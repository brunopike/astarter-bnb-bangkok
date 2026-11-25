"""File-backed finite native runs; lifecycle failures use explicit real-engine proxies."""

import json
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

import pytest
from nautilus_trader.execution import FillModel, MakerTakerFeeModel, StaticLatencyModel
from nautilus_trader.model import AccountType, BookType, OmsType

import stark_trading_os.runner.historical_component_run as owner
import stark_trading_os.runner.historical_sma as sma
from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision
from stark_trading_os.runner.input_adapter import InputAdapterError
from tests.integration.runner.sma_component_fixture import prepare_sma_case


def _prepared(tmp_path, closes, *, cash="1000"):
    _, _, _, raw, _ = prepare_sma_case(tmp_path, closes, cash=cash)
    run_id = "bt_" + "b" * 32
    stage = tmp_path / "runtime/staging" / run_id
    stage.mkdir(parents=True, mode=0o700)
    stage.parent.chmod(0o700)
    path = stage / "input-manifest.json"
    path.write_bytes(raw)
    path.chmod(0o600)
    return dict(
        run_id=run_id,
        staging_dir=stage,
        input_manifest=path,
        expected_input_sha256=sha256(raw).hexdigest(),
    )


@pytest.mark.parametrize(
    "closes,base,quote,fills,pnl",
    [
        ([100, 100, 110], "0", "1000", 0, None),
        ([100, 100, 100, 110], "1", "889.89", 1, "-0.11"),
        ([100, 100, 100, 110, 100, 90], "0", "979.8", 2, "-20.2"),
    ],
)
def test_file_to_native_result_preserves_cash_fees_and_finite_end(
    tmp_path: Path, closes, base, quote, fills, pnl
):
    args = _prepared(tmp_path, closes)
    before = {
        str(p.relative_to(tmp_path)): sha256(p.read_bytes()).hexdigest()
        for p in (tmp_path / "runtime/catalogs").rglob("*")
        if p.is_file()
    }
    result = owner.run_historical_sma_component(**args)
    snapshot = json.loads(result.component_snapshot_bytes)
    assert result.component_status == snapshot["status"] == "COMPONENT_CHECK_PASSED"
    assert result.run_id == args["run_id"]
    assert (
        result.input_manifest_sha256
        == snapshot["input_manifest_sha256"]
        == args["expected_input_sha256"]
    )
    manifest = json.loads(args["input_manifest"].read_bytes())
    assert result.catalog_revision == manifest["dataset"]["catalog_revision"]
    assert result.cost_sha256 == manifest["cost_sha256"]
    assert result.engine_construction_count == result.engine_run_count == 1
    assert result.engine_disposed is True
    assert snapshot["scope"] == "IN_MEMORY_COMPONENT_CHECK"
    assert len(snapshot["native_fill_facts"]) == fills
    final = snapshot["checkpoints"][-1]
    assert final["phase"] == "FINAL_POST_RUN"
    assert final["sequence"] == len(closes)
    assert final["balances"]["ETH"]["total"] == base
    assert final["balances"]["USDT"]["total"] == quote
    if pnl is not None:
        assert final["total_pnls"] == {"USDT": pnl}
    after = {
        str(p.relative_to(tmp_path)): sha256(p.read_bytes()).hexdigest()
        for p in (tmp_path / "runtime/catalogs").rglob("*")
        if p.is_file()
    }
    assert before == after


def test_bad_input_hash_never_constructs_engine(tmp_path, monkeypatch):
    args = _prepared(tmp_path, [100, 100, 100, 110])
    args["expected_input_sha256"] = "f" * 64
    monkeypatch.setattr(
        owner, "BacktestEngine", lambda **_: pytest.fail("must reject before construction")
    )
    with pytest.raises(InputAdapterError):
        owner.run_historical_sma_component(**args)


def _observe_engine(monkeypatch, *, fail=None):
    native = owner.BacktestEngine
    observed = {"events": [], "config": None, "venue": None}

    class NativeLifecycleProxy:
        def __init__(self, *, config):
            observed["events"].append("construct")
            observed["config"] = config
            self.inner = native(config=config)

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def add_venue(self, **kwargs):
            observed["venue"] = kwargs
            self.inner.add_venue(**kwargs)

        def add_data(self, bars):
            if fail == "setup":
                raise ValueError("private-native-marker")
            self.inner.add_data(bars)

        def run(self):
            observed["events"].append("run")
            if fail == "run":
                raise ValueError("private-native-marker")
            self.inner.run()

        def dispose(self):
            observed["events"].append("dispose")
            self.inner.dispose()
            if fail == "dispose":
                raise ValueError("private-native-marker")

    monkeypatch.setattr(owner, "BacktestEngine", NativeLifecycleProxy)
    return observed


def test_exact_approved_profile_reaches_real_native_engine(tmp_path, monkeypatch):
    args = _prepared(tmp_path, [100, 100, 100, 110])
    observed = _observe_engine(monkeypatch)
    result = owner.run_historical_sma_component(**args)
    assert observed["events"] == ["construct", "run", "dispose"]
    venue = observed["venue"]
    assert venue["base_currency"] is None
    assert venue["account_type"] == AccountType.CASH
    assert venue["oms_type"] == OmsType.NETTING
    assert venue["book_type"] == BookType.L1_MBP
    assert type(venue["fill_model"]) is FillModel
    assert type(venue["fee_model"]) is MakerTakerFeeModel
    assert type(venue["latency_model"]) is StaticLatencyModel
    for flag in ("use_position_ids", "bar_execution", "liquidity_consumption"):
        assert venue[flag] is True
    for flag in (
        "routing",
        "use_random_ids",
        "use_reduce_only",
        "use_market_order_acks",
        "bar_adaptive_high_low_ordering",
        "trade_execution",
        "allow_cash_borrowing",
    ):
        assert venue[flag] is False
    balances = {str(m.currency): str(m.as_decimal()) for m in venue["starting_balances"]}
    assert Decimal(balances["ETH"]) == 0 and Decimal(balances["USDT"]) == 1000
    manifest = json.loads(args["input_manifest"].read_bytes())
    assert observed["config"].risk_engine.max_notional_per_order == {
        manifest["dataset"]["instrument_id"]: "1000"
    }
    assert result.component_status == "COMPONENT_CHECK_PASSED"


@pytest.mark.parametrize("phase", ["setup", "run", "finalize", "dispose"])
def test_lifecycle_exception_attempts_cleanup_and_cannot_return_success(
    tmp_path, monkeypatch, phase
):
    args = _prepared(tmp_path, [100, 100, 100, 110])
    observed = _observe_engine(monkeypatch, fail=phase)
    if phase == "finalize":

        class FinalizeFailure(sma.HistoricalSmaStrategy):
            def finalize_component(self):
                observed["events"].append("finalize")
                super().finalize_component()
                raise ValueError("private-native-marker")

        monkeypatch.setattr(owner, "HistoricalSmaStrategy", FinalizeFailure)
    with pytest.raises(owner.HistoricalComponentFailure) as caught:
        owner.run_historical_sma_component(**args)
    assert str(caught.value) == "HISTORICAL_COMPONENT_" + phase.upper() + "_FAILED"
    assert caught.value.engine_disposed is (phase != "dispose")
    assert observed["events"].count("dispose") == 1
    assert observed["events"][-1] == "dispose"
    if phase == "finalize":
        assert observed["events"] == ["construct", "run", "finalize", "dispose"]


def test_native_reconciliation_failure_remains_failed_at_owner_boundary(tmp_path, monkeypatch):
    # Explicit test-only bypass reproduces the observed native fee-shortfall defect.
    args = _prepared(tmp_path, [100, 100, 100, 110], cash="110")
    monkeypatch.setattr(sma, "check_sma_intent", lambda **_: SmaGuardDecision("ALLOW"))
    result = owner.run_historical_sma_component(**args)
    snapshot = json.loads(result.component_snapshot_bytes)
    assert result.component_status == snapshot["status"] == "COMPONENT_CHECK_FAILED"
    assert "NATIVE_CASH_RECONCILIATION_FAILED" in snapshot["failure_codes"]
    assert result.engine_disposed is True
    final = snapshot["checkpoints"][-1]
    assert final["balances"]["ETH"]["total"] == "0"
    assert final["positions"] == [{"quantity": "1", "side": "LONG"}]
