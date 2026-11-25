"""Actual child exits before the parent verifies saved native economic evidence."""

import json
import os
import subprocess
import sys
from decimal import Decimal

import pytest

from stark_trading_os.runner.historical_protocol import (
    HistoricalRunnerIdentityV2,
    HistoricalRunnerSequenceValidator,
    parse_historical_protocol_line,
)
from stark_trading_os.runner.historical_report_files import read_historical_report_files
from stark_trading_os.runner.historical_report_reader import HistoricalReportExpectationV2
from tests.integration.runner.historical_report_fixture import stage_prepared
from tests.integration.runner.sma_component_fixture import prepare_sma_case


@pytest.mark.parametrize(
    "name,closes,params,counts",
    [
        ("warmup", [100, 100, 110], {}, (0, 0, 0, 2)),
        ("entry", [100, 100, 100, 110], {}, (1, 1, 1, 4)),
        ("round_trip", [100, 100, 100, 110, 100, 90], {}, (2, 2, 1, 6)),
        ("zero_volume", [100, 100, 100, 110], {"volume": "0.000"}, (1, 0, 0, 2)),
    ],
)
def test_real_child_handoff_after_exit(tmp_path, monkeypatch, name, closes, params, counts):
    prepared = prepare_sma_case(tmp_path, closes, **params)
    args = stage_prepared(tmp_path, prepared)
    manifest = json.loads(prepared[3])
    expected = HistoricalReportExpectationV2(
        args["run_id"], prepared[3], args["expected_input_sha256"], prepared[2], "SIM-001"
    )
    identity = HistoricalRunnerIdentityV2(
        run_id=args["run_id"],
        input_manifest_sha256=args["expected_input_sha256"],
        catalog_revision=manifest["dataset"]["catalog_revision"],
        cost_sha256=manifest["cost_sha256"],
        engine_package_version="2.0.0rc3",
        account_id="SIM-001",
    )
    environment = {
        key: os.environ[key] for key in ("HOME", "PATH", "TMPDIR", "LANG") if key in os.environ
    }
    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "stark_trading_os.runner.historical_main",
            "--run-id",
            args["run_id"],
            "--staging-dir",
            str(args["staging_dir"]),
            "--input-manifest",
            str(args["input_manifest"]),
            "--expected-input-sha256",
            args["expected_input_sha256"],
        ],
        capture_output=True,
        timeout=30,
        env=environment,
    )
    assert process.returncode == 0, process.stderr.decode()
    assert process.stderr == b""
    lines = process.stdout.splitlines(keepends=True)
    assert len(lines) == 2 and len(process.stdout) < 65536
    sequence = HistoricalRunnerSequenceValidator(expected=identity)
    for line in lines:
        sequence.accept(parse_historical_protocol_line(line))
    outcome = sequence.finish(process.returncode)
    # Parent readback must not construct or run another engine.
    import stark_trading_os.runner.historical_component_run as owner

    monkeypatch.setattr(owner, "BacktestEngine", lambda *a, **k: pytest.fail("reader ran engine"))
    fd = os.open(args["staging_dir"], os.O_RDONLY | os.O_DIRECTORY)
    try:
        bundle = read_historical_report_files(
            staging_fd=fd, expected=expected, artifacts=outcome.artifacts
        )
    finally:
        os.close(fd)
    assert tuple(count for _, count in bundle.summary.table_counts) == counts
    report = json.loads(bundle.report_bytes)
    snapshot = json.loads(bundle.component_snapshot_bytes)
    assert snapshot["status"] == "COMPONENT_CHECK_PASSED"
    assert len(report["cash_series"]["points"]) == len(closes) + 1
    fills = report["tables"]["fills"]
    if name == "entry":
        assert len(fills) == 1
        assert Decimal(fills[0]["last_qty"]) == Decimal("1")
        assert Decimal(fills[0]["last_px"]) == Decimal("110")
        assert fills[0]["commission"] == "0.11 USDT"
        assert report["tables"]["positions"][0]["closing_order_id"] is None
    if name == "zero_volume":
        assert report["tables"]["orders"][0]["status"] == "REJECTED"
        assert fills == []
    expected_base, expected_quote = {
        "warmup": ("0", "1000"),
        "entry": ("1", "889.89"),
        "round_trip": ("0", "979.8"),
        "zero_volume": ("0", "1000"),
    }[name]
    final = report["cash_series"]["points"][-1]
    assert final["balances"]["ETH"]["total"] == expected_base
    assert final["balances"]["USDT"]["total"] == expected_quote
