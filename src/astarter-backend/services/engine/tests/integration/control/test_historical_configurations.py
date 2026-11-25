"""Real historical publication, configuration transactions, corruption and races."""

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256

import pytest

from stark_trading_os.audit.historical_input import configuration_bytes
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.historical_source import validate_historical_source
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationIntegrityError,
    StrategyConfigurationStorageError,
    StrategyDraftUnknown,
    StrategyRevisionConflict,
)
from stark_trading_os.domain.historical_input import SmaConfigurationInputV2
from tests.integration.catalog.test_historical_publication import (
    _csv_bytes,
    _metadata_bytes,
    _source,
)
from tests.integration.control.test_strategy_configuration_races import _configuration
from tests.unit.domain.test_historical_input import config_payload

NOW = 1_700_000_500_000_000_000
DRAFT = "sd_" + "1" * 32
VERSION = "cfg_" + "1" * 32


def config(revision, **changes):
    payload = config_payload()
    payload.update(catalog_revision=revision, **changes)
    return SmaConfigurationInputV2.model_validate(payload)


@pytest.fixture
def setup(tmp_path):
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    publisher = FixturePublisher(registry=None, control=store, runtime_root=tmp_path / "runtime")
    publication = publisher.publish_historical(_source())
    try:
        yield store, publisher, publication, config(publication.catalog_revision)
    finally:
        store.close()


def counts(store):
    return tuple(
        store._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in (
            "strategy_drafts",
            "strategy_configuration_versions",
            "strategy_configuration_audit_entries",
        )
    )


def create_publish(setup):
    store, _, _, configuration = setup
    draft = store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    version = store.publish_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=1, configuration_id=VERSION
    )
    return draft, version


def test_historical_lifecycle_preserves_versions_and_exact_codec_after_reopen(setup, tmp_path):
    store, _, publication, original = setup
    draft, first = create_publish(setup)
    assert draft.configuration == original and draft.revision == 1
    assert store.historical_strategy_drafts() == (draft,)
    assert first.version == first.source_revision == 1
    assert first.content_sha256 == sha256(configuration_bytes(original)).hexdigest()
    row = store._connection.execute("SELECT * FROM strategy_configuration_versions").fetchone()
    assert row["content_bytes"] == configuration_bytes(original)
    assert row["content_schema"] == "StrategyConfigurationInput.v2"
    updated = store.update_historical_strategy_draft(
        draft_id=DRAFT,
        expected_revision=1,
        configuration=config(publication.catalog_revision, name="Changed draft"),
    )
    assert updated.revision == 2 and updated.created_at_ns == str(NOW)
    assert store.historical_strategy_configuration(VERSION) == first
    retry = store.publish_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=1, configuration_id="cfg_" + "2" * 32
    )
    assert retry == first and counts(store) == (1, 1, 3)
    second = store.publish_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=2, configuration_id="cfg_" + "2" * 32
    )
    assert second.version == 2 and second.source_revision == 2
    assert second.configuration.name == "Changed draft"
    assert second.content_sha256 != first.content_sha256
    assert counts(store) == (1, 2, 4)
    reopened = ControlStore.open(tmp_path / "control.sqlite")
    try:
        assert reopened.historical_strategy_draft(DRAFT) == updated
        assert reopened.historical_strategy_configuration_versions(DRAFT) == (second, first)
        assert reopened.historical_strategy_configuration(VERSION) == first
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "mutation", ["nested", "id", "bool_revision", "stale", "clock", "overflow_clock"]
)
def test_invalid_inputs_cannot_write_or_partially_audit(setup, mutation):
    store, _, _, configuration = setup
    store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    before = counts(store)
    if mutation == "nested":
        configuration = configuration.model_copy(
            update={"parameters": configuration.parameters.model_copy(update={"fast_period": True})}
        )
    if mutation == "clock":
        store._clock = lambda: 42
    if mutation == "overflow_clock":
        store._clock = lambda: 2**64
    expected = (
        StrategyRevisionConflict if mutation == "stale" else StrategyConfigurationIntegrityError
    )
    with pytest.raises(expected):
        store.update_historical_strategy_draft(
            draft_id="bad-id" if mutation == "id" else DRAFT,
            expected_revision=True
            if mutation == "bool_revision"
            else 2
            if mutation == "stale"
            else 1,
            configuration=configuration,
        )
    assert counts(store) == before
    assert store.historical_strategy_draft(DRAFT).revision == 1


@pytest.mark.parametrize("action", ["create", "update", "publish"])
def test_audit_failure_rolls_back_entire_operation(setup, action):
    store, _, _, configuration = setup
    if action != "create":
        store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    before = counts(store)
    store._connection.execute("""CREATE TEMP TRIGGER fail_test_audit
        BEFORE INSERT ON strategy_configuration_audit_entries
        BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;""")
    with pytest.raises(StrategyConfigurationStorageError):
        if action == "create":
            store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
        elif action == "update":
            store.update_historical_strategy_draft(
                draft_id=DRAFT, expected_revision=1, configuration=configuration
            )
        else:
            store.publish_historical_strategy_draft(
                draft_id=DRAFT, expected_revision=1, configuration_id=VERSION
            )
    assert counts(store) == before
    assert not store._connection.in_transaction
    store._connection.execute("DROP TRIGGER fail_test_audit")
    if action != "create":
        assert store.historical_strategy_draft(DRAFT).revision == 1


@pytest.mark.parametrize("race", ["update", "publish"])
def test_independent_connection_races_have_one_winner_and_one_audit(setup, tmp_path, race):
    store, _, publication, configuration = setup
    store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    barrier = threading.Barrier(2)

    def worker(number):
        client = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW + 1)
        try:
            barrier.wait(timeout=10)
            if race == "publish":
                return client.publish_historical_strategy_draft(
                    draft_id=DRAFT, expected_revision=1, configuration_id=f"cfg_{number:032x}"
                ).configuration_id
            try:
                return client.update_historical_strategy_draft(
                    draft_id=DRAFT,
                    expected_revision=1,
                    configuration=config(publication.catalog_revision, name=f"Winner {number}"),
                ).configuration.name
            except StrategyRevisionConflict:
                return "conflict"
        finally:
            client.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(worker, (2, 3)))
    if race == "publish":
        assert results[0] == results[1] and results[0].startswith("cfg_")
        assert counts(store) == (1, 1, 2)
    else:
        assert results.count("conflict") == 1
        assert store.historical_strategy_draft(DRAFT).revision == 2
        assert counts(store) == (1, 0, 2)


@pytest.mark.parametrize("state", ["missing", "prepared", "failed", "corrupt", "v1"])
def test_publish_requires_real_published_historical_catalog_evidence(setup, state):
    store, publisher, publication, configuration = setup
    from stark_trading_os.control.historical_configurations import (
        HistoricalConfigurationCatalogError,
    )

    if state == "missing":
        configuration = config("f" * 64)
    elif state == "v1":
        from stark_trading_os.catalog.fixture_registry import FixtureRegistry
        from tests.integration.catalog.test_historical_publication import REPOSITORY_ROOT

        publisher._registry = FixtureRegistry(REPOSITORY_ROOT / "data/fixtures")
        old = publisher.publish("local-qa-v1")
        configuration = config(old.catalog_revision)
    elif state == "failed":
        store.mark_catalog_integrity_failed(
            **{
                name: getattr(publication, name)
                for name in (
                    "catalog_revision",
                    "fixture_id",
                    "inventory_hash",
                    "publication_bytes",
                    "staging_identity",
                )
            }
        )
    elif state == "prepared":
        # A separate, well-formed prepared row uses the same canonical publication identity.
        store._connection.execute(
            "DELETE FROM catalog_audit_intents WHERE catalog_revision=?",
            (publication.catalog_revision,),
        )
        store._connection.execute(
            "UPDATE catalog_publications SET status='PREPARED',published_at_ns=NULL "
            "WHERE catalog_revision=?",
            (publication.catalog_revision,),
        )
    else:
        store._connection.execute(
            "UPDATE catalog_publications SET publication_bytes=? WHERE catalog_revision=?",
            (b"{}", publication.catalog_revision),
        )
    store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    with pytest.raises(HistoricalConfigurationCatalogError):
        store.publish_historical_strategy_draft(
            draft_id=DRAFT, expected_revision=1, configuration_id=VERSION
        )
    assert counts(store) == (1, 0, 1)


@pytest.mark.parametrize("quantity", ["0.0001", "0.003", "0.006"])
def test_publish_enforces_native_precision_minimum_and_step(setup, quantity):
    store, publisher, _, _ = setup
    from stark_trading_os.control.historical_configurations import (
        HistoricalConfigurationCatalogError,
    )

    raw = _csv_bytes()
    metadata = json.loads(_metadata_bytes(raw))
    metadata["instrument"].update(size_increment="0.005", minimum_quantity="0.005")
    source = validate_historical_source(raw, json.dumps(metadata).encode(), now_ns=NOW)
    publication = publisher.publish_historical(source)
    configuration = config(
        publication.catalog_revision,
        parameters=dict(fast_period=2, slow_period=3, order_quantity=quantity),
    )
    store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    with pytest.raises(HistoricalConfigurationCatalogError):
        store.publish_historical_strategy_draft(
            draft_id=DRAFT, expected_revision=1, configuration_id=VERSION
        )
    assert counts(store) == (1, 0, 1)


def test_existing_version_survives_later_catalog_failure_and_draft_changes(setup):
    store, _, publication, configuration = setup
    _, version = create_publish(setup)
    store.mark_catalog_integrity_failed(
        **{
            name: getattr(publication, name)
            for name in (
                "catalog_revision",
                "fixture_id",
                "inventory_hash",
                "publication_bytes",
                "staging_identity",
            )
        }
    )
    assert store.historical_strategy_configuration(VERSION) == version
    assert (
        store.publish_historical_strategy_draft(
            draft_id=DRAFT, expected_revision=1, configuration_id="cfg_" + "9" * 32
        )
        == version
    )
    assert counts(store) == (1, 1, 2)


@pytest.mark.parametrize(
    "damage",
    ["bytes", "hash", "noncanonical", "kind", "revision", "time", "audit_missing", "audit_hash"],
)
def test_corrupted_draft_or_audit_never_reads_as_valid(setup, damage):
    store, _, _, configuration = setup
    store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    connection = store._connection
    if damage == "bytes":
        connection.execute(
            "UPDATE strategy_drafts SET content_bytes=? WHERE draft_id=?", (b"{}", DRAFT)
        )
    elif damage == "hash":
        connection.execute(
            "UPDATE strategy_drafts SET content_sha256=? WHERE draft_id=?", ("f" * 64, DRAFT)
        )
    elif damage == "noncanonical":
        raw = configuration_bytes(configuration) + b" "
        connection.execute(
            "UPDATE strategy_drafts SET content_bytes=?, content_sha256=? WHERE draft_id=?",
            (raw, sha256(raw).hexdigest(), DRAFT),
        )
    elif damage == "kind":
        raw = configuration_bytes(configuration).replace(
            b"StrategyConfigurationInput.v2", b"StrategyConfigurationInput.v1"
        )
        connection.execute(
            "UPDATE strategy_drafts SET content_bytes=?, content_sha256=? WHERE draft_id=?",
            (raw, sha256(raw).hexdigest(), DRAFT),
        )
    elif damage == "revision":
        connection.execute(
            "UPDATE strategy_drafts SET revision=9007199254740992 WHERE draft_id=?", (DRAFT,)
        )
    elif damage == "time":
        connection.execute(
            "UPDATE strategy_drafts SET updated_at_ns=updated_at_ns+1 WHERE draft_id=?", (DRAFT,)
        )
    elif damage == "audit_missing":
        connection.execute("DROP TRIGGER trg_strategy_configuration_audit_entries_reject_delete")
        connection.execute("DELETE FROM strategy_configuration_audit_entries")
    else:
        connection.execute("DROP TRIGGER trg_strategy_configuration_audit_entries_reject_update")
        connection.execute(
            "UPDATE strategy_configuration_audit_entries SET entry_sha256=?", ("f" * 64,)
        )
    with pytest.raises(StrategyConfigurationIntegrityError):
        store.historical_strategy_draft(DRAFT)


def test_old_and_new_typed_apis_do_not_cross_or_overwrite_ids(setup):
    store, _, _, configuration = setup
    old = store.create_strategy_draft(draft_id=DRAFT, configuration=_configuration(name="Old"))
    version = store.publish_strategy_draft(
        draft_id=DRAFT, expected_revision=1, configuration_id=VERSION
    )
    assert store.historical_strategy_draft(DRAFT) is None
    assert store.historical_strategy_configuration(VERSION) is None
    assert store.historical_strategy_drafts() == ()
    assert store.historical_strategy_configuration_versions(DRAFT) == ()
    with pytest.raises(StrategyDraftUnknown):
        store.update_historical_strategy_draft(
            draft_id=DRAFT, expected_revision=1, configuration=configuration
        )
    with pytest.raises(StrategyDraftUnknown):
        store.publish_historical_strategy_draft(
            draft_id=DRAFT, expected_revision=1, configuration_id="cfg_" + "9" * 32
        )
    with pytest.raises(StrategyConfigurationStorageError):
        store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    assert store.strategy_draft(DRAFT) == old and store.strategy_configuration(VERSION) == version


def test_published_v2_rows_are_sql_immutable(setup):
    store, _, _, _ = setup
    create_publish(setup)
    for sql in (
        "UPDATE strategy_configuration_versions SET content_bytes=content_bytes",
        "DELETE FROM strategy_configuration_versions",
    ):
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            store._connection.execute(sql)


@pytest.mark.parametrize("damage", ["bytes", "hash", "source_revision", "time", "audit"])
def test_published_version_read_revalidates_content_and_lineage(setup, damage):
    store, _, _, _ = setup
    create_publish(setup)
    connection = store._connection
    connection.execute("DROP TRIGGER trg_historical_strategy_versions_reject_update")
    if damage == "bytes":
        connection.execute("UPDATE strategy_configuration_versions SET content_bytes=?", (b"{}",))
    elif damage == "hash":
        connection.execute(
            "UPDATE strategy_configuration_versions SET content_sha256=?", ("f" * 64,)
        )
    elif damage == "source_revision":
        connection.execute("UPDATE strategy_configuration_versions SET source_revision=2")
    elif damage == "time":
        connection.execute(
            "UPDATE strategy_configuration_versions SET created_at_ns=created_at_ns+1"
        )
    else:
        connection.execute("DROP TRIGGER trg_strategy_configuration_audit_entries_reject_update")
        connection.execute(
            "UPDATE strategy_configuration_audit_entries SET entry_bytes=? "
            "WHERE action='strategy_configuration.published'",
            (b"{}",),
        )
    with pytest.raises(StrategyConfigurationIntegrityError):
        store.historical_strategy_configuration(VERSION)


@pytest.mark.parametrize("consumer", ["single", "list", "retry"])
@pytest.mark.parametrize("damage", ["first_ordinal", "swapped_ordinals"])
def test_version_ordinal_must_match_immutable_publication_order(setup, consumer, damage):
    store, _, publication, configuration = setup
    store.create_historical_strategy_draft(draft_id=DRAFT, configuration=configuration)
    store.update_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=1, configuration=configuration
    )
    first = store.publish_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=2, configuration_id=VERSION
    )
    assert first.version == 1 and first.source_revision == 2
    connection = store._connection
    if damage == "swapped_ordinals":
        store.update_historical_strategy_draft(
            draft_id=DRAFT,
            expected_revision=2,
            configuration=config(publication.catalog_revision, name="Second publication"),
        )
        store.publish_historical_strategy_draft(
            draft_id=DRAFT, expected_revision=3, configuration_id="cfg_" + "2" * 32
        )
    connection.execute("DROP TRIGGER trg_historical_strategy_versions_reject_update")
    if damage == "first_ordinal":
        connection.execute("UPDATE strategy_configuration_versions SET version=2")
    else:
        connection.execute("UPDATE strategy_configuration_versions SET version=99 WHERE version=1")
        connection.execute("UPDATE strategy_configuration_versions SET version=1 WHERE version=2")
        connection.execute("UPDATE strategy_configuration_versions SET version=2 WHERE version=99")
    before = counts(store)
    with pytest.raises(StrategyConfigurationIntegrityError):
        if consumer == "single":
            store.historical_strategy_configuration(VERSION)
        elif consumer == "list":
            store.historical_strategy_configuration_versions(DRAFT)
        else:
            store.publish_historical_strategy_draft(
                draft_id=DRAFT, expected_revision=2, configuration_id="cfg_" + "3" * 32
            )
    assert counts(store) == before
