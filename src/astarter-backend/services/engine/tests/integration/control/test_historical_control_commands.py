"""Durable historical admission can precede trusted asynchronous execution."""

import asyncio
import json

import pytest

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.historical_preflight import HistoricalPreflightInvalid
from stark_trading_os.control.run_contract import RunContractMismatch
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_control import case as _case
from tests.integration.control.test_historical_control import control_for

case = _case


def ready_command(case, tmp_path):
    store, configurations, version = case
    control = control_for(store, configurations, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    command = dict(
        preflight_id=ready.preflight_id, request_sha256=ready.request_sha256, idempotency_key="run"
    )
    return store, control, ready, command


def test_reserve_persists_original_queue_receipt_without_process_or_staging(case, tmp_path):
    store, control, ready, command = ready_command(case, tmp_path)
    reservation = control.reserve(**command)
    assert store.run(ready.run_id).state is RunState.QUEUED
    assert reservation.run_id == ready.run_id
    assert reservation.input_manifest_hash == ready.input_manifest_sha256
    assert store.runner_process(ready.run_id) is None
    assert not (tmp_path / "runtime/staging" / ready.run_id).exists()
    record = control._preflights.record_for_run(ready.run_id)
    assert record.consumed_at_ns is not None
    assert record.input_manifest_bytes == reservation.input_manifest_bytes
    row = store._connection.execute(
        "SELECT response_status,response_body FROM idempotency_records "
        "WHERE idempotency_scope='historical.create' AND idempotency_key='run'"
    ).fetchone()
    assert row["response_status"] == 202
    assert row["response_body"] == canonical_json_bytes(
        {
            "run_id": ready.run_id,
            "state": "QUEUED",
            "state_version": 2,
            "last_visible_seq": 2,
            "input_manifest_hash": ready.input_manifest_sha256,
        }
    )
    before = tuple(store._connection.iterdump())
    assert control.reserve(**command) == reservation
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize("kind", ["unconsumed", "legacy"])
def test_trusted_run_lookup_rejects_unconsumed_or_foreign_run_without_mutation(
    case, tmp_path, monkeypatch, kind
):
    store, control, ready, _ = ready_command(case, tmp_path)
    run_id = ready.run_id
    expected = HistoricalPreflightInvalid
    if kind == "legacy":
        run_id = "bt_" + "a" * 32
        store.reserve_run(run_id=run_id)
        expected = RunContractMismatch
    before = tuple(store._connection.iterdump())

    async def forbidden(*args, **kwargs):
        pytest.fail("invalid admission spawned a process")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    with pytest.raises(expected):
        control._preflights.record_for_run(run_id)
    with pytest.raises(expected):
        asyncio.run(control.run_reserved(run_id))
    assert tuple(store._connection.iterdump()) == before
    assert not (tmp_path / "runtime/staging" / run_id).exists()


def test_reserved_native_run_and_completed_retries_keep_one_execution(case, tmp_path, monkeypatch):
    store, control, ready, command = ready_command(case, tmp_path)
    reservation = control.reserve(**command)
    result = asyncio.run(control.run_reserved(reservation.run_id))
    assert result.state is RunState.COMPLETED
    assert result.publication.validation == "COMPLETE_PASSED"
    report = json.loads(
        control.read_artifact(run_id=ready.run_id, relative_path="reports/historical-report.json")
    )
    assert [row["commission"] for row in report["tables"]["fills"]] == ["0.11 USDT", "0.09 USDT"]
    assert report["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "979.8"

    async def forbidden(*args, **kwargs):
        pytest.fail("completed reservation replay spawned a second process")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    before = tuple(store._connection.iterdump())
    assert control.reserve(**command) == reservation
    assert asyncio.run(control.run_reserved(ready.run_id)) == result
    assert asyncio.run(control.execute(**command)) == result
    assert tuple(store._connection.iterdump()) == before
    assert len([e for e in store.events(ready.run_id) if e.type == "run.completed"]) == 1


def test_explicit_execution_can_prepare_but_recovery_cannot_create_missing_anchor(case, tmp_path):
    store, control, ready, command = ready_command(case, tmp_path)
    reservation = control.reserve(**command)
    asyncio.run(control._supervisor.run(reservation))
    before = tuple(store._connection.iterdump())
    pending = asyncio.run(control.recover_one(ready.run_id))
    assert pending.pending_reason == "EVIDENCE_NOT_ANCHORED"
    assert pending.state is RunState.FINALIZING and pending.publication is None
    assert tuple(store._connection.iterdump()) == before
    result = asyncio.run(control.run_reserved(ready.run_id))
    assert result.state is RunState.COMPLETED and result.publication is not None


def test_clean_cancel_preserves_persisted_decision_and_native_zero_spawn(
    case, tmp_path, monkeypatch
):
    store, control, ready, command = ready_command(case, tmp_path)
    control.reserve(**command)
    decision = CancellationCoordinator(control=store).request(
        run_id=ready.run_id, idempotency_key="cancel", reason="operator"
    )

    async def forbidden(*args, **kwargs):
        pytest.fail("clean cancellation spawned a process")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    assert control.finalize_clean_cancel(decision) is None
    result = asyncio.run(control.run_reserved(ready.run_id))
    assert result.state is RunState.CANCELLED
    assert result.publication.validation == "NO_REPORT"
    assert store.runner_process(ready.run_id) is None
    assert len([e for e in store.events(ready.run_id) if e.type == "run.cancelled"]) == 1
