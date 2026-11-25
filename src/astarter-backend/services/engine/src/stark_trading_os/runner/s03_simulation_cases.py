"""Finite, explicitly synthetic raw inputs for the S03 native driver."""

from bisect import bisect_right
from decimal import ROUND_DOWN, Decimal
from hashlib import sha256

from stark_trading_os.domain.s03_bridge import (
    S03BridgePlan,
    S03BridgeRejected,
    S03DataManifest,
    S03RawBar,
    S03RawNews,
    S03RawQuote,
    local_simulation_case,
    replay_s03_observations,
)
from stark_trading_os.domain.s03_signal import S03Parameters

SCENARIOS: frozenset[str] = frozenset(
    {
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
    }
)
_SECOND = 1_000_000_000
_BAR = 300 * _SECOND
_SEED = 1_500_000_000_000_000_000
_TICK = Decimal("0.01")
_PARAMETERS = S03Parameters(
    ema_fast=10,
    ema_slow=30,
    rsi_cross="40",
    rsi_ceiling="75",
    rsi_fail="30",
    volatility_max="0.05",
    stop_atr="1.5",
    risk_fraction="0.0005",
    notional_fraction="0.05",
)


def _text(value: Decimal) -> str:
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def _prices(with_exit: bool) -> tuple[Decimal, ...]:
    level, prices = Decimal("1000"), []
    for count, delta in ((260, "1"), (22, "-0.4"), (1, "2")):
        for _ in range(count):
            level += Decimal(delta)
            prices.append(level)
    if with_exit:
        # Two genuine low-RSI bars precede any fixed-stop crossing.
        prices.extend(Decimal(x) for x in ("1242", "1241", "1240", "1240"))
    return tuple(prices)


def _issue(manifest: S03DataManifest, starts: int, expires: int) -> S03BridgePlan:
    return local_simulation_case().issue(
        parameters=_PARAMETERS,
        manifest=manifest,
        account_id="SIM-001",
        group_id="private-sim",
        starts_at_ns=starts,
        expires_at_ns=expires,
    )


def build_s03_case(scenario: str) -> tuple[S03BridgePlan, S03DataManifest]:
    if type(scenario) is not str or scenario not in SCENARIOS:
        raise S03BridgeRejected("S03_SCENARIO_UNKNOWN")
    with_exit = scenario in {"round_trip", "cancel_race", "exit_retries"}
    prices = _prices(with_exit)
    bars = tuple(
        S03RawBar(
            open=_text(price),
            high=_text(price + 5),
            low=_text(price - 5),
            close=_text(price),
            volume="1",
            bar_close_ns=_SEED + index * _BAR,
            ts_init_ns=_SEED + index * _BAR,
            available_at_ns=_SEED + index * _BAR + 1,
        )
        for index, price in enumerate(prices)
    )
    manifest = S03DataManifest(
        case_id="S03_SYNTHETIC_BTC_V1",
        source_revision=sha256(f"S03_TASK4_SYNTHETIC_V1:{scenario}".encode("ascii")).hexdigest(),
        seed_close_ns=_SEED,
        bars=bars,
    )
    preview = _issue(manifest, bars[250].available_at_ns, bars[-1].available_at_ns + _BAR)
    observed = replay_s03_observations(preview, manifest)
    signal = next(x.signal for x in observed if x.signal)
    assert signal is not None
    entry = signal.bar_close_ns
    starts = entry - 6 * _SECOND
    end = (
        bars[-1].bar_close_ns + 20_000_000
        if with_exit or scenario == "stop"
        else entry + 4 * _SECOND
    )
    if scenario == "timer_no_quote":
        end = entry + 3_000_000
    times = set(range(starts, end + 1, 2 * _SECOND))
    times.add(end)
    for bar in bars:
        if bar.bar_close_ns >= entry:
            times.update(
                bar.bar_close_ns + offset for offset in (0, 1_000_000, 2_000_000, 3_000_000)
            )
    if scenario in {"stop", "late_quote"}:
        times.update(entry + offset for offset in (10_000_000, 11_000_000, 12_000_000))
    exit_at: int | None = None
    race_at: int | None = None
    if scenario in {"cancel_race", "exit_retries"}:
        exit_bar = next(
            current
            for previous, current in zip(observed, observed[1:])
            if current.bar_close_ns > entry
            and current.ready
            and not current.gap_reset
            and (
                current.facts.trend_invalid
                or (
                    previous.ready
                    and not previous.gap_reset
                    and previous.facts.momentum_below_fail
                    and current.facts.momentum_below_fail
                )
            )
        )
        exit_at = exit_bar.bar_close_ns
        if scenario == "cancel_race":
            race_at = exit_bar.available_at_ns + 500_000
            times.update((race_at, exit_bar.available_at_ns + 750_000))
        else:
            times.update(
                exit_at + n * 1_000_000
                for n in (1, 2, 3, 4, 5, 250, 251, 252, 253, 500, 501, 502, 503, 504, 505)
            )
    closes = [bar.bar_close_ns for bar in bars]
    stop = (
        Decimal(signal.close) - Decimal(_PARAMETERS.stop_atr) * Decimal(str(signal.snapshot.atr))
    ).quantize(_TICK, rounding=ROUND_DOWN)
    cap = (Decimal(signal.close) * Decimal("1.002")).quantize(_TICK, rounding=ROUND_DOWN)
    quotes = []
    for sequence, at in enumerate(sorted(times), 1):
        bid = prices[max(0, bisect_right(closes, at) - 1)]
        ask, ask_size, source_at = bid + _TICK, "10", at
        if scenario == "partial_entry" and at == entry + 1_000_000:
            ask_size = "0.001"
        if scenario == "zero_fill" and at >= entry + 1_000_000:
            bid, ask = cap + _TICK, cap + 2 * _TICK
        if scenario in {"stop", "late_quote"} and at == entry + 10_000_000:
            bid, ask = stop - _TICK, stop + _TICK
            if scenario == "late_quote":
                source_at -= 3 * _SECOND
        if scenario == "cancel_race" and at == race_at:
            bid, ask = stop - _TICK, stop + _TICK
        bid_size = (
            "0.00001"
            if scenario == "exit_retries" and exit_at is not None and at >= exit_at
            else "10"
        )
        quotes.append(
            S03RawQuote(
                source_sequence=sequence,
                source_event_time_ns=source_at,
                received_time_ns=at,
                bid=_text(bid),
                ask=_text(ask),
                bid_size=bid_size,
                ask_size=ask_size,
            )
        )
    news = tuple(
        S03RawNews(
            source_sequence=index,
            previous_sequence=index - 1,
            source_event_time_ns=at,
            received_time_ns=at,
            available_at_ns=at,
            status="HEALTHY",
        )
        for index, at in enumerate((starts, *range(entry - _SECOND, end + 1, 60 * _SECOND)), 1)
    )
    manifest = manifest.model_copy(update={"quotes": tuple(quotes), "news": news})
    return _issue(manifest, starts - 1, end + 5 * _SECOND), manifest
