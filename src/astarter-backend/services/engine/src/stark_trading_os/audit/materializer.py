"""Canonical, non-public run-root materialization from committed authority."""

from __future__ import annotations

import ctypes
import errno
import fcntl
import os
import sqlite3
import stat
import sys
import threading
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Literal, cast

from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.audit.hash_chain import append_hash_chain, verify_hash_chain
from stark_trading_os.audit.seal import BuiltSeal, SealVerificationError, build_run_seal
from stark_trading_os.control.registry import (
    AuditIntent,
    ControlStore,
    PersistedEvent,
    TerminalFinalization,
    TerminalPreparation,
    TerminalPublication,
    UnverifiedTerminalPublication,
)
from stark_trading_os.control.transactions import (
    TerminalEligibilityError,
    TerminalIntegrityError,
    TerminalPublicationConflict,
    _same_terminal_preparation,
    _VerifiedPublicationWindow,
    _VerifiedRootProof,
)
from stark_trading_os.domain.models import EventEnvelopeV1, RunRecordV1, RunState

_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
_READ_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
_WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
_BASE_PATHS = (
    "request.json",
    "preflight.json",
    "input-manifest.json",
    "run-record.json",
    "events.ndjson",
    "audit.ndjson",
    "runner-exit.json",
    "stderr.txt",
)
_REPORT_NAMES = ("orders", "fills", "positions", "account", "metrics")
# The closed canonical inventory contains only _BASE_PATHS, seal.json, and fixed reports.
_LEGACY_MISSING_ARTIFACT_PATH = "__invalid_requested_relative_path__"
_TERMINAL_EVENT_TYPES = frozenset({"run.completed", "run.failed", "run.cancelled"})
_TERMINAL_EVENT_BY_STATE = {
    RunState.COMPLETED: "run.completed",
    RunState.FAILED: "run.failed",
    RunState.CANCELLED: "run.cancelled",
}
_RENAME_EXCL = 0x00000004
_RENAME_NOFOLLOW_ANY = 0x00000010
_RENAME_RESOLVE_BENEATH = 0x00000020
_RENAME_FLAGS = _RENAME_EXCL | _RENAME_NOFOLLOW_ANY | _RENAME_RESOLVE_BENEATH
_PUBLISH_LOCK_NAME = ".run-publish.lock"
_PROCESS_PUBLISH_LOCK = threading.Lock()
_OPERATIONAL_ERRNOS = frozenset(
    code
    for code in (
        getattr(errno, name, None)
        for name in (
            "EIO",
            "EAGAIN",
            "EBUSY",
            "ENOMEM",
            "EMFILE",
            "ENFILE",
            "ENOSPC",
            "EDQUOT",
            "EROFS",
        )
    )
    if code is not None
)


type MaterializationStage = Literal[
    "STAGING",
    "REPORTS",
    "RECONCILIATION",
    "MATERIALIZATION",
    "FSYNC",
    "RENAME",
    "SEAL",
    "PUBLICATION",
]


class MaterializationError(ValueError):
    """Raised when authority, staging, durability, or no-clobber checks fail."""

    def __init__(
        self,
        message: str,
        *,
        deterministic: bool = True,
        stage: MaterializationStage = "MATERIALIZATION",
        artifact: str | None = None,
    ) -> None:
        super().__init__(message)
        self.deterministic = deterministic
        self.stage = stage
        self.artifact = artifact


class RenamedRootRecoveryRequired(RuntimeError):
    """A final root exists without its SQLite terminal identity."""


class FinalizationAlreadyResolved(RuntimeError):
    """A concurrent terminal winner was observed under the held publish lock."""

    def __init__(self, result: TerminalFinalization) -> None:
        self.result = result
        super().__init__("Terminal finalization was resolved by another caller.")


class _PublicationTeardownFailure(Exception):
    """Carry one cleanup-only failure beyond ordinary materialization error mapping."""

    def __init__(self, error: BaseException) -> None:
        self.error = error
        super().__init__(str(error))


def _filesystem_os_error(
    message: str,
    error: OSError,
    *,
    stage: MaterializationStage = "MATERIALIZATION",
    artifact: str | None = None,
) -> MaterializationError:
    """Keep observed evidence/path failures deterministic; retry resource/I/O faults."""

    return MaterializationError(
        message,
        deterministic=error.errno not in _OPERATIONAL_ERRNOS,
        stage=stage,
        artifact=artifact,
    )


@dataclass(frozen=True)
class MaterializedRun:
    run_id: str
    terminal_state: RunState
    terminal_event_seq: int
    last_audit_seq: int
    audit_head_hash: str
    seal_bytes: bytes
    seal_digest: str


@dataclass(frozen=True)
class _Projection:
    files: dict[str, bytes]
    terminal_event_seq: int
    last_audit_seq: int
    audit_head_hash: str


@dataclass(frozen=True)
class _LockedFinalRoot:
    runtime_fd: int
    runs_fd: int
    root_fd: int
    lock_fd: int


_VERIFIED_FINAL_ROOT_RECEIPTS: dict[int, object] = {}


def _is_normalized_artifact_path(relative_path: str) -> bool:
    components = relative_path.split("/")
    return (
        bool(relative_path)
        and not relative_path.startswith("/")
        and "\\" not in relative_path
        and "\0" not in relative_path
        and all(component not in {"", ".", ".."} for component in components)
    )


def _legacy_artifact_path(relative_path: str) -> str:
    if _is_normalized_artifact_path(relative_path):
        return relative_path
    return _LEGACY_MISSING_ARTIFACT_PATH


class _RetainedFinalRootVerification:
    """Descriptor-only final-root identity retained through SQLite publication."""

    _runtime_fd: int
    _runs_fd: int
    _root_fd: int
    _reports_fd: int
    _root_name: str
    _runtime_path: Path
    _service_uid: int
    _runs_identity: os.stat_result
    _root_identity: os.stat_result
    _reports_identity: os.stat_result | None
    _files: tuple[tuple[str, int, os.stat_result, bytes], ...]
    __slots__ = (
        "_runtime_fd",
        "_runs_fd",
        "_root_fd",
        "_reports_fd",
        "_root_name",
        "_runtime_path",
        "_service_uid",
        "_runs_identity",
        "_root_identity",
        "_reports_identity",
        "_files",
    )

    def __init__(self, **_values: object) -> None:
        raise TypeError("Retained final-root verification is created only by the materializer.")

    def _discard(self) -> None:
        descriptors = (
            *(descriptor for _path, descriptor, _identity, _payload in self._files),
            self._reports_fd,
            self._root_fd,
            self._runs_fd,
            self._runtime_fd,
        )
        self._files = ()
        self._reports_fd = self._root_fd = self._runs_fd = self._runtime_fd = -1
        cleanup_error: BaseException | None = None
        for descriptor in descriptors:
            if descriptor < 0:
                continue
            try:
                os.close(descriptor)
            except BaseException as error:
                if cleanup_error is None:
                    cleanup_error = error
        if cleanup_error is not None:
            raise cleanup_error


class _VerifiedFinalRootReceipt:
    """Unforgeable record of the final descriptor-verified root under its flock."""

    _lock_guard_fd: int
    _retained: _RetainedFinalRootVerification | None
    _consumed: bool
    __slots__ = ("_lock_guard_fd", "_retained", "_consumed")

    def __init__(self, **_values: object) -> None:
        raise TypeError("Final-root receipts are created only by the materializer verifier.")

    def _consume_locked_guard(
        self, *, authority: object
    ) -> tuple[int, _RetainedFinalRootVerification]:
        if self._consumed:
            raise MaterializationError(
                "final-root receipt was already consumed", stage="PUBLICATION"
            )
        if _VERIFIED_FINAL_ROOT_RECEIPTS.pop(id(self), None) is not authority:
            raise MaterializationError(
                "final-root receipt was not issued by the current locked verifier",
                stage="PUBLICATION",
            )
        self._consumed = True
        guard_fd = self._lock_guard_fd
        self._lock_guard_fd = -1
        retained = self._retained
        self._retained = None
        if retained is None:
            _close_all(guard_fd)
            raise MaterializationError(
                "final-root receipt lacks retained verification identities",
                stage="PUBLICATION",
            )
        return guard_fd, retained

    def _discard(self) -> None:
        _VERIFIED_FINAL_ROOT_RECEIPTS.pop(id(self), None)
        cleanup_error: BaseException | None = None
        lock_guard_fd = self._lock_guard_fd
        self._lock_guard_fd = -1
        if lock_guard_fd >= 0:
            try:
                os.close(lock_guard_fd)
            except BaseException as error:
                cleanup_error = error
        retained = getattr(self, "_retained", None)
        self._retained = None
        if retained is not None:
            try:
                retained._discard()
            except BaseException as error:
                if cleanup_error is None:
                    cleanup_error = error
        if cleanup_error is not None:
            raise cleanup_error


class CanonicalMaterializer:
    """Build and durably rename one immutable, still non-public run root."""

    def __init__(self, *, store: ControlStore, runtime_root: Path) -> None:
        if type(store) is not ControlStore:
            raise TypeError("Materializer requires an exact ControlStore.")
        runtime = Path(runtime_root)
        if not runtime.is_absolute():
            raise MaterializationError("runtime_root must be absolute")
        self._store = store
        self._runtime_root = runtime
        self._service_uid = os.geteuid()

    def read_staging_reports(
        self,
        *,
        preparation: TerminalPreparation,
    ) -> tuple[tuple[str, bytes], ...]:
        """Return the fixed report snapshot bound to one normal preparation."""

        if type(preparation) is not TerminalPreparation:
            raise TypeError("Staging snapshot requires an exact TerminalPreparation.")
        authoritative = self._store.terminal_preparation(run_id=preparation.run_id)
        if (
            authoritative is None
            or not _same_terminal_preparation(authoritative, preparation)
            or authoritative.disposition != "NORMAL"
        ):
            raise MaterializationError("terminal preparation changed before staging snapshot")
        child = authoritative.outcome.outcome.child_outcome
        reports = () if child is None else child.report_candidates
        staged = self._read_staging_evidence(authoritative)
        return tuple((candidate.name, staged[candidate.relative_path]) for candidate in reports)

    def materialize_and_publish(
        self,
        *,
        preparation: TerminalPreparation,
    ) -> TerminalPublication:
        """Materialize and publish one exact normal preparation."""

        if type(preparation) is not TerminalPreparation:
            raise TypeError("Verified publication requires an exact TerminalPreparation.")
        existing = self._store.terminal_finalization(run_id=preparation.run_id)
        if existing is not None:
            if type(existing) is TerminalPublication:
                return existing
            raise FinalizationAlreadyResolved(existing)
        authoritative = self._store.terminal_preparation(run_id=preparation.run_id)
        if (
            authoritative is None
            or not _same_terminal_preparation(authoritative, preparation)
            or authoritative.disposition != "NORMAL"
        ):
            raise MaterializationError("terminal preparation changed before verified publication")

        projection = self._build_projection(authoritative)
        staged = self._read_staging_evidence(authoritative)
        files = {**projection.files, **staged}
        try:
            built_seal = build_run_seal(
                run_id=authoritative.run_id,
                terminal_state=authoritative.terminal_state,
                terminal_event_seq=projection.terminal_event_seq,
                last_audit_seq=projection.last_audit_seq,
                audit_head_hash=projection.audit_head_hash,
                files=files,
            )
        except SealVerificationError as error:
            raise MaterializationError(str(error), stage="SEAL") from error
        final_files = {**files, "seal.json": built_seal.seal_bytes}
        self._validate_projection_bytes(
            preparation=authoritative,
            expected=final_files,
            built_seal=built_seal,
        )
        publication = self._materialize_and_rename(
            preparation=authoritative,
            expected=final_files,
            built_seal=built_seal,
            publish=True,
        )
        if publication is None:
            raise MaterializationError("verified publication did not return a terminal identity")
        return publication

    def build_verify_and_rename(
        self,
        *,
        preparation: TerminalPreparation,
    ) -> MaterializedRun:
        """Build one closed root without publishing a terminal SQLite state."""

        if type(preparation) is not TerminalPreparation:
            raise TypeError("Materialization requires an exact TerminalPreparation.")
        _require_component(preparation.run_id)
        authoritative = self._store.terminal_preparation(run_id=preparation.run_id)
        if authoritative is None or not _same_terminal_preparation(
            authoritative,
            preparation,
        ):
            raise MaterializationError("terminal preparation changed before materialization")
        if authoritative.disposition != "NORMAL":
            raise MaterializationError("only a NORMAL terminal preparation may materialize")

        projection = self._build_projection(authoritative)
        staged = self._read_staging_evidence(authoritative)
        files = {**projection.files, **staged}
        try:
            built_seal = build_run_seal(
                run_id=authoritative.run_id,
                terminal_state=authoritative.terminal_state,
                terminal_event_seq=projection.terminal_event_seq,
                last_audit_seq=projection.last_audit_seq,
                audit_head_hash=projection.audit_head_hash,
                files=files,
            )
        except SealVerificationError as error:
            raise MaterializationError(str(error), stage="SEAL") from error

        final_files = {**files, "seal.json": built_seal.seal_bytes}
        self._validate_projection_bytes(
            preparation=authoritative,
            expected=final_files,
            built_seal=built_seal,
        )
        self._materialize_and_rename(
            preparation=authoritative,
            expected=final_files,
            built_seal=built_seal,
            publish=False,
        )
        return MaterializedRun(
            run_id=authoritative.run_id,
            terminal_state=authoritative.terminal_state,
            terminal_event_seq=projection.terminal_event_seq,
            last_audit_seq=projection.last_audit_seq,
            audit_head_hash=projection.audit_head_hash,
            seal_bytes=built_seal.seal_bytes,
            seal_digest=built_seal.seal_digest,
        )

    def recover_renamed_and_publish(
        self,
        *,
        preparation: TerminalPreparation,
    ) -> TerminalPublication | None:
        """Reverify and publish an already-renamed root, if one exists."""

        if type(preparation) is not TerminalPreparation:
            raise TypeError("Recovery requires an exact TerminalPreparation.")
        _require_component(preparation.run_id)
        try:
            with self._open_locked_final_root(preparation.run_id) as locked:
                if locked is None:
                    return None
                publication_window: _VerifiedPublicationWindow | None = None
                receipt: _VerifiedFinalRootReceipt | None = None
                proof: _VerifiedRootProof | None = None
                try:
                    existing = self._store.terminal_finalization(run_id=preparation.run_id)
                    if existing is not None:
                        if type(existing) is TerminalPublication:
                            return existing
                        raise FinalizationAlreadyResolved(existing)
                    current = self._store.terminal_preparation(run_id=preparation.run_id)
                    if (
                        current is None
                        or not _same_terminal_preparation(current, preparation)
                        or current.disposition != "NORMAL"
                    ):
                        raise MaterializationError(
                            "terminal preparation changed before renamed-root recovery",
                            stage="PUBLICATION",
                        )
                    try:
                        opened_window = self._store._open_verified_publication_window(
                            preparation=current,
                        )
                    except TerminalPublicationConflict as error:
                        raise MaterializationError(
                            "terminal preparation changed inside the recovery writer window",
                            stage="PUBLICATION",
                        ) from error
                    if type(opened_window) is TerminalPublication:
                        return opened_window
                    if type(opened_window) is UnverifiedTerminalPublication:
                        raise FinalizationAlreadyResolved(opened_window)
                    if type(opened_window) is not _VerifiedPublicationWindow:
                        raise MaterializationError(
                            "renamed-root recovery writer window is invalid",
                            stage="PUBLICATION",
                        )
                    publication_window = opened_window
                    projection = self._build_projection(current)
                    expected, built_seal = self._verified_existing_root_bytes(
                        preparation=current,
                        projection=projection,
                        locked=locked,
                    )
                    child = current.outcome.outcome.child_outcome
                    candidates = () if child is None else child.report_candidates
                    from stark_trading_os.control.finalizer import Finalizer

                    Finalizer(
                        store=self._store,
                        runtime_root=self._runtime_root,
                    ).validate_recovery_reports(
                        current,
                        tuple(
                            (candidate.name, expected[candidate.relative_path])
                            for candidate in candidates
                        ),
                    )
                    receipt = self._verify_projection_root(
                        preparation=current,
                        parent_fd=locked.runs_fd,
                        root_name=current.run_id,
                        expected=expected,
                        built_seal=built_seal,
                        expected_file_mode=0o400,
                        expected_root_mode=0o500,
                        expected_reports_mode=0o500,
                        failure_stage="SEAL",
                        publication_lock_fd=locked.lock_fd,
                        publication_runtime_fd=locked.runtime_fd,
                        publication_runtime_path=self._runtime_root,
                        publication_authority=self._store._publication_authority,
                    )
                    self._verify_final_publication_bindings(
                        runtime_fd=locked.runtime_fd,
                        runs_fd=locked.runs_fd,
                        root_fd=locked.root_fd,
                        root_name=current.run_id,
                        lock_fd=locked.lock_fd,
                    )
                    if type(receipt) is not _VerifiedFinalRootReceipt:
                        raise MaterializationError(
                            "renamed-root verifier did not issue a publication receipt",
                            stage="PUBLICATION",
                        )
                    proof = _VerifiedRootProof._issue_from_locked_root(
                        run_id=current.run_id,
                        terminal_state=current.terminal_state,
                        terminal_event_seq=current.event.seq,
                        last_audit_seq=current.audit_intent.audit_seq,
                        seal_digest=built_seal.seal_digest,
                        root_receipt=receipt,
                        authority=self._store._publication_authority,
                    )
                    try:
                        return self._store._publish_verified_terminal(proof=proof)
                    except (
                        TerminalEligibilityError,
                        TerminalIntegrityError,
                        TerminalPublicationConflict,
                    ) as error:
                        raise MaterializationError(
                            "renamed-root proof conflicts with terminal authority",
                            stage="PUBLICATION",
                        ) from error
                finally:
                    primary_exception = sys.exc_info()[0] is not None
                    cleanup_error: BaseException | None = None
                    if publication_window is not None:
                        try:
                            self._store._discard_verified_publication_window(publication_window)
                        except BaseException as error:
                            cleanup_error = error
                    if proof is not None:
                        try:
                            proof._discard()
                        except BaseException as error:
                            if cleanup_error is None:
                                cleanup_error = error
                    if receipt is not None:
                        try:
                            receipt._discard()
                        except BaseException as error:
                            if cleanup_error is None:
                                cleanup_error = error
                    if not primary_exception and cleanup_error is not None:
                        raise _PublicationTeardownFailure(cleanup_error) from cleanup_error
        except _PublicationTeardownFailure as error:
            raise error.error

    def read_verified_artifact(
        self,
        *,
        publication: TerminalPublication,
        relative_path: str,
    ) -> bytes | None:
        """Read one byte artifact after a fresh closed-root verification."""

        if type(publication) is not TerminalPublication:
            raise TypeError("Artifact reads require an exact TerminalPublication.")
        if type(relative_path) is not str or not relative_path:
            raise ValueError("relative_path must be a non-empty string.")
        return self.read_verified_artifacts(
            publication=publication,
            relative_paths=(_legacy_artifact_path(relative_path),),
        )[0]

    def read_verified_artifacts(
        self,
        *,
        publication: TerminalPublication,
        relative_paths: tuple[str, ...],
    ) -> tuple[bytes | None, ...]:
        """Read trusted internal paths from one freshly verified closed root."""

        if type(publication) is not TerminalPublication:
            raise TypeError("Artifact reads require an exact TerminalPublication.")
        if type(relative_paths) is not tuple:
            raise TypeError("relative_paths must be an exact tuple.")
        if not relative_paths:
            raise ValueError("relative_paths must not be empty.")
        seen: set[str] = set()
        for relative_path in relative_paths:
            if type(relative_path) is not str:
                raise TypeError("Every relative path must be an exact string.")
            if not _is_normalized_artifact_path(relative_path):
                raise ValueError("Every relative path must be a normalized relative path.")
            if relative_path in seen:
                raise ValueError("relative_paths must not contain duplicates.")
            seen.add(relative_path)
        try:
            with self._open_locked_final_root(publication.run_id) as locked:
                if locked is None:
                    raise MaterializationError("published final root is missing", stage="SEAL")
                current = self._store.terminal_finalization(run_id=publication.run_id)
                if type(current) is not TerminalPublication or current != publication:
                    raise MaterializationError(
                        "verified terminal authority changed before artifact access",
                        stage="PUBLICATION",
                    )
                preparation = self._store.terminal_preparation(run_id=publication.run_id)
                if preparation is None or preparation.disposition != "NORMAL":
                    raise MaterializationError(
                        "verified terminal lacks its normal preparation",
                        stage="PUBLICATION",
                    )
                projection = self._build_projection(
                    preparation,
                    publication=publication,
                )
                expected, built_seal = self._verified_existing_root_bytes(
                    preparation=preparation,
                    projection=projection,
                    locked=locked,
                    external_seal_digest=publication.seal_digest,
                )
                self._verify_final_publication_bindings(
                    runtime_fd=locked.runtime_fd,
                    runs_fd=locked.runs_fd,
                    root_fd=locked.root_fd,
                    root_name=publication.run_id,
                    lock_fd=locked.lock_fd,
                )
                if self._store.terminal_finalization(run_id=publication.run_id) != publication:
                    raise MaterializationError(
                        "verified terminal authority changed during artifact access",
                        stage="PUBLICATION",
                    )
                if built_seal.seal_digest != publication.seal_digest:
                    raise MaterializationError("external seal digest changed", stage="SEAL")
                return tuple(expected.get(relative_path) for relative_path in relative_paths)
        except _PublicationTeardownFailure as error:
            raise error.error

    @contextmanager
    def _open_locked_final_root(
        self,
        run_id: str,
    ) -> Iterator[_LockedFinalRoot | None]:
        runtime_fd = runs_fd = root_fd = lock_fd = -1
        flocked = False
        with _PROCESS_PUBLISH_LOCK:
            try:
                runtime_fd = _open_configured_directory(
                    self._runtime_root,
                    expected_mode=0o700,
                    expected_uid=self._service_uid,
                )
                runs_fd = _open_child_directory(
                    runtime_fd,
                    "runs",
                    expected_mode=0o700,
                    expected_uid=self._service_uid,
                )
                lock_fd = _open_publish_lock(runtime_fd, expected_uid=self._service_uid)
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                flocked = True
                _require_configured_directory_binding(
                    runtime_fd,
                    self._runtime_root,
                    expected_uid=self._service_uid,
                    label="runtime_root pathname",
                )
                _require_parent_binding(
                    runs_fd,
                    runtime_fd,
                    "runs",
                    expected_uid=self._service_uid,
                )
                _require_fd_name_identity(
                    lock_fd,
                    runtime_fd,
                    _PUBLISH_LOCK_NAME,
                    label="lock pathname",
                )
                try:
                    os.stat(run_id, dir_fd=runs_fd, follow_symlinks=False)
                except FileNotFoundError:
                    yield None
                    return
                root_fd = _open_child_directory(
                    runs_fd,
                    run_id,
                    expected_mode=0o500,
                    expected_uid=self._service_uid,
                )
                self._verify_final_publication_bindings(
                    runtime_fd=runtime_fd,
                    runs_fd=runs_fd,
                    root_fd=root_fd,
                    root_name=run_id,
                    lock_fd=lock_fd,
                )
                yield _LockedFinalRoot(
                    runtime_fd=runtime_fd,
                    runs_fd=runs_fd,
                    root_fd=root_fd,
                    lock_fd=lock_fd,
                )
            except MaterializationError as error:
                raise _with_stage(error, "SEAL") from error
            except OSError as error:
                raise _filesystem_os_error(
                    "final root could not be locked safely",
                    error,
                    stage="SEAL",
                ) from error
            finally:
                primary_exception = sys.exc_info()[0] is not None
                cleanup_error: BaseException | None = None
                if flocked:
                    try:
                        fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    except BaseException as error:
                        cleanup_error = error
                for descriptor in (root_fd, lock_fd, runs_fd, runtime_fd):
                    if descriptor < 0:
                        continue
                    try:
                        os.close(descriptor)
                    except BaseException as error:
                        if cleanup_error is None:
                            cleanup_error = error
                if not primary_exception and cleanup_error is not None:
                    raise _PublicationTeardownFailure(cleanup_error) from cleanup_error

    def _verified_existing_root_bytes(
        self,
        *,
        preparation: TerminalPreparation,
        projection: _Projection,
        locked: _LockedFinalRoot,
        external_seal_digest: str | None = None,
    ) -> tuple[dict[str, bytes], BuiltSeal]:
        evidence = self._read_final_root_evidence(
            preparation=preparation,
            root_fd=locked.root_fd,
            projection=projection,
        )
        files = {**projection.files, **evidence}
        try:
            built_seal = build_run_seal(
                run_id=preparation.run_id,
                terminal_state=preparation.terminal_state,
                terminal_event_seq=projection.terminal_event_seq,
                last_audit_seq=projection.last_audit_seq,
                audit_head_hash=projection.audit_head_hash,
                files=files,
            )
        except SealVerificationError as error:
            raise MaterializationError(str(error), stage="SEAL") from error
        if external_seal_digest is not None and built_seal.seal_digest != external_seal_digest:
            raise MaterializationError(
                "external seal digest changed",
                stage="SEAL",
                artifact="control.sqlite:seals",
            )
        expected = {**files, "seal.json": built_seal.seal_bytes}
        self._validate_projection_bytes(
            preparation=preparation,
            expected=expected,
            built_seal=built_seal,
        )
        self._verify_projection_root(
            preparation=preparation,
            parent_fd=locked.runs_fd,
            root_name=preparation.run_id,
            expected=expected,
            built_seal=built_seal,
            expected_file_mode=0o400,
            expected_root_mode=0o500,
            expected_reports_mode=0o500,
            failure_stage="SEAL",
        )
        return expected, built_seal

    def _build_projection(
        self,
        preparation: TerminalPreparation,
        *,
        publication: TerminalPublication | None = None,
    ) -> _Projection:
        record = preparation.run_record
        if type(record) is not RunRecordV1:
            raise MaterializationError("normal preparation lacks its planned run record")
        preflight = self._store.preflight(record.preflight_id)
        if preflight is None:
            raise MaterializationError("terminal preflight authority is missing")
        run = self._store.run(preparation.run_id)
        outcome = preparation.outcome
        outcome_value = outcome.outcome
        child = outcome_value.child_outcome
        if publication is None:
            run_identity_matches = (
                run.state is RunState.FINALIZING
                and run.state_version + 1 == preparation.terminal_state_version
                and run.last_event_seq + 1 == preparation.event.seq
                and run.last_audit_seq + 1 == preparation.audit_intent.audit_seq
                and run.evidence_status in {"STAGING", "PARTIAL"}
            )
        else:
            run_identity_matches = (
                publication.run_id == preparation.run_id
                and publication.state is preparation.terminal_state
                and publication.state_version == preparation.terminal_state_version
                and publication.event.seq == preparation.event.seq
                and publication.audit_intent == preparation.audit_intent
                and run.state is preparation.terminal_state
                and run.state_version == preparation.terminal_state_version
                and run.last_event_seq == preparation.event.seq
                and run.last_audit_seq == preparation.audit_intent.audit_seq
                and run.evidence_status == "VERIFIED"
            )
        if (
            preflight.preflight_id != record.preflight_id
            or preflight.run_id != preparation.run_id
            or preflight.status != "PREFLIGHT_READY"
            or preflight.consumed_at_ns is None
            or preflight.input_manifest_bytes is None
            or preflight.input_manifest_hash is None
            or sha256(preflight.request_bytes).hexdigest() != preflight.request_hash
            or sha256(preflight.input_manifest_bytes).hexdigest() != preflight.input_manifest_hash
            or run.run_id != preparation.run_id
            or not run_identity_matches
            or run.input_manifest_bytes != preflight.input_manifest_bytes
            or run.input_manifest_hash != preflight.input_manifest_hash
            or run.catalog_revision != preflight.catalog_revision
            or run.catalog_inventory_hash != preflight.catalog_inventory_hash
            or record.created_at_ns != str(run.created_at_ns)
            or outcome.run_id != preparation.run_id
            or sha256(outcome.outcome_bytes).hexdigest() != outcome.outcome_hash
            or outcome_value.run_id != preparation.run_id
            or outcome_value.proposed_terminal_state != preparation.terminal_state.value
            or (
                child is not None
                and (
                    child.run_id != preparation.run_id
                    or child.input_manifest_hash != preflight.input_manifest_hash
                    or child.catalog_revision != preflight.catalog_revision
                )
            )
        ):
            raise MaterializationError("SQLite authority does not bind one terminal identity")
        self._verify_exact_canonical(
            preflight.request_bytes,
            "request",
            declared_root=True,
        )
        self._verify_exact_canonical(preflight.result_bytes, "preflight")
        self._verify_exact_canonical(
            preflight.input_manifest_bytes,
            "input manifest",
            declared_root=True,
        )
        self._verify_run_record(preparation)

        committed_events = self._store.events(preparation.run_id)
        committed_audits = self._store.audit_intents(preparation.run_id)
        if publication is None:
            events = (*committed_events, preparation.event)
            audits = (*committed_audits, preparation.audit_intent)
        else:
            if (
                not committed_events
                or committed_events[-1] != publication.event
                or not committed_audits
                or committed_audits[-1] != publication.audit_intent
            ):
                raise MaterializationError("published terminal history differs from authority")
            events = (*committed_events[:-1], preparation.event)
            audits = committed_audits
        if (
            len(events) != preparation.event.seq
            or len(audits) != preparation.audit_intent.audit_seq
        ):
            raise MaterializationError("terminal event or audit boundary is not contiguous")

        event_bytes: list[bytes] = []
        event_digests: dict[int, str] = {}
        event_ingest_ns: dict[int, int] = {}
        control_source_seq = 0
        runner_source_seq = 0
        for expected_seq, event in enumerate(events, start=1):
            is_prepared = expected_seq == len(events)
            envelope = _validate_persisted_event(
                event,
                run_id=preparation.run_id,
                expected_seq=expected_seq,
                prepared=is_prepared,
            )
            if event.source == "control-api":
                control_source_seq += 1
                if event.source_seq != control_source_seq:
                    raise MaterializationError("control source sequence is not contiguous")
            else:
                runner_source_seq += 1
                if event.source_seq != runner_source_seq:
                    raise MaterializationError("runner source sequence is not contiguous")
            event_bytes.append(event.envelope_bytes)
            event_digests[expected_seq] = sha256(event.envelope_bytes).hexdigest()
            event_ingest_ns[expected_seq] = int(envelope.ts_ingest_ns)
            if envelope.seq != expected_seq:
                raise MaterializationError("event envelope sequence changed")

        if preparation.initial_event_digest != event_digests[preparation.event.seq]:
            raise MaterializationError("prepared initial event digest changed")
        if preparation.event.type != _TERMINAL_EVENT_BY_STATE[preparation.terminal_state]:
            raise MaterializationError("prepared terminal event type differs from state")
        if child is not None:
            if runner_source_seq != child.last_source_seq:
                raise MaterializationError("runner event boundary differs from child outcome")
        elif outcome_value.classification == "NO_SPAWN_CANCELLED":
            if runner_source_seq != 0:
                raise MaterializationError("no-spawn cancellation contains runner events")
        elif outcome_value.classification != "SUPERVISOR_FAILURE":
            raise MaterializationError("missing child outcome is not a valid frozen prefix")

        unhashed_audits: list[dict[str, object]] = []
        for expected_seq, audit in enumerate(audits, start=1):
            intent = _validate_audit_intent(
                audit,
                run_id=preparation.run_id,
                expected_seq=expected_seq,
                event_digests=event_digests,
                event_ingest_ns=event_ingest_ns,
            )
            unhashed_audits.append(intent)
        try:
            chained_audits = append_hash_chain(unhashed_audits)
            verify_hash_chain(chained_audits)
        except ValueError as error:
            raise MaterializationError("audit hash chain is invalid") from error
        audit_head_hash = cast(str, chained_audits[-1]["entry_hash"])
        events_ndjson = b"".join(raw + b"\n" for raw in event_bytes)
        audit_ndjson = b"".join(canonical_json_bytes(item) + b"\n" for item in chained_audits)
        run_record_bytes = canonical_json_bytes(record.model_dump(mode="json", by_alias=True))
        return _Projection(
            files={
                "request.json": preflight.request_bytes,
                "preflight.json": preflight.result_bytes,
                "run-record.json": run_record_bytes,
                "events.ndjson": events_ndjson,
                "audit.ndjson": audit_ndjson,
            },
            terminal_event_seq=preparation.event.seq,
            last_audit_seq=preparation.audit_intent.audit_seq,
            audit_head_hash=audit_head_hash,
        )

    def _verify_run_record(self, preparation: TerminalPreparation) -> None:
        record = preparation.run_record
        if type(record) is not RunRecordV1:
            raise MaterializationError("normal preparation lacks its planned run record")
        outcome = preparation.outcome.outcome
        record_value = record.model_dump(mode="json", by_alias=True)
        runner_identity = record_value["runner_identity"]
        runner_identity_digest = (
            None
            if runner_identity is None
            else sha256(canonical_json_bytes(runner_identity)).hexdigest()
        )
        if (
            type(record) is not RunRecordV1
            or record.run_id != preparation.run_id
            or record.idempotency_scope != "backtest.create"
            or record.state is not preparation.terminal_state
            or record.state_version != preparation.terminal_state_version
            or record.prepared_terminal_state is not preparation.terminal_state
            or record.prepared_terminal_state_version != preparation.terminal_state_version
            or record.started_at_ns
            != (None if outcome.launched_at_ns is None else str(outcome.launched_at_ns))
            or record.completed_at_ns != str(outcome.ended_at_ns)
            or record.duration_ns != str(outcome.duration_ns)
            or runner_identity_digest != outcome.process_identity_sha256
            or record_value["runner_exit"] != outcome.model_dump(mode="json", by_alias=True)
            or record.materialized_event_seq != preparation.event.seq
            or record.materialized_audit_seq != preparation.audit_intent.audit_seq
            or record.evidence_status != "VERIFIED"
        ):
            raise MaterializationError("planned RunRecord does not match preparation")
        canonical_json_bytes(record_value)

    def _read_staging_evidence(
        self,
        preparation: TerminalPreparation,
    ) -> dict[str, bytes]:
        outcome = preparation.outcome.outcome
        child = outcome.child_outcome
        reports = () if child is None else child.report_candidates
        report_paths = tuple(candidate.relative_path for candidate in reports)
        if report_paths != tuple(f"reports/{name}.json" for name in _REPORT_NAMES[: len(reports)]):
            raise MaterializationError(
                "runner reports are not the fixed path prefix",
                stage="REPORTS",
            )
        if preparation.terminal_state is RunState.COMPLETED and len(reports) != 5:
            raise MaterializationError("COMPLETED requires all five reports", stage="REPORTS")
        if outcome.classification == "NO_SPAWN_CANCELLED" and reports:
            raise MaterializationError(
                "no-spawn cancellation cannot contain reports",
                stage="REPORTS",
            )

        runtime_fd = staging_fd = run_fd = reports_fd = -1
        try:
            runtime_fd = _open_configured_directory(
                self._runtime_root,
                expected_mode=0o700,
                expected_uid=self._service_uid,
            )
            staging_fd = _open_child_directory(
                runtime_fd,
                "staging",
                expected_mode=0o700,
                expected_uid=self._service_uid,
            )
            run_fd = _open_child_directory(
                staging_fd,
                preparation.run_id,
                expected_mode=0o700,
                expected_uid=self._service_uid,
            )
            directory_before = os.fstat(run_fd)
            expected_top = {"input-manifest.json", "runner-exit.json", "stderr.txt"}
            if reports:
                expected_top.add("reports")
            if set(os.listdir(run_fd)) != expected_top:
                raise MaterializationError("staging root inventory is not closed", stage="STAGING")

            manifest_bytes = self._store.run(preparation.run_id).input_manifest_bytes
            if manifest_bytes is None:
                raise MaterializationError("input manifest authority disappeared", stage="STAGING")
            try:
                staged: dict[str, bytes] = {
                    "input-manifest.json": _read_regular_file(
                        run_fd,
                        "input-manifest.json",
                        expected_uid=self._service_uid,
                        expected_mode=0o600,
                        expected_size=len(manifest_bytes),
                        expected_hash=sha256(manifest_bytes).hexdigest(),
                        expected_bytes=manifest_bytes,
                    ),
                    "runner-exit.json": _read_regular_file(
                        run_fd,
                        "runner-exit.json",
                        expected_uid=self._service_uid,
                        expected_mode=0o600,
                        expected_size=len(preparation.outcome.outcome_bytes),
                        expected_hash=preparation.outcome.outcome_hash,
                        expected_bytes=preparation.outcome.outcome_bytes,
                    ),
                    "stderr.txt": _read_regular_file(
                        run_fd,
                        "stderr.txt",
                        expected_uid=self._service_uid,
                        expected_mode=0o600,
                        expected_size=outcome.stderr_size_bytes,
                        expected_hash=outcome.stderr_sha256,
                        expected_bytes=None,
                    ),
                }
            except MaterializationError as error:
                raise _with_stage(error, "STAGING") from error
            if reports:
                try:
                    reports_fd = _open_child_directory(
                        run_fd,
                        "reports",
                        expected_mode=0o700,
                        expected_uid=self._service_uid,
                    )
                    expected_report_names = {f"{candidate.name}.json" for candidate in reports}
                    if set(os.listdir(reports_fd)) != expected_report_names:
                        raise MaterializationError("staging report inventory is not closed")
                    reports_before = os.fstat(reports_fd)
                    for candidate in reports:
                        name = f"{candidate.name}.json"
                        staged[candidate.relative_path] = _read_regular_file(
                            reports_fd,
                            name,
                            expected_uid=self._service_uid,
                            expected_mode=0o600,
                            expected_size=candidate.size_bytes,
                            expected_hash=candidate.sha256,
                            expected_bytes=None,
                        )
                    if set(
                        os.listdir(reports_fd)
                    ) != expected_report_names or not _same_directory_identity(
                        reports_before, os.fstat(reports_fd)
                    ):
                        raise MaterializationError("staging reports changed while read")
                except MaterializationError as error:
                    raise _with_stage(error, "REPORTS") from error
                except OSError as error:
                    raise _filesystem_os_error(
                        "staging reports could not be read safely",
                        error,
                        stage="REPORTS",
                    ) from error
            if set(os.listdir(run_fd)) != expected_top or not _same_directory_identity(
                directory_before, os.fstat(run_fd)
            ):
                raise MaterializationError("staging root changed while read", stage="STAGING")
            return staged
        except MaterializationError:
            raise
        except OSError as error:
            raise _filesystem_os_error(
                "staging evidence could not be read safely",
                error,
                stage="STAGING",
            ) from error
        finally:
            _close_all(reports_fd, run_fd, staging_fd, runtime_fd)

    def _read_final_root_evidence(
        self,
        *,
        preparation: TerminalPreparation,
        root_fd: int,
        projection: _Projection,
    ) -> dict[str, bytes]:
        """Read variable evidence from a named immutable root using SQLite hashes."""

        outcome = preparation.outcome.outcome
        child = outcome.child_outcome
        reports = () if child is None else child.report_candidates
        report_paths = tuple(candidate.relative_path for candidate in reports)
        if report_paths != tuple(f"reports/{name}.json" for name in _REPORT_NAMES[: len(reports)]):
            raise MaterializationError("final report paths are not the fixed prefix", stage="SEAL")
        expected_top = set(projection.files) | {
            "input-manifest.json",
            "runner-exit.json",
            "stderr.txt",
            "seal.json",
        }
        if reports:
            expected_top.add("reports")
        root_before = os.fstat(root_fd)
        observed_top = set(os.listdir(root_fd))
        if observed_top != expected_top:
            raise MaterializationError(
                "final root inventory is not closed",
                stage="SEAL",
                artifact=_first_inventory_mismatch(observed_top, expected_top),
            )
        run = self._store.run(preparation.run_id)
        manifest_bytes = run.input_manifest_bytes
        if manifest_bytes is None:
            raise MaterializationError("input manifest authority disappeared", stage="SEAL")
        reports_fd = -1
        try:
            evidence: dict[str, bytes] = {
                "input-manifest.json": _read_regular_file(
                    root_fd,
                    "input-manifest.json",
                    expected_uid=self._service_uid,
                    expected_mode=0o400,
                    expected_size=len(manifest_bytes),
                    expected_hash=sha256(manifest_bytes).hexdigest(),
                    expected_bytes=manifest_bytes,
                    artifact="input-manifest.json",
                ),
                "runner-exit.json": _read_regular_file(
                    root_fd,
                    "runner-exit.json",
                    expected_uid=self._service_uid,
                    expected_mode=0o400,
                    expected_size=len(preparation.outcome.outcome_bytes),
                    expected_hash=preparation.outcome.outcome_hash,
                    expected_bytes=preparation.outcome.outcome_bytes,
                    artifact="runner-exit.json",
                ),
                "stderr.txt": _read_regular_file(
                    root_fd,
                    "stderr.txt",
                    expected_uid=self._service_uid,
                    expected_mode=0o400,
                    expected_size=outcome.stderr_size_bytes,
                    expected_hash=outcome.stderr_sha256,
                    expected_bytes=None,
                    artifact="stderr.txt",
                ),
            }
            if reports:
                try:
                    reports_fd = _open_child_directory(
                        root_fd,
                        "reports",
                        expected_mode=0o500,
                        expected_uid=self._service_uid,
                    )
                except MaterializationError as error:
                    raise MaterializationError(
                        str(error),
                        deterministic=error.deterministic,
                        stage="SEAL",
                        artifact="reports",
                    ) from error
                reports_before = os.fstat(reports_fd)
                expected_report_names = {f"{candidate.name}.json" for candidate in reports}
                observed_report_names = set(os.listdir(reports_fd))
                if observed_report_names != expected_report_names:
                    raise MaterializationError(
                        "final reports inventory is not closed",
                        stage="SEAL",
                        artifact=_first_inventory_mismatch(
                            observed_report_names,
                            expected_report_names,
                            prefix="reports/",
                        ),
                    )
                for candidate in reports:
                    name = f"{candidate.name}.json"
                    evidence[candidate.relative_path] = _read_regular_file(
                        reports_fd,
                        name,
                        expected_uid=self._service_uid,
                        expected_mode=0o400,
                        expected_size=candidate.size_bytes,
                        expected_hash=candidate.sha256,
                        expected_bytes=None,
                        artifact=candidate.relative_path,
                    )
                if set(os.listdir(reports_fd)) != expected_report_names or not (
                    _same_directory_identity(reports_before, os.fstat(reports_fd))
                ):
                    raise MaterializationError(
                        "final reports changed while read",
                        stage="SEAL",
                        artifact="reports",
                    )
            if set(os.listdir(root_fd)) != expected_top or not _same_directory_identity(
                root_before,
                os.fstat(root_fd),
            ):
                raise MaterializationError(
                    "final root changed while read",
                    stage="SEAL",
                    artifact="<root>",
                )
            return evidence
        except MaterializationError as error:
            raise _with_stage(error, "SEAL") from error
        except OSError as error:
            raise _filesystem_os_error(
                "final evidence could not be read safely",
                error,
                stage="SEAL",
            ) from error
        finally:
            _close_all(reports_fd)

    def _materialize_and_rename(
        self,
        *,
        preparation: TerminalPreparation,
        expected: Mapping[str, bytes],
        built_seal: BuiltSeal,
        publish: bool,
    ) -> TerminalPublication | None:
        runtime_fd = materializing_fd = runs_fd = temp_fd = -1
        temp_name = f".tmp-{uuid.uuid4().hex}"
        try:
            runtime_fd = _open_configured_directory(
                self._runtime_root,
                expected_mode=0o700,
                expected_uid=self._service_uid,
            )
            materializing_fd = _open_or_create_directory(
                runtime_fd,
                ".materializing",
                expected_uid=self._service_uid,
            )
            runs_fd = _open_child_directory(
                runtime_fd,
                "runs",
                expected_mode=0o700,
                expected_uid=self._service_uid,
            )
            try:
                os.mkdir(temp_name, mode=0o700, dir_fd=materializing_fd)
            except FileExistsError as error:
                raise MaterializationError("materialization temp identity collided") from error
            _fsync(materializing_fd)
            temp_fd = _open_child_directory(
                materializing_fd,
                temp_name,
                expected_mode=0o700,
                expected_uid=self._service_uid,
            )
            self._write_projection(temp_fd=temp_fd, expected=expected)
            _fsync(temp_fd)
            _fsync(materializing_fd)
            self._verify_projection_root(
                preparation=preparation,
                parent_fd=materializing_fd,
                root_name=temp_name,
                expected=expected,
                built_seal=built_seal,
                expected_file_mode=0o600,
                expected_root_mode=0o700,
                expected_reports_mode=0o700,
                failure_stage="MATERIALIZATION",
            )
            self._make_projection_immutable(temp_fd=temp_fd, expected=expected)
            _fsync(temp_fd)
            _fsync(materializing_fd)
            self._verify_projection_root(
                preparation=preparation,
                parent_fd=materializing_fd,
                root_name=temp_name,
                expected=expected,
                built_seal=built_seal,
                expected_file_mode=0o400,
                expected_root_mode=0o700,
                expected_reports_mode=0o500,
                failure_stage="MATERIALIZATION",
            )
            return self._locked_no_replace_rename(
                preparation=preparation,
                expected=expected,
                built_seal=built_seal,
                runtime_fd=runtime_fd,
                root_fd=temp_fd,
                source_parent_fd=materializing_fd,
                source_name=temp_name,
                destination_parent_fd=runs_fd,
                destination_name=preparation.run_id,
                publish=publish,
            )
        except _PublicationTeardownFailure as error:
            raise error.error
        except MaterializationError:
            raise
        except OSError as error:
            raise _filesystem_os_error(
                "materialization filesystem operation failed",
                error,
                stage="MATERIALIZATION",
            ) from error
        finally:
            _close_all(temp_fd, runs_fd, materializing_fd, runtime_fd)

    def _write_projection(self, *, temp_fd: int, expected: Mapping[str, bytes]) -> None:
        reports_fd = -1
        try:
            report_paths = sorted(path for path in expected if path.startswith("reports/"))
            if report_paths:
                os.mkdir("reports", mode=0o700, dir_fd=temp_fd)
                _fsync(temp_fd)
                reports_fd = _open_child_directory(
                    temp_fd,
                    "reports",
                    expected_mode=0o700,
                    expected_uid=self._service_uid,
                )
            for relative_path, payload in sorted(expected.items()):
                if relative_path.startswith("reports/"):
                    if reports_fd < 0:
                        raise MaterializationError("report directory was not created")
                    _write_projection_file(
                        reports_fd,
                        relative_path.removeprefix("reports/"),
                        payload,
                        expected_uid=self._service_uid,
                    )
                else:
                    _write_projection_file(
                        temp_fd,
                        relative_path,
                        payload,
                        expected_uid=self._service_uid,
                    )
            if reports_fd >= 0:
                _fsync(reports_fd)
            _fsync(temp_fd)
        finally:
            _close_all(reports_fd)

    def _make_projection_immutable(
        self,
        *,
        temp_fd: int,
        expected: Mapping[str, bytes],
    ) -> None:
        reports_fd = -1
        try:
            if any(path.startswith("reports/") for path in expected):
                reports_fd = _open_child_directory(
                    temp_fd,
                    "reports",
                    expected_mode=0o700,
                    expected_uid=self._service_uid,
                )
            for relative_path in sorted(expected):
                parent_fd = reports_fd if relative_path.startswith("reports/") else temp_fd
                name = relative_path.removeprefix("reports/")
                descriptor = -1
                try:
                    descriptor = os.open(name, _READ_FLAGS, dir_fd=parent_fd)
                    _verify_regular_metadata(
                        os.fstat(descriptor),
                        expected_uid=self._service_uid,
                        expected_mode=0o600,
                        expected_size=len(expected[relative_path]),
                    )
                    os.fchmod(descriptor, 0o400)
                    _fsync(descriptor)
                    _verify_regular_metadata(
                        os.fstat(descriptor),
                        expected_uid=self._service_uid,
                        expected_mode=0o400,
                        expected_size=len(expected[relative_path]),
                    )
                finally:
                    _close_all(descriptor)
            if reports_fd >= 0:
                os.fchmod(reports_fd, 0o500)
                _fsync(reports_fd)
                _verify_directory_metadata(
                    os.fstat(reports_fd),
                    expected_uid=self._service_uid,
                    expected_mode=0o500,
                )
            # macOS refuses to rename a 0500 source directory. The retained
            # root stays private 0700 until the successful no-replace move;
            # the locked move immediately changes it to final mode below.
            os.fchmod(temp_fd, 0o700)
            _fsync(temp_fd)
            _verify_directory_metadata(
                os.fstat(temp_fd),
                expected_uid=self._service_uid,
                expected_mode=0o700,
            )
        finally:
            _close_all(reports_fd)

    def _verify_projection_root(
        self,
        *,
        preparation: TerminalPreparation,
        parent_fd: int,
        root_name: str,
        expected: Mapping[str, bytes],
        built_seal: BuiltSeal,
        expected_file_mode: int,
        expected_root_mode: int,
        expected_reports_mode: int,
        failure_stage: MaterializationStage,
        publication_lock_fd: int | None = None,
        publication_runtime_fd: int | None = None,
        publication_runtime_path: Path | None = None,
        publication_authority: object | None = None,
    ) -> _VerifiedFinalRootReceipt | None:
        root_fd = reports_fd = -1
        try:
            root_fd = _open_child_directory(
                parent_fd,
                root_name,
                expected_mode=expected_root_mode,
                expected_uid=self._service_uid,
            )
            root_before = os.fstat(root_fd)
            report_paths = tuple(path for path in expected if path.startswith("reports/"))
            expected_top = {path for path in expected if not path.startswith("reports/")}
            if report_paths:
                expected_top.add("reports")
            if set(os.listdir(root_fd)) != expected_top:
                raise MaterializationError("materialized root inventory is not closed")
            if report_paths:
                reports_fd = _open_child_directory(
                    root_fd,
                    "reports",
                    expected_mode=expected_reports_mode,
                    expected_uid=self._service_uid,
                )
                reports_before = os.fstat(reports_fd)
                expected_names = {path.removeprefix("reports/") for path in report_paths}
                if set(os.listdir(reports_fd)) != expected_names:
                    raise MaterializationError("materialized reports inventory is not closed")
            else:
                reports_before = None

            observed: dict[str, bytes] = {}
            for relative_path, payload in expected.items():
                parent = reports_fd if relative_path.startswith("reports/") else root_fd
                name = relative_path.removeprefix("reports/")
                observed[relative_path] = _read_regular_file(
                    parent,
                    name,
                    expected_uid=self._service_uid,
                    expected_mode=expected_file_mode,
                    expected_size=len(payload),
                    expected_hash=sha256(payload).hexdigest(),
                    expected_bytes=payload,
                    artifact=relative_path,
                )
            if reports_fd >= 0 and (
                set(os.listdir(reports_fd))
                != {path.removeprefix("reports/") for path in report_paths}
                or reports_before is None
                or not _same_directory_identity(reports_before, os.fstat(reports_fd))
            ):
                raise MaterializationError("materialized reports changed while verified")
            if set(os.listdir(root_fd)) != expected_top or not _same_directory_identity(
                root_before, os.fstat(root_fd)
            ):
                raise MaterializationError("materialized root changed while verified")
            self._validate_projection_bytes(
                preparation=preparation,
                expected=observed,
                built_seal=built_seal,
            )
            if publication_lock_fd is not None:
                if (
                    publication_authority is None
                    or publication_runtime_fd is None
                    or publication_runtime_path is None
                ):
                    raise MaterializationError(
                        "final-root verifier lacks its store-bound publication authority",
                        stage="PUBLICATION",
                    )
                retained = _retain_final_root_verification(
                    runtime_fd=publication_runtime_fd,
                    runtime_path=publication_runtime_path,
                    runs_fd=parent_fd,
                    root_fd=root_fd,
                    root_name=root_name,
                    reports_fd=reports_fd,
                    expected=expected,
                    expected_uid=self._service_uid,
                    expected_file_mode=expected_file_mode,
                    expected_root_mode=expected_root_mode,
                    expected_reports_mode=expected_reports_mode,
                )
                try:
                    lock_guard_fd = os.dup(publication_lock_fd)
                except OSError:
                    retained._discard()
                    raise
                receipt = object.__new__(_VerifiedFinalRootReceipt)
                receipt._lock_guard_fd = lock_guard_fd
                receipt._retained = retained
                receipt._consumed = False
                _VERIFIED_FINAL_ROOT_RECEIPTS[id(receipt)] = publication_authority
                return receipt
            return None
        except MaterializationError as error:
            raise _with_stage(error, failure_stage) from error
        except OSError as error:
            raise _filesystem_os_error(
                "materialized root could not be verified safely",
                error,
                stage=failure_stage,
            ) from error
        finally:
            _close_all(reports_fd, root_fd)

    def _locked_no_replace_rename(
        self,
        *,
        preparation: TerminalPreparation,
        expected: Mapping[str, bytes],
        built_seal: BuiltSeal,
        runtime_fd: int,
        root_fd: int,
        source_parent_fd: int,
        source_name: str,
        destination_parent_fd: int,
        destination_name: str,
        publish: bool,
    ) -> TerminalPublication | None:
        lock_fd = -1
        renamed = False
        receipt: _VerifiedFinalRootReceipt | None = None
        proof: _VerifiedRootProof | None = None
        publication_window: _VerifiedPublicationWindow | None = None
        with _PROCESS_PUBLISH_LOCK:
            try:
                lock_fd = _open_publish_lock(
                    runtime_fd,
                    expected_uid=self._service_uid,
                )
                _verify_regular_metadata(
                    os.fstat(lock_fd),
                    expected_uid=self._service_uid,
                    expected_mode=0o600,
                    expected_size=0,
                )
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                _require_fd_name_identity(
                    lock_fd,
                    runtime_fd,
                    _PUBLISH_LOCK_NAME,
                    label="lock pathname",
                )
                _verify_regular_metadata(
                    os.fstat(lock_fd),
                    expected_uid=self._service_uid,
                    expected_mode=0o600,
                    expected_size=0,
                )
                _require_parent_binding(
                    source_parent_fd,
                    runtime_fd,
                    ".materializing",
                    expected_uid=self._service_uid,
                )
                _require_parent_binding(
                    destination_parent_fd,
                    runtime_fd,
                    "runs",
                    expected_uid=self._service_uid,
                )
                _require_fd_name_identity(
                    root_fd,
                    source_parent_fd,
                    source_name,
                    label="source root pathname",
                )
                _verify_directory_metadata(
                    os.fstat(root_fd),
                    expected_uid=self._service_uid,
                    expected_mode=0o700,
                )
                _require_configured_directory_binding(
                    runtime_fd,
                    self._runtime_root,
                    expected_uid=self._service_uid,
                    label="runtime_root pathname",
                )
                existing = self._store.terminal_finalization(run_id=preparation.run_id)
                if existing is not None:
                    if type(existing) is TerminalPublication:
                        return existing
                    raise FinalizationAlreadyResolved(existing)
                current = self._store.terminal_preparation(run_id=preparation.run_id)
                if (
                    current is None
                    or not _same_terminal_preparation(current, preparation)
                    or current.disposition != "NORMAL"
                ):
                    existing = self._store.terminal_finalization(run_id=preparation.run_id)
                    if existing is not None:
                        if type(existing) is TerminalPublication:
                            return existing
                        raise FinalizationAlreadyResolved(existing)
                    raise MaterializationError(
                        "terminal preparation changed under the publication lock",
                        stage="PUBLICATION",
                    )
                if publish:
                    try:
                        opened_window = self._store._open_verified_publication_window(
                            preparation=preparation,
                        )
                    except TerminalPublicationConflict as error:
                        raise MaterializationError(
                            "terminal preparation changed inside the publication writer window",
                            stage="PUBLICATION",
                        ) from error
                    if type(opened_window) is TerminalPublication:
                        return opened_window
                    if type(opened_window) is UnverifiedTerminalPublication:
                        raise FinalizationAlreadyResolved(opened_window)
                    if type(opened_window) is not _VerifiedPublicationWindow:
                        raise MaterializationError(
                            "verified publication writer window is invalid",
                            stage="PUBLICATION",
                        )
                    publication_window = opened_window
                try:
                    os.stat(
                        destination_name,
                        dir_fd=destination_parent_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    pass
                else:
                    if publish:
                        if publication_window is None:
                            raise MaterializationError(
                                "verified publication lacks its SQLite writer window",
                                stage="PUBLICATION",
                            )
                        existing = self._store.terminal_finalization(run_id=preparation.run_id)
                        if type(existing) is TerminalPublication:
                            return existing
                        raise RenamedRootRecoveryRequired(
                            "renamed root requires STA-26 recovery before finalization"
                        )
                    raise MaterializationError("final run target already exists", stage="RENAME")
                _darwin_rename_no_replace(
                    source_parent_fd,
                    source_name,
                    destination_parent_fd,
                    destination_name,
                )
                renamed = True
                _require_configured_directory_binding(
                    runtime_fd,
                    self._runtime_root,
                    expected_uid=self._service_uid,
                    label="runtime_root pathname",
                )
                _require_parent_binding(
                    source_parent_fd,
                    runtime_fd,
                    ".materializing",
                    expected_uid=self._service_uid,
                )
                _require_parent_binding(
                    destination_parent_fd,
                    runtime_fd,
                    "runs",
                    expected_uid=self._service_uid,
                )
                try:
                    os.stat(
                        source_name,
                        dir_fd=source_parent_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    pass
                else:
                    raise MaterializationError(
                        "source root pathname remained after no-replace rename",
                        stage="RENAME",
                    )
                _require_fd_name_identity(
                    root_fd,
                    destination_parent_fd,
                    destination_name,
                    label="destination root pathname",
                )
                os.fchmod(root_fd, 0o500)
                _fsync(root_fd)
                _verify_directory_metadata(
                    os.fstat(root_fd),
                    expected_uid=self._service_uid,
                    expected_mode=0o500,
                )
                _require_fd_name_identity(
                    root_fd,
                    destination_parent_fd,
                    destination_name,
                    label="destination root pathname",
                )
                _fsync(source_parent_fd)
                _fsync(destination_parent_fd)
                _require_fd_name_identity(
                    lock_fd,
                    runtime_fd,
                    _PUBLISH_LOCK_NAME,
                    label="lock pathname",
                )
                try:
                    self._verify_projection_root(
                        preparation=preparation,
                        parent_fd=destination_parent_fd,
                        root_name=destination_name,
                        expected=expected,
                        built_seal=built_seal,
                        expected_file_mode=0o400,
                        expected_root_mode=0o500,
                        expected_reports_mode=0o500,
                        failure_stage="SEAL",
                    )
                except MaterializationError as error:
                    raise _with_stage(error, "SEAL") from error
                self._verify_final_publication_bindings(
                    runtime_fd=runtime_fd,
                    runs_fd=destination_parent_fd,
                    root_fd=root_fd,
                    root_name=destination_name,
                    lock_fd=lock_fd,
                )
                # Keep the complete retained root identity through the handoff:
                # pathname rebinding alone cannot prove that a service-UID writer
                # did not replace immutable file contents after the first verifier.
                receipt = self._verify_projection_root(
                    preparation=preparation,
                    parent_fd=destination_parent_fd,
                    root_name=destination_name,
                    expected=expected,
                    built_seal=built_seal,
                    expected_file_mode=0o400,
                    expected_root_mode=0o500,
                    expected_reports_mode=0o500,
                    failure_stage="SEAL",
                    publication_lock_fd=lock_fd,
                    publication_runtime_fd=runtime_fd,
                    publication_runtime_path=self._runtime_root,
                    publication_authority=self._store._publication_authority,
                )
                self._verify_final_publication_bindings(
                    runtime_fd=runtime_fd,
                    runs_fd=destination_parent_fd,
                    root_fd=root_fd,
                    root_name=destination_name,
                    lock_fd=lock_fd,
                )
                if publish:
                    if type(receipt) is not _VerifiedFinalRootReceipt:
                        raise MaterializationError(
                            "final root verifier did not issue a publication receipt",
                            stage="PUBLICATION",
                        )
                    proof = _VerifiedRootProof._issue_from_locked_root(
                        run_id=preparation.run_id,
                        terminal_state=preparation.terminal_state,
                        terminal_event_seq=preparation.event.seq,
                        last_audit_seq=preparation.audit_intent.audit_seq,
                        seal_digest=built_seal.seal_digest,
                        root_receipt=receipt,
                        authority=self._store._publication_authority,
                    )
                    try:
                        if publication_window is None:
                            raise MaterializationError(
                                "verified publication lacks its SQLite writer window",
                                stage="PUBLICATION",
                            )
                        return self._store._publish_verified_terminal(proof=proof)
                    except (
                        TerminalEligibilityError,
                        TerminalIntegrityError,
                        TerminalPublicationConflict,
                    ) as error:
                        raise MaterializationError(
                            "verified publication proof conflicts with terminal authority",
                            stage="PUBLICATION",
                        ) from error
                return None
            except MaterializationError as error:
                if renamed and not error.deterministic:
                    raise RenamedRootRecoveryRequired(
                        "renamed root requires STA-26 recovery before finalization"
                    ) from error
                raise
            except sqlite3.Error as error:
                if renamed:
                    raise RenamedRootRecoveryRequired(
                        "renamed root requires STA-26 recovery before finalization"
                    ) from error
                raise
            except OSError as error:
                if renamed:
                    raise RenamedRootRecoveryRequired(
                        "renamed root requires STA-26 recovery before finalization"
                    ) from error
                raise MaterializationError(
                    "no-replace publication lock failed",
                    deterministic=False,
                    stage="RENAME",
                ) from error
            finally:
                primary_exception = sys.exc_info()[0] is not None
                cleanup_error: BaseException | None = None
                if publication_window is not None:
                    try:
                        self._store._discard_verified_publication_window(publication_window)
                    except BaseException as error:
                        cleanup_error = error
                if proof is not None:
                    try:
                        proof._discard()
                    except BaseException as error:
                        if cleanup_error is None:
                            cleanup_error = error
                if receipt is not None:
                    try:
                        receipt._discard()
                    except BaseException as error:
                        if cleanup_error is None:
                            cleanup_error = error
                if lock_fd >= 0:
                    try:
                        fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    except BaseException as error:
                        if cleanup_error is None:
                            cleanup_error = error
                    try:
                        os.close(lock_fd)
                    except BaseException as error:
                        if cleanup_error is None:
                            cleanup_error = error
                if not primary_exception and cleanup_error is not None:
                    raise _PublicationTeardownFailure(cleanup_error) from cleanup_error

    def _verify_final_publication_bindings(
        self,
        *,
        runtime_fd: int,
        runs_fd: int,
        root_fd: int,
        root_name: str,
        lock_fd: int,
    ) -> None:
        try:
            _require_configured_directory_binding(
                runtime_fd,
                self._runtime_root,
                expected_uid=self._service_uid,
                label="runtime_root pathname",
            )
            _require_parent_binding(
                runs_fd,
                runtime_fd,
                "runs",
                expected_uid=self._service_uid,
            )
            _require_fd_name_identity(
                root_fd,
                runs_fd,
                root_name,
                label="destination root pathname",
            )
            _verify_directory_metadata(
                os.fstat(root_fd),
                expected_uid=self._service_uid,
                expected_mode=0o500,
            )
            _require_fd_name_identity(
                lock_fd,
                runtime_fd,
                _PUBLISH_LOCK_NAME,
                label="lock pathname",
            )
        except MaterializationError as error:
            raise _with_stage(error, "SEAL") from error
        except OSError as error:
            raise _filesystem_os_error(
                "final publication bindings could not be verified",
                error,
                stage="SEAL",
            ) from error

    def _validate_projection_bytes(
        self,
        *,
        preparation: TerminalPreparation,
        expected: Mapping[str, bytes],
        built_seal: BuiltSeal,
    ) -> None:
        current = self._store.terminal_preparation(run_id=preparation.run_id)
        if (
            current is None
            or not _same_terminal_preparation(current, preparation)
            or current.disposition != "NORMAL"
        ):
            raise MaterializationError("terminal preparation drifted during materialization")
        record_authority = preparation.run_record
        if type(record_authority) is not RunRecordV1:
            raise MaterializationError("normal preparation lacks its planned run record")
        required = set(_BASE_PATHS) | {"seal.json"}
        report_paths = {path for path in expected if path.startswith("reports/")}
        if set(expected) != required | report_paths:
            raise MaterializationError("projection byte inventory is not closed")
        for name in ("request.json", "input-manifest.json", "run-record.json"):
            self._verify_exact_canonical(expected[name], name, declared_root=True)
        self._verify_exact_canonical(expected["preflight.json"], "preflight.json")
        for name in report_paths:
            self._verify_exact_canonical(expected[name], name)
        self._verify_exact_canonical(expected["runner-exit.json"], "runner exit")
        self._verify_exact_canonical(expected["seal.json"], "run seal", declared_root=True)
        if expected["seal.json"] != built_seal.seal_bytes:
            raise MaterializationError("seal bytes changed")
        if sha256(expected["seal.json"]).hexdigest() != built_seal.seal_digest:
            raise MaterializationError("external seal digest changed")
        seal_object = parse_json_object(expected["seal.json"])
        seal_files = seal_object.get("files")
        if type(seal_files) is not list:
            raise MaterializationError("seal files are invalid")
        expected_without_seal = {path: raw for path, raw in expected.items() if path != "seal.json"}
        try:
            rebuilt = build_run_seal(
                run_id=preparation.run_id,
                terminal_state=preparation.terminal_state,
                terminal_event_seq=preparation.event.seq,
                last_audit_seq=preparation.audit_intent.audit_seq,
                audit_head_hash=cast(str, seal_object["audit_head_hash"]),
                files=expected_without_seal,
            )
        except (KeyError, SealVerificationError) as error:
            raise MaterializationError("seal cannot be rebuilt from projection") from error
        if rebuilt != built_seal:
            raise MaterializationError("seal does not bind the exact projection")

        record_value = parse_json_object(expected["run-record.json"])
        try:
            record = RunRecordV1.model_validate(record_value)
        except ValidationError as error:
            raise MaterializationError("run record is invalid") from error
        if record.model_dump(
            mode="json",
            by_alias=True,
        ) != record_authority.model_dump(mode="json", by_alias=True):
            raise MaterializationError("run record differs from committed authority")

        event_objects = _parse_strict_ndjson(expected["events.ndjson"], label="events")
        if len(event_objects) != preparation.event.seq:
            raise MaterializationError("events NDJSON boundary changed")
        for seq, value in enumerate(event_objects, start=1):
            try:
                envelope = EventEnvelopeV1.model_validate(value)
            except ValidationError as error:
                raise MaterializationError("events NDJSON contains an invalid envelope") from error
            if envelope.run_id != preparation.run_id or envelope.seq != seq:
                raise MaterializationError("events NDJSON is not contiguous")
            if canonical_json_bytes(value) + b"\n" not in expected["events.ndjson"]:
                raise MaterializationError("events NDJSON is not canonical")

        audit_objects = _parse_strict_ndjson(expected["audit.ndjson"], label="audit")
        if len(audit_objects) != preparation.audit_intent.audit_seq:
            raise MaterializationError("audit NDJSON boundary changed")
        try:
            verify_hash_chain(audit_objects)
        except ValueError as error:
            raise MaterializationError("audit NDJSON chain changed") from error
        if cast(str, audit_objects[-1]["entry_hash"]) != seal_object["audit_head_hash"]:
            raise MaterializationError("seal audit head differs from audit NDJSON")

    @staticmethod
    def _verify_exact_canonical(
        raw: bytes,
        label: str,
        *,
        declared_root: bool = False,
    ) -> None:
        try:
            if declared_root:
                value = parse_json_object(raw)
                matches = canonical_json_bytes(value) == raw
            else:
                wrapped_raw = b'{"value":' + raw + b"}"
                value = parse_json_object(wrapped_raw)
                matches = canonical_json_bytes(value) == wrapped_raw
            if not matches:
                raise MaterializationError(f"{label} is not exact canonical JSON")
        except CanonicalJSONError as error:
            raise MaterializationError(f"{label} is not valid canonical JSON") from error


def _validate_persisted_event(
    event: PersistedEvent,
    *,
    run_id: str,
    expected_seq: int,
    prepared: bool,
) -> EventEnvelopeV1:
    if type(event) is not PersistedEvent:
        raise MaterializationError("event authority has an unexpected runtime type")
    try:
        value = parse_json_object(event.envelope_bytes)
        envelope = EventEnvelopeV1.model_validate(value)
    except (CanonicalJSONError, ValidationError) as error:
        raise MaterializationError("stored event envelope is invalid") from error
    if canonical_json_bytes(value) != event.envelope_bytes:
        raise MaterializationError("stored event envelope is not exact canonical bytes")
    if (prepared and event.type not in _TERMINAL_EVENT_TYPES) or (
        not prepared and event.type in _TERMINAL_EVENT_TYPES
    ):
        raise MaterializationError("terminal event must be the final prepared envelope")
    dumped = envelope.model_dump(mode="json", by_alias=True)
    if (
        event.run_id != run_id
        or event.seq != expected_seq
        or event.visible != (not prepared)
        or envelope.event_id != event.event_id
        or envelope.run_id != event.run_id
        or envelope.seq != event.seq
        or envelope.source_seq != event.source_seq
        or envelope.source != event.source
        or envelope.type != event.type
        or envelope.ts_event_ns != event.ts_event_ns
        or envelope.ts_ingest_ns != event.ts_ingest_ns
        or envelope.writer != "control-api"
        or envelope.schema_version != 1
        or dumped["payload"] != value["payload"]
    ):
        raise MaterializationError("stored event row does not bind its envelope")
    return envelope


def _validate_audit_intent(
    audit: AuditIntent,
    *,
    run_id: str,
    expected_seq: int,
    event_digests: Mapping[int, str],
    event_ingest_ns: Mapping[int, int],
) -> dict[str, object]:
    if type(audit) is not AuditIntent:
        raise MaterializationError("audit authority has an unexpected runtime type")
    try:
        value = parse_json_object(audit.intent_bytes)
    except CanonicalJSONError as error:
        raise MaterializationError("stored audit intent is invalid") from error
    expected = {
        "seq": expected_seq,
        "run_id": run_id,
        "event_seq": audit.event_seq,
        "event_digest": audit.event_digest,
    }
    if (
        audit.run_id != run_id
        or audit.audit_seq != expected_seq
        or audit.event_seq != expected_seq
        or audit.event_digest != event_digests.get(audit.event_seq)
        or audit.created_at_ns != event_ingest_ns.get(audit.event_seq)
        or value != expected
        or canonical_json_bytes(value) != audit.intent_bytes
        or audit.created_at_ns < 0
    ):
        raise MaterializationError("stored audit intent does not bind its event")
    return cast(dict[str, object], value)


def _parse_strict_ndjson(raw: bytes, *, label: str) -> list[dict[str, object]]:
    if not raw or not raw.endswith(b"\n") or raw.endswith(b"\n\n"):
        raise MaterializationError(f"{label} NDJSON requires one newline per record")
    objects: list[dict[str, object]] = []
    for line in raw[:-1].split(b"\n"):
        if not line:
            raise MaterializationError(f"{label} NDJSON contains an empty record")
        try:
            value = parse_json_object(line)
        except CanonicalJSONError as error:
            raise MaterializationError(f"{label} NDJSON contains invalid JSON") from error
        if canonical_json_bytes(value) != line:
            raise MaterializationError(f"{label} NDJSON is not canonical")
        objects.append(cast(dict[str, object], value))
    return objects


def _open_configured_directory(path: Path, *, expected_mode: int, expected_uid: int) -> int:
    if not path.is_absolute():
        raise MaterializationError("runtime_root ancestry must be absolute")
    current_fd = -1
    try:
        current_fd = os.open("/", _DIRECTORY_FLAGS)
        for component in path.parts[1:]:
            _require_component(component)
            next_fd = -1
            try:
                next_fd = os.open(component, _DIRECTORY_FLAGS, dir_fd=current_fd)
                name_metadata = os.stat(
                    component,
                    dir_fd=current_fd,
                    follow_symlinks=False,
                )
                observed = os.fstat(next_fd)
                if (
                    name_metadata.st_dev != observed.st_dev
                    or name_metadata.st_ino != observed.st_ino
                ):
                    raise MaterializationError("runtime_root ancestry changed while opened")
            except (MaterializationError, OSError):
                _close_all(next_fd)
                raise
            parent_fd = current_fd
            current_fd = -1
            try:
                os.close(parent_fd)
            except OSError:
                _close_all(next_fd)
                raise
            current_fd = next_fd
        observed = os.fstat(current_fd)
        _verify_directory_metadata(
            observed,
            expected_uid=expected_uid,
            expected_mode=expected_mode,
        )
        return current_fd
    except MaterializationError:
        _close_all(current_fd)
        raise
    except OSError as error:
        _close_all(current_fd)
        raise _filesystem_os_error("runtime_root ancestry is not descriptor-safe", error) from error


def _require_configured_directory_binding(
    retained_fd: int,
    path: Path,
    *,
    expected_uid: int,
    label: str,
) -> None:
    reopened_fd = -1
    try:
        reopened_fd = _open_configured_directory(
            path,
            expected_mode=0o700,
            expected_uid=expected_uid,
        )
        if not _same_directory_identity(os.fstat(retained_fd), os.fstat(reopened_fd)):
            raise MaterializationError(f"{label} changed while materializing")
    finally:
        _close_all(reopened_fd)


def _open_child_directory(
    parent_fd: int,
    name: str,
    *,
    expected_mode: int,
    expected_uid: int,
) -> int:
    _require_component(name)
    descriptor = -1
    try:
        descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
        descriptor_metadata = os.fstat(descriptor)
        name_metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        _verify_directory_metadata(
            descriptor_metadata,
            expected_uid=expected_uid,
            expected_mode=expected_mode,
        )
        if (
            descriptor_metadata.st_dev != name_metadata.st_dev
            or descriptor_metadata.st_ino != name_metadata.st_ino
        ):
            raise MaterializationError("directory changed while opened")
        return descriptor
    except MaterializationError:
        _close_all(descriptor)
        raise
    except OSError as error:
        _close_all(descriptor)
        raise _filesystem_os_error("child directory could not be opened safely", error) from error


def _open_or_create_directory(parent_fd: int, name: str, *, expected_uid: int) -> int:
    _require_component(name)
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        _fsync(parent_fd)
    except FileExistsError:
        pass
    return _open_child_directory(
        parent_fd,
        name,
        expected_mode=0o700,
        expected_uid=expected_uid,
    )


def _open_publish_lock(runtime_fd: int, *, expected_uid: int) -> int:
    descriptor = -1
    create_flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    existing_flags = os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        try:
            descriptor = os.open(
                _PUBLISH_LOCK_NAME,
                create_flags,
                0o600,
                dir_fd=runtime_fd,
            )
        except FileExistsError:
            named = os.stat(
                _PUBLISH_LOCK_NAME,
                dir_fd=runtime_fd,
                follow_symlinks=False,
            )
            _verify_regular_metadata(
                named,
                expected_uid=expected_uid,
                expected_mode=0o600,
                expected_size=0,
            )
            descriptor = os.open(
                _PUBLISH_LOCK_NAME,
                existing_flags,
                dir_fd=runtime_fd,
            )
        else:
            os.fchmod(descriptor, 0o600)
            _fsync(descriptor)
            _fsync(runtime_fd)
        _verify_regular_metadata(
            os.fstat(descriptor),
            expected_uid=expected_uid,
            expected_mode=0o600,
            expected_size=0,
        )
        _require_fd_name_identity(
            descriptor,
            runtime_fd,
            _PUBLISH_LOCK_NAME,
            label="lock pathname",
        )
        return descriptor
    except MaterializationError:
        _close_all(descriptor)
        raise
    except OSError as error:
        _close_all(descriptor)
        raise _filesystem_os_error("lock pathname could not be opened safely", error) from error


def _require_parent_binding(
    descriptor: int,
    runtime_fd: int,
    name: str,
    *,
    expected_uid: int,
) -> None:
    label = f"{name} parent pathname"
    _require_fd_name_identity(descriptor, runtime_fd, name, label=label)
    _verify_directory_metadata(
        os.fstat(descriptor),
        expected_uid=expected_uid,
        expected_mode=0o700,
    )


def _require_fd_name_identity(
    descriptor: int,
    parent_fd: int,
    name: str,
    *,
    label: str,
) -> None:
    try:
        retained = os.fstat(descriptor)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        raise _filesystem_os_error(
            f"{label} is not bound to its retained descriptor", error
        ) from error
    if retained.st_dev != named.st_dev or retained.st_ino != named.st_ino:
        raise MaterializationError(f"{label} is not bound to its retained descriptor")


def _read_regular_file(
    parent_fd: int,
    name: str,
    *,
    expected_uid: int,
    expected_mode: int,
    expected_size: int,
    expected_hash: str,
    expected_bytes: bytes | None,
    artifact: str | None = None,
) -> bytes:
    _require_component(name)
    descriptor = -1
    try:
        descriptor = os.open(name, _READ_FLAGS, dir_fd=parent_fd)
        before = os.fstat(descriptor)
        name_before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        _verify_regular_metadata(
            before,
            expected_uid=expected_uid,
            expected_mode=expected_mode,
            expected_size=expected_size,
        )
        if before.st_dev != name_before.st_dev or before.st_ino != name_before.st_ino:
            raise MaterializationError("file changed while opened")
        payload = bytearray()
        while len(payload) <= expected_size:
            chunk = os.read(descriptor, min(65_536, expected_size + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        name_after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            len(payload) != expected_size
            or sha256(payload).hexdigest() != expected_hash
            or (expected_bytes is not None and bytes(payload) != expected_bytes)
            or not _same_regular_identity(before, after)
            or after.st_dev != name_after.st_dev
            or after.st_ino != name_after.st_ino
        ):
            raise MaterializationError("file content or identity changed while read")
        return bytes(payload)
    except MaterializationError as error:
        if artifact is None or error.artifact is not None:
            raise
        raise MaterializationError(
            str(error),
            deterministic=error.deterministic,
            stage=error.stage,
            artifact=artifact,
        ) from error
    except OSError as error:
        raise _filesystem_os_error(
            "regular file could not be read safely",
            error,
            artifact=artifact,
        ) from error
    finally:
        _close_all(descriptor)


def _retain_final_root_verification(
    *,
    runtime_fd: int,
    runtime_path: Path,
    runs_fd: int,
    root_fd: int,
    root_name: str,
    reports_fd: int,
    expected: Mapping[str, bytes],
    expected_uid: int,
    expected_file_mode: int,
    expected_root_mode: int,
    expected_reports_mode: int,
) -> _RetainedFinalRootVerification:
    """Duplicate every verified descriptor so publication can recheck the same inodes."""

    retained = object.__new__(_RetainedFinalRootVerification)
    retained_files: list[tuple[str, int, os.stat_result, bytes]] = []
    runtime_guard = runs_guard = root_guard = reports_guard = -1
    try:
        runtime_guard = os.dup(runtime_fd)
        runs_guard = os.dup(runs_fd)
        root_guard = os.dup(root_fd)
        if reports_fd >= 0:
            reports_guard = os.dup(reports_fd)
        _require_fd_name_identity(runs_guard, runtime_guard, "runs", label="runs parent pathname")
        _require_fd_name_identity(
            root_guard, runs_guard, root_name, label="destination root pathname"
        )
        root_identity = os.fstat(root_guard)
        _verify_directory_metadata(
            root_identity,
            expected_uid=expected_uid,
            expected_mode=expected_root_mode,
        )
        report_paths = tuple(path for path in expected if path.startswith("reports/"))
        expected_top = {path for path in expected if not path.startswith("reports/")}
        if report_paths:
            expected_top.add("reports")
            _require_fd_name_identity(
                reports_guard,
                root_guard,
                "reports",
                label="reports pathname",
            )
            reports_identity = os.fstat(reports_guard)
            _verify_directory_metadata(
                reports_identity,
                expected_uid=expected_uid,
                expected_mode=expected_reports_mode,
            )
            if set(os.listdir(reports_guard)) != {
                path.removeprefix("reports/") for path in report_paths
            }:
                raise MaterializationError("materialized reports inventory is not closed")
        else:
            if reports_guard >= 0:
                raise MaterializationError(
                    "materialized root retained an unexpected reports descriptor"
                )
            reports_identity = None
        if set(os.listdir(root_guard)) != expected_top:
            raise MaterializationError("materialized root inventory is not closed")
        for relative_path, payload in expected.items():
            parent_fd = reports_guard if relative_path.startswith("reports/") else root_guard
            descriptor, identity = _open_retained_regular_file(
                parent_fd,
                relative_path.removeprefix("reports/"),
                expected_uid=expected_uid,
                expected_mode=expected_file_mode,
                expected_bytes=payload,
            )
            retained_files.append((relative_path, descriptor, identity, payload))
        if (
            not _same_directory_identity(root_identity, os.fstat(root_guard))
            or set(os.listdir(root_guard)) != expected_top
            or (
                reports_identity is not None
                and (
                    not _same_directory_identity(reports_identity, os.fstat(reports_guard))
                    or set(os.listdir(reports_guard))
                    != {path.removeprefix("reports/") for path in report_paths}
                )
            )
        ):
            raise MaterializationError("materialized root changed while retained")
        retained._runtime_fd = runtime_guard
        retained._runs_fd = runs_guard
        retained._root_fd = root_guard
        retained._reports_fd = reports_guard
        retained._root_name = root_name
        retained._runtime_path = runtime_path
        retained._service_uid = expected_uid
        retained._runs_identity = os.fstat(runs_guard)
        retained._root_identity = root_identity
        retained._reports_identity = reports_identity
        retained._files = tuple(retained_files)
        return retained
    except MaterializationError:
        _close_all(
            *(descriptor for _path, descriptor, _identity, _payload in retained_files),
            reports_guard,
            root_guard,
            runs_guard,
            runtime_guard,
        )
        raise
    except OSError as error:
        _close_all(
            *(descriptor for _path, descriptor, _identity, _payload in retained_files),
            reports_guard,
            root_guard,
            runs_guard,
            runtime_guard,
        )
        raise _filesystem_os_error(
            "final-root descriptor retention failed", error, stage="SEAL"
        ) from error


def _open_retained_regular_file(
    parent_fd: int,
    name: str,
    *,
    expected_uid: int,
    expected_mode: int,
    expected_bytes: bytes,
) -> tuple[int, os.stat_result]:
    """Open one exact verified file and retain its descriptor at offset zero."""

    _require_component(name)
    descriptor = -1
    try:
        descriptor = os.open(name, _READ_FLAGS, dir_fd=parent_fd)
        before = os.fstat(descriptor)
        _verify_regular_metadata(
            before,
            expected_uid=expected_uid,
            expected_mode=expected_mode,
            expected_size=len(expected_bytes),
        )
        _require_fd_name_identity(descriptor, parent_fd, name, label=f"{name} pathname")
        _verify_retained_regular_file(
            descriptor,
            parent_fd,
            name,
            identity=before,
            expected_bytes=expected_bytes,
            expected_uid=expected_uid,
            expected_mode=expected_mode,
        )
        return descriptor, before
    except MaterializationError:
        _close_all(descriptor)
        raise
    except OSError as error:
        _close_all(descriptor)
        raise _filesystem_os_error(
            "regular file could not be retained", error, stage="SEAL"
        ) from error


def _reverify_retained_final_root(
    retained: object,
    *,
    lock_guard_fd: int,
) -> None:
    """Re-read retained files and bindings immediately before SQLite publication."""

    if type(retained) is not _RetainedFinalRootVerification:
        raise MaterializationError(
            "publication proof lacks retained final-root identities", stage="PUBLICATION"
        )
    try:
        _require_configured_directory_binding(
            retained._runtime_fd,
            retained._runtime_path,
            expected_uid=retained._service_uid,
            label="runtime_root pathname",
        )
        _verify_regular_metadata(
            os.fstat(lock_guard_fd),
            expected_uid=retained._service_uid,
            expected_mode=0o600,
            expected_size=0,
        )
        _require_fd_name_identity(
            lock_guard_fd,
            retained._runtime_fd,
            _PUBLISH_LOCK_NAME,
            label="lock pathname",
        )
        _require_fd_name_identity(
            retained._runs_fd,
            retained._runtime_fd,
            "runs",
            label="runs parent pathname",
        )
        if not _same_directory_identity(retained._runs_identity, os.fstat(retained._runs_fd)):
            raise MaterializationError(
                "runs parent changed before verified publication", stage="SEAL"
            )
        _require_fd_name_identity(
            retained._root_fd,
            retained._runs_fd,
            retained._root_name,
            label="destination root pathname",
        )
        if not _same_directory_identity(retained._root_identity, os.fstat(retained._root_fd)):
            raise MaterializationError(
                "destination root changed before verified publication", stage="SEAL"
            )
        report_paths = tuple(
            path
            for path, _fd, _identity, _payload in retained._files
            if path.startswith("reports/")
        )
        expected_top = {
            path
            for path, _fd, _identity, _payload in retained._files
            if not path.startswith("reports/")
        }
        if report_paths:
            expected_top.add("reports")
            _require_fd_name_identity(
                retained._reports_fd,
                retained._root_fd,
                "reports",
                label="reports pathname",
            )
            if retained._reports_identity is None or not _same_directory_identity(
                retained._reports_identity, os.fstat(retained._reports_fd)
            ):
                raise MaterializationError(
                    "reports directory changed before verified publication", stage="SEAL"
                )
            expected_report_names = {path.removeprefix("reports/") for path in report_paths}
            if set(os.listdir(retained._reports_fd)) != expected_report_names:
                raise MaterializationError(
                    "materialized reports inventory is not closed", stage="SEAL"
                )
        elif retained._reports_fd >= 0:
            raise MaterializationError("unexpected retained reports descriptor", stage="SEAL")
        if set(os.listdir(retained._root_fd)) != expected_top:
            raise MaterializationError("materialized root inventory is not closed", stage="SEAL")
        for relative_path, descriptor, identity, payload in retained._files:
            parent_fd = (
                retained._reports_fd if relative_path.startswith("reports/") else retained._root_fd
            )
            _verify_retained_regular_file(
                descriptor,
                parent_fd,
                relative_path.removeprefix("reports/"),
                identity=identity,
                expected_bytes=payload,
                expected_uid=retained._service_uid,
                expected_mode=0o400,
            )
    except MaterializationError:
        raise
    except OSError as error:
        raise _filesystem_os_error(
            "retained final-root verification failed", error, stage="SEAL"
        ) from error


def _verify_retained_regular_file(
    descriptor: int,
    parent_fd: int,
    name: str,
    *,
    identity: os.stat_result,
    expected_bytes: bytes,
    expected_uid: int,
    expected_mode: int,
) -> None:
    before = os.fstat(descriptor)
    _verify_regular_metadata(
        before,
        expected_uid=expected_uid,
        expected_mode=expected_mode,
        expected_size=len(expected_bytes),
    )
    _require_fd_name_identity(descriptor, parent_fd, name, label=f"{name} pathname")
    if not _same_regular_identity(identity, before):
        raise MaterializationError("retained regular file identity changed", stage="SEAL")
    os.lseek(descriptor, 0, os.SEEK_SET)
    payload = bytearray()
    while len(payload) <= len(expected_bytes):
        chunk = os.read(descriptor, min(65_536, len(expected_bytes) + 1 - len(payload)))
        if not chunk:
            break
        payload.extend(chunk)
    after = os.fstat(descriptor)
    _require_fd_name_identity(descriptor, parent_fd, name, label=f"{name} pathname")
    if (
        bytes(payload) != expected_bytes
        or sha256(payload).hexdigest() != sha256(expected_bytes).hexdigest()
        or not _same_regular_identity(identity, after)
    ):
        raise MaterializationError("retained regular file content changed", stage="SEAL")


def _write_projection_file(
    parent_fd: int,
    name: str,
    payload: bytes,
    *,
    expected_uid: int,
) -> None:
    _require_component(name)
    if type(payload) is not bytes:
        raise MaterializationError("projection payload must be exact bytes")
    descriptor = -1
    try:
        descriptor = os.open(name, _WRITE_FLAGS, 0o600, dir_fd=parent_fd)
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise MaterializationError("projection write made no progress")
            offset += written
        _fsync(descriptor)
        _verify_regular_metadata(
            os.fstat(descriptor),
            expected_uid=expected_uid,
            expected_mode=0o600,
            expected_size=len(payload),
        )
        _fsync(parent_fd)
    except MaterializationError:
        raise
    except OSError as error:
        raise _filesystem_os_error("projection file could not be written durably", error) from error
    finally:
        _close_all(descriptor)


def _verify_regular_metadata(
    metadata: os.stat_result,
    *,
    expected_uid: int,
    expected_mode: int,
    expected_size: int,
) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or metadata.st_uid != expected_uid
        or metadata.st_nlink != 1
        or metadata.st_size != expected_size
    ):
        raise MaterializationError("regular file metadata is invalid")


def _verify_directory_metadata(
    metadata: os.stat_result,
    *,
    expected_uid: int,
    expected_mode: int,
) -> None:
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or metadata.st_uid != expected_uid
    ):
        raise MaterializationError("directory metadata is invalid")


def _same_regular_identity(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_mode == after.st_mode
        and before.st_uid == after.st_uid
        and before.st_nlink == after.st_nlink
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
    )


def _same_directory_identity(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_mode == after.st_mode
        and before.st_uid == after.st_uid
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
    )


def _first_inventory_mismatch(
    observed: set[str],
    expected: set[str],
    *,
    prefix: str = "",
) -> str:
    missing = sorted(expected - observed)
    if missing:
        return f"{prefix}{missing[0]}"
    extra = sorted(observed - expected)
    if extra:
        return f"{prefix}{extra[0]}"
    return prefix.removesuffix("/") or "<root>"


def _require_component(value: str) -> None:
    if (
        type(value) is not str
        or not value
        or value in {".", ".."}
        or any(character in value for character in ("/", "\\", ":", "\x00"))
    ):
        raise MaterializationError("unsafe filesystem component")


def _fsync(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as error:
        raise MaterializationError(
            "filesystem durability check failed",
            deterministic=False,
            stage="FSYNC",
        ) from error


def _with_stage(
    error: MaterializationError,
    stage: MaterializationStage,
) -> MaterializationError:
    if error.stage != "MATERIALIZATION" or error.stage == stage:
        return error
    return MaterializationError(
        str(error),
        deterministic=error.deterministic,
        stage=stage,
        artifact=error.artifact,
    )


def _darwin_rename_no_replace(
    source_parent_fd: int,
    source_name: str,
    destination_parent_fd: int,
    destination_name: str,
) -> None:
    _require_component(source_name)
    _require_component(destination_name)
    if sys.platform != "darwin":
        raise MaterializationError("approved no-replace rename is unavailable", stage="RENAME")
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        renameatx_np = libc.renameatx_np
    except (AttributeError, OSError) as error:
        raise MaterializationError("renameatx_np is unavailable", stage="RENAME") from error
    renameatx_np.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameatx_np.restype = ctypes.c_int
    ctypes.set_errno(0)
    result = renameatx_np(
        source_parent_fd,
        os.fsencode(source_name),
        destination_parent_fd,
        os.fsencode(destination_name),
        _RENAME_FLAGS,
    )
    if result == 0:
        return
    observed_errno = ctypes.get_errno()
    if observed_errno == errno.EEXIST:
        raise MaterializationError("final run target already exists", stage="RENAME")
    if observed_errno <= 0:
        raise MaterializationError(
            "renameatx_np returned an ambiguous failure", deterministic=False, stage="RENAME"
        )
    raise MaterializationError(
        "approved no-replace rename failed", deterministic=False, stage="RENAME"
    ) from OSError(
        observed_errno,
        os.strerror(observed_errno),
    )


def _close_all(*descriptors: int) -> None:
    for descriptor in descriptors:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
