"""Strict CLI entry point for the isolated backtest runner."""

from __future__ import annotations

import argparse
import os
import stat
import sys
from collections.abc import Mapping, Sequence
from hashlib import sha256
from pathlib import Path
from typing import BinaryIO, Literal

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.runner.input_adapter import (
    InputAdapterError,
    LoadedRunnerInput,
    _open_absolute_directory,
    load_runner_input,
)
from stark_trading_os.runner.nautilus_backtest import (
    NativeBacktestFailure,
    run_native_backtest,
)
from stark_trading_os.runner.protocol import (
    ProtocolMessage,
    RunnerFailureV1,
    RunnerOutcomeV1,
    RunnerReportCandidateV1,
    RunnerSequenceValidator,
    encode_protocol_line,
)

type ReportName = Literal["orders", "fills", "positions", "account", "metrics"]

_REPORT_NAMES: tuple[ReportName, ...] = (
    "orders",
    "fills",
    "positions",
    "account",
    "metrics",
)


class ReportPersistenceError(RuntimeError):
    """Raised with only the fixed report prefix completed before a write failure."""

    def __init__(
        self,
        completed: tuple[RunnerReportCandidateV1, ...],
    ) -> None:
        super().__init__("REPORT_PERSISTENCE_FAILED")
        self.completed = completed


def parse_runner_cli(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--staging-dir", required=True, type=Path)
    parser.add_argument("--input-manifest", required=True, type=Path)
    arguments = list(sys.argv[1:] if argv is None else argv)
    for option in ("--run-id", "--staging-dir", "--input-manifest"):
        occurrences = sum(
            item == option or item.startswith(f"{option}=") for item in arguments
        )
        if occurrences != 1:
            parser.error(f"{option} must occur exactly once")
    return parser.parse_args(arguments)


def persist_report_files(
    *,
    staging_fd: int,
    reports: Mapping[str, object],
) -> tuple[RunnerReportCandidateV1, ...]:
    """Create the fixed report set without replacing an existing path."""

    completed: list[RunnerReportCandidateV1] = []
    reports_fd = -1
    temporary_name: str | None = None
    try:
        if set(reports) != set(_REPORT_NAMES):
            raise ValueError("REPORT_SET_INVALID")
        os.mkdir("reports", mode=0o700, dir_fd=staging_fd)
        reports_fd = os.open(
            "reports",
            os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=staging_fd,
        )
        os.fchmod(reports_fd, 0o700)
        for name in _REPORT_NAMES:
            payload = canonical_json_bytes(reports[name])
            temporary_name = f".{name}.json.pending"
            final_name = f"{name}.json"
            descriptor = os.open(
                temporary_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
                dir_fd=reports_fd,
            )
            try:
                os.fchmod(descriptor, 0o600)
                _write_all(descriptor, payload)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.link(
                temporary_name,
                final_name,
                src_dir_fd=reports_fd,
                dst_dir_fd=reports_fd,
                follow_symlinks=False,
            )
            os.unlink(temporary_name, dir_fd=reports_fd)
            temporary_name = None
            os.fsync(reports_fd)
            completed.append(
                RunnerReportCandidateV1(
                    name=name,
                    relative_path=f"reports/{final_name}",
                    sha256=sha256(payload).hexdigest(),
                    size_bytes=len(payload),
                )
            )
        _verify_report_directory(reports_fd, tuple(completed))
        return tuple(completed)
    except (OSError, TypeError, ValueError) as error:
        if reports_fd >= 0 and temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=reports_fd)
            except OSError:
                pass
        raise ReportPersistenceError(tuple(completed)) from error
    finally:
        if reports_fd >= 0:
            os.close(reports_fd)


def execute_runner(
    arguments: argparse.Namespace,
    *,
    stdout: BinaryIO,
) -> int:
    try:
        loaded = load_runner_input(
            run_id=arguments.run_id,
            staging_dir=arguments.staging_dir,
            input_manifest=arguments.input_manifest,
        )
    except InputAdapterError:
        return 2

    staging_fd = -1
    try:
        try:
            staging_fd = _open_absolute_directory(
                loaded.staging_dir,
                expected_mode=0o700,
            )
            _require_staging_path_identity(loaded, staging_fd)
            output = run_native_backtest(loaded)
        except NativeBacktestFailure as error:
            sequence = RunnerSequenceValidator(
                run_id=loaded.run_id,
                input_manifest_hash=loaded.input_manifest_hash,
                catalog_revision=loaded.manifest.catalog_revision,
                instrument_id=loaded.manifest.instruments[0].instrument_id,
                quote_currency=loaded.manifest.venue_account_model.currency,
            )
            for candidate in error.candidates:
                sequence.accept(candidate)
                _write_protocol(stdout, candidate)
            outcome = _build_outcome(
                loaded=loaded,
                result="FAILED",
                last_source_seq=sequence.last_source_seq,
                report_candidates=(),
                failure=RunnerFailureV1(
                    code=error.code,
                    message=(
                        "native report export failed"
                        if error.code == "REPORT_EXPORT_FAILED"
                        else "native execution failed"
                    ),
                ),
            )
            sequence.finish(outcome)
            _write_protocol(stdout, outcome)
            return 1
        except Exception:
            _emit_outcome(
                stdout,
                loaded=loaded,
                result="FAILED",
                last_source_seq=0,
                report_candidates=(),
                failure=RunnerFailureV1(
                    code="RUNNER_EXECUTION_FAILED",
                    message="native execution failed",
                ),
            )
            return 1

        sequence = RunnerSequenceValidator(
            run_id=loaded.run_id,
            input_manifest_hash=loaded.input_manifest_hash,
            catalog_revision=loaded.manifest.catalog_revision,
            instrument_id=loaded.manifest.instruments[0].instrument_id,
            quote_currency=loaded.manifest.venue_account_model.currency,
        )
        for candidate in output.candidates:
            sequence.accept(candidate)
            _write_protocol(stdout, candidate)

        report_candidates: tuple[RunnerReportCandidateV1, ...] = ()
        try:
            _require_staging_path_identity(loaded, staging_fd)
            report_candidates = persist_report_files(
                staging_fd=staging_fd,
                reports=output.reports,
            )
            _require_staging_path_identity(loaded, staging_fd)
        except ReportPersistenceError as error:
            outcome = _build_outcome(
                loaded=loaded,
                result="FAILED",
                last_source_seq=sequence.last_source_seq,
                report_candidates=error.completed,
                failure=RunnerFailureV1(
                    code="REPORT_EXPORT_FAILED",
                    message="native report persistence failed",
                ),
            )
            sequence.finish(outcome)
            _write_protocol(stdout, outcome)
            return 1
        except Exception:
            outcome = _build_outcome(
                loaded=loaded,
                result="FAILED",
                last_source_seq=sequence.last_source_seq,
                report_candidates=report_candidates,
                failure=RunnerFailureV1(
                    code="REPORT_EXPORT_FAILED",
                    message="native report persistence failed",
                ),
            )
            sequence.finish(outcome)
            _write_protocol(stdout, outcome)
            return 1

        outcome = _build_outcome(
            loaded=loaded,
            result="SUCCEEDED",
            last_source_seq=sequence.last_source_seq,
            report_candidates=report_candidates,
            failure=None,
        )
        sequence.finish(outcome)
        _write_protocol(stdout, outcome)
        return 0
    finally:
        if staging_fd >= 0:
            os.close(staging_fd)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = parse_runner_cli(argv)
    return execute_runner(arguments, stdout=sys.stdout.buffer)


def _build_outcome(
    *,
    loaded: LoadedRunnerInput,
    result: str,
    last_source_seq: int,
    report_candidates: tuple[RunnerReportCandidateV1, ...],
    failure: RunnerFailureV1 | None,
) -> RunnerOutcomeV1:
    return RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": loaded.run_id,
            "input_manifest_hash": loaded.input_manifest_hash,
            "catalog_revision": loaded.manifest.catalog_revision,
            "engine_package_version": loaded.manifest.engine_package_version,
            "result": result,
            "last_source_seq": last_source_seq,
            "report_candidates": [
                report.model_dump(mode="json", by_alias=True)
                for report in report_candidates
            ],
            "failure": (
                failure.model_dump(mode="json", by_alias=True)
                if failure is not None
                else None
            ),
        }
    )


def _emit_outcome(
    stdout: BinaryIO,
    *,
    loaded: LoadedRunnerInput,
    result: str,
    last_source_seq: int,
    report_candidates: tuple[RunnerReportCandidateV1, ...],
    failure: RunnerFailureV1 | None,
) -> None:
    _write_protocol(
        stdout,
        _build_outcome(
            loaded=loaded,
            result=result,
            last_source_seq=last_source_seq,
            report_candidates=report_candidates,
            failure=failure,
        ),
    )


def _write_protocol(stdout: BinaryIO, message: ProtocolMessage) -> None:
    stdout.write(encode_protocol_line(message))
    stdout.flush()


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            raise OSError("REPORT_WRITE_INCOMPLETE")
        offset += written


def _require_staging_path_identity(loaded: LoadedRunnerInput, staging_fd: int) -> None:
    reopened = _open_absolute_directory(loaded.staging_dir, expected_mode=0o700)
    try:
        retained = os.fstat(staging_fd)
        current = os.fstat(reopened)
        if (retained.st_dev, retained.st_ino) != (current.st_dev, current.st_ino):
            raise OSError("STAGING_DIRECTORY_CHANGED")
    finally:
        os.close(reopened)


def _verify_report_directory(
    reports_fd: int,
    candidates: tuple[RunnerReportCandidateV1, ...],
) -> None:
    expected = {f"{name}.json" for name in _REPORT_NAMES}
    with os.scandir(reports_fd) as entries:
        if {entry.name for entry in entries} != expected:
            raise OSError("REPORT_FILE_SET_INVALID")
    for candidate in candidates:
        filename = f"{candidate.name}.json"
        descriptor = os.open(
            filename,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=reports_fd,
        )
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
                or metadata.st_size != candidate.size_bytes
            ):
                raise OSError("REPORT_FILE_INVALID")
            payload = os.read(descriptor, candidate.size_bytes + 1)
            if sha256(payload).hexdigest() != candidate.sha256:
                raise OSError("REPORT_FILE_HASH_MISMATCH")
        finally:
            os.close(descriptor)


if __name__ == "__main__":
    raise SystemExit(main())
