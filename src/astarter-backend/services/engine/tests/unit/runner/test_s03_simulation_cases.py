"""Formal raw scenarios drive native indicators; no fixture supplies trading facts."""

import importlib
import importlib.util
from decimal import ROUND_DOWN, Decimal

import pytest

from stark_trading_os.domain.s03_bridge import (
    S03BridgeRejected,
    local_simulation_case,
    replay_s03_observations,
    validate_s03_plan,
)
from stark_trading_os.runner.s03_bridge_source import S03SimulationInputSource
from tests.unit.runner.test_s03_bridge_source import NATIVE_TS, _event, _session

SCENARIOS = (
    "round_trip",
    "open_position",
    "stop",
    "partial_entry",
    "zero_fill",
    "late_quote",
    "protection_timeout",
    "timer_no_quote",
    "cancel_race",
    "exit_retries",
)
SECOND = 1_000_000_000
BAR = 300 * SECOND


def _builder():
    name = "stark_trading_os.runner.s03_simulation_cases"
    assert importlib.util.find_spec(name) is not None, "formal S03 scenario builder is missing"
    return importlib.import_module(name).build_s03_case


def _first(plan, manifest):
    rows = replay_s03_observations(plan, manifest)
    return rows, next(row for row in rows if row.signal is not None)


def _stop(plan, signal):
    value = Decimal(signal.close) - Decimal(plan.parameters.stop_atr) * Decimal(
        str(signal.snapshot.atr)
    )
    return value.quantize(Decimal("0.01"), rounding=ROUND_DOWN)


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_formal_case_has_real_native_cross_and_late_live_approval(scenario):
    plan, manifest = _builder()(scenario)
    validate_s03_plan(plan, manifest, local_simulation_case())
    rows, first = _first(plan, manifest)
    assert rows.index(first) >= 250 and first.ready and not first.gap_reset
    assert first.snapshot.previous_rsi < float(plan.parameters.rsi_cross) <= first.snapshot.rsi
    assert first.facts.rsi_cross_up and first.facts.trend_up and first.facts.volatility_allowed
    assert first.signal.close == "1253.2"
    warm_end = manifest.bars[rows.index(first) - 1].available_at_ns
    assert warm_end < plan.starts_at_ns < manifest.quotes[0].received_time_ns
    assert manifest.quotes[0].received_time_ns < first.bar_close_ns
    assert 0 < plan.expires_at_ns - plan.starts_at_ns < 4 * 3600 * SECOND
    assert Decimal(plan.parameters.risk_fraction) < Decimal("0.0025")
    assert Decimal(plan.parameters.notional_fraction) < Decimal("0.1")
    assert not plan.real_trading_connected and not plan.execution_authorized
    assert plan.review.label == "SIMULATED_REVIEW"


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_live_schedule_is_grid_exact_bounded_and_has_complete_news(scenario):
    plan, manifest = _builder()(scenario)
    assert 0 < len(manifest.quotes) < 6000
    assert all(b.available_at_ns == b.bar_close_ns + 1 for b in manifest.bars)
    assert all(b.bar_close_ns % BAR == 0 for b in manifest.bars)
    assert manifest.news and manifest.news[0].source_sequence == 1
    for index, news in enumerate(manifest.news, 1):
        assert news.source_sequence == index and news.previous_sequence == index - 1
        assert news.status == "HEALTHY" and news.incident_id is None
        assert news.source_event_time_ns == news.received_time_ns == news.available_at_ns
    assert all(
        0 < b.available_at_ns - a.available_at_ns <= 120 * SECOND
        for a, b in zip(manifest.news, manifest.news[1:])
    )
    for quote in manifest.quotes:
        assert plan.starts_at_ns <= quote.received_time_ns < plan.expires_at_ns
        assert 0 < Decimal(quote.bid) < Decimal(quote.ask)
        for value in (quote.bid, quote.ask):
            assert Decimal(value) % Decimal("0.01") == 0
        for value in (quote.bid_size, quote.ask_size):
            assert Decimal(value) > 0 and Decimal(value) % Decimal("0.00001") == 0
        assert (
            quote.received_time_ns
            - max(
                n.available_at_ns
                for n in manifest.news
                if n.available_at_ns <= quote.received_time_ns
            )
            <= 120 * SECOND
        )
    assert all(
        a.source_sequence < b.source_sequence
        and a.received_time_ns < b.received_time_ns
        and b.received_time_ns - a.received_time_ns <= 2 * SECOND
        for a, b in zip(manifest.quotes, manifest.quotes[1:])
    )


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_startup_supplies_two_spaced_news_before_the_first_live_cross(scenario):
    plan, manifest = _builder()(scenario)
    _, first = _first(plan, manifest)
    prior = [n for n in manifest.news if n.available_at_ns < first.available_at_ns]
    assert len(prior) >= 2
    assert prior[1].source_event_time_ns - prior[0].source_event_time_ns >= 5 * SECOND
    assert prior[1].received_time_ns - prior[0].received_time_ns >= 5 * SECOND
    assert manifest.quotes[0].received_time_ns <= prior[0].available_at_ns


def test_round_trip_contains_indicator_exit_before_hold_without_crossing_fixed_stop():
    plan, manifest = _builder()("round_trip")
    rows, first = _first(plan, manifest)
    later = [r for r in rows if r.bar_close_ns > first.bar_close_ns]
    exit_bar = next(r for r in later if r.facts.trend_invalid)
    assert exit_bar.bar_close_ns - first.bar_close_ns < plan.parameters.hold_boundaries * BAR
    assert all(
        Decimal(q.bid) > _stop(plan, first.signal)
        for q in manifest.quotes
        if q.received_time_ns <= exit_bar.available_at_ns
    )


@pytest.mark.parametrize(
    "scenario",
    [
        "open_position",
        "partial_entry",
        "protection_timeout",
        "timer_no_quote",
    ],
)
def test_open_samples_end_with_valid_quotes_and_no_exit_bars(scenario):
    plan, manifest = _builder()(scenario)
    rows, first = _first(plan, manifest)
    assert rows[-1] == first
    assert all(Decimal(q.bid) > _stop(plan, first.signal) for q in manifest.quotes)
    assert first.bar_close_ns + 3_000_000 <= manifest.quotes[-1].received_time_ns


def test_partial_and_zero_fill_execution_books_differ_after_the_entry_claim():
    build = _builder()
    plan, manifest = build("partial_entry")
    _, first = _first(plan, manifest)
    execution = next(
        q for q in manifest.quotes if q.received_time_ns == first.bar_close_ns + 1_000_000
    )
    assert Decimal(execution.ask_size) == Decimal("0.001")
    assert Decimal(execution.ask) <= Decimal(first.signal.close) * Decimal("1.002")
    plan, manifest = build("zero_fill")
    _, first = _first(plan, manifest)
    execution = next(
        q for q in manifest.quotes if q.received_time_ns == first.bar_close_ns + 1_000_000
    )
    assert Decimal(execution.bid) > Decimal(first.signal.close) * Decimal("1.002")


def test_stop_has_a_valid_low_bid_after_native_protection_can_be_accepted():
    plan, manifest = _builder()("stop")
    _, first = _first(plan, manifest)
    stop = _stop(plan, first.signal)
    trigger = next(q for q in manifest.quotes if Decimal(q.bid) < stop)
    assert trigger.source_event_time_ns == trigger.received_time_ns
    assert trigger.received_time_ns >= first.bar_close_ns + 3_000_000
    assert Decimal(trigger.ask) > stop


def test_late_low_bid_is_preserved_but_formal_gate_rejects_it_before_matching():
    plan, manifest = _builder()("late_quote")
    _, first = _first(plan, manifest)
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, strategy, native):
        before = strategy.cache.quote(strategy.item.id)
        gate = S03SimulationInputSource.open(
            case_id=manifest.case_id,
            case=local_simulation_case(),
            plan=plan,
            manifest=manifest,
            native=native,
        )
        records = [gate.admit(_event(q, q.received_time_ns)) for q in manifest.quotes]
        assert len(gate.rejected) == 1 and gate.rejected[0].reason == "QUOTE_SOURCE_AGE"
        late = next(
            q for q in manifest.quotes if q.received_time_ns - q.source_event_time_ns > 2 * SECOND
        )
        assert Decimal(late.bid) < _stop(plan, first.signal)
        assert records[-1].disposition == "ACCEPTED"
        assert manifest.quotes[-1].source_event_time_ns > late.received_time_ns
        assert strategy.cache.quote(strategy.item.id) == before


def test_protection_timeout_keeps_healthy_quotes_past_the_original_fill_deadline():
    plan, manifest = _builder()("protection_timeout")
    _, first = _first(plan, manifest)
    assert manifest.quotes[-1].received_time_ns > first.bar_close_ns + SECOND + 1_000_001
    assert all(q.source_event_time_ns == q.received_time_ns for q in manifest.quotes)


def test_no_quote_case_has_only_initial_execution_ticks_before_the_end_marker():
    plan, manifest = _builder()("timer_no_quote")
    _, first = _first(plan, manifest)
    assert manifest.quotes[-1].received_time_ns == first.bar_close_ns + 3_000_000
    assert plan.expires_at_ns - 1 > first.bar_close_ns + SECOND + 1_000_001
    assert manifest.bars[-1].available_at_ns == first.available_at_ns


def _first_exit_bar(plan, manifest):
    rows, first = _first(plan, manifest)
    later = [r for r in rows if r.bar_close_ns > first.bar_close_ns]
    assert later[0].bar_close_ns == first.bar_close_ns + BAR
    assert later[0].facts.trend_invalid
    return first, later[0]


def test_cancel_race_low_bid_arrives_inside_native_cancel_latency():
    plan, manifest = _builder()("cancel_race")
    first, exit_bar = _first_exit_bar(plan, manifest)
    trigger = next(q for q in manifest.quotes if Decimal(q.bid) < _stop(plan, first.signal))
    assert (
        exit_bar.available_at_ns < trigger.received_time_ns < exit_bar.available_at_ns + 1_000_000
    )
    assert trigger.source_event_time_ns == trigger.received_time_ns
    restored = next(q for q in manifest.quotes if q.received_time_ns > trigger.received_time_ns)
    assert Decimal(restored.bid) > _stop(plan, first.signal)


def test_exit_retries_freeze_small_books_and_each_native_latency_window():
    plan, manifest = _builder()("exit_retries")
    first, exit_bar = _first_exit_bar(plan, manifest)
    offsets = {q.received_time_ns - exit_bar.bar_close_ns for q in manifest.quotes}
    required = {n * 1_000_000 for n in (1, 2, 3, 4, 5, 250, 251, 252, 253, 500, 501, 502, 503)}
    assert required <= offsets
    assert all(
        Decimal(q.bid_size) == Decimal("0.00001")
        for q in manifest.quotes
        if q.received_time_ns >= exit_bar.bar_close_ns
    )
    assert all(Decimal(q.bid) > _stop(plan, first.signal) for q in manifest.quotes)


@pytest.mark.parametrize("bad", ["", "not_registered", None, [], True])
def test_unknown_or_non_string_scenario_is_rejected_without_a_default(bad):
    with pytest.raises(S03BridgeRejected, match="S03_SCENARIO_UNKNOWN"):
        _builder()(bad)
