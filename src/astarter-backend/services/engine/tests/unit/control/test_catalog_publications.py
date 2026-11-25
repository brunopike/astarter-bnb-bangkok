from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

import pytest

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogPublication,
    CatalogStorageFailed,
    ControlStore,
    ControlStoreError,
)
from stark_trading_os.domain.models import (
    CatalogFileV1,
    CatalogInstrumentV1,
    CatalogInventoryV1,
    CatalogManifestV1,
    CatalogMappingV1,
    CatalogNativeFingerprintV1,
    CatalogReadbackV1,
    CatalogSourceRecordV1,
    CatalogValidatedAuditV1,
    EvaluationProtocolV1,
    InformationSetPolicyV1,
)


def publication_identity() -> tuple[str, str, bytes, bytes]:
    instrument = CatalogInstrumentV1(
        instrument_id="ETH/USDT.SIM", raw_symbol="ETH/USDT", venue="SIM",
        base_currency="ETH", quote_currency="USDT", price_precision=2,
        size_precision=3, price_increment="0.01", size_increment="0.001",
        minimum_quantity="0.001", margin_init="0.1", margin_maint="0.05",
        maker_fee="0", taker_fee="0", ts_event_ns="1", ts_available_ns="1",
    )
    record = CatalogSourceRecordV1(
        instrument_id=instrument.instrument_id, bid_price="99.00", ask_price="100.00",
        bid_size="10.000", ask_size="10.000", ts_event_ns="1", ts_available_ns="1",
        source_seq=1, source_revision="local-qa-v1", record_hash="b" * 64,
    )
    second_record = record.model_copy(
        update={"ts_event_ns": "10", "ts_available_ns": "10", "source_seq": 2,
                "record_hash": "c" * 64}
    )
    policy = InformationSetPolicyV1.model_validate(
        {"schema": "InformationSetPolicy.v1", "availability_field": "ts_available_ns",
         "nautilus_timestamp_field": "ts_init",
         "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
         "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
         "bar_rule": "CLOSED_AND_AVAILABLE",
         "source_revision_rule": "SINGLE_IMMUTABLE_REVISION"}
    )
    evaluation = EvaluationProtocolV1.model_validate(
        {"schema": "EvaluationProtocol.v1", "mode": "fixture_only", "train": None,
         "tune": None, "out_of_sample": None, "purge_ns": "0", "embargo_ns": "0"}
    )
    inventory = CatalogInventoryV1(
        schema="CatalogInventory.v1", fixture_id="local-qa-v1", label="LOCAL QA FIXTURE",
        source_revision="local-qa-v1", timezone="UTC", purpose="LOCAL_QA_ONLY",
        source_checksum="c" * 64, catalog_checksum="d" * 64,
        catalog_files=(
            CatalogFileV1(relative_path="data/z.parquet", size_bytes=2, sha256="f" * 64),
            CatalogFileV1(relative_path="data/x.parquet", size_bytes=1, sha256="e" * 64),
        ),
        instrument=instrument, source_records=(second_record, record),
        readback=CatalogReadbackV1(instrument=instrument, quote_count=2,
                                   first_ts_init="1", last_ts_init="10",
                                   data_types=("instruments", "quotes")),
        mapping=CatalogMappingV1(
            schema="CatalogMapping.v1",
            event_timestamp="ts_event_ns -> QuoteTick.ts_event",
            availability_timestamp="ts_available_ns -> QuoteTick.ts_init",
            source_identity=(
                "source_seq/source_revision/record_hash -> catalog-manifest.json"
            ),
        ),
        native_fingerprint=CatalogNativeFingerprintV1(
            schema="CatalogNativeFingerprint.v1",
            installed_nautilus_version="2.0.0rc3",
            python_version="3.12.4", platform_system="Darwin", platform_machine="arm64",
            native_extension_sha256="9" * 64,
            writer_class="nautilus_trader.persistence.ParquetDataCatalog",
            writer_options=(
                "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
            ),
        ),
        information_set_policy=policy, evaluation_protocol=evaluation,
        gaps=(), duplicates=(), ordering_result="PASS",
    )
    inventory_bytes = canonical_json_bytes(inventory.model_dump(mode="json", by_alias=True))
    inventory_hash = sha256(inventory_bytes).hexdigest()
    manifest = CatalogManifestV1(
        schema="CatalogManifest.v1", fixture_id="local-qa-v1", label="LOCAL QA FIXTURE",
        source_checksum=inventory.source_checksum, catalog_checksum=inventory.catalog_checksum,
        inventory_hash=inventory_hash, inventory=inventory,
    )
    publication_bytes = canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
    revision = sha256(publication_bytes).hexdigest()
    audit = CatalogValidatedAuditV1(
        schema="CatalogValidatedAudit.v1", action="catalog.validated",
        fixture_id="local-qa-v1", catalog_revision=revision,
        inventory_hash=inventory_hash, source_checksum=inventory.source_checksum,
        catalog_checksum=inventory.catalog_checksum,
    )
    audit_bytes = canonical_json_bytes(audit.model_dump(mode="json", by_alias=True))
    return revision, inventory_hash, publication_bytes, audit_bytes


def prepare(store: ControlStore, *, staging_identity: str | None = None) -> CatalogPublication:
    revision, inventory_hash, publication_bytes, _ = publication_identity()
    return store.prepare_catalog_publication(
        catalog_revision=revision, fixture_id="local-qa-v1", inventory_hash=inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=staging_identity or f"prepared-{revision}",
    )


def test_prepare_is_exactly_idempotent_and_conflicts_on_identity_change(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 10)
    try:
        first = prepare(store)
        assert prepare(store) == first
        with pytest.raises(CatalogConflict, match="CATALOG_CONFLICT"):
            store.prepare_catalog_publication(
                catalog_revision=first.catalog_revision, fixture_id="other-fixture",
                inventory_hash=first.inventory_hash, publication_bytes=first.publication_bytes,
                staging_identity=first.staging_identity,
            )
        with pytest.raises(ValueError, match="derived from the revision"):
            prepare(store, staging_identity="different")
    finally:
        store.close()


def test_publish_commits_status_and_one_catalog_audit_atomically(tmp_path: Path) -> None:
    database = tmp_path / "control.sqlite"
    store = ControlStore.open(database, clock=lambda: 11)
    revision, inventory_hash, publication_bytes, audit_bytes = publication_identity()
    try:
        prepared = prepare(store)
        published = store.publish_catalog_publication(
            catalog_revision=revision, fixture_id=prepared.fixture_id,
            inventory_hash=inventory_hash, publication_bytes=publication_bytes,
            staging_identity=prepared.staging_identity, audit_intent_bytes=audit_bytes,
        )
        assert published.status == "PUBLISHED"
        assert published.published_at_ns == 11
        assert published.audit_intent_bytes == audit_bytes
        assert store.publish_catalog_publication(
            catalog_revision=revision, fixture_id=prepared.fixture_id,
            inventory_hash=inventory_hash, publication_bytes=publication_bytes,
            staging_identity=prepared.staging_identity, audit_intent_bytes=audit_bytes,
        ) == published
    finally:
        store.close()

    inspection = open_control_database(database)
    try:
        assert inspection.execute("SELECT count(*) FROM catalog_audit_intents").fetchone()[0] == 1
        assert inspection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
        assert inspection.execute("SELECT count(*) FROM outbox").fetchone()[0] == 0
    finally:
        inspection.close()


def test_audit_insert_failure_rolls_publish_back_to_prepared(tmp_path: Path) -> None:
    database = tmp_path / "control.sqlite"
    store = ControlStore.open(database, clock=lambda: 12)
    revision, inventory_hash, publication_bytes, audit_bytes = publication_identity()
    prepared = prepare(store)
    trigger_connection = open_control_database(database)
    trigger_connection.execute(
        "CREATE TRIGGER reject_catalog_audit BEFORE INSERT ON catalog_audit_intents "
        "BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    trigger_connection.close()
    try:
        with pytest.raises(CatalogStorageFailed, match="CATALOG_STORAGE_FAILED"):
            store.publish_catalog_publication(
                catalog_revision=revision, fixture_id=prepared.fixture_id,
                inventory_hash=inventory_hash, publication_bytes=publication_bytes,
                staging_identity=prepared.staging_identity, audit_intent_bytes=audit_bytes,
            )
        retained = store.catalog_publication(revision)
        assert retained is not None and retained.status == "PREPARED"
    finally:
        store.close()


def test_publication_update_failure_leaves_prepared_without_audit(tmp_path: Path) -> None:
    database = tmp_path / "control.sqlite"
    store = ControlStore.open(database, clock=lambda: 12)
    revision, inventory_hash, publication_bytes, audit_bytes = publication_identity()
    prepared = prepare(store)
    trigger_connection = open_control_database(database)
    trigger_connection.execute(
        "CREATE TRIGGER reject_catalog_publish BEFORE UPDATE OF status "
        "ON catalog_publications WHEN NEW.status = 'PUBLISHED' "
        "BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    try:
        with pytest.raises(CatalogStorageFailed, match="CATALOG_STORAGE_FAILED"):
            store.publish_catalog_publication(
                catalog_revision=revision,
                fixture_id=prepared.fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=prepared.staging_identity,
                audit_intent_bytes=audit_bytes,
            )
        retained = store.catalog_publication(revision)
        assert retained is not None and retained.status == "PREPARED"
        assert trigger_connection.execute(
            "SELECT count(*) FROM catalog_audit_intents"
        ).fetchone()[0] == 0
    finally:
        store.close()
        trigger_connection.close()


def test_only_published_identity_can_be_marked_integrity_failed(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 13)
    revision, inventory_hash, publication_bytes, audit_bytes = publication_identity()
    try:
        prepared = prepare(store)
        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            store.mark_catalog_integrity_failed(
                catalog_revision=revision, fixture_id=prepared.fixture_id,
                inventory_hash=inventory_hash, publication_bytes=publication_bytes,
                staging_identity=prepared.staging_identity,
            )
        published = store.publish_catalog_publication(
            catalog_revision=revision, fixture_id=prepared.fixture_id,
            inventory_hash=inventory_hash, publication_bytes=publication_bytes,
            staging_identity=prepared.staging_identity, audit_intent_bytes=audit_bytes,
        )
        failed = store.mark_catalog_integrity_failed(
            catalog_revision=revision, fixture_id=published.fixture_id,
            inventory_hash=inventory_hash, publication_bytes=publication_bytes,
            staging_identity=published.staging_identity,
        )
        assert failed.status == "INTEGRITY_FAILED"
        assert failed.published_at_ns == published.published_at_ns
        assert failed.audit_intent_bytes == audit_bytes
        with pytest.raises(CatalogIntegrityFailed, match="CATALOG_INTEGRITY_FAILED"):
            store.publish_catalog_publication(
                catalog_revision=revision, fixture_id=published.fixture_id,
                inventory_hash=inventory_hash, publication_bytes=publication_bytes,
                staging_identity=published.staging_identity, audit_intent_bytes=audit_bytes,
            )
    finally:
        store.close()


def test_published_row_with_missing_audit_is_rejected_as_inconsistent(tmp_path: Path) -> None:
    database = tmp_path / "control.sqlite"
    store = ControlStore.open(database, clock=lambda: 13)
    revision, inventory_hash, publication_bytes, audit_bytes = publication_identity()
    try:
        prepared = prepare(store)
        store.publish_catalog_publication(
            catalog_revision=revision,
            fixture_id=prepared.fixture_id,
            inventory_hash=inventory_hash,
            publication_bytes=publication_bytes,
            staging_identity=prepared.staging_identity,
            audit_intent_bytes=audit_bytes,
        )
        tamper = open_control_database(database)
        try:
            tamper.execute(
                "DELETE FROM catalog_audit_intents WHERE catalog_revision = ?",
                (revision,),
            )
        finally:
            tamper.close()

        with pytest.raises(ControlStoreError, match="evidence is incomplete"):
            store.catalog_publication(revision)
    finally:
        store.close()


def test_recovery_enumeration_is_fixed_to_prepared_and_published_in_revision_order(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: 14)
    revision, inventory_hash, publication_bytes, audit_bytes = publication_identity()
    try:
        item = prepare(store)
        assert store.recoverable_catalog_publications() == (item,)
        published = store.publish_catalog_publication(
            catalog_revision=revision, fixture_id=item.fixture_id,
            inventory_hash=inventory_hash, publication_bytes=publication_bytes,
            staging_identity=item.staging_identity, audit_intent_bytes=audit_bytes,
        )
        assert store.recoverable_catalog_publications() == (published,)
        failed = store.mark_catalog_integrity_failed(
            catalog_revision=revision, fixture_id=item.fixture_id,
            inventory_hash=inventory_hash, publication_bytes=publication_bytes,
            staging_identity=item.staging_identity,
        )
        assert failed.status == "INTEGRITY_FAILED"
        assert store.recoverable_catalog_publications() == ()
    finally:
        store.close()


@pytest.mark.parametrize("bad_bytes", [b"{}", b'{"schema":"CatalogManifest.v1"}', b'{"x":1} '])
def test_prepare_requires_exact_typed_manifest_bytes_hashing_to_revision(
    tmp_path: Path, bad_bytes: bytes
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    revision, inventory_hash, _, _ = publication_identity()
    try:
        with pytest.raises(ValueError):
            store.prepare_catalog_publication(
                catalog_revision=revision, fixture_id="local-qa-v1",
                inventory_hash=inventory_hash, publication_bytes=bad_bytes,
                staging_identity=f"prepared-{revision}",
            )
    finally:
        store.close()


def test_prepare_rejects_key_canonical_bytes_with_reversed_nested_declared_sets(
    tmp_path: Path,
) -> None:
    _, inventory_hash, publication_bytes, _ = publication_identity()
    parsed = json.loads(publication_bytes)
    parsed["inventory"]["catalog_files"].reverse()
    parsed["inventory"]["source_records"].reverse()
    attack_bytes = json.dumps(
        parsed, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()
    attack_revision = sha256(attack_bytes).hexdigest()
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(ValueError, match="exact canonical JSON bytes"):
            store.prepare_catalog_publication(
                catalog_revision=attack_revision, fixture_id="local-qa-v1",
                inventory_hash=inventory_hash, publication_bytes=attack_bytes,
                staging_identity=f"prepared-{attack_revision}",
            )
    finally:
        store.close()


def test_publish_requires_exact_typed_catalog_audit(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    revision, inventory_hash, publication_bytes, _ = publication_identity()
    try:
        prepared = prepare(store)
        with pytest.raises(ValueError, match="Catalog audit intent"):
            store.publish_catalog_publication(
                catalog_revision=revision, fixture_id=prepared.fixture_id,
                inventory_hash=inventory_hash, publication_bytes=publication_bytes,
                staging_identity=prepared.staging_identity, audit_intent_bytes=b"{}",
            )
        retained = store.catalog_publication(revision)
        assert retained is not None and retained.status == "PREPARED"
    finally:
        store.close()
