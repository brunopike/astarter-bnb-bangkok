"""Deterministic intent policy; no account mutation, matching or performance PnL."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

type SmaSide = Literal["BUY", "SELL"]
_DECIMAL = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")


class SmaCrossSignal:
    """Consume each already-validated closed bar once, comparing exact sums."""

    def __init__(self, *, fast_period: int, slow_period: int) -> None:
        if (
            type(fast_period) is not int
            or type(slow_period) is not int
            or not 2 <= fast_period < slow_period <= 500
        ):
            raise ValueError("SMA_PERIODS_INVALID")
        self._fast = fast_period
        self._slow = slow_period
        self._closes: deque[Fraction] = deque(maxlen=slow_period)
        self._previous: Fraction | None = None
        self._sequence = 0

    def update(self, *, sequence: int, close: str) -> SmaSide | None:
        if type(sequence) is not int or sequence != self._sequence + 1:
            raise ValueError("SMA_BAR_SEQUENCE_INVALID")
        if (
            type(close) is not str
            or len(close) > 64
            or _DECIMAL.fullmatch(close) is None
            or Fraction(close) <= 0
        ):
            raise ValueError("SMA_CLOSE_INVALID")
        value = Fraction(close)
        self._closes.append(value)
        self._sequence = sequence
        if len(self._closes) < self._slow:
            return None
        closes = tuple(self._closes)
        difference = (
            sum(closes[-self._fast :], Fraction(0)) * self._slow
            - sum(closes, Fraction(0)) * self._fast
        )
        previous, self._previous = self._previous, difference
        if previous is None:
            return None
        if previous <= 0 < difference:
            return "BUY"
        if previous >= 0 > difference:
            return "SELL"
        return None


@dataclass(frozen=True, slots=True)
class SmaGuardState:
    position_quantity: Fraction
    base_free: Fraction
    quote_free: Fraction
    pending: bool


@dataclass(frozen=True, slots=True)
class SmaGuardDecision:
    code: str
    required_quote: Fraction = Fraction(0)


def check_sma_intent(
    *,
    side: SmaSide,
    quantity: Fraction,
    price: Fraction,
    taker_fee: Fraction,
    quote_quantum: Fraction,
    size_increment: Fraction,
    max_order_notional: Fraction,
    max_position_quantity: Fraction,
    state: SmaGuardState,
) -> SmaGuardDecision:
    """Check current-price exposure; native later fills must still be reconciled.

    One quote quantum per possible size-step fill bounds fee rounding conservatively
    for this fixed profile. It does not promise market fills cannot jump in price.
    """

    positives = (
        quantity, price, quote_quantum, size_increment, max_order_notional,
        max_position_quantity,
    )
    if (
        type(state) is not SmaGuardState
        or side not in ("BUY", "SELL")
        or any(type(value) is not Fraction or value <= 0 for value in positives)
        or type(taker_fee) is not Fraction
        or not 0 <= taker_fee <= 1
        or type(state.pending) is not bool
        or any(
            type(value) is not Fraction or value < 0
            for value in (state.position_quantity, state.base_free, state.quote_free)
        )
        or (quantity / size_increment).denominator != 1
    ):
        raise ValueError("SMA_GUARD_INVALID")
    if state.pending:
        return SmaGuardDecision("PENDING_ORDER")
    if side == "BUY" and state.position_quantity != 0:
        return SmaGuardDecision("POSITION_NOT_FLAT")
    if side == "SELL":
        if state.position_quantity == 0:
            return SmaGuardDecision("NO_CONFIRMED_POSITION")
        if quantity != state.position_quantity:
            return SmaGuardDecision("EXIT_QUANTITY_MISMATCH")
        if state.base_free < quantity:
            return SmaGuardDecision("INSUFFICIENT_BASE")
    notional = quantity * price
    if notional > max_order_notional:
        return SmaGuardDecision("EXIT_LIMIT_BLOCKED" if side == "SELL" else "ORDER_NOTIONAL_LIMIT")
    if side == "SELL":
        return SmaGuardDecision("ALLOW")
    if state.position_quantity + quantity > max_position_quantity:
        return SmaGuardDecision("POSITION_LIMIT")
    rounding = quote_quantum * (quantity / size_increment) if taker_fee else Fraction(0)
    required = notional * (1 + taker_fee) + rounding
    if required > state.quote_free:
        return SmaGuardDecision("INSUFFICIENT_CASH", required)
    return SmaGuardDecision("ALLOW", required)
