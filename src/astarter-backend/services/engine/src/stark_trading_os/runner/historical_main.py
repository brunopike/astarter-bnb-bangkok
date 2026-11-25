"""Finite historical child entry point. Control must supply authority and supervision."""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from stark_trading_os.runner.historical_component_run import (
    HistoricalReportComponentOutput,
    run_historical_report_component,
)
from stark_trading_os.runner.historical_input_adapter import (
    LoadedHistoricalRunnerInput,
    load_historical_runner_input,
)
from stark_trading_os.runner.historical_protocol import (
    FailureCodeV2,
    HistoricalReportArtifactV2,
    HistoricalRunnerIdentityV2,
    HistoricalRunnerMessageV2,
    RunnerOutcomeV2,
    RunnerStartedV2,
    encode_historical_protocol_line,
)
from stark_trading_os.runner.historical_report_files import (
    HistoricalReportPersistenceError,
    persist_historical_report_files,
)
from stark_trading_os.runner.historical_report_reader import (
    HistoricalReportExpectationV2,
    validate_historical_report_candidate_v2,
)
from stark_trading_os.runner.input_adapter import _open_absolute_directory


class HistoricalRunnerCliError(ValueError):
    def __init__(self) -> None:
        super().__init__("historical runner input is invalid")


@dataclass(frozen=True, slots=True)
class HistoricalRunnerArgs:
    run_id: str
    staging_dir: Path
    input_manifest: Path
    expected_input_sha256: str


def parse_historical_runner_cli(argv: list[str]) -> HistoricalRunnerArgs:
    flags = {"--run-id", "--staging-dir", "--input-manifest", "--expected-input-sha256"}
    if len(argv) != 8 or set(argv[::2]) != flags or any(type(v) is not str for v in argv):
        raise HistoricalRunnerCliError()
    values = dict(zip(argv[::2], argv[1::2], strict=True))
    stage, manifest = Path(values["--staging-dir"]), Path(values["--input-manifest"])
    if (
        not re.fullmatch(r"bt_[0-9a-f]{32}", values["--run-id"])
        or not re.fullmatch(r"[0-9a-f]{64}", values["--expected-input-sha256"])
        or not stage.is_absolute()
        or not manifest.is_absolute()
    ):
        raise HistoricalRunnerCliError()
    return HistoricalRunnerArgs(
        values["--run-id"], stage, manifest, values["--expected-input-sha256"]
    )


def _require_staging_identity(path: Path, held_fd: int) -> None:
    reopened = _open_absolute_directory(path, expected_mode=0o700)
    try:
        left, right = os.fstat(held_fd), os.fstat(reopened)
        if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
            raise HistoricalRunnerCliError()
    finally:
        os.close(reopened)


def _identity(loaded: LoadedHistoricalRunnerInput) -> HistoricalRunnerIdentityV2:
    return HistoricalRunnerIdentityV2(
        run_id=loaded.run_id,
        input_manifest_sha256=loaded.input_manifest_hash,
        catalog_revision=loaded.manifest.dataset.catalog_revision,
        cost_sha256=loaded.execution_profile.cost_sha256,
        engine_package_version=loaded.runtime.engine_package_version,
        account_id="SIM-001",
    )


def _emit(stdout: BinaryIO, message: HistoricalRunnerMessageV2) -> None:
    raw = encode_historical_protocol_line(message)
    offset = 0
    while offset < len(raw):
        written = stdout.write(raw[offset:])
        if type(written) is not int or not 0 < written <= len(raw) - offset:
            raise OSError("historical runner output failed")
        offset += written
    stdout.flush()


def _require_owner_witness(
    output: HistoricalReportComponentOutput,
    identity: HistoricalRunnerIdentityV2,
) -> None:
    if type(output) is not HistoricalReportComponentOutput:
        raise ValueError("historical runner evidence invalid")
    component = output.component
    if (
        component.run_id != identity.run_id
        or component.input_manifest_sha256 != identity.input_manifest_sha256
        or component.catalog_revision != identity.catalog_revision
        or component.cost_sha256 != identity.cost_sha256
        or component.engine_construction_count != 1
        or component.engine_run_count != 1
        or component.engine_disposed is not True
    ):
        raise ValueError("historical runner evidence invalid")


def _failed(
    stdout: BinaryIO,
    identity: HistoricalRunnerIdentityV2,
    code: FailureCodeV2,
    artifacts: tuple[HistoricalReportArtifactV2, ...] = (),
) -> int:
    _emit(
        stdout,
        RunnerOutcomeV2(
            schema="RunnerOutcome.v2",
            identity=identity,
            result="FAILED",
            report_status=None,
            artifacts=artifacts,
            failure_code=code,
        ),
    )
    return 1


def execute_historical_runner(args: HistoricalRunnerArgs, *, stdout: BinaryIO) -> int:
    """Stable public boundary: no raw exception, path or credential goes to the wire."""
    staging_fd: int | None = None
    try:
        try:
            staging_fd = _open_absolute_directory(args.staging_dir, expected_mode=0o700)
            loaded = load_historical_runner_input(
                run_id=args.run_id,
                staging_dir=args.staging_dir,
                input_manifest=args.input_manifest,
                expected_input_sha256=args.expected_input_sha256,
            )
            _require_staging_identity(args.staging_dir, staging_fd)
            identity = _identity(loaded)
            expected = HistoricalReportExpectationV2(
                loaded.run_id,
                loaded.manifest_bytes,
                loaded.input_manifest_hash,
                loaded.catalog_manifest_bytes,
                identity.account_id,
            )
        except Exception:
            return 2
        _emit(stdout, RunnerStartedV2(schema="RunnerStarted.v2", identity=identity))
        try:
            result = run_historical_report_component(
                run_id=args.run_id,
                staging_dir=args.staging_dir,
                input_manifest=args.input_manifest,
                expected_input_sha256=args.expected_input_sha256,
            )
        except Exception:
            return _failed(stdout, identity, "EXECUTION_FAILED")
        try:
            _require_staging_identity(args.staging_dir, staging_fd)
            _require_owner_witness(result, identity)
            summary = validate_historical_report_candidate_v2(
                report_bytes=result.report_bytes,
                component_snapshot_bytes=result.component.component_snapshot_bytes,
                expected=expected,
            )
            component_passed = result.component.component_status == "COMPONENT_CHECK_PASSED"
            report_passed = summary.status == "INTERNAL_REPORT_CHECK_PASSED"
            if summary.status != result.report_status or (report_passed and not component_passed):
                raise ValueError("historical runner evidence invalid")
        except Exception:
            return _failed(stdout, identity, "EVIDENCE_INVALID")
        try:
            bundle = persist_historical_report_files(
                staging_fd=staging_fd,
                expected=expected,
                report_bytes=result.report_bytes,
                component_snapshot_bytes=result.component.component_snapshot_bytes,
            )
            _require_staging_identity(args.staging_dir, staging_fd)
        except HistoricalReportPersistenceError as error:
            return _failed(stdout, identity, "PERSISTENCE_FAILED", error.completed)
        except Exception:
            return _failed(stdout, identity, "PERSISTENCE_FAILED")
        passed = bundle.summary.status == "INTERNAL_REPORT_CHECK_PASSED"
        _emit(
            stdout,
            RunnerOutcomeV2(
                schema="RunnerOutcome.v2",
                identity=identity,
                result="SUCCEEDED" if passed else "FAILED",
                report_status=bundle.summary.status,
                artifacts=bundle.artifacts,
                failure_code=None if passed else "COMPONENT_CHECK_FAILED",
            ),
        )
        return 0 if passed else 1
    except Exception:
        # Includes broken/short/closed output: absent outcome is rejected by the parent.
        return 1
    finally:
        if staging_fd is not None:
            os.close(staging_fd)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_historical_runner_cli(list(sys.argv[1:] if argv is None else argv))
    except (ValueError, TypeError):
        sys.stderr.write("historical runner input is invalid\n")
        return 2
    return execute_historical_runner(args, stdout=sys.stdout.buffer)


if __name__ == "__main__":
    raise SystemExit(main())
