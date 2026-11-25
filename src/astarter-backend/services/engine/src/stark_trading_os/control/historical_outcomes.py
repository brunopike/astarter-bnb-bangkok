"""V2 observer validation against the same Control run and process authority."""

from __future__ import annotations

import sqlite3
from contextlib import nullcontext
from hashlib import sha256

from stark_trading_os.control.historical_preflight import _record, _snapshot
from stark_trading_os.control.historical_process import (
    HistoricalRunnerOutcomeRecord,
    SupervisorExitV2,
    historical_exit_from_bytes,
    historical_identity,
)
from stark_trading_os.control.run_contract import RunContractKind, RunContractMismatch
from stark_trading_os.control.transactions import (
    EventRejected,
    RunSnapshot,
    _read_runner_process_row,
    _validate_outcome_process_binding,
    read_run,
)
from stark_trading_os.domain.models import RunState


def _require_historical_run(connection: sqlite3.Connection, run_id: str) -> RunSnapshot:
    run = read_run(connection, run_id)
    if run.contract_kind is not RunContractKind.HISTORICAL_SMA_V2:
        raise RunContractMismatch()
    return run


def _validate_historical_binding(
    connection: sqlite3.Connection, outcome: SupervisorExitV2
) -> RunSnapshot:
    run = _require_historical_run(connection, outcome.run_id)
    row = connection.execute(
        "SELECT preflight_id FROM historical_preflights WHERE run_id=?", (run.run_id,)
    ).fetchone()
    if row is None:
        raise EventRejected("HISTORICAL_OBSERVER_INVALID")
    record = _record(connection, row["preflight_id"])
    if record is None or record.consumed_at_ns is None:
        raise EventRejected("HISTORICAL_OBSERVER_INVALID")
    expected = historical_identity(
        run.run_id, record.input_manifest_bytes, record.receipt.input_manifest_sha256
    )
    if outcome.identity != expected:
        raise EventRejected("HISTORICAL_OBSERVER_INVALID")
    cursor = connection.execute(
        "SELECT runner_source_seq FROM runs WHERE run_id=?", (run.run_id,)
    ).fetchone()[0]
    if (
        cursor is not None
        or connection.execute(
            "SELECT 1 FROM events WHERE run_id=? AND source='runner' LIMIT 1", (run.run_id,)
        ).fetchone()
        is not None
    ):
        raise EventRejected("HISTORICAL_OBSERVER_INVALID")
    return run


def _validate_historical_transaction_truth(
    connection: sqlite3.Connection, outcome: SupervisorExitV2, process_row: sqlite3.Row | None
) -> None:
    run = _validate_historical_binding(connection, outcome)
    if process_row is None:
        if run.state is not RunState.CANCEL_REQUESTED:
            raise EventRejected("No-spawn cancellation requires current cancel truth.")
    elif process_row["cancel_phase"] in {"TERM_SENT", "KILL_SENT"} and outcome.classification in {
        "NATURAL_SUCCESS",
        "NATURAL_FAILURE",
    }:
        raise EventRejected("A signaled runner cannot persist a natural outcome.")


def _historical_outcome_from_row(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> HistoricalRunnerOutcomeRecord:
    try:
        raw = row["outcome_bytes"]
        outcome = historical_exit_from_bytes(raw)
        if outcome.run_id != row["run_id"] or sha256(raw).hexdigest() != row["outcome_hash"]:
            raise ValueError("HISTORICAL_OBSERVER_INVALID")
        _validate_historical_binding(connection, outcome)
        _validate_outcome_process_binding(
            outcome, _read_runner_process_row(connection, outcome.run_id)
        )
        return HistoricalRunnerOutcomeRecord(
            run_id=outcome.run_id,
            outcome=outcome,
            outcome_bytes=raw,
            outcome_hash=row["outcome_hash"],
            recorded_at_ns=row["recorded_at_ns"],
        )
    except Exception:
        raise ValueError("HISTORICAL_OBSERVER_INVALID") from None


def read_historical_runner_outcome(
    connection: sqlite3.Connection, run_id: str
) -> HistoricalRunnerOutcomeRecord | None:
    with nullcontext() if connection.in_transaction else _snapshot(connection):
        _require_historical_run(connection, run_id)
        row = connection.execute(
            "SELECT run_id,outcome_bytes,outcome_hash,recorded_at_ns "
            "FROM runner_outcomes WHERE run_id=?",
            (run_id,),
        ).fetchone()
        return None if row is None else _historical_outcome_from_row(connection, row)
