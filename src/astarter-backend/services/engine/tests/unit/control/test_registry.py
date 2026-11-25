from __future__ import annotations

import inspect
import json
import sqlite3
from collections.abc import Callable, Iterator, MutableMapping
from hashlib import sha256
from pathlib import Path
from typing import cast

import pytest

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control import registry as registry_module
from stark_trading_os.control import transactions as transactions_module
from stark_trading_os.control.database import (
    DatabaseConfigurationError,
    open_control_database,
)
from stark_trading_os.control.preflight_contract import (
    PREFLIGHT_CHECK_EXPLANATIONS,
    PREFLIGHT_EVIDENCE_NAMES,
    PREFLIGHT_PASSING_CHECK_CODES,
)
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    SupervisorExitV1,
    process_identity_digest,
)
from stark_trading_os.control.registry import (
    ControlStore,
    ControlStoreError,
    ControlTransaction,
    EventCandidate,
    EventRejected,
    IdempotencyCommand,
    IdempotencyConflict,
    IdempotentResponse,
    RunNotFound,
    VersionConflict,
)
from stark_trading_os.control.transactions import LIFECYCLE_TARGETS
from stark_trading_os.domain.models import EventEnvelopeV1, RunState


class StepClock:
    def __init__(self, start: int = 1_000) -> None:
        self._next = start
        self.calls = 0

    def __call__(self) -> int:
        value = self._next
        self._next += 1
        self.calls += 1
        return value


class RecordingIds:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def __call__(self, run_id: str, seq: int) -> str:
        self.calls.append((run_id, seq))
        return f"evt_{run_id}_{seq:06d}"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[ControlStore]:
    connection = open_control_database(tmp_path / "control.sqlite")
    control_store = ControlStore(
        connection,
        clock=StepClock(),
        event_id_factory=RecordingIds(),
    )
    try:
        yield control_store
    finally:
        control_store.close()


def _control(event_type: str, ts: int = 10) -> EventCandidate:
    return EventCandidate.control(
        type=event_type,
        ts_event_ns=str(ts),
        payload={"reason": "test"},
    )


def _runner(event_type: str, source_seq: int, ts: int = 10) -> EventCandidate:
    return EventCandidate.runner(
        type=event_type,
        source_seq=source_seq,
        ts_event_ns=str(ts),
        payload={"order_id": "order-1"},
    )


def _persist_owned_terminal_preparation(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    include_hidden_event: bool = False,
) -> None:
    connection.execute(
        "INSERT INTO runs (run_id, state, state_version, created_at_ns) "
        "VALUES (?, 'FINALIZING', 4, 0)",
        (run_id,),
    )
    connection.execute(
        "INSERT INTO runner_outcomes (run_id, outcome_bytes, outcome_hash, recorded_at_ns) "
        "VALUES (?, ?, ?, 0)",
        (run_id, b"{}", "a" * 64),
    )
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """
        INSERT INTO terminal_preparations (
            run_id, runner_outcome_hash, terminal_state, terminal_state_version,
            event_id, event_seq, event_source_seq, event_source, event_type,
            event_writer, event_schema_version, event_ts_event_ns,
            event_ts_ingest_ns, event_visible, event_envelope_bytes, event_digest,
            initial_event_digest, audit_seq, audit_event_digest, audit_intent_bytes,
            audit_intent_digest, audit_created_at_ns, prepared_at_ns, disposition,
            failure_attempt_count, last_failure_at_ns, last_failure_stage,
            conversion_fault_hash, converted_at_ns
        ) VALUES (
            ?, ?, 'COMPLETED', 5, ?, 1, 1, 'control-api', 'run.completed',
            'control-api', 1, '10', '10', 0, ?, ?, ?, 1, ?, ?, ?, 10, 10,
            'NORMAL', 0, NULL, NULL, NULL, NULL
        )
        """,
        (
            run_id,
            "a" * 64,
            f"evt_{run_id}_000001",
            b'{"candidate":true}',
            "b" * 64,
            "b" * 64,
            "b" * 64,
            b'{"audit":true}',
            "c" * 64,
        ),
    )
    connection.execute(
        """
        UPDATE runs
        SET prepared_terminal_state = 'COMPLETED',
            prepared_terminal_state_version = 5,
            prepared_terminal_event_seq = 1,
            evidence_status = 'STAGING'
        WHERE run_id = ?
        """,
        (run_id,),
    )
    if include_hidden_event:
        connection.execute(
            """
            UPDATE runs
            SET last_event_seq = 1, last_audit_seq = 1, control_source_seq = 1
            WHERE run_id = ?
            """,
            (run_id,),
        )
        connection.execute(
            """
            INSERT INTO events (
                event_id, run_id, seq, source_seq, source, type, writer,
                schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
            ) VALUES (?, ?, 1, 1, 'control-api', 'run.completed', 'control-api',
                      1, '10', '10', 0, ?)
            """,
            (f"evt_{run_id}_000001", run_id, b'{"candidate":true}'),
        )
    connection.commit()


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
    expires_at_ns: int = PREFLIGHT_EXPIRES_AT_NS,
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
                "expires_at_ns": expires_at_ns,
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


def _persist_blocked_preflight(
    transaction: ControlTransaction,
    *,
    command: IdempotencyCommand,
    run_id: str,
    preflight_id: str,
    response_bytes: bytes,
    expires_at_ns: int = PREFLIGHT_EXPIRES_AT_NS,
) -> None:
    transaction.reserve_run(run_id=run_id)
    transaction.persist_preflight(
        preflight_id=preflight_id,
        run_id=run_id,
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
        expires_at_ns=expires_at_ns,
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


def _to_ready(store: ControlStore, run_id: str) -> None:
    store.reserve_run(run_id=run_id)
    store.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=_control("preflight.passed"),
    )


def _to_queued(store: ControlStore, run_id: str) -> None:
    _to_ready(store, run_id)
    store.commit_transition(
        run_id=run_id,
        expected_version=1,
        target=RunState.QUEUED,
        candidate=_control("run.queued"),
    )


def _to_running(store: ControlStore, run_id: str) -> None:
    _to_queued(store, run_id)
    store.commit_transition(
        run_id=run_id,
        expected_version=2,
        target=RunState.RUNNING,
        candidate=_control("run.started"),
    )


def test_run_evidence_snapshot_is_one_typed_registry_read(store: ControlStore) -> None:
    """Catches GET-run assembling lifecycle and evidence with autocommit reads."""

    run_id = "bt_evidence_snapshot"
    _to_queued(store, run_id)

    read = getattr(store, "run_evidence_snapshot", None)
    assert callable(read), "ControlStore must expose one coherent run evidence read"
    snapshot = read(run_id)
    expected_events = store.events(run_id)

    assert snapshot.run.run_id == run_id
    assert snapshot.last_visible_seq == snapshot.run.last_event_seq == 2
    assert snapshot.events == expected_events
    assert snapshot.catalog_publication is None
    assert snapshot.runner_outcome is None
    assert snapshot.terminal_preparation is None
    assert snapshot.terminal_finalization is None


def test_run_evidence_snapshot_stays_coherent_during_interleaving_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "control.sqlite"
    reader = ControlStore.open(database, clock=StepClock())
    writer = ControlStore.open(database, clock=StepClock(start=2_000))
    run_id = "bt_evidence_interleaving"
    _to_queued(reader, run_id)
    expected_events = reader.events(run_id)
    original = transactions_module.read_runner_outcome
    interleaved = False

    def commit_between_read_boundaries(
        connection: sqlite3.Connection,
        selected_run_id: str,
    ) -> object:
        nonlocal interleaved
        if not interleaved:
            interleaved = True
            writer.commit_transition(
                run_id=run_id,
                expected_version=2,
                target=RunState.CANCEL_REQUESTED,
                candidate=_control("run.cancel_requested", ts=20),
            )
        return original(connection, selected_run_id)

    monkeypatch.setattr(
        transactions_module,
        "read_runner_outcome",
        commit_between_read_boundaries,
    )
    try:
        snapshot = reader.run_evidence_snapshot(run_id)

        assert interleaved is True
        assert snapshot.run.state is RunState.QUEUED
        assert snapshot.run.state_version == 2
        assert snapshot.last_visible_seq == 2
        assert snapshot.events == expected_events
        assert writer.run(run_id).state is RunState.CANCEL_REQUESTED
        assert writer.run(run_id).last_event_seq == 3
        assert writer.events(run_id) == (*expected_events, writer.events(run_id)[-1])
    finally:
        writer.close()
        reader.close()


def _claimed_cancel_pending(
    store: ControlStore,
    run_id: str,
) -> tuple[ProcessIdentityV1, int]:
    _to_queued(store, run_id)
    claim = store.claim_runner_process(run_id=run_id, spawn_nonce=f"spawn-{run_id}")
    identity = ProcessIdentityV1(
        run_id=run_id,
        spawn_nonce=claim.spawn_nonce,
        pid=501,
        ppid=1,
        pgid=501,
        sid=501,
        platform="darwin",
        start_token="darwin:1700000000:123456",
        configured_executable_path="/service/venv/bin/python",
        observed_executable_path="/service/venv/bin/python",
        executable_device=7,
        executable_inode=11,
    )
    attached = store.attach_runner_process(identity=identity)
    assert attached.launched_at_ns is not None
    decision = store.request_runner_cancel(
        command=IdempotencyCommand.cancel(
            run_id=run_id,
            key=f"cancel-{run_id}",
            canonical_request_bytes=canonical_json_bytes({"reason": "recovery"}),
        ),
        reason="recovery",
    )
    assert decision.signal_required
    pending = store.commit_transition(
        run_id=run_id,
        expected_version=decision.state_version,
        target=RunState.CANCEL_PENDING,
        candidate=_control("run.cancel_pending"),
    )
    assert pending.state is RunState.CANCEL_PENDING
    return identity, attached.launched_at_ns


def test_transition_allocates_event_audit_and_outbox_in_one_commit(store: ControlStore) -> None:
    store.reserve_run(run_id="bt_atomic")

    result = store.commit_transition(
        run_id="bt_atomic",
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=_control("preflight.passed"),
    )

    assert (result.run_id, result.state, result.state_version) == (
        "bt_atomic",
        RunState.PREFLIGHT_READY,
        1,
    )
    assert (result.event.seq, result.event.source_seq, result.audit_seq) == (1, 1, 1)
    assert [event.seq for event in store.events("bt_atomic")] == [1]
    assert [intent.audit_seq for intent in store.audit_intents("bt_atomic")] == [1]
    assert [(row.seq, row.audit_seq) for row in store.pending_outbox("bt_atomic")] == [(1, 1)]

    envelope = EventEnvelopeV1.model_validate_json(result.event.envelope_bytes)
    assert envelope.model_dump(mode="json") == {
        "event_id": "evt_bt_atomic_000001",
        "run_id": "bt_atomic",
        "seq": 1,
        "source_seq": 1,
        "ts_event_ns": "10",
        "ts_ingest_ns": "1001",
        "type": "preflight.passed",
        "source": "control-api",
        "writer": "control-api",
        "schema_version": 1,
        "payload": {"reason": "test"},
    }


def test_append_event_does_not_change_state_or_state_version(store: ControlStore) -> None:
    _to_running(store, "bt_append")
    before = store.run("bt_append")

    result = store.append_event(
        run_id="bt_append",
        expected_version=before.state_version,
        candidate=_runner("order.submitted", source_seq=0),
    )

    after = store.run("bt_append")
    assert (after.state, after.state_version) == (RunState.RUNNING, before.state_version)
    assert result.state_version == before.state_version
    assert result.event.seq == before.last_event_seq + 1


def test_runner_source_sequence_accepts_first_zero_and_later_gaps(store: ControlStore) -> None:
    _to_running(store, "bt_runner_seq")

    first = store.append_event(
        run_id="bt_runner_seq",
        expected_version=3,
        candidate=_runner("order.submitted", source_seq=0),
    )
    second = store.append_event(
        run_id="bt_runner_seq",
        expected_version=3,
        candidate=_runner("order.accepted", source_seq=7),
    )

    assert (first.event.source_seq, second.event.source_seq) == (0, 7)
    for source_seq in (7, 6):
        with pytest.raises(EventRejected, match="strictly greater"):
            store.append_event(
                run_id="bt_runner_seq",
                expected_version=3,
                candidate=_runner("order.filled", source_seq=source_seq),
            )
    runner_sequences = [
        event.source_seq for event in store.events("bt_runner_seq") if event.source == "runner"
    ]
    assert runner_sequences == [0, 7]


def test_control_source_sequence_is_store_allocated_and_contiguous(store: ControlStore) -> None:
    _to_running(store, "bt_control_seq")
    store.commit_transition(
        run_id="bt_control_seq",
        expected_version=3,
        target=RunState.FINALIZING,
        candidate=_control("run.finalizing"),
    )
    store.append_event(
        run_id="bt_control_seq",
        expected_version=4,
        candidate=_control("report.generated"),
    )

    control_sequences = [
        event.source_seq
        for event in store.events("bt_control_seq")
        if event.source == "control-api"
    ]
    assert control_sequences == [1, 2, 3, 4, 5]
    with pytest.raises(TypeError):
        EventCandidate.control(
            type="report.generated",
            source_seq=99,
            ts_event_ns="10",
            payload={},
        )  # type: ignore[call-arg]


@pytest.mark.parametrize(
    ("prefix", "target", "event_type"),
    [
        ((), RunState.PREFLIGHT_BLOCKED, "preflight.blocked"),
        ((), RunState.PREFLIGHT_READY, "preflight.passed"),
        ((RunState.PREFLIGHT_READY,), RunState.QUEUED, "run.queued"),
        ((RunState.PREFLIGHT_READY, RunState.QUEUED), RunState.RUNNING, "run.started"),
        (
            (RunState.PREFLIGHT_READY, RunState.QUEUED),
            RunState.CANCEL_REQUESTED,
            "run.cancel_requested",
        ),
        (
            (RunState.PREFLIGHT_READY, RunState.QUEUED, RunState.CANCEL_REQUESTED),
            RunState.CANCEL_PENDING,
            "run.cancel_pending",
        ),
        ((RunState.PREFLIGHT_READY, RunState.QUEUED), RunState.FINALIZING, "run.finalizing"),
    ],
)
def test_each_lifecycle_event_maps_to_its_only_nonterminal_target(
    store: ControlStore,
    prefix: tuple[RunState, ...],
    target: RunState,
    event_type: str,
) -> None:
    run_id = f"bt_mapping_{target.value.lower()}"
    store.reserve_run(run_id=run_id)
    version = 0
    event_for_target = {
        RunState.PREFLIGHT_READY: "preflight.passed",
        RunState.QUEUED: "run.queued",
        RunState.RUNNING: "run.started",
        RunState.CANCEL_REQUESTED: "run.cancel_requested",
    }
    for state in prefix:
        version += 1
        store.commit_transition(
            run_id=run_id,
            expected_version=version - 1,
            target=state,
            candidate=_control(event_for_target[state]),
        )

    result = store.commit_transition(
        run_id=run_id,
        expected_version=version,
        target=target,
        candidate=_control(event_type),
    )
    assert result.state is target


def test_lifecycle_event_target_authority_is_runtime_immutable() -> None:
    mutable = cast(MutableMapping[str, RunState], LIFECYCLE_TARGETS)
    with pytest.raises(TypeError):
        mutable["run.started"] = RunState.COMPLETED

    assert LIFECYCLE_TARGETS["run.started"] is RunState.RUNNING


def test_event_target_mismatch_and_stale_version_leave_no_rows(store: ControlStore) -> None:
    store.reserve_run(run_id="bt_rejected")

    with pytest.raises(EventRejected, match="target"):
        store.commit_transition(
            run_id="bt_rejected",
            expected_version=0,
            target=RunState.PREFLIGHT_READY,
            candidate=_control("preflight.blocked"),
        )
    with pytest.raises(VersionConflict):
        store.commit_transition(
            run_id="bt_rejected",
            expected_version=9,
            target=RunState.PREFLIGHT_READY,
            candidate=_control("preflight.passed"),
        )

    assert store.run("bt_rejected").state_version == 0
    assert store.events("bt_rejected") == ()
    assert store.pending_outbox("bt_rejected") == ()


@pytest.mark.parametrize("terminal", [RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED])
def test_generic_transition_rejects_terminal_targets_before_writing(
    store: ControlStore, terminal: RunState
) -> None:
    store.reserve_run(run_id=f"bt_{terminal.value.lower()}")
    with pytest.raises(EventRejected, match="terminal"):
        store.commit_transition(
            run_id=f"bt_{terminal.value.lower()}",
            expected_version=0,
            target=terminal,
            candidate=_control(f"run.{terminal.value.lower()}"),
        )
    assert store.events(f"bt_{terminal.value.lower()}") == ()


def test_append_rejects_a_persisted_terminal_run(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "terminal.sqlite")
    connection.execute(
        "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, ?, ?)",
        ("bt_terminal", "COMPLETED", 0),
    )
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())
    try:
        with pytest.raises(EventRejected, match="Terminal run state"):
            store.append_event(
                run_id="bt_terminal",
                expected_version=0,
                candidate=_runner("run.progress", source_seq=0),
            )
        assert store.events("bt_terminal") == ()
    finally:
        store.close()


def test_generic_transition_rejects_a_prepared_terminal_boundary(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "prepared-transition.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())
    _persist_owned_terminal_preparation(
        connection,
        run_id="bt_prepared_transition",
    )
    try:
        with pytest.raises(EventRejected, match="terminal boundary"):
            store.commit_transition(
                run_id="bt_prepared_transition",
                expected_version=4,
                target=RunState.PREFLIGHT_READY,
                candidate=_control("preflight.passed"),
            )
        assert store.run("bt_prepared_transition").state is RunState.FINALIZING
        assert store.events("bt_prepared_transition") == ()
    finally:
        store.close()


def test_generic_append_rejects_an_existing_hidden_terminal_event(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "hidden-terminal-freeze.sqlite")
    _persist_owned_terminal_preparation(
        connection,
        run_id="bt_hidden_freeze",
        include_hidden_event=True,
    )
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())
    try:
        with pytest.raises(EventRejected, match="terminal boundary"):
            store.append_event(
                run_id="bt_hidden_freeze",
                expected_version=4,
                candidate=_control("report.generated"),
            )
        assert store.events("bt_hidden_freeze") == ()
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ?",
                ("bt_hidden_freeze",),
            ).fetchone()[0]
            == 1
        )
    finally:
        store.close()


@pytest.mark.parametrize("event_type", ["run.completed", "run.failed", "run.cancelled"])
def test_runner_cannot_forge_terminal_or_controller_events(
    store: ControlStore, event_type: str
) -> None:
    _to_running(store, f"bt_forge_{event_type}")
    with pytest.raises(EventRejected):
        store.append_event(
            run_id=f"bt_forge_{event_type}",
            expected_version=3,
            candidate=_runner(event_type, source_seq=0),
        )


@pytest.mark.parametrize(
    "candidate",
    [
        _control("order.filled"),
        _runner("run.started", source_seq=0),
        _control("catalog.validated"),
    ],
)
def test_wrong_source_type_ownership_and_fake_catalog_run_event_are_rejected(
    store: ControlStore, candidate: EventCandidate
) -> None:
    _to_running(store, f"bt_owner_{candidate.type}")
    with pytest.raises(EventRejected):
        store.append_event(
            run_id=f"bt_owner_{candidate.type}",
            expected_version=3,
            candidate=candidate,
        )


def test_runner_events_and_report_events_have_closed_state_eligibility(
    store: ControlStore,
) -> None:
    _to_ready(store, "bt_wrong_runner_state")
    with pytest.raises(EventRejected, match="state"):
        store.append_event(
            run_id="bt_wrong_runner_state",
            expected_version=1,
            candidate=_runner("run.progress", source_seq=0),
        )

    _to_running(store, "bt_wrong_report_state")
    with pytest.raises(EventRejected, match="FINALIZING"):
        store.append_event(
            run_id="bt_wrong_report_state",
            expected_version=3,
            candidate=_control("report.generated"),
        )


def test_public_operations_do_not_accept_a_visibility_switch(store: ControlStore) -> None:
    store.reserve_run(run_id="bt_visible")
    with pytest.raises(TypeError):
        store.commit_transition(
            run_id="bt_visible",
            expected_version=0,
            target=RunState.PREFLIGHT_READY,
            candidate=_control("preflight.passed"),
            visible=False,
        )  # type: ignore[call-arg]


def test_reservation_stores_exact_canonical_manifest_bytes(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "manifest.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())
    manifest = canonical_json_bytes({"fixture": "qa", "seed": 7})
    manifest_hash = sha256(manifest).hexdigest()
    try:
        with pytest.raises(ValueError, match="published"):
            store.reserve_run(
                run_id="bt_unknown_catalog",
                input_manifest_bytes=manifest,
                input_manifest_hash=manifest_hash,
                catalog_revision="catalog-a",
                catalog_inventory_hash="a" * 64,
            )

        connection.execute(
            """
            INSERT INTO catalog_publications (
                catalog_revision,
                fixture_id,
                status,
                inventory_hash,
                publication_bytes,
                staging_identity,
                prepared_at_ns,
                published_at_ns
            ) VALUES (?, ?, 'PREPARED', ?, ?, ?, ?, NULL)
            """,
            ("catalog-a", "qa", "a" * 64, b"{}", "staging-a", 1),
        )
        with pytest.raises(ValueError, match="published"):
            store.reserve_run(
                run_id="bt_prepared_catalog",
                input_manifest_bytes=manifest,
                input_manifest_hash=manifest_hash,
                catalog_revision="catalog-a",
                catalog_inventory_hash="a" * 64,
            )
        connection.execute(
            """
            UPDATE catalog_publications
            SET status = 'PUBLISHED', published_at_ns = ?
            WHERE catalog_revision = ?
            """,
            (2, "catalog-a"),
        )
        store.reserve_run(
            run_id="bt_manifest",
            input_manifest_bytes=manifest,
            input_manifest_hash=manifest_hash,
            catalog_revision="catalog-a",
            catalog_inventory_hash="a" * 64,
        )

        snapshot = store.run("bt_manifest")
        assert snapshot.input_manifest_bytes == manifest
        assert snapshot.input_manifest_hash == manifest_hash
        with pytest.raises(ValueError, match="exact canonical"):
            store.reserve_run(
                run_id="bt_noncanonical",
                input_manifest_bytes=b'{"seed": 7}',
                input_manifest_hash=sha256(b'{"seed": 7}').hexdigest(),
                catalog_revision="catalog-a",
                catalog_inventory_hash="a" * 64,
            )
    finally:
        store.close()


def test_same_idempotency_hash_replays_exact_bytes_without_reinvoking_handler_or_generators(
    tmp_path: Path,
) -> None:
    clock = StepClock()
    ids = RecordingIds()
    connection = open_control_database(tmp_path / "control.sqlite")
    store = ControlStore(connection, clock=clock, event_id_factory=ids)
    handler_calls = 0
    command = IdempotencyCommand.preflight(
        key="idem-1",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_idem",
        preflight_id="pf_idem",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        nonlocal handler_calls
        handler_calls += 1
        _persist_blocked_preflight(
            transaction,
            command=command,
            run_id="bt_idem",
            preflight_id="pf_idem",
            response_bytes=response_bytes,
        )
        return IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_idem")

    try:
        first = store.execute_idempotent(command=command, handler=handler)
        clock_calls = clock.calls
        id_calls = list(ids.calls)
        second = store.execute_idempotent(command=command, handler=handler)

        assert (
            first
            == second
            == IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_idem")
        )
        assert handler_calls == 1
        assert clock.calls == clock_calls
        assert ids.calls == id_calls
        assert store.run("bt_idem").state is RunState.PREFLIGHT_BLOCKED
        assert len(store.events("bt_idem")) == 1
        record = connection.execute(
            "SELECT request_body, response_body FROM idempotency_records"
        ).fetchone()
        assert record["request_body"] == command.logical_request_bytes
        assert record["response_body"] == response_bytes
    finally:
        store.close()


def test_different_idempotency_hash_conflicts_without_side_effects(store: ControlStore) -> None:
    calls = 0
    first_command = IdempotencyCommand.preflight(
        key="create-1", canonical_request_bytes=_blocked_request_bytes()
    )
    first_body = _blocked_result_bytes(
        command=first_command,
        run_id="bt_winner",
        preflight_id="pf_winner",
    )

    def first_handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked_preflight(
            transaction,
            command=first_command,
            run_id="bt_winner",
            preflight_id="pf_winner",
            response_bytes=first_body,
        )
        return IdempotentResponse(status_code=200, body=first_body, run_id="bt_winner")

    store.execute_idempotent(
        command=first_command,
        handler=first_handler,
    )

    def losing_handler(transaction: ControlTransaction) -> IdempotentResponse:
        nonlocal calls
        calls += 1
        return IdempotentResponse(status_code=200, body=b'{"winner":false}', run_id="bt_loser")

    with pytest.raises(IdempotencyConflict, match="IDEMPOTENCY_CONFLICT"):
        store.execute_idempotent(
            command=IdempotencyCommand.preflight(
                key="create-1", canonical_request_bytes=_blocked_request_bytes(replay_seed=1)
            ),
            handler=losing_handler,
        )

    assert calls == 0
    with pytest.raises(RunNotFound):
        store.run("bt_loser")


def test_idempotency_facade_does_not_directly_carry_a_raw_connection(
    store: ControlStore,
) -> None:
    observed: list[tuple[bool, bool, set[str]]] = []

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        public_surface = {name for name in dir(transaction) if not name.startswith("_")}
        observed.append(
            (
                hasattr(transaction, "connection"),
                hasattr(transaction, "_connection"),
                public_surface,
            )
        )
        return IdempotentResponse(status_code=400, body=b"{}")

    store.execute_idempotent(
        command=IdempotencyCommand.cancel(
            run_id="bt_surface", key="surface", canonical_request_bytes=b"{}"
        ),
        handler=handler,
    )

    assert observed == [
        (
            False,
            False,
            {
                "append_event",
                "commit_transition",
                "consume_preflight",
                "persist_preflight",
                "reserve_run",
            },
        )
    ]


def test_idempotency_facade_is_invalid_after_the_handler_returns(
    store: ControlStore,
) -> None:
    leaked: list[ControlTransaction] = []

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        leaked.append(transaction)
        return IdempotentResponse(status_code=400, body=b"{}")

    store.execute_idempotent(
        command=IdempotencyCommand.cancel(
            run_id="bt_leak", key="leak", canonical_request_bytes=b"{}"
        ),
        handler=handler,
    )

    with pytest.raises(ControlStoreError, match="inactive"):
        leaked[0].reserve_run(run_id="bt_escaped")
    with pytest.raises(RunNotFound):
        store.run("bt_escaped")


def test_private_facade_capability_cannot_bypass_cancel_target_binding(
    store: ControlStore,
) -> None:
    _to_queued(store, "bt_private_cancel_a")
    _to_queued(store, "bt_private_cancel_b")

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        private_capability = getattr(transaction, "_transition", None)
        if private_capability is None:
            raise ControlStoreError("No private mutation capability is exposed.")
        transition_capability = cast(Callable[..., object], private_capability)
        transition_capability(
            run_id="bt_private_cancel_b",
            expected_version=2,
            target=RunState.CANCEL_REQUESTED,
            candidate=_control("run.cancel_requested"),
        )
        return IdempotentResponse(
            status_code=202,
            body=b'{"run_id":"bt_private_cancel_a"}',
            run_id="bt_private_cancel_a",
        )

    with pytest.raises(ControlStoreError):
        store.execute_idempotent(
            command=IdempotencyCommand.cancel(
                run_id="bt_private_cancel_a",
                key="private-cancel",
                canonical_request_bytes=b"{}",
            ),
            handler=handler,
        )

    assert store.run("bt_private_cancel_a").state is RunState.QUEUED
    assert store.run("bt_private_cancel_b").state is RunState.QUEUED


def test_leaked_private_facade_capability_is_inactive_after_handler(
    store: ControlStore,
) -> None:
    _to_queued(store, "bt_private_leak")
    leaked: list[object | None] = []

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        leaked.append(getattr(transaction, "_transition", None))
        return IdempotentResponse(status_code=400, body=b"{}")

    store.execute_idempotent(
        command=IdempotencyCommand.cancel(
            run_id="bt_private_leak",
            key="private-leak",
            canonical_request_bytes=b"{}",
        ),
        handler=handler,
    )

    if leaked[0] is not None:
        leaked_capability = cast(Callable[..., object], leaked[0])
        with pytest.raises(ControlStoreError, match="inactive"):
            leaked_capability(
                run_id="bt_private_leak",
                expected_version=2,
                target=RunState.CANCEL_REQUESTED,
                candidate=_control("run.cancel_requested"),
            )
    assert store.run("bt_private_leak").state is RunState.QUEUED


def test_idempotency_facade_rejects_use_after_outer_transaction_is_ended(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "ended-transaction.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        connection.commit()
        try:
            transaction.reserve_run(run_id="bt_after_commit")
        except ControlStoreError:
            pass
        return IdempotentResponse(status_code=200, body=b"{}")

    try:
        with pytest.raises(ControlStoreError, match="poisoned"):
            store.execute_idempotent(
                command=IdempotencyCommand.preflight(
                    key="ended-transaction",
                    canonical_request_bytes=b"{}",
                ),
                handler=handler,
            )
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM idempotency_records").fetchone()[0] == 0
    finally:
        store.close()


def test_cancel_capability_cannot_mutate_another_run(store: ControlStore) -> None:
    _to_queued(store, "bt_cancel_a")
    _to_queued(store, "bt_cancel_b")

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        try:
            transaction.commit_transition(
                run_id="bt_cancel_b",
                expected_version=2,
                target=RunState.CANCEL_REQUESTED,
                candidate=_control("run.cancel_requested"),
            )
        except ControlStoreError:
            pass
        return IdempotentResponse(
            status_code=202,
            body=b'{"run_id":"bt_cancel_a"}',
            run_id="bt_cancel_a",
        )

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(
            command=IdempotencyCommand.cancel(
                run_id="bt_cancel_a",
                key="cancel-a",
                canonical_request_bytes=b'{"reason":"operator"}',
            ),
            handler=handler,
        )

    assert store.run("bt_cancel_a").state is RunState.QUEUED
    assert store.run("bt_cancel_b").state is RunState.QUEUED


def test_command_capability_binds_the_first_mutated_run(store: ControlStore) -> None:
    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_bound_a")
        try:
            transaction.reserve_run(run_id="bt_bound_b")
        except ControlStoreError:
            pass
        return IdempotentResponse(
            status_code=200,
            body=b'{"run_id":"bt_bound_a"}',
            run_id="bt_bound_a",
        )

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(
            command=IdempotencyCommand.preflight(
                key="bound-run",
                canonical_request_bytes=b"{}",
            ),
            handler=handler,
        )

    for run_id in ("bt_bound_a", "bt_bound_b"):
        with pytest.raises(RunNotFound):
            store.run(run_id)


def test_non_cancel_response_must_match_the_command_bound_run(store: ControlStore) -> None:
    store.reserve_run(run_id="bt_existing_response")

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_bound_response")
        return IdempotentResponse(
            status_code=200,
            body=b'{"run_id":"bt_existing_response"}',
            run_id="bt_existing_response",
        )

    with pytest.raises(ControlStoreError, match="bound run"):
        store.execute_idempotent(
            command=IdempotencyCommand.preflight(
                key="bound-response",
                canonical_request_bytes=b"{}",
            ),
            handler=handler,
        )

    with pytest.raises(RunNotFound):
        store.run("bt_bound_response")


def test_successful_cancel_response_must_name_the_command_target(store: ControlStore) -> None:
    _to_queued(store, "bt_response_a")
    _to_queued(store, "bt_response_b")

    with pytest.raises(ControlStoreError, match="cancel target"):
        store.execute_idempotent(
            command=IdempotencyCommand.cancel(
                run_id="bt_response_a",
                key="cancel-response",
                canonical_request_bytes=b'{"reason":"operator"}',
            ),
            handler=lambda transaction: IdempotentResponse(
                status_code=202,
                body=b'{"run_id":"bt_response_b"}',
                run_id="bt_response_b",
            ),
        )


def test_response_body_run_id_must_match_cancel_metadata_and_target(
    store: ControlStore,
) -> None:
    _to_queued(store, "bt_body_cancel_a")
    _to_queued(store, "bt_body_cancel_b")

    with pytest.raises(ControlStoreError, match="response body run_id"):
        store.execute_idempotent(
            command=IdempotencyCommand.cancel(
                run_id="bt_body_cancel_a",
                key="cancel-body-target",
                canonical_request_bytes=b"{}",
            ),
            handler=lambda transaction: IdempotentResponse(
                status_code=202,
                body=b'{"run_id":"bt_body_cancel_b"}',
                run_id="bt_body_cancel_a",
            ),
        )


def test_successful_bound_response_requires_matching_metadata_and_body(
    store: ControlStore,
) -> None:
    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_body_create")
        return IdempotentResponse(
            status_code=200,
            body=b'{"run_id":"bt_body_other"}',
            run_id="bt_body_create",
        )

    with pytest.raises(ControlStoreError, match="response body run_id"):
        store.execute_idempotent(
            command=IdempotencyCommand.preflight(
                key="create-body-target",
                canonical_request_bytes=b"{}",
            ),
            handler=handler,
        )
    with pytest.raises(RunNotFound):
        store.run("bt_body_create")

    def missing_metadata(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_missing_metadata")
        return IdempotentResponse(status_code=200, body=b"{}")

    with pytest.raises(ControlStoreError, match="Successful response"):
        store.execute_idempotent(
            command=IdempotencyCommand.preflight(
                key="create-missing-metadata",
                canonical_request_bytes=b"{}",
            ),
            handler=missing_metadata,
        )
    with pytest.raises(RunNotFound):
        store.run("bt_missing_metadata")


def test_idempotency_rejects_subclass_and_duck_typed_commands(store: ControlStore) -> None:
    class SubclassCommand(IdempotencyCommand):
        pass

    class DuckCommand:
        scope = "backtest.preflight"
        key = "duck"
        request_hash = "0" * 64
        logical_request_bytes = b'{"command":"backtest.preflight","request":{}}'

    subclass = object.__new__(SubclassCommand)
    object.__setattr__(subclass, "operation", "preflight")
    object.__setattr__(subclass, "key", "subclass")
    object.__setattr__(subclass, "canonical_request_bytes", b"{}")
    object.__setattr__(subclass, "run_id", None)
    duck = cast(IdempotencyCommand, DuckCommand())

    for command in (subclass, duck):
        with pytest.raises(TypeError, match="exact IdempotencyCommand"):
            store.execute_idempotent(
                command=command,
                handler=lambda transaction: IdempotentResponse(status_code=200, body=b"{}"),
            )

    assert (
        type(SubclassCommand.preflight(key="factory", canonical_request_bytes=b"{}"))
        is IdempotencyCommand
    )


def test_idempotency_revalidates_exact_command_fields(store: ControlStore) -> None:
    forged = object.__new__(IdempotencyCommand)
    object.__setattr__(forged, "operation", "cancel")
    object.__setattr__(forged, "key", "forged")
    object.__setattr__(forged, "canonical_request_bytes", b"{}")
    object.__setattr__(forged, "run_id", None)

    with pytest.raises(ValueError, match="command"):
        store.execute_idempotent(
            command=forged,
            handler=lambda transaction: IdempotentResponse(status_code=200, body=b"{}"),
        )


def test_idempotency_revalidates_exact_response_fields(store: ControlStore) -> None:
    command = IdempotencyCommand.preflight(
        key="forged-response",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    forged = IdempotentResponse(status_code=200, body=b"{}")
    object.__setattr__(forged, "body", b"{ }")

    with pytest.raises(ValueError, match="response body.*canonical"):
        store.execute_idempotent(
            command=command,
            handler=lambda transaction: forged,
        )

    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_valid_response",
        preflight_id="pf_valid_response",
    )

    def valid_handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked_preflight(
            transaction,
            command=command,
            run_id="bt_valid_response",
            preflight_id="pf_valid_response",
            response_bytes=response_bytes,
        )
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_valid_response",
        )

    assert store.execute_idempotent(command=command, handler=valid_handler) == (
        IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_valid_response",
        )
    )


def test_public_events_never_return_a_hidden_terminal_event(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "hidden.sqlite")
    _persist_owned_terminal_preparation(
        connection,
        run_id="bt_hidden",
        include_hidden_event=True,
    )
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())
    try:
        assert store.events("bt_hidden") == ()
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ?",
                ("bt_hidden",),
            ).fetchone()[0]
            == 1
        )
    finally:
        store.close()


def test_idempotency_scopes_are_server_derived_and_exact() -> None:
    assert IdempotencyCommand.preflight(key="k", canonical_request_bytes=b"{}").scope == (
        "backtest.preflight"
    )
    assert IdempotencyCommand.create(key="k", canonical_request_bytes=b"{}").scope == (
        "backtest.create"
    )
    assert (
        IdempotencyCommand.cancel(
            run_id="bt_1", key="k", canonical_request_bytes=b'{"reason":"operator"}'
        ).scope
        == "backtest.cancel/bt_1"
    )
    with pytest.raises(TypeError):
        IdempotencyCommand(scope="client-controlled", key="k", canonical_request_bytes=b"{}")
    with pytest.raises(TypeError):
        IdempotencyCommand(
            operation="preflight",
            key="k",
            canonical_request_bytes=b"{}",
            run_id=None,
        )


def test_idempotency_logical_identity_separates_operation_target_and_bare_body() -> None:
    request = b"{}"
    commands = (
        IdempotencyCommand.preflight(key="same", canonical_request_bytes=request),
        IdempotencyCommand.create(key="same", canonical_request_bytes=request),
        IdempotencyCommand.cancel(
            run_id="bt_a",
            key="same",
            canonical_request_bytes=request,
        ),
        IdempotencyCommand.cancel(
            run_id="bt_b",
            key="same",
            canonical_request_bytes=request,
        ),
    )

    assert len({command.logical_request_bytes for command in commands}) == 4
    assert len({command.request_hash for command in commands}) == 4
    assert commands[0].logical_request_bytes == canonical_json_bytes(
        {"command": "backtest.preflight", "request": {}}
    )
    assert commands[2].logical_request_bytes == canonical_json_bytes(
        {"command": "backtest.cancel", "request": {}, "run_id": "bt_a"}
    )


def test_preflight_persist_before_reserve_poisons_and_rolls_back(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="persist-before-reserve",
        canonical_request_bytes=b'{"fixture_id":"qa"}',
    )
    response_bytes = b'{"run_id":"bt_persist_first"}'

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        try:
            transaction.persist_preflight(
                preflight_id="pf_persist_first",
                run_id="bt_persist_first",
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
                expires_at_ns=10_000,
                ready_evidence=None,
            )
        except EventRejected:
            pass
        return IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_persist_first")

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(command=command, handler=handler)

    for table in ("runs", "preflights", "events", "idempotency_records"):
        assert store._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_preflight_cannot_attach_a_preexisting_draft_run(store: ControlStore) -> None:
    store.reserve_run(run_id="bt_existing_draft")
    command = IdempotencyCommand.preflight(
        key="attach-existing-draft",
        canonical_request_bytes=b'{"fixture_id":"qa"}',
    )
    response_bytes = b'{"run_id":"bt_existing_draft"}'

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        try:
            transaction.persist_preflight(
                preflight_id="pf_existing_draft",
                run_id="bt_existing_draft",
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
                expires_at_ns=10_000,
                ready_evidence=None,
            )
        except EventRejected:
            pass
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_existing_draft",
        )

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(command=command, handler=handler)

    assert store.run("bt_existing_draft").state is RunState.DRAFT
    assert store.events("bt_existing_draft") == ()
    assert store.preflight("pf_existing_draft") is None
    assert store.idempotent_response(command) is None


def test_preflight_request_identity_must_equal_the_current_command(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="request-binding",
        canonical_request_bytes=b'{"fixture_id":"qa"}',
    )
    other_request = b'{"fixture_id":"other"}'
    response_bytes = b'{"run_id":"bt_request_binding"}'

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_request_binding")
        try:
            transaction.persist_preflight(
                preflight_id="pf_request_binding",
                run_id="bt_request_binding",
                status="PREFLIGHT_BLOCKED",
                request_bytes=other_request,
                request_hash=sha256(other_request).hexdigest(),
                result_bytes=response_bytes,
                input_manifest_bytes=None,
                input_manifest_hash=None,
                catalog_revision=None,
                catalog_inventory_hash=None,
                engine_package_version=None,
                engine_tag_commit=None,
                risk_policy_hash=None,
                expires_at_ns=10_000,
                ready_evidence=None,
            )
        except EventRejected:
            pass
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_request_binding",
        )

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(command=command, handler=handler)

    with pytest.raises(RunNotFound):
        store.run("bt_request_binding")
    assert store.preflight("pf_request_binding") is None
    assert store.idempotent_response(command) is None


def test_preflight_persisted_result_must_equal_the_exact_success_response(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="result-binding",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    persisted = _blocked_result_bytes(
        command=command,
        run_id="bt_result_binding",
        preflight_id="pf_result_binding",
    )
    returned = _blocked_result_bytes(
        command=command,
        run_id="bt_result_binding",
        preflight_id="pf_result_binding",
        expires_at_ns=9_999,
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked_preflight(
            transaction,
            command=command,
            run_id="bt_result_binding",
            preflight_id="pf_result_binding",
            response_bytes=persisted,
        )
        return IdempotentResponse(
            status_code=200,
            body=returned,
            run_id="bt_result_binding",
        )

    with pytest.raises(EventRejected, match="exact successful response body"):
        store.execute_idempotent(command=command, handler=handler)

    with pytest.raises(RunNotFound):
        store.run("bt_result_binding")
    assert store.preflight("pf_result_binding") is None
    assert store.idempotent_response(command) is None


@pytest.mark.parametrize("field", ["state_version", "expires_at_ns"])
def test_preflight_write_rejects_boolean_result_integer_and_rolls_back(
    store: ControlStore,
    field: str,
) -> None:
    command = IdempotencyCommand.preflight(
        key=f"boolean-result-{field}",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    result = json.loads(
        _blocked_result_bytes(
            command=command,
            run_id=f"bt_boolean_{field}",
            preflight_id=f"pf_boolean_{field}",
        )
    )
    assert isinstance(result, dict)
    checks = result["checks"]
    assert isinstance(checks, list)
    assert all(
        isinstance(check, dict)
        and set(check) == {"checked_at_ns", "code", "evidence", "explanation", "passed"}
        for check in checks
    ), "the bool mutation must be the only invalid persisted-result field"
    result[field] = True
    wrapped = canonical_json_bytes({"value": result})
    prefix = b'{"value":'
    assert wrapped.startswith(prefix) and wrapped.endswith(b"}")
    response_bytes = wrapped[len(prefix) : -1]

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked_preflight(
            transaction,
            command=command,
            run_id=f"bt_boolean_{field}",
            preflight_id=f"pf_boolean_{field}",
            response_bytes=response_bytes,
            expires_at_ns=PREFLIGHT_EXPIRES_AT_NS,
        )
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id=f"bt_boolean_{field}",
        )

    with pytest.raises(ControlStoreError) as error_info:
        store.execute_idempotent(command=command, handler=handler)
    cause = error_info.value.__cause__
    assert isinstance(cause, ValueError)
    assert (
        str(cause)
        == {
            "expires_at_ns": "Preflight result expires_at_ns is invalid.",
            "state_version": "Preflight result state_version is invalid.",
        }[field]
    )

    with pytest.raises(RunNotFound):
        store.run(f"bt_boolean_{field}")
    assert store.preflight(f"pf_boolean_{field}") is None
    assert store.idempotent_response(command) is None


def test_preflight_requires_matching_transition_and_forbids_append_bypass(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="append-bypass",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_append_bypass",
        preflight_id="pf_append_bypass",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked_preflight(
            transaction,
            command=command,
            run_id="bt_append_bypass",
            preflight_id="pf_append_bypass",
            response_bytes=response_bytes,
        )
        try:
            transaction.append_event(
                run_id="bt_append_bypass",
                expected_version=1,
                candidate=_control("report.generated"),
            )
        except EventRejected:
            pass
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_append_bypass",
        )

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(command=command, handler=handler)

    with pytest.raises(RunNotFound):
        store.run("bt_append_bypass")
    assert store.preflight("pf_append_bypass") is None
    assert store.idempotent_response(command) is None


def test_preflight_completion_requires_its_matching_transition(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="missing-transition",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_missing_transition",
        preflight_id="pf_missing_transition",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_missing_transition")
        transaction.persist_preflight(
            preflight_id="pf_missing_transition",
            run_id="bt_missing_transition",
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
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_missing_transition",
        )

    with pytest.raises(EventRejected, match="must persist one preflight and transition"):
        store.execute_idempotent(command=command, handler=handler)

    with pytest.raises(RunNotFound):
        store.run("bt_missing_transition")
    assert store.preflight("pf_missing_transition") is None
    assert store.idempotent_response(command) is None


def test_preflight_transition_must_match_the_persisted_status_and_poisons(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="mismatched-transition",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_mismatched_transition",
        preflight_id="pf_mismatched_transition",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        transaction.reserve_run(run_id="bt_mismatched_transition")
        transaction.persist_preflight(
            preflight_id="pf_mismatched_transition",
            run_id="bt_mismatched_transition",
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
                run_id="bt_mismatched_transition",
                expected_version=0,
                target=RunState.PREFLIGHT_READY,
                candidate=EventCandidate.control(
                    type="preflight.passed",
                    ts_event_ns=str(PREFLIGHT_CHECKED_AT_NS),
                    payload={},
                ),
            )
        except EventRejected:
            pass
        return IdempotentResponse(
            status_code=200,
            body=response_bytes,
            run_id="bt_mismatched_transition",
        )

    with pytest.raises(ControlStoreError, match="poisoned"):
        store.execute_idempotent(command=command, handler=handler)

    with pytest.raises(RunNotFound):
        store.run("bt_mismatched_transition")
    assert store.preflight("pf_mismatched_transition") is None
    assert store.idempotent_response(command) is None


def test_fixed_idempotent_and_preflight_reads_do_not_begin_a_write_transaction(
    store: ControlStore,
) -> None:
    command = IdempotencyCommand.preflight(
        key="read-only-gate",
        canonical_request_bytes=_blocked_request_bytes(),
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_read_only",
        preflight_id="pf_read_only",
    )

    def handler(transaction: ControlTransaction) -> IdempotentResponse:
        _persist_blocked_preflight(
            transaction,
            command=command,
            run_id="bt_read_only",
            preflight_id="pf_read_only",
            response_bytes=response_bytes,
        )
        return IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_read_only")

    expected = store.execute_idempotent(command=command, handler=handler)
    statements: list[str] = []
    store._connection.set_trace_callback(statements.append)
    try:
        assert store.idempotent_response(command) == expected
        assert store.preflight("pf_read_only") is not None
    finally:
        store._connection.set_trace_callback(None)

    write_prefixes = ("BEGIN", "INSERT", "UPDATE", "DELETE", "REPLACE")
    assert not any(
        statement.lstrip().upper().startswith(write_prefixes) for statement in statements
    )
    assert not store._connection.in_transaction


def test_recoverable_active_runs_are_validated_read_only_and_deterministic(
    store: ControlStore,
) -> None:
    _to_queued(store, "bt_queued")
    _to_running(store, "bt_running")
    _to_queued(store, "bt_cancel")
    store.commit_transition(
        run_id="bt_cancel",
        expected_version=2,
        target=RunState.CANCEL_REQUESTED,
        candidate=_control("run.cancel_requested"),
    )
    _to_queued(store, "bt_pending")
    store.commit_transition(
        run_id="bt_pending",
        expected_version=2,
        target=RunState.CANCEL_REQUESTED,
        candidate=_control("run.cancel_requested"),
    )
    store.commit_transition(
        run_id="bt_pending",
        expected_version=3,
        target=RunState.CANCEL_PENDING,
        candidate=_control("run.cancel_pending"),
    )
    _to_running(store, "bt_finalizing")
    store.commit_transition(
        run_id="bt_finalizing",
        expected_version=3,
        target=RunState.FINALIZING,
        candidate=_control("run.finalizing"),
    )
    _to_ready(store, "bt_ready_excluded")

    reader = getattr(store, "recoverable_active_runs", None)
    assert reader is not None
    statements: list[str] = []
    store._connection.set_trace_callback(statements.append)
    try:
        active = reader()
    finally:
        store._connection.set_trace_callback(None)

    assert [(run.run_id, run.state) for run in active] == [
        ("bt_cancel", RunState.CANCEL_REQUESTED),
        ("bt_finalizing", RunState.FINALIZING),
        ("bt_pending", RunState.CANCEL_PENDING),
        ("bt_queued", RunState.QUEUED),
        ("bt_running", RunState.RUNNING),
    ]
    write_prefixes = ("BEGIN", "INSERT", "UPDATE", "DELETE", "REPLACE")
    assert not any(
        statement.lstrip().upper().startswith(write_prefixes) for statement in statements
    )
    assert not store._connection.in_transaction


def test_cancel_pending_recovery_can_advance_the_persisted_signal_phase(
    store: ControlStore,
) -> None:
    identity, _launched_at_ns = _claimed_cancel_pending(store, "bt_pending_signal")

    assert store.mark_recovery_term_sent(
        run_id=identity.run_id,
        spawn_nonce=identity.spawn_nonce,
    )
    process = store.runner_process(identity.run_id)
    assert process is not None
    assert process.cancel_phase == "TERM_SENT"


def test_cancel_pending_recovery_can_record_one_bound_runner_outcome(
    store: ControlStore,
) -> None:
    identity, launched_at_ns = _claimed_cancel_pending(store, "bt_pending_outcome")
    outcome = SupervisorExitV1(
        run_id=identity.run_id,
        spawn_nonce=identity.spawn_nonce,
        process_identity_sha256=process_identity_digest(identity),
        launched_at_ns=launched_at_ns,
        ended_at_ns=launched_at_ns + 1,
        duration_ns=1,
        exit_code=None,
        signal=None,
        final_cancel_phase="REQUESTED",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=None,
        classification="SUPERVISOR_FAILURE",
        failure_code="PROCESS_IDENTITY_LOST",
        proposed_terminal_state="FAILED",
    )

    first = store.record_runner_outcome(outcome)
    replay = store.record_runner_outcome(outcome)
    assert replay == first
    assert store.run(identity.run_id).state is RunState.FINALIZING


@pytest.mark.parametrize("read_kind", ["idempotent", "preflight"])
@pytest.mark.parametrize(
    "pragma",
    ["PRAGMA user_version = 2", "PRAGMA foreign_keys = OFF"],
)
def test_fixed_reads_fail_closed_when_runtime_connection_gate_drifts(
    store: ControlStore,
    read_kind: str,
    pragma: str,
) -> None:
    command = IdempotencyCommand.preflight(
        key="read-gate-drift",
        canonical_request_bytes=b'{"fixture_id":"qa"}',
    )
    store._connection.execute(pragma)

    with pytest.raises(DatabaseConfigurationError):
        if read_kind == "idempotent":
            store.idempotent_response(command)
        else:
            store.preflight("pf_missing")


def test_restricted_transaction_cannot_be_constructed_by_a_caller(tmp_path: Path) -> None:
    connection = open_control_database(tmp_path / "transaction.sqlite")
    try:
        with pytest.raises(TypeError, match="Protocols cannot be instantiated"):
            ControlTransaction(
                connection,
                clock=StepClock(),
                event_id_factory=RecordingIds(),
            )  # type: ignore[misc,call-arg]
    finally:
        connection.close()


def test_unknown_run_is_rejected(store: ControlStore) -> None:
    with pytest.raises(RunNotFound):
        store.run("bt_missing")


def test_terminal_finalization_api_hides_bare_digest_authority() -> None:
    assert tuple(inspect.signature(ControlStore.prepare_terminal).parameters) == (
        "self",
        "run_id",
    )
    assert tuple(inspect.signature(ControlStore.terminal_preparation).parameters) == (
        "self",
        "run_id",
    )
    assert tuple(inspect.signature(ControlStore.terminal_finalization).parameters) == (
        "self",
        "run_id",
    )
    assert tuple(inspect.signature(ControlStore.record_finalization_failure).parameters) == (
        "self",
        "run_id",
        "failure",
    )
    assert "VerifiedSealProof" not in registry_module.__all__
    assert "_VerifiedRootProof" not in registry_module.__all__
    assert not hasattr(ControlStore, "publish_verified_terminal")


def test_database_fault_from_public_call_rolls_back_the_transaction(
    tmp_path: Path,
) -> None:
    connection = open_control_database(tmp_path / "control.sqlite")
    store = ControlStore(connection, clock=StepClock(), event_id_factory=RecordingIds())
    store.reserve_run(run_id="bt_fault")
    connection.execute(
        """
        CREATE TEMP TRIGGER abort_events BEFORE INSERT ON main.events
        BEGIN SELECT RAISE(ABORT, 'event fault'); END
        """
    )
    try:
        with pytest.raises(sqlite3.IntegrityError, match="event fault"):
            store.commit_transition(
                run_id="bt_fault",
                expected_version=0,
                target=RunState.PREFLIGHT_READY,
                candidate=_control("preflight.passed"),
            )
        assert store.run("bt_fault").state_version == 0
    finally:
        store.close()
