from hashlib import sha256
from pathlib import Path

import pytest

import stark_trading_os.runner.historical_sma as sma_module
from stark_trading_os.runner.historical_sma import HistoricalSmaStrategy
from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision
from tests.integration.runner.sma_component_fixture import execute_sma_case, prepare_sma_case


def test_warmup_produces_no_orders(tmp_path: Path) -> None:
    result = execute_sma_case(prepare_sma_case(tmp_path, [100, 100, 110]))
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert result["native_orders"] == []
    assert result["decisions"] == []
    assert len(result["checkpoints"]) == 4


def test_final_bar_first_entry_is_preserved_with_native_fee_in_pnl(tmp_path: Path) -> None:
    result = execute_sma_case(prepare_sma_case(tmp_path, [100, 100, 100, 110]))
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert len(result["native_orders"]) == len(result["native_fills"]) == 1
    final = result["checkpoints"][-1]
    assert final["phase"] == "FINAL_POST_RUN"
    assert final["balances"]["ETH"]["total"] == "1"
    assert final["balances"]["USDT"]["total"] == "889.89"
    assert final["positions"] == [{"quantity": "1", "side": "LONG"}]
    assert final["realized_pnls"] == final["total_pnls"] == {"USDT": "-0.11"}
    assert final["base_currency_equity"] is None
    assert result["source_unchanged"] is True
    assert result["scope"] == "IN_MEMORY_COMPONENT_CHECK"


def test_cross_down_exits_only_confirmed_position_and_preserves_native_net_pnl(
    tmp_path: Path,
) -> None:
    result = execute_sma_case(prepare_sma_case(tmp_path, [100, 100, 100, 110, 100, 90]))
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert [row["side"] for row in result["decisions"]] == ["BUY", "SELL"]
    assert [row["code"] for row in result["decisions"]] == ["SUBMITTED", "SUBMITTED"]
    final = result["checkpoints"][-1]
    assert final["balances"]["ETH"]["total"] == "0"
    assert final["balances"]["USDT"]["total"] == "979.8"
    assert final["total_pnls"] == {"USDT": "-20.2"}
    assert final["positions"] == []


def test_fee_shortfall_is_blocked_before_native_submission(tmp_path: Path) -> None:
    result = execute_sma_case(prepare_sma_case(tmp_path, [100, 100, 100, 110], cash="110"))
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert result["native_orders"] == []
    assert result["decisions"][-1]["code"] == "INSUFFICIENT_CASH"
    assert result["checkpoints"][-1]["balances"]["USDT"]["total"] == "110"


def test_full_exit_above_notional_limit_is_blocked_and_not_split(tmp_path: Path) -> None:
    prepared = prepare_sma_case(tmp_path, [100, 100, 100, 110, 200, 190, 180], max_notional="150")
    result = execute_sma_case(prepared)
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert result["decisions"][-1]["code"] == "EXIT_LIMIT_BLOCKED"
    assert len(result["native_orders"]) == 1
    assert result["checkpoints"][-1]["positions"] == [{"quantity": "1", "side": "LONG"}]


def test_native_cash_discrepancy_latches_failure_and_preserves_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Deliberate test-only guard bypass reproduces the known native fee-shortfall defect.
    monkeypatch.setattr(sma_module, "check_sma_intent", lambda **_: SmaGuardDecision("ALLOW"))
    result = execute_sma_case(
        prepare_sma_case(tmp_path, [100, 100, 100, 110, 100, 90, 110, 120], cash="110")
    )
    assert result["status"] == "COMPONENT_CHECK_FAILED"
    assert "NATIVE_CASH_RECONCILIATION_FAILED" in result["failure_codes"]
    assert len(result["native_orders"]) == 1
    assert result["checkpoints"][-1]["balances"]["ETH"]["total"] == "0"
    assert result["checkpoints"][-1]["positions"] == [{"quantity": "1", "side": "LONG"}]


def test_duplicate_bar_rejected_before_engine_construction(tmp_path: Path) -> None:
    _, bars, catalog_raw, input_raw, _ = prepare_sma_case(tmp_path, [100, 100, 100, 110])
    with pytest.raises(ValueError, match="SMA_COMPONENT_BARS_INVALID"):
        HistoricalSmaStrategy(
            input_bytes=input_raw,
            expected_input_sha256=sha256(input_raw).hexdigest(),
            catalog_manifest_bytes=catalog_raw,
            bars=[bars[0], bars[0], *bars[2:]],
        )


def test_injected_duplicate_callback_fails_without_a_second_order(tmp_path: Path) -> None:
    prepared = prepare_sma_case(tmp_path, [100, 100, 100, 110])
    result = execute_sma_case(
        prepared, after_run=lambda strategy, _: strategy.on_bar(prepared[1][-1])
    )
    assert result["status"] == "COMPONENT_CHECK_FAILED"
    assert "SMA_BAR_SEQUENCE_INVALID" in result["failure_codes"]
    assert len(result["native_orders"]) == 1


def test_native_denial_is_preserved_and_does_not_repeat_the_same_cross(tmp_path: Path) -> None:
    result = execute_sma_case(
        prepare_sma_case(tmp_path, [100, 100, 100, 110, 120, 130]), native_order_cap="100"
    )
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert len(result["native_orders"]) == 1
    assert result["native_orders"][0]["status"] == "DENIED"
    denied = [row for row in result["native_order_events"] if row["event_type"] == "OrderDenied"]
    assert len(denied) == 1 and denied[0]["reason"]
    assert result["native_fills"] == []
    assert result["checkpoints"][-1]["pending_orders"] == []


def test_native_split_fills_reconcile_without_creating_another_intent(tmp_path: Path) -> None:
    result = execute_sma_case(
        prepare_sma_case(
            tmp_path,
            [100, 100, 100, 110],
            cash="100000",
            quantity="250",
            max_notional="100000",
            max_position="500",
        )
    )
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert len(result["native_orders"]) == 1
    assert len(result["native_fill_facts"]) >= 2
    assert result["checkpoints"][-1]["positions"] == [{"quantity": "250", "side": "LONG"}]


def test_altered_close_with_same_timestamps_is_rejected_before_run(tmp_path: Path) -> None:
    from nautilus_trader.model import Bar, Price

    _, bars, catalog_raw, input_raw, _ = prepare_sma_case(tmp_path, [100, 100, 100, 110])
    original = bars[-1]
    changed = Bar(
        original.bar_type,
        Price.from_str("120.00"),
        Price.from_str("120.00"),
        Price.from_str("120.00"),
        Price.from_str("120.00"),
        original.volume,
        original.ts_event,
        original.ts_init,
    )
    with pytest.raises(ValueError, match="SMA_COMPONENT_BARS_INVALID"):
        HistoricalSmaStrategy(
            input_bytes=input_raw,
            expected_input_sha256=sha256(input_raw).hexdigest(),
            catalog_manifest_bytes=catalog_raw,
            bars=[*bars[:-1], changed],
        )


def test_finalization_is_rejected_during_native_run(tmp_path: Path) -> None:
    attempts = []

    class PrematureFinalizationProbe(HistoricalSmaStrategy):
        def on_bar(self, bar):
            try:
                self.finalize_component()
            except ValueError as error:
                attempts.append(str(error))
            super().on_bar(bar)

    result = execute_sma_case(
        prepare_sma_case(tmp_path, [100, 100, 100, 110]),
        strategy_class=PrematureFinalizationProbe,
    )
    assert attempts == ["SMA_FINALIZE_REQUIRES_STOPPED_STRATEGY"] * 4
    assert result["status"] == "COMPONENT_CHECK_PASSED"
    assert len(result["native_fill_facts"]) == 1
