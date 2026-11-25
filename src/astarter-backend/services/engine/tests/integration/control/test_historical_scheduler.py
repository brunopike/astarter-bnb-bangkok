"""Historical work shares application ownership, cancellation and shutdown."""

import asyncio

import pytest

from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.dependencies import ApiCommandScheduler, current_engine_identity
from stark_trading_os.control.recovery import FinalizationRecovery
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.run_contract import RunContractMismatch
from stark_trading_os.control.supervisor import RunnerSupervisor
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_configuration_service import service_for
from tests.integration.control.test_historical_control import case as _case
from tests.integration.control.test_historical_control import control_for
from tests.integration.control.test_historical_control_commands import ready_command

case = _case


def scheduler_for(store, control, tmp_path, *, cancellation=None):
    cancellation = cancellation or CancellationCoordinator(control=store)
    legacy = RunnerSupervisor(
        control=store,
        runtime_root=tmp_path / "runtime",
        python_executable=control._supervisor._python_executable,
        runner_cwd=tmp_path / "runtime/service-cwd",
        cancellation=cancellation,
    )
    return ApiCommandScheduler(
        store=store,
        supervisor=legacy,
        cancellation=cancellation,
        recovery=FinalizationRecovery(store=store, runtime_root=tmp_path / "runtime"),
        engine_identity=current_engine_identity(),
        historical=control,
    )


async def drain(scheduler):
    await asyncio.gather(*tuple(scheduler._tasks.values()), return_exceptions=True)
    await asyncio.sleep(0)


def test_restart_queue_returns_before_native_completion_and_coalesces_replays(
    case, tmp_path, monkeypatch
):
    store, control, ready, command = ready_command(case, tmp_path)
    control.reserve(**command)  # Crash window: committed but not yet registered.
    reopened = ControlStore.open(tmp_path / "control.sqlite", clock=store._clock)
    restarted = control_for(reopened, service_for(reopened, tmp_path / "runtime"), tmp_path)
    scheduler = scheduler_for(reopened, restarted, tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    original = asyncio.create_subprocess_exec
    launches = 0

    async def delayed(*args, **kwargs):
        nonlocal launches
        launches += 1
        entered.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed)

    async def exercise():
        try:
            await scheduler.start()
            assert reopened.run(ready.run_id).state is RunState.QUEUED
            await asyncio.wait_for(entered.wait(), timeout=3)
            scheduler.schedule_historical_run(ready.run_id)
            scheduler.schedule_historical_run(ready.run_id)
            assert list(scheduler._tasks) == [("owner", ready.run_id)]
            assert reopened.historical_runner_outcome(ready.run_id) is None
            release.set()
            await drain(scheduler)
            assert reopened.run(ready.run_id).state is RunState.COMPLETED
            scheduler.schedule_historical_run(ready.run_id)
            await drain(scheduler)
            assert launches == 1
            assert len([e for e in reopened.events(ready.run_id) if e.type == "run.completed"]) == 1
            assert scheduler.command_unavailable_reason() is None
        finally:
            release.set()
            await scheduler.close()

    try:
        asyncio.run(exercise())
    finally:
        reopened.close()


@pytest.mark.parametrize("replay", [False, True])
def test_clean_cancel_owner_and_sidecar_finish_without_spawning(
    case, tmp_path, monkeypatch, replay
):
    store, control, ready, command = ready_command(case, tmp_path)
    control.reserve(**command)
    scheduler = scheduler_for(store, control, tmp_path)
    coordinator = scheduler._cancellation

    async def forbidden(*args, **kwargs):
        pytest.fail("clean cancellation spawned a child")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)

    async def exercise():
        scheduler.schedule_historical_run(ready.run_id)
        decision = coordinator.request(run_id=ready.run_id, idempotency_key="cancel", reason="user")
        if replay:
            decision = coordinator.request(
                run_id=ready.run_id, idempotency_key="cancel", reason="user"
            )
            assert not decision.created_by_caller
        scheduler.schedule_historical_cancel(decision)
        assert set(scheduler._tasks) == {("owner", ready.run_id), ("cancel", ready.run_id)}
        await scheduler.close()
        assert store.run(ready.run_id).state is RunState.CANCELLED
        assert store.runner_process(ready.run_id) is None
        assert len([e for e in store.events(ready.run_id) if e.type == "run.cancelled"]) == 1
        assert scheduler.unavailable_reason() is None

    asyncio.run(exercise())


@pytest.mark.parametrize("lost_dispatch", [False, True])
def test_signal_cancel_is_separate_and_shutdown_drains_both_tasks(
    case, tmp_path, monkeypatch, lost_dispatch
):
    store, control, ready, command = ready_command(case, tmp_path)
    control.reserve(**command)
    coordinator = CancellationCoordinator(control=store, term_grace_seconds=0.01)
    scheduler = scheduler_for(store, control, tmp_path, cancellation=coordinator)
    attached, sidecar, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_launch = asyncio.create_subprocess_exec
    original_attach = store.attach_runner_process
    original_terminate = coordinator.terminate
    original_recover = coordinator.recover
    processes = []
    terminations = 0

    async def launch(*args, **kwargs):
        process = await original_launch(*args[:5], "-c", "import time;time.sleep(10)", **kwargs)
        processes.append(process)
        return process

    def attach(**kwargs):
        result = original_attach(**kwargs)
        attached.set()
        return result

    async def terminate(decision):
        nonlocal terminations
        terminations += 1
        sidecar.set()
        await release.wait()
        return await original_terminate(decision)

    async def recover(process):
        nonlocal terminations
        terminations += 1
        sidecar.set()
        await release.wait()
        return await original_recover(process)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "attach_runner_process", attach)
    monkeypatch.setattr(coordinator, "terminate", terminate)
    monkeypatch.setattr(coordinator, "recover", recover)

    async def exercise():
        try:
            scheduler.schedule_historical_run(ready.run_id)
            await asyncio.wait_for(attached.wait(), timeout=3)
            decision = coordinator.request(
                run_id=ready.run_id, idempotency_key="cancel", reason="user"
            )
            assert decision.signal_required
            if not lost_dispatch:
                scheduler.schedule_historical_cancel(decision)
            scheduler.schedule_historical_cancel(
                coordinator.request(run_id=ready.run_id, idempotency_key="cancel", reason="user")
            )
            await asyncio.wait_for(sidecar.wait(), timeout=1)
            closing = asyncio.create_task(scheduler.close())
            await asyncio.sleep(0)
            assert not closing.done()
            assert scheduler.command_unavailable_reason() == "CONTROL_CLOSING"
            with pytest.raises(RuntimeError):
                scheduler.schedule_historical_run(ready.run_id)
            release.set()
            await asyncio.wait_for(closing, timeout=5)
            assert terminations == 1
            assert store.run(ready.run_id).state is RunState.FAILED
            outcome = store.historical_runner_outcome(ready.run_id).outcome
            assert outcome.classification == "SUPERVISOR_FAILURE"
            assert outcome.failure_code == "PROTOCOL_FAILED"
            assert outcome.final_cancel_phase in {"TERM_SENT", "KILL_SENT"}
            assert scheduler.unavailable_reason() is None
            assert all(process.returncode is not None for process in processes)
        finally:
            release.set()
            for process in processes:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            await scheduler.close()

    asyncio.run(exercise())


@pytest.mark.parametrize("explicit_operation", ["run", "cancel"])
def test_startup_missing_anchor_stays_pending_until_explicit_command(
    case, tmp_path, explicit_operation
):
    store, control, ready, command = ready_command(case, tmp_path)
    reservation = control.reserve(**command)
    asyncio.run(control._supervisor.run(reservation))
    before = tuple(store._connection.iterdump())
    scheduler = scheduler_for(store, control, tmp_path)

    async def exercise():
        await scheduler.start()
        await drain(scheduler)
        assert tuple(store._connection.iterdump()) == before
        assert store.run(ready.run_id).state is RunState.FINALIZING
        assert scheduler.command_unavailable_reason() is None
        if explicit_operation == "run":
            scheduler.schedule_historical_run(ready.run_id)
        else:
            scheduler.schedule_historical_cancel(
                scheduler._cancellation.request(
                    run_id=ready.run_id, idempotency_key="late-cancel", reason="user"
                )
            )
        await scheduler.close()
        # A late cancel cannot rewrite an already observed natural success.
        assert store.run(ready.run_id).state is RunState.COMPLETED
        assert scheduler.unavailable_reason() is None

    asyncio.run(exercise())


def test_explicit_retry_during_recovery_is_not_lost_by_owner_coalescing(
    case, tmp_path, monkeypatch
):
    store, control, ready, command = ready_command(case, tmp_path)
    asyncio.run(control._supervisor.run(control.reserve(**command)))
    scheduler = scheduler_for(store, control, tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    original = control.recover_one

    async def delayed(run_id):
        entered.set()
        await release.wait()
        return await original(run_id)

    monkeypatch.setattr(control, "recover_one", delayed)

    async def exercise():
        try:
            await scheduler.start()
            await asyncio.wait_for(entered.wait(), timeout=1)
            scheduler.schedule_historical_run(ready.run_id)
            assert len(scheduler._tasks) == 1
            release.set()
            await scheduler.close()
            assert store.run(ready.run_id).state is RunState.COMPLETED
        finally:
            release.set()
            await scheduler.close()

    asyncio.run(exercise())


def test_unknown_claim_is_bounded_and_keeps_capacity_without_global_failure(
    case, tmp_path, monkeypatch
):
    store, control, ready, command = ready_command(case, tmp_path)
    reservation = control.reserve(**command)
    control._supervisor._stage_input(reservation)
    store.claim_runner_process(run_id=ready.run_id, spawn_nonce="unbound-owner")
    before = tuple(store._connection.iterdump())
    scheduler = scheduler_for(store, control, tmp_path)
    original = control.recover_one
    calls = 0

    async def count(run_id):
        nonlocal calls
        calls += 1
        return await original(run_id)

    monkeypatch.setattr(control, "recover_one", count)

    async def exercise():
        await scheduler.start()
        await drain(scheduler)
        assert calls == 1 and not scheduler._tasks
        assert tuple(store._connection.iterdump()) == before
        assert scheduler.command_unavailable_reason() is None
        assert store.run(ready.run_id).state is RunState.QUEUED
        another = control.preflight(
            configuration_id=ready.configuration_id, idempotency_key="ready-next"
        )
        with pytest.raises(ValueError, match="HISTORICAL_CAPACITY_BUSY"):
            control.reserve(
                preflight_id=another.preflight_id,
                request_sha256=another.request_sha256,
                idempotency_key="run-next",
            )
        await scheduler.close()

    asyncio.run(exercise())


def test_unexpected_background_error_blocks_further_commands(case, tmp_path, monkeypatch):
    store, control, ready, command = ready_command(case, tmp_path)
    control.reserve(**command)
    scheduler = scheduler_for(store, control, tmp_path)

    async def broken(run_id):
        raise RuntimeError("simulated unexpected failure")

    monkeypatch.setattr(control, "run_reserved", broken)

    async def exercise():
        scheduler.schedule_historical_run(ready.run_id)
        await drain(scheduler)
        assert scheduler.command_unavailable_reason() == "BACKGROUND_RECOVERY_FAILED"
        with pytest.raises(RuntimeError):
            scheduler.schedule_historical_run(ready.run_id)
        assert not scheduler._tasks
        assert store.run(ready.run_id).state is RunState.QUEUED
        await scheduler.close()

    asyncio.run(exercise())


def test_dispatch_keeps_explicit_contract_guards(case, tmp_path):
    store, control, ready, command = ready_command(case, tmp_path)
    reservation = control.reserve(**command)
    scheduler = scheduler_for(store, control, tmp_path)
    before = tuple(store._connection.iterdump())

    async def exercise():
        with pytest.raises(RunContractMismatch):
            scheduler.schedule_run(reservation)
        with pytest.raises(RunContractMismatch):
            scheduler.reconcile_run(ready.run_id)
        assert not scheduler._tasks
        assert tuple(store._connection.iterdump()) == before
        await scheduler.close()

    asyncio.run(exercise())
