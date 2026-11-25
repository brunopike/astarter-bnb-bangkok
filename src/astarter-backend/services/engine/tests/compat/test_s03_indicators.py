"""Actual pinned native indicators and causal S03 stream, with synthetic BTC only."""

import hashlib
import importlib
import importlib.util
from dataclasses import FrozenInstanceError
from fractions import Fraction as F

import pytest
from nautilus_trader.indicators import (
    AverageTrueRange,
    ExponentialMovingAverage,
    MovingAverageType,
    RelativeStrengthIndex,
)
from nautilus_trader.model import Bar, BarType, Price, Quantity

from stark_trading_os.domain.s03_signal import S03Parameters

STEP = 300_000_000_000
SEED = STEP * 6
REVISION = hashlib.sha256(b"S03 synthetic source v1").hexdigest()
OTHER_REVISION = hashlib.sha256(b"S03 synthetic source v2").hexdigest()
TYPE = BarType.from_str("BTCUSDT.SIM-5-MINUTE-LAST-EXTERNAL")


def api():
    name = "stark_trading_os.runner.s03_indicators"
    assert importlib.util.find_spec(name) is not None, "S03 native stream is not implemented"
    return importlib.import_module(name)


def bar(index, price=60000, *, width=100, **updates):
    ts = SEED + (index - 1) * STEP
    values = dict(
        bar_type=TYPE,
        open=Price.from_str(str(price)),
        high=Price.from_str(str(price + width)),
        low=Price.from_str(str(price - width)),
        close=Price.from_str(str(price)),
        volume=Quantity.from_str("1"),
        ts_event=ts,
        ts_init=ts,
    )
    return Bar(**(values | updates))


def stream(module, parameters=None, **updates):
    return module.S03SignalStream(
        parameters or S03Parameters(),
        **(
            dict(instrument_id="BTCUSDT.SIM", source_revision=REVISION, seed_close_ns=SEED)
            | updates
        ),
    )


def feed(target, value, *, revision=REVISION, available=None):
    return target.update(
        value,
        source_revision=revision,
        available_at_ns=value.ts_init if available is None else available,
    )


def native_values(parameters):
    return (
        ExponentialMovingAverage(parameters.ema_fast),
        ExponentialMovingAverage(parameters.ema_slow),
        RelativeStrengthIndex(parameters.rsi_period, MovingAverageType.Wilder),
        AverageTrueRange(parameters.atr_period, MovingAverageType.Wilder, True),
    )


def test_locked_native_golden_sequences():
    api()
    ema = ExponentialMovingAverage(3)
    rsi = RelativeStrengthIndex(3, MovingAverageType.Wilder)
    observed = []
    observed_rsi = []
    for value in [1, 2, 3, 4, 3, 2, 2, 2]:
        ema.update_raw(value)
        rsi.update_raw(value)
        observed.append(ema.value)
        observed_rsi.append(rsi.value)
    assert observed == [1, 1.5, 2.25, 3.125, 3.0625, 2.53125, 2.265625, 2.1328125]
    assert observed_rsi[4:6] == [0.5846153846153846, 0.3601895734597157]
    atr = AverageTrueRange(3, MovingAverageType.Wilder, True)
    observed = []
    ready = []
    for h, low, close in [(3, 1, 2), (4, 2, 3), (8, 4, 7), (7, 6, 6.5)]:
        atr.update_raw(h, low, close)
        observed.append(atr.value)
        ready.append(atr.initialized)
    assert observed == [2, 2, 3, 2.3333333333333335]
    assert ready == [False, False, True, True]


@pytest.mark.parametrize(
    "parameters",
    [
        S03Parameters(),
        S03Parameters(
            ema_fast=10,
            ema_slow=80,
            rsi_period=7,
            atr_period=21,
            rsi_cross="55",
            rsi_ceiling="70",
            rsi_fail="40",
            volatility_min="0.002",
            volatility_max="0.03",
            stop_atr="3",
            risk_fraction="0.004",
            notional_fraction="0.1",
            hold_boundaries=12,
            cooldown_full_bars=4,
        ),
    ],
)
def test_stream_matches_explicit_native_configuration(parameters):
    m = api()
    target = stream(m, parameters)
    fast, slow, rsi, atr = native_values(parameters)
    previous = None
    for i in range(1, parameters.warmup_bars + 3):
        value = bar(i, 60000 + (i % 13) * 11)
        close = float(value.close)
        fast.update_raw(close)
        slow.update_raw(close)
        rsi.update_raw(close)
        atr.update_raw(float(value.high), float(value.low), close)
        observed = feed(target, value)
        assert observed.snapshot.ema_fast == fast.value
        assert observed.snapshot.ema_slow == slow.value
        assert observed.snapshot.rsi == rsi.value * 100
        assert observed.snapshot.previous_rsi == previous
        assert observed.snapshot.atr == atr.value
        assert observed.ready is (i >= parameters.warmup_bars)
        previous = rsi.value * 100


@pytest.mark.parametrize("period,warmup", [(50, 250), (250, 1250)])
def test_warmup_and_flat_native_rsi(period, warmup):
    m = api()
    target = stream(m, S03Parameters(ema_slow=period))
    for i in range(1, warmup + 1):
        result = feed(target, bar(i, width=0))
        assert result.ready is (i == warmup)
        assert result.snapshot.rsi == 100
        assert result.snapshot.atr == 0
        assert result.signal is None
    descending = stream(m)
    for i in range(1, 251):
        result = feed(descending, bar(i, 61000 - i))
    assert result.snapshot.rsi == 0
    assert not result.facts.market_match


@pytest.mark.parametrize(
    "updates",
    [
        {"instrument_id": "ETHUSDT.SIM"},
        {"instrument_id": "BTCUSDT"},
        {"source_revision": "not-a-digest"},
        {"source_revision": True},
        {"seed_close_ns": True},
        {"seed_close_ns": STEP - 1},
        {"seed_close_ns": SEED + 1},
        {"seed_close_ns": 2**64},
    ],
)
def test_constructor_rejects_unbound_or_invalid_identity(updates):
    m = api()
    with pytest.raises(m.S03InputError, match="^S03_INPUT_INVALID$"):
        stream(m, **updates)


def test_constructor_revalidates_parameters():
    m = api()
    with pytest.raises(m.S03InputError):
        stream(m, S03Parameters().model_copy(update={"ema_fast": True}))


@pytest.mark.parametrize(
    "which",
    [
        "duplicate",
        "old",
        "changed_duplicate",
        "revision",
        "available_backwards",
        "future_init",
        "future_close",
        "bad_type",
        "bad_bar_type",
        "misaligned",
        "zero_price",
        "non_bar",
        "bool_available",
        "overflow_available",
        "expiry_overflow",
    ],
)
def test_rejection_does_not_mutate_accepted_state(which):
    m = api()
    target, control = stream(m), stream(m)
    for i in [1, 2]:
        feed(target, bar(i), available=SEED + 3 * STEP)
        feed(control, bar(i), available=SEED + 3 * STEP)
    value, revision, available = bar(3), REVISION, SEED + 3 * STEP
    if which == "duplicate":
        value = bar(2)
    elif which == "old":
        value = bar(1)
    elif which == "changed_duplicate":
        value = bar(2, 70000)
    elif which == "revision":
        revision = OTHER_REVISION
    elif which == "available_backwards":
        available -= 1
    elif which == "future_init":
        value = bar(3, ts_init=available + 1)
    elif which == "future_close":
        available = value.ts_event - 1
    elif which == "bad_type":
        revision = 1
    elif which == "bad_bar_type":
        value = bar(3, bar_type=BarType.from_str("BTCUSDT.SIM-1-MINUTE-LAST-EXTERNAL"))
    elif which == "misaligned":
        value = bar(3, ts_event=value.ts_event + 1)
    elif which == "zero_price":
        value = bar(3, 0, width=0)
    elif which == "non_bar":
        value = object()
    elif which == "bool_available":
        available = True
    elif which == "overflow_available":
        available = 2**64
    else:
        # The final uint64-aligned five-minute close may have room for +5s;
        # non-grid near-max timestamps must also fail without wrapping.
        value = bar(3, ts_event=2**64 - 1, ts_init=2**64 - 1)
        available = 2**64 - 1
    with pytest.raises(m.S03InputError, match="^S03_INPUT_INVALID$"):
        feed(target, value, revision=revision, available=available)
    assert feed(target, bar(3), available=SEED + 3 * STEP) == feed(
        control, bar(3), available=SEED + 3 * STEP
    )


def test_native_bar_rejects_invalid_ohlc_before_stream():
    m = api()
    target, control = stream(m), stream(m)
    feed(target, bar(1))
    feed(control, bar(1))
    with pytest.raises(ValueError, match="high >= open"):
        bar(2, high=Price.from_str("59999"))
    assert feed(target, bar(2)) == feed(control, bar(2))


def test_last_uint64_grid_boundary_does_not_wrap_expiry():
    m = api()
    last_close = (2**64 - 1) // STEP * STEP
    target = stream(m, seed_close_ns=last_close)
    result = feed(target, bar(1, ts_event=last_close, ts_init=last_close))
    assert result.expires_at_ns == last_close + 5_000_000_000
    assert result.expires_at_ns <= 2**64 - 1


def test_seed_recovery_and_prefix_are_exact():
    m = api()
    original, replay = stream(m), stream(m)
    with pytest.raises(m.S03InputError):
        feed(replay, bar(251))
    for i in range(1, 501):
        value = bar(i, 60000 + (500 - i if i < 251 else i))
        left = feed(original, value)
        right = feed(replay, value)
        assert left == right
        assert left.seed_close_ns == SEED
        assert left.segment_seed_close_ns == SEED
    tail = stream(m, seed_close_ns=bar(251).ts_event)
    for i in range(251, 501):
        tail_result = feed(tail, bar(i, 60000 + i))
    assert tail_result.snapshot.ema_slow != left.snapshot.ema_slow
    assert tail_result.prefix_sha256 != left.prefix_sha256
    assert tail_result.seed_close_ns != left.seed_close_ns


def test_gap_resets_seed_segment_and_previous_rsi():
    m = api()
    target = stream(m)
    for i in range(1, 251):
        last = feed(target, bar(i, 60000 + i))
    assert last.ready
    gap = feed(target, bar(252))
    assert gap.gap_reset and not gap.ready
    assert gap.continuous_bars == 1
    assert gap.snapshot.previous_rsi is None
    assert gap.seed_close_ns == SEED
    assert gap.segment_seed_close_ns == bar(252).ts_event
    for i in range(253, 502):
        last = feed(target, bar(i))
        assert last.ready is (i == 501)


PRICES = [60000 + i * 10 for i in range(260)] + [
    62560,
    62530,
    62500,
    62470,
    62460,
    62510,
    62520,
    62540,
    62560,
    62580,
    62600,
]


def expected_signal_indices():
    fast, slow, rsi, atr = native_values(S03Parameters())
    previous = None
    expected = []
    for i, close in enumerate(PRICES, 1):
        fast.update_raw(close)
        slow.update_raw(close)
        rsi.update_raw(close)
        atr.update_raw(close + 100, close - 100, close)
        current = F(str(rsi.value * 100))
        if (
            i >= 250
            and close > fast.value > slow.value
            and previous is not None
            and previous <= 50 < current <= 65
            and F("0.001") <= F(str(atr.value)) / close <= F("0.02")
        ):
            expected.append(i)
        previous = current
    return expected


def test_btc_finite_crossing_is_shared_market_fact_not_execution():
    m = api()
    original, replay = stream(m), stream(m, source_revision=OTHER_REVISION)
    signals = []
    first = None
    for i, price in enumerate(PRICES, 1):
        observed = feed(original, bar(i, price))
        again = feed(replay, bar(i, price), revision=OTHER_REVISION)
        if i == 1:
            first = observed
        if observed.signal is not None:
            signals.append(i)
            signal = observed.signal
            assert signal.signal_id == again.signal.signal_id
            assert signal.prefix_sha256 != again.signal.prefix_sha256
            assert signal.scope == "MARKET_SIGNAL_ONLY"
            assert signal.execution_authorized is False
            assert signal.numeric_mode == "NATIVE_BINARY64_DECIMAL_BRIDGE_V1"
            assert signal.expires_at_ns == signal.bar_close_ns + 5_000_000_000
            with pytest.raises(FrozenInstanceError):
                signal.execution_authorized = True
    assert expected_signal_indices() == [266]
    assert signals == expected_signal_indices()
    assert first.snapshot.ema_fast == 60000
    assert first.snapshot.previous_rsi is None


@pytest.mark.parametrize(
    "offset,expected", [(4_999_999_999, True), (5_000_000_000, False), (5_000_000_001, False)]
)
def test_crossing_absolute_ttl_does_not_refresh(offset, expected):
    m = api()
    target = stream(m)
    for i, price in enumerate(PRICES[:266], 1):
        value = bar(i, price)
        observed = feed(target, value, available=value.ts_event + (offset if i == 266 else 0))
    assert observed.ready and observed.facts.market_match
    assert (observed.signal is not None) is expected
    assert observed.expired is (not expected)
    assert observed.expires_at_ns == value.ts_event + 5_000_000_000
    with pytest.raises(m.S03InputError):
        feed(target, value, available=value.ts_event + 9_000_000_000)
