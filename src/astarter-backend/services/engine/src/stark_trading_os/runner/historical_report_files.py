"""Private create-only historical files; candidate metadata is not a DB seal."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Literal, cast

from stark_trading_os.runner.historical_protocol import (
    MAX_ARTIFACT_BYTES_V2,
    REPORT_FILES_V2,
    HistoricalReportArtifactV2,
    validate_artifact_prefix,
)
from stark_trading_os.runner.historical_report_reader import (
    HistoricalReportExpectationV2,
    ValidatedHistoricalReportV2,
    reverify_historical_report_v2,
    validate_historical_report_candidate_v2,
)
from stark_trading_os.runner.input_adapter import (
    InputAdapterError,
    _open_child_directory,
    _read_one_regular_file,
)
from stark_trading_os.runner.main import _write_all
from stark_trading_os.runner.report_export import ReportSchemaError

_INVALID = "historical report files are invalid"


@dataclass(frozen=True, slots=True)
class HistoricalReportFileBundleV2:
    report_bytes: bytes
    component_snapshot_bytes: bytes
    summary: ValidatedHistoricalReportV2
    artifacts: tuple[HistoricalReportArtifactV2, ...]


class HistoricalReportPersistenceError(RuntimeError):
    def __init__(self, completed: tuple[HistoricalReportArtifactV2, ...]) -> None:
        super().__init__("historical report persistence failed")
        self.completed = completed


def _require_private_directory(fd: int) -> None:
    if type(fd) is not int:
        raise ValueError(_INVALID)
    metadata = os.fstat(fd)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ValueError(_INVALID)


def _require_report_directory_identity(staging_fd: int, reports_fd: int) -> None:
    _require_private_directory(staging_fd)
    _require_private_directory(reports_fd)
    current = os.stat("reports", dir_fd=staging_fd, follow_symlinks=False)
    opened = os.fstat(reports_fd)
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (
        opened.st_dev,
        opened.st_ino,
    ):
        raise ValueError(_INVALID)


def read_historical_report_files(
    *,
    staging_fd: int,
    expected: HistoricalReportExpectationV2,
    artifacts: tuple[HistoricalReportArtifactV2, ...],
) -> HistoricalReportFileBundleV2:
    """Read original bytes against supplied digests, which the caller must anchor."""
    reports_fd: int | None = None
    try:
        validate_artifact_prefix(artifacts)
        if len(artifacts) != len(REPORT_FILES_V2):
            raise ValueError(_INVALID)
        _require_private_directory(staging_fd)
        reports_fd = _open_child_directory(staging_fd, "reports", expected_mode=0o700)
        _require_report_directory_identity(staging_fd, reports_fd)
        names = {filename for _, filename in REPORT_FILES_V2}
        if set(os.listdir(reports_fd)) != names:
            raise ValueError(_INVALID)
        payloads = []
        for metadata, (_, filename) in zip(artifacts, REPORT_FILES_V2, strict=True):
            raw = _read_one_regular_file(
                Path(filename),
                dir_fd=reports_fd,
                max_bytes=MAX_ARTIFACT_BYTES_V2,
                expected_mode=0o600,
                label="REPORT",
            )
            if len(raw) != metadata.size_bytes or sha256(raw).hexdigest() != metadata.sha256:
                raise ValueError(_INVALID)
            payloads.append(raw)
        _require_report_directory_identity(staging_fd, reports_fd)
        if set(os.listdir(reports_fd)) != names:
            raise ValueError(_INVALID)
        summary = reverify_historical_report_v2(
            report_bytes=payloads[1],
            component_snapshot_bytes=payloads[0],
            expected=expected,
            expected_report_sha256=artifacts[1].sha256,
            expected_component_snapshot_sha256=artifacts[0].sha256,
        )
        return HistoricalReportFileBundleV2(payloads[1], payloads[0], summary, artifacts)
    except (OSError, ValueError, TypeError, InputAdapterError) as error:
        raise ReportSchemaError(_INVALID) from error
    finally:
        if reports_fd is not None:
            os.close(reports_fd)


def _publish_file(*, reports_fd: int, filename: str, payload: bytes) -> None:
    pending = "." + filename + ".pending"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(pending, flags, 0o600, dir_fd=reports_fd)
    owned = os.fstat(descriptor)
    try:
        os.fchmod(descriptor, 0o600)
        _write_all(descriptor, payload)
        os.fsync(descriptor)
        now = os.stat(pending, dir_fd=reports_fd, follow_symlinks=False)
        if (now.st_dev, now.st_ino) != (owned.st_dev, owned.st_ino):
            raise ValueError(_INVALID)
        os.link(
            pending, filename, src_dir_fd=reports_fd, dst_dir_fd=reports_fd, follow_symlinks=False
        )
    finally:
        os.close(descriptor)
        # Remove only the temporary inode created by this invocation.
        try:
            now = os.stat(pending, dir_fd=reports_fd, follow_symlinks=False)
            if (now.st_dev, now.st_ino) == (owned.st_dev, owned.st_ino):
                os.unlink(pending, dir_fd=reports_fd)
        except FileNotFoundError:
            pass
    os.fsync(reports_fd)


def persist_historical_report_files(
    *,
    staging_fd: int,
    report_bytes: bytes,
    component_snapshot_bytes: bytes,
    expected: HistoricalReportExpectationV2,
) -> HistoricalReportFileBundleV2:
    """Validate before writing, preserve successful prefixes on any storage failure."""
    validate_historical_report_candidate_v2(
        report_bytes=report_bytes,
        component_snapshot_bytes=component_snapshot_bytes,
        expected=expected,
    )
    completed: list[HistoricalReportArtifactV2] = []
    reports_fd: int | None = None
    try:
        _require_private_directory(staging_fd)
        os.mkdir("reports", mode=0o700, dir_fd=staging_fd)
        reports_fd = _open_child_directory(staging_fd, "reports", expected_mode=0o700)
        os.fsync(staging_fd)
        for (name, filename), payload in zip(
            REPORT_FILES_V2,
            (component_snapshot_bytes, report_bytes),
            strict=True,
        ):
            _require_report_directory_identity(staging_fd, reports_fd)
            _publish_file(reports_fd=reports_fd, filename=filename, payload=payload)
            _require_report_directory_identity(staging_fd, reports_fd)
            completed.append(
                HistoricalReportArtifactV2(
                    name=cast(Literal["component_snapshot", "historical_report"], name),
                    path="reports/" + filename,
                    sha256=sha256(payload).hexdigest(),
                    size_bytes=len(payload),
                )
            )
        return read_historical_report_files(
            staging_fd=staging_fd, expected=expected, artifacts=tuple(completed)
        )
    except (OSError, ValueError, TypeError, InputAdapterError) as error:
        raise HistoricalReportPersistenceError(tuple(completed)) from error
    finally:
        if reports_fd is not None:
            os.close(reports_fd)
