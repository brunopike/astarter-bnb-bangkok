from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import shutil
import socket
import sys
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest
from nautilus_trader.common import LogLevel
from nautilus_trader.model import AccountType, BookType, OmsType

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import open_catalog_service
from stark_trading_os.domain.models import CatalogManifestV1, InputManifestV1
from stark_trading_os.runner.input_adapter import (
    MAX_INPUT_MANIFEST_BYTES,
    InputAdapterError,
    load_runner_input,
)
from stark_trading_os.runner.main import parse_runner_cli

_RUN_ID = "bt_001"
_FIXTURE_ROOT = Path(__file__).resolve().parents[5] / "data" / "fixtures"


@dataclass(frozen=True)
class PreparedInput:
    runtime: Path
    staging: Path
    manifest_path: Path
    manifest_bytes: bytes
    catalog_dir: Path
    catalog_manifest: CatalogManifestV1


def _cost_fill() -> dict[str, object]:
    return {
        "schema": "CostFillModel.v1",
        "fee": {
            "model": "MakerTakerFeeModel",
            "rate_source": "INSTRUMENT_MAKER_TAKER",
            "rate_unit": "NOTIONAL_DECIMAL_FRACTION",
            "charge_currency": "INSTRUMENT_QUOTE_CURRENCY",
            "minimum_fee": "0",
            "application": "PER_FILL",
            "decimal_precision": 8,
            "rounding_mode": "MIDPOINT_NEAREST_EVEN",
        },
        "spread": {"authority": "FIXTURE_BID_ASK"},
        "slippage": {
            "model": "DefaultFillModel",
            "prob_fill_on_limit": "1",
            "prob_slippage": "0",
            "random_seed_source": "INPUT_MANIFEST_REPLAY_SEED",
            "probabilistic_slippage": "DISABLED",
            "depth_price_impact": "DISABLED",
            "maximum_book_walk_ticks": "0",
        },
        "latency": {
            "model": "StaticLatencyModel",
            "decision_to_submit_ns": "0",
            "submit_to_venue_ns": "0",
            "base_latency_ns": "0",
            "insert_latency_ns": "0",
            "update_latency_ns": "0",
            "cancel_latency_ns": "0",
        },
        "liquidity": {
            "available_size_source": "RECORDED_QUOTE_TICK_BID_ASK_SIZE",
            "queue_assumption": "NOT_MODELED_AT_L1",
            "allocation_order": "SINGLE_ORDER_NO_ALLOCATION_COMPETITION",
            "partial_fill_schedule": "ON_RECORDED_QUOTE",
            "price_selection": "NATIVE_L1_BID_ASK_CROSS",
            "allow_partial_fills": True,
            "liquidity_consumption": True,
        },
        "cancel": {
            "acknowledgment_rule": "NATIVE",
            "remaining_quantity_disposition": "CANCEL_OPEN_REMAINDER",
            "time_in_force": "GTC",
        },
    }


def _strategy() -> dict[str, object]:
    return {
        "entry_limit_price": "100",
        "entry_quantity": "15",
        "metric_round_trip_quantity": "1",
        "metric_round_trips": 5,
        "risk_probe_quantity": "20",
        "venue_rejection_quantity": "1",
    }


def _prepare(tmp_path: Path) -> PreparedInput:
    runtime = tmp_path / "runtime"
    publisher, control = open_catalog_service(
        fixture_root=_FIXTURE_ROOT,
        runtime_root=runtime,
    )
    try:
        publication = publisher.publish("local-qa-v1")
    finally:
        control.close()
    catalog_manifest = CatalogManifestV1.model_validate_json(publication.publication_bytes)
    strategy = _strategy()
    risk = {"max_notional": "1600"}
    strategy_bytes = canonical_json_bytes(strategy)
    risk_bytes = canonical_json_bytes(risk)
    instrument = catalog_manifest.inventory.instrument
    manifest = InputManifestV1.model_validate(
        {
            "schema": "InputManifest.v1",
            "environment": "BACKTEST",
            "strategy_id": "determinism-probe",
            "strategy_version": "v1",
            "canonical_config": strategy,
            "config_hash": sha256(strategy_bytes).hexdigest(),
            "engine_package_version": "2.0.0rc3",
            "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
            "python_version": "3.12.4",
            "precision_mode": "FIXED_PRECISION_16",
            "fixture_id": catalog_manifest.fixture_id,
            "catalog_revision": publication.catalog_revision,
            "source_checksum": catalog_manifest.source_checksum,
            "catalog_checksum": catalog_manifest.catalog_checksum,
            "instruments": [
                {
                    "instrument_id": instrument.instrument_id,
                    "price_increment": instrument.price_increment,
                    "quantity_increment": instrument.size_increment,
                }
            ],
            "data_types": list(catalog_manifest.inventory.readback.data_types),
            "window": {
                "start_ns": catalog_manifest.inventory.readback.first_ts_init,
                "end_ns": str(int(catalog_manifest.inventory.readback.last_ts_init) + 1),
            },
            "timezone": catalog_manifest.inventory.timezone,
            "gaps": catalog_manifest.inventory.gaps,
            "duplicates": catalog_manifest.inventory.duplicates,
            "ordering_result": catalog_manifest.inventory.ordering_result,
            "information_set_policy": catalog_manifest.inventory.information_set_policy,
            "evaluation_protocol": catalog_manifest.inventory.evaluation_protocol,
            "venue_account_model": {
                "venue_id": "SIM",
                "oms_type": "HEDGING",
                "account_type": "MARGIN",
                "book_type": "L1_MBP",
                "routing": False,
                "use_random_ids": False,
                "use_position_ids": True,
                "allow_cash_borrowing": False,
                "starting_balance": "1000000",
                "currency": "USDT",
            },
            "cost_fill_model": _cost_fill(),
            "risk_policy_id": "probe-risk",
            "risk_policy_version": "v1",
            "canonical_risk_policy": risk,
            "risk_policy_hash": sha256(risk_bytes).hexdigest(),
            "replay_seed": 7,
        }
    )
    manifest_bytes = canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
    staging_parent = runtime / "staging"
    staging_parent.mkdir(mode=0o700)
    staging = staging_parent / _RUN_ID
    staging.mkdir(mode=0o700)
    manifest_path = staging / "input-manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    manifest_path.chmod(0o600)
    return PreparedInput(
        runtime=runtime,
        staging=staging,
        manifest_path=manifest_path,
        manifest_bytes=manifest_bytes,
        catalog_dir=runtime / "catalogs" / publication.catalog_revision,
        catalog_manifest=catalog_manifest,
    )


def test_adapter_binds_exact_manifest_catalog_window_and_native_venue(tmp_path: Path) -> None:
    prepared = _prepare(tmp_path)

    loaded = load_runner_input(
        run_id=_RUN_ID,
        staging_dir=prepared.staging,
        input_manifest=prepared.manifest_path,
    )

    assert loaded.manifest_bytes == prepared.manifest_bytes
    assert loaded.input_manifest_hash == sha256(prepared.manifest_bytes).hexdigest()
    assert loaded.catalog_dir == prepared.catalog_dir
    assert loaded.catalog_manifest == prepared.catalog_manifest
    assert loaded.run_config.id == "determinism-probe-v1"
    assert loaded.run_config.raise_exception is True
    assert loaded.run_config.dispose_on_completion is False
    assert len(loaded.run_config.data) == 1
    assert loaded.run_config.data[0].start_time == int(loaded.manifest.window.start_ns)
    assert loaded.run_config.data[0].end_time == int(loaded.manifest.window.end_ns) - 1
    assert loaded.run_config.engine.bypass_logging is False
    assert loaded.run_config.engine.logging.bypass_logging is False
    assert loaded.run_config.engine.logging.stdout_level is LogLevel.OFF
    assert loaded.run_config.engine.logging.fileout_level is LogLevel.OFF
    assert loaded.run_config.engine.logging.print_config is False
    venue = loaded.run_config.venues[0]
    assert venue.oms_type is OmsType.HEDGING
    assert venue.account_type is AccountType.MARGIN
    assert venue.book_type is BookType.L1_MBP
    assert venue.routing is False
    assert venue.use_random_ids is False
    assert venue.use_position_ids is True
    assert venue.allow_cash_borrowing is False
    assert venue.liquidity_consumption is True


@pytest.mark.parametrize(
    "argv",
    [
        ["--run", _RUN_ID, "--staging-dir", "/tmp/x", "--input-manifest", "/tmp/y"],
        [
            "--run-id",
            _RUN_ID,
            "--run-id",
            "bt_002",
            "--staging-dir",
            "/tmp/x",
            "--input-manifest",
            "/tmp/y",
        ],
        ["--run-id", _RUN_ID, "--staging-dir", "/tmp/x"],
        [
            "--run-id",
            _RUN_ID,
            "--staging-dir",
            "/tmp/x",
            "--input-manifest",
            "/tmp/y",
            "--strategy-path",
            "evil:Strategy",
        ],
    ],
)
def test_cli_rejects_abbreviated_duplicate_missing_and_extra_arguments(argv: list[str]) -> None:
    with pytest.raises(SystemExit):
        parse_runner_cli(argv)


def test_cli_accepts_only_the_exact_three_server_owned_arguments() -> None:
    parsed = parse_runner_cli(
        [
            "--run-id",
            _RUN_ID,
            "--staging-dir",
            "/runtime/staging/bt_001",
            "--input-manifest",
            "/runtime/staging/bt_001/input-manifest.json",
        ]
    )
    assert vars(parsed) == {
        "run_id": _RUN_ID,
        "staging_dir": Path("/runtime/staging/bt_001"),
        "input_manifest": Path("/runtime/staging/bt_001/input-manifest.json"),
    }


def test_cli_rejects_duplicate_arguments_from_real_sys_argv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "python -m stark_trading_os.runner.main",
            "--run-id",
            _RUN_ID,
            "--run-id",
            "bt_002",
            "--staging-dir",
            "/runtime/staging/bt_001",
            "--input-manifest",
            "/runtime/staging/bt_001/input-manifest.json",
        ],
    )

    with pytest.raises(SystemExit):
        parse_runner_cli()


@pytest.mark.parametrize("attack", ["wrong-run", "wrong-parent", "manifest-name"])
def test_staging_and_manifest_paths_must_be_the_exact_runtime_shape(
    tmp_path: Path,
    attack: str,
) -> None:
    prepared = _prepare(tmp_path)
    run_id = "bt_002" if attack == "wrong-run" else _RUN_ID
    staging = prepared.runtime / "other" / _RUN_ID if attack == "wrong-parent" else prepared.staging
    manifest = (
        prepared.staging / "other.json" if attack == "manifest-name" else prepared.manifest_path
    )

    with pytest.raises(InputAdapterError):
        load_runner_input(run_id=run_id, staging_dir=staging, input_manifest=manifest)


@pytest.mark.parametrize("attack", ["staging", "manifest"])
def test_lexical_parent_traversal_is_rejected_before_any_filesystem_access(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    prepared = _prepare(tmp_path)
    spare = prepared.runtime / "spare"
    spare.mkdir(mode=0o700)
    if attack == "staging":
        staging = prepared.runtime / "spare" / ".." / "staging" / _RUN_ID
        manifest = staging / "input-manifest.json"
    else:
        staging = prepared.staging
        manifest = staging / "spare" / ".." / "input-manifest.json"
        (staging / "spare").mkdir(mode=0o700)

    def forbidden_access(*args: object, **kwargs: object) -> object:
        raise AssertionError("filesystem accessed before lexical traversal rejection")

    monkeypatch.setattr(Path, "lstat", forbidden_access)
    monkeypatch.setattr(os, "open", forbidden_access)

    with pytest.raises(InputAdapterError, match="RUNTIME_PATH_INVALID"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=staging,
            input_manifest=manifest,
        )


@pytest.mark.parametrize("attack", ["manifest", "staging", "runtime"])
def test_final_path_and_parent_symlinks_are_rejected(tmp_path: Path, attack: str) -> None:
    prepared = _prepare(tmp_path)
    staging = prepared.staging
    manifest = prepared.manifest_path
    if attack == "manifest":
        target = prepared.staging / "manifest-target.json"
        manifest.rename(target)
        manifest.symlink_to(target)
    elif attack == "staging":
        target = prepared.runtime / "real-staging"
        staging.rename(target)
        staging.symlink_to(target, target_is_directory=True)
    else:
        alias = tmp_path / "runtime-alias"
        alias.symlink_to(prepared.runtime, target_is_directory=True)
        staging = alias / "staging" / _RUN_ID
        manifest = staging / "input-manifest.json"

    with pytest.raises(InputAdapterError):
        load_runner_input(run_id=_RUN_ID, staging_dir=staging, input_manifest=manifest)


@pytest.mark.parametrize("kind", ["directory", "fifo", "socket", "hardlink"])
def test_manifest_must_be_one_private_regular_unlinked_file(tmp_path: Path, kind: str) -> None:
    prepared = _prepare(tmp_path)
    prepared.manifest_path.unlink()
    sock: socket.socket | None = None
    if kind == "directory":
        prepared.manifest_path.mkdir()
    elif kind == "fifo":
        os.mkfifo(prepared.manifest_path, mode=0o600)
    elif kind == "socket":
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        short_socket = Path("/tmp") / f"stark-runner-{os.getpid()}-{id(sock)}.sock"
        sock.bind(str(short_socket))
        short_socket.rename(prepared.manifest_path)
    else:
        source = prepared.staging / "linked-source.json"
        source.write_bytes(prepared.manifest_bytes)
        source.chmod(0o600)
        os.link(source, prepared.manifest_path)
    try:
        with pytest.raises(InputAdapterError):
            load_runner_input(
                run_id=_RUN_ID,
                staging_dir=prepared.staging,
                input_manifest=prepared.manifest_path,
            )
    finally:
        if sock is not None:
            sock.close()


def test_manifest_size_boundary_is_checked_before_canonical_parsing(tmp_path: Path) -> None:
    prepared = _prepare(tmp_path)
    prepared.manifest_path.write_bytes(b"{" + b" " * (MAX_INPUT_MANIFEST_BYTES - 1))
    prepared.manifest_path.chmod(0o600)
    with pytest.raises(InputAdapterError, match="NOT_CANONICAL"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )

    prepared.manifest_path.write_bytes(b"x" * (MAX_INPUT_MANIFEST_BYTES + 1))
    prepared.manifest_path.chmod(0o600)
    with pytest.raises(InputAdapterError, match="TOO_LARGE"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


def test_manifest_replacement_during_fd_read_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared = _prepare(tmp_path)
    original_read = os.read
    replaced = False

    def replacing_read(fd: int, size: int) -> bytes:
        nonlocal replaced
        if not replaced:
            replaced = True
            retained = prepared.staging / "retained-manifest.json"
            prepared.manifest_path.rename(retained)
            prepared.manifest_path.write_bytes(
                prepared.manifest_bytes.replace(b"bt_001", b"bt_002")
            )
            prepared.manifest_path.chmod(0o600)
        return original_read(fd, size)

    monkeypatch.setattr(os, "read", replacing_read)

    with pytest.raises(InputAdapterError, match="CHANGED_DURING_READ"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


@pytest.mark.parametrize("attack", ["run", "staging", "catalogs"])
def test_parent_directory_rename_to_symlink_races_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    prepared = _prepare(tmp_path)
    if attack == "run":
        source = prepared.staging
        relocated = prepared.runtime / "relocated-run"
        trigger = prepared.manifest_path
    elif attack == "staging":
        source = prepared.runtime / "staging"
        relocated = prepared.runtime / "relocated-staging"
        trigger = prepared.manifest_path
    else:
        source = prepared.runtime / "catalogs"
        relocated = prepared.runtime / "relocated-catalogs"
        trigger = prepared.catalog_dir / "catalog-manifest.json"
    original_open = os.open
    swapped = False

    def racing_open(
        path: os.PathLike[str] | str,
        flags: int,
        *args: object,
        **kwargs: object,
    ) -> int:
        nonlocal swapped
        if not swapped and Path(path).name == trigger.name:
            swapped = True
            source.rename(relocated)
            source.symlink_to(relocated, target_is_directory=True)
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", racing_open)

    with pytest.raises(InputAdapterError, match="CHANGED|SYMLINK|INVALID"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


@pytest.mark.parametrize(
    "attack",
    ["package", "python", "platform", "machine", "extension", "precision", "high"],
)
def test_current_runtime_and_catalog_native_fingerprint_are_reprobed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    prepared = _prepare(tmp_path)
    import stark_trading_os.runner.input_adapter as adapter_module

    if attack == "package":
        original_version = importlib.metadata.version
        monkeypatch.setattr(
            importlib.metadata,
            "version",
            lambda name: "2.0.0" if name == "nautilus_trader" else original_version(name),
        )
    elif attack == "python":
        monkeypatch.setattr(platform, "python_version", lambda: "3.12.5")
    elif attack == "platform":
        monkeypatch.setattr(platform, "system", lambda: "Linux")
    elif attack == "machine":
        monkeypatch.setattr(platform, "machine", lambda: "x86_64")
    elif attack == "extension":
        fake_extension = tmp_path / "_libnautilus.so"
        fake_extension.write_bytes(b"not-the-loaded-native-extension")
        monkeypatch.setattr(
            adapter_module,
            "_libnautilus",
            SimpleNamespace(__file__=str(fake_extension)),
            raising=False,
        )
    elif attack == "precision":
        monkeypatch.setattr(
            adapter_module,
            "native_model",
            SimpleNamespace(FIXED_PRECISION=8, HIGH_PRECISION=1),
            raising=False,
        )
    else:
        monkeypatch.setattr(
            adapter_module,
            "native_model",
            SimpleNamespace(FIXED_PRECISION=16, HIGH_PRECISION=0),
            raising=False,
        )

    with pytest.raises(InputAdapterError, match="RUNTIME|FINGERPRINT|IDENTITY"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


@pytest.mark.parametrize("attack", ["extra", "missing", "mutable"])
def test_catalog_extra_missing_and_mode_drift_are_rejected(tmp_path: Path, attack: str) -> None:
    prepared = _prepare(tmp_path)
    prepared.catalog_dir.chmod(0o700)
    payload = prepared.catalog_manifest.inventory.catalog_files[0]
    payload_path = prepared.catalog_dir / payload.relative_path
    if attack == "extra":
        extra = prepared.catalog_dir / "extra.bin"
        extra.write_bytes(b"not-declared")
        extra.chmod(0o400)
        prepared.catalog_dir.chmod(0o500)
    elif attack == "missing":
        payload_path.parent.chmod(0o700)
        payload_path.unlink()
        payload_path.parent.chmod(0o500)
        prepared.catalog_dir.chmod(0o500)
    else:
        payload_path.chmod(0o600)
        prepared.catalog_dir.chmod(0o500)

    with pytest.raises(InputAdapterError):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


@pytest.mark.parametrize("path_value", ["/absolute.parquet", "../escape.parquet"])
def test_catalog_manifest_rejects_absolute_and_parent_paths(
    tmp_path: Path,
    path_value: str,
) -> None:
    prepared = _prepare(tmp_path)
    _install_malicious_catalog(prepared, path_value=path_value, duplicate=False)

    with pytest.raises(InputAdapterError):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


def test_catalog_manifest_rejects_duplicate_declared_paths(tmp_path: Path) -> None:
    prepared = _prepare(tmp_path)
    _install_malicious_catalog(prepared, path_value=None, duplicate=True)

    with pytest.raises(InputAdapterError):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


def test_environment_cannot_override_economic_or_path_inputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared = _prepare(tmp_path)
    monkeypatch.setenv("STRATEGY_PATH", "evil.module:Strategy")
    monkeypatch.setenv("MAX_NOTIONAL", "999999999")
    monkeypatch.setenv("CATALOG_PATH", "/tmp/evil")
    monkeypatch.setenv("OPENAI_API_KEY", "not-visible-to-runner")

    loaded = load_runner_input(
        run_id=_RUN_ID,
        staging_dir=prepared.staging,
        input_manifest=prepared.manifest_path,
    )

    assert loaded.catalog_dir == prepared.catalog_dir
    assert loaded.manifest.canonical_config == _strategy()
    assert loaded.manifest.canonical_risk_policy == {"max_notional": "1600"}


def test_catalog_checksum_is_independently_recomputed_from_declared_files(
    tmp_path: Path,
) -> None:
    prepared = _prepare(tmp_path)
    forged_checksum = "d" * 64
    original = json.loads((prepared.catalog_dir / "catalog-manifest.json").read_bytes())
    original["catalog_checksum"] = forged_checksum
    original["inventory"]["catalog_checksum"] = forged_checksum
    inventory_bytes = canonical_json_bytes(original["inventory"])
    original["inventory_hash"] = sha256(inventory_bytes).hexdigest()
    publication_bytes = canonical_json_bytes(original)
    revision = sha256(publication_bytes).hexdigest()
    malicious = prepared.runtime / "catalogs" / revision
    shutil.copytree(prepared.catalog_dir, malicious)
    malicious.chmod(0o700)
    sidecar = malicious / "catalog-manifest.json"
    sidecar.chmod(0o600)
    sidecar.write_bytes(publication_bytes)
    sidecar.chmod(0o400)
    malicious.chmod(0o500)
    manifest = json.loads(prepared.manifest_path.read_bytes())
    manifest["catalog_revision"] = revision
    manifest["catalog_checksum"] = forged_checksum
    prepared.manifest_path.write_bytes(canonical_json_bytes(manifest))
    prepared.manifest_path.chmod(0o600)

    with pytest.raises(InputAdapterError, match="CATALOG_CHECKSUM"):
        load_runner_input(
            run_id=_RUN_ID,
            staging_dir=prepared.staging,
            input_manifest=prepared.manifest_path,
        )


def _install_malicious_catalog(
    prepared: PreparedInput,
    *,
    path_value: str | None,
    duplicate: bool,
) -> None:
    original = json.loads((prepared.catalog_dir / "catalog-manifest.json").read_bytes())
    inventory = original["inventory"]
    files = inventory["catalog_files"]
    assert isinstance(files, list) and files
    if duplicate:
        files.append(deepcopy(files[0]))
    else:
        files[0]["relative_path"] = path_value
    inventory_bytes = json.dumps(
        inventory,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    original["inventory_hash"] = sha256(inventory_bytes).hexdigest()
    publication_bytes = json.dumps(
        original,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    revision = sha256(publication_bytes).hexdigest()
    malicious = prepared.runtime / "catalogs" / revision
    shutil.copytree(prepared.catalog_dir, malicious)
    malicious.chmod(0o700)
    sidecar = malicious / "catalog-manifest.json"
    sidecar.chmod(0o600)
    sidecar.write_bytes(publication_bytes)
    sidecar.chmod(0o400)
    malicious.chmod(0o500)

    manifest = json.loads(prepared.manifest_path.read_bytes())
    manifest["catalog_revision"] = revision
    manifest_bytes = canonical_json_bytes(manifest)
    prepared.manifest_path.write_bytes(manifest_bytes)
    prepared.manifest_path.chmod(0o600)
