"""Closed finite simulation contracts, not a public strategy/run or live API."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from decimal import Context, Decimal, Inexact, localcontext
from fractions import Fraction as F
from hashlib import sha256
from typing import Literal, cast

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.domain import astarter_risk as risk

TERMINAL = frozenset({"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"})
_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")


class AstarterBlocked(ValueError):
    pass


class AstarterConflict(ValueError):
    pass


class AstarterIntegrityError(ValueError):
    pass


def amount(value: str, *, signed: bool = False) -> F:
    if (
        type(value) is not str
        or len(value) > 256
        or value == "-0"
        or _DECIMAL.fullmatch(value) is None
    ):
        raise ValueError("ASTARTER_AMOUNT_INVALID")
    result = F(value)
    if not signed and result < 0:
        raise ValueError("ASTARTER_AMOUNT_INVALID")
    return result


def text(value: F | Decimal) -> str:
    value = F(value)
    with localcontext(Context(prec=1024)) as ctx:
        ctx.traps[Inexact] = True
        raw = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
    raw = raw.rstrip("0").rstrip(".") if "." in raw else raw
    if len(raw) > 256:
        raise ValueError("ASTARTER_AMOUNT_INVALID")
    return "0" if raw == "-0" else raw


def encode(value: object) -> bytes:
    def wire(item: object) -> object:
        if type(item) in (tuple, list):
            return [wire(v) for v in cast(tuple[object, ...] | list[object], item)]
        if type(item) is dict:
            return {k: wire(v) for k, v in item.items()}
        return item

    return canonical_json_bytes(wire(value))


def digest(value: object) -> str:
    return sha256(encode(value)).hexdigest()


@dataclass(frozen=True, slots=True)
class SimulationPolicy:
    identity: Literal["ASTARTER_BTC_NATIVE_SIM_V1"] = "ASTARTER_BTC_NATIVE_SIM_V1"
    cap: str = "60120"
    stress: str = "58882"
    stop: str = "59000"
    fee: str = "0.001"
    step: str = "0.00001"
    quote_unit: str = "0.00000001"
    nominal_cap: str = "1000"
    max_request_risk: str = "25"
    lock_fraction: str = "0.2"
    stage: str = "1"
    account_multiplier: str = "1"
    snapshot_ttl_ns: int = 5_000_000_000
    protection_timeout_ns: int = 1_000_000_000
    caps: tuple[str, ...] = ("25", "500", "200", "100", "50", "60", "50")

    def profile(self) -> risk.CostProfile:
        return risk.CostProfile(
            risk.Pair("BTC", "USDT"),
            self.cap,
            self.stress,
            self.fee,
            self.fee,
            self.step,
            self.quote_unit,
        )


def policy_bytes(policy: SimulationPolicy) -> bytes:
    if (
        type(policy) is not SimulationPolicy
        or policy.identity != "ASTARTER_BTC_NATIVE_SIM_V1"
        or type(policy.caps) is not tuple
        or len(policy.caps) != 7
        or type(policy.snapshot_ttl_ns) is not int
        or not 0 < policy.snapshot_ttl_ns <= 5_000_000_000
        or type(policy.protection_timeout_ns) is not int
        or not 0 < policy.protection_timeout_ns <= 1_000_000_000
    ):
        raise ValueError("ASTARTER_POLICY_INVALID")
    risk.spot_costs(policy.profile(), "0")
    for value in policy.caps:
        amount(value)
    if (
        policy.step != "0.00001"
        or policy.quote_unit != "0.00000001"
        or policy.fee != "0.001"
        or amount(policy.stop) <= amount(policy.stress)
        or amount(policy.stop) >= amount(policy.cap)
        or not 0 < amount(policy.nominal_cap) <= 1000
        or not 0 < amount(policy.max_request_risk) <= 25
        or not 0 <= amount(policy.lock_fraction) <= 1
    ):
        raise ValueError("ASTARTER_POLICY_INVALID")
    risk.staged_risk(
        "USDT", "10000", "0.0025", "0.0025", "0.0025", policy.account_multiplier, policy.stage
    )
    return encode(asdict(policy))


@dataclass(frozen=True, slots=True)
class Opportunity:
    key: str
    created_at_ns: int
    expires_at_ns: int
    requested_risk: str = "5"


def validate_opportunity(
    opportunity: Opportunity, *, now_ns: int, policy: SimulationPolicy
) -> None:
    policy_bytes(policy)
    if (
        type(opportunity) is not Opportunity
        or type(opportunity.key) is not str
        or not 1 <= len(opportunity.key) <= 128
        or any(
            type(v) is not int or not 0 <= v < 2**63
            for v in (opportunity.created_at_ns, opportunity.expires_at_ns, now_ns)
        )
        or not 0 < opportunity.expires_at_ns - opportunity.created_at_ns <= 5_000_000_000
        or not 0 < amount(opportunity.requested_risk) <= amount(policy.max_request_risk)
    ):
        raise ValueError("ASTARTER_OPPORTUNITY_INVALID")
    if opportunity.created_at_ns > now_ns:
        raise AstarterBlocked("ASTARTER_OPPORTUNITY_FROM_FUTURE")
    if now_ns >= opportunity.expires_at_ns:
        raise AstarterBlocked("ASTARTER_OPPORTUNITY_EXPIRED")


@dataclass(frozen=True, slots=True)
class NativeOrder:
    order_id: str
    side: str
    order_type: str
    state: str
    quantity: str
    filled: str
    trigger_price: str | None
    accepted_at_ns: int | None
    limit_price: str | None = None
    state_time_ns: int | None = None


@dataclass(frozen=True, slots=True)
class NativeFill:
    order_id: str
    trade_id: str
    side: str
    quantity: str
    price: str
    fee: str
    currency: str
    time_ns: int


@dataclass(frozen=True, slots=True)
class NativeSnapshot:
    account_id: str
    venue_session: str
    sequence: int
    now_ns: int
    quote_time_ns: int
    bid: str
    ask: str
    quote_total: str
    quote_free: str
    base_total: str
    base_free: str
    position_quantity: str
    orders: tuple[NativeOrder, ...]
    fills: tuple[NativeFill, ...]
    cash_reconciled: bool
    seal: str = ""
    source_event_time_ns: int | None = None
    bid_size: str | None = None
    ask_size: str | None = None


@dataclass(frozen=True, slots=True)
class Reservation:
    intent_id: str
    account_id: str
    entry_order_id: str
    quantity: str
    cash_hold: str
    risk_reserved: str
    stress_loss: str
    cap: str
    stop: str
    epoch: int
    expires_at_ns: int
    scope: Literal["FINITE_NATIVE_SIMULATION"] = "FINITE_NATIVE_SIMULATION"
    execution_authorized: Literal[False] = False


@dataclass(frozen=True, slots=True)
class OrderCommand:
    order_id: str
    intent_id: str
    role: str
    quantity: str
    price: str | None


@dataclass(frozen=True, slots=True)
class OrderState:
    order_id: str
    intent_id: str
    role: str
    quantity: str
    native_state: str
    dispatch_state: str
    cancel_requested: bool
    accepted_at_ns: int | None
    deadline_ns: int | None


@dataclass(frozen=True, slots=True)
class Settlement:
    account_id: str
    economic_id: str
    applied: bool
    net_profit: str
    new_lock: str
    reserve: str
    profit_hwm: str
    gross_equity: str
    tradable_equity: str


@dataclass(frozen=True, slots=True)
class AccountRiskState:
    account_id: str
    epoch: int
    fence: int
    locks: tuple[str, ...]
    risk_period: str
    latest_sequence: int
    pending_risk: str
    inventory_risk: str
    cash_hold: str
    profit_hwm: str
    reserve: str
