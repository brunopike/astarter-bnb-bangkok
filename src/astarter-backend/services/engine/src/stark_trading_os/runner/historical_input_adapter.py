"""Explicit v2 file/runtime loader; caller still owns database and run authorization.

The expected input hash must come from a trusted immutable Control reservation. This
loader checks actual bytes and native readback and never starts an engine. Its returned
dataclass is an internal value, not an unforgeable capability or publication authority.
"""

from __future__ import annotations

import importlib.metadata
import os
import platform
import stat
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

import nautilus_trader._libnautilus as _libnautilus
import nautilus_trader.model as native_model
from nautilus_trader.model import Bar, CurrencyPair
from nautilus_trader.persistence import ParquetDataCatalog

from stark_trading_os.audit.historical_input import (
    parse_input_manifest_bytes,
    validate_input_bindings,
)
from stark_trading_os.catalog.historical_catalog import (
    CatalogManifestV2,
    _bar_value,
    _native_instrument,
    canonical_historical_bytes,
    parse_historical_manifest_bytes,
    readback_historical_native,
)
from stark_trading_os.catalog.historical_source import HistoricalSource, validate_historical_source
from stark_trading_os.domain.historical_input import HistoricalRuntimeV2, InputManifestV2
from stark_trading_os.runner.historical_cost import (
    NativeHistoricalExecutionProfile,
    build_historical_execution_profile,
)
from stark_trading_os.runner.input_adapter import (
    InputAdapterError,
    _open_absolute_directory,
    _open_child_directory,
    _read_one_regular_file,
    _same_file_snapshot,
    _validate_runtime_shape,
    _verify_catalog_tree,
    _verify_open_paths,
)

_CSV_BYTE_LIMIT = 32 * 1024 * 1024
_METADATA_BYTE_LIMIT = 64 * 1024
# A loader budget for the bounded (<=100,000 bar) first historical runner.
# These are admission limits, not guarantees about native decoder memory use.
_NATIVE_FILE_BYTE_LIMIT = 64 * 1024 * 1024
_CATALOG_BYTE_LIMIT = 128 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class LoadedHistoricalRunnerInput:
    run_id: str
    staging_dir: Path
    manifest_bytes: bytes
    input_manifest_hash: str
    manifest: InputManifestV2
    catalog_dir: Path
    catalog_manifest_bytes: bytes
    catalog_manifest: CatalogManifestV2
    runtime: HistoricalRuntimeV2
    source: HistoricalSource
    instrument: CurrencyPair
    bars: tuple[Bar, ...]
    execution_profile: NativeHistoricalExecutionProfile


def _native_extension_digest() -> str:
    path = Path(str(_libnautilus.__file__))
    descriptor = -1
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 512 * 1024 * 1024:
            raise InputAdapterError("HISTORICAL_RUNTIME_EXTENSION_INVALID")
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        opened = os.fstat(descriptor)
        if not _same_file_snapshot(before, opened):
            raise InputAdapterError("HISTORICAL_RUNTIME_EXTENSION_CHANGED")
        digest, length = sha256(), 0
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
            length += len(chunk)
            if length > before.st_size:
                raise InputAdapterError("HISTORICAL_RUNTIME_EXTENSION_CHANGED")
        after = os.fstat(descriptor)
        if (
            length != before.st_size
            or not _same_file_snapshot(opened, after)
            or not _same_file_snapshot(after, path.lstat())
        ):
            raise InputAdapterError("HISTORICAL_RUNTIME_EXTENSION_CHANGED")
        return digest.hexdigest()
    except InputAdapterError:
        raise
    except OSError as error:
        raise InputAdapterError("HISTORICAL_RUNTIME_EXTENSION_INVALID") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def observe_historical_runtime() -> HistoricalRuntimeV2:
    """Observe the currently imported pinned package and stable extension file bytes."""
    try:
        if native_model.FIXED_PRECISION != 16 or native_model.HIGH_PRECISION != 1:
            raise InputAdapterError("HISTORICAL_RUNTIME_PRECISION_UNSUPPORTED")
        return HistoricalRuntimeV2.model_validate(
            {
                "engine_package_version": importlib.metadata.version("nautilus_trader"),
                "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
                "python_version": platform.python_version(),
                "precision_mode": "FIXED_PRECISION_16",
                "platform_system": platform.system(),
                "platform_machine": platform.machine(),
                "native_extension_sha256": _native_extension_digest(),
            }
        )
    except InputAdapterError:
        raise
    except Exception as error:
        raise InputAdapterError("HISTORICAL_RUNTIME_UNSUPPORTED") from error


def _check_catalog_runtime(catalog: CatalogManifestV2, runtime: HistoricalRuntimeV2) -> None:
    fingerprint = catalog.inventory.native_fingerprint
    if (
        fingerprint.installed_nautilus_version != runtime.engine_package_version
        or fingerprint.python_version != runtime.python_version
        or fingerprint.platform_system != runtime.platform_system
        or fingerprint.platform_machine != runtime.platform_machine
        or fingerprint.native_extension_sha256 != runtime.native_extension_sha256
        or fingerprint.writer_class != "nautilus_trader.persistence.ParquetDataCatalog"
        or fingerprint.writer_options
        != ("batch_size=null;compression=null;max_row_group_size=null;storage_options=null")
    ):
        raise InputAdapterError("HISTORICAL_CATALOG_RUNTIME_MISMATCH")


def _check_catalog_byte_budget(catalog: CatalogManifestV2) -> None:
    files = catalog.inventory.catalog_files
    if sum(item.size_bytes for item in files) > _CATALOG_BYTE_LIMIT:
        raise InputAdapterError("HISTORICAL_CATALOG_BYTE_BUDGET")
    for item in files:
        limit = {
            "source/bars.csv": _CSV_BYTE_LIMIT - 1,
            "source/source.json": _METADATA_BYTE_LIMIT - 1,
        }.get(item.relative_path, _NATIVE_FILE_BYTE_LIMIT)
        if item.size_bytes > limit:
            raise InputAdapterError("HISTORICAL_CATALOG_BYTE_BUDGET")


def _read_source(catalog_fd: int, catalog: CatalogManifestV2) -> HistoricalSource:
    source_fd = _open_child_directory(catalog_fd, "source", expected_mode=0o500)
    try:
        raw = _read_one_regular_file(
            Path("bars.csv"),
            dir_fd=source_fd,
            max_bytes=_CSV_BYTE_LIMIT - 1,
            expected_mode=0o400,
            label="HISTORICAL_SOURCE_CSV",
        )
        metadata = _read_one_regular_file(
            Path("source.json"),
            dir_fd=source_fd,
            max_bytes=_METADATA_BYTE_LIMIT - 1,
            expected_mode=0o400,
            label="HISTORICAL_SOURCE_METADATA",
        )
        source = validate_historical_source(raw, metadata, now_ns=time.time_ns())
        inventory = catalog.inventory
        if (
            source.source_id != catalog.source_id
            or source.raw_sha256 != catalog.raw_sha256
            or source.metadata_sha256 != catalog.metadata_sha256
            or source.metadata != inventory.metadata
            or source.record_count != inventory.record_count
        ):
            raise InputAdapterError("HISTORICAL_SOURCE_IDENTITY_MISMATCH")
        return source
    finally:
        os.close(source_fd)


def _read_native(
    catalog_dir: Path,
    source: HistoricalSource,
    catalog: CatalogManifestV2,
) -> tuple[CurrencyPair, tuple[Bar, ...]]:
    inventory = catalog.inventory
    readback = readback_historical_native(
        catalog_dir, source, inventory.instrument, inventory.bar_type
    )
    if readback != inventory.readback:
        raise InputAdapterError("HISTORICAL_NATIVE_READBACK_MISMATCH")
    reader = ParquetDataCatalog(str(catalog_dir))
    instruments, bars = reader.instruments(), tuple(reader.query_bars())
    if (
        len(instruments) != 1
        or type(instruments[0]) is not CurrencyPair
        or instruments[0].to_dict() != _native_instrument(inventory.instrument).to_dict()
        or len(bars) != source.record_count
        or any(type(bar) is not Bar or str(bar.bar_type) != inventory.bar_type for bar in bars)
    ):
        raise InputAdapterError("HISTORICAL_NATIVE_VALUES_MISMATCH")
    digest = sha256(
        canonical_historical_bytes(
            {"bars": [_bar_value(bar).model_dump(mode="json", by_alias=True) for bar in bars]}
        )
    ).hexdigest()
    if digest != inventory.readback.bar_values_sha256:
        raise InputAdapterError("HISTORICAL_NATIVE_VALUES_MISMATCH")
    return instruments[0], bars


def load_historical_runner_input(
    *,
    run_id: str,
    staging_dir: Path,
    input_manifest: Path,
    expected_input_sha256: str,
) -> LoadedHistoricalRunnerInput:
    """Load one explicitly authorized hash. Does not dispatch, publish or start an engine."""
    staging, manifest_path = Path(staging_dir), Path(input_manifest)
    runtime_root = _validate_runtime_shape(
        run_id=run_id, staging_dir=staging, input_manifest=manifest_path
    )
    descriptors: list[int] = []
    try:
        runtime_fd = _open_absolute_directory(runtime_root, expected_mode=0o700)
        descriptors.append(runtime_fd)
        staging_parent_fd = _open_child_directory(runtime_fd, "staging", expected_mode=0o700)
        descriptors.append(staging_parent_fd)
        staging_fd = _open_child_directory(staging_parent_fd, run_id, expected_mode=0o700)
        descriptors.append(staging_fd)
        raw = _read_one_regular_file(
            Path("input-manifest.json"),
            dir_fd=staging_fd,
            max_bytes=64 * 1024,
            expected_mode=0o600,
            label="HISTORICAL_INPUT_MANIFEST",
        )
        manifest = parse_input_manifest_bytes(raw, expected_sha256=expected_input_sha256)
        catalogs_fd = _open_child_directory(runtime_fd, "catalogs", expected_mode=0o700)
        descriptors.append(catalogs_fd)
        revision = manifest.dataset.catalog_revision
        catalog_fd = _open_child_directory(catalogs_fd, revision, expected_mode=0o500)
        descriptors.append(catalog_fd)
        catalog_dir = runtime_root / "catalogs" / revision
        catalog_raw = _read_one_regular_file(
            Path("catalog-manifest.json"),
            dir_fd=catalog_fd,
            max_bytes=4 * 1024 * 1024,
            expected_mode=0o400,
            label="HISTORICAL_CATALOG_MANIFEST",
        )
        current_runtime = observe_historical_runtime()
        if current_runtime != manifest.runtime:
            raise InputAdapterError("HISTORICAL_INPUT_RUNTIME_MISMATCH")
        validate_input_bindings(
            manifest, catalog_manifest_bytes=catalog_raw, expected_runtime=current_runtime
        )
        catalog = parse_historical_manifest_bytes(catalog_raw)
        _check_catalog_runtime(catalog, current_runtime)
        _check_catalog_byte_budget(catalog)
        _verify_catalog_tree(catalog_fd, catalog)
        source = _read_source(catalog_fd, catalog)

        def verify_paths() -> None:
            _verify_open_paths(
                runtime=runtime_root,
                runtime_fd=runtime_fd,
                staging_parent_fd=staging_parent_fd,
                run_id=run_id,
                staging_fd=staging_fd,
                catalogs_fd=catalogs_fd,
                revision=revision,
                catalog_fd=catalog_fd,
            )

        verify_paths()
        instrument, bars = _read_native(catalog_dir, source, catalog)
        verify_paths()
        _verify_catalog_tree(catalog_fd, catalog)
        if catalog_raw != _read_one_regular_file(
            Path("catalog-manifest.json"),
            dir_fd=catalog_fd,
            max_bytes=4 * 1024 * 1024,
            expected_mode=0o400,
            label="HISTORICAL_CATALOG_MANIFEST",
        ):
            raise InputAdapterError("HISTORICAL_CATALOG_CHANGED_DURING_LOAD")
        # The input sidecar can change independently of its containing directory.
        if raw != _read_one_regular_file(
            Path("input-manifest.json"),
            dir_fd=staging_fd,
            max_bytes=64 * 1024,
            expected_mode=0o600,
            label="HISTORICAL_INPUT_MANIFEST",
        ):
            raise InputAdapterError("HISTORICAL_INPUT_CHANGED_DURING_LOAD")
        verify_paths()
        profile = build_historical_execution_profile(
            instrument, manifest.configuration.configuration.execution_cost
        )
        return LoadedHistoricalRunnerInput(
            run_id=run_id,
            staging_dir=staging,
            manifest_bytes=raw,
            input_manifest_hash=expected_input_sha256,
            manifest=manifest,
            catalog_dir=catalog_dir,
            catalog_manifest_bytes=catalog_raw,
            catalog_manifest=catalog,
            runtime=current_runtime,
            source=source,
            instrument=instrument,
            bars=bars,
            execution_profile=profile,
        )
    except InputAdapterError:
        raise
    except Exception as error:
        raise InputAdapterError("HISTORICAL_RUNNER_INPUT_INVALID") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
