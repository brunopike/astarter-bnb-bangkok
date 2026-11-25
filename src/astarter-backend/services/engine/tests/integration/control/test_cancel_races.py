from __future__ import annotations

import asyncio
import os
import signal
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from test_supervisor import (
    FakeProcess,
    fake_observation,
    make_supervisor,
    prepare_reservation,
    success_stdout,
)

from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.process_identity import (
    ProcessObservation,
    capture_process_identity,
)
from stark_trading_os.control.registry import ControlStore, EventRejected
from stark_trading_os.control.supervisor import (
    RunnerSupervisor,
    SupervisorError,
    stage_input_manifest,
)
from stark_trading_os.domain.models import RunState


def _attach(store: ControlStore, run_id: str, nonce: str = "spawn-race") -> None:
    claim = store.claim_runner_process(run_id=run_id, spawn_nonce=nonce)
    identity = capture_process_identity(
        run_id=run_id,
        spawn_nonce=claim.spawn_nonce,
        pid=501,
        configured_executable=Path(sys.executable),
        observer=lambda pid, _path: fake_observation(pid),
    )
    store.attach_runner_process(identity=identity)


def _recovery_supervisor(
    *,
    store: ControlStore,
    runtime: Path,
    service_cwd: Path,
    signals: list[tuple[int, int]],
    sleeps: list[float],
    start_token: str = "darwin:1700000000:123456",
    group_stays_live: bool = False,
) -> RunnerSupervisor:
    killed = False

    async def record_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    def send(pgid: int, number: int) -> None:
        nonlocal killed
        signals.append((pgid, number))
        if number == signal.SIGKILL:
            killed = True

    def observe(pid: int, _path: Path) -> ProcessObservation:
        observed = fake_observation(pid)
        return ProcessObservation(
            platform=observed.platform,
            pid=observed.pid,
            ppid=1,
            pgid=observed.pgid,
            sid=observed.sid,
            start_token=start_token,
            executable_path=observed.executable_path,
            executable_device=observed.executable_device,
            executable_inode=observed.executable_inode,
        )

    cancellation = CancellationCoordinator(
        control=store,
        identity_observer=observe,
        signal_sender=send,
        group_is_live=lambda _identity: group_stays_live or not killed,
        sleep=record_sleep,
        term_grace_seconds=0.25,
    )
    return RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        identity_observer=observe,
        cancellation=cancellation,
        run_timeout_seconds=5,
    )


def test_no_claim_queued_cancel_records_clean_exit_and_finalizing_only(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_clean_cancel"
    )
    coordinator = CancellationCoordinator(control=store)
    supervisor = make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd)
    try:
        decision = coordinator.request(
            run_id=reservation.run_id,
            idempotency_key="cancel-clean",
            reason="operator",
        )
        result = supervisor.finalize_clean_cancel(decision)

        assert decision.clean_no_claim
        assert result is not None and result.state is RunState.FINALIZING
        assert store.runner_process(reservation.run_id) is None
        assert result.outcome is not None
        assert result.outcome.outcome.classification == "NO_SPAWN_CANCELLED"
        assert result.outcome.outcome.proposed_terminal_state == "CANCELLED"
        staging = runtime / "staging" / reservation.run_id
        assert (staging / "stderr.txt").read_bytes() == b""
        assert (staging / "runner-exit.json").is_file()
        event_types = [event.type for event in store.events(reservation.run_id)]
        assert event_types[-2:] == ["run.cancel_requested", "run.finalizing"]
        assert not any("ack" in value or "pending" in value for value in event_types)

        event_count = len(event_types)
        replay = coordinator.request(
            run_id=reservation.run_id,
            idempotency_key="cancel-clean",
            reason="operator",
        )
        repeated = coordinator.request(
            run_id=reservation.run_id,
            idempotency_key="cancel-other",
            reason="operator",
        )
        assert supervisor.finalize_clean_cancel(replay) is None
        assert supervisor.finalize_clean_cancel(repeated) is None
        assert len(store.events(reservation.run_id)) == event_count
    finally:
        store.close()


def test_restart_recovers_clean_cancel_from_sqlite_truth_without_ephemeral_decision(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_clean_cancel_restart"
    )
    decision = CancellationCoordinator(control=store).request(
        run_id=reservation.run_id,
        idempotency_key="cancel-before-controller-crash",
        reason="operator",
    )
    assert decision.clean_no_claim
    database = runtime / "control.sqlite"
    store.close()

    restarted = ControlStore.open(database)
    supervisor = make_supervisor(
        store=restarted,
        runtime=runtime,
        service_cwd=service_cwd,
    )
    try:
        recovered = asyncio.run(supervisor.recover_all())
        assert len(recovered) == 1
        assert recovered[0].state is RunState.FINALIZING
        assert recovered[0].outcome is not None
        assert recovered[0].outcome.outcome.classification == "NO_SPAWN_CANCELLED"
        assert restarted.runner_process(reservation.run_id) is None
        assert restarted.recoverable_runner_processes() == ()
    finally:
        restarted.close()


def test_real_two_connection_cancel_vs_claim_has_one_fail_closed_result(
    tmp_path: Path,
) -> None:
    setup, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_cancel_claim_race"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    database = runtime / "control.sqlite"
    setup.close()
    barrier = threading.Barrier(2)

    def claim():
        store = ControlStore.open(database)
        try:
            barrier.wait(timeout=5)
            try:
                return store.claim_runner_process(
                    run_id=reservation.run_id,
                    spawn_nonce="spawn-race",
                )
            except EventRejected:
                return None
        finally:
            store.close()

    def cancel():
        store = ControlStore.open(database)
        try:
            barrier.wait(timeout=5)
            return CancellationCoordinator(control=store).request(
                run_id=reservation.run_id,
                idempotency_key="cancel-race",
                reason="operator",
            )
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        claimed_future = executor.submit(claim)
        cancelled_future = executor.submit(cancel)
        claim_result = claimed_future.result(timeout=10)
        cancel_result = cancelled_future.result(timeout=10)

    restarted = ControlStore.open(database)
    supervisor = make_supervisor(
        store=restarted,
        runtime=runtime,
        service_cwd=service_cwd,
    )
    try:
        if claim_result is None:
            assert cancel_result.clean_no_claim
            result = supervisor.finalize_clean_cancel(cancel_result)
            assert result is not None and result.state is RunState.FINALIZING
            assert result.outcome is not None
            assert result.outcome.outcome.classification == "NO_SPAWN_CANCELLED"
            assert restarted.run(reservation.run_id).state is RunState.FINALIZING
        else:
            assert claim_result.created_by_caller
            assert not cancel_result.clean_no_claim
            with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
                asyncio.run(supervisor.recover_one(reservation.run_id))
            assert restarted.runner_outcome(reservation.run_id) is None
            assert restarted.run(reservation.run_id).state is RunState.CANCEL_REQUESTED
    finally:
        restarted.close()


def test_launch_owner_records_unbound_failure_when_cancel_wins_after_claim(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_cancel_after_claim"
    )
    second = ControlStore.open(runtime / "control.sqlite")
    original_claim = store.claim_runner_process
    spawn_calls = 0

    def claim_then_cancel(*, run_id: str, spawn_nonce: str):
        claim = original_claim(run_id=run_id, spawn_nonce=spawn_nonce)
        decision = CancellationCoordinator(control=second).request(
            run_id=run_id,
            idempotency_key="cancel-after-claim",
            reason="operator",
        )
        assert not decision.clean_no_claim
        return claim

    async def forbidden_spawn(*_args: object, **_kwargs: object) -> FakeProcess:
        nonlocal spawn_calls
        spawn_calls += 1
        raise AssertionError("cancel won before spawn")

    monkeypatch.setattr(store, "claim_runner_process", claim_then_cancel)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden_spawn)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert spawn_calls == 0
        assert result.state is RunState.FINALIZING
        assert not result.spawned
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "UNBOUND_CLAIM"
    finally:
        second.close()
        store.close()


def test_launch_owner_delivers_cancel_that_wins_before_pid_attachment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_cancel_before_attach"
    )
    second = ControlStore.open(runtime / "control.sqlite")
    signals: list[tuple[int, int]] = []

    class PendingProcess:
        def __init__(self) -> None:
            self.pid = 501
            self.stdout = asyncio.StreamReader(limit=65_537)
            self.stderr = asyncio.StreamReader(limit=65_537)
            self.returncode: int | None = None
            self._released = asyncio.Event()

        async def wait(self) -> int:
            await self._released.wait()
            assert self.returncode is not None
            return self.returncode

        def terminate(self, number: int) -> None:
            self.returncode = -number
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            self._released.set()

    process: PendingProcess | None = None

    async def launch(*_args: object, **_kwargs: object) -> PendingProcess:
        nonlocal process
        process = PendingProcess()
        decision = CancellationCoordinator(control=second).request(
            run_id=reservation.run_id,
            idempotency_key="cancel-before-attach",
            reason="operator",
        )
        assert not decision.signal_required
        return process

    async def no_wait(_seconds: float) -> None:
        return None

    def send(pgid: int, number: int) -> None:
        assert process is not None
        signals.append((pgid, number))
        process.terminate(number)

    cancellation = CancellationCoordinator(
        control=store,
        identity_observer=lambda pid, _path: fake_observation(pid),
        signal_sender=send,
        group_is_live=lambda _identity: process is not None and process.returncode is None,
        sleep=no_wait,
        term_grace_seconds=0.01,
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        identity_observer=lambda pid, _path: fake_observation(pid),
        cancellation=cancellation,
        run_timeout_seconds=0.05,
    )
    try:
        result = asyncio.run(supervisor.run(reservation))
        assert signals == [(501, signal.SIGTERM)]
        assert store.runner_process(reservation.run_id).cancel_phase == "TERM_SENT"
        assert result.state is RunState.FINALIZING
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "PROTOCOL_FAILED"
        assert result.outcome.outcome.signal == signal.SIGTERM
    finally:
        second.close()
        store.close()


def test_restart_unbound_claim_never_spawns_adopts_or_signals(tmp_path: Path) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_unbound_restart"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    store.claim_runner_process(run_id=reservation.run_id, spawn_nonce="spawn-orphan")
    database = runtime / "control.sqlite"
    store.close()
    restarted = ControlStore.open(database)
    signals: list[tuple[int, int]] = []
    supervisor = _recovery_supervisor(
        store=restarted,
        runtime=runtime,
        service_cwd=service_cwd,
        signals=signals,
        sleeps=[],
    )

    async def exercise() -> None:
        child = await asyncio.create_subprocess_exec(
            str(Path(sys.executable).absolute()),
            "-s",
            "-P",
            "-c",
            "import time; time.sleep(60)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
            cwd=str(service_cwd),
        )
        try:
            with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
                await supervisor.recover_one(reservation.run_id)
            assert signals == []
            assert child.returncode is None
            assert restarted.runner_outcome(reservation.run_id) is None
            assert restarted.run(reservation.run_id).state is RunState.QUEUED
            process = restarted.runner_process(reservation.run_id)
            assert process is not None and process.identity is None
        finally:
            if child.returncode is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await child.wait()

    try:
        asyncio.run(exercise())
    finally:
        restarted.close()


@pytest.mark.parametrize("persisted_phase", ["TERM_SENT", "KILL_SENT"])
def test_restart_repairs_signal_crash_windows_without_repeating_term(
    tmp_path: Path,
    persisted_phase: str,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_crash_{persisted_phase.lower()}"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    _attach(store, reservation.run_id)
    decision = CancellationCoordinator(control=store).request(
        run_id=reservation.run_id,
        idempotency_key="cancel-crash",
        reason="operator",
    )
    assert decision.signal_required

    class ControllerCrash(RuntimeError):
        pass

    delivered_before_crash: list[tuple[int, int]] = []

    async def no_wait(_seconds: float) -> None:
        return None

    def crash_at_committed_phase(pgid: int, number: int) -> None:
        if (persisted_phase, number) in {
            ("TERM_SENT", signal.SIGTERM),
            ("KILL_SENT", signal.SIGKILL),
        }:
            raise ControllerCrash(persisted_phase)
        delivered_before_crash.append((pgid, number))

    crashing = CancellationCoordinator(
        control=store,
        identity_observer=lambda pid, _path: fake_observation(pid),
        signal_sender=crash_at_committed_phase,
        group_is_live=lambda _identity: True,
        sleep=no_wait,
        term_grace_seconds=0.01,
    )
    with pytest.raises(ControllerCrash, match=persisted_phase):
        asyncio.run(crashing.terminate(decision))
    assert store.runner_process(reservation.run_id).cancel_phase == persisted_phase
    assert delivered_before_crash == (
        [] if persisted_phase == "TERM_SENT" else [(501, signal.SIGTERM)]
    )
    database = runtime / "control.sqlite"
    store.close()

    restarted = ControlStore.open(database)
    signals: list[tuple[int, int]] = []
    sleeps: list[float] = []
    supervisor = _recovery_supervisor(
        store=restarted,
        runtime=runtime,
        service_cwd=service_cwd,
        signals=signals,
        sleeps=sleeps,
    )
    try:
        result = asyncio.run(supervisor.recover_one(reservation.run_id))
        assert result is not None and result.outcome is not None
        assert result.state is RunState.FINALIZING
        assert result.outcome.outcome.failure_code == "FORCED_TERMINATION"
        assert signals == [(501, signal.SIGKILL)]
        assert sleeps == ([0.25, 0.25] if persisted_phase == "TERM_SENT" else [0.25])
        assert restarted.runner_process(reservation.run_id).cancel_phase == "KILL_SENT"
    finally:
        restarted.close()


def test_restart_records_delivered_kill_when_second_group_check_confirms_dead(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_second_group_check_dead"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    _attach(store, reservation.run_id)
    signals: list[tuple[int, int]] = []
    group_liveness = iter((True, True, False))
    observed_liveness: list[bool] = []

    async def no_wait(_seconds: float) -> None:
        return None

    def group_is_live(_identity: object) -> bool:
        live = next(group_liveness)
        observed_liveness.append(live)
        return live

    cancellation = CancellationCoordinator(
        control=store,
        identity_observer=lambda pid, _path: fake_observation(pid),
        signal_sender=lambda pgid, number: signals.append((pgid, number)),
        group_is_live=group_is_live,
        sleep=no_wait,
        term_grace_seconds=0.01,
    )
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        identity_observer=lambda pid, _path: fake_observation(pid),
        cancellation=cancellation,
        run_timeout_seconds=5,
    )
    try:
        result = asyncio.run(supervisor.recover_one(reservation.run_id))

        assert observed_liveness == [True, True, False]
        assert signals == [(501, signal.SIGTERM), (501, signal.SIGKILL)]
        assert store.runner_process(reservation.run_id).cancel_phase == "KILL_SENT"
        assert result is not None and result.outcome is not None
        assert result.state is RunState.FINALIZING
        assert (
            result.outcome.outcome.failure_code,
            result.outcome.outcome.signal,
            result.outcome.outcome.final_cancel_phase,
        ) == ("FORCED_TERMINATION", signal.SIGKILL, "KILL_SENT")
    finally:
        store.close()


def test_restart_identity_mismatch_with_live_group_stays_unresolved(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_restart_reused_pid"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    _attach(store, reservation.run_id)
    CancellationCoordinator(control=store).request(
        run_id=reservation.run_id,
        idempotency_key="cancel-reused",
        reason="operator",
    )
    database = runtime / "control.sqlite"
    store.close()

    restarted = ControlStore.open(database)
    signals: list[tuple[int, int]] = []
    supervisor = _recovery_supervisor(
        store=restarted,
        runtime=runtime,
        service_cwd=service_cwd,
        signals=signals,
        sleeps=[],
        start_token="darwin:1700000000:123457",
    )
    try:
        with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
            asyncio.run(supervisor.recover_one(reservation.run_id))
        assert signals == []
        assert restarted.runner_outcome(reservation.run_id) is None
        assert restarted.run(reservation.run_id).state is RunState.CANCEL_REQUESTED
    finally:
        restarted.close()


def test_restart_does_not_record_forced_termination_while_group_remains_live(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_unresolved_process_group"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    _attach(store, reservation.run_id)
    signals: list[tuple[int, int]] = []
    supervisor = _recovery_supervisor(
        store=store,
        runtime=runtime,
        service_cwd=service_cwd,
        signals=signals,
        sleeps=[],
        group_stays_live=True,
    )
    try:
        with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
            asyncio.run(supervisor.recover_one(reservation.run_id))
        assert signals == [(501, signal.SIGTERM), (501, signal.SIGKILL)]
        assert store.runner_outcome(reservation.run_id) is None
        assert store.run(reservation.run_id).state is RunState.RUNNING
    finally:
        store.close()


def test_restart_classifies_post_verification_disappearance_as_non_delivery(
    tmp_path: Path,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_signal_process_gone"
    )
    stage_input_manifest(runtime_root=runtime, reservation=reservation)
    _attach(store, reservation.run_id)
    attempts: list[tuple[int, int]] = []

    async def no_wait(_seconds: float) -> None:
        return None

    def disappeared(pgid: int, number: int) -> None:
        attempts.append((pgid, number))
        raise ProcessLookupError

    cancellation = CancellationCoordinator(
        control=store,
        identity_observer=lambda pid, _path: fake_observation(pid),
        signal_sender=disappeared,
        group_is_live=lambda _identity: False,
        sleep=no_wait,
        term_grace_seconds=0.01,
    )
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        identity_observer=lambda pid, _path: fake_observation(pid),
        cancellation=cancellation,
        run_timeout_seconds=5,
    )
    try:
        result = asyncio.run(supervisor.recover_one(reservation.run_id))
        assert attempts == [(501, signal.SIGTERM)]
        assert result is not None and result.outcome is not None
        assert result.outcome.outcome.failure_code == "PROCESS_IDENTITY_LOST"
        assert result.state is RunState.FINALIZING
    finally:
        store.close()


def test_natural_outcome_winning_before_signal_remains_natural_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_cancel_natural"
    )
    second = ControlStore.open(runtime / "control.sqlite")
    revision = store.run(reservation.run_id).catalog_revision
    assert revision is not None
    signals: list[tuple[int, int]] = []

    class PausedProcess(FakeProcess):
        def __init__(self) -> None:
            super().__init__(stdout=success_stdout(reservation, revision))
            self.release = asyncio.Event()

        async def wait(self) -> int:
            await self.release.wait()
            return await super().wait()

    process: PausedProcess | None = None

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        assert process is not None
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    coordinator = CancellationCoordinator(
        control=second,
        identity_observer=lambda pid, _path: fake_observation(pid),
        signal_sender=lambda pgid, number: signals.append((pgid, number)),
    )

    async def race():
        nonlocal process
        process = PausedProcess()
        running = asyncio.create_task(
            make_supervisor(
                store=store,
                runtime=runtime,
                service_cwd=service_cwd,
            ).run(reservation)
        )
        for _ in range(100):
            if second.run(reservation.run_id).state is RunState.RUNNING:
                break
            await asyncio.sleep(0)
        assert second.run(reservation.run_id).state is RunState.RUNNING
        decision = coordinator.request(
            run_id=reservation.run_id,
            idempotency_key="cancel-natural",
            reason="operator",
        )
        process.release.set()
        result = await running
        await coordinator.terminate(decision)
        return result

    try:
        result = asyncio.run(race())
        assert result.outcome is not None
        assert result.outcome.outcome.classification == "NATURAL_SUCCESS"
        assert result.outcome.outcome.proposed_terminal_state == "COMPLETED"
        assert result.state is RunState.FINALIZING
        assert signals == []
    finally:
        second.close()
        store.close()


def test_cancel_race_contract_is_available() -> None:
    assert RunnerSupervisor is not None
