"""Finite raw venue failures remain visible instead of being converted to success."""

import importlib
import json
from decimal import Decimal

import pytest


def run(tmp_path, scenario):
    module = importlib.import_module("stark_trading_os.runner.s03_simulation")
    result = module.run_s03_simulation(database_path=tmp_path / "native.sqlite", scenario=scenario)
    assert result.engine_disposed
    return json.loads(result.evidence_bytes)


def test_actual_native_stop_uses_bid_and_never_sells_more_than_inventory(tmp_path):
    r = run(tmp_path, "stop")
    assert r["status"] == "COMPLETE" and not r["errors"]
    buy, sell = r["native_snapshot"]["fills"]
    assert buy["side"] == "BUY" and sell["side"] == "SELL"
    assert buy["quantity"] == sell["quantity"]
    assert Decimal(sell["price"]) <= Decimal(r["reservation"]["stop"])
    assert r["native_snapshot"]["cash_reconciled"]
    assert r["native_snapshot"]["position_quantity"] == "0"
    assert r["settlement"]["new_lock"] == "0"


def test_partial_ioc_protects_only_actual_native_fill(tmp_path):
    r = run(tmp_path, "partial_entry")
    assert r["status"] == "OPEN_POSITION" and not r["errors"]
    buys = [f for f in r["native_snapshot"]["fills"] if f["side"] == "BUY"]
    actual = sum(Decimal(f["quantity"]) for f in buys)
    assert 0 < actual < Decimal(r["reservation"]["quantity"])
    stops = [o for o in r["native_snapshot"]["orders"] if o["order_type"] == "STOP_MARKET"]
    assert stops and sum(Decimal(o["quantity"]) for o in stops) == actual
    assert r["account"]["pending_risk"] == "0"


def test_zero_fill_does_not_spawn_protection_or_count_as_completed_trade(tmp_path):
    r = run(tmp_path, "zero_fill")
    assert r["status"] == "NO_FILL" and not r["errors"]
    assert r["entry_submissions"] == 1 and r["protected_acceptances"] == 0
    assert not r["native_snapshot"]["fills"]
    assert r["account"]["pending_risk"] == r["account"]["cash_hold"] == "0"


def test_rejected_news_preserves_health_evidence_and_existing_native_stop(tmp_path, monkeypatch):
    from stark_trading_os.domain.s03_bridge import S03RawNews, local_simulation_case

    module = importlib.import_module("stark_trading_os.runner.s03_simulation")
    plan, manifest = module.build_s03_case("stop")
    at = manifest.bars[-1].bar_close_ns + 5_000_000
    previous = manifest.news[-1].source_sequence
    bad = S03RawNews(
        source_sequence=previous + 1,
        previous_sequence=previous,
        source_event_time_ns=at - 121_000_000_000,
        received_time_ns=at,
        available_at_ns=at,
        status="HEALTHY",
    )
    manifest = manifest.model_copy(update={"news": (*manifest.news, bad)})
    plan = local_simulation_case().issue(
        parameters=plan.parameters,
        manifest=manifest,
        account_id=plan.account_id,
        group_id=plan.group_id,
        starts_at_ns=plan.starts_at_ns,
        expires_at_ns=plan.expires_at_ns,
    )
    monkeypatch.setattr(module, "build_s03_case", lambda scenario: (plan, manifest))
    r = run(tmp_path, "stop")
    assert not r["errors"] and r["status"] == "COMPLETE"
    assert [x["side"] for x in r["native_snapshot"]["fills"]] == ["BUY", "SELL"]
    assert r["native_snapshot"]["position_quantity"] == "0"
    assert any(x["kind"] == "S03_SOURCE_REJECTED" for x in r["s03_audit"])
    assert any(
        x["event"] == "NEWS_REJECTED" and x["reason"] == "S03_NEWS_UNTRUSTED" for x in r["trace"]
    )


def test_send_failure_keeps_original_failure_and_unknown_reservation(tmp_path, monkeypatch):
    module = importlib.import_module("stark_trading_os.runner.s03_simulation")

    def fail(strategy, command, **kwargs):
        raise RuntimeError("SYNTHETIC_SEND_INTERRUPTED")

    monkeypatch.setattr(module.S03NativeStrategy, "_submit", fail)
    r = run(tmp_path, "open_position")
    assert r["status"] == "FAILED"
    assert r["errors"] == ["RuntimeError:SYNTHETIC_SEND_INTERRUPTED"]
    assert r["settlement"] is None and r["native_snapshot"]["orders"] == []
    assert Decimal(r["account"]["pending_risk"]) > 0
    assert Decimal(r["account"]["cash_hold"]) > 0
    assert r["settlement_rejection"] == "ASTARTER_SETTLEMENT_HAS_UNRESOLVED_ORDERS"
    assert r["cleanup"] == dict(source_closed=True, store_closed=True, engine_disposed=True)


@pytest.mark.parametrize("failure", ["engine", "stream"])
def test_initialization_failure_closes_any_open_control(tmp_path, monkeypatch, failure):
    from stark_trading_os.control.registry import ControlStore

    module = importlib.import_module("stark_trading_os.runner.s03_simulation")
    opened, closed = [], []
    original_open, original_close = ControlStore.open.__func__, ControlStore.close

    def track_open(cls, path):
        store = original_open(cls, path)
        opened.append(store)
        return store

    def track_close(store):
        closed.append(store)
        return original_close(store)

    def fail(*args, **kwargs):
        raise RuntimeError("SYNTHETIC_INIT_FAILURE")

    monkeypatch.setattr(ControlStore, "open", classmethod(track_open))
    monkeypatch.setattr(ControlStore, "close", track_close)
    monkeypatch.setattr(
        module, "BacktestEngine" if failure == "engine" else "S03SignalStream", fail
    )
    try:
        with pytest.raises(RuntimeError, match="SYNTHETIC_INIT_FAILURE"):
            run(tmp_path, "stop")
        assert closed == opened
    finally:
        for store in opened:
            if store not in closed:
                original_close(store)


def test_existing_database_and_unknown_scenario_are_refused_before_write(tmp_path):
    module = importlib.import_module("stark_trading_os.runner.s03_simulation")
    existing = tmp_path / "owned.sqlite"
    existing.write_bytes(b"not a simulator database")
    with pytest.raises(ValueError, match="NEW_SIMULATION_DATABASE_REQUIRED"):
        module.run_s03_simulation(database_path=existing)
    assert existing.read_bytes() == b"not a simulator database"
    missing = tmp_path / "missing.sqlite"
    with pytest.raises(ValueError, match="SCENARIO_UNSUPPORTED"):
        module.run_s03_simulation(database_path=missing, scenario="external-source")
    assert not missing.exists()


@pytest.mark.parametrize("scenario", ["protection_timeout", "timer_no_quote"])
def test_first_fill_deadline_uses_native_timer_even_without_further_quote(tmp_path, scenario):
    r = run(tmp_path, scenario)
    buys = [x for x in r["native_snapshot"]["fills"] if x["side"] == "BUY"]
    assert buys and r["entry_submissions"] == 1
    deadline = min(x["time_ns"] for x in buys) + 1_000_000_000
    failures = [
        x for x in r["trace"] if x["event"] == "TIMER" and "PROTECTION_FAILED" in x["reasons"]
    ]
    assert failures and failures[0]["time_ns"] == deadline + 1
    assert "PROTECTION_FAILED" in r["life"]["reasons"]
    if scenario == "timer_no_quote":
        assert failures[0]["quote_time_ns"] < deadline
        assert not any(x["event"] == "QUOTE" and x["time_ns"] >= deadline for x in r["trace"])
        assert r["native_snapshot"]["position_quantity"] == "0"
        assert r["status"] == "FLAT_UNSETTLED" and r["settlement"] is None
        assert r["settlement_rejection"] == "ASTARTER_S03_QUOTE_CLOCK"
    assert not r["errors"]


def test_stop_fill_during_cancel_prevents_duplicate_market_sale(tmp_path):
    r = run(tmp_path, "cancel_race")
    assert not r["errors"]
    assert r["status"] == "COMPLETE"
    cancels = [x for x in r["trace"] if x["event"] == "CANCEL"]
    assert cancels
    sells = [x for x in r["native_snapshot"]["fills"] if x["side"] == "SELL"]
    assert len(sells) == 1 and sells[0]["time_ns"] > cancels[0]["time_ns"]
    assert Decimal(sells[0]["quantity"]) == Decimal(r["reservation"]["quantity"])
    assert r["native_snapshot"]["base_total"] == "0"


def test_three_native_partial_exit_attempts_have_spacing_and_one_residual_stop(tmp_path):
    r = run(tmp_path, "exit_retries")
    assert not r["errors"]
    submits = [x for x in r["trace"] if x["event"] == "SUBMIT" and x["role"] == "EXIT"]
    assert len(submits) == 3 and r["life"]["exit_claims"] == 3
    assert all(b["time_ns"] - a["time_ns"] >= 250_000_000 for a, b in zip(submits, submits[1:]))
    assert r["life"]["residual_used"] and "EXIT_BLOCKED" in r["life"]["reasons"]
    assert r["status"] == "OPEN_POSITION" and r["open_positions"] == 1
    residual = r["life"]["residual_order_id"]
    assert (
        residual
        and sum(x.get("order_id") == residual and x["event"] == "SUBMIT" for x in r["trace"]) == 1
    )
    stops = [x for x in r["native_snapshot"]["orders"] if x["order_id"] == residual]
    assert len(stops) == 1 and stops[0]["state"] == "ACCEPTED"
    assert stops[0]["quantity"] == r["native_snapshot"]["position_quantity"]


@pytest.mark.parametrize("hold", [24, 36])
@pytest.mark.parametrize("source_lag_ns", [0, 500_000_000, -500_000_000])
def test_no_quote_source_news_and_hold_timers_preserve_existing_native_stop(
    tmp_path, monkeypatch, hold, source_lag_ns
):
    from stark_trading_os.domain.s03_bridge import S03RawNews, local_simulation_case

    module = importlib.import_module("stark_trading_os.runner.s03_simulation")
    plan, manifest = module.build_s03_case("open_position")
    tail = manifest.quotes[-1].model_copy(
        update={"source_event_time_ns": manifest.quotes[-1].received_time_ns - source_lag_ns}
    )
    manifest = manifest.model_copy(update={"quotes": (*manifest.quotes[:-1], tail)})
    cross = manifest.bars[-1].bar_close_ns
    last = manifest.news[-1]
    end = cross + hold * 300_000_000_000 + 1
    # Another approved NEWS record advances the real engine, without a new quote or bar.
    future = S03RawNews(
        source_sequence=last.source_sequence + 1,
        previous_sequence=last.source_sequence,
        source_event_time_ns=end,
        received_time_ns=end,
        available_at_ns=end,
        status="HEALTHY",
    )
    manifest = manifest.model_copy(update={"news": (*manifest.news, future)})
    parameters = plan.parameters.model_copy(update={"hold_boundaries": hold})
    plan = local_simulation_case().issue(
        parameters=parameters,
        manifest=manifest,
        account_id=plan.account_id,
        group_id=plan.group_id,
        starts_at_ns=plan.starts_at_ns,
        expires_at_ns=plan.starts_at_ns + 86_400_000_000_000,
    )
    monkeypatch.setattr(module, "build_s03_case", lambda scenario: (plan, manifest))
    r = run(tmp_path, "open_position")
    assert not r["errors"] and r["status"] == "OPEN_POSITION"
    timers = [x for x in r["trace"] if x["event"] == "TIMER"]
    assert any(
        x["time_ns"] == min(tail.source_event_time_ns, tail.received_time_ns) + 2_000_000_001
        and "QUOTE_UNHEALTHY" in x["reasons"]
        for x in timers
    )
    assert any(
        x["time_ns"] == last.source_event_time_ns + 120_000_000_001
        and "NEWS_UNHEALTHY" in x["reasons"]
        for x in timers
    )
    assert any(
        x["time_ns"] == cross + hold * 300_000_000_000 and "HOLD_LIMIT" in x["reasons"]
        for x in timers
    )
    assert r["life"]["hold_seen"] == hold
    assert not any(x["event"] == "CANCEL" for x in r["trace"])
    stops = [x for x in r["native_snapshot"]["orders"] if x["order_type"] == "STOP_MARKET"]
    assert len(stops) == 1 and stops[0]["state"] == "ACCEPTED"
