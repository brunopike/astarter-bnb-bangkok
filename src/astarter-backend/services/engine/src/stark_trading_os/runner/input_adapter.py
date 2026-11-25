"""Fail-closed adapter from one server-owned manifest to one native run config."""

from __future__ import annotations

import importlib.metadata
import os
import platform
import stat
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath

import nautilus_trader._libnautilus as _libnautilus
import nautilus_trader.model as native_model
from nautilus_trader.backtest import (
    BacktestDataConfig,
    BacktestEngineConfig,
    BacktestRunConfig,
    BacktestVenueConfig,
)
from nautilus_trader.common import LogLevel
from nautilus_trader.config import LoggerConfig, RiskEngineConfig
from nautilus_trader.model import AccountType, BookType, InstrumentId, OmsType
from nautilus_trader.persistence import ParquetDataCatalog
from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.catalog.historical_catalog import CatalogManifestV2
from stark_trading_os.domain.cost_fill import build_native_cost_fill_profile
from stark_trading_os.domain.models import (
    CatalogFileSetV1,
    CatalogManifestV1,
    DeterminismProbeConfigV1,
    InputManifestV1,
    ProbeRiskPolicyV1,
)

MAX_INPUT_MANIFEST_BYTES = 1024 * 1024
_MAX_CATALOG_MANIFEST_BYTES = 4 * 1024 * 1024
_RUN_CONFIG_ID = "determinism-probe-v1"
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW


class InputAdapterError(ValueError):
    """Raised before native construction when immutable runner input is invalid."""


@dataclass(frozen=True)
class LoadedRunnerInput:
    run_id: str
    staging_dir: Path
    manifest_bytes: bytes
    input_manifest_hash: str
    manifest: InputManifestV1
    catalog_dir: Path
    catalog_manifest: CatalogManifestV1
    run_config: BacktestRunConfig


def load_runner_input(
    *,
    run_id: str,
    staging_dir: Path,
    input_manifest: Path,
) -> LoadedRunnerInput:
    staging = Path(staging_dir)
    manifest_path = Path(input_manifest)
    runtime = _validate_runtime_shape(
        run_id=run_id,
        staging_dir=staging,
        input_manifest=manifest_path,
    )
    runtime_fd = _open_absolute_directory(runtime, expected_mode=0o700)
    staging_parent_fd = -1
    staging_fd = -1
    catalogs_fd = -1
    catalog_fd = -1
    try:
        staging_parent_fd = _open_child_directory(
            runtime_fd,
            "staging",
            expected_mode=0o700,
        )
        staging_fd = _open_child_directory(
            staging_parent_fd,
            run_id,
            expected_mode=0o700,
        )
        manifest_bytes = _read_one_regular_file(
            Path("input-manifest.json"),
            dir_fd=staging_fd,
            max_bytes=MAX_INPUT_MANIFEST_BYTES,
            expected_mode=0o600,
            label="INPUT_MANIFEST",
        )
        try:
            manifest_object = parse_json_object(manifest_bytes)
            manifest = InputManifestV1.model_validate(manifest_object)
        except (CanonicalJSONError, ValidationError, ValueError) as error:
            raise InputAdapterError("INPUT_MANIFEST_NOT_CANONICAL") from error
        if (
            canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
            != manifest_bytes
        ):
            raise InputAdapterError("INPUT_MANIFEST_NOT_CANONICAL")
        _validate_manifest_definitions(manifest)

        catalogs_fd = _open_child_directory(
            runtime_fd,
            "catalogs",
            expected_mode=0o700,
        )
        catalog_fd = _open_child_directory(
            catalogs_fd,
            manifest.catalog_revision,
            expected_mode=0o500,
        )
        catalog_dir = runtime / "catalogs" / manifest.catalog_revision
        catalog_manifest = _load_catalog(
            catalog_dir,
            revision=manifest.catalog_revision,
            catalog_fd=catalog_fd,
        )
        _bind_manifest_to_catalog(manifest, catalog_manifest)
        _verify_runtime_identity(manifest, catalog_manifest)
        _verify_open_paths(
            runtime=runtime,
            runtime_fd=runtime_fd,
            staging_parent_fd=staging_parent_fd,
            run_id=run_id,
            staging_fd=staging_fd,
            catalogs_fd=catalogs_fd,
            revision=manifest.catalog_revision,
            catalog_fd=catalog_fd,
        )
        _verify_native_catalog(catalog_dir, catalog_manifest)
        _verify_open_paths(
            runtime=runtime,
            runtime_fd=runtime_fd,
            staging_parent_fd=staging_parent_fd,
            run_id=run_id,
            staging_fd=staging_fd,
            catalogs_fd=catalogs_fd,
            revision=manifest.catalog_revision,
            catalog_fd=catalog_fd,
        )
        run_config = _build_run_config(manifest=manifest, catalog_dir=catalog_dir)
        return LoadedRunnerInput(
            run_id=run_id,
            staging_dir=staging,
            manifest_bytes=manifest_bytes,
            input_manifest_hash=sha256(manifest_bytes).hexdigest(),
            manifest=manifest,
            catalog_dir=catalog_dir,
            catalog_manifest=catalog_manifest,
            run_config=run_config,
        )
    finally:
        for descriptor in (catalog_fd, catalogs_fd, staging_fd, staging_parent_fd, runtime_fd):
            if descriptor >= 0:
                os.close(descriptor)


def _validate_runtime_shape(
    *, run_id: str, staging_dir: Path, input_manifest: Path
) -> Path:
    if ".." in staging_dir.parts or ".." in input_manifest.parts:
        raise InputAdapterError("RUNTIME_PATH_INVALID")
    if (
        not run_id
        or run_id in {".", ".."}
        or "/" in run_id
        or "\\" in run_id
        or not staging_dir.is_absolute()
        or not input_manifest.is_absolute()
        or staging_dir.name != run_id
        or staging_dir.parent.name != "staging"
        or input_manifest != staging_dir / "input-manifest.json"
    ):
        raise InputAdapterError("RUNTIME_PATH_INVALID")
    runtime = staging_dir.parent.parent
    if staging_dir != runtime / "staging" / run_id:
        raise InputAdapterError("RUNTIME_PATH_INVALID")
    for path in (runtime, runtime / "staging", staging_dir):
        _require_directory(path, expected_mode=0o700)
    _require_no_symlink_components(staging_dir)
    return runtime


def _open_absolute_directory(path: Path, *, expected_mode: int) -> int:
    try:
        descriptor = os.open(path.anchor, _DIRECTORY_FLAGS)
        for part in path.parts[1:]:
            child = os.open(part, _DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        metadata = os.fstat(descriptor)
    except OSError as error:
        try:
            os.close(descriptor)
        except (OSError, UnboundLocalError):
            pass
        raise InputAdapterError("DIRECTORY_INVALID") from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != expected_mode
    ):
        os.close(descriptor)
        raise InputAdapterError("DIRECTORY_INVALID")
    return descriptor


def _open_child_directory(
    parent_fd: int,
    name: str,
    *,
    expected_mode: int,
) -> int:
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        opened = os.fstat(descriptor)
    except OSError as error:
        raise InputAdapterError("DIRECTORY_INVALID") from error
    if (
        not stat.S_ISDIR(before.st_mode)
        or not _same_file_snapshot(before, opened)
        or stat.S_IMODE(opened.st_mode) != expected_mode
    ):
        os.close(descriptor)
        raise InputAdapterError("DIRECTORY_CHANGED_DURING_OPEN")
    return descriptor


def _verify_open_paths(
    *,
    runtime: Path,
    runtime_fd: int,
    staging_parent_fd: int,
    run_id: str,
    staging_fd: int,
    catalogs_fd: int,
    revision: str,
    catalog_fd: int,
) -> None:
    _require_no_symlink_components(runtime)
    try:
        runtime_path = runtime.lstat()
    except OSError as error:
        raise InputAdapterError("DIRECTORY_CHANGED_DURING_READ") from error
    if not _same_file_snapshot(runtime_path, os.fstat(runtime_fd)):
        raise InputAdapterError("DIRECTORY_CHANGED_DURING_READ")
    for parent_fd, name, child_fd in (
        (runtime_fd, "staging", staging_parent_fd),
        (staging_parent_fd, run_id, staging_fd),
        (runtime_fd, "catalogs", catalogs_fd),
        (catalogs_fd, revision, catalog_fd),
    ):
        try:
            path_metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError as error:
            raise InputAdapterError("DIRECTORY_CHANGED_DURING_READ") from error
        if not _same_file_snapshot(path_metadata, os.fstat(child_fd)):
            raise InputAdapterError("DIRECTORY_CHANGED_DURING_READ")


def _require_no_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except OSError as error:
            raise InputAdapterError("RUNTIME_PATH_INVALID") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise InputAdapterError("RUNTIME_PATH_SYMLINK")


def _require_directory(path: Path, *, expected_mode: int) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise InputAdapterError("DIRECTORY_INVALID") from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != expected_mode
    ):
        raise InputAdapterError("DIRECTORY_INVALID")


def _read_one_regular_file(
    path: Path,
    *,
    dir_fd: int | None = None,
    max_bytes: int,
    expected_mode: int,
    label: str,
) -> bytes:
    try:
        before_path = (
            path.lstat()
            if dir_fd is None
            else os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
        )
    except OSError as error:
        raise InputAdapterError(f"{label}_UNREADABLE") from error
    if (
        not stat.S_ISREG(before_path.st_mode)
        or stat.S_ISLNK(before_path.st_mode)
        or before_path.st_nlink != 1
        or stat.S_IMODE(before_path.st_mode) != expected_mode
    ):
        raise InputAdapterError(f"{label}_NOT_PRIVATE_REGULAR")
    if before_path.st_size > max_bytes:
        raise InputAdapterError(f"{label}_TOO_LARGE")
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, dir_fd=dir_fd)
    except OSError as error:
        raise InputAdapterError(f"{label}_UNREADABLE") from error
    try:
        before_fd = os.fstat(descriptor)
        if not _same_file_snapshot(before_path, before_fd):
            raise InputAdapterError(f"{label}_CHANGED_DURING_READ")
        payload = os.read(descriptor, before_fd.st_size + 1)
        after_fd = os.fstat(descriptor)
        try:
            after_path = (
                path.lstat()
                if dir_fd is None
                else os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
            )
        except OSError as error:
            raise InputAdapterError(f"{label}_CHANGED_DURING_READ") from error
        if (
            len(payload) != before_fd.st_size
            or not _same_file_snapshot(before_fd, after_fd)
            or not _same_file_snapshot(after_fd, after_path)
        ):
            raise InputAdapterError(f"{label}_CHANGED_DURING_READ")
        return payload
    finally:
        os.close(descriptor)


def _same_file_snapshot(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        left.st_mode,
        left.st_nlink,
        left.st_size,
        left.st_mtime_ns,
        left.st_ctime_ns,
    ) == (
        right.st_dev,
        right.st_ino,
        right.st_mode,
        right.st_nlink,
        right.st_size,
        right.st_mtime_ns,
        right.st_ctime_ns,
    )


def _validate_manifest_definitions(manifest: InputManifestV1) -> None:
    try:
        strategy = DeterminismProbeConfigV1.model_validate(manifest.canonical_config)
        risk = ProbeRiskPolicyV1.model_validate(manifest.canonical_risk_policy)
    except ValidationError as error:
        raise InputAdapterError("INPUT_MANIFEST_DEFINITION_UNSUPPORTED") from error
    config_bytes = canonical_json_bytes(strategy.model_dump(mode="json", by_alias=True))
    risk_bytes = canonical_json_bytes(risk.model_dump(mode="json", by_alias=True))
    if (
        manifest.strategy_id != "determinism-probe"
        or manifest.strategy_version != "v1"
        or manifest.risk_policy_id != "probe-risk"
        or manifest.risk_policy_version != "v1"
        or manifest.config_hash != sha256(config_bytes).hexdigest()
        or manifest.risk_policy_hash != sha256(risk_bytes).hexdigest()
        or manifest.engine_package_version != "2.0.0rc3"
        or manifest.engine_tag_commit != "648970ce64a304d93da0a29320cb6e19b905fa39"
        or manifest.python_version != "3.12.4"
        or manifest.precision_mode != "FIXED_PRECISION_16"
        or len(manifest.instruments) != 1
    ):
        raise InputAdapterError("INPUT_MANIFEST_IDENTITY_INVALID")


def _load_catalog(
    catalog_dir: Path,
    *,
    revision: str,
    catalog_fd: int,
) -> CatalogManifestV1:
    if catalog_dir.name != revision or catalog_dir.parent.name != "catalogs":
        raise InputAdapterError("CATALOG_PATH_INVALID")
    sidecar_bytes = _read_one_regular_file(
        Path("catalog-manifest.json"),
        dir_fd=catalog_fd,
        max_bytes=_MAX_CATALOG_MANIFEST_BYTES,
        expected_mode=0o400,
        label="CATALOG_MANIFEST",
    )
    if sha256(sidecar_bytes).hexdigest() != revision:
        raise InputAdapterError("CATALOG_REVISION_MISMATCH")
    try:
        value = parse_json_object(sidecar_bytes)
        manifest = CatalogManifestV1.model_validate(value)
    except (CanonicalJSONError, ValidationError, ValueError) as error:
        raise InputAdapterError("CATALOG_MANIFEST_INVALID") from error
    if canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True)) != sidecar_bytes:
        raise InputAdapterError("CATALOG_MANIFEST_NOT_CANONICAL")
    inventory_bytes = canonical_json_bytes(
        manifest.inventory.model_dump(mode="json", by_alias=True)
    )
    if manifest.inventory_hash != sha256(inventory_bytes).hexdigest():
        raise InputAdapterError("CATALOG_INVENTORY_HASH_MISMATCH")
    file_set = CatalogFileSetV1(
        schema="CatalogFileSet.v1",
        catalog_files=manifest.inventory.catalog_files,
    )
    expected_catalog_checksum = sha256(
        canonical_json_bytes(file_set.model_dump(mode="json", by_alias=True))
    ).hexdigest()
    if (
        manifest.catalog_checksum != expected_catalog_checksum
        or manifest.inventory.catalog_checksum != expected_catalog_checksum
    ):
        raise InputAdapterError("CATALOG_CHECKSUM_MISMATCH")
    _verify_catalog_tree(catalog_fd, manifest)
    return manifest


def _verify_catalog_tree(catalog_fd: int, manifest: CatalogManifestV1 | CatalogManifestV2) -> None:
    declared: dict[str, tuple[int, str]] = {}
    expected_directories = {"."}
    for item in manifest.inventory.catalog_files:
        relative = PurePosixPath(item.relative_path)
        if (
            relative.is_absolute()
            or not relative.parts
            or any(part in {"", ".", ".."} for part in relative.parts)
            or item.relative_path in declared
        ):
            raise InputAdapterError("CATALOG_DECLARED_PATH_INVALID")
        declared[item.relative_path] = (item.size_bytes, item.sha256)
        parent = relative.parent
        while str(parent) != ".":
            expected_directories.add(parent.as_posix())
            parent = parent.parent
    actual_files: set[str] = set()
    actual_directories = {"."}

    def visit(directory_fd: int, relative_parent: PurePosixPath) -> None:
        try:
            with os.scandir(directory_fd) as entries:
                ordered = sorted(
                    (
                        (entry.name, entry.stat(follow_symlinks=False))
                        for entry in entries
                    ),
                    key=lambda item: item[0],
                )
        except OSError as error:
            raise InputAdapterError("CATALOG_DIRECTORY_INVALID") from error
        for name, metadata in ordered:
            relative = relative_parent / name
            relative_text = relative.as_posix()
            if stat.S_ISDIR(metadata.st_mode):
                child_fd = _open_child_directory(
                    directory_fd,
                    name,
                    expected_mode=0o500,
                )
                actual_directories.add(relative_text)
                try:
                    visit(child_fd, relative)
                finally:
                    os.close(child_fd)
                continue
            if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise InputAdapterError("CATALOG_FILE_INVALID")
            actual_files.add(relative_text)
            if relative_text == "catalog-manifest.json":
                if (
                    metadata.st_nlink != 1
                    or stat.S_IMODE(metadata.st_mode) != 0o400
                ):
                    raise InputAdapterError("CATALOG_FILE_INVALID")
                continue
            expected = declared.get(relative_text)
            if expected is None:
                continue
            expected_size, expected_hash = expected
            payload = _read_one_regular_file(
                Path(name),
                dir_fd=directory_fd,
                max_bytes=expected_size,
                expected_mode=0o400,
                label="CATALOG_FILE",
            )
            if len(payload) != expected_size or sha256(payload).hexdigest() != expected_hash:
                raise InputAdapterError("CATALOG_FILE_HASH_MISMATCH")

    visit(catalog_fd, PurePosixPath("."))
    if actual_directories != expected_directories:
        raise InputAdapterError("CATALOG_DIRECTORY_SET_MISMATCH")
    if actual_files != {"catalog-manifest.json", *declared}:
        raise InputAdapterError("CATALOG_FILE_SET_MISMATCH")


def _bind_manifest_to_catalog(
    manifest: InputManifestV1,
    catalog: CatalogManifestV1,
) -> None:
    inventory = catalog.inventory
    instrument = inventory.instrument
    manifest_instrument = manifest.instruments[0]
    if (
        manifest.fixture_id != catalog.fixture_id
        or manifest.source_checksum != catalog.source_checksum
        or manifest.catalog_checksum != catalog.catalog_checksum
        or inventory.fixture_id != catalog.fixture_id
        or inventory.source_checksum != catalog.source_checksum
        or inventory.catalog_checksum != catalog.catalog_checksum
        or manifest_instrument.instrument_id != instrument.instrument_id
        or manifest_instrument.price_increment != instrument.price_increment
        or manifest_instrument.quantity_increment != instrument.size_increment
        or tuple(manifest.data_types) != tuple(inventory.readback.data_types)
        or manifest.timezone != inventory.timezone
        or manifest.gaps != inventory.gaps
        or manifest.duplicates != inventory.duplicates
        or manifest.ordering_result != inventory.ordering_result
        or manifest.information_set_policy != inventory.information_set_policy
        or manifest.evaluation_protocol != inventory.evaluation_protocol
        or manifest.venue_account_model.venue_id != instrument.venue
        or manifest.venue_account_model.currency != instrument.quote_currency
        or int(manifest.window.start_ns) < int(inventory.readback.first_ts_init)
        or int(manifest.window.end_ns) > int(inventory.readback.last_ts_init) + 1
    ):
        raise InputAdapterError("INPUT_MANIFEST_CATALOG_MISMATCH")
    source_sequences = tuple(record.source_seq for record in inventory.source_records)
    if source_sequences != tuple(range(1, len(source_sequences) + 1)):
        raise InputAdapterError("CATALOG_SOURCE_SEQUENCE_INVALID")
    for record in inventory.source_records:
        value = record.model_dump(mode="json", by_alias=True)
        record_hash = value.pop("record_hash")
        if record_hash != sha256(canonical_json_bytes(value)).hexdigest():
            raise InputAdapterError("CATALOG_SOURCE_RECORD_HASH_MISMATCH")


def _verify_runtime_identity(
    manifest: InputManifestV1,
    catalog: CatalogManifestV1,
) -> None:
    try:
        installed_version = importlib.metadata.version("nautilus_trader")
        python_version = platform.python_version()
        platform_system = platform.system()
        platform_machine = platform.machine()
        extension_path = Path(str(_libnautilus.__file__))
        extension_metadata = extension_path.lstat()
        if not stat.S_ISREG(extension_metadata.st_mode) or stat.S_ISLNK(
            extension_metadata.st_mode
        ):
            raise InputAdapterError("RUNTIME_NATIVE_FINGERPRINT_INVALID")
        extension_sha256 = sha256(extension_path.read_bytes()).hexdigest()
        fixed_precision = native_model.FIXED_PRECISION
        high_precision = native_model.HIGH_PRECISION
    except InputAdapterError:
        raise
    except Exception as error:
        raise InputAdapterError("RUNTIME_NATIVE_FINGERPRINT_INVALID") from error
    fingerprint = catalog.inventory.native_fingerprint
    if (
        installed_version != "2.0.0rc3"
        or manifest.engine_package_version != installed_version
        or python_version != "3.12.4"
        or manifest.python_version != python_version
        or fixed_precision != 16
        or high_precision != 1
        or manifest.precision_mode != f"FIXED_PRECISION_{fixed_precision}"
        or fingerprint.installed_nautilus_version != installed_version
        or fingerprint.python_version != python_version
        or fingerprint.platform_system != platform_system
        or fingerprint.platform_machine != platform_machine
        or fingerprint.native_extension_sha256 != extension_sha256
    ):
        raise InputAdapterError("RUNTIME_NATIVE_FINGERPRINT_MISMATCH")


def _verify_native_catalog(catalog_dir: Path, manifest: CatalogManifestV1) -> None:
    catalog = ParquetDataCatalog(str(catalog_dir))
    instruments = catalog.instruments()
    quotes = catalog.query_quote_ticks(
        identifiers=[manifest.inventory.instrument.instrument_id]
    )
    if (
        len(instruments) != 1
        or str(instruments[0].id) != manifest.inventory.instrument.instrument_id
        or len(quotes) != manifest.inventory.readback.quote_count
        or tuple(str(quote.ts_init) for quote in quotes)[0]
        != manifest.inventory.readback.first_ts_init
        or tuple(str(quote.ts_init) for quote in quotes)[-1]
        != manifest.inventory.readback.last_ts_init
    ):
        raise InputAdapterError("NATIVE_CATALOG_READBACK_MISMATCH")


def _build_run_config(*, manifest: InputManifestV1, catalog_dir: Path) -> BacktestRunConfig:
    native = build_native_cost_fill_profile(
        manifest.cost_fill_model,
        replay_seed=manifest.replay_seed,
    )
    instrument_id = manifest.instruments[0].instrument_id
    venue = manifest.venue_account_model
    risk = ProbeRiskPolicyV1.model_validate(manifest.canonical_risk_policy)
    engine = BacktestEngineConfig(
        bypass_logging=False,
        run_analysis=True,
        logging=LoggerConfig(
            bypass_logging=False,
            stdout_level=LogLevel.OFF,
            fileout_level=LogLevel.OFF,
            print_config=False,
        ),
        risk_engine=RiskEngineConfig(
            bypass=False,
            max_notional_per_order={instrument_id: risk.max_notional},
        ),
    )
    return BacktestRunConfig(
        venues=[
            BacktestVenueConfig(
                name=venue.venue_id,
                oms_type=OmsType.HEDGING,
                account_type=AccountType.MARGIN,
                book_type=BookType.L1_MBP,
                starting_balances=[f"{venue.starting_balance} {venue.currency}"],
                routing=False,
                use_random_ids=False,
                use_position_ids=True,
                allow_cash_borrowing=False,
                liquidity_consumption=native.liquidity_consumption,
                fill_model=native.fill_model,
                latency_model=native.latency_model,
                fee_model=native.fee_model,
            )
        ],
        data=[
            BacktestDataConfig(
                data_type="QuoteTick",
                catalog_path=str(catalog_dir),
                instrument_id=InstrumentId.from_str(instrument_id),
                start_time=int(manifest.window.start_ns),
                end_time=int(manifest.window.end_ns) - 1,
            )
        ],
        engine=engine,
        id=_RUN_CONFIG_ID,
        raise_exception=True,
        dispose_on_completion=False,
    )
