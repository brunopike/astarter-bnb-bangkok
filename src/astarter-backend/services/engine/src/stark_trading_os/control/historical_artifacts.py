"""Historical projections use the existing descriptor and no-replace primitives."""

from __future__ import annotations

import fcntl
import os
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from stark_trading_os.audit.materializer import (
    _PROCESS_PUBLISH_LOCK,
    _PUBLISH_LOCK_NAME,
    _close_all,
    _darwin_rename_no_replace,
    _fsync,
    _open_child_directory,
    _open_configured_directory,
    _open_or_create_directory,
    _open_publish_lock,
    _read_regular_file,
    _require_configured_directory_binding,
    _require_fd_name_identity,
    _require_parent_binding,
    _same_directory_identity,
    _verify_directory_metadata,
    _verify_regular_metadata,
    _write_projection_file,
)
from stark_trading_os.control.historical_terminal import (
    BASE_PATHS,
    REPORT_PATHS,
    HistoricalAuthority,
    HistoricalFinalizationError,
)

type ExpectedFiles = Mapping[str, tuple[int, str, bytes | None]]


def _read(parent: int, name: str, size: int, digest: str, raw: bytes | None, *, mode: int) -> bytes:
    return _read_regular_file(
        parent,
        name,
        expected_uid=os.getuid(),
        expected_mode=mode,
        expected_size=size,
        expected_hash=digest,
        expected_bytes=raw,
    )


def read_staged(runtime: Path, authority: HistoricalAuthority) -> dict[str, bytes]:
    uid = os.getuid()
    runtime_fd = staging_fd = run_fd = reports_fd = -1
    try:
        runtime_fd = _open_configured_directory(runtime, expected_mode=0o700, expected_uid=uid)
        staging_fd = _open_child_directory(
            runtime_fd, "staging", expected_mode=0o700, expected_uid=uid
        )
        run_fd = _open_child_directory(
            staging_fd, authority.run.run_id, expected_mode=0o700, expected_uid=uid
        )
        if set(os.listdir(run_fd)) - {
            "input-manifest.json",
            "runner-exit.json",
            "stderr.txt",
            "reports",
        }:
            raise HistoricalFinalizationError()
        preflight, outcome = authority.preflight, authority.outcome
        result = {"catalog-manifest.json": preflight.catalog_publication_bytes}
        for name, raw in (
            (BASE_PATHS[0], preflight.input_manifest_bytes),
            (BASE_PATHS[2], outcome.outcome_bytes),
        ):
            result[name] = _read(run_fd, name, len(raw), sha256(raw).hexdigest(), raw, mode=0o600)
        result["stderr.txt"] = _read(
            run_fd,
            "stderr.txt",
            outcome.outcome.stderr_size_bytes,
            outcome.outcome.stderr_sha256,
            None,
            mode=0o600,
        )
        child = outcome.outcome.child_outcome
        artifacts = () if child is None else child.artifacts
        if artifacts:
            reports_fd = _open_child_directory(
                run_fd, "reports", expected_mode=0o700, expected_uid=uid
            )
            if len(artifacts) == 2 and set(os.listdir(reports_fd)) != {
                p.split("/")[1] for p in REPORT_PATHS
            }:
                raise HistoricalFinalizationError()
            for artifact in artifacts:
                result[artifact.path] = _read(
                    reports_fd,
                    artifact.path.split("/")[1],
                    artifact.size_bytes,
                    artifact.sha256,
                    None,
                    mode=0o600,
                )
            _require_fd_name_identity(reports_fd, run_fd, "reports", label="reports")
        _require_fd_name_identity(run_fd, staging_fd, authority.run.run_id, label="staged run")
        _require_parent_binding(staging_fd, runtime_fd, "staging", expected_uid=uid)
        _require_configured_directory_binding(
            runtime_fd, runtime, expected_uid=uid, label="runtime"
        )
        return result
    finally:
        _close_all(reports_fd, run_fd, staging_fd, runtime_fd)


def _verify_root(root_fd: int, expected: ExpectedFiles, *, mode: int = 0o500) -> dict[str, bytes]:
    before = os.fstat(root_fd)
    _verify_directory_metadata(before, expected_uid=os.getuid(), expected_mode=mode)
    report_names = {name.split("/")[1] for name in expected if name.startswith("reports/")}
    root_names = {name for name in expected if not name.startswith("reports/")}
    if report_names:
        root_names.add("reports")
    if set(os.listdir(root_fd)) != root_names:
        raise HistoricalFinalizationError()
    result: dict[str, bytes] = {}
    reports_fd = -1
    try:
        if report_names:
            reports_fd = _open_child_directory(
                root_fd, "reports", expected_mode=0o500, expected_uid=os.getuid()
            )
            if set(os.listdir(reports_fd)) != report_names:
                raise HistoricalFinalizationError()
        for name, (size, digest, raw) in expected.items():
            parent, basename = (
                (reports_fd, name.split("/")[1]) if name.startswith("reports/") else (root_fd, name)
            )
            result[name] = _read(parent, basename, size, digest, raw, mode=0o400)
        if reports_fd >= 0:
            _require_fd_name_identity(reports_fd, root_fd, "reports", label="published reports")
            _verify_directory_metadata(
                os.fstat(reports_fd), expected_uid=os.getuid(), expected_mode=0o500
            )
        if set(os.listdir(root_fd)) != root_names:
            raise HistoricalFinalizationError()
        after = os.fstat(root_fd)
        _verify_directory_metadata(after, expected_uid=os.getuid(), expected_mode=mode)
        if not _same_directory_identity(before, after):
            raise HistoricalFinalizationError()
        return result
    finally:
        _close_all(reports_fd)


def _write_immutable(root_fd: int, payloads: Mapping[str, bytes], expected: ExpectedFiles) -> None:
    if set(payloads) != set(expected):
        raise HistoricalFinalizationError()
    reports_fd = -1
    try:
        for path, raw in payloads.items():
            size, digest, exact = expected[path]
            if (
                len(raw) != size
                or sha256(raw).hexdigest() != digest
                or (exact is not None and raw != exact)
            ):
                raise HistoricalFinalizationError()
            if path.startswith("reports/"):
                if reports_fd < 0:
                    reports_fd = _open_or_create_directory(
                        root_fd, "reports", expected_uid=os.getuid()
                    )
                parent, name = reports_fd, path.split("/")[1]
            else:
                parent, name = root_fd, path
            _write_projection_file(parent, name, raw, expected_uid=os.getuid())
            os.chmod(name, 0o400, dir_fd=parent, follow_symlinks=False)
            _fsync(parent)
        if reports_fd >= 0:
            os.fchmod(reports_fd, 0o500)
            _fsync(reports_fd)
        _fsync(root_fd)
        _verify_root(root_fd, expected, mode=0o700)
    finally:
        _close_all(reports_fd)


@contextmanager
def locked_root(
    runtime: Path,
    run_id: str,
    expected: ExpectedFiles,
    *,
    create: Callable[[], Mapping[str, bytes]] | None = None,
    can_materialize: Callable[[], bool] | None = None,
) -> Iterator[Callable[[], dict[str, bytes]]]:
    """Hold shared publication lock and retained root descriptors across DB publication."""
    uid = os.getuid()
    runtime_fd = runs_fd = lock_fd = root_fd = temp_parent_fd = -1
    with _PROCESS_PUBLISH_LOCK:
        try:
            runtime_fd = _open_configured_directory(runtime, expected_mode=0o700, expected_uid=uid)
            if create is None:
                runs_fd = _open_child_directory(
                    runtime_fd, "runs", expected_mode=0o700, expected_uid=uid
                )
                # No O_CREAT, including a concurrent unlink between stat/open.
                lock_fd = os.open(
                    _PUBLISH_LOCK_NAME,
                    os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=runtime_fd,
                )
            else:
                runs_fd = _open_or_create_directory(runtime_fd, "runs", expected_uid=uid)
                lock_fd = _open_publish_lock(runtime_fd, expected_uid=uid)
            _verify_regular_metadata(
                os.fstat(lock_fd), expected_uid=uid, expected_mode=0o600, expected_size=0
            )
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            _require_fd_name_identity(lock_fd, runtime_fd, _PUBLISH_LOCK_NAME, label="publish lock")
            # A caller's lock-free snapshot may precede another publication.
            # Recheck DB authority under this same lock before any root mutation.
            mutable = create is not None and can_materialize is not None and can_materialize()
            try:
                os.stat(run_id, dir_fd=runs_fd, follow_symlinks=False)
            except FileNotFoundError:
                if not mutable or create is None:
                    raise
                payloads = create()
                temp_parent_fd = _open_or_create_directory(
                    runtime_fd, ".materializing", expected_uid=uid
                )
                temp_name = ".tmp-historical-" + uuid4().hex
                os.mkdir(temp_name, mode=0o700, dir_fd=temp_parent_fd)
                _fsync(temp_parent_fd)
                root_fd = _open_child_directory(
                    temp_parent_fd, temp_name, expected_mode=0o700, expected_uid=uid
                )
                _write_immutable(root_fd, payloads, expected)
                _fsync(temp_parent_fd)
                _require_parent_binding(
                    temp_parent_fd, runtime_fd, ".materializing", expected_uid=uid
                )
                _require_parent_binding(runs_fd, runtime_fd, "runs", expected_uid=uid)
                _require_fd_name_identity(
                    root_fd, temp_parent_fd, temp_name, label="materialized root"
                )
                _darwin_rename_no_replace(temp_parent_fd, temp_name, runs_fd, run_id)
                _fsync(temp_parent_fd)
                _fsync(runs_fd)
                # Darwin requires the moved directory to remain owner-writable
                # until rename. Files/reports are already immutable.
                os.fchmod(root_fd, 0o500)
                _fsync(root_fd)
            else:
                mode = os.stat(run_id, dir_fd=runs_fd, follow_symlinks=False).st_mode & 0o7777
                root_fd = _open_child_directory(
                    runs_fd, run_id, expected_mode=mode, expected_uid=uid
                )
                if mode == 0o700 and mutable:
                    # Anchored, unpublished root left by a crash immediately
                    # after rename. Validate every byte before freezing it.
                    _verify_root(root_fd, expected, mode=0o700)
                    os.fchmod(root_fd, 0o500)
                    _fsync(root_fd)
                elif mode != 0o500:
                    raise HistoricalFinalizationError()

            def verify() -> dict[str, bytes]:
                _require_configured_directory_binding(
                    runtime_fd, runtime, expected_uid=uid, label="runtime"
                )
                _require_parent_binding(runs_fd, runtime_fd, "runs", expected_uid=uid)
                _require_fd_name_identity(
                    lock_fd, runtime_fd, _PUBLISH_LOCK_NAME, label="publish lock"
                )
                _verify_regular_metadata(
                    os.fstat(lock_fd), expected_uid=uid, expected_mode=0o600, expected_size=0
                )
                _require_fd_name_identity(root_fd, runs_fd, run_id, label="published root")
                result = _verify_root(root_fd, expected)
                _require_fd_name_identity(root_fd, runs_fd, run_id, label="published root")
                return result

            verify()
            yield verify
            verify()
        finally:
            if lock_fd >= 0:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            _close_all(root_fd, temp_parent_fd, lock_fd, runs_fd, runtime_fd)
