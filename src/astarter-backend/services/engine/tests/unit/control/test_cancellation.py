from __future__ import annotations

import asyncio
import signal
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    ProcessObservation,
    capture_process_identity,
)
from stark_trading_os.control.registry import ControlStore, EventCandidate, EventRejected
from stark_trading_os.domain.models import RunState


class StepClock:
    def __init__(self, value: int = 1_000) -> None:
        self.value = value
        self.calls = 0

    def __call__(self) -> int:
        self.calls += 1
        value = self.value
        self.value += 1
        return value


def _control(event_type: str) -> EventCandidate:
    return EventCandidate.control(type=event_type, ts_event_ns="10", payload={})


def _queued(store: ControlStore, run_id: str) -> None:
    store.reserve_run(run_id=run_id)
    store.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=_control("preflight.passed"),
    )
    store.commit_transition(
        run_id=run_id,
        expected_version=1,
        target=RunState.QUEUED,
        candidate=_control("run.queued"),
    )


def _observation(
    *,
    ppid: int = 41,
    start_token: str = "darwin:1700000000:123456",
) -> ProcessObservation:
    return ProcessObservation(
        platform="darwin",
        pid=501,
        ppid=ppid,
        pgid=501,
        sid=501,
        start_token=start_token,
        executable_path="/opt/stark/python3.12",
        executable_device=7,
        executable_inode=11,
    )


def _identity(run_id: str, spawn_nonce: str) -> ProcessIdentityV1:
    return capture_process_identity(
        run_id=run_id,
        spawn_nonce=spawn_nonce,
        pid=501,
        configured_executable=Path("/service/venv/bin/python"),
        observer=lambda _pid, _path: _observation(),
    )


def _attached_running(store: ControlStore, run_id: str) -> ProcessIdentityV1:
    _queued(store, run_id)
    claim = store.claim_runner_process(run_id=run_id, spawn_nonce=f"spawn-{run_id}")
    assert claim.created_by_caller
    identity = _identity(run_id, claim.spawn_nonce)
    attached = store.attach_runner_process(identity=identity)
    assert attached.identity == identity
    assert store.run(run_id).state is RunState.RUNNING
    return identity


def test_two_independent_stores_return_one_exact_claim_insert_winner(tmp_path: Path) -> None:
    database = tmp_path / "control.sqlite"
    setup = ControlStore.open(database)
    _queued(setup, "bt_claim")
    setup.close()
    barrier = threading.Barrier(2)

    def claim(nonce: str):
        store = ControlStore.open(database)
        try:
            barrier.wait(timeout=5)
            return store.claim_runner_process(run_id="bt_claim", spawn_nonce=nonce)
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        left = executor.submit(claim, "spawn-left")
        right = executor.submit(claim, "spawn-right")
        results = (left.result(timeout=10), right.result(timeout=10))

    assert sum(item.created_by_caller for item in results) == 1
    assert results[0].spawn_nonce == results[1].spawn_nonce
    assert {item.spawn_nonce for item in results} <= {"spawn-left", "spawn-right"}


def test_attach_transitions_queued_but_cancel_winner_stays_cancel_requested(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        _queued(store, "bt_started")
        claim = store.claim_runner_process(run_id="bt_started", spawn_nonce="spawn-started")
        store.attach_runner_process(identity=_identity("bt_started", claim.spawn_nonce))
        assert store.run("bt_started").state is RunState.RUNNING
        assert [event.type for event in store.events("bt_started")][-1] == "run.started"

        _queued(store, "bt_cancel_won")
        claim = store.claim_runner_process(run_id="bt_cancel_won", spawn_nonce="spawn-cancel-won")
        coordinator = CancellationCoordinator(control=store)
        decision = coordinator.request(
            run_id="bt_cancel_won", idempotency_key="cancel-1", reason="operator"
        )
        assert decision.state is RunState.CANCEL_REQUESTED
        store.attach_runner_process(identity=_identity("bt_cancel_won", claim.spawn_nonce))
        assert store.run("bt_cancel_won").state is RunState.CANCEL_REQUESTED
        assert "run.started" not in {event.type for event in store.events("bt_cancel_won")}
    finally:
        store.close()


def test_cancel_same_key_replays_exact_response_and_different_key_adds_no_edge(
    tmp_path: Path,
) -> None:
    clock = StepClock()
    store = ControlStore.open(tmp_path / "control.sqlite", clock=clock)
    try:
        _queued(store, "bt_replay")
        coordinator = CancellationCoordinator(control=store)

        first = coordinator.request(
            run_id="bt_replay", idempotency_key="cancel-same", reason="operator"
        )
        event_count = len(store.events("bt_replay"))
        calls_after_first = clock.calls
        replay = coordinator.request(
            run_id="bt_replay", idempotency_key="cancel-same", reason="operator"
        )
        assert replay.response == first.response
        assert not replay.created_by_caller
        assert len(store.events("bt_replay")) == event_count
        assert clock.calls == calls_after_first

        repeated = coordinator.request(
            run_id="bt_replay", idempotency_key="cancel-other", reason="operator"
        )
        assert repeated.created_by_caller
        assert repeated.state is RunState.CANCEL_REQUESTED
        assert not repeated.signal_required
        assert len(store.events("bt_replay")) == event_count
    finally:
        store.close()


@pytest.mark.parametrize(
    "state",
    [RunState.DRAFT, RunState.PREFLIGHT_READY, RunState.PREFLIGHT_BLOCKED],
)
def test_fresh_cancel_rejects_pre_run_states_without_persisting_success(
    tmp_path: Path,
    state: RunState,
) -> None:
    run_id = f"bt_cancel_{state.value.lower()}"
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        store.reserve_run(run_id=run_id)
        if state is not RunState.DRAFT:
            event_type = (
                "preflight.passed"
                if state is RunState.PREFLIGHT_READY
                else "preflight.blocked"
            )
            store.commit_transition(
                run_id=run_id,
                expected_version=0,
                target=state,
                candidate=_control(event_type),
            )
        event_count = len(store.events(run_id))
        coordinator = CancellationCoordinator(control=store)

        with pytest.raises(EventRejected, match="cancel|Cancel"):
            coordinator.request(
                run_id=run_id,
                idempotency_key="cancel-pre-run",
                reason="operator",
            )

        assert store.run(run_id).state is state
        assert len(store.events(run_id)) == event_count
        if state in {RunState.DRAFT, RunState.PREFLIGHT_READY}:
            if state is RunState.DRAFT:
                store.commit_transition(
                    run_id=run_id,
                    expected_version=0,
                    target=RunState.PREFLIGHT_READY,
                    candidate=_control("preflight.passed"),
                )
            ready = store.run(run_id)
            store.commit_transition(
                run_id=run_id,
                expected_version=ready.state_version,
                target=RunState.QUEUED,
                candidate=_control("run.queued"),
            )
            accepted = coordinator.request(
                run_id=run_id,
                idempotency_key="cancel-pre-run",
                reason="operator",
            )
            assert accepted.created_by_caller
            assert accepted.state is RunState.CANCEL_REQUESTED
    finally:
        store.close()


def test_queued_cancel_is_clean_only_without_any_process_claim(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        _queued(store, "bt_no_claim")
        coordinator = CancellationCoordinator(control=store)
        clean = coordinator.request(
            run_id="bt_no_claim", idempotency_key="cancel-clean", reason="operator"
        )
        assert clean.clean_no_claim

        _queued(store, "bt_unbound")
        store.claim_runner_process(run_id="bt_unbound", spawn_nonce="spawn-unbound")
        unbound = coordinator.request(
            run_id="bt_unbound", idempotency_key="cancel-unbound", reason="operator"
        )
        assert not unbound.clean_no_claim
        assert not unbound.signal_required
        assert store.runner_process("bt_unbound").pid is None
    finally:
        store.close()


def test_running_cancel_persists_one_term_then_one_kill_without_acknowledgment(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    signals: list[tuple[int, int]] = []

    async def no_wait(_seconds: float) -> None:
        return None

    try:
        identity = _attached_running(store, "bt_forced")
        coordinator = CancellationCoordinator(
            control=store,
            identity_observer=lambda _pid, _path: _observation(ppid=1),
            signal_sender=lambda pgid, number: signals.append((pgid, number)),
            group_is_live=lambda _identity: True,
            sleep=no_wait,
            term_grace_seconds=0.01,
        )
        decision = coordinator.request(
            run_id="bt_forced", idempotency_key="cancel-force", reason="operator"
        )
        asyncio.run(coordinator.terminate(decision))
        replay = coordinator.request(
            run_id="bt_forced", idempotency_key="cancel-force", reason="operator"
        )
        asyncio.run(coordinator.terminate(replay))

        assert signals == [(identity.pgid, signal.SIGTERM), (identity.pgid, signal.SIGKILL)]
        process = store.runner_process("bt_forced")
        assert process.cancel_phase == "KILL_SENT"
        assert store.run("bt_forced").state is RunState.CANCEL_REQUESTED
        assert "run.cancel_pending" not in {event.type for event in store.events("bt_forced")}
    finally:
        store.close()


def test_identity_mismatch_persists_term_phase_but_sends_no_signal(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    signals: list[tuple[int, int]] = []
    try:
        _attached_running(store, "bt_reused_pid")
        coordinator = CancellationCoordinator(
            control=store,
            identity_observer=lambda _pid, _path: _observation(
                start_token="darwin:1700000000:123457"
            ),
            signal_sender=lambda pgid, number: signals.append((pgid, number)),
        )
        decision = coordinator.request(
            run_id="bt_reused_pid", idempotency_key="cancel-reused", reason="operator"
        )
        asyncio.run(coordinator.terminate(decision))

        assert signals == []
        assert store.runner_process("bt_reused_pid").cancel_phase == "TERM_SENT"
    finally:
        store.close()


def test_post_leader_recovery_never_uses_stored_pgid_as_signal_authority(
    tmp_path: Path,
) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    signals: list[tuple[int, int]] = []
    observations = 0

    async def no_wait(_seconds: float) -> None:
        return None

    def observe(_pid: int, _path: Path) -> ProcessObservation:
        nonlocal observations
        observations += 1
        return _observation()

    try:
        _attached_running(store, "bt_post_leader")
        process = store.runner_process("bt_post_leader")
        assert process is not None
        coordinator = CancellationCoordinator(
            control=store,
            identity_observer=observe,
            signal_sender=lambda pgid, number: signals.append((pgid, number)),
            group_is_live=lambda _identity: True,
            sleep=no_wait,
            term_grace_seconds=0.01,
        )

        observation = asyncio.run(
            coordinator.recover_owned_group_after_leader_exit(process)
        )

        assert observations == 0
        assert signals == []
        assert not observation.identity_verified
        assert observation.term_delivery is None
        assert observation.kill_delivery is None
        assert not observation.group_dead
        assert store.runner_process("bt_post_leader").cancel_phase == "NONE"
    finally:
        store.close()


def test_term_grace_rejects_nan_as_non_finite(tmp_path: Path) -> None:
    store = ControlStore.open(tmp_path / "control.sqlite")
    try:
        with pytest.raises(ValueError, match="positive finite"):
            CancellationCoordinator(control=store, term_grace_seconds=float("nan"))
    finally:
        store.close()


def test_cancellation_coordinator_contract_is_available() -> None:
    assert CancellationCoordinator is not None
