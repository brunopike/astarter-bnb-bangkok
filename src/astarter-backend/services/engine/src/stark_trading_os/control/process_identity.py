"""Closed runner process and supervisor observation models."""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import signal
import stat
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Literal, Protocol

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    ValidationError,
    model_validator,
)

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.runner.protocol import RunnerOutcomeV1

type CancelPhase = Literal["NONE", "REQUESTED", "TERM_SENT", "KILL_SENT"]
type ProcessPlatform = Literal["linux", "darwin"]
type SignalDelivery = Literal["DELIVERED", "PROCESS_GONE", "IDENTITY_MISMATCH"]
type SupervisorClassification = Literal[
    "NATURAL_SUCCESS", "NATURAL_FAILURE", "NO_SPAWN_CANCELLED", "SUPERVISOR_FAILURE"
]
type SupervisorFailureCode = Literal[
    "LAUNCH_FAILED",
    "PROTOCOL_FAILED",
    "STDERR_OVERFLOW",
    "RUN_TIMEOUT",
    "CHILD_REPORTED_FAILURE",
    "UNKNOWN_EXIT",
    "PROCESS_IDENTITY_LOST",
    "FORCED_TERMINATION",
    "UNBOUND_CLAIM",
    "PIPE_DRAIN_TIMEOUT",
]
type Sha256Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
type SchemaVersion = Annotated[StrictInt, Field(ge=1, le=1)]

_DARWIN_FRAMEWORK_BIND_TIMEOUT_SECONDS = 0.05
_DARWIN_FRAMEWORK_BIND_POLL_SECONDS = 0.001


class _ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True)
class ProcessObservation:
    platform: ProcessPlatform
    pid: int
    ppid: int
    pgid: int
    sid: int
    start_token: str
    executable_path: str
    executable_device: int
    executable_inode: int


@dataclass(frozen=True)
class _ExecutableTarget:
    path: str
    device: int
    inode: int


@dataclass(frozen=True)
class _DarwinFrameworkTransition:
    launcher: _ExecutableTarget
    python_app: _ExecutableTarget


@dataclass(frozen=True)
class _DarwinExecutableSnapshot:
    configured: _ExecutableTarget
    transition: _DarwinFrameworkTransition | None


class ProcessObserver(Protocol):
    def __call__(self, pid: int, configured_executable: Path) -> ProcessObservation: ...


class ProcessIdentityV1(_ClosedModel):
    schema_version: SchemaVersion = 1
    run_id: StrictStr
    spawn_nonce: StrictStr
    pid: StrictInt = Field(gt=0)
    ppid: StrictInt = Field(ge=0)
    pgid: StrictInt = Field(gt=0)
    sid: StrictInt = Field(gt=0)
    platform: ProcessPlatform
    start_token: StrictStr
    configured_executable_path: StrictStr
    observed_executable_path: StrictStr
    executable_device: StrictInt = Field(ge=0)
    executable_inode: StrictInt = Field(gt=0)


class RunnerProcessRecord(_ClosedModel):
    schema_version: SchemaVersion = 1
    run_id: StrictStr
    spawn_nonce: StrictStr
    pid: StrictInt | None
    identity: ProcessIdentityV1 | None
    launched_at_ns: StrictInt | None
    cancel_phase: CancelPhase
    created_by_caller: StrictBool

    @model_validator(mode="after")
    def require_bound_or_unbound_shape(self) -> RunnerProcessRecord:
        bound_values = (self.pid, self.identity, self.launched_at_ns)
        if not (
            all(value is None for value in bound_values)
            or all(value is not None for value in bound_values)
        ):
            raise ValueError("Runner process must be wholly bound or wholly unbound.")
        if self.identity is not None and (
            self.identity.run_id != self.run_id
            or self.identity.spawn_nonce != self.spawn_nonce
            or self.identity.pid != self.pid
        ):
            raise ValueError("Runner process identity does not bind its claim row.")
        return self


class UnresolvedProcessGroupV1(_ClosedModel):
    schema_version: SchemaVersion = 1
    run_id: StrictStr = Field(min_length=1)
    spawn_nonce: StrictStr = Field(min_length=1, max_length=128)
    process_identity_sha256: Sha256Digest
    reason: Literal["PIPE_HOLDER_UNRESOLVED"] = "PIPE_HOLDER_UNRESOLVED"


class SupervisorExitV1(_ClosedModel):
    schema_version: SchemaVersion = 1
    run_id: StrictStr
    spawn_nonce: StrictStr | None
    process_identity_sha256: Sha256Digest | None
    launched_at_ns: StrictInt | None
    ended_at_ns: StrictInt = Field(ge=0)
    duration_ns: StrictInt = Field(ge=0)
    exit_code: StrictInt | None
    signal: StrictInt | None
    final_cancel_phase: CancelPhase
    cooperative_cancel_acknowledged: Literal[False] = False
    stdout_size_bytes: StrictInt = Field(ge=0)
    stderr_size_bytes: StrictInt = Field(ge=0)
    stderr_sha256: Sha256Digest
    stderr_truncated: StrictBool
    child_outcome: RunnerOutcomeV1 | None
    classification: SupervisorClassification
    failure_code: SupervisorFailureCode | None
    proposed_terminal_state: Literal["COMPLETED", "FAILED", "CANCELLED"]

    @model_validator(mode="after")
    def require_consistent_exit_shape(self) -> SupervisorExitV1:
        if self.exit_code is not None and self.signal is not None:
            raise ValueError("Exit code and signal are mutually exclusive.")
        if self.launched_at_ns is None:
            if self.process_identity_sha256 is not None or self.duration_ns != 0:
                raise ValueError("An unlaunched observation cannot carry process identity.")
        elif (
            self.process_identity_sha256 is None
            or self.ended_at_ns < self.launched_at_ns
            or self.duration_ns != self.ended_at_ns - self.launched_at_ns
        ):
            raise ValueError("Launched observation timing or identity is inconsistent.")
        if self.classification == "NATURAL_SUCCESS":
            if (
                self.child_outcome is None
                or self.child_outcome.result != "SUCCEEDED"
                or self.exit_code != 0
                or self.signal is not None
                or self.failure_code is not None
                or self.proposed_terminal_state != "COMPLETED"
            ):
                raise ValueError("Natural success requires a clean successful child outcome.")
        elif self.classification == "NATURAL_FAILURE":
            if (
                self.child_outcome is None
                or self.child_outcome.result != "FAILED"
                or self.exit_code != 1
                or self.signal is not None
                or self.failure_code != "CHILD_REPORTED_FAILURE"
                or self.proposed_terminal_state != "FAILED"
            ):
                raise ValueError("Natural failure requires a failed child outcome.")
        elif self.classification == "NO_SPAWN_CANCELLED":
            if (
                self.spawn_nonce is not None
                or self.launched_at_ns is not None
                or self.exit_code is not None
                or self.signal is not None
                or self.child_outcome is not None
                or self.failure_code is not None
                or self.proposed_terminal_state != "CANCELLED"
            ):
                raise ValueError("Clean cancellation requires proof that no spawn claim exists.")
        elif self.failure_code is None or self.proposed_terminal_state != "FAILED":
            raise ValueError("Supervisor failure requires one closed failure code.")
        return self


class RunnerOutcomeRecord(_ClosedModel):
    schema_version: SchemaVersion = 1
    run_id: StrictStr
    outcome: SupervisorExitV1
    outcome_bytes: bytes
    outcome_hash: Sha256Digest
    recorded_at_ns: StrictInt = Field(ge=0)

    @model_validator(mode="after")
    def require_exact_outcome_bytes(self) -> RunnerOutcomeRecord:
        expected = supervisor_exit_bytes(self.outcome)
        if (
            self.outcome.run_id != self.run_id
            or self.outcome_bytes != expected
            or sha256(self.outcome_bytes).hexdigest() != self.outcome_hash
        ):
            raise ValueError("Runner outcome row does not bind exact canonical bytes.")
        return self


def capture_process_identity(
    *,
    run_id: str,
    spawn_nonce: str,
    pid: int,
    configured_executable: Path,
    observer: ProcessObserver | None = None,
) -> ProcessIdentityV1:
    if type(run_id) is not str or not run_id:
        raise ValueError("Process identity requires a non-empty run ID.")
    if type(spawn_nonce) is not str or not spawn_nonce:
        raise ValueError("Process identity requires a non-empty spawn nonce.")
    if type(pid) is not int or pid <= 0:
        raise ValueError("Process identity requires a positive PID.")
    executable = Path(configured_executable)
    if not executable.is_absolute():
        raise ValueError("Configured Python executable must be absolute.")
    observe = observe_process if observer is None else observer
    transition = _darwin_framework_transition(executable) if observer is None else None
    anchor: tuple[ProcessPlatform, int, int, int, str] | None = None
    deadline: float | None = None
    while True:
        observed = observe(pid, executable)
        if observed.pid != pid or observed.pgid != pid or observed.sid != pid:
            raise RuntimeError("Runner process session identity is invalid.")
        _validate_start_token(observed.platform, observed.start_token)
        current_anchor = (
            observed.platform,
            observed.pid,
            observed.pgid,
            observed.sid,
            observed.start_token,
        )
        if anchor is not None and current_anchor != anchor:
            raise RuntimeError("Runner process identity changed during executable binding.")
        if transition is None or observed.platform != "darwin":
            break
        if anchor is None:
            anchor = current_anchor
            deadline = time.monotonic() + _DARWIN_FRAMEWORK_BIND_TIMEOUT_SECONDS
        if _observation_matches_target(observed, transition.python_app):
            break
        if not _observation_matches_target(observed, transition.launcher):
            raise RuntimeError("Observed executable is not the configured Framework launcher.")
        assert deadline is not None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Runner Framework executable did not stabilize before deadline.")
        time.sleep(min(_DARWIN_FRAMEWORK_BIND_POLL_SECONDS, remaining))
    return ProcessIdentityV1(
        run_id=run_id,
        spawn_nonce=spawn_nonce,
        pid=observed.pid,
        ppid=observed.ppid,
        pgid=observed.pgid,
        sid=observed.sid,
        platform=observed.platform,
        start_token=observed.start_token,
        configured_executable_path=str(executable),
        observed_executable_path=observed.executable_path,
        executable_device=observed.executable_device,
        executable_inode=observed.executable_inode,
    )


def _darwin_framework_transition(
    configured_executable: Path,
) -> _DarwinFrameworkTransition | None:
    return _snapshot_darwin_executables(configured_executable).transition


def _snapshot_darwin_executables(
    configured_executable: Path,
) -> _DarwinExecutableSnapshot:
    launcher_path = configured_executable.resolve(strict=True)
    launcher = os.stat(launcher_path, follow_symlinks=True)
    configured = _ExecutableTarget(
        path=str(launcher_path),
        device=launcher.st_dev,
        inode=launcher.st_ino,
    )
    version_root = launcher_path.parent.parent
    if (
        launcher_path.parent.name != "bin"
        or version_root.parent.name != "Versions"
        or version_root.parent.parent.name != "Python.framework"
        or launcher_path.name != f"python{version_root.name}"
        or not stat.S_ISREG(launcher.st_mode)
    ):
        return _DarwinExecutableSnapshot(configured=configured, transition=None)
    python_app_path = version_root / "Resources" / "Python.app" / "Contents" / "MacOS" / "Python"
    python_app_path = python_app_path.resolve(strict=True)
    python_app = os.stat(python_app_path, follow_symlinks=True)
    if not stat.S_ISREG(python_app.st_mode) or python_app.st_dev != launcher.st_dev:
        raise RuntimeError("Configured Framework Python.app companion is invalid.")
    return _DarwinExecutableSnapshot(
        configured=configured,
        transition=_DarwinFrameworkTransition(
            launcher=configured,
            python_app=_ExecutableTarget(
                path=str(python_app_path),
                device=python_app.st_dev,
                inode=python_app.st_ino,
            ),
        ),
    )


def _observation_matches_target(
    observation: ProcessObservation,
    target: _ExecutableTarget,
) -> bool:
    return (
        observation.executable_path == target.path
        and observation.executable_device == target.device
        and observation.executable_inode == target.inode
    )


def process_identity_bytes(identity: ProcessIdentityV1) -> bytes:
    if type(identity) is not ProcessIdentityV1:
        raise TypeError("Process identity must be an exact ProcessIdentityV1.")
    return canonical_json_bytes(identity.model_dump(mode="json", by_alias=True))


def process_identity_digest(identity: ProcessIdentityV1) -> str:
    return sha256(process_identity_bytes(identity)).hexdigest()


def unresolved_process_group_bytes(diagnostic: UnresolvedProcessGroupV1) -> bytes:
    if type(diagnostic) is not UnresolvedProcessGroupV1:
        raise TypeError("Unresolved process-group diagnostic must be exact.")
    return canonical_json_bytes(diagnostic.model_dump(mode="json", by_alias=True))


def unresolved_process_group_from_bytes(raw: bytes) -> UnresolvedProcessGroupV1:
    try:
        value = parse_json_object(raw)
        diagnostic = UnresolvedProcessGroupV1.model_validate(value)
    except (ValidationError, ValueError) as error:
        raise ValueError("Stored unresolved process-group diagnostic is invalid.") from error
    if unresolved_process_group_bytes(diagnostic) != raw:
        raise ValueError("Stored unresolved process-group diagnostic is not exact canonical bytes.")
    return diagnostic


def verify_process_identity(
    identity: ProcessIdentityV1,
    *,
    observer: ProcessObserver | None = None,
) -> bool:
    if type(identity) is not ProcessIdentityV1:
        return False
    observe = observe_process if observer is None else observer
    try:
        observed = observe(identity.pid, Path(identity.configured_executable_path))
        _validate_start_token(observed.platform, observed.start_token)
    except (OSError, RuntimeError, ValueError):
        return False
    return (
        observed.platform == identity.platform
        and observed.pid == identity.pid
        and observed.pgid == identity.pgid == identity.pid
        and observed.sid == identity.sid == identity.pid
        and observed.start_token == identity.start_token
        and observed.executable_path == identity.observed_executable_path
        and observed.executable_device == identity.executable_device
        and observed.executable_inode == identity.executable_inode
    )


def verified_signal_process_group(
    identity: ProcessIdentityV1,
    signal_number: int,
    *,
    observer: ProcessObserver | None = None,
    sender: Callable[[int, int], None] = os.killpg,
) -> SignalDelivery:
    if (
        isinstance(signal_number, bool)
        or not isinstance(signal_number, int)
        or signal_number
        not in {
            signal.SIGTERM,
            signal.SIGKILL,
        }
    ):
        raise ValueError("Only SIGTERM and SIGKILL are approved runner signals.")
    if not verify_process_identity(identity, observer=observer):
        return "IDENTITY_MISMATCH"
    try:
        sender(identity.pgid, signal_number)
    except ProcessLookupError:
        return "PROCESS_GONE"
    return "DELIVERED"


def process_identity_from_bytes(raw: bytes) -> ProcessIdentityV1:
    try:
        value = parse_json_object(raw)
        identity = ProcessIdentityV1.model_validate(value)
    except (ValidationError, ValueError) as error:
        raise ValueError("Stored process identity is invalid.") from error
    if process_identity_bytes(identity) != raw:
        raise ValueError("Stored process identity is not exact canonical bytes.")
    return identity


def supervisor_exit_bytes(outcome: SupervisorExitV1) -> bytes:
    if type(outcome) is not SupervisorExitV1:
        raise TypeError("Supervisor outcome must be an exact SupervisorExitV1.")
    return canonical_json_bytes(outcome.model_dump(mode="json", by_alias=True))


def supervisor_exit_from_bytes(raw: bytes) -> SupervisorExitV1:
    try:
        value = parse_json_object(raw)
        outcome = SupervisorExitV1.model_validate(value)
    except (ValidationError, ValueError) as error:
        raise ValueError("Stored supervisor outcome is invalid.") from error
    if supervisor_exit_bytes(outcome) != raw:
        raise ValueError("Stored supervisor outcome is not exact canonical bytes.")
    return outcome


def process_group_is_live(
    identity: ProcessIdentityV1,
    *,
    observer: ProcessObserver | None = None,
    checker: Callable[[int, int], None] = os.killpg,
) -> bool:
    if not verify_process_identity(identity, observer=observer):
        return False
    try:
        checker(identity.pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def persisted_process_group_is_live(
    identity: ProcessIdentityV1,
    *,
    checker: Callable[[int, int], None] = os.killpg,
) -> bool:
    """Check a previously verified owned group without requiring a live leader."""
    if type(identity) is not ProcessIdentityV1:
        return False
    try:
        checker(identity.pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def observe_process(pid: int, configured_executable: Path) -> ProcessObservation:
    if sys.platform == "darwin":
        snapshot = _snapshot_darwin_executables(configured_executable)
        observation = _observe_darwin_process(pid)
        configured_matches = (
            snapshot.configured.device == observation.executable_device
            and snapshot.configured.inode == observation.executable_inode
        )
        python_app_matches = snapshot.transition is not None and _observation_matches_target(
            observation, snapshot.transition.python_app
        )
        if not configured_matches and not python_app_matches:
            raise RuntimeError("Observed executable does not match configured Python executable.")
        return observation
    elif sys.platform.startswith("linux"):
        observation = _observe_linux_process(pid)
    else:
        raise RuntimeError("High-resolution process identity is unavailable on this platform.")
    configured = os.stat(configured_executable, follow_symlinks=True)
    configured_matches = (
        configured.st_dev == observation.executable_device
        and configured.st_ino == observation.executable_inode
    )
    if not configured_matches:
        raise RuntimeError("Observed executable does not match configured Python executable.")
    return observation


class _ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def _observe_darwin_process(pid: int) -> ProcessObservation:
    library_name = ctypes.util.find_library("proc")
    if library_name is None:
        raise RuntimeError("macOS libproc is unavailable.")
    library = ctypes.CDLL(library_name, use_errno=True)
    proc_pidinfo = library.proc_pidinfo
    proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    proc_pidinfo.restype = ctypes.c_int
    info = _ProcBsdInfo()
    received = proc_pidinfo(
        pid,
        3,
        0,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if received != ctypes.sizeof(info) or info.pbi_pid != pid:
        errno_value = ctypes.get_errno()
        raise OSError(errno_value, "proc_pidinfo(PROC_PIDTBSDINFO) failed")
    if info.pbi_start_tvusec > 999_999:
        raise RuntimeError("macOS process start identity has invalid microseconds.")
    path_buffer = ctypes.create_string_buffer(4096)
    proc_pidpath = library.proc_pidpath
    proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    proc_pidpath.restype = ctypes.c_int
    path_length = proc_pidpath(pid, path_buffer, len(path_buffer))
    if path_length <= 0:
        errno_value = ctypes.get_errno()
        raise OSError(errno_value, "proc_pidpath failed")
    executable_path = os.fsdecode(path_buffer.value)
    executable = os.stat(executable_path, follow_symlinks=True)
    return ProcessObservation(
        platform="darwin",
        pid=pid,
        ppid=int(info.pbi_ppid),
        pgid=int(info.pbi_pgid),
        sid=os.getsid(pid),
        start_token=f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec:06d}",
        executable_path=executable_path,
        executable_device=executable.st_dev,
        executable_inode=executable.st_ino,
    )


def _observe_linux_process(pid: int) -> ProcessObservation:
    directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
    proc_fd = os.open(f"/proc/{pid}", directory_flags)
    stat_fd = -1
    executable_fd = -1
    try:
        stat_fd = os.open(
            "stat",
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=proc_fd,
        )
        raw_stat = os.read(stat_fd, 4097)
        if len(raw_stat) > 4096:
            raise RuntimeError("Linux process stat record is oversized.")
        closing = raw_stat.rfind(b") ")
        if closing < 0:
            raise RuntimeError("Linux process stat record is malformed.")
        fields = raw_stat[closing + 2 :].split()
        if len(fields) < 20:
            raise RuntimeError("Linux process stat record is incomplete.")
        ppid = int(fields[1])
        pgid = int(fields[2])
        sid = int(fields[3])
        start_ticks = int(fields[19])
        executable_path = os.readlink("exe", dir_fd=proc_fd)
        executable_fd = os.open("exe", os.O_RDONLY | os.O_CLOEXEC, dir_fd=proc_fd)
        executable = os.fstat(executable_fd)
        return ProcessObservation(
            platform="linux",
            pid=pid,
            ppid=ppid,
            pgid=pgid,
            sid=sid,
            start_token=f"linux:{start_ticks}",
            executable_path=executable_path,
            executable_device=executable.st_dev,
            executable_inode=executable.st_ino,
        )
    finally:
        if executable_fd >= 0:
            os.close(executable_fd)
        if stat_fd >= 0:
            os.close(stat_fd)
        os.close(proc_fd)


def _validate_start_token(platform: ProcessPlatform, value: str) -> None:
    parts = value.split(":")
    if platform == "linux":
        valid = len(parts) == 2 and parts[0] == "linux" and parts[1].isdigit()
    else:
        valid = (
            len(parts) == 3
            and parts[0] == "darwin"
            and parts[1].isdigit()
            and len(parts[2]) == 6
            and parts[2].isdigit()
            and int(parts[2]) <= 999_999
        )
    if not valid:
        raise ValueError("Process start identity is not high-resolution OS evidence.")
