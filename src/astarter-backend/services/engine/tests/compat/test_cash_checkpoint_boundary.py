from decimal import Decimal

import pytest

from tests.compat.rc3_bar_fixture import SECOND_CLOSE_NS
from tests.compat.rc3_cash_checkpoint_fixture import run_cash_checkpoint_case


def test_next_bar_observes_previous_fill_and_current_close_before_its_intent() -> None:
    result = run_cash_checkpoint_case(sell_on_second=True)
    first, second, final = result["checkpoints"]
    assert first["phase"] == second["phase"] == "PRE_INTENT"
    assert first["balances"]["ETH"]["total"] == "0"
    assert first["balances"]["USDT"]["total"] == "1000"
    assert second["balances"]["ETH"]["total"] == "1"
    assert second["balances"]["USDT"]["total"] == "894.895"
    assert second["open_positions"][0]["quantity"] == "1"
    assert second["active_orders"] == []
    assert second["explicit_price_unrealized_pnl"] == {"USDT": "105"}
    assert second["mark_values"] == {"USDT": "210"}
    assert final["phase"] == "FINAL_POST_RUN"
    assert final["balances"]["ETH"]["total"] == "0"
    assert final["balances"]["USDT"]["total"] == "1104.685"
    assert final["open_positions"] == []
    assert final["realized_pnls"] == final["total_pnls"] == {"USDT": "104.685"}
    assert final["unrealized_pnls"] == {}
    assert len(result["fills"]) == len(result["orders"]) == 2
    assert result["source_unchanged"] is True
    assert result["engine_disposed"] is True


def test_final_bar_preserves_native_open_position_and_currency_vector() -> None:
    result = run_cash_checkpoint_case()
    final = result["checkpoints"][-1]
    assert len(result["orders"]) == len(result["fills"]) == 1
    assert final["balances"]["ETH"]["total"] == "1"
    assert final["balances"]["USDT"]["total"] == "894.895"
    assert final["open_positions"][0]["side"] == "LONG"
    assert final["explicit_price_unrealized_pnl"] == {"USDT": "105"}
    assert final["realized_pnls"] == {"USDT": "-0.105"}
    assert final["total_pnls"] == {"USDT": "104.895"}
    assert set(final["snapshot"]["total_equity"]) == {"ETH", "USDT"}
    assert final["snapshot"]["base_currency_equity"] is None
    assert final["snapshot"]["is_stale"] is False
    assert final["snapshot"]["unpriced_instruments"] == []


def test_fee_shortfall_remains_observable_at_both_safe_checkpoints() -> None:
    result = run_cash_checkpoint_case(cash="105")
    assert result["orders"][0]["status"] == "FILLED"
    for checkpoint in result["checkpoints"][1:]:
        assert checkpoint["balances"]["ETH"]["total"] == "0"
        assert checkpoint["balances"]["USDT"]["total"] == "105"
        assert checkpoint["open_positions"][0]["quantity"] == "1"


def test_buy_on_only_final_bar_reconciles_without_a_later_pre_intent() -> None:
    result = run_cash_checkpoint_case(final_bar_only=True)
    before, final = result["checkpoints"]
    assert before["phase"] == "PRE_INTENT"
    assert final["phase"] == "FINAL_POST_RUN"
    assert before["clock_ns"] == final["clock_ns"] == SECOND_CLOSE_NS
    assert before["bar_ts_event"] == final["bar_ts_event"] == SECOND_CLOSE_NS
    assert before["balances"]["ETH"]["total"] == "0"
    assert before["balances"]["USDT"]["total"] == "1000"
    assert final["balances"]["ETH"]["total"] == "1"
    assert final["balances"]["USDT"]["total"] == "789.79"
    assert final["open_positions"] == [{"quantity": "1", "side": "LONG"}]
    assert len(result["fills"]) == len(result["orders"]) == 1
    assert final["active_orders"] == []
    delta = result["native_fill_deltas"][0]
    assert delta["cash_delta"] == {"ETH": "1", "USDT": "-210"}
    assert delta["commission"] == {"USDT": "0.21"}
    assert Decimal("1000") + Decimal(delta["cash_delta"]["USDT"]) - Decimal(
        delta["commission"]["USDT"]
    ) == Decimal(final["balances"]["USDT"]["total"])
    assert final["snapshot"]["base_currency_equity"] is None
    assert final["snapshot"]["is_stale"] is False
    assert final["snapshot"]["unpriced_instruments"] == []
    assert result["source_unchanged"] is result["engine_disposed"] is True


@pytest.mark.parametrize(
    ("quantity", "cash", "sell", "expected_fees"),
    [
        ("1.000", "1000", True, ["0.105", "0.210"]),
        ("250.000", "100000", False, ["2.625", "23.62725"]),
    ],
)
def test_native_cash_delta_projection_reconciles_real_fills_and_commissions(
    quantity: str, cash: str, sell: bool, expected_fees: list[str]
) -> None:
    result = run_cash_checkpoint_case(cash=cash, quantity=quantity, sell_on_second=sell)
    projections = result["native_fill_deltas"]
    assert [Decimal(row["commission"]["USDT"]) for row in projections] == [
        Decimal(value) for value in expected_fees
    ]
    balances = {"ETH": Decimal("0"), "USDT": Decimal(cash)}
    for row in projections:
        for currency, amount in row["cash_delta"].items():
            balances[currency] += Decimal(amount)
        for currency, amount in row["commission"].items():
            balances[currency] -= Decimal(amount)
    final = result["checkpoints"][-1]
    assert balances == {
        currency: Decimal(values["total"]) for currency, values in final["balances"].items()
    }
