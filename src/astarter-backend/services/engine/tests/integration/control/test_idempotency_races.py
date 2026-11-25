from __future__ import annotations

import multiprocessing
import threading
from collections.abc import Callable
from hashlib import sha256
from multiprocessing.queues import Queue
from multiprocessing.synchronize import Barrier
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
    ControlTransaction,
    EventCandidate,
    IdempotencyCommand,
    IdempotencyConflict,
    IdempotentResponse,
    VersionConflict,
)
from stark_trading_os.domain.models import RunState


class CountingClock:
    def __init__(self, start: int) -> None:
        self._next = start
        self.calls = 0

    def __call__(self) -> int:
        value = self._next
        self._next += 1
        self.calls += 1
        return value


class CountingIds:
    def __init__(self, label: str) -> None:
        self.label = label
        self.calls = 0

    def __call__(self, run_id: str, seq: int) -> str:
        self.calls += 1
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


def _run_two_workers(
    first: Callable[[], object], second: Callable[[], object]
) -> tuple[list[object], list[BaseException]]:
    barrier = threading.Barrier(2)
    results: list[object] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def invoke(callback: Callable[[], object]) -> None:
        barrier.wait(timeout=5)
        try:
            result = callback()
        except BaseException as error:
            with lock:
                errors.append(error)
        else:
            with lock:
                results.append(result)

    threads = [
        threading.Thread(target=invoke, args=(first,)),
        threading.Thread(target=invoke, args=(second,)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive()
    return results, errors


def _bootstrap_process(
    database_path: str,
    barrier: Barrier,
    output: Queue,
) -> None:
    try:
        barrier.wait(timeout=10)
        connection = open_control_database(database_path)
        try:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        finally:
            connection.close()
    except BaseException as error:
        output.put(("error", type(error).__name__, str(error)))
    else:
        output.put(("ok", version, ""))


@pytest.mark.parametrize("attempt", range(12))
def test_two_connections_can_bootstrap_the_same_fresh_database(
    tmp_path: Path,
    attempt: int,
) -> None:
    database_path = tmp_path / f"fresh-bootstrap-{attempt}.sqlite"

    def worker() -> int:
        connection = open_control_database(database_path)
        try:
            return int(connection.execute("PRAGMA user_version").fetchone()[0])
        finally:
            connection.close()

    results, errors = _run_two_workers(worker, worker)

    assert errors == []
    assert results == [9, 9]
    verify = open_control_database(database_path)
    try:
        assert verify.execute("PRAGMA foreign_key_check").fetchall() == []
        assert verify.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        verify.close()


@pytest.mark.parametrize("attempt", range(12))
def test_two_processes_can_bootstrap_the_same_fresh_database(
    tmp_path: Path,
    attempt: int,
) -> None:
    if "spawn" not in multiprocessing.get_all_start_methods():
        pytest.skip("The independent-process bootstrap race requires spawn support.")
    context = multiprocessing.get_context("spawn")
    database_path = tmp_path / f"fresh-process-bootstrap-{attempt}.sqlite"
    barrier = context.Barrier(2)
    output = context.Queue()
    processes = [
        context.Process(
            target=_bootstrap_process,
            args=(str(database_path), barrier, output),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=15)
        assert not process.is_alive()
        assert process.exitcode == 0
    observed = [output.get(timeout=5) for _ in range(2)]
    output.close()
    output.join_thread()

    assert observed == [("ok", 9, ""), ("ok", 9, "")]
    verify = open_control_database(database_path)
    try:
        assert verify.execute("PRAGMA foreign_key_check").fetchall() == []
        assert verify.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        verify.close()


@pytest.mark.parametrize("attempt", range(3))
def test_same_hash_race_runs_handler_and_generators_once(tmp_path: Path, attempt: int) -> None:
    database_path = tmp_path / f"same-{attempt}.sqlite"
    bootstrap = open_control_database(database_path)
    bootstrap.close()
    command = IdempotencyCommand.preflight(
        key="race-key", canonical_request_bytes=_blocked_request_bytes()
    )
    response_bytes = _blocked_result_bytes(
        command=command,
        run_id="bt_race",
        preflight_id="pf_race",
    )
    handler_calls = 0
    handler_lock = threading.Lock()
    clocks = [CountingClock(1_000), CountingClock(2_000)]
    ids = [CountingIds("a"), CountingIds("b")]

    def worker(index: int) -> IdempotentResponse:
        connection = open_control_database(database_path)
        store = ControlStore(connection, clock=clocks[index], event_id_factory=ids[index])

        def handler(transaction: ControlTransaction) -> IdempotentResponse:
            nonlocal handler_calls
            with handler_lock:
                handler_calls += 1
            _persist_blocked(
                transaction,
                command=command,
                run_id="bt_race",
                preflight_id="pf_race",
                result_bytes=response_bytes,
            )
            return IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_race")

        try:
            return store.execute_idempotent(command=command, handler=handler)
        finally:
            store.close()

    results, errors = _run_two_workers(lambda: worker(0), lambda: worker(1))

    assert errors == []
    assert results == [
        IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_race"),
        IdempotentResponse(status_code=200, body=response_bytes, run_id="bt_race"),
    ]
    assert handler_calls == 1
    assert sum(clock.calls for clock in clocks) == 3
    assert sum(factory.calls for factory in ids) == 1
    verify = ControlStore(
        open_control_database(database_path),
        clock=CountingClock(9_000),
        event_id_factory=CountingIds("v"),
    )
    try:
        assert len(verify.events("bt_race")) == 1
        assert len(verify.pending_outbox("bt_race")) == 1
    finally:
        verify.close()


def test_different_hash_race_commits_one_command_and_conflicts_the_other(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "different.sqlite"
    bootstrap = open_control_database(database_path)
    bootstrap.close()
    handler_calls: list[str] = []
    call_lock = threading.Lock()

    def worker(label: str) -> IdempotentResponse:
        store = ControlStore(
            open_control_database(database_path),
            clock=CountingClock(1_000 if label == "a" else 2_000),
            event_id_factory=CountingIds(label),
        )

        command = IdempotencyCommand.preflight(
            key="same-key",
            canonical_request_bytes=_blocked_request_bytes(replay_seed=0 if label == "a" else 1),
        )
        body = _blocked_result_bytes(
            command=command,
            run_id=f"bt_{label}",
            preflight_id=f"pf_{label}",
        )

        def handler(transaction: ControlTransaction) -> IdempotentResponse:
            with call_lock:
                handler_calls.append(label)
            _persist_blocked(
                transaction,
                command=command,
                run_id=f"bt_{label}",
                preflight_id=f"pf_{label}",
                result_bytes=body,
            )
            return IdempotentResponse(status_code=200, body=body, run_id=f"bt_{label}")

        try:
            return store.execute_idempotent(
                command=command,
                handler=handler,
            )
        finally:
            store.close()

    results, errors = _run_two_workers(lambda: worker("a"), lambda: worker("b"))

    assert len(results) == 1
    assert len(errors) == 1
    assert isinstance(errors[0], IdempotencyConflict)
    assert str(errors[0]) == "IDEMPOTENCY_CONFLICT"
    assert len(handler_calls) == 1
    connection = open_control_database(database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM idempotency_records").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 1
    finally:
        connection.close()


def test_two_independent_connections_with_same_expected_version_have_one_cas_winner(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "cas.sqlite"
    setup = ControlStore(
        open_control_database(database_path),
        clock=CountingClock(100),
        event_id_factory=CountingIds("setup"),
    )
    setup.reserve_run(run_id="bt_cancel")
    setup.commit_transition(
        run_id="bt_cancel",
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=_control("preflight.passed"),
    )
    setup.commit_transition(
        run_id="bt_cancel",
        expected_version=1,
        target=RunState.QUEUED,
        candidate=_control("run.queued"),
    )
    setup.close()

    def worker(label: str) -> object:
        store = ControlStore(
            open_control_database(database_path),
            clock=CountingClock(1_000 if label == "a" else 2_000),
            event_id_factory=CountingIds(label),
        )
        try:
            return store.commit_transition(
                run_id="bt_cancel",
                expected_version=2,
                target=RunState.CANCEL_REQUESTED,
                candidate=_control("run.cancel_requested"),
            )
        finally:
            store.close()

    results, errors = _run_two_workers(lambda: worker("a"), lambda: worker("b"))

    assert len(results) == 1
    assert len(errors) == 1
    assert isinstance(errors[0], VersionConflict)
    verify = ControlStore(
        open_control_database(database_path),
        clock=CountingClock(9_000),
        event_id_factory=CountingIds("verify"),
    )
    try:
        assert verify.run("bt_cancel").state is RunState.CANCEL_REQUESTED
        assert verify.run("bt_cancel").state_version == 3
        assert [event.seq for event in verify.events("bt_cancel")] == [1, 2, 3]
    finally:
        verify.close()
