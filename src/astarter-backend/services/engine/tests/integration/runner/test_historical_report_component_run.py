"""Actual file-to-native-report ownership and injected lifecycle failures."""

import json
from dataclasses import FrozenInstanceError
from hashlib import sha256

import pytest

import stark_trading_os.runner.historical_component_run as owner
import stark_trading_os.runner.historical_sma as sma
from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision
from stark_trading_os.runner.input_adapter import InputAdapterError
from tests.integration.runner.historical_report_fixture import stage_prepared
from tests.integration.runner.sma_component_fixture import prepare_sma_case


def prepared(tmp_path, closes, **kwargs):
    return stage_prepared(tmp_path, prepare_sma_case(tmp_path, closes, **kwargs))


def observe(monkeypatch, *, fail=None):
    native = owner.BacktestEngine
    events = []

    class ObservedStrategy(sma.HistoricalSmaStrategy):
        def finalize_component(self):
            value = super().finalize_component()
            events.append("finalized")
            return value

    class Proxy:
        def __init__(self, **kwargs):
            events.append("construct")
            self.inner = native(**kwargs)

        def __getattr__(self, key):
            return getattr(self.inner, key)

        def run(self):
            events.append("run")
            self.inner.run()
            events.append("run-returned")

        def generate_orders_report(self):
            events.append("orders")
            if fail in {"capture", "capture_dispose"}:
                raise ValueError("private-capture-marker")
            assert events[-2] == "finalized"
            return self.inner.generate_orders_report()

        def generate_fills_report(self):
            events.append("fills")
            return self.inner.generate_fills_report()

        def generate_positions_report(self):
            events.append("positions")
            return self.inner.generate_positions_report()

        def generate_account_report(self, venue):
            events.append("account")
            return self.inner.generate_account_report(venue)

        def dispose(self):
            events.append("dispose")
            self.inner.dispose()
            if fail in {"dispose", "capture_dispose"}:
                raise ValueError("private-dispose-marker")

    monkeypatch.setattr(owner, "BacktestEngine", Proxy)
    monkeypatch.setattr(owner, "HistoricalSmaStrategy", ObservedStrategy)
    return events


@pytest.mark.parametrize(
    "closes,base,quote,counts",
    [
        ([100, 100, 110], "0", "1000", (0, 0, 0, 2)),
        ([100, 100, 100, 110], "1", "889.89", (1, 1, 1, 4)),
        ([100, 100, 100, 110, 100, 90], "0", "979.8", (2, 2, 1, 6)),
    ],
)
def test_opt_in_report_is_captured_after_run_before_single_dispose(
    tmp_path, monkeypatch, closes, base, quote, counts
):
    args = prepared(tmp_path, closes)
    paths = [args["input_manifest"], *(tmp_path / "runtime/catalogs").rglob("*")]
    before = {str(p): sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}
    events = observe(monkeypatch)
    result = owner.run_historical_report_component(**args)
    assert events == [
        "construct",
        "run",
        "run-returned",
        "finalized",
        "orders",
        "fills",
        "positions",
        "account",
        "dispose",
    ]
    component = result.component
    report = json.loads(result.report_bytes)
    assert component.engine_construction_count == component.engine_run_count == 1
    assert component.engine_disposed is True
    assert component.component_status == "COMPONENT_CHECK_PASSED"
    assert result.report_status == report["status"] == "INTERNAL_REPORT_CHECK_PASSED"
    assert report["identity"]["run_id"] == args["run_id"]
    assert report["identity"]["account_id"] == "SIM-001"
    assert report["identity"]["input_manifest_sha256"] == args["expected_input_sha256"]
    assert (
        report["component_snapshot_sha256"]
        == sha256(component.component_snapshot_bytes).hexdigest()
    )
    assert (
        tuple(len(report["tables"][k]) for k in ("orders", "fills", "positions", "account"))
        == counts
    )
    points = report["cash_series"]["points"]
    assert len(points) == len(closes) + 1 and points[-1]["sequence"] == len(closes)
    assert points[-1]["balances"]["ETH"]["total"] == base
    assert points[-1]["balances"]["USDT"]["total"] == quote
    if len(closes) == 4:
        assert points[-2]["balances"]["ETH"]["total"] == "0"
        assert report["tables"]["positions"][0]["closing_order_id"] is None
        assert points[-1]["total_pnls"] == {"USDT": "-0.11"}
    assert before == {str(p): sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}
    with pytest.raises(FrozenInstanceError):
        result.report_bytes = b"changed"


@pytest.mark.parametrize(
    "failure,code,disposed",
    [
        ("capture", "HISTORICAL_COMPONENT_REPORT_FAILED", True),
        ("serialize", "HISTORICAL_COMPONENT_REPORT_FAILED", True),
        ("dispose", "HISTORICAL_COMPONENT_DISPOSE_FAILED", False),
        ("capture_dispose", "HISTORICAL_COMPONENT_DISPOSE_FAILED", False),
    ],
)
def test_capture_or_disposal_failure_cannot_return_a_success(
    tmp_path, monkeypatch, failure, code, disposed
):
    args = prepared(tmp_path, [100, 100, 100, 110])
    events = observe(monkeypatch, fail=failure)
    if failure == "serialize":

        def fail_builder(**kwargs):
            raise ValueError("private-serialization-marker")

        monkeypatch.setattr(owner, "build_historical_report_component_v2", fail_builder)
    with pytest.raises(owner.HistoricalComponentFailure) as caught:
        owner.run_historical_report_component(**args)
    assert str(caught.value) == code
    assert caught.value.engine_disposed is disposed
    assert events.count("dispose") == 1 and events[-1] == "dispose"
    assert events[:4] == ["construct", "run", "run-returned", "finalized"]


def test_old_owner_does_not_collect_any_report_tables(tmp_path, monkeypatch):
    args = prepared(tmp_path, [100, 100, 100, 110])
    events = observe(monkeypatch, fail="capture")
    result = owner.run_historical_sma_component(**args)
    assert result.component_status == "COMPONENT_CHECK_PASSED"
    assert events == ["construct", "run", "run-returned", "finalized", "dispose"]


def test_report_bad_hash_still_rejects_before_engine_construction(tmp_path, monkeypatch):
    args = prepared(tmp_path, [100, 100, 100, 110])
    args["expected_input_sha256"] = "f" * 64
    monkeypatch.setattr(
        owner, "BacktestEngine", lambda **_: pytest.fail("constructed before input validation")
    )
    with pytest.raises(InputAdapterError):
        owner.run_historical_report_component(**args)


def test_actual_native_cash_failure_survives_complete_report(tmp_path, monkeypatch):
    args = prepared(tmp_path, [100, 100, 100, 110], cash="110")
    monkeypatch.setattr(sma, "check_sma_intent", lambda **_: SmaGuardDecision("ALLOW"))
    result = owner.run_historical_report_component(**args)
    report = json.loads(result.report_bytes)
    assert result.component.component_status == "COMPONENT_CHECK_FAILED"
    assert result.report_status == "INTERNAL_REPORT_CHECK_FAILED"
    assert "NATIVE_CASH_RECONCILIATION_FAILED" in report["cash_series"]["failure_codes"]
    final = report["cash_series"]["points"][-1]
    assert final["balances"]["ETH"]["total"] == "0"
    assert final["positions"] == [{"quantity": "1", "side": "LONG"}]
    assert report["tables"]["positions"][0]["quantity"] == "1"
    assert result.component.engine_disposed is True
