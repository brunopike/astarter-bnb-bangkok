"""Approved S03 risk must size the reserve. A fixed sample policy does not."""

from decimal import Decimal
from hashlib import sha256

import pytest

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    SimulationPolicy,
    policy_bytes,
)
from stark_trading_os.domain.s03_bridge import S03BridgeRejected, S03RawBar
from stark_trading_os.domain.s03_signal import S03Parameters
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_lifecycle import _book, _consume_news, _push
from tests.unit.domain.test_s03_bridge import (
    POLICY_SHA256,
    SEED,
    _stream_prices,
    market_plan,
)

BAR = 300_000_000_000


def _case(risk: str, notional: str, stop_atr: str = "2"):
    parameters = S03Parameters(
        ema_fast=10,
        ema_slow=30,
        rsi_cross="40",
        rsi_ceiling="75",
        rsi_fail="30",
        volatility_max="0.05",
        risk_fraction=risk,
        notional_fraction=notional,
        stop_atr=stop_atr,
    )
    bars = tuple(
        S03RawBar(
            open=f"{price:.2f}",
            high=f"{price + 5:.2f}",
            low=f"{price - 5:.2f}",
            close=f"{price:.2f}",
            volume="1",
            bar_close_ns=SEED + index * BAR,
            ts_init_ns=SEED + index * BAR,
            available_at_ns=SEED + index * BAR + 1,
        )
        for index, price in enumerate(_stream_prices())
    )
    plan, manifest, _case, signal, observation = market_plan(parameters, bars)
    assert signal is not None and signal.close == "1253.20"
    return plan, manifest, signal, observation


def _reserve(tmp_path, name: str, risk: str, notional: str, ask: str, stop_atr: str = "2"):
    plan, manifest, signal, observation = _case(risk, notional, stop_atr)
    when = signal.bar_close_ns + 1_000_000_000
    book = _book(when)
    engine, strategy, source = book.__enter__()
    try:
        if ask != "60000.00":
            _push(engine, strategy, when + 1_000_000, str(Decimal(ask) - 1), ask, None)
        control = s03_bridge(ControlStore.open(tmp_path / name), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        account = control._astarter.account("SIM-001")
        return control.reserve_signal(
            owner,
            source,
            signal,
            observation,
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
        )
    finally:
        book.__exit__(None, None, None)


def test_sample_policy_bytes_stay_canonical() -> None:
    assert sha256(policy_bytes(SimulationPolicy())).hexdigest() == POLICY_SHA256


def test_cap_below_the_fresh_ask_rejects_before_a_sample_reserve(tmp_path) -> None:
    with pytest.raises(S03BridgeRejected, match="S03_CAP_BELOW_ASK"):
        _reserve(tmp_path, "ask.sqlite", "0.005", "0.2", "60000.00")


def test_tiny_approved_limits_do_not_reserve_five(tmp_path) -> None:
    with pytest.raises(AstarterBlocked, match="ASTARTER_NO_FEASIBLE_ORDER"):
        _reserve(tmp_path, "tiny.sqlite", "0.000001", "0.0001", "1254.00")


def test_receipt_uses_the_signal_cap_and_the_approved_risk(tmp_path) -> None:
    reserved = _reserve(tmp_path, "fit.sqlite", "0.005", "0.2", "1254.00")
    assert Decimal(reserved.cap) == Decimal("1255.70")
    assert Decimal(reserved.stop) == Decimal("1233.20")
    assert Decimal(reserved.risk_reserved) <= Decimal("25")
    assert Decimal(reserved.risk_reserved) != Decimal("5")
    assert Decimal(reserved.quantity) * Decimal(reserved.cap) <= Decimal("1000")


def test_nondefault_stop_changes_the_receipt(tmp_path) -> None:
    reserved = _reserve(tmp_path, "stop.sqlite", "0.005", "0.2", "1254.00", stop_atr="1")
    assert Decimal(reserved.stop) == Decimal("1243.20")
    assert Decimal(reserved.cap) == Decimal("1255.70")
