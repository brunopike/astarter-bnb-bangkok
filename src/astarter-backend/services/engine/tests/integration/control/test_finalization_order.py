from __future__ import annotations

import fcntl
import os
import sqlite3
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path

import pytest

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.audit.materializer import _VerifiedFinalRootReceipt
from stark_trading_os.catalog.fixture_publisher import FixturePublisher
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.finalizer import Finalizer
from stark_trading_os.control.preflight import (
    EngineIdentity,
    PreflightService,
    RegisteredDefinition,
)
from stark_trading_os.control.process_identity import SupervisorExitV1, supervisor_exit_bytes
from stark_trading_os.control.registry import (
    ControlStore,
    FinalizationFailure,
    IdempotencyCommand,
    TerminalEligibilityError,
    TerminalIntegrityError,
    UnverifiedTerminalPublication,
)
from stark_trading_os.control.transactions import TerminalPreparation, _VerifiedRootProof
from stark_trading_os.domain.models import BacktestDraftRequest, EventEnvelopeV1, RunState
from stark_trading_os.runner.protocol import RunnerOutcomeV1, RunnerReportCandidateV1

REPOSITORY_ROOT = Path(__file__).parents[5]


class MutableClock:
    def __init__(self, value: int = 100) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value


def test_rootless_arbitrary_digest_cannot_publish_a_terminal(tmp_path: Path) -> None:
    """Catches a directly constructible proof publishing without locked root evidence."""

    clock = MutableClock()
    store = ControlStore.open(tmp_path / "rootless-forgery.sqlite", clock=clock)
    run_id = "bt_rootless_forgery"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        preparation = store.prepare_terminal(run_id=run_id)

        with pytest.raises(TypeError, match="issued only"):
            _VerifiedRootProof(
                run_id=preparation.run_id,
                terminal_state=preparation.terminal_state,
                terminal_event_seq=preparation.event.seq,
                last_audit_seq=preparation.audit_intent.audit_seq,
                seal_digest="9" * 64,
            )
        fd, path = tempfile.mkstemp(prefix="sta25-rootless-")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            forged_receipt = object.__new__(_VerifiedFinalRootReceipt)
            forged_receipt._lock_guard_fd = os.dup(fd)
            forged_receipt._consumed = False
            with pytest.raises(Exception, match="receipt"):
                _VerifiedRootProof._issue_from_locked_root(
                    run_id=preparation.run_id,
                    terminal_state=preparation.terminal_state,
                    terminal_event_seq=preparation.event.seq,
                    last_audit_seq=preparation.audit_intent.audit_seq,
                    seal_digest="9" * 64,
                    root_receipt=forged_receipt,
                    authority=store._publication_authority,
                )
            forged_receipt._discard()
        finally:
            os.close(fd)
            os.unlink(path)
        assert store.terminal_finalization(run_id=run_id) is None
        assert store.run(run_id).state is RunState.FINALIZING
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def _definition(identifier: str, version: str, value: dict[str, object]) -> RegisteredDefinition:
    raw = canonical_json_bytes(value)
    return RegisteredDefinition(
        identifier=identifier,
        version=version,
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )


def _draft(catalog_revision: str) -> BacktestDraftRequest:
    return BacktestDraftRequest.model_validate(
        {
            "environment": "BACKTEST",
            "strategy_ref": "determinism-probe@v1",
            "catalog_revision": catalog_revision,
            "window": {
                "start_ns": "1700000000000000000",
                "end_ns": "1700000000000000002",
            },
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
            "cost_fill_model": {
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
            },
            "risk_policy_ref": "probe-risk@v1",
            "replay_seed": 7,
        }
    )


def _insert_direct_preparation(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    candidate_state: str,
    candidate_event_type: str,
) -> None:
    connection.execute(
        "INSERT INTO runs (run_id, state, state_version, created_at_ns) "
        "VALUES (?, 'FINALIZING', 4, 0)",
        (run_id,),
    )
    connection.execute(
        """
        INSERT INTO runner_outcomes (run_id, outcome_bytes, outcome_hash, recorded_at_ns)
        VALUES (?, ?, ?, 0)
        """,
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
            ?, ?, ?, 5, ?, 1, 1, 'control-api', ?, 'control-api', 1,
            '10', '10', 0, ?, ?, ?, 1, ?, ?, ?, 10, 10, 'NORMAL', 0,
            NULL, NULL, NULL, NULL
        )
        """,
        (
            run_id,
            "a" * 64,
            candidate_state,
            f"evt_{run_id}_000001",
            candidate_event_type,
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
        SET prepared_terminal_state = ?, prepared_terminal_state_version = 5,
            prepared_terminal_event_seq = 1, evidence_status = 'STAGING'
        WHERE run_id = ?
        """,
        (candidate_state, run_id),
    )
    connection.commit()


@pytest.mark.parametrize(
    ("candidate_state", "candidate_event_type"),
    [
        pytest.param("COMPLETED", "run.completed", id="completed"),
        pytest.param("CANCELLED", "run.cancelled", id="cancelled"),
    ],
)
def test_v2_preparation_keeps_fault_conversion_relational_and_private(
    tmp_path: Path,
    candidate_state: str,
    candidate_event_type: str,
) -> None:
    store = ControlStore.open(tmp_path / f"{candidate_state.lower()}.sqlite")
    connection = store._connection
    run_id = f"bt_v2_{candidate_state.lower()}"
    try:
        _insert_direct_preparation(
            connection,
            run_id=run_id,
            candidate_state=candidate_state,
            candidate_event_type=candidate_event_type,
        )
        before = connection.execute(
            """
            SELECT state, state_version, last_event_seq, last_audit_seq,
                   control_source_seq, evidence_status
            FROM runs WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        assert tuple(before) == ("FINALIZING", 4, 0, 0, 0, "STAGING")
        for table in ("events", "audit_intents", "outbox", "seals"):
            assert (
                connection.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE run_id = ?", (run_id,)
                ).fetchone()[0]
                == 0
            )

        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            UPDATE terminal_preparations
            SET terminal_state = 'FAILED', event_type = 'run.failed',
                event_envelope_bytes = ?, event_digest = ?, audit_event_digest = ?,
                audit_intent_bytes = ?, audit_intent_digest = ?,
                disposition = 'FAULT_CONVERTED', failure_attempt_count = 3,
                last_failure_at_ns = 20, last_failure_stage = 'PUBLICATION',
                conversion_fault_hash = ?, converted_at_ns = 20
            WHERE run_id = ?
            """,
            (
                b'{"converted":true}',
                "d" * 64,
                "d" * 64,
                b'{"converted_audit":true}',
                "e" * 64,
                "f" * 64,
                run_id,
            ),
        )
        connection.execute(
            "UPDATE runs SET prepared_terminal_state = 'FAILED', "
            "evidence_status = 'UNVERIFIED' WHERE run_id = ?",
            (run_id,),
        )
        connection.execute(
            """
            INSERT INTO finalization_faults (run_id, fault_bytes, fault_hash, recorded_at_ns)
            VALUES (?, ?, ?, 20)
            """,
            (run_id, b'{"fault":true}', "f" * 64),
        )
        connection.commit()

        converted = connection.execute(
            """
            SELECT runner_outcome_hash, terminal_state, event_type, disposition,
                   failure_attempt_count, conversion_fault_hash
            FROM terminal_preparations WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        assert tuple(converted) == (
            "a" * 64,
            "FAILED",
            "run.failed",
            "FAULT_CONVERTED",
            3,
            "f" * 64,
        )
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )
        assert tuple(
            connection.execute(
                "SELECT last_event_seq, last_audit_seq, control_source_seq "
                "FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        ) == (0, 0, 0)
    finally:
        store.close()


def _seed_queued(
    store: ControlStore,
    run_id: str,
    *,
    tmp_path: Path,
) -> tuple[str, str]:
    clock = store._clock
    assert isinstance(clock, MutableClock)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=store,
        runtime_root=tmp_path / f"trading-{run_id}",
    )
    publication = publisher.publish("local-qa-v1")
    strategy = _definition(
        "determinism-probe",
        "v1",
        {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
    )
    risk = _definition("probe-risk", "v1", {"max_notional": "1600"})
    run_root = tmp_path / f"runs-{run_id}"
    run_root.mkdir()
    service = PreflightService(
        control=store,
        catalog=publisher,
        engine=EngineIdentity(
            package_version="2.0.0rc3",
            tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
            python_version="3.12.4",
            precision_mode="FIXED_PRECISION_16",
        ),
        strategy_resolver=lambda ref: strategy if ref == "determinism-probe@v1" else None,
        risk_resolver=lambda ref: risk if ref == "probe-risk@v1" else None,
        clock=clock,
        run_id_factory=lambda: run_id,
        preflight_id_factory=lambda: f"pf_{run_id}",
        token_ttl_ns=100,
        run_root=run_root,
    )
    previous_clock_value = clock.value
    clock.value = 1_700_000_000_000_000_000
    try:
        preflight = service.run(
            _draft(publication.catalog_revision),
            idempotency_key=f"preflight-{run_id}",
        )
        service.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key=f"create-{run_id}",
        )
    finally:
        clock.value = previous_clock_value
    run = store.run(run_id)
    assert run.input_manifest_hash is not None
    assert run.catalog_revision is not None
    return run.input_manifest_hash, run.catalog_revision


def _seed_no_spawn_finalizing(
    store: ControlStore,
    run_id: str,
    *,
    tmp_path: Path,
) -> SupervisorExitV1:
    _seed_queued(store, run_id, tmp_path=tmp_path)
    store.request_runner_cancel(
        command=IdempotencyCommand.cancel(
            run_id=run_id,
            key=f"cancel-{run_id}",
            canonical_request_bytes=canonical_json_bytes({"reason": "test"}),
        ),
        reason="test",
    )
    outcome = SupervisorExitV1(
        run_id=run_id,
        spawn_nonce=None,
        process_identity_sha256=None,
        launched_at_ns=None,
        ended_at_ns=100,
        duration_ns=0,
        exit_code=None,
        signal=None,
        final_cancel_phase="REQUESTED",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=None,
        classification="NO_SPAWN_CANCELLED",
        failure_code=None,
        proposed_terminal_state="CANCELLED",
    )
    assert supervisor_exit_bytes(outcome)
    store.record_runner_outcome(outcome)
    return outcome


def _publish_no_spawn_through_materializer(
    store: ControlStore,
    preparation: TerminalPreparation,
    *,
    tmp_path: Path,
) -> object:
    """Exercise verified publication only through the real locked root chain."""

    runtime = tmp_path / f"finalizer-runtime-{preparation.run_id}"
    runtime.mkdir(mode=0o700)
    (runtime / "runs").mkdir(mode=0o700)
    staging = runtime / "staging" / preparation.run_id
    staging.mkdir(parents=True, mode=0o700)
    assert preparation.run_record is not None
    manifest = store.run(preparation.run_id).input_manifest_bytes
    assert manifest is not None
    for name, payload in (
        ("input-manifest.json", manifest),
        ("runner-exit.json", preparation.outcome.outcome_bytes),
        ("stderr.txt", b""),
    ):
        path = staging / name
        path.write_bytes(payload)
        path.chmod(0o600)
    return Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)


def _seed_completed_finalizing(
    store: ControlStore,
    run_id: str,
    *,
    tmp_path: Path,
) -> SupervisorExitV1:
    input_manifest_hash, catalog_revision = _seed_queued(
        store,
        run_id,
        tmp_path=tmp_path,
    )
    spawn_nonce = f"spawn-{run_id}"
    store.claim_runner_process(run_id=run_id, spawn_nonce=spawn_nonce)
    reports = tuple(
        RunnerReportCandidateV1(
            name=name,
            relative_path=f"reports/{name}.json",
            sha256=str(index) * 64,
            size_bytes=index,
        )
        for index, name in enumerate(
            ("orders", "fills", "positions", "account", "metrics"),
            start=1,
        )
    )
    child = RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": run_id,
            "input_manifest_hash": input_manifest_hash,
            "catalog_revision": catalog_revision,
            "engine_package_version": "2.0.0rc3",
            "result": "SUCCEEDED",
            "last_source_seq": 0,
            "report_candidates": [report.model_dump(mode="json") for report in reports],
            "failure": None,
        }
    )
    outcome = SupervisorExitV1(
        run_id=run_id,
        spawn_nonce=spawn_nonce,
        process_identity_sha256=None,
        launched_at_ns=None,
        ended_at_ns=100,
        duration_ns=0,
        exit_code=0,
        signal=None,
        final_cancel_phase="NONE",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=child,
        classification="NATURAL_SUCCESS",
        failure_code=None,
        proposed_terminal_state="COMPLETED",
    )
    store.record_runner_outcome(outcome)
    return outcome


def _convert_preparation(
    store: ControlStore,
    *,
    run_id: str,
    forged_fault_bytes: bool,
) -> None:
    preparation = store.terminal_preparation(run_id=run_id)
    assert preparation is not None
    wrapped_fault = canonical_json_bytes(
        {
            "value": {
                "schema": "FinalizationFault.v1",
                "run_id": run_id,
                "outcome_hash": preparation.outcome.outcome_hash,
                "initial_event_digest": preparation.initial_event_digest,
                "category": "DETERMINISTIC_EVIDENCE_FAILURE",
                "stage": "PUBLICATION",
                "attempt_count": 3,
                "observed_at_ns": 201,
            }
        }
    )
    assert wrapped_fault.startswith(b'{"value":') and wrapped_fault.endswith(b"}")
    fault_bytes = wrapped_fault[len(b'{"value":') : -1]
    fault_hash = sha256(fault_bytes).hexdigest()
    envelope = EventEnvelopeV1.model_validate(
        {
            "event_id": preparation.event.event_id,
            "run_id": run_id,
            "seq": preparation.event.seq,
            "source_seq": preparation.event.source_seq,
            "ts_event_ns": preparation.event.ts_event_ns,
            "ts_ingest_ns": preparation.event.ts_ingest_ns,
            "type": "run.failed",
            "source": "control-api",
            "writer": "control-api",
            "schema_version": 1,
            "payload": {
                "classification": preparation.outcome.outcome.classification,
                "outcome_hash": preparation.outcome.outcome_hash,
                "outcome_terminal_state": preparation.outcome.outcome.proposed_terminal_state,
                "terminal_state": "FAILED",
                "evidence_status": "UNVERIFIED",
                "finalization_fault_hash": fault_hash,
            },
        }
    )
    envelope_bytes = canonical_json_bytes(envelope.model_dump(mode="json", by_alias=True))
    event_digest = sha256(envelope_bytes).hexdigest()
    audit_bytes = canonical_json_bytes(
        {
            "seq": preparation.audit_intent.audit_seq,
            "run_id": run_id,
            "event_seq": preparation.event.seq,
            "event_digest": event_digest,
        }
    )
    connection = store._connection
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """
        UPDATE terminal_preparations
        SET terminal_state = 'FAILED', event_type = 'run.failed',
            event_envelope_bytes = ?, event_digest = ?, audit_event_digest = ?,
            audit_intent_bytes = ?, audit_intent_digest = ?,
            disposition = 'FAULT_CONVERTED', failure_attempt_count = 3,
            last_failure_at_ns = 201, last_failure_stage = 'PUBLICATION',
            conversion_fault_hash = ?, converted_at_ns = 201
        WHERE run_id = ?
        """,
        (
            envelope_bytes,
            event_digest,
            event_digest,
            audit_bytes,
            sha256(audit_bytes).hexdigest(),
            fault_hash,
            run_id,
        ),
    )
    connection.execute(
        "UPDATE runs SET prepared_terminal_state = 'FAILED', "
        "evidence_status = 'UNVERIFIED' WHERE run_id = ?",
        (run_id,),
    )
    connection.execute(
        """
        INSERT INTO finalization_faults (run_id, fault_bytes, fault_hash, recorded_at_ns)
        VALUES (?, ?, ?, 201)
        """,
        (run_id, b"{}" if forged_fault_bytes else fault_bytes, fault_hash),
    )
    connection.commit()


def test_prepared_identity_cannot_publish_without_a_verified_root(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "terminal.sqlite", clock=clock)
    run_id = "bt_terminal_authority"
    try:
        outcome = _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        assert hasattr(preparation, "run_record"), (
            "STA-24 requires one store-derived RunRecord.v1 authority on the preparation"
        )
        assert preparation == store.prepare_terminal(run_id=run_id)
        assert preparation == store.terminal_preparation(run_id=run_id)
        assert preparation.outcome.outcome == outcome
        assert preparation.terminal_state is RunState.CANCELLED
        assert preparation.terminal_state_version == 5
        assert preparation.event.event_id == f"evt_{run_id}_000005"
        assert preparation.event.seq == 5
        assert preparation.event.source_seq == 5
        assert preparation.event.visible is False
        assert preparation.audit_intent.audit_seq == 5
        assert preparation.prepared_at_ns == 200
        assert preparation.run_record.model_dump(mode="json", by_alias=True) == {
            "schema": "RunRecord.v1",
            "run_id": run_id,
            "preflight_id": f"pf_{run_id}",
            "idempotency_scope": "backtest.create",
            "idempotency_key": f"create-{run_id}",
            "state": "CANCELLED",
            "state_version": 5,
            "prepared_terminal_state": "CANCELLED",
            "prepared_terminal_state_version": 5,
            "created_at_ns": "1700000000000000000",
            "started_at_ns": None,
            "completed_at_ns": "100",
            "duration_ns": "0",
            "runner_identity": None,
            "runner_exit": outcome.model_dump(mode="json"),
            "materialized_event_seq": 5,
            "materialized_audit_seq": 5,
            "evidence_status": "VERIFIED",
        }
        assert [event.type for event in store.events(run_id)] == [
            "preflight.passed",
            "run.queued",
            "run.cancel_requested",
            "run.finalizing",
        ]
        assert store.run(run_id).state is RunState.FINALIZING
        assert store.run(run_id).state_version == 4
        assert store.run(run_id).last_event_seq == 4

        clock.value = 300
        publication = _publish_no_spawn_through_materializer(
            store,
            preparation,
            tmp_path=tmp_path,
        )
        assert publication == store.terminal_finalization(run_id=run_id)
        assert isinstance(publication, UnverifiedTerminalPublication)
        assert publication.state is RunState.FAILED
        assert publication.state_version == 5
        assert publication.event.event_id == preparation.event.event_id
        assert publication.event.type == "run.failed"
        assert publication.event.visible is True
        assert publication.audit_intent.event_seq == publication.event.seq
        assert store.terminal_finalization(run_id=run_id) == publication
        assert [item.seq for item in store.pending_outbox(run_id)] == [1, 2, 3, 4, 5]
        assert [event.type for event in store.events(run_id)] == [
            "preflight.passed",
            "run.queued",
            "run.cancel_requested",
            "run.finalizing",
            "run.failed",
        ]
        run = store.run(run_id)
        assert run.state is RunState.FAILED
        assert run.state_version == 5
        assert run.last_event_seq == 5
        assert run.last_audit_seq == 5
        with pytest.raises(TypeError, match="issued only"):
            _VerifiedRootProof(
                run_id=run_id,
                terminal_state=preparation.terminal_state,
                terminal_event_seq=preparation.event.seq,
                last_audit_seq=preparation.audit_intent.audit_seq,
                seal_digest="8" * 64,
            )
    finally:
        store.close()


def test_rootless_preparation_cannot_create_a_forgeable_seal(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "forged-seal.sqlite", clock=clock)
    run_id = "bt_forged_seal"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        clock.value = 300
        publication = _publish_no_spawn_through_materializer(store, preparation, tmp_path=tmp_path)
        assert isinstance(publication, UnverifiedTerminalPublication)
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_terminal_preparation_reads_one_exact_converted_identity(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "converted-exact.sqlite", clock=clock)
    run_id = "bt_converted_exact"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        store.prepare_terminal(run_id=run_id)
        _convert_preparation(
            store,
            run_id=run_id,
            forged_fault_bytes=False,
        )

        try:
            converted = store.terminal_preparation(run_id=run_id)
        except TerminalIntegrityError:
            converted = None
        assert converted is not None
        assert converted.disposition == "FAULT_CONVERTED"
        assert converted.run_record is None
        assert converted.terminal_state is RunState.FAILED
        assert converted.failure_attempt_count == 3
        assert (
            converted.conversion_fault_hash
            == sha256(
                store._connection.execute(
                    "SELECT fault_bytes FROM finalization_faults WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            ).hexdigest()
        )
        with pytest.raises(TerminalIntegrityError, match="partial"):
            store.terminal_finalization(run_id=run_id)
    finally:
        store.close()


def test_terminal_preparation_rejects_forged_converted_fault_bytes(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "converted-forged.sqlite", clock=clock)
    run_id = "bt_converted_forged"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        store.prepare_terminal(run_id=run_id)
        _convert_preparation(store, run_id=run_id, forged_fault_bytes=True)

        with pytest.raises(TerminalIntegrityError, match="invalid"):
            store.terminal_preparation(run_id=run_id)
    finally:
        store.close()


def test_operational_failures_persist_one_attempt_per_fresh_connection_then_convert(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "operational-attempts.sqlite"
    setup = ControlStore.open(database_path, clock=MutableClock())
    run_id = "bt_operational_attempts"
    try:
        _seed_no_spawn_finalizing(setup, run_id, tmp_path=tmp_path)
        setup._clock.value = 200
        setup.prepare_terminal(run_id=run_id)
    finally:
        setup.close()

    results: list[TerminalPreparation | UnverifiedTerminalPublication] = []
    for observed_at_ns in (201, 202, 203):
        store = ControlStore.open(database_path, clock=lambda: observed_at_ns)
        try:
            results.append(
                store.record_finalization_failure(
                    run_id=run_id,
                    failure=FinalizationFailure(deterministic=False, stage="FSYNC"),
                )
            )
        finally:
            store.close()

    assert isinstance(results[0], TerminalPreparation)
    assert results[0].failure_attempt_count == 1
    assert results[0].last_failure_at_ns == 201
    assert isinstance(results[1], TerminalPreparation)
    assert results[1].failure_attempt_count == 2
    assert results[1].last_failure_at_ns == 202
    assert isinstance(results[2], UnverifiedTerminalPublication)
    assert results[2].fault.category == "OPERATIONAL_RETRY_EXHAUSTED"
    assert results[2].fault.recorded_at_ns == 203

    verify = ControlStore.open(database_path, clock=lambda: 999)
    try:
        assert verify.terminal_finalization(run_id=run_id) == results[2]
        assert (
            verify.record_finalization_failure(
                run_id=run_id,
                failure=FinalizationFailure(deterministic=False, stage="RENAME"),
            )
            == results[2]
        )
    finally:
        verify.close()


def test_terminal_preparation_rejects_normal_retry_not_later_than_preparation(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "normal-retry-corruption.sqlite", clock=clock)
    run_id = "bt_normal_retry_corruption"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        initial = store.prepare_terminal(run_id=run_id)
        clock.value = 201
        retry = store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(deterministic=False, stage="FSYNC"),
        )
        assert isinstance(retry, TerminalPreparation)
        store._connection.execute("DROP TRIGGER trg_terminal_preparations_validate_update")
        store._connection.execute(
            "UPDATE terminal_preparations SET last_failure_at_ns = prepared_at_ns WHERE run_id = ?",
            (run_id,),
        )

        with pytest.raises(TerminalIntegrityError):
            store.terminal_preparation(run_id=run_id)
        assert initial.prepared_at_ns == 200
    finally:
        store.close()


def test_deterministic_failure_immediately_publishes_exact_unverified_identity(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "deterministic.sqlite", clock=clock)
    run_id = "bt_deterministic_failure"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        initial = store.prepare_terminal(run_id=run_id)
        clock.value = 201
        publication = store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
        )

        assert isinstance(publication, UnverifiedTerminalPublication)
        expected_fault_bytes = canonical_json_bytes(
            {
                "schema": "FinalizationFault.v1",
                "run_id": run_id,
                "outcome_hash": initial.outcome.outcome_hash,
                "initial_event_digest": initial.initial_event_digest,
                "category": "DETERMINISTIC_EVIDENCE_FAILURE",
                "stage": "REPORTS",
                "attempt_count": 3,
                "observed_at_ns": 201,
            }
        )
        assert publication.fault.fault_bytes == expected_fault_bytes
        assert publication.fault.fault_hash == sha256(expected_fault_bytes).hexdigest()
        assert b"exception" not in publication.fault.fault_bytes
        assert b"/" not in publication.fault.fault_bytes
        assert publication.state is RunState.FAILED
        assert publication.event.type == "run.failed"
        assert publication.event.visible is True
        assert publication.audit_intent.event_seq == publication.event.seq
        assert store.terminal_finalization(run_id=run_id) == publication
        converted = store.terminal_preparation(run_id=run_id)
        assert converted is not None
        assert converted.disposition == "FAULT_CONVERTED"
        assert converted.run_record is None
        assert converted.initial_event_digest == initial.initial_event_digest
        assert store.run(run_id).state is RunState.FAILED
        assert store.run(run_id).evidence_status == "UNVERIFIED"
        cursors = store._connection.execute(
            "SELECT materialized_event_seq, materialized_audit_seq FROM runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        assert tuple(cursors) == (0, 0)
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 1
        )
        assert [event.type for event in store.events(run_id)][-1] == "run.failed"
        assert store.pending_outbox(run_id)[-1].seq == publication.event.seq
    finally:
        store.close()


def test_terminal_finalization_rejects_mismatched_preterminal_materialized_cursors(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "unverified-cursor-drift.sqlite", clock=clock)
    run_id = "bt_unverified_cursor_drift"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        clock.value = 201
        store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
        )
        assert tuple(
            store._connection.execute(
                "SELECT materialized, materialized_at_ns FROM outbox WHERE run_id = ? AND seq = ?",
                (run_id, preparation.event.seq),
            ).fetchone()
        ) == (0, None)
        store._connection.execute(
            "UPDATE runs SET materialized_event_seq = 0, materialized_audit_seq = 1 "
            "WHERE run_id = ?",
            (run_id,),
        )

        with pytest.raises(TerminalIntegrityError):
            store.terminal_finalization(run_id=run_id)
    finally:
        store.close()


def test_deterministic_failure_converts_a_prepared_completed_candidate(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "completed-conversion.sqlite", clock=clock)
    run_id = "bt_completed_conversion"
    try:
        _seed_completed_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        initial = store.prepare_terminal(run_id=run_id)
        assert initial.terminal_state is RunState.COMPLETED

        clock.value = 201
        publication = store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(deterministic=True, stage="RECONCILIATION"),
        )

        assert isinstance(publication, UnverifiedTerminalPublication)
        assert publication.state is RunState.FAILED
        assert publication.fault.category == "DETERMINISTIC_EVIDENCE_FAILURE"
        assert publication.fault.stage == "RECONCILIATION"
        assert store.run(run_id).state is RunState.FAILED
        assert tuple(
            store._connection.execute(
                "SELECT terminal_state, disposition FROM terminal_preparations WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        ) == ("FAILED", "FAULT_CONVERTED")
    finally:
        store.close()


@pytest.mark.parametrize(
    "trigger_sql",
    [
        "BEFORE INSERT ON main.finalization_faults",
        "BEFORE INSERT ON main.events",
        "BEFORE INSERT ON main.audit_intents",
        "BEFORE INSERT ON main.outbox",
        "BEFORE UPDATE OF visible ON main.events",
        "BEFORE UPDATE OF state ON main.runs",
    ],
)
def test_conversion_statement_failure_rolls_back_every_public_identity(
    tmp_path: Path,
    trigger_sql: str,
) -> None:
    clock = MutableClock()
    database_path = tmp_path / f"rollback-{sha256(trigger_sql.encode()).hexdigest()}.sqlite"
    store = ControlStore.open(database_path, clock=clock)
    run_id = "bt_conversion_rollback"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        initial = store.prepare_terminal(run_id=run_id)
        store._connection.execute(
            f"CREATE TEMP TRIGGER fail_conversion {trigger_sql} "
            "BEGIN SELECT RAISE(ABORT, 'injected conversion failure'); END"
        )
        clock.value = 201
        with pytest.raises(sqlite3.IntegrityError, match="injected conversion failure"):
            store.record_finalization_failure(
                run_id=run_id,
                failure=FinalizationFailure(deterministic=True, stage="PUBLICATION"),
            )

        assert store.terminal_preparation(run_id=run_id) == initial
        assert store.terminal_finalization(run_id=run_id) is None
        assert store.run(run_id).state is RunState.FINALIZING
        assert store.run(run_id).evidence_status == "STAGING"
        for table in ("events", "audit_intents", "outbox"):
            assert (
                store._connection.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE run_id = ? AND rowid > 4",
                    (run_id,),
                ).fetchone()[0]
                == 0
            )
        for table in ("seals", "finalization_faults"):
            assert (
                store._connection.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE run_id = ?", (run_id,)
                ).fetchone()[0]
                == 0
            )
    finally:
        store.close()


def test_concurrent_deterministic_failure_recording_returns_one_identity(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "concurrent-fault.sqlite"
    setup = ControlStore.open(database_path, clock=MutableClock())
    run_id = "bt_concurrent_fault"
    try:
        _seed_no_spawn_finalizing(setup, run_id, tmp_path=tmp_path)
        setup._clock.value = 200
        setup.prepare_terminal(run_id=run_id)
    finally:
        setup.close()

    def record() -> object:
        store = ControlStore.open(database_path, clock=lambda: 201)
        try:
            return store.record_finalization_failure(
                run_id=run_id,
                failure=FinalizationFailure(deterministic=True, stage="SEAL"),
            )
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = tuple(executor.map(lambda _: record(), range(2)))
    assert results[0] == results[1]
    verify = ControlStore.open(database_path)
    try:
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.failed'",
                (run_id,),
            ).fetchone()[0]
            == 1
        )
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 1
        )
    finally:
        verify.close()


def test_verified_root_proof_mismatch_rejects_before_mutation(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "proof-mismatch.sqlite", clock=clock)
    run_id = "bt_proof_mismatch"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        for kwargs in (
            {"run_id": "bt_other"},
            {"terminal_state": RunState.COMPLETED},
            {"terminal_event_seq": preparation.event.seq + 1},
            {"last_audit_seq": preparation.audit_intent.audit_seq + 1},
        ):
            with pytest.raises(TypeError, match="issued only"):
                _VerifiedRootProof(
                    run_id=kwargs.get("run_id", preparation.run_id),
                    terminal_state=kwargs.get("terminal_state", preparation.terminal_state),
                    terminal_event_seq=kwargs.get("terminal_event_seq", preparation.event.seq),
                    last_audit_seq=kwargs.get("last_audit_seq", preparation.audit_intent.audit_seq),
                    seal_digest="9" * 64,
                )
        assert store.terminal_preparation(run_id=run_id) == preparation
        assert store.terminal_finalization(run_id=run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_same_nanosecond_failures_receive_minimal_monotonic_bumps(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "monotonic-failures.sqlite", clock=clock)
    run_id = "bt_monotonic_failures"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        store.prepare_terminal(run_id=run_id)
        observed: list[int] = []
        for _ in range(3):
            result = store.record_finalization_failure(
                run_id=run_id,
                failure=FinalizationFailure(deterministic=False, stage="STAGING"),
            )
            if isinstance(result, TerminalPreparation):
                assert result.last_failure_at_ns is not None
                observed.append(result.last_failure_at_ns)
            else:
                observed.append(result.fault.recorded_at_ns)
        assert observed == [201, 202, 203]
    finally:
        store.close()


def test_terminal_finalization_rejects_forged_published_event_bytes(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "forged-finalization.sqlite", clock=clock)
    run_id = "bt_forged_finalization"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        store.prepare_terminal(run_id=run_id)
        clock.value = 201
        store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
        )
        store._connection.execute("DROP TRIGGER trg_events_immutable_update")
        store._connection.execute(
            "UPDATE events SET envelope_bytes = ? WHERE run_id = ? AND type = 'run.failed'",
            (b"{}", run_id),
        )

        with pytest.raises(TerminalIntegrityError):
            store.terminal_finalization(run_id=run_id)
    finally:
        store.close()


def test_finalization_failure_requires_exact_closed_fields_before_mutation(
    tmp_path: Path,
) -> None:
    class FailureSubclass(FinalizationFailure):
        pass

    clock = MutableClock()
    store = ControlStore.open(tmp_path / "failure-fields.sqlite", clock=clock)
    run_id = "bt_failure_fields"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        initial = store.prepare_terminal(run_id=run_id)
        invalid_bool = FinalizationFailure(deterministic=True, stage="FSYNC")
        object.__setattr__(invalid_bool, "deterministic", 1)
        invalid_stage = FinalizationFailure(deterministic=True, stage="FSYNC")
        object.__setattr__(invalid_stage, "stage", "PATH")
        invalid = (
            FailureSubclass(deterministic=True, stage="FSYNC"),
            invalid_bool,
            invalid_stage,
        )
        for failure in invalid:
            with pytest.raises((TypeError, ValueError)):
                store.record_finalization_failure(run_id=run_id, failure=failure)
        assert store.terminal_preparation(run_id=run_id) == initial
        assert store.terminal_finalization(run_id=run_id) is None
    finally:
        store.close()


def test_private_root_proof_requires_exact_type_and_state(tmp_path: Path) -> None:
    class ProofSubclass(_VerifiedRootProof):
        pass

    clock = MutableClock()
    store = ControlStore.open(tmp_path / "proof-fields.sqlite", clock=clock)
    run_id = "bt_proof_fields"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        with pytest.raises(TypeError):
            ProofSubclass(
                run_id=preparation.run_id,
                terminal_state=preparation.terminal_state,
                terminal_event_seq=preparation.event.seq,
                last_audit_seq=preparation.audit_intent.audit_seq,
                seal_digest="9" * 64,
            )
        assert store.terminal_finalization(run_id=run_id) is None
    finally:
        store.close()


@pytest.mark.parametrize(
    "mutation",
    [
        "state = 'RUNNING'",
        "state_version = 99",
        "last_event_seq = last_event_seq + 1",
        "last_audit_seq = last_audit_seq + 1",
        "control_source_seq = control_source_seq + 1",
        "materialized_event_seq = 1",
        "materialized_audit_seq = 1",
        "evidence_status = 'VERIFIED'",
    ],
)
def test_terminal_preparation_rejects_run_phase_drift(
    tmp_path: Path,
    mutation: str,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(
        tmp_path / f"phase-{sha256(mutation.encode()).hexdigest()}.sqlite",
        clock=clock,
    )
    run_id = "bt_terminal_phase_drift"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        store.prepare_terminal(run_id=run_id)
        store._connection.execute(f"UPDATE runs SET {mutation} WHERE run_id = ?", (run_id,))

        with pytest.raises(TerminalIntegrityError, match="invalid"):
            store.terminal_preparation(run_id=run_id)
        with pytest.raises(TerminalIntegrityError, match="invalid"):
            store.prepare_terminal(run_id=run_id)
    finally:
        store.close()


@pytest.mark.parametrize("boundary", ["prepare", "publish"])
def test_terminal_read_observes_one_snapshot_across_concurrent_commit(
    tmp_path: Path,
    boundary: str,
) -> None:
    database_path = tmp_path / f"terminal-read-{boundary}.sqlite"
    setup_clock = MutableClock()
    setup = ControlStore.open(database_path, clock=setup_clock)
    run_id = f"bt_terminal_read_{boundary}"
    _seed_no_spawn_finalizing(setup, run_id, tmp_path=tmp_path)
    if boundary == "publish":
        setup_clock.value = 200
        before = setup.prepare_terminal(run_id=run_id)
    else:
        before = None
    setup.close()

    reader_ready = threading.Event()
    writer_done = threading.Event()
    result: list[object] = []
    errors: list[BaseException] = []

    def read() -> None:
        reader = ControlStore.open(database_path)

        def trace(statement: str) -> None:
            if statement.startswith("SELECT * FROM terminal_preparations"):
                reader_ready.set()
                assert writer_done.wait(timeout=5)

        reader._connection.set_trace_callback(trace)
        try:
            result.append(reader.terminal_preparation(run_id=run_id))
        except BaseException as error:
            errors.append(error)
        finally:
            reader.close()

    thread = threading.Thread(target=read)
    thread.start()
    assert reader_ready.wait(timeout=5)
    writer = ControlStore.open(database_path, clock=lambda: 300)
    try:
        if boundary == "prepare":
            writer.prepare_terminal(run_id=run_id)
        else:
            assert isinstance(before, TerminalPreparation)
            writer.record_finalization_failure(
                run_id=run_id,
                failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
            )
    finally:
        writer.close()
        writer_done.set()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert errors == []
    assert result == [before]


@pytest.mark.parametrize(
    "corruption",
    [
        "missing-preflight",
        "malformed-preflight-result",
        "missing-preflight-idempotency",
        "invalid-input-manifest",
        "forged-catalog-publication",
        "forged-preflight-lifecycle",
        "forged-create-lifecycle",
        "missing-create",
        "duplicate-create",
        "forged-create",
        "start-drift",
    ],
)
def test_planned_run_record_identity_fails_closed(
    tmp_path: Path,
    corruption: str,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / f"run-record-{corruption}.sqlite", clock=clock)
    run_id = f"bt_run_record_{corruption}"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        if corruption == "missing-preflight":
            store._connection.execute("DELETE FROM preflights WHERE run_id = ?", (run_id,))
        elif corruption == "malformed-preflight-result":
            store._connection.execute(
                "UPDATE preflights SET result_bytes = ? WHERE run_id = ?",
                (canonical_json_bytes({"status": "ready"}), run_id),
            )
        elif corruption == "missing-preflight-idempotency":
            store._connection.execute(
                "DELETE FROM idempotency_records "
                "WHERE idempotency_scope = 'backtest.preflight' AND run_id = ?",
                (run_id,),
            )
        elif corruption == "invalid-input-manifest":
            manifest = canonical_json_bytes({"fixture": run_id})
            manifest_hash = sha256(manifest).hexdigest()
            store._connection.execute(
                "UPDATE preflights SET input_manifest_bytes = ?, input_manifest_hash = ? "
                "WHERE run_id = ?",
                (manifest, manifest_hash, run_id),
            )
            store._connection.execute(
                "UPDATE runs SET input_manifest_bytes = ?, input_manifest_hash = ? "
                "WHERE run_id = ?",
                (manifest, manifest_hash, run_id),
            )
            create = store._connection.execute(
                "SELECT response_body FROM idempotency_records "
                "WHERE idempotency_scope = 'backtest.create' AND run_id = ?",
                (run_id,),
            ).fetchone()
            assert create is not None
            response = canonical_json_bytes(
                {
                    "input_manifest_hash": manifest_hash,
                    "last_visible_seq": 2,
                    "run_id": run_id,
                    "state": "QUEUED",
                    "state_version": 2,
                }
            )
            store._connection.execute(
                "UPDATE idempotency_records SET response_body = ? "
                "WHERE idempotency_scope = 'backtest.create' AND run_id = ?",
                (response, run_id),
            )
        elif corruption == "forged-catalog-publication":
            store._connection.execute(
                "UPDATE catalog_publications SET publication_bytes = ?",
                (b"{}",),
            )
        elif corruption == "forged-preflight-lifecycle":
            store._connection.execute("DROP TRIGGER trg_events_immutable_update")
            store._connection.execute(
                "UPDATE events SET envelope_bytes = ? WHERE run_id = ? AND seq = 1",
                (b"{}", run_id),
            )
        elif corruption == "forged-create-lifecycle":
            store._connection.execute(
                "UPDATE audit_intents SET intent_bytes = ? WHERE run_id = ? AND audit_seq = 2",
                (b"{}", run_id),
            )
        elif corruption == "missing-create":
            store._connection.execute(
                "DELETE FROM idempotency_records "
                "WHERE idempotency_scope = 'backtest.create' AND run_id = ?",
                (run_id,),
            )
        elif corruption == "duplicate-create":
            store._connection.execute(
                """
                INSERT INTO idempotency_records (
                    idempotency_scope, idempotency_key, request_hash, request_body,
                    response_status, response_body, target_run_id, run_id, created_at_ns
                )
                SELECT idempotency_scope, 'duplicate-create', request_hash, request_body,
                       response_status, response_body, target_run_id, run_id, created_at_ns
                FROM idempotency_records
                WHERE idempotency_scope = 'backtest.create' AND run_id = ?
                """,
                (run_id,),
            )
        elif corruption == "forged-create":
            store._connection.execute(
                "UPDATE idempotency_records SET request_hash = ? "
                "WHERE idempotency_scope = 'backtest.create' AND run_id = ?",
                ("0" * 64, run_id),
            )
        else:
            store._connection.execute(
                "UPDATE runs SET started_at_ns = 1 WHERE run_id = ?",
                (run_id,),
            )

        with pytest.raises(TerminalIntegrityError, match="invalid"):
            store.prepare_terminal(run_id=run_id)
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM terminal_preparations WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
            == 0
        )
        assert (
            store._connection.execute(
                "SELECT prepared_terminal_state FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
            is None
        )
    finally:
        store.close()


def test_prepare_and_publish_races_return_one_identity(tmp_path: Path) -> None:
    database_path = tmp_path / "terminal-race.sqlite"
    setup = ControlStore.open(database_path, clock=MutableClock())
    _seed_no_spawn_finalizing(setup, "bt_terminal_race", tmp_path=tmp_path)
    setup.close()

    def prepare() -> object:
        store = ControlStore.open(database_path, clock=lambda: 200)
        try:
            return store.prepare_terminal(run_id="bt_terminal_race")
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        preparations = tuple(executor.map(lambda _: prepare(), range(2)))
    assert preparations[0] == preparations[1]

    def publish() -> object:
        store = ControlStore.open(database_path, clock=lambda: 300)
        try:
            assert isinstance(preparations[0], TerminalPreparation)
            return store.record_finalization_failure(
                run_id="bt_terminal_race",
                failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
            )
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        publications = tuple(executor.map(lambda _: publish(), range(2)))
    assert publications[0] == publications[1]
    verify = ControlStore.open(database_path)
    try:
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.failed'",
                ("bt_terminal_race",),
            ).fetchone()[0]
            == 1
        )
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", ("bt_terminal_race",)
            ).fetchone()[0]
            == 0
        )
    finally:
        verify.close()


def test_publication_failure_rolls_back_and_retry_uses_reserved_identity(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "rollback.sqlite", clock=clock)
    run_id = "bt_publication_rollback"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        with pytest.raises(TypeError, match="issued only"):
            _VerifiedRootProof(
                run_id=run_id,
                terminal_state=preparation.terminal_state,
                terminal_event_seq=preparation.event.seq,
                last_audit_seq=preparation.audit_intent.audit_seq,
                seal_digest="6" * 64,
            )
        assert store.run(run_id).state is RunState.FINALIZING
        assert store.run(run_id).last_event_seq == 4
        assert store.terminal_preparation(run_id=run_id) == preparation
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.cancelled'",
                (run_id,),
            ).fetchone()[0]
            == 0
        )
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )

        assert store.terminal_finalization(run_id=run_id) is None
    finally:
        store.close()


def test_readback_rejects_forged_opaque_preparation_bytes(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "opaque.sqlite", clock=clock)
    run_id = "bt_opaque"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        forged_bytes = b"{}"
        forged_digest = sha256(forged_bytes).hexdigest()
        forged_audit = canonical_json_bytes(
            {
                "seq": preparation.audit_intent.audit_seq,
                "run_id": run_id,
                "event_seq": preparation.event.seq,
                "event_digest": forged_digest,
            }
        )
        store._connection.execute("DROP TRIGGER trg_terminal_preparations_validate_update")
        store._connection.execute(
            """
            UPDATE terminal_preparations
            SET event_envelope_bytes = ?, event_digest = ?, initial_event_digest = ?,
                audit_event_digest = ?, audit_intent_bytes = ?, audit_intent_digest = ?
            WHERE run_id = ?
            """,
            (
                forged_bytes,
                forged_digest,
                forged_digest,
                forged_digest,
                forged_audit,
                sha256(forged_audit).hexdigest(),
                run_id,
            ),
        )
        with pytest.raises(TerminalIntegrityError):
            store.terminal_preparation(run_id=run_id)
    finally:
        store.close()


def test_prepare_rejects_missing_outcome_and_publication_rejects_bad_proof(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "eligibility.sqlite", clock=clock)
    try:
        store._connection.execute(
            "INSERT INTO runs (run_id, state, created_at_ns) VALUES (?, 'FINALIZING', 0)",
            ("bt_missing_outcome",),
        )
        with pytest.raises(TerminalEligibilityError, match="runner outcome"):
            store.prepare_terminal(run_id="bt_missing_outcome")

        _seed_no_spawn_finalizing(store, "bt_bad_proof", tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id="bt_bad_proof")
        for digest in ("A" * 64, "0" * 63, "g" * 64):
            with pytest.raises(TypeError, match="issued only"):
                _VerifiedRootProof(
                    run_id=preparation.run_id,
                    terminal_state=preparation.terminal_state,
                    terminal_event_seq=preparation.event.seq,
                    last_audit_seq=preparation.audit_intent.audit_seq,
                    seal_digest=digest,
                )
    finally:
        store.close()


def test_terminal_read_rejects_partial_publication_identity(tmp_path: Path) -> None:
    clock = MutableClock()
    store = ControlStore.open(tmp_path / "partial.sqlite", clock=clock)
    run_id = "bt_partial_publication"
    try:
        _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
        clock.value = 200
        preparation = store.prepare_terminal(run_id=run_id)
        store._connection.execute(
            """
            UPDATE runs
            SET last_event_seq = ?, last_audit_seq = ?, control_source_seq = ?
            WHERE run_id = ?
            """,
            (
                preparation.event.seq,
                preparation.audit_intent.audit_seq,
                preparation.event.source_seq,
                run_id,
            ),
        )
        store._connection.execute(
            """
            INSERT INTO events (
                event_id, run_id, seq, source_seq, source, type, writer,
                schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
            ) VALUES (?, ?, ?, ?, 'control-api', ?, 'control-api', 1, ?, ?, 0, ?)
            """,
            (
                preparation.event.event_id,
                run_id,
                preparation.event.seq,
                preparation.event.source_seq,
                preparation.event.type,
                preparation.event.ts_event_ns,
                preparation.event.ts_ingest_ns,
                preparation.event.envelope_bytes,
            ),
        )
        with pytest.raises(TerminalIntegrityError, match="invalid"):
            store.terminal_preparation(run_id=run_id)
        with pytest.raises(TerminalIntegrityError):
            store.terminal_finalization(run_id=run_id)
    finally:
        store.close()
