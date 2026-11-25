from __future__ import annotations

import asyncio
import os
import signal
import sqlite3
import stat
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_supervisor import (
    FakeProcess,
    StepClock,
    fake_observation,
    make_supervisor,
    prepare_reservation,
    success_stdout,
)

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.process_identity import (
    SupervisorExitV1,
    process_identity_digest,
    supervisor_exit_bytes,
)
from stark_trading_os.control.registry import ControlStore, EventRejected
from stark_trading_os.control.supervisor import (
    MAX_STDERR_BYTES,
    MAX_STDOUT_BYTES,
    RunnerSupervisor,
    SupervisorError,
    sanitize_stderr,
)
from stark_trading_os.domain.models import InputManifestV1, RunState
from stark_trading_os.runner.protocol import (
    RunnerCandidateV1,
    RunnerOutcomeV1,
    encode_protocol_line,
    parse_protocol_line,
)


class _SignaledProcess:
    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"") -> None:
        self.pid = 501
        self.stdout = asyncio.StreamReader(limit=65_537)
        self.stdout.feed_data(stdout)
        self.stderr = asyncio.StreamReader(limit=65_537)
        self.stderr.feed_data(stderr)
        self.returncode: int | None = None
        self._released = asyncio.Event()

    async def wait(self) -> int:
        await self._released.wait()
        assert self.returncode is not None
        return self.returncode

    def finish(self, signal_number: int) -> None:
        if self.returncode is None:
            self.returncode = -signal_number
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            self._released.set()


def _catalog_revision(store, run_id: str) -> str:
    value = store.run(run_id).catalog_revision
    assert value is not None
    return value


def _drifted_outcome(reservation, catalog_revision: str) -> bytes:
    outcome = RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": reservation.run_id,
            "input_manifest_hash": "0" * 64,
            "catalog_revision": catalog_revision,
            "engine_package_version": "2.0.0rc3",
            "result": "FAILED",
            "last_source_seq": 0,
            "report_candidates": [],
            "failure": {
                "code": "PROTOCOL_FAILED",
                "message": "protocol failed",
            },
        }
    )
    return encode_protocol_line(outcome)


def _failed_stdout(reservation, catalog_revision: str) -> bytes:
    outcome = RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": reservation.run_id,
            "input_manifest_hash": reservation.input_manifest_hash,
            "catalog_revision": catalog_revision,
            "engine_package_version": "2.0.0rc3",
            "result": "FAILED",
            "last_source_seq": 0,
            "report_candidates": [],
            "failure": {
                "code": "PROTOCOL_FAILED",
                "message": "runner failed",
            },
        }
    )
    return encode_protocol_line(outcome)


def _capture_uncommitted_success_exit(
    *,
    store,
    reservation,
    runtime: Path,
    service_cwd: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[SupervisorExitV1, RunnerSupervisor]:
    revision = _catalog_revision(store, reservation.run_id)
    captured: list[SupervisorExitV1] = []
    record_outcome = store.record_runner_outcome

    class ControllerCrash(RuntimeError):
        pass

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=success_stdout(reservation, revision))

    def crash_after_files(outcome: SupervisorExitV1) -> None:
        captured.append(outcome)
        raise ControllerCrash("before outcome transaction")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "record_runner_outcome", crash_after_files)
    supervisor = make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd)
    with pytest.raises(ControllerCrash, match="outcome transaction"):
        asyncio.run(supervisor.run(reservation))
    monkeypatch.setattr(store, "record_runner_outcome", record_outcome)
    assert len(captured) == 1
    return captured[0], supervisor


def _accepted_candidate_line(reservation, catalog_revision: str, source_seq: int) -> bytes:
    manifest = InputManifestV1.model_validate_json(reservation.input_manifest_bytes)
    candidate = RunnerCandidateV1.model_validate(
        {
            "schema": "RunnerCandidate.v1",
            "run_id": reservation.run_id,
            "input_manifest_hash": reservation.input_manifest_hash,
            "catalog_revision": catalog_revision,
            "source_seq": source_seq,
            "ts_event_ns": str(1_700_000_000_000_000_000 + source_seq),
            "type": "order.accepted",
            "payload": {
                "client_order_id": f"client-{source_seq}",
                "instrument_id": manifest.instruments[0].instrument_id,
                "venue_order_id": f"venue-{source_seq}",
            },
        }
    )
    return encode_protocol_line(candidate)


async def _assert_unresolved_diagnostic_survives_recovery(
    *,
    store: ControlStore,
    reservation,
    runtime: Path,
    service_cwd: Path,
    tamper: str,
) -> None:
    process = store.runner_process(reservation.run_id)
    assert process is not None and process.identity is not None
    expected = {
        "schema_version": 1,
        "run_id": reservation.run_id,
        "spawn_nonce": process.spawn_nonce,
        "process_identity_sha256": process_identity_digest(process.identity),
        "reason": "PIPE_HOLDER_UNRESOLVED",
    }
    diagnostic = runtime / "staging" / reservation.run_id / "runner-unresolved.json"
    metadata = os.lstat(diagnostic)
    assert stat.S_ISREG(metadata.st_mode)
    assert stat.S_IMODE(metadata.st_mode) == 0o600
    assert metadata.st_uid == os.getuid()
    assert metadata.st_nlink == 1
    expected_bytes = canonical_json_bytes(expected)
    assert diagnostic.read_bytes() == expected_bytes

    restarted = ControlStore.open(runtime / "control.sqlite")
    signals: list[tuple[int, int]] = []
    observations = 0

    def forbidden_observation(_pid: int, _path: Path):
        nonlocal observations
        observations += 1
        raise AssertionError("a durable unresolved diagnostic must preempt identity recovery")

    cancellation = CancellationCoordinator(
        control=restarted,
        identity_observer=forbidden_observation,
        signal_sender=lambda pgid, number: signals.append((pgid, number)),
    )
    supervisor = RunnerSupervisor(
        control=restarted,
        runtime_root=runtime,
        python_executable=Path(sys.executable).resolve(),
        runner_cwd=service_cwd,
        identity_observer=forbidden_observation,
        cancellation=cancellation,
        run_timeout_seconds=5,
    )
    try:
        assert await supervisor.recover_one(reservation.run_id) is None
        assert await supervisor.recover_all() == ()
        assert observations == 0
        assert signals == []
        assert restarted.runner_outcome(reservation.run_id) is None
        assert restarted.run(reservation.run_id).state is RunState.RUNNING
        assert restarted.runner_process(reservation.run_id).cancel_phase == "NONE"

        attacks = ("binding", "hardlink") if tamper == "binding" else ("mode", "symlink")
        for index, attack in enumerate(attacks):
            if os.path.lexists(diagnostic):
                diagnostic.unlink()
            diagnostic.write_bytes(expected_bytes)
            diagnostic.chmod(0o600)
            extra_path: Path | None = None
            if attack == "binding":
                mismatched = dict(expected)
                mismatched["spawn_nonce"] = "different-spawn"
                diagnostic.write_bytes(canonical_json_bytes(mismatched))
            elif attack == "mode":
                diagnostic.chmod(0o640)
            elif attack == "hardlink":
                extra_path = runtime / "unresolved-hardlink"
                os.link(diagnostic, extra_path)
            else:
                assert attack == "symlink"
                extra_path = runtime / "unresolved-symlink-target"
                diagnostic.unlink()
                extra_path.write_bytes(expected_bytes)
                extra_path.chmod(0o600)
                diagnostic.symlink_to(extra_path)
            try:
                with pytest.raises(SupervisorError, match="STAGING_OUTPUT_INVALID"):
                    if index == 0:
                        await supervisor.recover_one(reservation.run_id)
                    else:
                        await supervisor.recover_all()
                assert observations == 0
                assert signals == []
                assert restarted.runner_outcome(reservation.run_id) is None
                assert restarted.run(reservation.run_id).state is RunState.RUNNING
                assert restarted.runner_process(reservation.run_id).cancel_phase == "NONE"
            finally:
                if extra_path is not None and extra_path.exists():
                    extra_path.unlink()
    finally:
        restarted.close()


async def _run_signaled_failure(
    *,
    store,
    reservation,
    runtime: Path,
    service_cwd: Path,
    stdout: bytes = b"",
    stderr: bytes = b"",
    run_timeout_seconds: float = 0.05,
):
    process = _SignaledProcess(stdout=stdout, stderr=stderr)
    signals: list[tuple[int, int]] = []

    async def launch(*_args: object, **_kwargs: object) -> _SignaledProcess:
        return process

    async def no_wait(_seconds: float) -> None:
        return None

    def send(pgid: int, number: int) -> None:
        signals.append((pgid, number))
        if number == signal.SIGKILL:
            process.finish(number)

    cancellation = CancellationCoordinator(
        control=store,
        identity_observer=lambda pid, _path: fake_observation(pid),
        signal_sender=send,
        group_is_live=lambda _identity: process.returncode is None,
        sleep=no_wait,
        term_grace_seconds=0.01,
    )
    original = asyncio.create_subprocess_exec
    asyncio.create_subprocess_exec = launch
    try:
        supervisor = RunnerSupervisor(
            control=store,
            runtime_root=runtime,
            python_executable=Path(sys.executable),
            runner_cwd=service_cwd,
            clock=StepClock(20_000),
            spawn_nonce_factory=lambda: "spawn-signaled",
            identity_observer=lambda pid, _path: fake_observation(pid),
            cancellation=cancellation,
            run_timeout_seconds=run_timeout_seconds,
        )
        result = await supervisor.run(reservation)
        return result, signals
    finally:
        asyncio.create_subprocess_exec = original


@pytest.mark.parametrize(
    "stdout",
    [
        b"",
        b"not-json\n",
        b"\xff\n",
        b'{"schema":"RunnerOutcome.v1"}',
        b"x" * 65_537 + b"\n",
    ],
    ids=["missing-outcome", "invalid-json", "non-utf8", "partial", "line-overflow"],
)
def test_protocol_failures_persist_one_failed_observation_and_finalizing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stdout: bytes,
) -> None:
    run_id = f"bt_protocol_{len(stdout)}"
    store, reservation, runtime, service_cwd = prepare_reservation(tmp_path, run_id=run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=stdout, returncode=0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert result.state is RunState.FINALIZING
        persisted = store.runner_outcome(run_id)
        assert persisted is not None
        assert persisted.outcome.classification == "SUPERVISOR_FAILURE"
        assert persisted.outcome.failure_code == "PROTOCOL_FAILED"
        assert persisted.outcome.child_outcome is None
        assert [event.type for event in store.events(run_id)][-1] == "run.finalizing"
    finally:
        store.close()


def test_extra_message_and_outcome_identity_drift_are_protocol_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for suffix, build_stdout in (
        (
            "extra",
            lambda reservation, revision: success_stdout(reservation, revision) * 2,
        ),
        ("drift", _drifted_outcome),
        (
            "duplicate",
            lambda reservation, revision: _accepted_candidate_line(reservation, revision, 1) * 2,
        ),
        (
            "cursor",
            lambda reservation, revision: _accepted_candidate_line(reservation, revision, 2),
        ),
    ):
        case_root = tmp_path / suffix
        case_root.mkdir()
        store, reservation, runtime, service_cwd = prepare_reservation(
            case_root, run_id=f"bt_{suffix}"
        )
        revision = _catalog_revision(store, reservation.run_id)

        async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
            return FakeProcess(stdout=build_stdout(reservation, revision))

        monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
        try:
            result = asyncio.run(
                make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(
                    reservation
                )
            )
            assert result.state is RunState.FINALIZING
            assert result.outcome is not None
            assert result.outcome.outcome.failure_code == "PROTOCOL_FAILED"
        finally:
            store.close()


@pytest.mark.parametrize("return_code", [0, -signal.SIGKILL, 2])
def test_failed_child_outcome_is_natural_only_with_exact_exit_code_one(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    return_code: int,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_failed_exit_{return_code}"
    )
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(
            stdout=_failed_stdout(reservation, revision),
            returncode=return_code,
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert result.outcome is not None
        assert result.outcome.outcome.classification == "SUPERVISOR_FAILURE"
        assert result.outcome.outcome.failure_code == "UNKNOWN_EXIT"
        assert result.outcome.outcome.proposed_terminal_state == "FAILED"
    finally:
        store.close()


def test_failed_child_outcome_with_exit_code_one_is_natural_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_failed_exit_one"
    )
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=_failed_stdout(reservation, revision), returncode=1)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert result.outcome is not None
        assert result.outcome.outcome.classification == "NATURAL_FAILURE"
        assert result.outcome.outcome.failure_code == "CHILD_REPORTED_FAILURE"
    finally:
        store.close()


@pytest.mark.parametrize(
    "drift",
    [
        "launched_at",
        "cancel_phase",
        "child_run",
        "child_manifest",
        "child_catalog",
        "child_cursor",
    ],
)
def test_outcome_transaction_rejects_stale_process_or_child_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    drift: str,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_outcome_drift_{drift}"
    )
    try:
        captured, _supervisor = _capture_uncommitted_success_exit(
            store=store,
            reservation=reservation,
            runtime=runtime,
            service_cwd=service_cwd,
            monkeypatch=monkeypatch,
        )
        values = captured.model_dump(mode="json")
        child = values["child_outcome"]
        assert isinstance(child, dict)
        if drift == "launched_at":
            launched_at_ns = values["launched_at_ns"]
            assert isinstance(launched_at_ns, int)
            ended_at_ns = values["ended_at_ns"]
            assert isinstance(ended_at_ns, int)
            values["launched_at_ns"] = launched_at_ns + 1
            values["duration_ns"] = ended_at_ns - (launched_at_ns + 1)
        elif drift == "cancel_phase":
            values["final_cancel_phase"] = "REQUESTED"
        elif drift == "child_run":
            child["run_id"] = "bt_other_run"
        elif drift == "child_manifest":
            child["input_manifest_hash"] = "0" * 64
        elif drift == "child_catalog":
            child["catalog_revision"] = "0" * 64
        else:
            child["last_source_seq"] = 1
        changed = SupervisorExitV1.model_validate(values)

        with pytest.raises(EventRejected):
            store.record_runner_outcome(changed)

        assert store.runner_outcome(reservation.run_id) is None
        assert store.run(reservation.run_id).state is RunState.RUNNING
    finally:
        store.close()


def test_outcome_transaction_rejects_noncontiguous_runner_event_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_outcome_event_gap"
    )
    try:
        captured, supervisor = _capture_uncommitted_success_exit(
            store=store,
            reservation=reservation,
            runtime=runtime,
            service_cwd=service_cwd,
            monkeypatch=monkeypatch,
        )
        revision = _catalog_revision(store, reservation.run_id)
        message = parse_protocol_line(_accepted_candidate_line(reservation, revision, 2))
        assert isinstance(message, RunnerCandidateV1)
        supervisor._append_candidate(reservation.run_id, message)
        values = captured.model_dump(mode="json")
        child = values["child_outcome"]
        assert isinstance(child, dict)
        child["last_source_seq"] = 2
        changed = SupervisorExitV1.model_validate(values)

        with pytest.raises(EventRejected):
            store.record_runner_outcome(changed)

        assert store.runner_outcome(reservation.run_id) is None
        assert store.run(reservation.run_id).state is RunState.RUNNING
    finally:
        store.close()


@pytest.mark.parametrize("persisted_phase", ["TERM_SENT", "KILL_SENT"])
def test_outcome_transaction_rejects_natural_exit_after_signal_phase(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    persisted_phase: str,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_outcome_after_{persisted_phase.lower()}"
    )
    try:
        captured, _supervisor = _capture_uncommitted_success_exit(
            store=store,
            reservation=reservation,
            runtime=runtime,
            service_cwd=service_cwd,
            monkeypatch=monkeypatch,
        )
        CancellationCoordinator(control=store).request(
            run_id=reservation.run_id,
            idempotency_key=f"cancel-{persisted_phase.lower()}",
            reason="operator",
        )
        process = store.runner_process(reservation.run_id)
        assert process is not None
        assert store.mark_runner_term_sent(
            run_id=reservation.run_id,
            spawn_nonce=process.spawn_nonce,
        )
        if persisted_phase == "KILL_SENT":
            assert store.mark_runner_kill_sent(
                run_id=reservation.run_id,
                spawn_nonce=process.spawn_nonce,
            )
        values = captured.model_dump(mode="json")
        values["final_cancel_phase"] = persisted_phase
        changed = SupervisorExitV1.model_validate(values)

        with pytest.raises(EventRejected):
            store.record_runner_outcome(changed)

        assert store.runner_outcome(reservation.run_id) is None
        assert store.run(reservation.run_id).state is RunState.CANCEL_REQUESTED
    finally:
        store.close()


def test_phase_advance_after_exit_fsync_rebuilds_before_final_name_is_published(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_exit_phase_handoff"
    )
    phase_store = type(store).open(runtime / "control.sqlite")
    revision = _catalog_revision(store, reservation.run_id)
    original_record = store.record_runner_outcome
    artifact_states: list[tuple[bool, bool]] = []
    candidates: list[SupervisorExitV1] = []

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=success_stdout(reservation, revision))

    def advance_phase_then_record(outcome: SupervisorExitV1):
        staging = runtime / "staging" / reservation.run_id
        artifact_states.append(
            (
                (staging / "runner-exit.pending").is_file(),
                (staging / "runner-exit.json").exists(),
            )
        )
        candidates.append(outcome)
        if len(candidates) == 1:
            decision = CancellationCoordinator(control=phase_store).request(
                run_id=reservation.run_id,
                idempotency_key="cancel-during-exit-handoff",
                reason="operator",
            )
            assert decision.created_by_caller
            process = phase_store.runner_process(reservation.run_id)
            assert process is not None
            assert phase_store.mark_runner_term_sent(
                run_id=reservation.run_id,
                spawn_nonce=process.spawn_nonce,
            )
        return original_record(outcome)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "record_runner_outcome", advance_phase_then_record)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )

        assert artifact_states == [(True, False), (True, False)]
        assert [candidate.final_cancel_phase for candidate in candidates] == [
            "NONE",
            "TERM_SENT",
        ]
        assert result.state is RunState.FINALIZING
        assert result.outcome is not None
        assert result.outcome.outcome.classification == "SUPERVISOR_FAILURE"
        assert result.outcome.outcome.failure_code == "UNKNOWN_EXIT"
        assert result.outcome.outcome.final_cancel_phase == "TERM_SENT"
        staging = runtime / "staging" / reservation.run_id
        assert not (staging / "runner-exit.pending").exists()
        assert (staging / "runner-exit.json").read_bytes() == result.outcome.outcome_bytes
    finally:
        phase_store.close()
        store.close()


@pytest.mark.parametrize(
    ("child_result", "return_code", "expected_classification", "expected_failure"),
    [
        ("SUCCEEDED", 0, "NATURAL_SUCCESS", None),
        ("FAILED", 1, "NATURAL_FAILURE", "CHILD_REPORTED_FAILURE"),
    ],
)
def test_request_only_after_exit_fsync_preserves_natural_outcome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    child_result: str,
    return_code: int,
    expected_classification: str,
    expected_failure: str | None,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_requested_handoff_{child_result.lower()}"
    )
    phase_store = ControlStore.open(runtime / "control.sqlite")
    revision = _catalog_revision(store, reservation.run_id)
    original_record = store.record_runner_outcome
    candidates: list[SupervisorExitV1] = []

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        stdout = (
            success_stdout(reservation, revision)
            if child_result == "SUCCEEDED"
            else _failed_stdout(reservation, revision)
        )
        return FakeProcess(stdout=stdout, returncode=return_code)

    def request_then_record(outcome: SupervisorExitV1):
        candidates.append(outcome)
        if len(candidates) == 1:
            staging = runtime / "staging" / reservation.run_id
            assert (staging / "runner-exit.pending").is_file()
            assert not (staging / "runner-exit.json").exists()
            decision = CancellationCoordinator(control=phase_store).request(
                run_id=reservation.run_id,
                idempotency_key=f"request-only-{child_result.lower()}",
                reason="operator",
            )
            assert decision.created_by_caller
            assert phase_store.runner_process(reservation.run_id).cancel_phase == "REQUESTED"
        return original_record(outcome)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "record_runner_outcome", request_then_record)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )

        assert [candidate.final_cancel_phase for candidate in candidates] == [
            "NONE",
            "REQUESTED",
        ]
        assert [candidate.classification for candidate in candidates] == [
            expected_classification,
            expected_classification,
        ]
        assert result.state is RunState.FINALIZING
        assert result.outcome is not None
        assert result.outcome.outcome.classification == expected_classification
        assert result.outcome.outcome.failure_code == expected_failure
        assert result.outcome.outcome.final_cancel_phase == "REQUESTED"
    finally:
        phase_store.close()
        store.close()


@pytest.mark.parametrize(
    ("child_result", "return_code", "expected_classification", "expected_failure"),
    [
        ("SUCCEEDED", 0, "NATURAL_SUCCESS", None),
        ("FAILED", 1, "NATURAL_FAILURE", "CHILD_REPORTED_FAILURE"),
    ],
)
def test_request_only_after_pending_crash_preserves_natural_outcome_on_recovery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    child_result: str,
    return_code: int,
    expected_classification: str,
    expected_failure: str | None,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_requested_pending_{child_result.lower()}"
    )
    phase_store = ControlStore.open(runtime / "control.sqlite")
    revision = _catalog_revision(store, reservation.run_id)

    class ControllerCrash(RuntimeError):
        pass

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        stdout = (
            success_stdout(reservation, revision)
            if child_result == "SUCCEEDED"
            else _failed_stdout(reservation, revision)
        )
        return FakeProcess(stdout=stdout, returncode=return_code)

    def crash_after_pending(_outcome: SupervisorExitV1):
        raise ControllerCrash("after pending fsync")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "record_runner_outcome", crash_after_pending)
    try:
        with pytest.raises(ControllerCrash, match="pending fsync"):
            asyncio.run(
                make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(
                    reservation
                )
            )
        staging = runtime / "staging" / reservation.run_id
        pending = supervisor_exit_bytes(
            SupervisorExitV1.model_validate_json((staging / "runner-exit.pending").read_bytes())
        )
        assert pending == (staging / "runner-exit.pending").read_bytes()
        decision = CancellationCoordinator(control=phase_store).request(
            run_id=reservation.run_id,
            idempotency_key=f"request-after-crash-{child_result.lower()}",
            reason="operator",
        )
        assert decision.created_by_caller
        assert phase_store.runner_process(reservation.run_id).cancel_phase == "REQUESTED"

        recovered = asyncio.run(
            make_supervisor(
                store=phase_store,
                runtime=runtime,
                service_cwd=service_cwd,
            ).recover_one(reservation.run_id)
        )

        assert recovered is not None and recovered.outcome is not None
        assert recovered.state is RunState.FINALIZING
        assert recovered.outcome.outcome.classification == expected_classification
        assert recovered.outcome.outcome.failure_code == expected_failure
        assert recovered.outcome.outcome.final_cancel_phase == "REQUESTED"
        assert not (staging / "runner-exit.pending").exists()
        assert (staging / "runner-exit.json").read_bytes() == recovered.outcome.outcome_bytes
    finally:
        phase_store.close()
        store.close()


def test_crash_before_outcome_transaction_reuses_exact_pending_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_exit_pending_retry"
    )
    try:
        captured, supervisor = _capture_uncommitted_success_exit(
            store=store,
            reservation=reservation,
            runtime=runtime,
            service_cwd=service_cwd,
            monkeypatch=monkeypatch,
        )
        staging = runtime / "staging" / reservation.run_id
        expected = supervisor_exit_bytes(captured)
        assert (staging / "runner-exit.pending").read_bytes() == expected
        assert not (staging / "runner-exit.json").exists()
        assert store.runner_outcome(reservation.run_id) is None

        recovered = asyncio.run(supervisor.recover_one(reservation.run_id))

        assert recovered is not None
        assert recovered.state is RunState.FINALIZING
        assert recovered.outcome is not None
        assert recovered.outcome.outcome_bytes == expected
        assert not (staging / "runner-exit.pending").exists()
        assert (staging / "runner-exit.json").read_bytes() == expected
    finally:
        store.close()


def test_crash_after_outcome_commit_promotes_pending_from_sqlite_truth(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_exit_committed_pending"
    )
    revision = _catalog_revision(store, reservation.run_id)
    original_record = store.record_runner_outcome

    class ControllerCrash(RuntimeError):
        pass

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=success_stdout(reservation, revision))

    def crash_after_commit(outcome: SupervisorExitV1):
        original_record(outcome)
        raise ControllerCrash("after outcome commit")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "record_runner_outcome", crash_after_commit)
    supervisor = make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd)
    try:
        with pytest.raises(ControllerCrash, match="after outcome commit"):
            asyncio.run(supervisor.run(reservation))
        staging = runtime / "staging" / reservation.run_id
        stored = store.runner_outcome(reservation.run_id)
        assert stored is not None
        assert (staging / "runner-exit.pending").read_bytes() == stored.outcome_bytes
        assert not (staging / "runner-exit.json").exists()

        monkeypatch.setattr(store, "record_runner_outcome", original_record)
        recovered = asyncio.run(supervisor.recover_one(reservation.run_id))

        assert recovered is not None and recovered.outcome == stored
        assert not (staging / "runner-exit.pending").exists()
        assert (staging / "runner-exit.json").read_bytes() == stored.outcome_bytes
    finally:
        store.close()


@pytest.mark.parametrize(
    ("failure_code", "stdout", "stderr", "timeout"),
    [
        ("PROTOCOL_FAILED", b"not-json\n", b"", 0.2),
        ("STDERR_OVERFLOW", b"", b"e" * (1024 * 1024 + 1), 0.2),
        ("RUN_TIMEOUT", b"", b"", 0.01),
    ],
    ids=["protocol-while-live", "stderr-overflow-while-live", "run-timeout"],
)
def test_live_failures_persist_phase_then_bounded_term_and_kill(
    tmp_path: Path,
    failure_code: str,
    stdout: bytes,
    stderr: bytes,
    timeout: float,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_live_{failure_code.lower()}"
    )
    try:
        result, signals = asyncio.run(
            _run_signaled_failure(
                store=store,
                reservation=reservation,
                runtime=runtime,
                service_cwd=service_cwd,
                stdout=stdout,
                stderr=stderr,
                run_timeout_seconds=timeout,
            )
        )
        assert signals == [(501, signal.SIGTERM), (501, signal.SIGKILL)]
        assert store.runner_process(reservation.run_id).cancel_phase == "KILL_SENT"
        assert result.state is RunState.FINALIZING
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == failure_code
        assert result.outcome.outcome.signal == signal.SIGKILL
    finally:
        store.close()


def test_same_group_descendant_held_pipes_return_bounded_without_blind_signal_or_outcome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_descendant_held_pipes"
    )
    marker = tmp_path / "descendant.pid"
    processes: list[asyncio.subprocess.Process] = []
    signals: list[tuple[int, int]] = []
    original_launch = asyncio.create_subprocess_exec
    script = (
        "import os,signal,subprocess,sys,time\n"
        "child=subprocess.Popen([sys.executable,'-c',"
        "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "time.sleep(30)'])\n"
        "with open(sys.argv[1],'w',encoding='ascii') as stream: "
        "stream.write(str(child.pid))\n"
        "time.sleep(0.25)\n"
        "os._exit(0)\n"
    )

    async def launch(*_args: object, **kwargs: object):
        process = await original_launch(
            str(Path(sys.executable).resolve()),
            "-s",
            "-P",
            "-B",
            "-u",
            "-c",
            script,
            str(marker),
            **kwargs,
        )
        processes.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    cancellation = CancellationCoordinator(
        control=store,
        signal_sender=lambda pgid, number: signals.append((pgid, number)),
        term_grace_seconds=0.05,
    )
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable).resolve(),
        runner_cwd=service_cwd,
        spawn_nonce_factory=lambda: "spawn-descendant",
        cancellation=cancellation,
        run_timeout_seconds=5,
    )

    async def exercise() -> None:
        started = time.monotonic()
        try:
            with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
                await supervisor.run(reservation)
            elapsed = time.monotonic() - started
            assert elapsed < 3
            assert signals == []
            assert store.run(reservation.run_id).state is RunState.RUNNING
            assert store.runner_outcome(reservation.run_id) is None
            assert store.runner_process(reservation.run_id).cancel_phase == "NONE"
            assert processes
            for stream in (processes[0].stdout, processes[0].stderr):
                assert stream is not None
                transport = getattr(stream, "_transport", None)
                assert transport is not None and transport.is_closing()
            await _assert_unresolved_diagnostic_survives_recovery(
                store=store,
                reservation=reservation,
                runtime=runtime,
                service_cwd=service_cwd,
                tamper="binding",
            )
        finally:
            if marker.exists():
                descendant_pid = int(marker.read_text(encoding="ascii"))
                try:
                    os.kill(descendant_pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    pass
            if processes:
                try:
                    os.killpg(processes[0].pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    pass
                if processes[0].returncode is None:
                    try:
                        await asyncio.wait_for(processes[0].wait(), timeout=1)
                    except TimeoutError:
                        pass
            await asyncio.sleep(0.05)

    try:
        asyncio.run(exercise())
    finally:
        store.close()


def test_detached_descendant_held_pipes_return_bounded_without_finalizing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_detached_pipe_holder"
    )
    marker = tmp_path / "detached-descendant.pid"
    processes: list[asyncio.subprocess.Process] = []
    signals: list[tuple[int, int]] = []
    original_launch = asyncio.create_subprocess_exec
    script = (
        "import os,subprocess,sys\n"
        "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],"
        "start_new_session=True)\n"
        "with open(sys.argv[1],'w',encoding='ascii') as stream: "
        "stream.write(str(child.pid))\n"
        "os._exit(0)\n"
    )

    async def launch(*_args: object, **kwargs: object):
        process = await original_launch(
            str(Path(sys.executable).resolve()),
            "-s",
            "-P",
            "-B",
            "-u",
            "-c",
            script,
            str(marker),
            **kwargs,
        )
        processes.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable).resolve(),
        runner_cwd=service_cwd,
        spawn_nonce_factory=lambda: "spawn-detached-descendant",
        cancellation=CancellationCoordinator(
            control=store,
            signal_sender=lambda pgid, number: signals.append((pgid, number)),
            term_grace_seconds=0.05,
        ),
        run_timeout_seconds=5,
    )

    async def exercise() -> None:
        started = time.monotonic()
        try:
            with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
                await supervisor.run(reservation)
            elapsed = time.monotonic() - started
            assert elapsed < 3
            assert signals == []
            assert store.run(reservation.run_id).state is RunState.RUNNING
            assert store.runner_outcome(reservation.run_id) is None
            assert store.runner_process(reservation.run_id).cancel_phase == "NONE"
            assert processes
            for stream in (processes[0].stdout, processes[0].stderr):
                assert stream is not None
                transport = getattr(stream, "_transport", None)
                assert transport is not None and transport.is_closing()
            await _assert_unresolved_diagnostic_survives_recovery(
                store=store,
                reservation=reservation,
                runtime=runtime,
                service_cwd=service_cwd,
                tamper="mode",
            )
        finally:
            if marker.exists():
                descendant_pid = int(marker.read_text(encoding="ascii"))
                try:
                    os.kill(descendant_pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    pass
            if processes and processes[0].returncode is None:
                try:
                    await asyncio.wait_for(processes[0].wait(), timeout=1)
                except TimeoutError:
                    pass
            await asyncio.sleep(0.05)

    try:
        asyncio.run(exercise())
    finally:
        store.close()


def test_identity_mismatch_after_launch_never_signals_a_reused_descendant_group(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_descendant_identity_mismatch"
    )
    signals: list[tuple[int, int]] = []
    observations = 0

    class ExitedLeaderWithHeldPipes:
        def __init__(self) -> None:
            self.pid = 501
            self.stdout = asyncio.StreamReader(limit=65_537)
            self.stdout.feed_data(b"not-json\n")
            self.stderr = asyncio.StreamReader(limit=65_537)
            self.returncode: int | None = None

        async def wait(self) -> int:
            await asyncio.sleep(0.01)
            self.returncode = 0
            return 0

    process: ExitedLeaderWithHeldPipes | None = None

    async def launch(*_args: object, **_kwargs: object) -> ExitedLeaderWithHeldPipes:
        nonlocal process
        process = ExitedLeaderWithHeldPipes()
        return process

    async def no_wait(_seconds: float) -> None:
        return None

    def observe(pid: int, _path: Path):
        nonlocal observations
        observations += 1
        observed = fake_observation(pid)
        if observations == 1:
            return observed
        return type(observed)(
            platform=observed.platform,
            pid=observed.pid,
            ppid=observed.ppid,
            pgid=observed.pgid,
            sid=observed.sid,
            start_token="darwin:1700000000:654321",
            executable_path=observed.executable_path,
            executable_device=observed.executable_device,
            executable_inode=observed.executable_inode,
        )

    cancellation = CancellationCoordinator(
        control=store,
        identity_observer=observe,
        signal_sender=lambda pgid, number: signals.append((pgid, number)),
        group_is_live=lambda _identity: True,
        sleep=no_wait,
        term_grace_seconds=0.01,
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        identity_observer=observe,
        cancellation=cancellation,
        run_timeout_seconds=1,
    )
    try:
        with pytest.raises(SupervisorError, match="PROCESS_GROUP_UNRESOLVED"):
            asyncio.run(supervisor.run(reservation))
        assert signals == []
        assert store.runner_outcome(reservation.run_id) is None
        assert store.runner_process(reservation.run_id).cancel_phase == "NONE"
    finally:
        store.close()


def test_raw_stdout_total_over_four_mib_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_stdout_total"
    )
    manifest = InputManifestV1.model_validate_json(reservation.input_manifest_bytes)
    revision = _catalog_revision(store, reservation.run_id)
    lines = []
    for source_seq in range(1, 69):
        candidate = RunnerCandidateV1.model_validate(
            {
                "schema": "RunnerCandidate.v1",
                "run_id": reservation.run_id,
                "input_manifest_hash": reservation.input_manifest_hash,
                "catalog_revision": revision,
                "source_seq": source_seq,
                "ts_event_ns": str(1_700_000_000_000_000_000 + source_seq),
                "type": "order.accepted",
                "payload": {
                    "client_order_id": "x" * 62_000,
                    "instrument_id": manifest.instruments[0].instrument_id,
                    "venue_order_id": str(source_seq),
                },
            }
        )
        line = encode_protocol_line(candidate)
        assert len(line) < 65_536
        lines.append(line)
    stdout = b"".join(lines)
    assert len(stdout) > 4 * 1024 * 1024

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=stdout)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(RunnerSupervisor, "_append_candidate", lambda *_args: None)
    try:
        result = asyncio.run(
            make_supervisor(
                store=store,
                runtime=runtime,
                service_cwd=service_cwd,
            ).run(reservation)
        )
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "PROTOCOL_FAILED"
        assert result.outcome.outcome.stdout_size_bytes > 4 * 1024 * 1024
    finally:
        store.close()


@pytest.mark.parametrize(
    "raw_size",
    [MAX_STDOUT_BYTES + 123, MAX_STDOUT_BYTES + 65_537],
)
def test_overlong_unterminated_stdout_counts_exactly_through_cap_plus_one(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    raw_size: int,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id=f"bt_stdout_exact_{raw_size}"
    )

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=b"x" * raw_size)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "PROTOCOL_FAILED"
        assert result.outcome.outcome.stdout_size_bytes == MAX_STDOUT_BYTES + 1
    finally:
        store.close()


def test_candidate_event_audit_outbox_and_cursor_rollback_together(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_candidate_atomic"
    )
    manifest = InputManifestV1.model_validate_json(reservation.input_manifest_bytes)
    revision = _catalog_revision(store, reservation.run_id)
    candidate = RunnerCandidateV1.model_validate(
        {
            "schema": "RunnerCandidate.v1",
            "run_id": reservation.run_id,
            "input_manifest_hash": reservation.input_manifest_hash,
            "catalog_revision": revision,
            "source_seq": 1,
            "ts_event_ns": "1700000000000000001",
            "type": "order.accepted",
            "payload": {
                "client_order_id": "client-atomic",
                "instrument_id": manifest.instruments[0].instrument_id,
                "venue_order_id": "venue-atomic",
            },
        }
    )
    base_outcome = parse_protocol_line(success_stdout(reservation, revision))
    assert isinstance(base_outcome, RunnerOutcomeV1)
    outcome = RunnerOutcomeV1.model_validate(
        {**base_outcome.model_dump(mode="json", by_alias=True), "last_source_seq": 1}
    )

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=encode_protocol_line(candidate) + encode_protocol_line(outcome))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    injector = sqlite3.connect(runtime / "control.sqlite", isolation_level=None)
    injector.execute(
        """
        CREATE TRIGGER fail_task8_candidate_audit
        BEFORE INSERT ON audit_intents
        WHEN NEW.run_id = 'bt_candidate_atomic' AND NEW.event_seq = 4
        BEGIN
            SELECT RAISE(ABORT, 'task8 candidate audit fault');
        END
        """
    )
    try:
        with pytest.raises(sqlite3.IntegrityError, match="candidate audit fault"):
            asyncio.run(
                make_supervisor(
                    store=store,
                    runtime=runtime,
                    service_cwd=service_cwd,
                ).run(reservation)
            )
        events = store.events(reservation.run_id)
        assert [event.type for event in events] == [
            "preflight.passed",
            "run.queued",
            "run.started",
        ]
        assert len(store.audit_intents(reservation.run_id)) == 3
        assert len(store.pending_outbox(reservation.run_id)) == 3
        run = store.run(reservation.run_id)
        assert run.state is RunState.RUNNING
        assert run.last_event_seq == 3
        assert run.state_version == 3
    finally:
        injector.close()
        store.close()


def test_launch_failure_records_unbound_claim_and_failed_finalizing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_launch_failure"
    )

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        raise OSError("exec failed")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        process = store.runner_process(reservation.run_id)
        assert process is not None and process.pid is None
        assert result.state is RunState.FINALIZING
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "LAUNCH_FAILED"
        assert result.outcome.outcome.process_identity_sha256 is None
    finally:
        store.close()


def test_nonzero_unknown_exit_is_failed_even_with_success_outcome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_unknown_exit"
    )
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(
            stdout=success_stdout(reservation, revision),
            returncode=7,
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "UNKNOWN_EXIT"
        assert result.outcome.outcome.exit_code == 7
        assert result.state is RunState.FINALIZING
    finally:
        store.close()


def test_stderr_is_concurrently_drained_bounded_and_sanitized(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(tmp_path, run_id="bt_stderr")
    revision = _catalog_revision(store, reservation.run_id)
    raw = (
        b"\x00OPENAI_API_KEY=sk-parent-secret-123456 "
        b"password=hunter2 /Users/mac/private/key.txt\n" + b"safe\n" * 100_000
    )

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(
            stdout=success_stdout(reservation, revision),
            stderr=raw,
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        stderr = (runtime / "staging" / reservation.run_id / "stderr.txt").read_bytes()
        assert b"sk-parent" not in stderr
        assert b"hunter2" not in stderr
        assert b"/Users/mac" not in stderr
        assert b"\x00" not in stderr
        assert b"<REDACTED>" in stderr and b"<PATH>" in stderr
        assert result.outcome is not None
        assert not result.outcome.outcome.stderr_truncated
    finally:
        store.close()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (b"Authorization: Bearer aaa.bbb.ccc\n", b"<REDACTED>\n"),
        (b"authorization=Basic Zm9vOmJhcg==\n", b"<REDACTED>\n"),
        (
            b"value=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature\n",
            b"value=<REDACTED>\n",
        ),
        (b"/secret\n", b"<PATH>\n"),
        (
            "alpha\r\nbeta\rgamma\tdelta\u0085epsilon\x7fzeta".encode(),
            b"alpha\nbeta\ngamma\tdeltaepsilonzeta",
        ),
    ],
    ids=["bearer", "basic", "jwt", "root-path", "unicode-controls"],
)
def test_sanitize_stderr_redacts_complete_credentials_paths_and_controls(
    raw: bytes,
    expected: bytes,
) -> None:
    sanitized = sanitize_stderr(raw)
    assert sanitized == expected
    sanitized.decode("utf-8", errors="strict")


def test_stderr_overflow_is_a_failed_observation_not_silent_truncation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_stderr_overflow"
    )
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(
            stdout=success_stdout(reservation, revision),
            stderr=b"e" * (1024 * 1024 + 1),
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        assert result.outcome is not None
        assert result.outcome.outcome.failure_code == "STDERR_OVERFLOW"
        assert result.outcome.outcome.stderr_truncated
        assert result.state is RunState.FINALIZING
    finally:
        store.close()


def test_sanitized_stderr_stays_bounded_valid_utf8_when_replacement_expands(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_stderr_replacement_bound"
    )
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(
            stdout=success_stdout(reservation, revision),
            stderr=b"\xff" * MAX_STDERR_BYTES,
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        result = asyncio.run(
            make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd).run(reservation)
        )
        stderr = (runtime / "staging" / reservation.run_id / "stderr.txt").read_bytes()
        assert len(stderr) <= MAX_STDERR_BYTES
        stderr.decode("utf-8", errors="strict")
        assert result.outcome is not None
        assert result.outcome.outcome.stderr_size_bytes == len(stderr)
        assert result.outcome.outcome.stderr_truncated
    finally:
        store.close()


def test_process_identity_capture_loss_is_persisted_without_pid_only_signal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_identity_loss"
    )
    real_create_subprocess_exec = asyncio.create_subprocess_exec
    children: list[asyncio.subprocess.Process] = []
    outcome_recorded_after_exit: list[bool] = []
    record_outcome = store.record_runner_outcome

    async def launch(*_args: object, **_kwargs: object) -> asyncio.subprocess.Process:
        child = await real_create_subprocess_exec(
            str(Path(sys.executable).absolute()),
            "-s",
            "-P",
            "-c",
            "import time; time.sleep(60)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            close_fds=True,
            start_new_session=True,
            cwd=str(service_cwd),
        )
        children.append(child)
        return child

    def record_after_owned_group_exit(outcome: SupervisorExitV1):
        assert children
        outcome_recorded_after_exit.append(children[0].returncode is not None)
        return record_outcome(outcome)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(store, "record_runner_outcome", record_after_owned_group_exit)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(os.path.abspath(os.sys.executable)),
        runner_cwd=service_cwd,
        identity_observer=lambda _pid, _path: (_ for _ in ()).throw(
            RuntimeError("identity unavailable")
        ),
        run_timeout_seconds=5,
    )

    async def exercise() -> None:
        try:
            result = await supervisor.run(reservation)
            assert outcome_recorded_after_exit == [True]
            assert len(children) == 1
            child = children[0]
            assert child.returncode == -signal.SIGTERM
            with pytest.raises(ProcessLookupError):
                os.killpg(child.pid, 0)
            assert result.outcome is not None
            assert result.outcome.outcome.failure_code == "PROCESS_IDENTITY_LOST"
            assert result.outcome.outcome.signal == signal.SIGTERM
            assert store.runner_process(reservation.run_id).pid is None
        finally:
            if children and children[0].returncode is None:
                try:
                    os.killpg(children[0].pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await children[0].wait()

    try:
        asyncio.run(exercise())
    finally:
        store.close()


@pytest.mark.parametrize(
    ("fault_table", "sequence_column"),
    [("audit_intents", "event_seq"), ("outbox", "seq")],
)
def test_outcome_and_finalizing_are_atomic_and_exact_existing_files_recover(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fault_table: str,
    sequence_column: str,
) -> None:
    run_id = f"bt_db_fault_{fault_table}"
    store, reservation, runtime, service_cwd = prepare_reservation(tmp_path, run_id=run_id)
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=success_stdout(reservation, revision))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    injector = sqlite3.connect(runtime / "control.sqlite", isolation_level=None)
    if fault_table == "audit_intents":
        injector.execute(
            """
            CREATE TRIGGER fail_task8_audit_intents
            BEFORE INSERT ON audit_intents
            WHEN NEW.run_id = 'bt_db_fault_audit_intents' AND NEW.event_seq >= 4
            BEGIN
                SELECT RAISE(ABORT, 'task8 persistence fault');
            END
            """
        )
    else:
        assert sequence_column == "seq"
        injector.execute(
            """
            CREATE TRIGGER fail_task8_outbox
            BEFORE INSERT ON outbox
            WHEN NEW.run_id = 'bt_db_fault_outbox' AND NEW.seq >= 4
            BEGIN
                SELECT RAISE(ABORT, 'task8 persistence fault');
            END
            """
        )
    supervisor = make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="task8 persistence fault"):
            asyncio.run(supervisor.run(reservation))
        staging = runtime / "staging" / reservation.run_id
        exact_exit = (staging / "runner-exit.pending").read_bytes()
        exact_stderr = (staging / "stderr.txt").read_bytes()
        assert not (staging / "runner-exit.json").exists()
        assert store.runner_outcome(reservation.run_id) is None
        assert store.run(reservation.run_id).state is RunState.RUNNING

        injector.execute(
            "DROP TRIGGER fail_task8_audit_intents"
            if fault_table == "audit_intents"
            else "DROP TRIGGER fail_task8_outbox"
        )
        recovered = asyncio.run(supervisor.recover_one(reservation.run_id))
        assert recovered is not None and recovered.state is RunState.FINALIZING
        assert not (staging / "runner-exit.pending").exists()
        assert (staging / "runner-exit.json").read_bytes() == exact_exit
        assert (staging / "stderr.txt").read_bytes() == exact_stderr
        assert store.runner_outcome(reservation.run_id) is not None
    finally:
        injector.close()
        store.close()


@pytest.mark.parametrize("attack", ["bytes", "mode", "hardlink", "owner"])
@pytest.mark.parametrize("target_name", ["runner-exit.pending", "stderr.txt"])
def test_mismatching_exact_existing_output_file_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
    target_name: str,
) -> None:
    store, reservation, runtime, service_cwd = prepare_reservation(
        tmp_path, run_id="bt_exit_mismatch"
    )
    revision = _catalog_revision(store, reservation.run_id)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=success_stdout(reservation, revision))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    injector = sqlite3.connect(runtime / "control.sqlite", isolation_level=None)
    injector.execute(
        """
        CREATE TRIGGER fail_task8_audit_mismatch
        BEFORE INSERT ON audit_intents
        WHEN NEW.run_id = 'bt_exit_mismatch' AND NEW.event_seq >= 4
        BEGIN
            SELECT RAISE(ABORT, 'task8 audit fault');
        END
        """
    )
    supervisor = make_supervisor(store=store, runtime=runtime, service_cwd=service_cwd)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            asyncio.run(supervisor.run(reservation))
        injector.execute("DROP TRIGGER fail_task8_audit_mismatch")
        target_path = runtime / "staging" / reservation.run_id / target_name
        if attack == "bytes":
            target_path.write_bytes(target_path.read_bytes() + b" ")
        elif attack == "mode":
            target_path.chmod(0o640)
        elif attack == "hardlink":
            os.link(target_path, runtime / f"{target_name}-hardlink")
        else:
            target_inode = target_path.stat().st_ino
            real_fstat = os.fstat

            def wrong_exit_owner(descriptor: int):
                metadata = real_fstat(descriptor)
                if metadata.st_ino != target_inode:
                    return metadata
                return SimpleNamespace(
                    st_mode=metadata.st_mode,
                    st_uid=metadata.st_uid + 1,
                    st_nlink=metadata.st_nlink,
                    st_size=metadata.st_size,
                    st_dev=metadata.st_dev,
                    st_ino=metadata.st_ino,
                    st_mtime_ns=metadata.st_mtime_ns,
                )

            monkeypatch.setattr(os, "fstat", wrong_exit_owner)
        with pytest.raises(SupervisorError, match="STAGING_OUTPUT_INVALID"):
            asyncio.run(supervisor.recover_one(reservation.run_id))
        assert store.runner_outcome(reservation.run_id) is None
    finally:
        injector.close()
        store.close()


def test_runner_failure_contract_is_available() -> None:
    assert RunnerSupervisor is not None
