"""Simulation-only risk mathematics. No account, order, clock or I/O authority.

All monetary inputs are bounded canonical decimal strings. Rational intermediates
avoid ambient Decimal rounding; finite outputs use a fresh local Decimal context.
Fees are conservative RC04 bounds, not a prediction of actual commission.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Context, Decimal, Inexact, localcontext
from fractions import Fraction as F
from math import gcd, lcm
from typing import Literal

BUDGET_SCOPES = ("PRIVATE", "CYCLE", "DAY", "PORTFOLIO", "ASSET", "CORRELATED", "EVENT")
_NUMBER = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
_CURRENCY = re.compile(r"^[A-Z][A-Z0-9_]{0,15}$")


class InvalidRiskInput(ValueError):
    def __init__(self) -> None:
        super().__init__("ASTARTER_RISK_INPUT_INVALID")


def _number(value: str, *, signed: bool = False, positive: bool = False) -> F:
    if (
        type(value) is not str
        or len(value) > 64
        or value == "-0"
        or _NUMBER.fullmatch(value) is None
    ):
        raise InvalidRiskInput
    with localcontext(Context(prec=1024)):
        result = F(Decimal(value))
    if (not signed and result < 0) or (positive and result <= 0):
        raise InvalidRiskInput
    return result


def _text(value: F) -> str:
    with localcontext(Context(prec=1024)) as ctx:
        ctx.traps[Inexact] = True
        text = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if len(text) > 256:
        raise InvalidRiskInput
    return "0" if text == "-0" else text


def _currency(value: str) -> None:
    if type(value) is not str or _CURRENCY.fullmatch(value) is None:
        raise InvalidRiskInput


def _rate(value: str) -> F:
    result = _number(value)
    if result > 1:
        raise InvalidRiskInput
    return result


def _floor(value: F, unit: F) -> F:
    return (value // unit) * unit


def _ceil(value: F, unit: F) -> F:
    return -((-value) // unit) * unit


@dataclass(frozen=True, slots=True)
class _Candidate:
    scope: Literal["SIMULATION_MATH_ONLY"] = field(default="SIMULATION_MATH_ONLY", init=False)
    execution_authorized: Literal[False] = field(default=False, init=False)


@dataclass(frozen=True, slots=True)
class Pair:
    base: str
    quote: str


@dataclass(frozen=True, slots=True)
class CostProfile:
    pair: Pair
    cap: str
    stress_exit: str
    buy_fee: str
    sell_fee: str
    quantity_step: str
    quote_unit: str


@dataclass(frozen=True, slots=True)
class SizingLimits:
    pair: Pair
    risk_budget: str
    notional_cap: str
    available_quote: str
    min_quantity: str
    min_notional: str


@dataclass(frozen=True, slots=True)
class CostQuote(_Candidate):
    pair: Pair
    quantity: str
    notional: str
    reserve: str
    stress_loss: str
    buy_fee_max: str
    sell_fee_max: str
    fill_bound: int


@dataclass(frozen=True, slots=True)
class SizeCandidate(_Candidate):
    reason: str
    costs: CostQuote | None
    initial_quantity: str
    reduced_steps: int
    search_iterations: int


@dataclass(frozen=True, slots=True)
class BasketOrder:
    cap: str
    quantity: str


@dataclass(frozen=True, slots=True)
class WeightedLayer:
    cap: str
    weight: str


@dataclass(frozen=True, slots=True)
class BasketSizeCandidate(_Candidate):
    reason: str
    first_layer_quantity: str
    orders: tuple[BasketOrder, ...]
    costs: CostQuote | None
    search_iterations: int


@dataclass(frozen=True, slots=True)
class BudgetLimit:
    scope: str
    cap: str
    booked_debit: str
    inventory_future: str
    pending_future: str


@dataclass(frozen=True, slots=True)
class BudgetLine:
    scope: str
    occupied: str
    headroom: str
    remaining: str
    over_limit: bool


@dataclass(frozen=True, slots=True)
class BudgetCandidate(_Candidate):
    quote_currency: str
    candidate_risk: str
    lines: tuple[BudgetLine, ...]


@dataclass(frozen=True, slots=True)
class StagedRisk(_Candidate):
    quote_currency: str
    risk_fraction: str
    risk_quote: str


@dataclass(frozen=True, slots=True)
class ProfitInput:
    quote_currency: str
    gross_equity: str
    settled_profit: str
    old_profit_hwm: str
    old_reserve: str
    lock_fraction: str
    flat: bool
    orders_terminal: bool
    reconciled: bool


@dataclass(frozen=True, slots=True)
class ProfitCandidate(_Candidate):
    quote_currency: str
    increment: str
    new_reserve: str
    reserve_after: str
    profit_hwm_after: str
    tradable_equity: str
    wealth: str


@dataclass(frozen=True, slots=True)
class KellyAdvice(_Candidate):
    full_fraction: str
    fractional_fraction: str
    nonnegative_fractional_cap: str
    positive: bool
    quantum: str


@dataclass(frozen=True, slots=True)
class LpBudget(_Candidate):
    quote_currency: str
    remaining: str
    requested_pressure: str
    maximum_principal: str
    exceeds_budget: bool


@dataclass(frozen=True, slots=True)
class AtomicCost(_Candidate):
    quote_currency: str
    net_profit: str
    minimum_net: str
    minimum_output: str
    cost_floor_met: bool


def _pair(pair: Pair) -> None:
    if type(pair) is not Pair:
        raise InvalidRiskInput
    _currency(pair.base)
    _currency(pair.quote)
    if pair.base == pair.quote:
        raise InvalidRiskInput


def _profile(p: CostProfile) -> tuple[F, F, F, F, F, F]:
    if type(p) is not CostProfile:
        raise InvalidRiskInput
    _pair(p.pair)
    cap, stress = _number(p.cap, positive=True), _number(p.stress_exit, positive=True)
    if stress >= cap:
        raise InvalidRiskInput
    return (
        cap,
        stress,
        _rate(p.buy_fee),
        _rate(p.sell_fee),
        _number(p.quantity_step, positive=True),
        _number(p.quote_unit, positive=True),
    )


def _limits(p: CostProfile, limits: SizingLimits) -> tuple[F, F, F, F, F]:
    if type(limits) is not SizingLimits:
        raise InvalidRiskInput
    _pair(limits.pair)
    if limits.pair != p.pair:
        raise InvalidRiskInput
    return (
        _number(limits.risk_budget),
        _number(limits.notional_cap),
        _number(limits.available_quote),
        _number(limits.min_quantity, positive=True),
        _number(limits.min_notional),
    )


def _cost(q: F, cap: F, stress: F, fb: F, fs: F, step: F, unit: F) -> tuple[F, F, F, F, int]:
    count = int(_ceil(q / step, F(1)))
    buy = _ceil(q * cap * fb, unit) + count * unit
    sell = _ceil(q * stress * fs, unit) + count * unit
    return (_ceil(q * cap, unit) + buy, q * (cap - stress) + buy + sell, buy, sell, count)


def _search(upper: int, fits: Callable[[int], bool]) -> tuple[int, int]:
    lo, hi, iterations = 0, upper, 0
    while lo < hi:
        middle = (lo + hi + 1) // 2
        if fits(middle):
            lo = middle
        else:
            hi = middle - 1
        iterations += 1
    return lo, iterations


def spot_costs(profile: CostProfile, quantity: str) -> CostQuote:
    """Price one exact-step candidate; no budget or execution permission implied."""
    cap, stress, fb, fs, step, unit = _profile(profile)
    q = _number(quantity)
    if (q / step).denominator != 1:
        raise InvalidRiskInput
    reserve, loss, buy, sell, count = _cost(q, cap, stress, fb, fs, step, unit)
    return CostQuote(
        profile.pair,
        _text(q),
        _text(q * cap),
        _text(reserve),
        _text(loss),
        _text(buy),
        _text(sell),
        count,
    )


def size_spot(profile: CostProfile, limits: SizingLimits) -> SizeCandidate:
    """Largest step-aligned spot candidate fitting pressure, notional and cash."""
    cap, stress, fb, fs, step, unit = _profile(profile)
    risk, nominal, cash, minimum_q, minimum_n = _limits(profile, limits)
    if risk == 0:
        return SizeCandidate("NO_RISK_BUDGET", None, "0", 0, 0)
    ell = cap - stress + cap * fb + stress * fs
    initial = _floor(min(risk / ell, nominal / cap, cash / (cap * (1 + fb))), step)
    upper = int(initial / step)

    def fits(n: int) -> bool:
        reserve, loss, _, _, _ = _cost(n * step, cap, stress, fb, fs, step, unit)
        return reserve <= cash and loss <= risk

    n, iterations = _search(upper, fits)
    q = n * step
    if q == 0 or q < minimum_q or q * cap < minimum_n:
        return SizeCandidate("BELOW_MIN_ORDER", None, _text(initial), upper - n, iterations)
    reserved, loss, buy, sell, count = _cost(q, cap, stress, fb, fs, step, unit)
    quote = CostQuote(
        profile.pair,
        _text(q),
        _text(q * cap),
        _text(reserved),
        _text(loss),
        _text(buy),
        _text(sell),
        count,
    )
    return SizeCandidate("CANDIDATE_ONLY", quote, _text(initial), upper - n, iterations)


def _basket_math(
    values: tuple[tuple[F, F], ...], stress: F, fb: F, fs: F, step: F, unit: F
) -> tuple[F, F, F, F, F, F]:
    qty = nominal = reserve = pressure = buy_fees = F(0)
    for cap, q in values:
        fee = _ceil(q * cap * fb, unit) + int(q / step) * unit
        qty += q
        nominal += q * cap
        reserve += _ceil(q * cap, unit) + fee
        pressure += q * (cap - stress) + fee
        buy_fees += fee
    sell = _ceil(qty * stress * fs, unit) + int(qty / step) * unit
    return qty, nominal, reserve, pressure + sell, buy_fees, sell


def _basket_values(p: CostProfile, orders: tuple[BasketOrder, ...]) -> tuple[F, F, F, F, F, F]:
    _, stress, fb, fs, step, unit = _profile(p)
    if type(orders) is not tuple or not 1 <= len(orders) <= 16:
        raise InvalidRiskInput
    values = []
    for row in orders:
        if type(row) is not BasketOrder:
            raise InvalidRiskInput
        cap, q = _number(row.cap, positive=True), _number(row.quantity)
        if cap <= stress or (q / step).denominator != 1:
            raise InvalidRiskInput
        values.append((cap, q))
    return _basket_math(tuple(values), stress, fb, fs, step, unit)


def basket_costs(profile: CostProfile, orders: tuple[BasketOrder, ...]) -> CostQuote:
    """Aggregate all requested layers, with one full-inventory exit fee bound."""
    qty, nominal, reserve, loss, buy, sell = _basket_values(profile, orders)
    _, _, _, _, step, _ = _profile(profile)
    return CostQuote(
        profile.pair,
        _text(qty),
        _text(nominal),
        _text(reserve),
        _text(loss),
        _text(buy),
        _text(sell),
        int(qty / step),
    )


def size_basket(
    profile: CostProfile, layers: tuple[WeightedLayer, ...], limits: SizingLimits
) -> BasketSizeCandidate:
    """Size a finite basket without truncating its frozen layer ratios."""
    _, stress, fb, fs, step, unit = _profile(profile)
    risk, nominal, cash, minimum_q, minimum_n = _limits(profile, limits)
    if type(layers) is not tuple or not 1 <= len(layers) <= 16:
        raise InvalidRiskInput
    values: list[tuple[F, F]] = []
    for row in layers:
        if type(row) is not WeightedLayer:
            raise InvalidRiskInput
        cap, weight = _number(row.cap, positive=True), _number(row.weight, positive=True)
        if cap <= stress:
            raise InvalidRiskInput
        values.append((cap, weight))
    denominator = lcm(*(weight.denominator for _, weight in values))
    numerator_gcd = gcd(*(int(weight * denominator) for _, weight in values))
    increment = step * F(denominator, numerator_gcd)
    notional_per = sum((cap * w for cap, w in values), F(0))
    loss_per = sum((w * (cap - stress + cap * fb + stress * fs) for cap, w in values), F(0))
    upper = int(
        min(risk / loss_per, nominal / notional_per, cash / (notional_per * (1 + fb))) // increment
    )

    def quantities(n: int) -> tuple[tuple[F, F], ...]:
        return tuple((cap, n * increment * w) for cap, w in values)

    def fits(n: int) -> bool:
        _, _, reserved, loss, _, _ = _basket_math(quantities(n), stress, fb, fs, step, unit)
        return reserved <= cash and loss <= risk

    n, iterations = _search(upper, fits)
    if n == 0 or any(
        n * increment * w < minimum_q or n * increment * w * cap < minimum_n for cap, w in values
    ):
        return BasketSizeCandidate("BELOW_MIN_ORDER", "0", (), None, iterations)
    final = tuple(BasketOrder(_text(cap), _text(q)) for cap, q in quantities(n))
    qty, notional, reserve, loss, buy, sell = _basket_math(
        quantities(n), stress, fb, fs, step, unit
    )
    quote = CostQuote(
        profile.pair,
        _text(qty),
        _text(notional),
        _text(reserve),
        _text(loss),
        _text(buy),
        _text(sell),
        int(qty / step),
    )
    return BasketSizeCandidate("CANDIDATE_ONLY", final[0].quantity, final, quote, iterations)


def remaining_budget(
    quote_currency: str, requested_risk: str, limits: tuple[BudgetLimit, ...]
) -> BudgetCandidate:
    """Every scope is explicit; booked loss and future losses are disjoint inputs."""
    _currency(quote_currency)
    requested = _number(requested_risk)
    if (
        type(limits) is not tuple
        or len(limits) != len(BUDGET_SCOPES)
        or any(type(v) is not BudgetLimit or type(v.scope) is not str for v in limits)
        or {v.scope for v in limits} != set(BUDGET_SCOPES)
    ):
        raise InvalidRiskInput
    lines = []
    candidate = requested
    for row in limits:
        cap, debit, inventory, pending = (
            _number(v)
            for v in (row.cap, row.booked_debit, row.inventory_future, row.pending_future)
        )
        occupied = debit + inventory + pending
        headroom = cap - occupied
        remaining = max(F(0), headroom)
        candidate = min(candidate, remaining)
        lines.append(
            BudgetLine(row.scope, _text(occupied), _text(headroom), _text(remaining), headroom < 0)
        )
    return BudgetCandidate(quote_currency, _text(candidate), tuple(lines))


def staged_risk(
    quote_currency: str,
    equity: str,
    base_fraction: str,
    card_cap: str,
    policy_cap: str,
    account_multiplier: str,
    stage_multiplier: str,
    kelly_cap: str | None = None,
) -> StagedRisk:
    _currency(quote_currency)
    e, base, card, policy = (
        _number(equity),
        _rate(base_fraction),
        _rate(card_cap),
        _rate(policy_cap),
    )
    account, stage = _number(account_multiplier), _number(stage_multiplier)
    if account not in (F(1, 2), F(1), F(5, 4)) or stage not in (
        F(0),
        F(1, 4),
        F(1, 2),
        F(3, 4),
        F(1),
    ):
        raise InvalidRiskInput
    r = min(card, policy, base * account * stage)
    if kelly_cap is not None:
        r = min(r, _rate(kelly_cap))
    return StagedRisk(quote_currency, _text(r), _text(e * r))


def profit_lock(inputs: ProfitInput) -> ProfitCandidate:
    """Candidate state transition, conditional on caller-supplied settlement facts."""
    if type(inputs) is not ProfitInput:
        raise InvalidRiskInput
    _currency(inputs.quote_currency)
    if any(
        type(v) is not bool or not v
        for v in (inputs.flat, inputs.orders_terminal, inputs.reconciled)
    ):
        raise InvalidRiskInput
    gross = _number(inputs.gross_equity)
    settled = _number(inputs.settled_profit, signed=True)
    hwm, old, rate = (
        _number(inputs.old_profit_hwm),
        _number(inputs.old_reserve),
        _rate(inputs.lock_fraction),
    )
    increment = max(F(0), settled - hwm)
    new = increment * rate
    reserve = old + new
    return ProfitCandidate(
        inputs.quote_currency,
        _text(increment),
        _text(new),
        _text(reserve),
        _text(max(hwm, settled)),
        _text(gross - reserve),
        _text(gross),
    )


def kelly_advice(
    probability: str, net_payoff_ratio: str, fraction: str, quantum: str = "0.000000000000000001"
) -> KellyAdvice:
    p, b, multiplier = _rate(probability), _number(net_payoff_ratio, positive=True), _rate(fraction)
    unit = _number(quantum, positive=True)
    if unit > 1:
        raise InvalidRiskInput
    full = p - (1 - p) / b
    part = _floor(full * multiplier, unit)
    return KellyAdvice(
        _text(_floor(full, unit)), _text(part), _text(max(F(0), part)), full > 0, _text(unit)
    )


def lp_budget(
    quote_currency: str,
    equity: str,
    portfolio_fraction: str,
    other_occupancy: str,
    nominal_fraction: str,
    principal: str,
    gas: str,
    quote_unit: str,
) -> LpBudget:
    _currency(quote_currency)
    e, f, other, nominal, q, g, unit = (
        _number(equity),
        _rate(portfolio_fraction),
        _number(other_occupancy),
        _rate(nominal_fraction),
        _number(principal),
        _number(gas),
        _number(quote_unit, positive=True),
    )
    remaining = e * f - other
    pressure = _ceil(q, unit) + _ceil(g, unit)
    maximum = _floor(max(F(0), min(e * nominal, remaining - _ceil(g, unit))), unit)
    return LpBudget(
        quote_currency,
        _text(remaining),
        _text(pressure),
        _text(maximum),
        pressure > remaining or _ceil(q, unit) > e * nominal,
    )


def atomic_cost_floor(
    quote_currency: str,
    input_quote: str,
    output_net: str,
    gas: str,
    external_fee: str,
    buffer: str,
    minimum_absolute: str,
    minimum_fraction: str,
    quote_unit: str,
    *,
    fees_in_output: bool,
) -> AtomicCost:
    _currency(quote_currency)
    if type(fees_in_output) is not bool or not fees_in_output:
        raise InvalidRiskInput
    start, net = _number(input_quote, positive=True), _number(output_net)
    extra = _number(gas) + _number(external_fee) + _number(buffer)
    minimum = max(_number(minimum_absolute), start * _rate(minimum_fraction))
    unit = _number(quote_unit, positive=True)
    profit = net - start - extra
    minimum_output = _ceil(start + extra + minimum, unit)
    return AtomicCost(
        quote_currency, _text(profit), _text(minimum), _text(minimum_output), net >= minimum_output
    )
