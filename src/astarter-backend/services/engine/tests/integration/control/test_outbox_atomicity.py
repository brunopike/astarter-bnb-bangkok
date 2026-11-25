from __future__ import annotations

import sqlite3
from hashlib import sha256
from pathlib import Path

import pytest

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.preflight_contract import (
    PREFLIGHT_CHECK_EXPLANATIONS,
    PREFLIGHT_EVIDENCE_NAMES,
    PREFLIGHT_PASSING_CHECK_CODES,
)
from stark_trading_os.control.registry import (
    ControlStore,
    ControlStoreError,
    ControlTransaction,
    EventCandidate,
    IdempotencyCommand,
    IdempotentResponse,
)
from stark_trading_os.domain.models import RunState


class StepClock:
    def __init__(self, start: int = 1_000) -> None:
        self.value = start

    def __call__(self) -> int:
        current = self.value
        self.value += 1
        return current


def _event_id(run_id: str, seq: int) -> str:
    return f"evt_{run_id}_{seq:06d}"


def _control(event_type: str) -> EventCandidate:
    return EventCandidate.control(type=event_type, ts_event_ns="10", payload={})


def _blocked_request_bytes(*, replay_seed: int = 0) -> bytes:
    return canonical_json_bytes(
        {
            "environment": "BACKTEST",
            "strategy_ref": "task-four-probe@v1",
            "catalog_revision": "0" * 64,
            "window": {"start_ns": "0", "end_ns": "1"},
            "information_set_policy": {
                "schema": "InformationSetPolicy.v1",
                "availability_field": "ts_available_ns",
                "nautilus_timestamp_field": "ts_init",
                "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
                "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
                "bar_rule": "CLOSED_AND_AVAILABLE",
                "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
            },
            "evaluation_protocol": {
                "schema": "EvaluationProtocol.v1",
                "mode": "fixture_only",
                "train": None,
                "tune": None,
                "out_of_sample": None,
                "purge_ns": "0",
                "embargo_ns": "0",
            },
            "venue_account_model": None,
            "cost_fill_model": {"schema": "CostFillModel.v1"},
            "risk_policy_ref": None,
            "replay_seed": replay_seed,
        }
    )


PREFLIGHT_CHECKED_AT_NS = 1_700_000_000_000_000_000
PREFLIGHT_EXPIRES_AT_NS = PREFLIGHT_CHECKED_AT_NS + 10_000
_PREFLIGHT_FACTS = {
    "account_model_sha256": "NONE",
    "account_model_status": "MISSING",
    "authority": "SERVER_CONFIGURED_RUN_ROOT",
    "catalog_revision": "0" * 64,
    "cost_fill_sha256": "8df6374bdd6cc543a1f94d4cc9d161b64aeed016fa46601153e9daf408c93570",
    "currency_authority_sha256": "NONE",
    "currency_match": "FALSE",
    "definition_sha256": "1" * 64,
    "directory_status": "AVAILABLE_DIRECTORY",
    "lookup_status": "NOT_FOUND",
    "registry_status": "MISSING",
    "risk_policy_ref": "NONE",
    "section_status": "MISSING",
    "strategy_ref": "task-four-probe@v1",
    "support_status": "SUPPORTED",
    "venue_match": "FALSE",
}


def _blocked_check(code: str, **overrides: str) -> dict[str, object]:
    values = _PREFLIGHT_FACTS | overrides
    return {
        "checked_at_ns": PREFLIGHT_CHECKED_AT_NS,
        "code": code,
        "evidence": [
            {"name": name, "value": values[name]} for name in PREFLIGHT_EVIDENCE_NAMES[code]
        ],
        "explanation": PREFLIGHT_CHECK_EXPLANATIONS[code],
        "passed": code in PREFLIGHT_PASSING_CHECK_CODES,
    }


def _blocked_result_bytes(
    *,
    command: IdempotencyCommand,
    run_id: str,
    preflight_id: str,
) -> bytes:
    checks = [
        _blocked_check(
            "ENGINE_VERSION_VALID",
            expected_version="2.0.0rc3",
            observed_version="2.0.0rc3",
        ),
        _blocked_check("ENGINE_TAG_VALID", expected_commit="2" * 40, observed_commit="2" * 40),
        _blocked_check(
            "PYTHON_VERSION_VALID",
            expected_version="3.12.4",
            observed_version="3.12.4",
        ),
        _blocked_check(
            "PRECISION_MODE_VALID",
            expected_mode="FIXED_PRECISION_16",
            observed_mode="FIXED_PRECISION_16",
            high_precision="ENABLED",
        ),
        _blocked_check("STRATEGY_VALID"),
        _blocked_check("CATALOG_UNKNOWN"),
        _blocked_check("COST_FEE_MISSING", required_section="fee"),
        _blocked_check("COST_SPREAD_MISSING", required_section="spread"),
        _blocked_check("COST_SLIPPAGE_MISSING", required_section="slippage"),
        _blocked_check("COST_LATENCY_MISSING", required_section="latency"),
        _blocked_check("FILL_LIQUIDITY_MISSING", required_section="liquidity"),
        _blocked_check("FILL_CANCEL_MISSING", required_section="cancel"),
        _blocked_check("RISK_POLICY_MISSING"),
        _blocked_check("BALANCE_MODEL_MISSING"),
        _blocked_check("CURRENCY_MISMATCH"),
        _blocked_check("RUN_ROOT_VALID"),
    ]
    wrapped = canonical_json_bytes(
        {
            "value": {
                "canonical_request_hash": sha256(command.canonical_request_bytes).hexdigest(),
                "catalog_revision": None,
                "checks": checks,
                "expires_at_ns": PREFLIGHT_EXPIRES_AT_NS,
                "input_manifest_hash": None,
                "preflight_id": preflight_id,
                "run_id": run_id,
                "state": "PREFLIGHT_BLOCKED",
                "state_version": 1,
            }
        }
    )
    prefix = b'{"value":'
    assert wrapped.startswith(prefix) and wrapped.endswith(b"}")
    return wrapped[len(prefix) : -1]


def _persist_blocked(
    transaction: ControlTransaction,
    *,
    command: IdempotencyCommand,
    run_id: str,
    preflight_id: str,
    result_bytes: bytes,
) -> None:
    transaction.reserve_run(run_id=run_id)
    transaction.persist_preflight(
        preflight_id=preflight_id,
        run_id=run_id,
        status="PREFLIGHT_BLOCKED",
        request_bytes=command.canonical_request_bytes,
        request_hash=sha256(command.canonical_request_bytes).hexdigest(),
        result_bytes=result_bytes,
        input_manifest_bytes=None,
        input_manifest_hash=None,
        catalog_revision=None,
        catalog_inventory_hash=None,
        engine_package_version=None,
        engine_tag_commit=None,
        risk_policy_hash=None,
        expires_at_ns=PREFLIGHT_EXPIRES_AT_NS,
        ready_evidence=None,
    )
    transaction.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.PREFLIGHT_BLOCKED,
        candidate=EventCandidate.control(
            type="preflight.blocked",
            ts_event_ns=str(PREFLIGHT_CHECKED_AT_NS),
            payload={
                "canonical_request_hash": sha256(command.canonical_request_bytes).hexdigest(),
                "preflight_id": preflight_id,
            },
        ),
    )


def _ready_store(path: Path, run_id: str) -> tuple[sqlite3.Connection, ControlStore]:
    connection = open_control_database(path)
    store = ControlStore(connection, clock=StepClock(), event_id_factory=_event_id)
    store.reserve_run(run_id=run_id)
    store.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=_control("preflight.passed"),
    )
    return connection, store


@pytest.mark.parametrize("table", ["audit_intents", "outbox"])
def test_injected_audit_or_outbox_abort_rolls_back_without_consuming_sequences(
    tmp_path: Path, table: str
) -> None:
    connection, store = _ready_store(tmp_path / f"{table}.sqlite", f"bt_{table}")
    run_id = f"bt_{table}"
    connection.execute(
        f"""
        CREATE TEMP TRIGGER abort_{table} BEFORE INSERT ON main.{table}
        BEGIN SELECT RAISE(ABORT, '{table} fault'); END
        """
    )
    before = store.run(run_id)
    before_events = store.events(run_id)
    before_audits = store.audit_intents(run_id)
    before_outbox = store.pending_outbox(run_id)

    with pytest.raises(sqlite3.IntegrityError, match=f"{table} fault"):
        store.commit_transition(
            run_id=run_id,
            expected_version=1,
            target=RunState.QUEUED,
            candidate=_control("run.queued"),
        )

    assert store.run(run_id) == before
    assert store.events(run_id) == before_events
    assert store.audit_intents(run_id) == before_audits
    assert store.pending_outbox(run_id) == before_outbox

    connection.execute(f"DROP TRIGGER abort_{table}")
    committed = store.commit_transition(
        run_id=run_id,
        expected_version=1,
        target=RunState.QUEUED,
        candidate=_control("run.queued"),
    )
    assert committed.event.seq == before.last_event_seq + 1
    assert committed.event.source_seq == before.last_event_seq + 1
    assert committed.audit_seq == before.last_audit_seq + 1
    store.close()


def test_idempotency_record_rolls_back_with_failed_outbox_write(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "idempotency-rollback.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=_event_id)
    connection.execute(
        """
        CREATE TEMP TRIGGER abort_outbox BEFORE INSERT ON main.outbox
        BEGIN SELECT RAISE(ABORT, 'outbox fault'); END
        """
    )

    command = IdempotencyCommand.preflight(
        key="rollback-key", canonical_request_bytes=_blocked_request_bytes()
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_idem_rollback",
        preflight_id="pf_idem_rollback",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked(
            transaction,
            command=command,
            run_id="bt_idem_rollback",
            preflight_id="pf_idem_rollback",
            result_bytes=response_bytes,
        )
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_idem_rollback",
        )

    with pytest.raises(sqlite3.IntegrityError, match="outbox fault"):
        store.execute_idempotent(
            command=command,
            handler=handler,
        )

    assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM audit_intents").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM idempotency_records").fetchone()[0] == 0
    connection.execute("DROP TRIGGER abort_outbox")
    committed = store.execute_idempotent(
        command=command,
        handler=handler,
    )
    assert committed.body == response_bytes
    assert store.events("bt_idem_rollback")[0].seq == 1
    assert store.audit_intents("bt_idem_rollback")[0].audit_seq == 1
    store.close()


@pytest.mark.parametrize("table", ["audit_intents", "outbox"])
def test_caught_capability_failure_poisons_and_rolls_back_the_command(
    tmp_path: Path,
    table: str,
) -> None:
    connection = open_control_database(tmp_path / f"caught-{table}.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=_event_id)
    connection.execute(
        f"""
        CREATE TEMP TRIGGER abort_{table} BEFORE INSERT ON main.{table}
        BEGIN SELECT RAISE(ABORT, '{table} fault'); END
        """
    )

    command = IdempotencyCommand.preflight(
        key=f"caught-{table}",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id=f"bt_caught_{table}",
        preflight_id=f"pf_caught_{table}",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id=f"bt_caught_{table}")
        transaction.persist_preflight(
            preflight_id=f"pf_caught_{table}",
            run_id=f"bt_caught_{table}",
            status="PREFLIGHT_BLOCKED",
            request_bytes=command.canonical_request_bytes,
            request_hash=sha256(command.canonical_request_bytes).hexdigest(),
            result_bytes=response_bytes,
            input_manifest_bytes=None,
            input_manifest_hash=None,
            catalog_revision=None,
            catalog_inventory_hash=None,
            engine_package_version=None,
            engine_tag_commit=None,
            risk_policy_hash=None,
            expires_at_ns=PREFLIGHT_EXPIRES_AT_NS,
            ready_evidence=None,
        )
        try:
            transaction.commit_transition(
                run_id=f"bt_caught_{table}",
                expected_version=0,
                target=RunState.PREFLIGHT_BLOCKED,
                candidate=EventCandidate.control(
                    type="preflight.blocked",
                    ts_event_ns=str(PREFLIGHT_CHECKED_AT_NS),
                    payload={},
                ),
            )
        except sqlite3.IntegrityError:
            pass
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id=f"bt_caught_{table}",
        )

    try:
        with pytest.raises(ControlStoreError, match="poisoned"):
            store.execute_idempotent(
                command=command,
                handler=handler,
            )

        for persisted_table in (
            "runs",
            "events",
            "audit_intents",
            "outbox",
            "idempotency_records",
        ):
            assert connection.execute(f"SELECT COUNT(*) FROM {persisted_table}").fetchone()[0] == 0
    finally:
        store.close()


def test_handler_cannot_clear_command_poison_through_facade_state(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "poison-state.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=_event_id)
    connection.execute(
        """
        CREATE TEMP TRIGGER abort_outbox BEFORE INSERT ON main.outbox
        BEGIN SELECT RAISE(ABORT, 'outbox fault'); END
        """
    )

    command = IdempotencyCommand.preflight(
        key="poison-state",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_poison_state",
        preflight_id="pf_poison_state",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_poison_state")
        transaction.persist_preflight(
            preflight_id="pf_poison_state",
            run_id="bt_poison_state",
            status="PREFLIGHT_BLOCKED",
            request_bytes=command.canonical_request_bytes,
            request_hash=sha256(command.canonical_request_bytes).hexdigest(),
            result_bytes=response_bytes,
            input_manifest_bytes=None,
            input_manifest_hash=None,
            catalog_revision=None,
            catalog_inventory_hash=None,
            engine_package_version=None,
            engine_tag_commit=None,
            risk_policy_hash=None,
            expires_at_ns=PREFLIGHT_EXPIRES_AT_NS,
            ready_evidence=None,
        )
        try:
            transaction.commit_transition(
                run_id="bt_poison_state",
                expected_version=0,
                target=RunState.PREFLIGHT_BLOCKED,
                candidate=EventCandidate.control(
                    type="preflight.blocked",
                    ts_event_ns=str(PREFLIGHT_CHECKED_AT_NS),
                    payload={},
                ),
            )
        except sqlite3.IntegrityError:
            if hasattr(transaction, "_poisoned"):
                setattr(transaction, "_poisoned", False)
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_poison_state",
        )

    try:
        with pytest.raises(ControlStoreError, match="poisoned"):
            store.execute_idempotent(
                command=command,
                handler=handler,
            )
        for table in ("runs", "events", "audit_intents", "outbox", "idempotency_records"):
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        store.close()


def test_restart_preserves_exact_response_state_events_and_pending_outbox(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "restart.sqlite"
    connection = open_control_database(database_path)
    first = ControlStore(connection, clock=StepClock(), event_id_factory=_event_id)
    command = IdempotencyCommand.preflight(
        key="restart-key", canonical_request_bytes=_blocked_request_bytes()
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_restart",
        preflight_id="pf_restart",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked(
            transaction,
            command=command,
            run_id="bt_restart",
            preflight_id="pf_restart",
            result_bytes=response_bytes,
        )
        return IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_restart")

    expected_response = first.execute_idempotent(command=command, handler=handler)
    expected_run = first.run("bt_restart")
    expected_events = first.events("bt_restart")
    expected_outbox = first.pending_outbox("bt_restart")
    first.close()

    reopened = ControlStore(
        open_control_database(database_path),
        clock=StepClock(9_000),
        event_id_factory=_event_id,
    )
    try:
        replayed = reopened.execute_idempotent(
            command=command,
            handler=lambda transaction: pytest.fail("replay must not invoke the handler"),
        )
        assert replayed == expected_response
        assert replayed.body == response_bytes
        assert reopened.run("bt_restart") == expected_run
        assert reopened.events("bt_restart") == expected_events
        assert reopened.pending_outbox("bt_restart") == expected_outbox
    finally:
        reopened.close()
