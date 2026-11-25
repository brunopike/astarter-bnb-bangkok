"""Published historical intent obtains one immutable receipt and one run."""

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from hashlib import sha256

import pytest

from stark_trading_os.control.historical_configuration_service import (
    HistoricalConfigurationService,
    HistoricalInputCandidateError,
)
from stark_trading_os.control.registry import ControlStore, IdempotencyConflict
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_configuration_service import setup as _native_setup
from tests.integration.control.test_historical_configurations import DRAFT, NOW, VERSION, config

setup = _native_setup


def services(store, root, clock):
    from stark_trading_os.control.historical_preflight import HistoricalPreflightService

    configurations = HistoricalConfigurationService(
        store=store,
        runtime_root=root,
        draft_id_factory=lambda: DRAFT,
        configuration_id_factory=lambda: VERSION,
    )
    preflights = HistoricalPreflightService(
        store=store,
        configurations=configurations,
        clock=clock,
        ttl_ns=60_000_000_000,
    )
    return configurations, preflights


def prepared(setup, tmp_path, clock=lambda: NOW):
    store, _, publication = setup
    configurations, preflights = services(store, tmp_path / "runtime", clock)
    configurations.create_draft(config(publication.catalog_revision))
    configurations.publish_draft(draft_id=DRAFT, expected_revision=1)
    return store, configurations, preflights


def counts(store):
    return tuple(
        store._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in (
            "runs",
            "historical_preflights",
            "events",
            "audit_intents",
            "idempotency_records",
        )
    )


def test_ready_binds_published_version_and_exact_original_input(setup, tmp_path):
    store, configurations, service = prepared(setup, tmp_path)
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    record = service.record(receipt.preflight_id)
    assert record is not None and record.receipt == receipt and record.consumed_at_ns is None
    run = store.run(receipt.run_id)
    assert run.contract_kind == "HISTORICAL_SMA_V2"
    assert run.state is RunState.PREFLIGHT_READY and run.state_version == 1
    assert run.input_manifest_hash == receipt.input_manifest_sha256
    assert sha256(run.input_manifest_bytes).hexdigest() == receipt.input_manifest_sha256
    assert (
        run.input_manifest_bytes
        == configurations.build_input_candidate(VERSION).input_manifest_bytes
    )
    manifest = json.loads(run.input_manifest_bytes)
    assert manifest["configuration_id"] == VERSION and manifest["configuration_version"] == 1
    assert counts(store) == (1, 1, 1, 1, 1)
    assert store._connection.execute("SELECT COUNT(*) FROM preflights").fetchone()[0] == 0
    assert store._connection.execute("SELECT COUNT(*) FROM runner_processes").fetchone()[0] == 0


def test_same_ready_key_replays_original_receipt_after_expiry_without_refresh(
    setup, tmp_path, monkeypatch
):
    now = [NOW]
    store, configurations, service = prepared(setup, tmp_path, clock=lambda: now[0])
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    now[0] += 61_000_000_000
    monkeypatch.setattr(
        configurations, "build_input_candidate", lambda *_: pytest.fail("replay rebuilt input")
    )
    assert service.preflight(configuration_id=VERSION, idempotency_key="ready") == receipt
    assert counts(store) == (1, 1, 1, 1, 1)
    with pytest.raises(ValueError, match="HISTORICAL_PREFLIGHT_STALE"):
        service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "consume")
    assert counts(store) == (1, 1, 1, 1, 1)


def test_same_key_different_configuration_conflicts_before_new_lookup(setup, tmp_path):
    store, _, service = prepared(setup, tmp_path)
    service.preflight(configuration_id=VERSION, idempotency_key="ready")
    with pytest.raises(IdempotencyConflict):
        service.preflight(configuration_id="cfg_" + "f" * 32, idempotency_key="ready")
    assert counts(store) == (1, 1, 1, 1, 1)


def test_failure_during_ready_rolls_back_run_event_audit_and_idempotency(setup, tmp_path):
    store, _, service = prepared(setup, tmp_path)
    before = counts(store)
    store._connection.execute(
        "CREATE TRIGGER fail_historical_ready BEFORE INSERT ON historical_preflights "
        "BEGIN SELECT RAISE(ABORT,'injected failure'); END"
    )
    with pytest.raises((sqlite3.Error, RuntimeError)):
        service.preflight(configuration_id=VERSION, idempotency_key="ready")
    assert counts(store) == before
    assert not store._connection.in_transaction


def test_changed_catalog_between_observation_and_commit_cannot_get_ready(
    setup, tmp_path, monkeypatch
):
    store, configurations, service = prepared(setup, tmp_path)
    original = configurations.build_input_candidate

    def invalidate_after_observation(configuration_id):
        candidate = original(configuration_id)
        store._connection.execute("UPDATE catalog_publications SET status='INTEGRITY_FAILED'")
        return candidate

    monkeypatch.setattr(configurations, "build_input_candidate", invalidate_after_observation)
    with pytest.raises(ValueError, match="HISTORICAL_PREFLIGHT_STALE"):
        service.preflight(configuration_id=VERSION, idempotency_key="ready")
    assert counts(store) == (0, 0, 0, 0, 0)


def test_internal_consume_queues_same_run_once_and_public_capability_stays_closed(setup, tmp_path):
    store, _, service = prepared(setup, tmp_path)
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    with pytest.raises(RuntimeError, match="HISTORICAL_CONSUMER_UNAVAILABLE"):
        service.consume_ready(receipt.preflight_id, receipt.request_sha256, "consume")
    reservation = service._consume_ready_for_control(
        receipt.preflight_id, receipt.request_sha256, "consume"
    )
    assert reservation.run_id == receipt.run_id and reservation.state is RunState.QUEUED
    assert reservation.input_manifest_hash == receipt.input_manifest_sha256
    assert (
        service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "consume")
        == reservation
    )
    assert counts(store) == (1, 1, 2, 2, 2)
    assert service.record(receipt.preflight_id).consumed_at_ns == NOW


def test_busy_internal_consume_leaves_ready_and_receipt_unconsumed(setup, tmp_path):
    store, _, service = prepared(setup, tmp_path)
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    store._connection.execute(
        "INSERT INTO runs(run_id,state,created_at_ns) VALUES('bt_other','RUNNING',10)"
    )
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError, match="HISTORICAL_CAPACITY_BUSY"):
        service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "consume")
    assert tuple(store._connection.iterdump()) == before


def test_receipt_survives_store_restart_and_newer_configuration_version(setup, tmp_path):
    store, configurations, service = prepared(setup, tmp_path)
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    original = configurations.configuration(VERSION).configuration
    store.update_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=1, configuration=original
    )
    store.publish_historical_strategy_draft(
        draft_id=DRAFT, expected_revision=2, configuration_id="cfg_" + "2" * 32
    )
    reopened = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    try:
        _, after = services(reopened, tmp_path / "runtime", lambda: NOW)
        assert after.preflight(configuration_id=VERSION, idempotency_key="ready") == receipt
        reservation = after._consume_ready_for_control(
            receipt.preflight_id, receipt.request_sha256, "consume"
        )
        assert reservation.run_id == receipt.run_id
    finally:
        reopened.close()


@pytest.mark.parametrize("operation", ["ready", "same_consume", "different_consume"])
def test_concurrent_requests_keep_one_run_per_receipt_and_one_active_run(
    setup, tmp_path, operation
):
    store, _, service = prepared(setup, tmp_path)
    receipts = (
        []
        if operation == "ready"
        else [
            service.preflight(configuration_id=VERSION, idempotency_key=f"ready-{i}")
            for i in range(2 if operation == "different_consume" else 1)
        ]
    )
    barrier = threading.Barrier(2)

    def worker(i):
        connection = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
        try:
            configurations, preflights = services(connection, tmp_path / "runtime", lambda: NOW)
            original = configurations.build_input_candidate

            def simultaneous_candidate(configuration_id):
                result = original(configuration_id)
                barrier.wait(timeout=20)
                return result

            configurations.build_input_candidate = simultaneous_candidate
            if operation == "ready":
                return preflights.preflight(configuration_id=VERSION, idempotency_key="ready")
            receipt = receipts[i if operation == "different_consume" else 0]
            try:
                return preflights._consume_ready_for_control(
                    receipt.preflight_id,
                    receipt.request_sha256,
                    f"consume-{i}" if operation == "different_consume" else "consume",
                )
            except ValueError as error:
                assert str(error) == "HISTORICAL_CAPACITY_BUSY"
                return None
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, (0, 1)))
    if operation == "ready":
        assert results[0] == results[1] and counts(store) == (1, 1, 1, 1, 1)
    elif operation == "same_consume":
        assert results[0] == results[1] and counts(store) == (1, 1, 2, 2, 2)
    else:
        assert sum(result is not None for result in results) == 1
        assert counts(store) == (2, 2, 3, 3, 3)
        records = [service.record(receipt.preflight_id) for receipt in receipts]
        assert sum(record.consumed_at_ns is not None for record in records) == 1


def test_consumed_replay_keeps_original_response_after_expiry_and_catalog_failure(
    setup, tmp_path, monkeypatch
):
    now = [NOW]
    store, configurations, service = prepared(setup, tmp_path, clock=lambda: now[0])
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    reservation = service._consume_ready_for_control(
        receipt.preflight_id, receipt.request_sha256, "consume"
    )
    now[0] += 61_000_000_000
    store._connection.execute("UPDATE catalog_publications SET status='INTEGRITY_FAILED'")
    before = tuple(store._connection.iterdump())
    monkeypatch.setattr(
        configurations, "build_input_candidate", lambda *_: pytest.fail("replay rebuilt input")
    )
    assert service.preflight(configuration_id=VERSION, idempotency_key="ready") == receipt
    assert (
        service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "consume")
        == reservation
    )
    with pytest.raises(ValueError, match="HISTORICAL_PREFLIGHT_STALE"):
        service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "new-key")
    with pytest.raises(IdempotencyConflict):
        service._consume_ready_for_control(receipt.preflight_id, "f" * 64, "consume")
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE runs SET created_at_ns=0",
        "UPDATE idempotency_records SET created_at_ns=0",
        "UPDATE audit_intents SET created_at_ns=0",
        "DELETE FROM outbox",
        "UPDATE historical_preflights SET risk_sha256='" + "f" * 64 + "'",
        "UPDATE historical_preflights SET runtime_sha256='" + "f" * 64 + "'",
        "UPDATE events SET source_seq=99",
    ],
)
def test_replay_rejects_corrupted_linkage_without_mutation(setup, tmp_path, mutation):
    store, _, service = prepared(setup, tmp_path)
    service.preflight(configuration_id=VERSION, idempotency_key="ready")
    store._connection.execute("DROP TRIGGER trg_historical_idempotency_reject_update")
    store._connection.execute("DROP TRIGGER trg_historical_preflights_immutable")
    store._connection.execute("DROP TRIGGER trg_events_immutable_update")
    store._connection.execute(mutation)
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError, match="^HISTORICAL_PREFLIGHT_INVALID$"):
        service.preflight(configuration_id=VERSION, idempotency_key="ready")
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize("phase", ["preflight", "consume"])
def test_expiry_during_native_observation_cannot_commit(setup, tmp_path, monkeypatch, phase):
    now = [NOW]
    store, configurations, service = prepared(setup, tmp_path, clock=lambda: now[0])
    receipt = (
        None
        if phase == "preflight"
        else service.preflight(configuration_id=VERSION, idempotency_key="ready")
    )
    original = configurations.build_input_candidate

    def delayed(configuration_id):
        result = original(configuration_id)
        now[0] += 61_000_000_000
        return result

    monkeypatch.setattr(configurations, "build_input_candidate", delayed)
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError, match="HISTORICAL_PREFLIGHT_STALE"):
        if phase == "preflight":
            service.preflight(configuration_id=VERSION, idempotency_key="ready")
        else:
            service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "go")
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize("file_kind", ["source", "native"])
def test_actual_input_drift_after_ready_never_queues(setup, tmp_path, file_kind):
    store, _, service = prepared(setup, tmp_path)
    receipt = service.preflight(configuration_id=VERSION, idempotency_key="ready")
    catalog = tmp_path / "runtime/catalogs" / store.run(receipt.run_id).catalog_revision
    path = (
        catalog / "source/bars.csv" if file_kind == "source" else next(catalog.rglob("*.parquet"))
    )
    path.chmod(0o600)
    path.write_bytes(path.read_bytes() + b"private-marker")
    path.chmod(0o400)
    with pytest.raises(HistoricalInputCandidateError) as error:
        service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "go")
    assert "private-marker" not in str(error.value)
    assert counts(store) == (1, 1, 1, 1, 1)
    assert service.record(receipt.preflight_id).consumed_at_ns is None


@pytest.mark.parametrize("writer_version", [None, 4])
@pytest.mark.parametrize("operation", ["update", "delete"])
def test_untrusted_and_old_connections_cannot_change_historical_receipts(
    setup, tmp_path, writer_version, operation
):
    store, _, service = prepared(setup, tmp_path)
    service.preflight(configuration_id=VERSION, idempotency_key="ready")
    before = tuple(store._connection.iterdump())
    old = sqlite3.connect(tmp_path / "control.sqlite", isolation_level=None)
    if writer_version is not None:
        old.create_function("stark_control_writer_schema_version", 0, lambda: writer_version)
    try:
        with pytest.raises(sqlite3.Error):
            old.execute(
                "DELETE FROM historical_preflights"
                if operation == "delete"
                else f"UPDATE historical_preflights SET consumed_at_ns={NOW}"
            )
    finally:
        old.close()
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize("phase", ["preflight", "consume"])
def test_late_receipt_write_failure_rolls_back_every_state_and_audit_change(setup, tmp_path, phase):
    store, _, service = prepared(setup, tmp_path)
    receipt = (
        None
        if phase == "preflight"
        else service.preflight(configuration_id=VERSION, idempotency_key="ready")
    )
    store._connection.execute(
        "CREATE TRIGGER fail_late_receipt BEFORE INSERT ON idempotency_records "
        "BEGIN SELECT RAISE(ABORT,'late failure'); END"
    )
    before = tuple(store._connection.iterdump())
    with pytest.raises(sqlite3.IntegrityError, match="late failure"):
        if phase == "preflight":
            service.preflight(configuration_id=VERSION, idempotency_key="ready")
        else:
            service._consume_ready_for_control(receipt.preflight_id, receipt.request_sha256, "go")
    assert tuple(store._connection.iterdump()) == before


def test_foreign_candidate_cannot_bind_requested_configuration(setup, tmp_path, monkeypatch):
    store, configurations, service = prepared(setup, tmp_path)
    candidate = configurations.build_input_candidate(VERSION)
    foreign = replace(candidate, configuration_id="cfg_" + "f" * 32)
    monkeypatch.setattr(configurations, "build_input_candidate", lambda *_: foreign)
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError, match="HISTORICAL_PREFLIGHT_STALE"):
        service.preflight(configuration_id=VERSION, idempotency_key="ready")
    assert tuple(store._connection.iterdump()) == before
