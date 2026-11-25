"""Actual owner disposal followed by independent saved-file verification."""

import json
from copy import deepcopy
from hashlib import sha256

import nautilus_trader.backtest as native
import pytest

import stark_trading_os.runner.historical_component_run as owner
import stark_trading_os.runner.historical_input_adapter as loader
import stark_trading_os.runner.historical_sma as sma
import stark_trading_os.runner.report_export as exporter
from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.runner.historical_report_reader import (
    HistoricalReportExpectationV2,
    reverify_historical_report_v2,
    validate_historical_report_candidate_v2,
)
from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision
from stark_trading_os.runner.report_export import ReportSchemaError
from tests.integration.runner.historical_report_fixture import stage_prepared
from tests.integration.runner.sma_component_fixture import prepare_sma_case
from tests.integration.runner.test_historical_report_component_run import observe


@pytest.mark.parametrize(
    "name,closes,params,counts,base,quote",
    [
        ("warmup", [100, 100, 110], {}, (0, 0, 0, 2), "0", "1000"),
        ("entry", [100, 100, 100, 110], {}, (1, 1, 1, 4), "1", "889.89"),
        ("round_trip", [100, 100, 100, 110, 100, 90], {}, (2, 2, 1, 6), "0", "979.8"),
        ("denied", [100, 100, 100, 110], {"max_notional": "100"}, (1, 0, 0, 2), "0", "1000"),
        ("zero_volume", [100, 100, 100, 110], {"volume": "0.000"}, (1, 0, 0, 2), "0", "1000"),
        (
            "split",
            [100, 100, 100, 110],
            dict(quantity="1000", max_position="2000", cash="1000000", max_notional="1000000"),
            (1, 2, 1, 6),
            "1000",
            "889880.24025",
        ),
        ("native_failed", [100, 100, 100, 110], {"cash": "110"}, (1, 1, 1, 4), "0", "110"),
    ],
)
def test_saved_reports_remain_verifiable_after_single_actual_disposal(
    tmp_path, monkeypatch, name, closes, params, counts, base, quote
):
    prepared = prepare_sma_case(tmp_path, closes, **params)
    args = stage_prepared(tmp_path, prepared)
    # These inputs exist before execution. The report cannot choose the expectation.
    expected = HistoricalReportExpectationV2(
        run_id=args["run_id"],
        input_manifest_bytes=prepared[3],
        input_manifest_sha256=args["expected_input_sha256"],
        catalog_manifest_bytes=prepared[2],
        account_id="SIM-001",
    )
    if name in {"denied", "native_failed"}:
        # Test-only bypass reaches the actual native denial/cash failure paths.
        monkeypatch.setattr(sma, "check_sma_intent", lambda **_: SmaGuardDecision("ALLOW"))
    events = observe(monkeypatch)
    result = owner.run_historical_report_component(**args)
    assert events.count("construct") == events.count("run") == events.count("dispose") == 1
    assert events[-1] == "dispose" and result.component.engine_disposed
    before_events = list(events)
    report_path, snapshot_path = tmp_path / "saved-report.json", tmp_path / "saved-component.json"
    report_path.write_bytes(result.report_bytes)
    snapshot_path.write_bytes(result.component.component_snapshot_bytes)
    report_hash = sha256(result.report_bytes).hexdigest()
    snapshot_hash = sha256(result.component.component_snapshot_bytes).hexdigest()

    def forbidden(*args, **kwargs):
        raise AssertionError("saved report verification must not construct or load an engine")

    monkeypatch.setattr(owner, "BacktestEngine", forbidden)
    monkeypatch.setattr(native, "BacktestEngine", forbidden)
    monkeypatch.setattr(exporter, "BacktestNode", forbidden)
    monkeypatch.setattr(loader, "observe_historical_runtime", forbidden)
    monkeypatch.setattr(loader, "load_historical_runner_input", forbidden)
    raw, snapshot_raw = report_path.read_bytes(), snapshot_path.read_bytes()
    report = json.loads(raw)
    snapshot = json.loads(snapshot_raw)
    verified = validate_historical_report_candidate_v2(
        report_bytes=raw,
        component_snapshot_bytes=snapshot_raw,
        expected=expected,
    )
    assert verified == reverify_historical_report_v2(
        report_bytes=raw,
        component_snapshot_bytes=snapshot_raw,
        expected=expected,
        expected_report_sha256=report_hash,
        expected_component_snapshot_sha256=snapshot_hash,
    )
    assert tuple(n for _, n in verified.table_counts) == counts
    points = report["cash_series"]["points"]
    assert points[-1]["balances"]["ETH"]["total"] == base
    assert points[-1]["balances"]["USDT"]["total"] == quote
    assert snapshot["checkpoints"][-1]["clock_ns"] > 2**53
    assert points[-1]["clock_ns"] == str(snapshot["checkpoints"][-1]["clock_ns"])
    assert len(points) == len(closes) + 1 and points[-1]["phase"] == "FINAL_POST_RUN"
    if name == "entry":
        assert points[-2]["balances"]["ETH"]["total"] == "0"
        assert report["tables"]["positions"][0]["closing_order_id"] is None
    if name == "zero_volume":
        assert points[-1]["pending_orders"] == []
        assert report["tables"]["orders"][0]["status"] == "REJECTED"
        assert report["tables"]["orders"][0]["time_in_force"] == "GTC"
        assert report["tables"]["orders"][0]["filled_qty"] == "0"
    if name == "denied":
        assert report["tables"]["orders"][0]["status"] == "DENIED"
    if name == "split":
        assert [
            (f["last_qty"], f["last_px"], f["commission"]) for f in report["tables"]["fills"]
        ] == [("25", "110", "2.75 USDT"), ("975", "110.01", "107.25975 USDT")]
        rows = report["tables"]["account"]
        keys = [(r["ts_event_ns"], r["currency"]) for r in rows]
        assert len(keys) > len(set(keys))  # Distinct same-time snapshots survive.
    if name == "native_failed":
        assert verified.status == "INTERNAL_REPORT_CHECK_FAILED"
        assert "COMPONENT_CHECK_FAILED" in verified.consistency_failures
        assert "NATIVE_CASH_RECONCILIATION_FAILED" in report["cash_series"]["failure_codes"]
        assert points[-1]["positions"] == [{"quantity": "1", "side": "LONG"}]
        washed_report, washed_snapshot = deepcopy(report), deepcopy(snapshot)
        washed_snapshot.update(status="COMPONENT_CHECK_PASSED", failure_codes=[])
        washed_report["cash_series"].update(
            component_status="COMPONENT_CHECK_PASSED", failure_codes=[]
        )
        washed_report.update(status="INTERNAL_REPORT_CHECK_PASSED", consistency_failures=[])
        washed_bytes = canonical_historical_bytes(washed_snapshot)
        washed_report["component_snapshot_sha256"] = sha256(washed_bytes).hexdigest()
        with pytest.raises(ReportSchemaError, match="^historical report evidence is invalid$"):
            validate_historical_report_candidate_v2(
                report_bytes=canonical_historical_bytes(washed_report),
                component_snapshot_bytes=washed_bytes,
                expected=expected,
            )
    else:
        assert verified.status == "INTERNAL_REPORT_CHECK_PASSED"
    assert events == before_events
    assert raw == result.report_bytes and snapshot_raw == result.component.component_snapshot_bytes

    # A corrupt on-disk artifact fails anchored reverification, even for failed runs.
    for field in ("report_bytes", "component_snapshot_bytes"):
        altered = dict(report_bytes=raw, component_snapshot_bytes=snapshot_raw)
        altered[field] += b" "
        with pytest.raises(ReportSchemaError):
            reverify_historical_report_v2(
                **altered,
                expected=expected,
                expected_report_sha256=report_hash,
                expected_component_snapshot_sha256=snapshot_hash,
            )
    assert report_path.read_bytes() == raw and snapshot_path.read_bytes() == snapshot_raw
