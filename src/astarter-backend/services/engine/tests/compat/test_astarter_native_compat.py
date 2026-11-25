"""Pin actual rc3 capability; no mocked orders, fills or account balances."""

from tests.compat.astarter_native_fixture import run_case


def test_btc_ioc_to_accepted_protection_then_cancel_and_native_close():
    result = run_case("round_trip")
    assert not result["errors"]
    assert [(v["side"], v["quantity"], v["price"], v["fee"]) for v in result["fills"]] == [
        ("BUY", "0.00368", "60000", "0.2208"),
        ("SELL", "0.00368", "61000", "0.22448"),
    ]
    assert result["balances"] == {"BTC": "0", "USDT": "10003.23472"}
    assert result["open_orders"] == 0 and result["open_positions"] == 0
    assert result["accepted_stops"] == ["AST-STOP-1"]
    assert result["canceled_stops"] == ["AST-STOP-1"]


def test_btc_ioc_zero_fill_does_not_install_a_stop_or_reenter_on_next_quote():
    result = run_case("zero")
    assert not result["errors"] and not result["fills"]
    assert result["entry_submissions"] == 1
    assert not result["accepted_stops"]
    assert result["balances"] == {"BTC": "0", "USDT": "10000"}
    assert result["open_orders"] == result["open_positions"] == 0


def test_btc_partial_fill_is_protected_at_same_native_timestamp_and_stop_triggers():
    result = run_case("partial")
    assert not result["errors"]
    buy, sell = result["fills"]
    assert (buy["quantity"], buy["price"], sell["quantity"], sell["price"]) == (
        "0.001",
        "60000",
        "0.001",
        "58900",
    )
    assert result["stop_acceptance_times"] == [buy["time_ns"]]
    assert result["accepted_stops"] == ["AST-STOP-1"]
    assert result["balances"] == {"BTC": "0", "USDT": "9998.7811"}
    assert result["open_orders"] == result["open_positions"] == 0


def test_btc_full_stop_trigger_uses_a_later_bid_quote_not_a_past_bar_low():
    result = run_case("stop")
    assert not result["errors"]
    buy, sell = result["fills"]
    assert sell["order_id"] == "AST-STOP-1"
    assert sell["time_ns"] > buy["time_ns"]
    assert result["balances"] == {"BTC": "0", "USDT": "9995.514448"}
    assert result["open_orders"] == result["open_positions"] == 0
