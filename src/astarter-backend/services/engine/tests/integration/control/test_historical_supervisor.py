"""Historical child uses shared process ownership and explicit v2 observations."""

import asyncio
import sys
from pathlib import Path

import pytest

from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.run_contract import RunContractMismatch
from stark_trading_os.control.supervisor import RunnerSupervisor, SupervisorError
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_preflight import prepared
from tests.integration.control.test_historical_preflight import setup as _native_setup

setup = _native_setup


def queued(setup, tmp_path):
    store, _, preflights = prepared(setup, tmp_path)
    receipt = preflights.preflight(configuration_id="cfg_" + "1" * 32, idempotency_key="ready")
    reservation = preflights._consume_ready_for_control(
        receipt.preflight_id, receipt.request_sha256, "create"
    )
    return store, preflights, reservation


def supervisor(store, tmp_path, **kwargs):
    from stark_trading_os.control.historical_supervisor import HistoricalRunnerSupervisor

    cwd = tmp_path / "runtime/service-cwd"
    cwd.mkdir(mode=0o700, exist_ok=True)
    kwargs.setdefault("clock", store._clock)
    return HistoricalRunnerSupervisor(
        control=store,
        runtime_root=tmp_path / "runtime",
        python_executable=Path(sys.executable).absolute(),
        runner_cwd=cwd,
        **kwargs,
    )


def test_real_historical_child_records_explicit_v2_and_recovers_without_respawn(setup, tmp_path):
    store, preflights, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    result = asyncio.run(owner.run(reservation))
    assert result.spawned and result.created_by_caller
    assert result.state is RunState.FINALIZING
    record = store.historical_runner_outcome(reservation.run_id)
    assert record == result.outcome
    assert record.outcome.schema_ == "SupervisorExit.v2"
    assert record.outcome.classification == "NATURAL_SUCCESS"
    assert record.outcome.identity.input_manifest_sha256 == reservation.input_manifest_hash
    assert record.outcome.child_outcome.identity == record.outcome.identity
    assert record.outcome.proposed_terminal_state == "COMPLETED"
    assert [event.type for event in store.events(reservation.run_id)] == [
        "preflight.passed",
        "run.queued",
        "run.started",
        "run.finalizing",
    ]
    assert all(event.source == "control-api" for event in store.events(reservation.run_id))
    with pytest.raises(RunContractMismatch):
        store.runner_outcome(reservation.run_id)
    recovered = asyncio.run(owner.recover_one(reservation.run_id))
    assert not recovered.spawned and recovered.outcome == record
    assert (
        preflights.record(
            next(iter(store._connection.execute("SELECT preflight_id FROM historical_preflights")))[
                0
            ]
        ).consumed_at_ns
        is not None
    )


def test_duplicate_historical_claim_never_launches_second_child(setup, tmp_path, monkeypatch):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    claim = store.claim_runner_process(run_id=reservation.run_id, spawn_nonce="first-claim")
    assert claim.created_by_caller

    async def forbidden(*args, **kwargs):
        pytest.fail("duplicate claim spawned a child")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    result = asyncio.run(owner.run(reservation))
    assert not result.spawned and not result.created_by_caller and result.outcome is None
    assert store.run(reservation.run_id).state is RunState.QUEUED


def test_unbound_historical_claim_recovery_keeps_exclusive_capacity(setup, tmp_path):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    store.claim_runner_process(run_id=reservation.run_id, spawn_nonce="crashed-before-binding")
    asyncio.run(owner.run(reservation))  # verifies/stages input but cannot own this claim
    before = tuple(store._connection.iterdump())
    with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
        asyncio.run(owner.recover_one(reservation.run_id))
    assert tuple(store._connection.iterdump()) == before
    assert store.run(reservation.run_id).state is RunState.QUEUED


def test_legacy_entry_rejects_historical_before_any_staging_or_claim(setup, tmp_path):
    store, _, reservation = queued(setup, tmp_path)
    supervisor(store, tmp_path)  # create private server cwd
    legacy = RunnerSupervisor(
        control=store,
        runtime_root=tmp_path / "runtime",
        python_executable=Path(sys.executable).absolute(),
        runner_cwd=tmp_path / "runtime/service-cwd",
    )
    before = tuple(store._connection.iterdump())
    with pytest.raises(RunContractMismatch):
        asyncio.run(legacy.run(reservation))
    assert tuple(store._connection.iterdump()) == before
    assert not (tmp_path / "runtime/staging" / reservation.run_id).exists()


def failed_wire(owner, run_id):
    from stark_trading_os.runner.historical_protocol import (
        RunnerOutcomeV2,
        RunnerStartedV2,
        encode_historical_protocol_line,
    )

    identity = owner._identity(run_id)
    started = encode_historical_protocol_line(
        RunnerStartedV2(schema="RunnerStarted.v2", identity=identity)
    )
    failed = encode_historical_protocol_line(
        RunnerOutcomeV2(
            schema="RunnerOutcome.v2",
            identity=identity,
            result="FAILED",
            artifacts=(),
            report_status=None,
            failure_code="EXECUTION_FAILED",
        )
    )
    return started, failed


@pytest.mark.parametrize(
    "scenario,expected",
    [
        ("natural_failure", "CHILD_REPORTED_FAILURE"),
        ("exit_mismatch", "UNKNOWN_EXIT"),
        ("bad_json", "PROTOCOL_FAILED"),
        ("duplicate_started", "PROTOCOL_FAILED"),
        ("partial_line", "PROTOCOL_FAILED"),
        ("large_line", "PROTOCOL_FAILED"),
        ("stderr_overflow", "STDERR_OVERFLOW"),
        ("timeout", "RUN_TIMEOUT"),
        ("launch_failure", "LAUNCH_FAILED"),
    ],
)
def test_owned_historical_failure_never_becomes_success(
    setup, tmp_path, monkeypatch, scenario, expected
):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path, run_timeout_seconds=0.15 if scenario == "timeout" else 5)
    started, failed = failed_wire(owner, reservation.run_id)
    stdout, stderr, exit_code, delay = started + failed, b"", 1, 0
    if scenario == "exit_mismatch":
        exit_code = 0
    elif scenario == "bad_json":
        stdout = b"not json\n"
    elif scenario == "duplicate_started":
        stdout = started + started + failed
    elif scenario == "partial_line":
        stdout = started + failed[:-1]
    elif scenario == "large_line":
        stdout = b"x" * 65537 + b"\n"
    elif scenario == "stderr_overflow":
        stderr = b"x" * (1024 * 1024 + 1)
    elif scenario == "timeout":
        stdout, delay = b"", 10
    # Trusted test-owned Python child; no shell, network or production process.
    script = (
        f"import os,time;os.write(1,{stdout!r});"
        f"os.write(2,b'x'*{len(stderr)});time.sleep({delay});os._exit({exit_code})"
    )
    original = asyncio.create_subprocess_exec

    async def launch(*args, **kwargs):
        assert args[1:5] == ("-s", "-P", "-B", "-u")
        assert args[6] == "stark_trading_os.runner.historical_main"
        assert args[-2:] == ("--expected-input-sha256", reservation.input_manifest_hash)
        assert kwargs["start_new_session"] is True and kwargs["close_fds"] is True
        assert "HOME" not in kwargs["env"] and "OPENAI_API_KEY" not in kwargs["env"]
        assert store.runner_process(reservation.run_id).pid is None
        if scenario == "launch_failure":
            raise OSError("test-owned launch failure")
        return await original(*args[:5], "-c", script, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    result = asyncio.run(owner.run(reservation))
    assert result.state is RunState.FINALIZING
    outcome = result.outcome.outcome
    assert outcome.failure_code == expected and outcome.proposed_terminal_state == "FAILED"
    assert outcome.classification == (
        "NATURAL_FAILURE" if scenario == "natural_failure" else "SUPERVISOR_FAILURE"
    )
    assert len([e for e in store.events(reservation.run_id) if e.type == "run.finalizing"]) == 1
    assert not any(e.source == "runner" for e in store.events(reservation.run_id))
    before = tuple(store._connection.iterdump())
    assert asyncio.run(owner.recover_one(reservation.run_id)).outcome == result.outcome
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize("restart", [False, True])
def test_clean_historical_cancel_uses_shared_cancel_truth_and_no_process(setup, tmp_path, restart):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    decision = CancellationCoordinator(control=store).request(
        run_id=reservation.run_id, idempotency_key="cancel", reason="operator"
    )
    assert decision.clean_no_claim
    result = (
        asyncio.run(owner.recover_one(reservation.run_id))
        if restart
        else owner.finalize_clean_cancel(decision)
    )
    assert result.state is RunState.FINALIZING and not result.spawned
    assert result.outcome.outcome.classification == "NO_SPAWN_CANCELLED"
    assert result.outcome.outcome.proposed_terminal_state == "CANCELLED"
    assert store.runner_process(reservation.run_id) is None
    before = tuple(store._connection.iterdump())
    replay = CancellationCoordinator(control=store).request(
        run_id=reservation.run_id, idempotency_key="cancel", reason="operator"
    )
    assert owner.finalize_clean_cancel(replay) is None
    assert tuple(store._connection.iterdump()) == before


def test_late_cancel_request_is_bound_once_without_rewriting_natural_result(
    setup, tmp_path, monkeypatch
):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    original = owner._store_outcome
    cancelled = False

    def late_cancel(outcome):
        nonlocal cancelled
        if not cancelled:
            cancelled = True
            CancellationCoordinator(control=store).request(
                run_id=reservation.run_id, idempotency_key="late", reason="operator"
            )
        return original(outcome)

    monkeypatch.setattr(owner, "_store_outcome", late_cancel)
    result = asyncio.run(owner.run(reservation))
    assert result.outcome.outcome.final_cancel_phase == "REQUESTED"
    assert result.outcome.outcome.classification == "NATURAL_SUCCESS"
    assert [event.type for event in store.events(reservation.run_id)][-2:] == [
        "run.cancel_requested",
        "run.finalizing",
    ]


def test_foreign_pending_exit_cannot_override_committed_observation(setup, tmp_path):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    result = asyncio.run(owner.run(reservation))
    pending = tmp_path / "runtime/staging" / reservation.run_id / "runner-exit.pending"
    pending.write_bytes(result.outcome.outcome_bytes.replace(b'"SIM-001"', b'"SIM-999"'))
    pending.chmod(0o600)
    before = tuple(store._connection.iterdump())
    with pytest.raises(SupervisorError):
        asyncio.run(owner.recover_one(reservation.run_id))
    assert tuple(store._connection.iterdump()) == before


def test_unresolved_pipe_holder_keeps_historical_run_active_without_signalling_guess(
    setup, tmp_path
):
    from stark_trading_os.control.process_identity import (
        UnresolvedProcessGroupV1,
        capture_process_identity,
        process_identity_digest,
        unresolved_process_group_bytes,
    )
    from tests.integration.control.test_supervisor import fake_observation

    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    store.claim_runner_process(run_id=reservation.run_id, spawn_nonce="unresolved")
    asyncio.run(owner.run(reservation))
    identity = capture_process_identity(
        run_id=reservation.run_id,
        spawn_nonce="unresolved",
        pid=501,
        configured_executable=Path(sys.executable),
        observer=lambda pid, _: fake_observation(pid),
    )
    store.attach_runner_process(identity=identity)
    path = tmp_path / "runtime/staging" / reservation.run_id / "runner-unresolved.json"
    path.write_bytes(
        unresolved_process_group_bytes(
            UnresolvedProcessGroupV1(
                run_id=reservation.run_id,
                spawn_nonce="unresolved",
                process_identity_sha256=process_identity_digest(identity),
            )
        )
    )
    path.chmod(0o600)
    before = tuple(store._connection.iterdump())
    assert asyncio.run(owner.recover_one(reservation.run_id)) is None
    assert tuple(store._connection.iterdump()) == before
    assert store.run(reservation.run_id).state is RunState.RUNNING
