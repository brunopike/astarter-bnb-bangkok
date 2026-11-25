from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from pathlib import Path

import pytest
from test_backtest_process import prepare_real_runner_input

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.runner.input_adapter import LoadedRunnerInput
from stark_trading_os.runner.main import (
    ReportPersistenceError,
    execute_runner,
    parse_runner_cli,
    persist_report_files,
)
from stark_trading_os.runner.nautilus_backtest import NativeBacktestFailure
from stark_trading_os.runner.protocol import (
    RunnerCandidateV1,
    RunnerOutcomeV1,
    RunnerSequenceValidator,
    parse_protocol_line,
)

_ENGINE_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class RunnerProcessResult:
    completed: subprocess.CompletedProcess[bytes]
    candidates: tuple[RunnerCandidateV1, ...]
    outcome: RunnerOutcomeV1


def invoke_runner_process(loaded: LoadedRunnerInput) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "stark_trading_os.runner.main",
            "--run-id",
            loaded.run_id,
            "--staging-dir",
            str(loaded.staging_dir),
            "--input-manifest",
            str(loaded.staging_dir / "input-manifest.json"),
        ],
        cwd=_ENGINE_ROOT,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=30,
    )


def run_runner_process(loaded: LoadedRunnerInput) -> RunnerProcessResult:
    completed = invoke_runner_process(loaded)
    messages = tuple(
        parse_protocol_line(line) for line in completed.stdout.splitlines(keepends=True)
    )
    assert messages
    assert all(type(message) is RunnerCandidateV1 for message in messages[:-1])
    assert type(messages[-1]) is RunnerOutcomeV1
    return RunnerProcessResult(
        completed=completed,
        candidates=tuple(messages[:-1]),
        outcome=messages[-1],
    )


def test_real_module_process_writes_only_five_atomic_private_reports(
    tmp_path: Path,
) -> None:
    loaded = prepare_real_runner_input(tmp_path, run_id="bt_subprocess")

    process = run_runner_process(loaded)
    completed = process.completed

    assert completed.returncode == 0
    assert completed.stderr == b""
    outcome = process.outcome
    assert outcome.result == "SUCCEEDED"

    sequence = RunnerSequenceValidator(
        run_id=loaded.run_id,
        input_manifest_hash=loaded.input_manifest_hash,
        catalog_revision=loaded.manifest.catalog_revision,
        instrument_id=loaded.manifest.instruments[0].instrument_id,
        quote_currency=loaded.manifest.venue_account_model.currency,
    )
    for candidate in process.candidates:
        sequence.accept(candidate)
    sequence.finish(outcome)

    reports_dir = loaded.staging_dir / "reports"
    assert stat.S_IMODE(reports_dir.stat().st_mode) == 0o700
    assert {path.name for path in reports_dir.iterdir()} == {
        "orders.json",
        "fills.json",
        "positions.json",
        "account.json",
        "metrics.json",
    }
    for report in outcome.report_candidates:
        path = loaded.staging_dir / report.relative_path
        payload = path.read_bytes()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert path.stat().st_nlink == 1
        assert len(payload) == report.size_bytes
        assert sha256(payload).hexdigest() == report.sha256
        assert canonical_json_bytes(json.loads(payload)) == payload


@pytest.mark.parametrize("attack", ["existing-extra", "directory-link"])
def test_runner_never_reuses_an_existing_report_target(
    tmp_path: Path,
    attack: str,
) -> None:
    loaded = prepare_real_runner_input(tmp_path, run_id=f"bt_report_{attack}")
    reports_path = loaded.staging_dir / "reports"
    if attack == "existing-extra":
        reports_path.mkdir(mode=0o700)
        reports_path.chmod(0o700)
        extra = reports_path / "extra.json"
        extra.write_bytes(b"{}")
        extra.chmod(0o600)
    else:
        external = tmp_path / "external"
        external.mkdir(mode=0o700)
        reports_path.symlink_to(external, target_is_directory=True)

    process = run_runner_process(loaded)

    assert process.completed.returncode == 1
    assert process.completed.stderr == b""
    assert process.outcome.result == "FAILED"
    assert process.outcome.failure is not None
    assert process.outcome.failure.code == "REPORT_EXPORT_FAILED"
    assert process.outcome.report_candidates == ()
    if attack == "existing-extra":
        assert {path.name for path in reports_path.iterdir()} == {"extra.json"}
    else:
        assert list((tmp_path / "external").iterdir()) == []


def test_report_write_failure_returns_only_the_completed_ordered_prefix(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    staging = tmp_path / "staging"
    staging.mkdir(mode=0o700)
    staging.chmod(0o700)
    staging_fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY)
    real_link = os.link

    def fail_on_positions(
        source: str,
        destination: str,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> None:
        if destination == "positions.json":
            raise OSError("injected report write failure")
        real_link(
            source,
            destination,
            src_dir_fd=src_dir_fd,
            dst_dir_fd=dst_dir_fd,
            follow_symlinks=follow_symlinks,
        )

    monkeypatch.setattr(os, "link", fail_on_positions)
    try:
        with pytest.raises(ReportPersistenceError) as failure:
            persist_report_files(
                staging_fd=staging_fd,
                reports={
                    "orders": [],
                    "fills": [],
                    "positions": [],
                    "account": [],
                    "metrics": {},
                },
            )
    finally:
        os.close(staging_fd)

    assert tuple(item.name for item in failure.value.completed) == (
        "orders",
        "fills",
    )
    assert {path.name for path in (staging / "reports").iterdir()} == {
        "orders.json",
        "fills.json",
    }


def test_invalid_manifest_process_emits_no_unbound_protocol_or_reports(
    tmp_path: Path,
) -> None:
    loaded = prepare_real_runner_input(tmp_path, run_id="bt_invalid_manifest")
    manifest_path = loaded.staging_dir / "input-manifest.json"
    manifest_path.write_bytes(manifest_path.read_bytes() + b"\n")
    manifest_path.chmod(0o600)

    completed = invoke_runner_process(loaded)

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert completed.stderr == b""
    assert not (loaded.staging_dir / "reports").exists()


def test_export_failure_outcome_keeps_the_actual_emitted_candidate_cursor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loaded = prepare_real_runner_input(tmp_path, run_id="bt_export_failure")
    candidate = RunnerCandidateV1.model_validate(
        {
            "schema": "RunnerCandidate.v1",
            "run_id": loaded.run_id,
            "input_manifest_hash": loaded.input_manifest_hash,
            "catalog_revision": loaded.manifest.catalog_revision,
            "source_seq": 1,
            "ts_event_ns": "1700000000000000000",
            "type": "run.progress",
            "payload": {
                "progress": "decision",
                "decision_ts_ns": "1700000000000000000",
                "quote_identity": {
                    "instrument_id": "ETH/USDT.SIM",
                    "ts_event_ns": "1700000000000000000",
                    "ts_available_ns": "1700000000000000000",
                    "source_seq": 1,
                    "source_revision": "determinism-probe-v1",
                    "record_hash": "a" * 64,
                },
            },
        }
    )

    def fail_native_run(loaded_input: LoadedRunnerInput) -> object:
        assert loaded_input.input_manifest_hash == loaded.input_manifest_hash
        raise NativeBacktestFailure(
            code="REPORT_EXPORT_FAILED",
            candidates=(candidate,),
            node_disposed=True,
        )

    monkeypatch.setattr(
        "stark_trading_os.runner.main.run_native_backtest",
        fail_native_run,
    )
    stdout = BytesIO()
    arguments = parse_runner_cli(
        [
            "--run-id",
            loaded.run_id,
            "--staging-dir",
            str(loaded.staging_dir),
            "--input-manifest",
            str(loaded.staging_dir / "input-manifest.json"),
        ]
    )

    return_code = execute_runner(arguments, stdout=stdout)
    messages = tuple(
        parse_protocol_line(line)
        for line in stdout.getvalue().splitlines(keepends=True)
    )

    assert return_code == 1
    assert messages[0] == candidate
    assert type(messages[1]) is RunnerOutcomeV1
    assert messages[1].result == "FAILED"
    assert messages[1].last_source_seq == 1
    assert messages[1].failure is not None
    assert messages[1].failure.code == "REPORT_EXPORT_FAILED"


def test_post_persist_identity_failure_preserves_all_completed_reports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loaded = prepare_real_runner_input(tmp_path, run_id="bt_post_persist_identity")
    import stark_trading_os.runner.main as runner_main

    real_identity_check = runner_main._require_staging_path_identity
    identity_checks = 0

    def fail_after_five_reports(
        loaded_input: LoadedRunnerInput,
        staging_fd: int,
    ) -> None:
        nonlocal identity_checks
        identity_checks += 1
        if identity_checks == 3:
            raise OSError("injected post-persist identity failure")
        real_identity_check(loaded_input, staging_fd)

    monkeypatch.setattr(
        runner_main,
        "_require_staging_path_identity",
        fail_after_five_reports,
    )
    stdout = BytesIO()
    arguments = parse_runner_cli(
        [
            "--run-id",
            loaded.run_id,
            "--staging-dir",
            str(loaded.staging_dir),
            "--input-manifest",
            str(loaded.staging_dir / "input-manifest.json"),
        ]
    )

    return_code = execute_runner(arguments, stdout=stdout)
    messages = tuple(
        parse_protocol_line(line)
        for line in stdout.getvalue().splitlines(keepends=True)
    )
    outcome = messages[-1]

    assert identity_checks == 3
    assert return_code == 1
    assert type(outcome) is RunnerOutcomeV1
    assert outcome.result == "FAILED"
    assert outcome.failure is not None
    assert outcome.failure.code == "REPORT_EXPORT_FAILED"
    assert tuple(item.name for item in outcome.report_candidates) == (
        "orders",
        "fills",
        "positions",
        "account",
        "metrics",
    )
    for report in outcome.report_candidates:
        payload = (loaded.staging_dir / report.relative_path).read_bytes()
        assert len(payload) == report.size_bytes
        assert sha256(payload).hexdigest() == report.sha256
