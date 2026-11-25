"""Pure, offline Q03 adaptation. Only trusted host code may supply current context.

No object here is a grant, account reservation, native order or source authenticator.
Do not expose these constructors as a user/model authorization endpoint.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, fields
from fractions import Fraction as F
from typing import Annotated, Literal, Self

from pydantic import Field, StrictInt, model_validator

from stark_trading_os.domain.astarter_risk import (
    CostProfile,
    CostQuote,
    InvalidRiskInput,
    Pair,
    SizeCandidate,
    SizingLimits,
    size_spot,
)
from stark_trading_os.integrations.contracts import Identifier
from stark_trading_os.integrations.decimal_normalization import (
    CanonicalDecimal,
    DecimalValue,
    normalize_decimal_text,
)
from stark_trading_os.integrations.instrument_metadata import (
    Asset,
    Digest,
    Frozen,
    InstrumentFactsV1,
    InstrumentQuery,
    LotRules,
    MetadataInvalid,
    MetadataReceiptV1,
    MetadataResult,
    Nanoseconds,
    NotionalRules,
    PrecisionFact,
    PriceRules,
    RuleObservation,
    checked,
    digest,
)

type DynamicRule = Literal[
    "PERCENT_PRICE",
    "PERCENT_PRICE_BY_SIDE",
    "MAX_NUM_ORDERS",
    "MAX_POSITION",
    "EXCHANGE_MAX_NUM_ORDERS",
]
type Reason = Literal[
    "INVALID_INPUT",
    "SOURCE_POLICY_DENIED",
    "METADATA_EXPIRED",
    "BINDING_MISMATCH",
    "FILTER_UNSUPPORTED",
    "REQUIRED_FILTER_MISSING",
    "SYMBOL_NOT_TRADING",
    "ORDER_SCOPE_UNSUPPORTED",
    "TARGET_ASSET_UNSUPPORTED",
    "PRICE_GRID_INVALID",
    "STATIC_LIMIT_FAILED",
    "ASSUMPTION_MISMATCH",
    "INPUT_EXPIRED",
    "CANDIDATE_MISMATCH",
    "NO_RISK_BUDGET",
    "BELOW_MIN_ORDER",
]
_REASONS = {
    "INVALID_INPUT",
    "SOURCE_POLICY_DENIED",
    "METADATA_EXPIRED",
    "BINDING_MISMATCH",
    "FILTER_UNSUPPORTED",
    "REQUIRED_FILTER_MISSING",
    "SYMBOL_NOT_TRADING",
    "ORDER_SCOPE_UNSUPPORTED",
    "TARGET_ASSET_UNSUPPORTED",
    "PRICE_GRID_INVALID",
    "STATIC_LIMIT_FAILED",
    "ASSUMPTION_MISMATCH",
    "INPUT_EXPIRED",
    "CANDIDATE_MISMATCH",
    "NO_RISK_BUDGET",
    "BELOW_MIN_ORDER",
}


class SourcePolicyRef(Frozen):
    """Trusted fixture policy reference, not a transferable permission token."""

    policy_id: Identifier
    revision: Identifier
    purpose: Literal["OFFLINE_FIXTURE"] = "OFFLINE_FIXTURE"
    capability_id: Literal["binance.spot.instrument"] = "binance.spot.instrument"


class SimulationAssumptionsV1(Frozen):
    profile_id: Identifier
    revision: Identifier
    base: Asset
    quote: Asset
    buy_fee: CanonicalDecimal
    sell_fee: CanonicalDecimal
    quote_unit: CanonicalDecimal
    fee_currency: Literal["QUOTE"]
    fee_model: Literal["RC04_QUOTE_BOUND_V1"]
    fill_bound_policy: Literal["MIN_NONZERO_FILL_AT_LEAST_STEP"]
    provenance: Literal["SIM_ASSUMPTION"]
    valid_from_ns: Nanoseconds
    valid_until_ns: Nanoseconds
    unmodeled_constraints: Annotated[tuple[DynamicRule, ...], Field(max_length=5)]

    @model_validator(mode="after")
    def consistent(self) -> Self:
        normalize_decimal_text(self.buy_fee, domain="rate")
        normalize_decimal_text(self.sell_fee, domain="rate")
        normalize_decimal_text(self.quote_unit, domain="positive")
        if (
            self.base == self.quote
            or self.valid_from_ns >= self.valid_until_ns
            or len(set(self.unmodeled_constraints)) != len(self.unmodeled_constraints)
        ):
            raise MetadataInvalid
        return self


class SimulationPlan(Frozen):
    plan_id: Identifier
    revision: Identifier
    instrument: InstrumentQuery
    cap: CanonicalDecimal
    stress_exit: CanonicalDecimal
    valid_from_ns: Nanoseconds
    valid_until_ns: Nanoseconds
    signal_id: Identifier
    parameters_sha256: Digest
    bar_source_revision: Identifier
    signal_expires_at_ns: Nanoseconds
    side: Literal["BUY"] = "BUY"
    order_type: Literal["LIMIT"] = "LIMIT"
    time_in_force: Literal["IOC"] = "IOC"
    scope: Literal["SIM_ASSUMPTION"] = "SIM_ASSUMPTION"

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if not 0 < F(self.stress_exit) < F(self.cap) or self.valid_from_ns >= min(
            self.valid_until_ns, self.signal_expires_at_ns
        ):
            raise MetadataInvalid
        return self


class AccountView(Frozen):
    account_id: Identifier
    snapshot_id: Identifier
    risk_epoch: Annotated[StrictInt, Field(ge=0, le=2**64 - 1)]
    base: Asset
    quote: Asset
    risk_budget: CanonicalDecimal = Field(repr=False)
    notional_cap: CanonicalDecimal = Field(repr=False)
    available_quote: CanonicalDecimal = Field(repr=False)
    available_at_ns: Nanoseconds
    valid_until_ns: Nanoseconds
    scope: Literal["SIM_ASSUMPTION"] = "SIM_ASSUMPTION"

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.base == self.quote or self.available_at_ns >= self.valid_until_ns:
            raise MetadataInvalid
        return self


class InputBinding(Frozen):
    instrument: InstrumentQuery
    metadata_revision: Digest
    receipt_id: Identifier
    receipt_sha256: Digest
    plan_sha256: Digest
    assumptions_sha256: Digest
    account_sha256: Digest = Field(repr=False)


class SimulationContext(Frozen):
    """Host-owned current snapshot. None policy means revoked/not supplied.

    Matching IDs prove only consistency. The host owns sourcing these values and
    must repeat account/data/news/activation/expiry checks at atomic reservation.
    """

    decision_time_ns: Nanoseconds
    expected_binding: InputBinding
    source_policy: SourcePolicyRef | None
    mode: Literal["OFFLINE_FIXTURE"] = "OFFLINE_FIXTURE"


def bind_inputs(
    metadata: MetadataResult,
    plan: SimulationPlan,
    assumptions: SimulationAssumptionsV1,
    account: AccountView,
) -> InputBinding:
    try:
        result = _bind_inputs(metadata, plan, assumptions, account)
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        pass
    else:
        return result
    # Raise after leaving the handler: no retained ValidationError/input_value
    # in __context__, as well as no visible exception chain.
    raise MetadataInvalid from None


def _bind_inputs(
    metadata: MetadataResult,
    plan: SimulationPlan,
    assumptions: SimulationAssumptionsV1,
    account: AccountView,
) -> InputBinding:
    for value in (metadata, plan, assumptions, account):
        _shape(value)
    metadata = checked(MetadataResult, metadata)
    plan = checked(SimulationPlan, plan)
    assumptions = checked(SimulationAssumptionsV1, assumptions)
    account = checked(AccountView, account)
    if metadata.receipt is None or metadata.facts is None:
        raise MetadataInvalid
    return InputBinding(
        instrument=metadata.query,
        metadata_revision=metadata.facts.revision(),
        receipt_id=metadata.receipt.receipt_id,
        receipt_sha256=digest(metadata.receipt.model_dump(mode="json")),
        plan_sha256=digest(plan.model_dump(mode="json")),
        assumptions_sha256=digest(assumptions.model_dump(mode="json")),
        account_sha256=digest(account.model_dump(mode="json")),
    )


@dataclass(frozen=True, slots=True)
class PreparedQ03Inputs:
    metadata: MetadataResult
    plan: SimulationPlan
    assumptions: SimulationAssumptionsV1
    account: AccountView = field(repr=False)
    binding: InputBinding
    profile: CostProfile
    limits: SizingLimits = field(repr=False)
    valid_until_ns: int
    unchecked_constraints: tuple[str, ...]
    scope: Literal["SIMULATION_INPUT_ONLY"] = field(default="SIMULATION_INPUT_ONLY", init=False)
    execution_authorized: Literal[False] = field(default=False, init=False)


@dataclass(frozen=True, slots=True)
class PrepareResult:
    status: Literal["PREPARED", "REJECTED"]
    prepared: PreparedQ03Inputs | None = field(default=None, repr=False)
    reason: Reason | None = None

    def __post_init__(self) -> None:
        if not (
            (
                self.status == "PREPARED"
                and type(self.prepared) is PreparedQ03Inputs
                and self.reason is None
            )
            or (self.status == "REJECTED" and self.prepared is None and self.reason in _REASONS)
        ):
            raise MetadataInvalid


@dataclass(frozen=True, slots=True)
class CandidateCheck:
    status: Literal["CANDIDATE", "NO_CANDIDATE", "REJECTED"]
    candidate: SizeCandidate | None = field(default=None, repr=False)
    reason: Reason | None = None
    unchecked_constraints: tuple[str, ...] = ()
    scope: Literal["STATIC_LIMIT_IOC_SIMULATION_ONLY"] = field(
        default="STATIC_LIMIT_IOC_SIMULATION_ONLY", init=False
    )
    venue_admissibility: Literal["UNVERIFIED"] = field(default="UNVERIFIED", init=False)
    execution_authorized: Literal[False] = field(default=False, init=False)

    def __post_init__(self) -> None:
        if not (
            (
                self.status == "CANDIDATE"
                and type(self.candidate) is SizeCandidate
                and self.candidate.reason == "CANDIDATE_ONLY"
                and type(self.candidate.costs) is CostQuote
                and self.reason is None
            )
            or (
                self.status in {"NO_CANDIDATE", "REJECTED"}
                and self.candidate is None
                and self.reason in _REASONS
            )
        ):
            raise MetadataInvalid


_MODEL_TYPES = (
    DecimalValue,
    InstrumentQuery,
    PriceRules,
    LotRules,
    NotionalRules,
    RuleObservation,
    PrecisionFact,
    InstrumentFactsV1,
    MetadataReceiptV1,
    MetadataResult,
    SourcePolicyRef,
    SimulationAssumptionsV1,
    SimulationPlan,
    AccountView,
    InputBinding,
    SimulationContext,
)
_DATACLASS_TYPES = (PreparedQ03Inputs, CostProfile, SizingLimits, Pair, SizeCandidate, CostQuote)


def _shape(value: object) -> object:
    """Exact closed-schema snapshot, without user equality/serialization/numeric hooks.

    Tags distinguish bool/int and reject subclasses before touching their fields.
    Only builtin scalars/tuples appear in the returned comparison value. This is
    an input boundary, not a sandbox against modification of trusted Python code.
    """
    kind = type(value)
    if value is None:
        return ("none",)
    if any(kind is scalar for scalar in (str, int, bool, float)):
        return (kind.__name__, value)
    if type(value) is tuple:
        return ("tuple", tuple(_shape(item) for item in value))
    for model in _MODEL_TYPES:
        if kind is model:
            data = object.__getattribute__(value, "__dict__")
            if (
                type(data) is not dict
                or any(type(key) is not str for key in data)
                or set(data) != set(model.model_fields)
                or object.__getattribute__(value, "__pydantic_extra__") is not None
            ):
                raise MetadataInvalid
            return (
                model.__name__,
                tuple((name, _shape(data[name])) for name in model.model_fields),
            )
    for dataclass_type in _DATACLASS_TYPES:
        if kind is dataclass_type:
            return (
                dataclass_type.__name__,
                tuple(
                    (f.name, _shape(object.__getattribute__(value, f.name)))
                    for f in fields(dataclass_type)
                ),
            )
    raise MetadataInvalid


def _reject(reason: Reason) -> PrepareResult:
    return PrepareResult(status="REJECTED", reason=reason)


def prepare_q03_inputs(
    metadata: MetadataResult,
    plan: SimulationPlan,
    assumptions: SimulationAssumptionsV1,
    account: AccountView,
    context: SimulationContext,
) -> PrepareResult:
    try:
        for value in (metadata, plan, assumptions, account, context):
            _shape(value)
        metadata = checked(MetadataResult, metadata)
        plan = checked(SimulationPlan, plan)
        assumptions = checked(SimulationAssumptionsV1, assumptions)
        account = checked(AccountView, account)
        context = checked(SimulationContext, context)
        return _prepare(metadata, plan, assumptions, account, context)
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        return _reject("INVALID_INPUT")


def _prepare(
    metadata: MetadataResult,
    plan: SimulationPlan,
    assumptions: SimulationAssumptionsV1,
    account: AccountView,
    context: SimulationContext,
) -> PrepareResult:
    r, facts, now = metadata.receipt, metadata.facts, context.decision_time_ns
    if metadata.status == "STALE":
        return _reject("METADATA_EXPIRED")
    if metadata.status != "OK" or r is None or facts is None:
        return _reject("INVALID_INPUT")
    if not r.usable_at(now):
        return _reject("METADATA_EXPIRED")
    policy = context.source_policy
    if (
        policy is None
        or policy.policy_id == "offline-unregistered"
        or (policy.policy_id, policy.revision, policy.purpose, policy.capability_id)
        != (r.source_policy_id, r.source_policy_revision, r.purpose, r.capability_id)
    ):
        return _reject("SOURCE_POLICY_DENIED")
    binding = bind_inputs(metadata, plan, assumptions, account)
    if binding != context.expected_binding or plan.instrument != metadata.query:
        return _reject("BINDING_MISMATCH")
    q = metadata.query
    if any(
        re.fullmatch(r"[A-Z][A-Z0-9_]{0,15}", a) is None
        for a in (q.expected_base, q.expected_quote)
    ):
        return _reject("TARGET_ASSET_UNSUPPORTED")
    if (q.venue, q.market, q.symbol, q.expected_base, q.expected_quote) != (
        "BINANCE",
        "SPOT",
        "BTCUSDT",
        "BTC",
        "USDT",
    ):
        return _reject("ORDER_SCOPE_UNSUPPORTED")
    if (assumptions.base, assumptions.quote) != (q.expected_base, q.expected_quote) or (
        account.base,
        account.quote,
    ) != (q.expected_base, q.expected_quote):
        return _reject("ASSUMPTION_MISMATCH")
    expiry = min(
        r.expires_at_ns,
        plan.valid_until_ns,
        plan.signal_expires_at_ns,
        assumptions.valid_until_ns,
        account.valid_until_ns,
    )
    if (
        not max(plan.valid_from_ns, assumptions.valid_from_ns, account.available_at_ns)
        <= now
        < expiry
    ):
        return _reject("INPUT_EXPIRED")
    if facts.trading_status != "TRADING" or not facts.spot_allowed:
        return _reject("SYMBOL_NOT_TRADING")
    if "LIMIT" not in facts.order_types:
        return _reject("ORDER_SCOPE_UNSUPPORTED")
    if facts.unsupported:
        return _reject("FILTER_UNSUPPORTED")
    dynamic = tuple(sorted(r.kind for r in facts.rules if r.category == "DYNAMIC"))
    if not set(dynamic).issubset(assumptions.unmodeled_constraints):
        return _reject("FILTER_UNSUPPORTED")
    price, lot = facts.price, facts.lot
    if price is None or lot is None or not facts.notionals:
        return _reject("REQUIRED_FILTER_MISSING")
    if not (price.tick.exact() > 0 and lot.step.exact() > 0 and lot.minimum.exact() > 0):
        return _reject("FILTER_UNSUPPORTED")
    cap = F(plan.cap)
    if (
        cap % price.tick.exact()
        or (price.minimum.exact() and cap < price.minimum.exact())
        or (price.maximum.exact() and cap > price.maximum.exact())
    ):
        return _reject("PRICE_GRID_INVALID")
    pair = Pair(q.expected_base, q.expected_quote)
    profile = CostProfile(
        pair,
        plan.cap,
        plan.stress_exit,
        assumptions.buy_fee,
        assumptions.sell_fee,
        lot.step.canonical,
        assumptions.quote_unit,
    )
    minimum = max(facts.notionals, key=lambda f: f.minimum.exact()).minimum.canonical
    limits = SizingLimits(
        pair,
        account.risk_budget,
        account.notional_cap,
        account.available_quote,
        lot.minimum.canonical,
        minimum,
    )
    return PrepareResult(
        status="PREPARED",
        prepared=PreparedQ03Inputs(
            metadata,
            plan,
            assumptions,
            account,
            binding,
            profile,
            limits,
            expiry,
            dynamic + ("ACCOUNT_PERMISSION", "VENUE_ADMISSIBILITY", "NATIVE_EXECUTION"),
        ),
    )


def _same_candidate(actual: SizeCandidate, expected: SizeCandidate) -> bool:
    return _shape(actual) == _shape(expected)


def check_q03_candidate(
    prepared: PreparedQ03Inputs, candidate: SizeCandidate, context: SimulationContext
) -> CandidateCheck:
    try:
        if type(prepared) is not PreparedQ03Inputs:
            raise MetadataInvalid
        original_shape = _shape(prepared)
        current = prepare_q03_inputs(
            prepared.metadata, prepared.plan, prepared.assumptions, prepared.account, context
        )
        if current.status != "PREPARED":
            return CandidateCheck(status="REJECTED", reason=current.reason)
        canonical = current.prepared
        assert canonical is not None
        if _shape(canonical) != original_shape:
            return CandidateCheck(status="REJECTED", reason="CANDIDATE_MISMATCH")
        expected = size_spot(canonical.profile, canonical.limits)
        if not _same_candidate(candidate, expected):
            return CandidateCheck(status="REJECTED", reason="CANDIDATE_MISMATCH")
        if expected.costs is None:
            reason: Reason = (
                "NO_RISK_BUDGET" if expected.reason == "NO_RISK_BUDGET" else "BELOW_MIN_ORDER"
            )
            return CandidateCheck(status="NO_CANDIDATE", reason=reason)
        facts = canonical.metadata.facts
        assert facts is not None and facts.lot is not None
        quantity = F(expected.costs.quantity)
        nominal = F(canonical.profile.cap) * quantity
        if (
            quantity % facts.lot.step.exact()
            or quantity < facts.lot.minimum.exact()
            or quantity > facts.lot.maximum.exact()
            or any(
                nominal < f.minimum.exact()
                or (f.maximum is not None and nominal > f.maximum.exact())
                for f in facts.notionals
            )
        ):
            return CandidateCheck(status="REJECTED", reason="STATIC_LIMIT_FAILED")
        return CandidateCheck(
            status="CANDIDATE",
            candidate=expected,
            unchecked_constraints=canonical.unchecked_constraints,
        )
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError, InvalidRiskInput):
        return CandidateCheck(status="REJECTED", reason="INVALID_INPUT")
