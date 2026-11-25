"""Task4 drives the actual native engine from approved synthetic raw input."""

import importlib
import importlib.util
import json
import socket
from decimal import Decimal


def run(tmp_path, scenario="round_trip"):
    name = "stark_trading_os.runner.s03_simulation"
    assert importlib.util.find_spec(name) is not None, "S03 native driver is not wired"
    result = importlib.import_module(name).run_s03_simulation(
        database_path=tmp_path / "control.sqlite", scenario=scenario
    )
    assert result.engine_disposed
    return json.loads(result.evidence_bytes)


def test_real_cross_runs_native_entry_protection_exit_and_cash_reconciliation(
    tmp_path, monkeypatch
):
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    attempts = []

    def forbidden(*args, **kwargs):
        attempts.append("external-call")
        raise AssertionError("finite native path must not contact a model or network")

    monkeypatch.setattr(OpenRouterModelPort, "generate_structured", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    r = run(tmp_path)
    assert attempts == []
    assert r["scope"] == "S03_FINITE_NATIVE_SIMULATION"
    assert r["real_trading_enabled"] is False and r["fast_path_model_calls"] == 0
    assert r["status"] == "COMPLETE" and not r["errors"]
    assert r["indicator_bars"] > 250 and r["signal_count"] >= 1
    assert r["entry_submissions"] == 1 and r["protected_acceptances"] >= 1
    fills = r["native_snapshot"]["fills"]
    assert fills[0]["side"] == "BUY" and fills[-1]["side"] == "SELL"
    assert sum(Decimal(x["quantity"]) * (1 if x["side"] == "BUY" else -1) for x in fills) == 0
    assert r["native_snapshot"]["cash_reconciled"] is True
    assert r["native_snapshot"]["base_total"] == "0"
    cash = Decimal("10000")
    for fill in fills:
        quantity, price, fee = map(Decimal, (fill["quantity"], fill["price"], fill["fee"]))
        assert quantity >= Decimal("0.00001") and quantity % Decimal("0.00001") == 0
        assert fill["currency"] == "USDT" and fee >= 0
        cash += quantity * price * (1 if fill["side"] == "SELL" else -1) - fee
    assert cash == Decimal(r["native_snapshot"]["quote_total"])
    assert Decimal(r["reservation"]["risk_reserved"]) <= Decimal("5")
    assert Decimal(r["reservation"]["quantity"]) * Decimal(r["reservation"]["cap"]) <= 500
    assert r["duplicate_settlement"]["new_lock"] == "0"
    assert r["live_orders"] == r["open_positions"] == 0
    assert r["native_orders_csv"] and r["native_fills_csv"] and r["native_account_csv"]
    assert r["cleanup"]["source_closed"] and r["cleanup"]["store_closed"]


def test_end_of_fixture_preserves_real_open_position(tmp_path):
    r = run(tmp_path, "open_position")
    assert r["status"] == "OPEN_POSITION" and not r["errors"]
    assert Decimal(r["native_snapshot"]["position_quantity"]) > 0
    assert r["open_positions"] == 1 and r["settlement"] is None
    assert all(x["side"] == "BUY" for x in r["native_snapshot"]["fills"])


def test_rejected_low_bid_never_reaches_native_stop_matcher(tmp_path):
    r = run(tmp_path, "late_quote")
    rejected = [x for x in r["feed_records"] if x["disposition"] == "REJECTED"]
    assert rejected and any(x["reason"] == "QUOTE_SOURCE_AGE" for x in rejected)
    assert r["status"] == "OPEN_POSITION" and not r["errors"]
    assert r["entry_submissions"] == 1
    assert Decimal(r["native_snapshot"]["position_quantity"]) > 0
    assert all(x["side"] == "BUY" for x in r["native_snapshot"]["fills"])
    assert any(x["kind"] == "S03_SOURCE_REJECTED" for x in r["s03_audit"])
    assert r["native_quote_count"] == sum(x["disposition"] == "ACCEPTED" for x in r["feed_records"])
