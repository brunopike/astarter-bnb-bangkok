from __future__ import annotations

import json
from pathlib import Path

from test_backtest_process import prepare_real_runner_input
from test_report_lifecycle import RunnerProcessResult, run_runner_process

from stark_trading_os.audit.replay import project_events, project_reports, replay_digest_v1
from stark_trading_os.runner.protocol import RunnerCandidateV1


def test_two_fresh_real_subprocesses_have_the_same_economic_replay(tmp_path: Path) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir(mode=0o700)
    second_root.mkdir(mode=0o700)
    first_loaded = prepare_real_runner_input(first_root, run_id="bt_replay_a")
    second_loaded = prepare_real_runner_input(second_root, run_id="bt_replay_b")

    first = run_runner_process(first_loaded)
    second = run_runner_process(second_loaded)
    first_reports = _read_reports(first_loaded.staging_dir, first)
    second_reports = _read_reports(second_loaded.staging_dir, second)
    first_metrics_bytes = (first_loaded.staging_dir / "reports/metrics.json").read_bytes()
    second_metrics_bytes = (second_loaded.staging_dir / "reports/metrics.json").read_bytes()
    first_events = _persisted_event_envelopes(first.candidates, run_id="bt_replay_a")
    second_events = _persisted_event_envelopes(second.candidates, run_id="bt_replay_b")

    assert first_loaded.input_manifest_hash == second_loaded.input_manifest_hash
    assert first.outcome.run_id != second.outcome.run_id
    assert project_events(first_events) == project_events(second_events)
    assert project_reports(first_reports) == project_reports(second_reports)
    assert first_metrics_bytes == second_metrics_bytes
    assert "performance_series" in first_reports["metrics"]
    first_digest = replay_digest_v1(
        {
            "input_manifest_hash": first_loaded.input_manifest_hash,
            "events": first_events,
            "reports": first_reports,
        }
    )
    second_digest = replay_digest_v1(
        {
            "input_manifest_hash": second_loaded.input_manifest_hash,
            "events": second_events,
            "reports": second_reports,
        }
    )
    assert first_digest == second_digest
    assert len(first_digest) == 64


def _read_reports(staging_dir: Path, process: RunnerProcessResult) -> dict[str, object]:
    assert process.completed.returncode == 0
    assert process.outcome.result == "SUCCEEDED"
    return {
        report.name: json.loads((staging_dir / report.relative_path).read_bytes())
        for report in process.outcome.report_candidates
    }


def _persisted_event_envelopes(
    candidates: tuple[RunnerCandidateV1, ...],
    *,
    run_id: str,
) -> list[dict[str, object]]:
    return [
        {
            "run_id": run_id,
            "event_id": f"evt-{run_id}-{candidate.source_seq}",
            "seq": candidate.source_seq,
            "source_seq": candidate.source_seq,
            "ts_event_ns": candidate.ts_event_ns,
            "ts_ingest_ns": str(1_900_000_000_000_000_000 + candidate.source_seq),
            "type": candidate.type,
            "source": "runner",
            "writer": "control-api",
            "schema_version": 1,
            "payload": candidate.payload,
        }
        for candidate in candidates
    ]
