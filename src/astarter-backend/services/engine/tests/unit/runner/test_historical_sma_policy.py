from decimal import localcontext
from fractions import Fraction as F

import pytest

from stark_trading_os.runner.historical_sma_policy import (
    SmaCrossSignal,
    SmaGuardState,
    check_sma_intent,
)


def _signals(values: list[str]) -> list[str | None]:
    tracker = SmaCrossSignal(fast_period=2, slow_period=3)
    return [tracker.update(sequence=i, close=value) for i, value in enumerate(values, 1)]


def test_slow_plus_one_warmup_and_equality_cross_in_both_directions() -> None:
    assert _signals(["100", "100", "100", "110"]) == [None, None, None, "BUY"]
    assert _signals(["100", "100", "100", "90"]) == [None, None, None, "SELL"]
    assert _signals(["100"] * 8) == [None] * 8


def test_exact_crossing_ignores_decimal_context_and_float_precision() -> None:
    with localcontext() as ctx:
        ctx.prec = 4
        assert _signals(["100000000.00000001"] * 3 + ["100000000.00000002"])[-1] == "BUY"


def test_signal_prefix_is_independent_of_future_prices() -> None:
    prefix = ["100", "100", "100", "110", "100", "90", "110"]
    assert _signals(prefix + ["10000", "0.01"])[: len(prefix)] == _signals(prefix)


@pytest.mark.parametrize("sequence", [0, 1, 3, True])
def test_invalid_sequence_rejected_without_mutating_signal_state(sequence: int) -> None:
    tracker = SmaCrossSignal(fast_period=2, slow_period=3)
    tracker.update(sequence=1, close="100")
    with pytest.raises(ValueError, match="SMA_BAR_SEQUENCE_INVALID"):
        tracker.update(sequence=sequence, close="999")
    assert tracker.update(sequence=2, close="100") is None
    assert tracker.update(sequence=3, close="100") is None
    assert tracker.update(sequence=4, close="110") == "BUY"


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-1", "0", "1e5", "1/2", ""])
def test_invalid_close_rejected_without_consuming_sequence(value: str) -> None:
    tracker = SmaCrossSignal(fast_period=2, slow_period=3)
    with pytest.raises(ValueError, match="SMA_CLOSE_INVALID"):
        tracker.update(sequence=1, close=value)
    assert tracker.update(sequence=1, close="1") is None


@pytest.mark.parametrize("fast,slow", [(1, 3), (3, 3), (4, 3), (2, 501), (True, 3)])
def test_invalid_periods_rejected(fast: int, slow: int) -> None:
    with pytest.raises(ValueError, match="SMA_PERIODS_INVALID"):
        SmaCrossSignal(fast_period=fast, slow_period=slow)


def _guard(side: str = "BUY", **changes: object):
    values = dict(
        side=side,
        quantity=F(1),
        price=F(105),
        taker_fee=F("0.001"),
        quote_quantum=F("0.00000001"),
        size_increment=F("0.001"),
        max_order_notional=F(1000),
        max_position_quantity=F(2),
        state=SmaGuardState(
            position_quantity=F(0), base_free=F(0), quote_free=F(1000), pending=False
        ),
    )
    values.update(changes)
    return check_sma_intent(**values)


def test_guard_cash_covers_fee_and_each_possible_fill_rounding() -> None:
    allowed = _guard()
    assert allowed.code == "ALLOW"
    assert allowed.required_quote == F("105.10501")
    assert _guard(state=SmaGuardState(F(0), F(0), F(105), False)).code == "INSUFFICIENT_CASH"
    assert _guard(state=SmaGuardState(F(0), F(0), F("105.10501"), False)).code == "ALLOW"
    assert _guard(taker_fee=F(0)).required_quote == F(105)


def test_no_pyramiding_or_pending_order_overlap() -> None:
    assert _guard(state=SmaGuardState(F(1), F(1), F(1000), False)).code == "POSITION_NOT_FLAT"
    assert _guard(state=SmaGuardState(F(0), F(0), F(1000), True)).code == "PENDING_ORDER"


def test_entry_quantity_and_both_direction_notional_caps() -> None:
    assert _guard(max_position_quantity=F("0.5")).code == "POSITION_LIMIT"
    assert _guard(max_order_notional=F(100)).code == "ORDER_NOTIONAL_LIMIT"
    assert _guard("SELL", state=SmaGuardState(F(1), F(1), F(0), False),
                  max_order_notional=F(100)).code == "EXIT_LIMIT_BLOCKED"


def test_sell_requires_confirmed_full_position_and_free_base() -> None:
    assert _guard("SELL").code == "NO_CONFIRMED_POSITION"
    assert _guard(
        "SELL", state=SmaGuardState(F(2), F(2), F(0), False)
    ).code == "EXIT_QUANTITY_MISMATCH"
    assert _guard(
        "SELL", state=SmaGuardState(F(1), F("0.5"), F(0), False)
    ).code == "INSUFFICIENT_BASE"
    result = _guard("SELL", state=SmaGuardState(F(1), F(1), F(0), False))
    assert result.code == "ALLOW"
    assert result.required_quote == 0


def test_invalid_negative_state_and_misaligned_quantity_fail_closed() -> None:
    with pytest.raises(ValueError, match="SMA_GUARD_INVALID"):
        _guard(state=SmaGuardState(F(0), F(0), F(-1), False))
    with pytest.raises(ValueError, match="SMA_GUARD_INVALID"):
        _guard(quantity=F("0.0011"))
