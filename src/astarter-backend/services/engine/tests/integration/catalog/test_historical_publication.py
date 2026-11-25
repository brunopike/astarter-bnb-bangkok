from __future__ import annotations

import json
import os
import subprocess
from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import pytest
from nautilus_trader.persistence import ParquetDataCatalog

import stark_trading_os.catalog.historical_catalog as historical_catalog_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.catalog.fixture_publisher import CatalogPublishError, FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.catalog.historical_catalog import (
    canonical_historical_bytes,
    parse_historical_manifest_bytes,
)
from stark_trading_os.catalog.historical_source import validate_historical_source
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogRecoveryBlocked,
    ControlStore,
    ControlStoreError,
)

REPOSITORY_ROOT = Path(__file__).parents[5]
ENGINE_ROOT = REPOSITORY_ROOT / "services" / "engine"
PYTHON = ENGINE_ROOT / ".venv" / "bin" / "python"
NOW_NS = 1_700_000_400_000_000_000


def _csv_bytes(*, timeframe_ns: int = 60_000_000_000) -> bytes:
    first_open = 1_700_000_000_000_000_000
    first_close = first_open + timeframe_ns
    second_close = first_close + timeframe_ns
    return (
        "open_time_ns,close_time_ns,available_time_ns,open,high,low,close,volume\n"
        f"{first_open},{first_close},{first_close},"
        "100.00,110.00,90.00,105.00,100.000\n"
        f"{first_close},{second_close},{second_close},"
        "200.00,220.00,180.00,210.00,100.000\n"
    ).encode()


def _metadata_bytes(
    csv_bytes: bytes,
    *,
    timeframe_ns: int = 60_000_000_000,
    name: str = "Synthetic publication bars",
    raw_symbol: str = "ETHUSDT",
) -> bytes:
    value = {
        "schema": "HistoricalBarSource.v1",
        "source": {
            "name": name,
            "origin": "generated test input; not market data",
            "retrieved_at_ns": "1700000300000000000",
            "raw_sha256": sha256(csv_bytes).hexdigest(),
        },
        "instrument": {
            "market": "SYNTHETIC",
            "raw_symbol": raw_symbol,
            "base_currency": "ETH",
            "quote_currency": "USDT",
            "price_precision": 2,
            "size_precision": 3,
            "price_increment": "0.01",
            "size_increment": "0.001",
            "minimum_quantity": "0.001",
            "specification_source": "test assumptions",
            "specification_status": "EXPLICIT_ASSUMPTION",
        },
        "timeframe_ns": str(timeframe_ns),
        "timestamp_mapping": "UTC nanoseconds, half-open, available at close",
        "availability_source": "ASSUMED_AT_CLOSE",
        "purpose": "SYNTHETIC_QA",
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _source(
    *,
    timeframe_ns: int = 60_000_000_000,
    name: str = "Synthetic publication bars",
    raw_symbol: str = "ETHUSDT",
):
    csv_bytes = _csv_bytes(timeframe_ns=timeframe_ns)
    metadata_bytes = _metadata_bytes(
        csv_bytes,
        timeframe_ns=timeframe_ns,
        name=name,
        raw_symbol=raw_symbol,
    )
    return validate_historical_source(csv_bytes, metadata_bytes, now_ns=NOW_NS)


def _publisher(tmp_path: Path) -> tuple[FixturePublisher, ControlStore]:
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 100)
    return (
        FixturePublisher(
            registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
            control=store,
            runtime_root=tmp_path / "runtime",
        ),
        store,
    )


def _publication_with_mismatched_native_descriptor(
    publication_bytes: bytes,
    *,
    descriptor_field: str,
) -> tuple[bytes, str, str]:
    payload = json.loads(publication_bytes)
    assert isinstance(payload, dict)
    inventory = payload["inventory"]
    assert isinstance(inventory, dict)
    native_files = inventory["native_returned_files"]
    assert isinstance(native_files, list)
    native_file = native_files[0]
    assert isinstance(native_file, dict)
    if descriptor_field == "sha256":
        native_file["sha256"] = "0" * 64
    elif descriptor_field == "size_bytes":
        size_bytes = native_file["size_bytes"]
        assert isinstance(size_bytes, int)
        native_file["size_bytes"] = size_bytes + 1
    else:
        raise AssertionError(f"Unsupported descriptor field: {descriptor_field}")
    inventory_hash = sha256(canonical_historical_bytes(inventory)).hexdigest()
    payload["inventory_hash"] = inventory_hash
    changed_bytes = canonical_historical_bytes(payload)
    revision = sha256(changed_bytes).hexdigest()
    return changed_bytes, inventory_hash, revision


class SimulatedProcessDeath(BaseException):
    pass


class CrashPublisher(FixturePublisher):
    def __init__(
        self,
        *,
        crash_point: str,
        registry: FixtureRegistry,
        control: ControlStore,
        runtime_root: Path,
    ) -> None:
        super().__init__(
            registry=registry,
            control=control,
            runtime_root=runtime_root,
        )
        self._crash_point = crash_point

    def _checkpoint(self, point: str) -> None:
        if point == self._crash_point:
            raise SimulatedProcessDeath(point)


def test_historical_publication_is_native_immutable_idempotent_and_coexists_with_v1(
    tmp_path: Path,
) -> None:
    source = _source()
    original_csv = bytes(source.csv_bytes)
    original_metadata = bytes(source.metadata_bytes)
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(source)

        assert publication.status == "PUBLISHED"
        assert publication.fixture_id == source.source_id
        assert publication.catalog_revision == sha256(publication.publication_bytes).hexdigest()
        assert service.revalidate(publication.catalog_revision) == publication
        assert service.publish_historical(source) == publication
        assert source.csv_bytes == original_csv
        assert source.metadata_bytes == original_metadata

        manifest = parse_historical_manifest_bytes(publication.publication_bytes)
        assert manifest.schema_ == "CatalogManifest.v2"
        assert manifest.source_id == source.source_id
        assert manifest.inventory.source_id == source.source_id
        assert manifest.inventory.record_count == source.record_count
        assert manifest.inventory.raw_sha256 == source.raw_sha256
        assert manifest.inventory.metadata_sha256 == source.metadata_sha256

        target = tmp_path / "runtime" / "catalogs" / publication.catalog_revision
        assert (target / "source" / "bars.csv").read_bytes() == original_csv
        assert (target / "source" / "source.json").read_bytes() == original_metadata
        native = ParquetDataCatalog(str(target.resolve()))
        bars = native.query_bars()
        assert bars[0].ts_event == int(source.records[0].close_time_ns)
        assert bars[0].ts_init == int(source.records[0].available_time_ns)

        fixture = service.publish("local-qa-v1")
        assert fixture.status == "PUBLISHED"
        assert service.revalidate(fixture.catalog_revision) == fixture
        assert service.revalidate(publication.catalog_revision) == publication
    finally:
        store.close()


def test_metadata_only_change_creates_a_distinct_historical_version(tmp_path: Path) -> None:
    first = _source(name="Synthetic publication bars")
    second = _source(name="Synthetic publication bars revised")
    assert first.csv_bytes == second.csv_bytes
    service, store = _publisher(tmp_path)
    try:
        first_publication = service.publish_historical(first)
        second_publication = service.publish_historical(second)

        assert first_publication.catalog_revision != second_publication.catalog_revision
        assert first_publication.inventory_hash != second_publication.inventory_hash
        assert first_publication.fixture_id == first.source_id
        assert second_publication.fixture_id == second.source_id
        assert service.revalidate(first_publication.catalog_revision) == first_publication
        assert service.revalidate(second_publication.catalog_revision) == second_publication
    finally:
        store.close()


def test_unsupported_exact_timeframe_is_rejected_before_native_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source(timeframe_ns=7_000_000_000)
    service, store = _publisher(tmp_path)
    writer_constructed = False

    def forbidden_writer(_path: str) -> object:
        nonlocal writer_constructed
        writer_constructed = True
        raise AssertionError("native writer must not be constructed")

    try:
        monkeypatch.setattr(
            historical_catalog_module,
            "ParquetDataCatalog",
            forbidden_writer,
        )
        with pytest.raises(
            CatalogPublishError,
            match="HISTORICAL_TIMEFRAME_UNSUPPORTED",
        ):
            service.publish_historical(source)
        assert writer_constructed is False
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


def test_forged_frozen_source_is_rejected_without_authority(tmp_path: Path) -> None:
    source = _source()
    service, store = _publisher(tmp_path)
    try:
        with pytest.raises(CatalogPublishError, match="HISTORICAL_SOURCE_FORGED"):
            service.publish_historical(replace(source, source_id="0" * 64))
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


@pytest.mark.parametrize(
    "relative_path",
    ["source/bars.csv", "source/source.json", "native"],
)
def test_published_source_and_native_tampering_fail_closed(
    tmp_path: Path,
    relative_path: str,
) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        target = tmp_path / "runtime" / "catalogs" / publication.catalog_revision
        if relative_path == "native":
            changed = next(path for path in target.rglob("*.parquet") if path.is_file())
        else:
            changed = target / relative_path
        os.chmod(changed, 0o600)
        changed.write_bytes(changed.read_bytes() + b"tampered")
        os.chmod(changed, 0o400)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
        retained = store.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "INTEGRITY_FAILED"
    finally:
        store.close()


def test_v2_audit_schema_must_match_manifest_schema(tmp_path: Path) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        assert publication.audit_intent_bytes is not None
        wrong_audit = {
            "schema": "CatalogValidatedAudit.v1",
            "action": "catalog.validated",
            "fixture_id": publication.fixture_id,
            "catalog_revision": publication.catalog_revision,
            "inventory_hash": publication.inventory_hash,
            "source_checksum": "a" * 64,
            "catalog_checksum": "b" * 64,
        }
        with pytest.raises(ValueError, match="CatalogValidatedAudit.v2"):
            store.publish_catalog_publication(
                catalog_revision=publication.catalog_revision,
                fixture_id=publication.fixture_id,
                inventory_hash=publication.inventory_hash,
                publication_bytes=publication.publication_bytes,
                staging_identity=publication.staging_identity,
                audit_intent_bytes=canonical_json_bytes(wrong_audit),
            )
        assert store.catalog_publication(publication.catalog_revision) == publication
    finally:
        store.close()


def test_transaction_authority_rejects_self_hashed_nested_v2_mismatch(
    tmp_path: Path,
) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        payload = json.loads(publication.publication_bytes)
        assert isinstance(payload, dict)
        inventory = payload["inventory"]
        assert isinstance(inventory, dict)
        readback = inventory["readback"]
        assert isinstance(readback, dict)
        readback["bar_count"] = 3
        inventory_hash = sha256(canonical_historical_bytes(inventory)).hexdigest()
        payload["inventory_hash"] = inventory_hash
        publication_bytes = canonical_historical_bytes(payload)
        revision = sha256(publication_bytes).hexdigest()

        with pytest.raises(CatalogConflict):
            store.prepare_catalog_publication(
                catalog_revision=revision,
                fixture_id=publication.fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=f"prepared-{revision}",
            )
        assert store.catalog_publication(revision) is None
    finally:
        store.close()


@pytest.mark.parametrize("descriptor_field", ["sha256", "size_bytes"])
def test_transaction_authority_rejects_self_hashed_native_descriptor_mismatch(
    tmp_path: Path,
    descriptor_field: str,
) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        publication_bytes, inventory_hash, revision = (
            _publication_with_mismatched_native_descriptor(
                publication.publication_bytes,
                descriptor_field=descriptor_field,
            )
        )

        with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
            store.prepare_catalog_publication(
                catalog_revision=revision,
                fixture_id=publication.fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=f"prepared-{revision}",
            )
        assert store.catalog_publication(revision) is None
    finally:
        store.close()


@pytest.mark.parametrize("descriptor_field", ["sha256", "size_bytes"])
def test_persisted_native_descriptor_mismatch_is_rejected_on_read(
    tmp_path: Path,
    descriptor_field: str,
) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        publication_bytes, inventory_hash, revision = (
            _publication_with_mismatched_native_descriptor(
                publication.publication_bytes,
                descriptor_field=descriptor_field,
            )
        )
        store._connection.execute(
            """
            INSERT INTO catalog_publications (
                catalog_revision, fixture_id, status, inventory_hash,
                publication_bytes, staging_identity, prepared_at_ns, published_at_ns
            ) VALUES (?, ?, 'PREPARED', ?, ?, ?, 100, NULL)
            """,
            (
                revision,
                publication.fixture_id,
                inventory_hash,
                publication_bytes,
                f"prepared-{revision}",
            ),
        )

        with pytest.raises(ControlStoreError, match="Persisted catalog"):
            store.catalog_publication(revision)
    finally:
        store.close()


def test_transaction_authority_recomputes_v2_mapping_relationships(
    tmp_path: Path,
) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        mutations = (
            ("native-symbol", "HIST" + ("0" * 20)),
            ("source-raw-symbol", "forged-provenance"),
            ("bar-type", "HIST00000000000000000000.SIM-7-SECOND-LAST-EXTERNAL"),
            ("first-availability", "1700000060000000001"),
        )
        for mutation, value in mutations:
            payload = json.loads(publication.publication_bytes)
            assert isinstance(payload, dict)
            inventory = payload["inventory"]
            assert isinstance(inventory, dict)
            instrument = inventory["instrument"]
            readback = inventory["readback"]
            window = inventory["window"]
            assert isinstance(instrument, dict)
            assert isinstance(readback, dict)
            assert isinstance(window, dict)
            readback_instrument = readback["instrument"]
            first_bar = readback["first_bar"]
            assert isinstance(readback_instrument, dict)
            assert isinstance(first_bar, dict)
            if mutation == "native-symbol":
                instrument["native_symbol"] = value
                readback_instrument["native_symbol"] = value
            elif mutation == "source-raw-symbol":
                instrument["source_raw_symbol"] = value
                readback_instrument["source_raw_symbol"] = value
            elif mutation == "bar-type":
                inventory["bar_type"] = value
                readback["bar_type"] = value
            else:
                window["first_available_ns"] = value
                instrument["ts_init_ns"] = value
                readback_instrument["ts_init_ns"] = value
                readback["first_ts_init"] = value
                first_bar["ts_init"] = value
            inventory_hash = sha256(canonical_historical_bytes(inventory)).hexdigest()
            payload["inventory_hash"] = inventory_hash
            publication_bytes = canonical_historical_bytes(payload)
            revision = sha256(publication_bytes).hexdigest()

            with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
                store.prepare_catalog_publication(
                    catalog_revision=revision,
                    fixture_id=publication.fixture_id,
                    inventory_hash=inventory_hash,
                    publication_bytes=publication_bytes,
                    staging_identity=f"prepared-{revision}",
                )
    finally:
        store.close()


def test_persisted_v2_audit_tampering_is_rejected_on_read(tmp_path: Path) -> None:
    service, store = _publisher(tmp_path)
    try:
        publication = service.publish_historical(_source())
        assert publication.audit_intent_bytes is not None
        audit = json.loads(publication.audit_intent_bytes)
        assert isinstance(audit, dict)
        audit["source_id"] = "0" * 64
        store._connection.execute(
            "UPDATE catalog_audit_intents SET intent_bytes = ? WHERE catalog_revision = ?",
            (canonical_historical_bytes(audit), publication.catalog_revision),
        )

        with pytest.raises(ControlStoreError, match="Persisted catalog"):
            store.catalog_publication(publication.catalog_revision)
    finally:
        store.close()


@pytest.mark.parametrize(
    "crash_point",
    ["after_staging", "after_prepare", "after_rename", "after_readonly", "after_db_publish"],
)
def test_all_historical_crash_points_recover_with_fresh_store(
    tmp_path: Path,
    crash_point: str,
) -> None:
    database = tmp_path / "control.sqlite"
    runtime = tmp_path / "runtime"
    source = _source()
    first = ControlStore.open(database, clock=lambda: 100)
    crashing = CrashPublisher(
        crash_point=crash_point,
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=first,
        runtime_root=runtime,
    )
    try:
        with pytest.raises(SimulatedProcessDeath, match=crash_point):
            crashing.publish_historical(source)
    finally:
        first.close()

    second = ControlStore.open(database, clock=lambda: 200)
    recovered_service = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=second,
        runtime_root=runtime,
    )
    try:
        if crash_point == "after_prepare":
            prepared = second.recoverable_catalog_publications()[0]
            assert prepared.status == "PREPARED"
            with pytest.raises(CatalogRecoveryBlocked):
                recovered_service.revalidate(prepared.catalog_revision)
        recovered = recovered_service.recover()
        if crash_point == "after_staging":
            assert recovered == ()
            published = recovered_service.publish_historical(source)
        else:
            assert len(recovered) == 1
            published = recovered[0]
        assert published.status == "PUBLISHED"
        assert recovered_service.revalidate(published.catalog_revision) == published
    finally:
        second.close()


def test_unknown_schema_staging_is_retained_and_blocks_recovery(tmp_path: Path) -> None:
    service, store = _publisher(tmp_path)
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    staging = runtime / "catalog-staging"
    staging.mkdir(mode=0o700)
    (runtime / "catalogs").mkdir(mode=0o700)
    raw = canonical_historical_bytes(
        {"schema": "CatalogManifest.v999", "sentinel": "retain-me"}
    )
    revision = sha256(raw).hexdigest()
    prepared = staging / f"prepared-{revision}"
    prepared.mkdir(mode=0o700)
    sidecar = prepared / "catalog-manifest.json"
    sidecar.write_bytes(raw)
    sidecar.chmod(0o600)
    try:
        with pytest.raises(CatalogPublishError, match="CATALOG_SCHEMA_UNSUPPORTED"):
            service.recover()
        assert prepared.is_dir()
        assert sidecar.read_bytes() == raw
    finally:
        store.close()


@pytest.mark.parametrize("entry_kind", ["unexpected-file", "symlink"])
def test_unexpected_entries_and_symlinks_fail_closed(
    tmp_path: Path,
    entry_kind: str,
) -> None:
    service, store = _publisher(tmp_path)
    altered: Path | None = None
    target: Path | None = None
    try:
        publication = service.publish_historical(_source())
        target = tmp_path / "runtime" / "catalogs" / publication.catalog_revision
        target.chmod(0o700)
        if entry_kind == "unexpected-file":
            altered = target / "unexpected.bin"
            altered.write_bytes(b"unexpected")
            altered.chmod(0o400)
        else:
            outside = tmp_path / "outside.bin"
            outside.write_bytes(b"outside")
            altered = target / "unsafe-link"
            altered.symlink_to(outside)
        target.chmod(0o500)

        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            service.revalidate(publication.catalog_revision)
        retained = store.catalog_publication(publication.catalog_revision)
        assert retained is not None and retained.status == "INTEGRITY_FAILED"
    finally:
        if target is not None and altered is not None:
            target.chmod(0o700)
            altered.unlink(missing_ok=True)
            target.chmod(0o500)
        store.close()


def _write_cli_source(root: Path) -> tuple[bytes, bytes]:
    root.mkdir(mode=0o700)
    csv_bytes = _csv_bytes()
    metadata_bytes = _metadata_bytes(csv_bytes)
    (root / "bars.csv").write_bytes(csv_bytes)
    (root / "source.json").write_bytes(metadata_bytes)
    return csv_bytes, metadata_bytes


def _run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            str(PYTHON),
            "-m",
            "stark_trading_os.catalog.historical_import",
            *arguments,
        ],
        cwd=ENGINE_ROOT,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


def _cli_payload(completed: subprocess.CompletedProcess[str]) -> dict[str, object]:
    assert completed.stderr == ""
    lines = completed.stdout.splitlines()
    assert len(lines) == 1
    value = json.loads(lines[0])
    assert type(value) is dict
    return value


def test_operator_cli_publishes_revalidates_and_repeats_without_source_mutation(
    tmp_path: Path,
) -> None:
    source_root = (tmp_path / "source").resolve()
    runtime_root = (tmp_path / "runtime").resolve()
    csv_bytes, metadata_bytes = _write_cli_source(source_root)

    first = _run_cli(str(source_root), str(runtime_root))
    second = _run_cli(str(source_root), str(runtime_root))

    assert first.returncode == 0
    assert second.returncode == 0
    first_payload = _cli_payload(first)
    second_payload = _cli_payload(second)
    assert first_payload == second_payload
    assert first_payload["status"] == "PUBLISHED"
    assert first_payload["catalog_published"] is True
    assert first_payload["record_count"] == 2
    assert first_payload["source_id"]
    assert first_payload["catalog_revision"]
    assert first_payload["inventory_hash"]
    assert (source_root / "bars.csv").read_bytes() == csv_bytes
    assert (source_root / "source.json").read_bytes() == metadata_bytes


def test_operator_cli_rejects_usage_and_source_runtime_overlap_without_paths(
    tmp_path: Path,
) -> None:
    source_root = (tmp_path / "source-sentinel").resolve()
    _write_cli_source(source_root)

    usage = _run_cli(str(source_root))
    overlap = _run_cli(str(source_root), str(source_root / "runtime-sentinel"))

    assert usage.returncode == 2
    assert _cli_payload(usage) == {
        "code": "HISTORICAL_IMPORT_USAGE_INVALID",
        "status": "REJECTED",
    }
    assert overlap.returncode == 2
    assert _cli_payload(overlap) == {
        "code": "HISTORICAL_RUNTIME_OVERLAP",
        "status": "REJECTED",
    }
    rendered = overlap.stdout + overlap.stderr
    assert "source-sentinel" not in rendered
    assert "runtime-sentinel" not in rendered
    assert not (source_root / "runtime-sentinel").exists()


def test_operator_cli_rejects_noncanonical_and_symlink_runtime_before_writes(
    tmp_path: Path,
) -> None:
    source_root = (tmp_path / "source").resolve()
    _write_cli_source(source_root)
    symlink_target = (tmp_path / "runtime-target").resolve()
    symlink_target.mkdir(mode=0o700)
    symlink_runtime = tmp_path / "runtime-link-sentinel"
    symlink_runtime.symlink_to(symlink_target, target_is_directory=True)
    traversal_runtime = f"{tmp_path.resolve()}/segment/../runtime-traversal-sentinel"

    symlink_result = _run_cli(str(source_root), str(symlink_runtime))
    traversal_result = _run_cli(str(source_root), traversal_runtime)

    assert symlink_result.returncode == 2
    assert traversal_result.returncode == 2
    expected = {
        "code": "HISTORICAL_RUNTIME_PATH_INVALID",
        "status": "REJECTED",
    }
    assert _cli_payload(symlink_result) == expected
    assert _cli_payload(traversal_result) == expected
    rendered = (
        symlink_result.stdout
        + symlink_result.stderr
        + traversal_result.stdout
        + traversal_result.stderr
    )
    assert "runtime-link-sentinel" not in rendered
    assert "runtime-traversal-sentinel" not in rendered
    assert not (symlink_target / "control.sqlite").exists()
    assert not (tmp_path / "runtime-traversal-sentinel").exists()
