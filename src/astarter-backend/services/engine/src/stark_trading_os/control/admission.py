"""One shared capacity predicate for legacy and historical queue transitions."""

import sqlite3

from stark_trading_os.control.run_contract import parse_run_contract

ACTIVE_RUN_STATES = ("QUEUED", "RUNNING", "CANCEL_REQUESTED", "CANCEL_PENDING", "FINALIZING")


class HistoricalCapacityBusy(ValueError):
    """Admission is busy; no consume, event, or reservation change is committed."""

    def __init__(self) -> None:
        super().__init__("HISTORICAL_CAPACITY_BUSY")


def require_historical_capacity(connection: sqlite3.Connection, run_id: str) -> None:
    """Called inside the same BEGIN IMMEDIATE that commits the QUEUED transition.

    READY/DRAFT reserve identity, not capacity. CANCEL_PENDING and FINALIZING
    continue occupying capacity until the existing terminal authority resolves them.
    No process liveness or elapsed-time guess can release this predicate.
    """
    if not connection.in_transaction:
        raise RuntimeError("Historical admission requires the active writer transaction.")
    row = connection.execute("SELECT contract_kind FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if row is None:
        raise ValueError("Historical admission requires a registered run.")
    kind = parse_run_contract(row["contract_kind"])
    placeholders = ",".join("?" for _ in ACTIVE_RUN_STATES)
    occupied = connection.execute(
        f"SELECT 1 FROM runs WHERE state IN ({placeholders}) AND run_id != ? "
        "AND (? = 'HISTORICAL_SMA_V2' OR contract_kind = 'HISTORICAL_SMA_V2') LIMIT 1",
        (*ACTIVE_RUN_STATES, run_id, kind.value),
    ).fetchone()
    if occupied is not None:
        raise HistoricalCapacityBusy()
