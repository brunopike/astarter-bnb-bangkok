"""S03 parameter and market-only fact contracts; no market data or orders."""

import importlib
import importlib.util
import math
from decimal import localcontext

import pytest
from pydantic import ValidationError


def api():
    name = "stark_trading_os.domain.s03_signal"
    assert importlib.util.find_spec(name) is not None, "S03 signal contract is not implemented"
    return importlib.import_module(name)


def snapshot(module, **updates):
    return module.S03IndicatorSnapshot(
        **(
            dict(ema_fast=99.0, ema_slow=98.0, close=100.0, atr=1.0, previous_rsi=50.0, rsi=60.0)
            | updates
        )
    )


def test_signal_contract_exists():
    assert api().S03Parameters().warmup_bars == 250


def test_defaults_and_frozen_identity():
    m = api()
    p = m.S03Parameters()
    expected = dict(
        ema_fast=20,
        ema_slow=50,
        rsi_period=14,
        atr_period=14,
        rsi_cross="50",
        rsi_ceiling="65",
        rsi_fail="45",
        volatility_min="0.001",
        volatility_max="0.02",
        stop_atr="2",
        risk_fraction="0.005",
        notional_fraction="0.2",
        hold_boundaries=36,
        cooldown_full_bars=3,
    )
    assert p.model_dump() == expected
    assert len(expected) == 14
    assert len(p.parameters_sha256) == 64
    assert (
        p.parameters_sha256
        == m.S03Parameters(**dict(reversed(list(expected.items())))).parameters_sha256
    )
    with pytest.raises(ValidationError):
        p.ema_fast = 10
    with pytest.raises(ValidationError):
        m.S03Parameters(unknown=1)
    assert m.S03Parameters(ema_slow=250).warmup_bars == 1250


CHANGES = dict(
    ema_fast=10,
    ema_slow=60,
    rsi_period=10,
    atr_period=10,
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
)


@pytest.mark.parametrize("name,value", CHANGES.items())
def test_every_parameter_changes_identity(name, value):
    m = api()
    assert m.S03Parameters(**{name: value}).parameters_sha256 != m.S03Parameters().parameters_sha256


@pytest.mark.parametrize(
    "values",
    [
        dict(
            ema_fast=5,
            ema_slow=10,
            rsi_period=5,
            atr_period=5,
            rsi_cross="40",
            rsi_ceiling="40.00000000000000000001",
            rsi_fail="25",
            stop_atr="1",
            hold_boundaries=6,
            cooldown_full_bars=1,
        ),
        dict(
            ema_fast=100,
            ema_slow=250,
            rsi_period=50,
            atr_period=50,
            rsi_cross="60",
            rsi_ceiling="75",
            rsi_fail="50",
            volatility_max="0.05",
            stop_atr="4",
            hold_boundaries=288,
            cooldown_full_bars=12,
        ),
    ],
)
def test_parameter_valid_endpoints(values):
    api().S03Parameters(**values)


@pytest.mark.parametrize(
    "name,value",
    [
        ("ema_fast", 4),
        ("ema_fast", 101),
        ("ema_fast", 50),
        ("ema_slow", 9),
        ("ema_slow", 251),
        ("rsi_period", 4),
        ("rsi_period", 51),
        ("atr_period", 4),
        ("atr_period", 51),
        ("hold_boundaries", 5),
        ("hold_boundaries", 289),
        ("cooldown_full_bars", 0),
        ("cooldown_full_bars", 13),
        ("rsi_cross", "39.99"),
        ("rsi_cross", "60.01"),
        ("rsi_ceiling", "50"),
        ("rsi_ceiling", "75.001"),
        ("rsi_fail", "24.99"),
        ("rsi_fail", "50"),
        ("volatility_min", "0"),
        ("volatility_min", "0.02"),
        ("volatility_max", "0.001"),
        ("volatility_max", "0.050000000000000000001"),
        ("stop_atr", "0.999"),
        ("stop_atr", "4.001"),
        ("risk_fraction", "0"),
        ("risk_fraction", "0.005000000000000000001"),
        ("notional_fraction", "0"),
        ("notional_fraction", "0.200000000000000000001"),
    ],
)
def test_parameter_invalid_bounds(name, value):
    m = api()
    with pytest.raises(ValidationError):
        m.S03Parameters(**{name: value})


@pytest.mark.parametrize(
    "name",
    ["ema_fast", "ema_slow", "rsi_period", "atr_period", "hold_boundaries", "cooldown_full_bars"],
)
@pytest.mark.parametrize("value", [True, 20.0, "20"])
def test_integer_parameters_are_strict(name, value):
    m = api()
    with pytest.raises(ValidationError):
        m.S03Parameters(**{name: value})


@pytest.mark.parametrize(
    "value",
    [
        "0.20",
        " 0.2",
        "+0.2",
        "00.2",
        "2e-1",
        "NaN",
        "Infinity",
        "-0",
        "0.2\n",
        0.2,
        True,
        "0." + "0" * 62 + "1",
    ],
)
def test_parameter_decimal_representation_is_bounded_canonical(value):
    m = api()
    with pytest.raises(ValidationError):
        m.S03Parameters(notional_fraction=value)


@pytest.mark.parametrize(
    "updates,field,expected",
    [
        ({}, "market_match", True),
        ({"rsi": 50.0}, "rsi_cross_up", False),
        ({"rsi": 65.0}, "rsi_cross_up", True),
        ({"rsi": math.nextafter(65.0, math.inf)}, "rsi_cross_up", False),
        ({"previous_rsi": math.nextafter(50.0, math.inf)}, "rsi_cross_up", False),
        ({"previous_rsi": None}, "rsi_cross_up", False),
        ({"ema_fast": 98.0}, "trend_up", False),
        ({"ema_fast": 100.0}, "trend_up", False),
        ({"ema_fast": 98.0}, "trend_invalid", True),
        ({"ema_fast": 100.0}, "trend_invalid", False),
        ({"rsi": 45.0}, "momentum_below_fail", False),
        ({"rsi": math.nextafter(45.0, 0.0)}, "momentum_below_fail", True),
    ],
)
def test_market_fact_boundaries(updates, field, expected):
    m = api()
    assert (
        getattr(m.evaluate_s03_market(snapshot(m, **updates), m.S03Parameters()), field) is expected
    )


@pytest.mark.parametrize(
    "atr,expected",
    [
        (0.0, False),
        (0.1, True),
        (2.0, True),
        (math.nextafter(0.1, 0.0), False),
        (math.nextafter(2.0, math.inf), False),
    ],
)
def test_volatility_decimal_bridge(atr, expected):
    m = api()
    assert (
        m.evaluate_s03_market(snapshot(m, atr=atr), m.S03Parameters()).volatility_allowed
        is expected
    )


def test_high_precision_threshold_is_not_rounded_to_binary64():
    m = api()
    p = m.S03Parameters(volatility_max="0.019999999999999999999")
    assert not m.evaluate_s03_market(snapshot(m, atr=2.0), p).volatility_allowed


def test_decimal_context_does_not_change_facts():
    m = api()
    p = m.S03Parameters()
    s = snapshot(m, atr=2.0)
    expected = m.evaluate_s03_market(s, p)
    digest = p.parameters_sha256
    with localcontext() as context:
        context.prec = 2
        for signal in context.traps:
            context.traps[signal] = True
        assert m.evaluate_s03_market(s, p) == expected
        assert p.parameters_sha256 == digest


@pytest.mark.parametrize(
    "field,value",
    [
        ("ema_fast", 0.0),
        ("ema_slow", -1.0),
        ("close", 0.0),
        ("atr", -1.0),
        ("rsi", 100.1),
        ("rsi", -0.1),
        ("previous_rsi", 101.0),
        ("atr", math.inf),
        ("ema_fast", math.nan),
        ("rsi", math.nan),
        ("previous_rsi", -math.inf),
        ("close", True),
    ],
)
def test_snapshot_rejects_nonfinite_or_invalid_values(field, value):
    m = api()
    with pytest.raises(ValidationError):
        snapshot(m, **{field: value})


def test_all_nondefault_parameters_are_consumed():
    m = api()
    p = m.S03Parameters(**CHANGES)
    s = snapshot(m, previous_rsi=55.0, rsi=67.0, atr=2.5)
    assert m.evaluate_s03_market(s, p).market_match
    assert not m.evaluate_s03_market(s, m.S03Parameters()).market_match
    assert not m.evaluate_s03_market(snapshot(m, rsi=42.0), p).momentum_below_fail
    assert m.evaluate_s03_market(snapshot(m, rsi=42.0), m.S03Parameters()).momentum_below_fail


def test_public_evaluator_revalidates_constructed_models():
    m = api()
    p = m.S03Parameters()
    with pytest.raises(ValidationError):
        m.evaluate_s03_market(snapshot(m).model_copy(update={"atr": math.inf}), p)
    with pytest.raises(ValidationError):
        m.evaluate_s03_market(snapshot(m), p.model_copy(update={"ema_fast": True}))


def test_signal_identity_uses_rule_instrument_and_bar_only():
    m = api()
    p = m.S03Parameters()
    one = m.s03_signal_id(p.parameters_sha256, "BTCUSDT.SIM", 300_000_000_000)
    assert one == m.s03_signal_id(p.parameters_sha256, "BTCUSDT.SIM", 300_000_000_000)
    assert one != m.s03_signal_id(p.parameters_sha256, "BTCUSDT.SIM", 600_000_000_000)
    assert one != m.s03_signal_id(p.parameters_sha256, "BTCUSDT.BINANCE", 300_000_000_000)
    assert one != m.s03_signal_id(
        m.S03Parameters(ema_fast=10).parameters_sha256, "BTCUSDT.SIM", 300_000_000_000
    )
