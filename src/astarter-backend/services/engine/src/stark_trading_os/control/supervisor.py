"""Isolated Task 7 runner supervision with fixed SQLite and filesystem authority."""

from __future__ import annotations

import asyncio
import os
import re
import secrets
import signal
import stat
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from math import isfinite
from pathlib import Path
from typing import ClassVar, Literal, cast

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.historical_process import (
    HistoricalRunnerOutcomeRecord,
    SupervisorExitV2,
)
from stark_trading_os.control.preflight import RunReservation
from stark_trading_os.control.process_identity import (
    ProcessObserver,
    RunnerOutcomeRecord,
    RunnerProcessRecord,
    SupervisorClassification,
    SupervisorExitV1,
    SupervisorFailureCode,
    UnresolvedProcessGroupV1,
    capture_process_identity,
    process_identity_digest,
    supervisor_exit_bytes,
    supervisor_exit_from_bytes,
    unresolved_process_group_bytes,
    unresolved_process_group_from_bytes,
)
from stark_trading_os.control.registry import (
    ControlStore,
    EventCandidate,
    EventRejected,
    VersionConflict,
)
from stark_trading_os.control.run_contract import (
    RunContractKind,
    RunContractMismatch,
)
from stark_trading_os.control.transactions import PersistedCancelRequest
from stark_trading_os.domain.historical_input import InputManifestV2
from stark_trading_os.domain.models import InputManifestV1, RunState
from stark_trading_os.runner.historical_protocol import RunnerOutcomeV2
from stark_trading_os.runner.protocol import (
    MAX_PROTOCOL_LINE_BYTES,
    ProtocolError,
    RunnerCandidateV1,
    RunnerOutcomeV1,
    RunnerSequenceValidator,
    parse_protocol_line,
)

MAX_STDOUT_BYTES = 4 * 1024 * 1024
MAX_STDERR_BYTES = 1024 * 1024
POST_EXIT_PIPE_TIMEOUT_SECONDS = 0.25
_EXIT_PENDING_NAME = "runner-exit.pending"
_EXIT_FINAL_NAME = "runner-exit.json"
_UNRESOLVED_NAME = "runner-unresolved.json"
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
_APPROVED_ENVIRONMENT_KEYS = frozenset(
    {
        "LANG",
        "LC_ALL",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONHASHSEED",
        "PYTHONNOUSERSITE",
        "PYTHONUNBUFFERED",
        "TZ",
    }
)


class SupervisorError(RuntimeError):
    """Stable Task 8 supervisor failure."""


@dataclass(frozen=True)
class SupervisorRunResult:
    run_id: str
    created_by_caller: bool
    spawned: bool
    state: RunState
    outcome: RunnerOutcomeRecord | HistoricalRunnerOutcomeRecord | None


@dataclass(frozen=True)
class _ProtocolRead:
    outcome: RunnerOutcomeV1 | RunnerOutcomeV2
    raw_size_bytes: int


@dataclass(frozen=True)
class _StderrRead:
    raw: bytes
    truncated: bool


@dataclass(frozen=True)
class _SanitizedStderr:
    raw: bytes
    truncated: bool


@dataclass(frozen=True)
class _ChildObservation:
    return_code: int | None
    protocol: _ProtocolRead | None
    protocol_error: _ProtocolReadError | None
    stderr: _StderrRead
    failure_code: SupervisorFailureCode | None


class _ProtocolReadError(ProtocolError):
    def __init__(self, message: str, *, raw_size_bytes: int) -> None:
        self.raw_size_bytes = raw_size_bytes
        super().__init__(message)


class _OutcomePhaseChanged(RuntimeError):
    def __init__(self, process: RunnerProcessRecord) -> None:
        self.process = process
        super().__init__("Runner cancellation phase advanced during outcome handoff.")


def build_minimal_runner_environment(replay_seed: int) -> dict[str, str]:
    if type(replay_seed) is not int or not 0 <= replay_seed <= 2**64 - 1:
        raise ValueError("Runner replay seed must be a strict u64 integer.")
    environment = {
        "LANG": "C",
        "LC_ALL": "C",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": str(replay_seed % 2**32),
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
        "TZ": "UTC",
    }
    assert frozenset(environment) == _APPROVED_ENVIRONMENT_KEYS
    return environment


def stage_input_manifest(*, runtime_root: Path, reservation: RunReservation) -> Path:
    if type(reservation) is not RunReservation:
        raise TypeError("Manifest staging requires an exact RunReservation.")
    runtime = Path(runtime_root)
    if not runtime.is_absolute():
        raise SupervisorError("STAGING_INVALID")
    if sha256(reservation.input_manifest_bytes).hexdigest() != reservation.input_manifest_hash:
        raise SupervisorError("STAGING_INVALID")
    try:
        manifest = InputManifestV1.model_validate(
            parse_json_object(reservation.input_manifest_bytes)
        )
    except ValueError as error:
        raise SupervisorError("STAGING_INVALID") from error
    if (
        canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
        != reservation.input_manifest_bytes
    ):
        raise SupervisorError("STAGING_INVALID")
    return _stage_input_manifest_bytes(runtime_root=runtime, reservation=reservation)


def _stage_input_manifest_bytes(*, runtime_root: Path, reservation: RunReservation) -> Path:
    runtime = Path(runtime_root)
    if not runtime.is_absolute() or type(reservation) is not RunReservation:
        raise SupervisorError("STAGING_INVALID")
    if sha256(reservation.input_manifest_bytes).hexdigest() != reservation.input_manifest_hash:
        raise SupervisorError("STAGING_INVALID")
    _require_component(reservation.run_id)
    runtime_fd = -1
    staging_fd = -1
    run_fd = -1
    manifest_fd = -1
    try:
        runtime_fd = _open_service_directory(runtime)
        staging_fd = _open_or_create_child_directory(runtime_fd, "staging")
        run_fd = _open_or_create_child_directory(staging_fd, reservation.run_id)
        names = set(os.listdir(run_fd))
        if names - {"input-manifest.json"}:
            raise SupervisorError("STAGING_INVALID")
        try:
            manifest_fd = os.open(
                "input-manifest.json",
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
                dir_fd=run_fd,
            )
        except FileExistsError:
            manifest_fd = os.open(
                "input-manifest.json",
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=run_fd,
            )
            _verify_private_regular_file(
                manifest_fd,
                expected=reservation.input_manifest_bytes,
                expected_mode=0o600,
            )
        else:
            os.fchmod(manifest_fd, 0o600)
            written = os.write(manifest_fd, reservation.input_manifest_bytes)
            if written != len(reservation.input_manifest_bytes):
                raise SupervisorError("STAGING_INVALID")
            os.fsync(manifest_fd)
            _verify_private_regular_file(
                manifest_fd,
                expected=reservation.input_manifest_bytes,
                expected_mode=0o600,
            )
        if set(os.listdir(run_fd)) != {"input-manifest.json"}:
            raise SupervisorError("STAGING_INVALID")
        os.fsync(run_fd)
        os.fsync(staging_fd)
    except SupervisorError:
        raise
    except OSError as error:
        raise SupervisorError("STAGING_INVALID") from error
    finally:
        for descriptor in (manifest_fd, run_fd, staging_fd, runtime_fd):
            if descriptor >= 0:
                os.close(descriptor)
    return runtime / "staging" / reservation.run_id


class _OwnedRunnerSupervisor:
    """Shared process ownership, cancellation, bounded I/O and durable observation."""

    _contract_kind: ClassVar[RunContractKind]

    def __init__(
        self,
        *,
        control: ControlStore,
        runtime_root: Path,
        python_executable: Path,
        runner_cwd: Path,
        clock: Callable[[], int] = time.time_ns,
        spawn_nonce_factory: Callable[[], str] | None = None,
        identity_observer: ProcessObserver | None = None,
        cancellation: CancellationCoordinator | None = None,
        run_timeout_seconds: float = 120.0,
    ) -> None:
        runtime = Path(runtime_root)
        executable = Path(python_executable)
        cwd = Path(runner_cwd)
        if not runtime.is_absolute() or not executable.is_absolute() or not cwd.is_absolute():
            raise ValueError("Supervisor paths must be absolute server configuration.")
        _validate_service_directory_path(runtime)
        _validate_service_directory_path(cwd)
        try:
            executable_metadata = os.stat(executable, follow_symlinks=True)
        except OSError as error:
            raise ValueError("Configured Python executable is unavailable.") from error
        if not stat.S_ISREG(executable_metadata.st_mode):
            raise ValueError("Configured Python executable must resolve to a regular file.")
        if isinstance(run_timeout_seconds, bool) or not isinstance(
            run_timeout_seconds, (int, float)
        ):
            raise ValueError("Runner timeout must be a positive finite duration.")
        timeout = float(run_timeout_seconds)
        if timeout <= 0 or not isfinite(timeout):
            raise ValueError("Runner timeout must be a positive finite duration.")
        self._control = control
        self._runtime_root = runtime
        self._python_executable = executable
        self._runner_cwd = cwd
        self._clock = clock
        self._spawn_nonce_factory = (
            spawn_nonce_factory
            if spawn_nonce_factory is not None
            else lambda: secrets.token_hex(16)
        )
        self._identity_observer = identity_observer
        if cancellation is not None and type(cancellation) is not CancellationCoordinator:
            raise TypeError("Supervisor cancellation must be a CancellationCoordinator.")
        self._cancellation = (
            cancellation
            if cancellation is not None
            else CancellationCoordinator(
                control=control,
                identity_observer=identity_observer,
            )
        )
        self._run_timeout_seconds = timeout

    async def run(self, reservation: RunReservation) -> SupervisorRunResult:
        manifest, catalog_revision = self._validate_reservation(reservation)
        staging = self._stage_input(reservation)
        spawn_nonce = self._new_spawn_nonce()
        claim = self._control.claim_runner_process(
            run_id=reservation.run_id,
            spawn_nonce=spawn_nonce,
        )
        if not claim.created_by_caller:
            return SupervisorRunResult(
                run_id=reservation.run_id,
                created_by_caller=False,
                spawned=False,
                state=self._control.run(reservation.run_id).state,
                outcome=self._stored_outcome(reservation.run_id),
            )
        state_after_claim = self._control.run(reservation.run_id).state
        if state_after_claim is RunState.CANCEL_REQUESTED:
            current_claim = self._control.runner_process(reservation.run_id)
            assert current_claim is not None
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=current_claim,
                failure_code="UNBOUND_CLAIM",
                spawned=False,
            )
        if state_after_claim is not RunState.QUEUED:
            raise SupervisorError("SPAWN_STATE_INVALID")
        input_manifest_path = staging / "input-manifest.json"
        try:
            process = await asyncio.create_subprocess_exec(
                str(self._python_executable),
                "-s",
                "-P",
                "-B",
                "-u",
                *self._runner_arguments(reservation, staging, input_manifest_path),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                close_fds=True,
                start_new_session=True,
                cwd=str(self._runner_cwd),
                env=build_minimal_runner_environment(self._environment_seed(manifest)),
                limit=MAX_PROTOCOL_LINE_BYTES + 1,
            )
        except OSError:
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=claim,
                failure_code="LAUNCH_FAILED",
                spawned=False,
            )
        try:
            identity = capture_process_identity(
                run_id=reservation.run_id,
                spawn_nonce=claim.spawn_nonce,
                pid=process.pid,
                configured_executable=self._python_executable,
                observer=self._identity_observer,
            )
        except (OSError, RuntimeError, ValueError):
            wait_task = asyncio.create_task(process.wait())
            return_code = await _stop_owned_process_handle(process, wait_task)
            if return_code is None or _held_process_group_is_live(process):
                _close_child_pipe_transports(process)
                raise SupervisorError("PROCESS_GROUP_UNRESOLVED")
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=claim,
                failure_code="PROCESS_IDENTITY_LOST",
                spawned=True,
                return_code=return_code,
            )
        attached = self._control.attach_runner_process(identity=identity)
        assert attached.launched_at_ns is not None
        if attached.cancel_phase == "REQUESTED":
            await self._cancellation.recover(attached)
        if process.stdout is None or process.stderr is None:
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=attached,
                failure_code="PROTOCOL_FAILED",
                spawned=True,
            )
        observation = await self._observe_child(
            process,
            reservation=reservation,
            manifest=manifest,
            catalog_revision=catalog_revision,
            staging=staging,
        )
        sanitized = _sanitize_stderr(observation.stderr.raw)
        sanitized_stderr = sanitized.raw
        stderr_truncated = observation.stderr.truncated or sanitized.truncated
        if observation.failure_code is not None:
            current = self._control.runner_process(reservation.run_id)
            assert current is not None
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=current,
                failure_code=observation.failure_code,
                spawned=True,
                return_code=observation.return_code,
                stdout_size_bytes=(
                    observation.protocol.raw_size_bytes
                    if observation.protocol is not None
                    else (
                        observation.protocol_error.raw_size_bytes
                        if observation.protocol_error is not None
                        else 0
                    )
                ),
                stderr=sanitized_stderr,
                stderr_truncated=stderr_truncated,
                child_outcome=(
                    None if observation.protocol is None else observation.protocol.outcome
                ),
            )
        return_code = observation.return_code
        protocol = observation.protocol
        assert return_code is not None and protocol is not None
        current_process = self._control.runner_process(reservation.run_id)
        assert current_process is not None
        if current_process.cancel_phase in {"TERM_SENT", "KILL_SENT"}:
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=current_process,
                failure_code="UNKNOWN_EXIT",
                spawned=True,
                return_code=return_code,
                stdout_size_bytes=protocol.raw_size_bytes,
                stderr=sanitized_stderr,
                stderr_truncated=stderr_truncated,
                child_outcome=protocol.outcome,
            )
        classification: SupervisorClassification
        failure_code: SupervisorFailureCode | None
        proposed_terminal_state: Literal["COMPLETED", "FAILED", "CANCELLED"]
        if return_code == 0 and protocol.outcome.result == "SUCCEEDED":
            classification = "NATURAL_SUCCESS"
            failure_code = None
            proposed_terminal_state = "COMPLETED"
        elif return_code == 1 and protocol.outcome.result == "FAILED":
            classification = "NATURAL_FAILURE"
            failure_code = "CHILD_REPORTED_FAILURE"
            proposed_terminal_state = "FAILED"
        else:
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=attached,
                failure_code="UNKNOWN_EXIT",
                spawned=True,
                return_code=return_code,
                stdout_size_bytes=protocol.raw_size_bytes,
                stderr=sanitized_stderr,
                child_outcome=protocol.outcome,
            )
        ended_at_ns = self._now()
        exit_record = self._make_exit(
            run_id=reservation.run_id,
            spawn_nonce=claim.spawn_nonce,
            process_identity_sha256=process_identity_digest(identity),
            launched_at_ns=attached.launched_at_ns,
            ended_at_ns=ended_at_ns,
            duration_ns=ended_at_ns - attached.launched_at_ns,
            exit_code=return_code if return_code >= 0 else None,
            signal=-return_code if return_code < 0 else None,
            final_cancel_phase=current_process.cancel_phase,
            stdout_size_bytes=protocol.raw_size_bytes,
            stderr_size_bytes=len(sanitized_stderr),
            stderr_sha256=sha256(sanitized_stderr).hexdigest(),
            stderr_truncated=stderr_truncated,
            child_outcome=protocol.outcome,
            classification=classification,
            failure_code=failure_code,
            proposed_terminal_state=proposed_terminal_state,
        )
        _write_or_verify_private_file(staging, "stderr.txt", sanitized_stderr)
        try:
            stored = self._record_natural_exit_artifact(staging, exit_record)
        except _OutcomePhaseChanged as error:
            return self._persist_failure(
                reservation=reservation,
                staging=staging,
                process=error.process,
                failure_code="UNKNOWN_EXIT",
                spawned=True,
                return_code=return_code,
                stdout_size_bytes=protocol.raw_size_bytes,
                stderr=sanitized_stderr,
                stderr_truncated=stderr_truncated,
                child_outcome=protocol.outcome,
            )
        return SupervisorRunResult(
            run_id=reservation.run_id,
            created_by_caller=True,
            spawned=True,
            state=self._control.run(reservation.run_id).state,
            outcome=stored,
        )

    def finalize_clean_cancel(
        self,
        decision: PersistedCancelRequest,
    ) -> SupervisorRunResult | None:
        if type(decision) is not PersistedCancelRequest:
            raise TypeError("Clean cancellation requires an exact persisted decision.")
        if not decision.created_by_caller or not decision.clean_no_claim:
            return None
        run_id = decision.response.run_id
        if run_id is None:
            raise SupervisorError("CANCEL_DECISION_INVALID")
        return self._finalize_clean_cancel_from_db(run_id, created_by_caller=True)

    def _finalize_clean_cancel_from_db(
        self,
        run_id: str,
        *,
        created_by_caller: bool,
    ) -> SupervisorRunResult | None:
        reservation = self._reservation_for_run(run_id)
        if reservation.state is not RunState.CANCEL_REQUESTED:
            return None
        if self._control.runner_process(run_id) is not None:
            raise SupervisorError("CANCEL_DECISION_INVALID")
        staging = self._stage_input(reservation)
        cancel_events = tuple(
            event for event in self._control.events(run_id) if event.type == "run.cancel_requested"
        )
        if len(cancel_events) != 1:
            raise SupervisorError("CANCEL_DECISION_INVALID")
        ended_at_ns = int(cancel_events[0].ts_ingest_ns)
        exit_record = self._make_exit(
            run_id=run_id,
            spawn_nonce=None,
            process_identity_sha256=None,
            launched_at_ns=None,
            ended_at_ns=ended_at_ns,
            duration_ns=0,
            exit_code=None,
            signal=None,
            final_cancel_phase="NONE",
            stdout_size_bytes=0,
            stderr_size_bytes=0,
            stderr_sha256=sha256(b"").hexdigest(),
            stderr_truncated=False,
            child_outcome=None,
            classification="NO_SPAWN_CANCELLED",
            failure_code=None,
            proposed_terminal_state="CANCELLED",
        )
        _write_or_verify_private_file(staging, "stderr.txt", b"")
        stored = self._record_exit_artifact(staging, exit_record)
        return SupervisorRunResult(
            run_id=run_id,
            created_by_caller=created_by_caller,
            spawned=False,
            state=self._control.run(run_id).state,
            outcome=stored,
        )

    async def recover_one(self, run_id: str) -> SupervisorRunResult | None:
        reservation = self._reservation_for_run(run_id)
        staging = self._runtime_root / "staging" / run_id
        existing = self._stored_outcome(run_id)
        process = self._control.runner_process(run_id)
        if (
            existing is None
            and process is None
            and reservation.state is RunState.CANCEL_REQUESTED
            and not os.path.lexists(staging)
        ):
            return self._finalize_clean_cancel_from_db(
                run_id,
                created_by_caller=False,
            )
        names = _private_staging_names(staging)
        if names - {
            "input-manifest.json",
            "reports",
            _EXIT_PENDING_NAME,
            _EXIT_FINAL_NAME,
            _UNRESOLVED_NAME,
            "stderr.txt",
        }:
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        if "input-manifest.json" not in names:
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        raw_manifest = _read_private_output_file(
            staging,
            "input-manifest.json",
            max_bytes=len(reservation.input_manifest_bytes),
        )
        if raw_manifest != reservation.input_manifest_bytes:
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        if _UNRESOLVED_NAME in names:
            if (
                existing is not None
                or process is None
                or process.identity is None
                or names & {_EXIT_PENDING_NAME, _EXIT_FINAL_NAME, "stderr.txt"}
            ):
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            raw_unresolved = _read_private_output_file(
                staging,
                _UNRESOLVED_NAME,
                max_bytes=4096,
            )
            try:
                unresolved = unresolved_process_group_from_bytes(raw_unresolved)
            except ValueError as error:
                raise SupervisorError("STAGING_OUTPUT_INVALID") from error
            if (
                unresolved.run_id != run_id
                or unresolved.spawn_nonce != process.spawn_nonce
                or unresolved.process_identity_sha256 != process_identity_digest(process.identity)
            ):
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            return None
        if existing is not None:
            if "stderr.txt" not in names:
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            raw_stderr = _read_private_output_file(
                staging,
                "stderr.txt",
                max_bytes=MAX_STDERR_BYTES,
            )
            if (
                existing.outcome.stderr_size_bytes != len(raw_stderr)
                or existing.outcome.stderr_sha256 != sha256(raw_stderr).hexdigest()
            ):
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            _promote_pending_exit(staging, existing.outcome_bytes)
            return SupervisorRunResult(
                run_id=run_id,
                created_by_caller=False,
                spawned=False,
                state=self._control.run(run_id).state,
                outcome=existing,
            )
        if _EXIT_FINAL_NAME in names:
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        if _EXIT_PENDING_NAME in names:
            if "stderr.txt" not in names:
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            raw_exit = _read_private_output_file(
                staging,
                _EXIT_PENDING_NAME,
                max_bytes=1024 * 1024,
            )
            raw_stderr = _read_private_output_file(
                staging,
                "stderr.txt",
                max_bytes=MAX_STDERR_BYTES,
            )
            try:
                exit_record = self._exit_from_bytes(raw_exit)
            except ValueError as error:
                raise SupervisorError("STAGING_OUTPUT_INVALID") from error
            if (
                exit_record.run_id != run_id
                or exit_record.stderr_size_bytes != len(raw_stderr)
                or exit_record.stderr_sha256 != sha256(raw_stderr).hexdigest()
            ):
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            try:
                if exit_record.classification in {"NATURAL_SUCCESS", "NATURAL_FAILURE"}:
                    stored = self._record_natural_exit_artifact(staging, exit_record)
                else:
                    stored = self._record_exit_artifact(staging, exit_record)
            except _OutcomePhaseChanged as error:
                return_code = exit_record.exit_code
                if exit_record.signal is not None:
                    return_code = -exit_record.signal
                recovered_failure_code = (
                    exit_record.failure_code
                    if exit_record.classification == "SUPERVISOR_FAILURE"
                    else "UNKNOWN_EXIT"
                )
                assert recovered_failure_code is not None
                return self._persist_failure(
                    reservation=reservation,
                    staging=staging,
                    process=error.process,
                    failure_code=recovered_failure_code,
                    spawned=False,
                    return_code=return_code,
                    stdout_size_bytes=exit_record.stdout_size_bytes,
                    stderr=raw_stderr,
                    stderr_truncated=exit_record.stderr_truncated,
                    child_outcome=exit_record.child_outcome,
                    created_by_caller=False,
                )
            return SupervisorRunResult(
                run_id=run_id,
                created_by_caller=False,
                spawned=False,
                state=self._control.run(run_id).state,
                outcome=stored,
            )
        if process is None:
            if self._control.run(run_id).state is RunState.CANCEL_REQUESTED:
                return self._finalize_clean_cancel_from_db(
                    run_id,
                    created_by_caller=False,
                )
            return None
        if process.identity is None:
            raise SupervisorError("PROCESS_GROUP_UNRESOLVED")
        termination = await self._cancellation.recover(process)
        if not termination.group_dead:
            group = await self._cancellation.recover_owned_group_after_leader_exit(process)
            if not group.group_dead:
                raise SupervisorError("PROCESS_GROUP_UNRESOLVED")
        failure_code: SupervisorFailureCode = (
            "FORCED_TERMINATION" if termination.delivered else "PROCESS_IDENTITY_LOST"
        )
        delivered_return_code: int | None = None
        if termination.kill_delivery == "DELIVERED":
            delivered_return_code = -int(signal.SIGKILL)
        elif termination.term_delivery == "DELIVERED":
            delivered_return_code = -int(signal.SIGTERM)
        current = self._control.runner_process(run_id)
        assert current is not None
        return self._persist_failure(
            reservation=reservation,
            staging=staging,
            process=current,
            failure_code=failure_code,
            spawned=False,
            return_code=delivered_return_code,
            created_by_caller=False,
        )

    async def recover_all(self) -> tuple[SupervisorRunResult, ...]:
        recovered: list[SupervisorRunResult] = []
        process_run_ids = {
            process.run_id for process in self._control.recoverable_runner_processes()
        }
        run_ids = process_run_ids | set(self._control.recoverable_clean_cancellations())
        for run_id in sorted(run_ids):
            if self._control.run(run_id).contract_kind is not self._contract_kind:
                continue
            result = await self.recover_one(run_id)
            if result is not None:
                recovered.append(result)
        return tuple(recovered)

    def _persist_failure(
        self,
        *,
        reservation: RunReservation,
        staging: Path,
        process: RunnerProcessRecord,
        failure_code: SupervisorFailureCode,
        spawned: bool,
        return_code: int | None = None,
        stdout_size_bytes: int = 0,
        stderr: bytes = b"",
        stderr_truncated: bool = False,
        child_outcome: RunnerOutcomeV1 | RunnerOutcomeV2 | None = None,
        created_by_caller: bool = True,
    ) -> SupervisorRunResult:
        _write_or_verify_private_file(staging, "stderr.txt", stderr)
        current = process
        while True:
            identity = current.identity
            ended_at_ns = self._now()
            launched_at_ns = current.launched_at_ns
            exit_record = self._make_exit(
                **{
                    "run_id": reservation.run_id,
                    "spawn_nonce": current.spawn_nonce,
                    "process_identity_sha256": (
                        None if identity is None else process_identity_digest(identity)
                    ),
                    "launched_at_ns": launched_at_ns,
                    "ended_at_ns": ended_at_ns,
                    "duration_ns": (0 if launched_at_ns is None else ended_at_ns - launched_at_ns),
                    "exit_code": (
                        return_code if return_code is not None and return_code >= 0 else None
                    ),
                    "signal": (
                        -return_code if return_code is not None and return_code < 0 else None
                    ),
                    "final_cancel_phase": current.cancel_phase,
                    "stdout_size_bytes": stdout_size_bytes,
                    "stderr_size_bytes": len(stderr),
                    "stderr_sha256": sha256(stderr).hexdigest(),
                    "stderr_truncated": stderr_truncated,
                    "child_outcome": child_outcome,
                    "classification": "SUPERVISOR_FAILURE",
                    "failure_code": failure_code,
                    "proposed_terminal_state": "FAILED",
                }
            )
            try:
                stored = self._record_exit_artifact(staging, exit_record)
            except _OutcomePhaseChanged as error:
                current = error.process
                continue
            return SupervisorRunResult(
                run_id=reservation.run_id,
                created_by_caller=created_by_caller,
                spawned=spawned,
                state=self._control.run(reservation.run_id).state,
                outcome=stored,
            )

    def _record_exit_artifact(
        self,
        staging: Path,
        exit_record: SupervisorExitV1 | SupervisorExitV2,
    ) -> RunnerOutcomeRecord | HistoricalRunnerOutcomeRecord:
        payload = self._exit_bytes(exit_record)
        existing_before = self._stored_outcome(exit_record.run_id)
        if existing_before is None and _EXIT_FINAL_NAME in _private_staging_names(staging):
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        _write_or_verify_private_file(staging, _EXIT_PENDING_NAME, payload)
        try:
            stored = self._store_outcome(exit_record)
        except EventRejected:
            current = self._control.runner_process(exit_record.run_id)
            if current is None or not _matches_exit_process_except_phase(
                exit_record,
                current,
            ):
                raise
            _discard_exact_pending_exit(staging, payload)
            raise _OutcomePhaseChanged(current) from None
        _promote_pending_exit(staging, stored.outcome_bytes)
        return stored

    def _record_natural_exit_artifact(
        self,
        staging: Path,
        exit_record: SupervisorExitV1 | SupervisorExitV2,
    ) -> RunnerOutcomeRecord | HistoricalRunnerOutcomeRecord:
        current = exit_record
        while True:
            try:
                return self._record_exit_artifact(staging, current)
            except _OutcomePhaseChanged as error:
                if error.process.cancel_phase != "REQUESTED":
                    raise
                values = current.model_dump(mode="json", by_alias=True)
                values["final_cancel_phase"] = "REQUESTED"
                current = self._make_exit(**values)

    def _reservation_for_run(self, run_id: str) -> RunReservation:
        run = self._control.run(run_id)
        self._require_kind(run.contract_kind)
        if run.input_manifest_bytes is None or run.input_manifest_hash is None:
            raise SupervisorError("RESERVATION_INVALID")
        return RunReservation(
            run_id=run.run_id,
            state=run.state,
            state_version=run.state_version,
            last_visible_seq=run.last_event_seq,
            input_manifest_bytes=run.input_manifest_bytes,
            input_manifest_hash=run.input_manifest_hash,
        )

    def _validate_reservation(
        self,
        reservation: RunReservation,
    ) -> tuple[InputManifestV1 | InputManifestV2, str]:
        if type(reservation) is not RunReservation:
            raise TypeError("Supervisor requires an exact RunReservation.")
        run = self._control.run(reservation.run_id)
        self._require_kind(run.contract_kind)
        if (
            run.input_manifest_bytes != reservation.input_manifest_bytes
            or run.input_manifest_hash != reservation.input_manifest_hash
            or run.catalog_revision is None
            or sha256(reservation.input_manifest_bytes).hexdigest()
            != reservation.input_manifest_hash
        ):
            raise SupervisorError("RESERVATION_INVALID")
        manifest = self._parse_reserved_manifest(reservation, run.catalog_revision)
        return manifest, run.catalog_revision

    async def _observe_child(
        self,
        process: asyncio.subprocess.Process,
        *,
        reservation: RunReservation,
        manifest: InputManifestV1 | InputManifestV2,
        catalog_revision: str,
        staging: Path,
    ) -> _ChildObservation:
        assert process.stdout is not None and process.stderr is not None
        overflow = asyncio.Event()
        protocol_failed = asyncio.Event()
        protocol_task = asyncio.create_task(
            self._read_protocol(
                process.stdout,
                reservation=reservation,
                manifest=manifest,
                catalog_revision=catalog_revision,
                failure=protocol_failed,
            )
        )
        stderr_task = asyncio.create_task(self._read_stderr(process.stderr, overflow=overflow))
        wait_task = asyncio.create_task(process.wait())
        overflow_task = asyncio.create_task(overflow.wait())
        protocol_failure_task = asyncio.create_task(protocol_failed.wait())
        protocol: _ProtocolRead | None = None
        protocol_error: _ProtocolReadError | None = None
        return_code: int | None = None
        failure_code: SupervisorFailureCode | None = None
        deadline = asyncio.get_running_loop().time() + self._run_timeout_seconds
        try:
            while return_code is None and failure_code is None:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    failure_code = "RUN_TIMEOUT"
                    break
                wait_watch = cast(asyncio.Task[object], wait_task)
                overflow_watch = cast(asyncio.Task[object], overflow_task)
                protocol_watch = cast(asyncio.Task[object], protocol_task)
                protocol_failure_watch = cast(asyncio.Task[object], protocol_failure_task)
                monitored = {wait_watch, overflow_watch, protocol_failure_watch}
                if protocol is None:
                    monitored.add(protocol_watch)
                done, _pending = await asyncio.wait(
                    monitored,
                    timeout=min(remaining, 0.05),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    if process.returncode is not None:
                        return_code = process.returncode
                        break
                    if asyncio.get_running_loop().time() >= deadline:
                        failure_code = "RUN_TIMEOUT"
                        break
                    continue
                if wait_watch in done:
                    return_code = wait_task.result()
                if overflow_watch in done and overflow_task.result():
                    failure_code = "STDERR_OVERFLOW"
                if protocol_failure_watch in done and protocol_failure_task.result():
                    failure_code = "PROTOCOL_FAILED"
                if protocol_watch in done and protocol is None:
                    try:
                        protocol = protocol_task.result()
                    except _ProtocolReadError as error:
                        protocol_error = error
                        failure_code = "PROTOCOL_FAILED"
                if return_code is None and process.returncode is not None:
                    return_code = process.returncode

            if failure_code is not None and return_code is None:
                current = self._control.runner_process(reservation.run_id)
                assert current is not None
                termination = await self._cancellation.recover(current)
                if termination.identity_verified and not termination.group_dead:
                    raise SupervisorError("PROCESS_GROUP_UNRESOLVED")
                if termination.identity_verified:
                    try:
                        return_code = await asyncio.wait_for(
                            asyncio.shield(wait_task),
                            timeout=POST_EXIT_PIPE_TIMEOUT_SECONDS,
                        )
                    except TimeoutError:
                        raise SupervisorError("PROCESS_GROUP_UNRESOLVED") from None
                else:
                    return_code = await _stop_owned_process_handle(process, wait_task)
                    if return_code is None:
                        raise SupervisorError("PROCESS_GROUP_UNRESOLVED")

            if return_code is None and wait_task.done():
                return_code = wait_task.result()
            if return_code is None:
                raise SupervisorError("PROCESS_GROUP_UNRESOLVED")

            pipe_tasks = {
                cast(asyncio.Task[object], task)
                for task in (protocol_task, stderr_task)
                if not task.done()
            }
            pipes_timed_out = False
            if pipe_tasks:
                _done, pending = await asyncio.wait(
                    pipe_tasks,
                    timeout=POST_EXIT_PIPE_TIMEOUT_SECONDS,
                    return_when=asyncio.ALL_COMPLETED,
                )
                pipes_timed_out = bool(pending)
                if pipes_timed_out and failure_code is None:
                    failure_code = "PIPE_DRAIN_TIMEOUT"

            current = self._control.runner_process(reservation.run_id)
            assert current is not None
            if pipes_timed_out:
                assert current.identity is not None
                diagnostic = UnresolvedProcessGroupV1(
                    run_id=current.run_id,
                    spawn_nonce=current.spawn_nonce,
                    process_identity_sha256=process_identity_digest(current.identity),
                )
                _write_or_verify_private_file(
                    staging,
                    _UNRESOLVED_NAME,
                    unresolved_process_group_bytes(diagnostic),
                )
                _close_child_pipe_transports(process)
                raise SupervisorError("PROCESS_GROUP_UNRESOLVED")
            group = await self._cancellation.recover_owned_group_after_leader_exit(current)
            if not group.group_dead:
                raise SupervisorError("PROCESS_GROUP_UNRESOLVED")
            if group.delivered and failure_code is None:
                failure_code = "FORCED_TERMINATION"

            if pipes_timed_out:
                remaining_pipe_tasks = {
                    cast(asyncio.Task[object], task)
                    for task in (protocol_task, stderr_task)
                    if not task.done()
                }
                if remaining_pipe_tasks:
                    await asyncio.wait(
                        remaining_pipe_tasks,
                        timeout=POST_EXIT_PIPE_TIMEOUT_SECONDS,
                        return_when=asyncio.ALL_COMPLETED,
                    )

            if protocol is None and protocol_task.done():
                try:
                    protocol = protocol_task.result()
                except _ProtocolReadError as error:
                    protocol_error = error
                    if failure_code is None:
                        failure_code = "PROTOCOL_FAILED"
            if stderr_task.done():
                stderr = stderr_task.result()
            else:
                stderr = _StderrRead(raw=b"", truncated=overflow.is_set())
            if stderr.truncated and failure_code is None:
                failure_code = "STDERR_OVERFLOW"
            return _ChildObservation(
                return_code=return_code,
                protocol=protocol,
                protocol_error=protocol_error,
                stderr=stderr,
                failure_code=failure_code,
            )
        finally:
            for task in (
                overflow_task,
                protocol_failure_task,
                protocol_task,
                stderr_task,
                wait_task,
            ):
                if not task.done():
                    task.cancel()
            await asyncio.gather(
                overflow_task,
                protocol_failure_task,
                protocol_task,
                stderr_task,
                wait_task,
                return_exceptions=True,
            )

    async def _read_protocol(
        self, stream: asyncio.StreamReader, *, reservation: RunReservation,
        manifest: InputManifestV1 | InputManifestV2, catalog_revision: str,
        failure: asyncio.Event,
    ) -> _ProtocolRead:
        raise NotImplementedError

    async def _read_stderr(
        self,
        stream: asyncio.StreamReader,
        *,
        overflow: asyncio.Event | None = None,
    ) -> _StderrRead:
        retained = bytearray()
        truncated = False
        while True:
            chunk = await stream.read(65_536)
            if not chunk:
                break
            if len(retained) < MAX_STDERR_BYTES + 1:
                remaining = MAX_STDERR_BYTES + 1 - len(retained)
                retained.extend(chunk[:remaining])
            if len(retained) > MAX_STDERR_BYTES:
                truncated = True
                if overflow is not None:
                    overflow.set()
        return _StderrRead(raw=bytes(retained[:MAX_STDERR_BYTES]), truncated=truncated)

    def _append_candidate(self, run_id: str, message: RunnerCandidateV1) -> None:
        candidate = EventCandidate.runner(
            type=message.type,
            source_seq=message.source_seq,
            ts_event_ns=message.ts_event_ns,
            payload=dict(message.payload),
        )
        for _ in range(2):
            run = self._control.run(run_id)
            try:
                self._control.append_event(
                    run_id=run_id,
                    expected_version=run.state_version,
                    candidate=candidate,
                )
            except VersionConflict:
                continue
            return
        raise EventRejected("Runner event lost a repeated state-version race.")

    def _new_spawn_nonce(self) -> str:
        value = self._spawn_nonce_factory()
        if type(value) is not str or not value or len(value) > 128:
            raise SupervisorError("SPAWN_NONCE_INVALID")
        return value

    def _now(self) -> int:
        value = self._clock()
        if type(value) is not int or value < 0:
            raise SupervisorError("CLOCK_INVALID")
        return value

    def _require_kind(self, kind: RunContractKind) -> None:
        if kind is not self._contract_kind:
            raise RunContractMismatch("run contract is unsupported by this consumer")

    def _stage_input(self, reservation: RunReservation) -> Path:
        raise NotImplementedError

    def _runner_arguments(
        self, reservation: RunReservation, staging: Path, input_path: Path
    ) -> tuple[str, ...]:
        raise NotImplementedError

    def _environment_seed(self, manifest: InputManifestV1 | InputManifestV2) -> int:
        raise NotImplementedError

    def _parse_reserved_manifest(
        self, reservation: RunReservation, catalog_revision: str
    ) -> InputManifestV1 | InputManifestV2:
        raise NotImplementedError

    def _make_exit(self, **values: object) -> SupervisorExitV1 | SupervisorExitV2:
        raise NotImplementedError

    def _exit_bytes(self, outcome: SupervisorExitV1 | SupervisorExitV2) -> bytes:
        raise NotImplementedError

    def _exit_from_bytes(self, raw: bytes) -> SupervisorExitV1 | SupervisorExitV2:
        raise NotImplementedError

    def _stored_outcome(
        self, run_id: str
    ) -> RunnerOutcomeRecord | HistoricalRunnerOutcomeRecord | None:
        raise NotImplementedError

    def _store_outcome(
        self, outcome: SupervisorExitV1 | SupervisorExitV2
    ) -> RunnerOutcomeRecord | HistoricalRunnerOutcomeRecord:
        raise NotImplementedError


class RunnerSupervisor(_OwnedRunnerSupervisor):
    """The unchanged v1 contract on the shared owned-process machinery."""

    _contract_kind = RunContractKind.PROBE_V1

    def _stage_input(self, reservation: RunReservation) -> Path:
        return stage_input_manifest(runtime_root=self._runtime_root, reservation=reservation)

    def _runner_arguments(
        self, reservation: RunReservation, staging: Path, input_path: Path
    ) -> tuple[str, ...]:
        return ("-m", "stark_trading_os.runner.main", "--run-id", reservation.run_id,
                "--staging-dir", str(staging), "--input-manifest", str(input_path))

    def _environment_seed(self, manifest: InputManifestV1 | InputManifestV2) -> int:
        assert isinstance(manifest, InputManifestV1)
        return manifest.replay_seed

    def _parse_reserved_manifest(
        self, reservation: RunReservation, catalog_revision: str
    ) -> InputManifestV1:
        try:
            manifest = InputManifestV1.model_validate(
                parse_json_object(reservation.input_manifest_bytes)
            )
        except ValueError as error:
            raise SupervisorError("RESERVATION_INVALID") from error
        if (
            canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
            != reservation.input_manifest_bytes
            or manifest.catalog_revision != catalog_revision
        ):
            raise SupervisorError("RESERVATION_INVALID")
        return manifest

    def _make_exit(self, **values: object) -> SupervisorExitV1:
        return SupervisorExitV1.model_validate(values)

    def _exit_bytes(self, outcome: SupervisorExitV1 | SupervisorExitV2) -> bytes:
        assert isinstance(outcome, SupervisorExitV1)
        return supervisor_exit_bytes(outcome)

    def _exit_from_bytes(self, raw: bytes) -> SupervisorExitV1:
        return supervisor_exit_from_bytes(raw)

    def _stored_outcome(self, run_id: str) -> RunnerOutcomeRecord | None:
        return self._control.runner_outcome(run_id)

    def _store_outcome(self, outcome: SupervisorExitV1 | SupervisorExitV2) -> RunnerOutcomeRecord:
        assert isinstance(outcome, SupervisorExitV1)
        return self._control.record_runner_outcome(outcome)

    async def _read_protocol(
        self, stream: asyncio.StreamReader, *, reservation: RunReservation,
        manifest: InputManifestV1 | InputManifestV2, catalog_revision: str,
        failure: asyncio.Event,
    ) -> _ProtocolRead:
        assert isinstance(manifest, InputManifestV1)
        validator = RunnerSequenceValidator(
            run_id=reservation.run_id, input_manifest_hash=reservation.input_manifest_hash,
            catalog_revision=catalog_revision,
            instrument_id=manifest.instruments[0].instrument_id,
            quote_currency=manifest.venue_account_model.currency,
        )
        outcome: RunnerOutcomeV1 | None = None

        def accept_line(line: bytes) -> None:
            nonlocal outcome
            message = parse_protocol_line(line)
            if outcome is not None:
                raise ProtocolError("Runner emitted data after its outcome.")
            if isinstance(message, RunnerCandidateV1):
                validator.accept(message)
                self._append_candidate(reservation.run_id, message)
            else:
                validator.finish(message)
                outcome = message

        total = await _read_bounded_protocol(stream, accept_line=accept_line, failure=failure)
        if outcome is None:
            raise _ProtocolReadError(
                "Runner stdout ended without one outcome.", raw_size_bytes=total
            )
        return _ProtocolRead(outcome=outcome, raw_size_bytes=total)


async def _read_bounded_protocol(
    stream: asyncio.StreamReader, *, accept_line: Callable[[bytes], None], failure: asyncio.Event,
) -> int:
    total = 0
    line_buffer = bytearray()
    first_error: str | None = None

    def reject(message: str) -> None:
        nonlocal first_error
        if first_error is None:
            first_error = message
            failure.set()

    while True:
        chunk = await stream.read(65_536)
        if not chunk:
            break
        retained_length = min(len(chunk), MAX_STDOUT_BYTES + 1 - total)
        retained = chunk[:retained_length]
        total += retained_length
        if first_error is None:
            offset = 0
            while offset < len(retained):
                newline = retained.find(b"\n", offset)
                end = len(retained) if newline < 0 else newline + 1
                piece = retained[offset:end]
                if len(line_buffer) + len(piece) > MAX_PROTOCOL_LINE_BYTES:
                    reject("Runner protocol line exceeds 64 KiB.")
                    line_buffer.clear()
                    break
                line_buffer.extend(piece)
                offset = end
                if newline >= 0:
                    try:
                        accept_line(bytes(line_buffer))
                    except ProtocolError as error:
                        reject(str(error))
                    line_buffer.clear()
                    if first_error is not None:
                        break
        if total == MAX_STDOUT_BYTES + 1:
            reject("Runner stdout exceeds 4 MiB.")
    if first_error is None and line_buffer:
        reject("Runner stdout ended with a partial protocol line.")
    if first_error is not None:
        raise _ProtocolReadError(first_error, raw_size_bytes=total)
    return total


def sanitize_stderr(raw: bytes) -> bytes:
    return _sanitize_stderr(raw).raw


async def _stop_owned_process_handle(
    process: asyncio.subprocess.Process,
    wait_task: asyncio.Task[int],
) -> int | None:
    """Bound a still-owned leader without trusting a now-stale persisted PID."""

    if wait_task.done():
        return wait_task.result()
    if process.returncode is None:
        try:
            terminate = process.terminate
        except AttributeError:
            return None
        try:
            terminate()
        except ProcessLookupError:
            pass
    try:
        return await asyncio.wait_for(
            asyncio.shield(wait_task),
            timeout=POST_EXIT_PIPE_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        pass
    if process.returncode is None:
        try:
            kill = process.kill
        except AttributeError:
            return None
        try:
            kill()
        except ProcessLookupError:
            pass
    try:
        return await asyncio.wait_for(
            asyncio.shield(wait_task),
            timeout=POST_EXIT_PIPE_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        return None


def _held_process_group_is_live(process: asyncio.subprocess.Process) -> bool:
    """Check only the new session identified by a still-held process handle."""

    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _close_child_pipe_transports(process: asyncio.subprocess.Process) -> None:
    for stream in (process.stdout, process.stderr):
        if stream is None:
            continue
        transport = cast(asyncio.ReadTransport | None, getattr(stream, "_transport", None))
        if transport is not None:
            transport.close()


def _sanitize_stderr(raw: bytes) -> _SanitizedStderr:
    text = raw.decode("utf-8", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(
        character
        for character in text
        if character in "\n\t" or unicodedata.category(character) != "Cc"
    )
    text = re.sub(
        r"(?i)\bauthorization\b\s*[:=]\s*(?:bearer|basic)\s+\S+",
        "<REDACTED>",
        text,
    )
    text = re.sub(
        r"(?i)\b(?:api[_-]?key|authorization|credential|password|secret|token)\b"
        r"\s*[:=]\s*\S+",
        "<REDACTED>",
        text,
    )
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,})\b", "<REDACTED>", text)
    text = re.sub(
        r"(?<![A-Za-z0-9_.:/-])(?:[A-Za-z0-9_-]{2,}\.){2}[A-Za-z0-9_-]{2,}"
        r"(?![A-Za-z0-9_-])",
        "<REDACTED>",
        text,
    )
    text = re.sub(r"(?<![A-Za-z0-9_.:/-])/(?!/)[^\s]*[^\s/]", "<PATH>", text)
    sanitized = text.encode("utf-8")
    if len(sanitized) <= MAX_STDERR_BYTES:
        return _SanitizedStderr(raw=sanitized, truncated=False)
    bounded = sanitized[:MAX_STDERR_BYTES].decode("utf-8", errors="ignore").encode("utf-8")
    return _SanitizedStderr(raw=bounded, truncated=True)


def _write_or_verify_private_file(directory: Path, name: str, payload: bytes) -> None:
    _require_component(name)
    directory_fd = -1
    descriptor = -1
    try:
        directory_fd = _open_service_directory(directory)
        try:
            descriptor = os.open(
                name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory_fd,
            )
        except FileExistsError:
            descriptor = os.open(
                name,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            try:
                _verify_private_regular_file(
                    descriptor,
                    expected=payload,
                    expected_mode=0o600,
                )
            except SupervisorError as error:
                raise SupervisorError("STAGING_OUTPUT_INVALID") from error
            return
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise SupervisorError("STAGING_OUTPUT_INVALID")
            offset += written
        os.fsync(descriptor)
        _verify_private_regular_file(descriptor, expected=payload, expected_mode=0o600)
        os.fsync(directory_fd)
    except SupervisorError:
        raise
    except OSError as error:
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if directory_fd >= 0:
            os.close(directory_fd)


def _promote_pending_exit(directory: Path, payload: bytes) -> None:
    directory_fd = -1
    pending_fd = -1
    final_fd = -1
    try:
        directory_fd = _open_service_directory(directory)
        try:
            pending_fd = os.open(
                _EXIT_PENDING_NAME,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
        except FileNotFoundError:
            final_fd = os.open(
                _EXIT_FINAL_NAME,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            _verify_private_regular_file(
                final_fd,
                expected=payload,
                expected_mode=0o600,
            )
            return
        try:
            final_fd = os.open(
                _EXIT_FINAL_NAME,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
        except FileNotFoundError:
            _verify_private_regular_file(
                pending_fd,
                expected=payload,
                expected_mode=0o600,
            )
            try:
                os.link(
                    _EXIT_PENDING_NAME,
                    _EXIT_FINAL_NAME,
                    src_dir_fd=directory_fd,
                    dst_dir_fd=directory_fd,
                    follow_symlinks=False,
                )
            except FileExistsError:
                pass
            else:
                os.fsync(directory_fd)
            final_fd = os.open(
                _EXIT_FINAL_NAME,
                os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
        pending_metadata = os.fstat(pending_fd)
        final_metadata = os.fstat(final_fd)
        if (
            pending_metadata.st_dev != final_metadata.st_dev
            or pending_metadata.st_ino != final_metadata.st_ino
        ):
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        _verify_private_regular_file(
            pending_fd,
            expected=payload,
            expected_mode=0o600,
            expected_links=2,
        )
        _verify_private_regular_file(
            final_fd,
            expected=payload,
            expected_mode=0o600,
            expected_links=2,
        )
        os.unlink(_EXIT_PENDING_NAME, dir_fd=directory_fd)
        os.fsync(directory_fd)
        os.close(final_fd)
        final_fd = os.open(
            _EXIT_FINAL_NAME,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
        _verify_private_regular_file(
            final_fd,
            expected=payload,
            expected_mode=0o600,
        )
    except SupervisorError as error:
        if str(error) == "STAGING_OUTPUT_INVALID":
            raise
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    except OSError as error:
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    finally:
        for descriptor in (pending_fd, final_fd, directory_fd):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


def _discard_exact_pending_exit(directory: Path, payload: bytes) -> None:
    directory_fd = -1
    pending_fd = -1
    try:
        directory_fd = _open_service_directory(directory)
        try:
            os.stat(_EXIT_FINAL_NAME, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        pending_fd = os.open(
            _EXIT_PENDING_NAME,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
        _verify_private_regular_file(
            pending_fd,
            expected=payload,
            expected_mode=0o600,
        )
        descriptor_metadata = os.fstat(pending_fd)
        name_metadata = os.stat(
            _EXIT_PENDING_NAME,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            descriptor_metadata.st_dev != name_metadata.st_dev
            or descriptor_metadata.st_ino != name_metadata.st_ino
        ):
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        os.unlink(_EXIT_PENDING_NAME, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except SupervisorError as error:
        if str(error) == "STAGING_OUTPUT_INVALID":
            raise
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    except OSError as error:
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    finally:
        if pending_fd >= 0:
            os.close(pending_fd)
        if directory_fd >= 0:
            os.close(directory_fd)


def _read_private_output_file(directory: Path, name: str, *, max_bytes: int) -> bytes:
    _require_component(name)
    directory_fd = -1
    descriptor = -1
    try:
        directory_fd = _open_service_directory(directory)
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_uid != os.getuid()
            or before.st_nlink != 1
            or before.st_size < 0
            or before.st_size > max_bytes
        ):
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        payload = bytearray()
        while len(payload) <= before.st_size:
            chunk = os.read(descriptor, min(65_536, before.st_size + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        if (
            len(payload) != before.st_size
            or after.st_dev != before.st_dev
            or after.st_ino != before.st_ino
            or after.st_size != before.st_size
            or after.st_mtime_ns != before.st_mtime_ns
        ):
            raise SupervisorError("STAGING_OUTPUT_INVALID")
        return bytes(payload)
    except SupervisorError:
        raise
    except OSError as error:
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if directory_fd >= 0:
            os.close(directory_fd)


def _private_staging_names(directory: Path) -> set[str]:
    descriptor = -1
    try:
        descriptor = _open_service_directory(directory)
        names = os.listdir(descriptor)
    except SupervisorError:
        raise
    except OSError as error:
        raise SupervisorError("STAGING_OUTPUT_INVALID") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if any(
        type(name) is not str or not name or name in {".", ".."} or "/" in name for name in names
    ):
        raise SupervisorError("STAGING_OUTPUT_INVALID")
    return set(names)


def _open_service_directory(path: Path) -> int:
    descriptor = os.open(path, _DIRECTORY_FLAGS)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o700
            or metadata.st_uid != os.getuid()
        ):
            raise SupervisorError("STAGING_INVALID")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _open_or_create_child_directory(parent_fd: int, name: str) -> int:
    _require_component(name)
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except FileExistsError:
        pass
    descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or metadata.st_uid != os.getuid()
    ):
        os.close(descriptor)
        raise SupervisorError("STAGING_INVALID")
    return descriptor


def _verify_private_regular_file(
    descriptor: int,
    *,
    expected: bytes,
    expected_mode: int,
    expected_links: int = 1,
) -> None:
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != expected_links
        or metadata.st_size != len(expected)
    ):
        raise SupervisorError("STAGING_INVALID")
    os.lseek(descriptor, 0, os.SEEK_SET)
    observed = bytearray()
    while len(observed) <= len(expected):
        chunk = os.read(descriptor, min(65_536, len(expected) + 1 - len(observed)))
        if not chunk:
            break
        observed.extend(chunk)
    if bytes(observed) != expected or sha256(observed).digest() != sha256(expected).digest():
        raise SupervisorError("STAGING_INVALID")


def _validate_service_directory_path(path: Path) -> None:
    descriptor = -1
    try:
        descriptor = _open_service_directory(path)
    except OSError as error:
        raise ValueError("Service-owned directory is unavailable.") from error
    except SupervisorError as error:
        raise ValueError("Service-owned directory metadata is invalid.") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _require_component(value: str) -> None:
    if type(value) is not str or not value or value in {".", ".."} or "/" in value:
        raise SupervisorError("STAGING_INVALID")


def _matches_exit_process_except_phase(
    exit_record: SupervisorExitV1 | SupervisorExitV2,
    process: RunnerProcessRecord,
) -> bool:
    identity_digest = (
        None if process.identity is None else process_identity_digest(process.identity)
    )
    return (
        process.run_id == exit_record.run_id
        and process.spawn_nonce == exit_record.spawn_nonce
        and process.launched_at_ns == exit_record.launched_at_ns
        and identity_digest == exit_record.process_identity_sha256
        and process.cancel_phase != exit_record.final_cancel_phase
    )
