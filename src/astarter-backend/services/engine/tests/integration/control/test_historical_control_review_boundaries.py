"""Whole-chain review regressions: retry, public isolation and lock-time authority."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.dependencies import (
    ApiCommandScheduler,
    current_engine_identity,
    get_dependencies,
)
from stark_trading_os.control.recovery import FinalizationRecovery
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.supervisor import RunnerSupervisor
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_control import case as _case
from tests.integration.control.test_historical_control import control_for

case = _case


@pytest.mark.parametrize("recover_first", [False, True])
def test_facade_retries_exit_promotion_crash_without_creating_anchor_in_recovery(
    case, tmp_path, monkeypatch, recover_first
):
    from stark_trading_os.control import supervisor as shared_owner

    store, configs, version = case
    control = control_for(store, configs, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    command = dict(
        preflight_id=ready.preflight_id, request_sha256=ready.request_sha256, idempotency_key="run"
    )

    async def launch_failure(*args, **kwargs):
        raise OSError("test launch failure")

    def crash(*args):
        raise RuntimeError("crash after outcome commit")

    with monkeypatch.context() as fault:
        fault.setattr(asyncio, "create_subprocess_exec", launch_failure)
        fault.setattr(shared_owner, "_promote_pending_exit", crash)
        with pytest.raises(RuntimeError, match="crash after outcome commit"):
            asyncio.run(control.execute(**command))
    outcome = store.historical_runner_outcome(ready.run_id)
    assert outcome is not None and store.run(ready.run_id).state is RunState.FINALIZING
    staging = tmp_path / "runtime/staging" / ready.run_id
    assert (staging / "runner-exit.pending").read_bytes() == outcome.outcome_bytes
    assert not (staging / "runner-exit.json").exists()
    before = tuple(store._connection.iterdump())

    async def forbidden(*args, **kwargs):
        pytest.fail("retry spawned a new child")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    if recover_first:
        recovered = asyncio.run(control.recover_one(ready.run_id))
        assert recovered.pending_reason == "EVIDENCE_NOT_ANCHORED"
        assert recovered.publication is None
        assert tuple(store._connection.iterdump()) == before
        assert (staging / "runner-exit.json").read_bytes() == outcome.outcome_bytes
    result = asyncio.run(control.execute(**command))
    assert result.state is RunState.FAILED and result.publication.validation == "NO_REPORT"
    assert store.historical_runner_outcome(ready.run_id) == outcome
    assert len([e for e in store.events(ready.run_id) if e.type == "run.failed"]) == 1
    assert asyncio.run(control.execute(**command)) == result


def test_public_v1_cancel_rejects_historical_before_any_write_or_scheduling(case, tmp_path):
    store, configs, version = case
    control = control_for(store, configs, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    control._preflights._consume_ready_for_control(ready.preflight_id, ready.request_sha256, "run")
    schedulers = []

    async def api_dependencies():
        # SQLite connections belong to the request thread, just as in the
        # real application's lifespan; the fixture's main-thread store observes.
        request_store = ControlStore.open(tmp_path / "control.sqlite", clock=store._clock)
        cancellation = CancellationCoordinator(control=request_store)
        scheduler = ApiCommandScheduler(
            store=request_store,
            supervisor=RunnerSupervisor(
                control=request_store,
                runtime_root=tmp_path / "runtime",
                python_executable=control._supervisor._python_executable,
                runner_cwd=tmp_path / "runtime/service-cwd",
            ),
            cancellation=cancellation,
            recovery=FinalizationRecovery(store=request_store, runtime_root=tmp_path / "runtime"),
            engine_identity=current_engine_identity(),
        )
        schedulers.append(scheduler)
        try:
            yield SimpleNamespace(
                store=request_store, cancellation=cancellation, scheduler=scheduler
            )
        finally:
            request_store.close()

    app = create_app(testing=True)
    app.dependency_overrides[get_dependencies] = api_dependencies
    before = tuple(store._connection.iterdump())
    with TestClient(app, base_url="http://127.0.0.1", raise_server_exceptions=False) as client:
        for key in ("cancel", "cancel", "cancel-new"):
            response = client.post(
                f"/v1/backtests/{ready.run_id}/cancel",
                headers={"Origin": "http://127.0.0.1:3000", "Idempotency-Key": key},
                json={"reason": "operator"},
            )
            assert response.status_code == 409
            assert response.json()["code"] == "RUN_CONTRACT_UNSUPPORTED"
            assert tuple(store._connection.iterdump()) == before
            assert all(not scheduler._tasks for scheduler in schedulers)
    assert store.run(ready.run_id).state is RunState.QUEUED


def test_stale_finalize_cannot_normalize_a_concurrently_published_root(case, tmp_path, monkeypatch):
    from stark_trading_os.control import historical_finalizer as finalization

    store, configs, version = case
    control = control_for(store, configs, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    reservation = control._preflights._consume_ready_for_control(
        ready.preflight_id, ready.request_sha256, "run"
    )
    decision = CancellationCoordinator(control=store).request(
        run_id=ready.run_id, idempotency_key="cancel", reason="operator"
    )
    control._supervisor.finalize_clean_cancel(decision)
    service = control._finalizer
    service.prepare(reservation.run_id)
    root = tmp_path / "runtime/runs" / ready.run_id
    original = finalization.locked_root
    other_publication = None
    published_database = None

    @contextmanager
    def interleaved(*args, **kwargs):
        nonlocal other_publication, published_database
        # Deterministic second caller completes after A's DB snapshot and before
        # A obtains its publication lock; all writes use the real finalizer.
        with monkeypatch.context() as second:
            second.setattr(finalization, "locked_root", original)
            other_publication = service.finalize(ready.run_id)
        published_database = tuple(store._connection.iterdump())
        root.chmod(0o700)
        with original(*args, **kwargs) as verify:
            yield verify

    monkeypatch.setattr(finalization, "locked_root", interleaved)
    with pytest.raises(ValueError, match="HISTORICAL_FINALIZATION_INVALID"):
        service.finalize(ready.run_id)
    assert other_publication.state is RunState.CANCELLED
    assert root.stat().st_mode & 0o7777 == 0o700
    assert tuple(store._connection.iterdump()) == published_database
    assert len([e for e in store.events(ready.run_id) if e.type == "run.cancelled"]) == 1
