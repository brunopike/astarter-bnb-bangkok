"""Q01-C versioned CONTRACT_PREFLIGHT only; hashes are not trusted signatures.

No I/O, clocks, issuer, ledger, execution adapter or runtime registration. Public
functions snapshot exact DTO trees using the existing research boundary before
examining them. Synthetic references can establish offline compatibility only.
"""

from __future__ import annotations

from typing import Annotated, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator

from stark_trading_os.domain.s03_signal import STRATEGY_VERSION, Number, S03Parameters
from stark_trading_os.integrations.contracts import Identifier, RoleId, Timestamp
from stark_trading_os.integrations.research_egress import (
    Atoms,
    Closed,
    Digest,
    canonical,
    digest_text,
    encode,
)

Revision = Annotated[StrictStr, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$")]
Names = Annotated[tuple[Identifier, ...], Field(max_length=32)]
SOURCE_SHA256: Final = "976970573ca0ac333656ae800c1129430901d402ee80980637a8e6994c170742"
ROLE_VERSION: Final = "Q01_S03_NINE_DUTIES_REF_V1"
S03_DUTIES = ("A01", "A02", "A07", "A10", "A12", "A14", "A15", "A16", "A13")
VP_VERSION = "s02-virtual-probe-limited-basket@research-v0.1"
COMPOSITION_VERSION = "q01-c-s03-astarter@v1"
# One frozen offline correspondence, not a live instrument registry or ID parser.
# venue, product, opaque reference ID, normalized base/quote[, settlement].
_RX05_SPOT_REFERENCE = ("BINANCE", "SPOT", "BTCUSDT", "BTC", "USDT")
_RX05_PERP_REFERENCE = ("BINANCE", "PERP", "BTCUSDT-PERP", "BTC", "USDT", "USDT")
# Immutable pins, not an approved runtime registry. No research file is read.
# id, all-defaults digest, execution base/product, additional required data.
_PROFILES = (
    ("S00", "019b256036c376fc912937bbea63ce4e16c4f5a083a4cdaca1cbe8f31a8fa8a8",
     "BTC", "SPOT", "POINT_IN_TIME_SCORES"),
    ("S01", "0d86832f57226d3304035a84decb52ff925a11fc152b2f4f414021f80088fad1",
     "BTC", "SPOT", "RANGE_BARS"),
    ("S02", "5f9e7674b6ae12ca99d2afb1e2ffd01eca7c6a3e6238de406bb2c6512c262b35",
     "BTC", "SPOT", "BASKET_BARS"),
    ("S03", "091572a399ddfb425e92c65853da289176ca902e8356d8808eae7be80898f5a6",
     "BTC", "SPOT", "S03_CONTINUOUS_BARS"),
    ("S04", "d5a2fabcf2645cd5a59da88b288164a3c004c6fa218ff506c24d7cdcf96ca3d8",
     "BTC", "SPOT", "CONFIRMED_PIVOTS"),
    ("S05", "5463ca17105f42c6cfc2fc895f57885fe632fe568345cf03cfd0ccf319f75c2c",
     "BTC", "SPOT", "ORDERED_L2_TRADES"),
    ("S06", "bac9ed5e08ab40c46e46a17c4892ee779beedd2b15dc1f60af3f983e583e151d",
     "BTC", "SPOT", "CONFIRMED_WAVES"),
    ("S07", "83ccd913f23f5205132e31aa804e265a30ce5a8f4417bc89face0ee1048d4e54",
     "BTC", "SPOT", "SPRING_TEST_BARS"),
    ("S08", "07307a8d87e233d4934c71ea31430b41217aea0c2ad7b3740c09ecd6ea69a7ad",
     "BTC", "SPOT", "INSIDE_BAR_STRUCTURE"),
    ("S09-A", "765d24c8a74e0070accf26a5407a96a5cdb9279e47a18059dd1f1b71a4cb3678",
     "WETH", "CHAIN", "REGISTERED_ATOMIC_POOLS"),
    ("S09-L", "a538e676a57b276dfdabdabefa3341d5dd8e3803b4fc991cc256b2c45eac7cd6",
     "WETH", "LP", "REGISTERED_CLMM_POSITION"),
    ("RX01", "fce24f2dd2e2547a1f70d6512582fccad158a989b68aab9b1daa799f678b2ed3",
     "BTC", "SPOT", "OFFICIAL_RELEASE_CALENDAR"),
    ("RX02-P", "1be91f458b8c0e2403aab98b8e01798b34f1fdd2913499caec5e1b549c396539",
     "ETH", "SPOT", "ORIGINAL_POSTS_HISTORY"),
    ("RX02-A", "bb5aaf93b5acd1a368455a973b5593e05f34fa997cf26aaff1bad8e2b2b2b723",
     "ETH", "SPOT", "AGGREGATE_ATTENTION_HISTORY"),
    ("RX03-S", "5f196b7889fbfce10d0dd0143db3fc8daa5ef8953af934c19badb41a1bb2b391",
     "ETH", "SPOT", "FINALIZED_REGISTERED_POOL_FLOW"),
    ("RX03-B", "1515c875fcf912f8d41dca5ee2ebbf2b0443e6d77437d0957778d9e59c5b8616",
     "BTC", "SPOT", "NATIVE_BTC_ENTITY_HISTORY"),
    ("RX04", "200a5048b11470d4d9697354063e275f4f97951583c013fd8a2ec0748e82ce22",
     "ARB", "SPOT", "UNLOCK_REGISTRY_INVENTORY"),
    ("RX05", "1307092faf4909686c13c5e2cf2f769ac709b31fa9e5f0c67a9e413665c8d576",
     "BTC", "SPOT", "SAME_VENUE_PERP_AND_SPOT"),
    ("S02-VP", "f4bed725591e460ae023ef3f09b0307f9acd4040976897898cf552db750b675f",
     "BTC", "SPOT", "VIRTUAL_PHYSICAL_LAYER_BARS"),
)


class Offline(Closed):
    model_config = ConfigDict(strict=True, validate_default=True)
    scope: Literal["CONTRACT_PREFLIGHT"] = "CONTRACT_PREFLIGHT"
    purpose: Literal["OFFLINE_FIXTURE"] = "OFFLINE_FIXTURE"
    execution_authorized: StrictBool = False

    @model_validator(mode="before")
    @classmethod
    def exact_literals(cls, value: object) -> object:
        # Pydantic Literal[False]/Literal[0] otherwise accepts equal int/bool values.
        if type(value) is dict:
            for name in (
                "risk_release_allowed", "preserve_protection",
                "allow_exit_reconciliation_checks", "automatic_charged_retry_allowed",
            ):
                if name in value and type(value[name]) is not bool:
                    raise ValueError("STRICT_BOOLEAN_REQUIRED")
            for name in ("research_call_budget", "fast_path_llm_calls"):
                if name in value and type(value[name]) is not int:
                    raise ValueError("STRICT_INTEGER_REQUIRED")
        return value

    @model_validator(mode="after")
    def no_authority(self) -> Self:
        if self.execution_authorized:
            raise ValueError("NO_EXECUTION_AUTHORITY")
        return self


class StrategyIdentity(Offline):
    strategy_id: Identifier
    kind: Literal["SMA_LEGACY_REF", "S03_ORIGINAL", "ASTARTER_COMPOSITION", "RESEARCH", "VP"]
    version: Revision

    @model_validator(mode="after")
    def known(self) -> Self:
        if self.strategy_id == "SMA":
            expected = ("SMA_LEGACY_REF", "sma-cross-long-flat@v1")
        elif self.strategy_id == "S03" and self.kind == "ASTARTER_COMPOSITION":
            expected = ("ASTARTER_COMPOSITION", COMPOSITION_VERSION)
        elif self.strategy_id == "S03":
            expected = ("S03_ORIGINAL", STRATEGY_VERSION)
        elif self.strategy_id == "S02-VP":
            expected = ("VP", VP_VERSION)
        elif self.strategy_id in tuple(row[0] for row in _PROFILES):
            expected = ("RESEARCH", "research-v0.1")
        else:
            raise ValueError("UNKNOWN_STRATEGY")
        if (self.kind, self.version) != expected:
            raise ValueError("UNKNOWN_STRATEGY_VERSION_OR_KIND")
        return self


class CatalogProfile(Offline):
    strategy_id: Identifier
    revision: Literal["Q01_C_PROFILE_V1"] = "Q01_C_PROFILE_V1"
    source_revision: Literal["design-registry-v0.2"] = "design-registry-v0.2"
    source_sha256: Digest = SOURCE_SHA256
    defaults_sha256: Digest
    base: Identifier
    product: Literal["SPOT", "CHAIN", "LP"]
    required_data: Names
    required_capabilities: Names


def catalog_profile(strategy_id: str) -> CatalogProfile:
    if type(strategy_id) is not str:
        raise ValueError("UNKNOWN_STRATEGY")
    for sid, sha, base, product, data in _PROFILES:
        if sid != strategy_id:
            continue
        capabilities: tuple[str, ...] = (
            "LIMIT_IOC", "SELL_STOP_MARKET_GTC_BID_ASK", "SELL_MARKET_IOC"
        )
        if sid == "S01":
            capabilities += ("LIMIT_GTC_POST_ONLY",)
        if product == "CHAIN":
            capabilities = ("ATOMIC_ROUTE", "NONCE_RECEIPT_RECONCILIATION")
        if product == "LP":
            capabilities = ("CLMM_POSITION", "WITHDRAW_RESIDUAL_INVENTORY")
        return CatalogProfile.model_validate({
            "strategy_id": sid, "defaults_sha256": sha, "base": base,
            "product": product, "required_data": ("MARKET_WINDOW", "NEWS_HEALTH", data),
            "required_capabilities": capabilities,
        })
    raise ValueError("UNKNOWN_STRATEGY")


class ABCReference(Offline):
    """Read-only source references, not an implementation of ABC branches."""

    identity: StrategyIdentity
    revision: Literal["Q01_ABC_SOURCE_REF_V1"] = "Q01_ABC_SOURCE_REF_V1"
    source_sha256: Literal[
        "976970573ca0ac333656ae800c1129430901d402ee80980637a8e6994c170742"
    ] = SOURCE_SHA256
    a: Literal["ENTRY_GATES_REQUIRED"] = "ENTRY_GATES_REQUIRED"
    b: Literal["STRATEGY_EXIT_SOURCE_RULES"] = "STRATEGY_EXIT_SOURCE_RULES"
    c: Literal["PAUSE_NEW_RISK_NOT_PROTECTION_OR_RECONCILIATION"] = (
        "PAUSE_NEW_RISK_NOT_PROTECTION_OR_RECONCILIATION"
    )


class StrategySpec(Offline):
    identity: StrategyIdentity
    profile: CatalogProfile
    parameter_revision: Identifier
    abc: ABCReference
    parameters: S03Parameters | None = None
    frozen_defaults_json: Annotated[StrictStr, Field(max_length=16384)] | None = None

    @model_validator(mode="after")
    def frozen_profile(self) -> Self:
        expected = catalog_profile(self.identity.strategy_id)
        if self.profile != expected or self.abc.identity != self.identity:
            raise ValueError("PROFILE_OR_ABC_MISMATCH")
        if self.identity.strategy_id == "S03":
            if self.parameters is None or self.frozen_defaults_json is not None:
                raise ValueError("S03_PARAMETERS_REQUIRED")
        elif (self.parameters is not None or self.frozen_defaults_json is None
              or digest_text(self.frozen_defaults_json) != expected.defaults_sha256):
            raise ValueError("FROZEN_PROFILE_PARAMETERS_ONLY")
        return self


class PrivateBinding(Offline):
    visibility: Literal["PRIVATE"] = "PRIVATE"
    tenant_id: Identifier
    account_id: Identifier
    environment: Literal["OFFLINE", "PAPER", "LIVE"]


class InstrumentProfile(Offline):
    profile_id: Identifier
    revision: Identifier
    native_id: Identifier
    venue: Identifier
    base: Identifier
    quote: Identifier
    product: Literal["SPOT", "PERP", "CHAIN", "LP"]
    chain: Identifier | None = None
    pool: Identifier | None = None
    fee_currency: Identifier | None = None
    fee_revision: Identifier
    tick: Number | None = None
    step: Number | None = None
    # Q03 SizingLimits semantics: base quantity and quote notional, never interchangeable.
    min_quantity: Number | None = None
    min_notional: Number | None = None
    multiplier: Number | None = None
    maker_fee: Number | None = None
    taker_fee: Number | None = None

    @model_validator(mode="after")
    def units(self) -> Self:
        if self.base == self.quote:
            raise ValueError("DISTINCT_ASSETS_REQUIRED")
        if self.product in {"SPOT", "PERP"} and (self.chain is not None or self.pool is not None):
            raise ValueError("CHAIN_IDENTITY_NOT_CEX")
        if any(value == "0" for value in (
            self.tick, self.step, self.multiplier, self.min_quantity
        )):
            raise ValueError("POSITIVE_PRECISION_REQUIRED")
        return self


class PlanRevision(Offline):
    plan_id: Identifier
    revision: Identifier
    spec: StrategySpec
    binding: PrivateBinding
    instrument: InstrumentProfile | None
    data_profile_revision: Identifier
    capability_profile_revision: Identifier
    risk_policy_revision: Identifier
    evidence_sha256s: Annotated[tuple[Digest, ...], Field(max_length=32)] = ()
    role_schema_revision: Literal["Q01_S03_NINE_DUTIES_REF_V1"] = ROLE_VERSION
    starts_at_ms: Timestamp
    expires_at_ms: Timestamp

    @model_validator(mode="after")
    def interval(self) -> Self:
        if self.starts_at_ms >= self.expires_at_ms:
            raise ValueError("EMPTY_PLAN_WINDOW")
        return self


class EvidenceSnapshot(Offline):
    """References only. BACKEND_REFERENCE_UNVERIFIED cannot satisfy preflight."""

    evidence_id: Identifier
    kind: Literal["DATA", "CAPABILITY", "FEES", "REVIEW"]
    name: Identifier
    profile_revision: Identifier
    subject_sha256: Digest
    content_sha256: Digest
    origin: Literal["SYNTHETIC_REFERENCE", "BACKEND_REFERENCE_UNVERIFIED"]
    status: Literal["PASS", "BLOCK", "UNKNOWN"]
    source_id: Identifier
    source_revision: Identifier
    source_product: Literal["SPOT", "PERP", "CHAIN", "LP"]
    source_instrument_id: Identifier
    source_venue: Identifier
    source_chain: Identifier | None = None
    # Required for the frozen RX05 PERP/spot correspondence, not for chain sources.
    source_base: Identifier | None = None
    source_quote: Identifier | None = None
    source_settlement: Identifier | None = None
    coverage: Literal["COMPLETE_REFERENCE", "INCOMPLETE", "UNKNOWN"]
    rights_revision: Identifier
    use_allowed: StrictBool
    share_allowed: StrictBool
    classification: Literal["PUBLIC", "PRIVATE"]
    funding: Literal["PLATFORM", "BYOK"]
    binding: PrivateBinding | None
    window_start_ms: Timestamp
    window_end_ms: Timestamp
    event_at_ms: Timestamp
    available_at_ms: Timestamp
    received_at_ms: Timestamp
    expires_at_ms: Timestamp
    rights_until_ms: Timestamp
    max_age_ms: Annotated[StrictInt, Field(gt=0, le=86400000)]

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if not (self.window_start_ms < self.window_end_ms <= self.event_at_ms
                <= self.available_at_ms <= self.received_at_ms < self.expires_at_ms):
            raise ValueError("INVALID_SOURCE_WINDOW")
        if self.classification == "PUBLIC":
            if self.binding is not None or self.funding == "BYOK" or not self.share_allowed:
                raise ValueError("PRIVATE_EVIDENCE_NOT_PUBLIC")
        elif self.binding is None or self.share_allowed:
            raise ValueError("PRIVATE_BINDING_REQUIRED")
        return self


class DutyEvidence(Offline):
    role: RoleId
    role_semantics_revision: Literal["Q01_S03_NINE_DUTIES_REF_V1"] = ROLE_VERSION
    method: Literal["SIMULATED_PRIVATE_REVIEW_REF"]
    source: EvidenceSnapshot


class ApprovalSnapshot(Offline):
    """An approval *reference*, never a seal, signature, grant or activation."""

    reference_id: Identifier
    issuer_reference: Identifier
    plan_revision: Identifier
    plan_sha256: Digest
    binding: PrivateBinding
    risk_policy_revision: Identifier
    role_schema_revision: Literal["Q01_S03_NINE_DUTIES_REF_V1"] = ROLE_VERSION
    starts_at_ms: Timestamp
    expires_at_ms: Timestamp
    duties: Annotated[tuple[DutyEvidence, ...], Field(max_length=18)]
    research_call_budget: Literal[0, 6, 8, 12]

    @model_validator(mode="after")
    def no_call_count_coverage(self) -> Self:
        if type(self.research_call_budget) is not int:
            raise ValueError("INTEGER_CALL_BUDGET_REQUIRED")
        if self.starts_at_ms >= self.expires_at_ms:
            raise ValueError("EMPTY_APPROVAL_WINDOW")
        if len({d.role for d in self.duties}) != len(self.duties):
            raise ValueError("DUPLICATE_DUTY")
        return self


class PreflightInput(Offline):
    plan: PlanRevision
    evidence: Annotated[tuple[EvidenceSnapshot, ...], Field(max_length=32)] = ()
    approval: ApprovalSnapshot | None = None

    @model_validator(mode="after")
    def unique(self) -> Self:
        keys = tuple((e.kind, e.name) for e in self.evidence)
        if len(set(keys)) != len(keys):
            raise ValueError("DUPLICATE_EVIDENCE_SLOT")
        if len({e.evidence_id for e in self.evidence}) != len(self.evidence):
            raise ValueError("DUPLICATE_EVIDENCE_ID")
        return self


class Decision(Offline):
    status: Literal["ELIGIBLE", "RESEARCH_ONLY", "BLOCKED"]
    reasons: Names
    missing_capabilities: Names = ()
    missing_roles: Annotated[tuple[RoleId, ...], Field(max_length=18)] = ()
    fast_path_llm_calls: Literal[0] = 0
    risk_release_allowed: Literal[False] = False


class StateSnapshot(Offline):
    lifecycle: Literal[
        "DRAFT", "PREFLIGHT", "REVIEWED_REFERENCE", "ACTIVE_REFERENCE", "PAUSED", "EXPIRED"
    ]
    order: Literal["NONE", "PENDING", "ACK", "PARTIAL", "FILLED", "CANCELLED", "UNKNOWN"]
    protection: Literal[
        "NOT_REQUIRED", "PENDING", "SUFFICIENT_REFERENCE", "INSUFFICIENT", "UNKNOWN"
    ]
    reconciliation: Literal["NOT_STARTED", "PENDING", "MATCHED_REFERENCE", "MISMATCH", "UNKNOWN"]


class StatePolicy(Offline):
    new_risk_blocked: StrictBool
    risk_release_allowed: Literal[False] = False
    preserve_protection: Literal[True] = True
    allow_exit_reconciliation_checks: Literal[True] = True


class SimBudget(Offline):
    unit: Literal["SIM_MODEL_CREDIT_V1"] = "SIM_MODEL_CREDIT_V1"
    scale: Annotated[StrictInt, Field(ge=6, le=6)] = 6
    atoms: Atoms


class SupplierBudget(Offline):
    version: Literal["Q01_SUPPLIER_METER_ATOMS_V1"] = "Q01_SUPPLIER_METER_ATOMS_V1"
    unit: Literal["USD", "points", "CU"]
    provider: Identifier
    meter: Identifier
    meter_revision: Identifier
    scale: Annotated[StrictInt, Field(ge=0, le=18)]
    cost_atoms: Atoms | None
    liability: Literal["UNKNOWN_PENDING_RECONCILE", "OBSERVED_REFERENCE"]

    @model_validator(mode="after")
    def unknown_not_zero(self) -> Self:
        if (self.cost_atoms is None) != (self.liability == "UNKNOWN_PENDING_RECONCILE"):
            raise ValueError("UNKNOWN_COST_MUST_REMAIN_UNKNOWN")
        return self


class CustomerBudget(Offline):
    unit: Literal["ASTARTER_CREDITS"] = "ASTARTER_CREDITS"
    version: Literal["Q01_CUSTOMER_CREDIT_ATOMS_V1"] = "Q01_CUSTOMER_CREDIT_ATOMS_V1"
    scale: Annotated[StrictInt, Field(ge=6, le=6)] = 6
    atoms: Atoms
    state: Literal["RESERVED_REFERENCE", "RELEASED_REFERENCE"]


class BudgetSnapshot(Offline):
    simulation: SimBudget
    supplier: SupplierBudget
    customer: CustomerBudget
    payer: Literal["PLATFORM", "BYOK"]
    upstream_retry_responsibility: Literal["UNRESOLVED", "DECLARED_REFERENCE"]
    key_valid: StrictBool
    within_limits: StrictBool

    @model_validator(mode="after")
    def resource_payer(self) -> Self:
        if self.payer == "BYOK" and self.customer.atoms != 0:
            raise ValueError("BYOK_RESOURCE_CUSTOMER_CREDITS_MUST_BE_ZERO")
        return self


class BudgetPolicy(Offline):
    new_research_blocked: StrictBool
    automatic_charged_retry_allowed: Literal[False] = False
    supplier_liability_unresolved: StrictBool
    preserve_protection: Literal[True] = True
    allow_exit_reconciliation_checks: Literal[True] = True
    transaction_actions: tuple[()] = ()


class Request(Offline):
    key: Identifier
    payload_sha256: Digest


_TYPES: tuple[type[BaseModel], ...] = (
    StrategyIdentity, CatalogProfile, ABCReference, StrategySpec, S03Parameters,
    PrivateBinding, InstrumentProfile, PlanRevision, EvidenceSnapshot, DutyEvidence,
    ApprovalSnapshot, PreflightInput, Decision, StateSnapshot, StatePolicy, SimBudget,
    SupplierBudget, CustomerBudget, BudgetSnapshot, BudgetPolicy, Request,
)


def contract_hash(value: Offline) -> str:
    """Consistency identity only. Exact-type validation precedes serialization."""
    if type(value) not in _TYPES:
        raise ValueError("UNKNOWN_CONTRACT_TYPE")
    valid = canonical(value, type(value), extra=_TYPES)
    return digest_text(encode(valid.model_dump(mode="json")))


def _clock(now_ms: int) -> None:
    if type(now_ms) is not int or not 0 <= now_ms <= 253402300799999:
        raise ValueError("EXPLICIT_CLOCK_REQUIRED")


def _usable(e: EvidenceSnapshot, binding: PrivateBinding, now: int) -> bool:
    return (
        e.origin == "SYNTHETIC_REFERENCE" and e.status == "PASS" and e.use_allowed
        and e.coverage == "COMPLETE_REFERENCE"
        and e.received_at_ms <= now < min(e.expires_at_ms, e.rights_until_ms)
        and now - e.window_end_ms <= e.max_age_ms
        and (e.binding is None or e.binding == binding)
    )


def _source_matches(e: EvidenceSnapshot, i: InstrumentProfile) -> bool:
    expected = i.product
    if e.kind == "DATA" and e.name == "SAME_VENUE_PERP_AND_SPOT":
        expected = "PERP"
    if e.kind == "DATA" and e.name in {
        "FINALIZED_REGISTERED_POOL_FLOW", "NATIVE_BTC_ENTITY_HISTORY"
    }:
        expected = "CHAIN"
    if e.source_product != expected:
        return False
    if expected in {"CHAIN", "LP"}:
        if e.source_chain is None:
            return False
        if expected == i.product and e.source_chain != i.chain:
            return False
        if e.name == "FINALIZED_REGISTERED_POOL_FLOW" and e.source_chain != "eip155:1":
            return False
        if e.name == "NATIVE_BTC_ENTITY_HISTORY" and e.source_chain != "BITCOIN":
            return False
    elif e.source_chain is not None:
        return False
    if expected == i.product:
        return e.source_instrument_id == i.native_id and e.source_venue == i.venue
    if expected == "PERP":
        return (
            (i.venue, i.product, i.native_id, i.base, i.quote) == _RX05_SPOT_REFERENCE
            and (e.source_venue, e.source_product, e.source_instrument_id,
                 e.source_base, e.source_quote, e.source_settlement) == _RX05_PERP_REFERENCE
        )
    return e.source_instrument_id != i.native_id


def check_approval(plan: PlanRevision, approval: ApprovalSnapshot, *, now_ms: int) -> Decision:
    p = canonical(plan, PlanRevision, extra=_TYPES)
    a = canonical(approval, ApprovalSnapshot, extra=_TYPES)
    _clock(now_ms)
    reasons: list[str] = []
    ph = contract_hash(p)
    if (p.spec.identity.strategy_id, p.spec.identity.kind, p.spec.identity.version) != (
        "S03", "S03_ORIGINAL", STRATEGY_VERSION
    ):
        return Decision(status="BLOCKED", reasons=("NO_REVIEW_ADAPTER",))
    if (a.plan_sha256 != ph or a.plan_revision != p.revision or a.binding != p.binding
            or a.risk_policy_revision != p.risk_policy_revision
            or a.role_schema_revision != p.role_schema_revision):
        reasons.append("APPROVAL_BINDING_MISMATCH")
    if not p.starts_at_ms <= a.starts_at_ms <= now_ms < a.expires_at_ms <= p.expires_at_ms:
        reasons.append("APPROVAL_OR_PLAN_EXPIRED")
    covered: set[str] = set()
    for duty in a.duties:
        e = duty.source
        if (duty.role not in S03_DUTIES or e.kind != "REVIEW" or e.name != duty.role
                or e.profile_revision != a.role_schema_revision or e.subject_sha256 != ph
                or e.classification != "PRIVATE" or e.binding != p.binding
                or e.received_at_ms > a.starts_at_ms or not _usable(e, p.binding, now_ms)):
            reasons.append("INVALID_DUTY_EVIDENCE")
        else:
            covered.add(duty.role)
    missing = tuple(role for role in S03_DUTIES if role not in covered)
    if missing:
        reasons.append("REQUIRED_DUTIES_MISSING")
    return Decision(
        status="BLOCKED" if reasons else "ELIGIBLE",
        reasons=tuple(dict.fromkeys(reasons)) or ("OFFLINE_REFERENCE_MATCH_ONLY",),
        missing_roles=missing,
    )


def preflight(value: PreflightInput, *, now_ms: int) -> Decision:
    request = canonical(value, PreflightInput, extra=_TYPES)
    _clock(now_ms)
    p = request.plan
    profile = catalog_profile(p.spec.identity.strategy_id)
    reasons: list[str] = []
    missing: list[str] = []
    if tuple(contract_hash(e) for e in request.evidence) != p.evidence_sha256s:
        reasons.append("EVIDENCE_MANIFEST_MISMATCH")
    if not p.starts_at_ms <= now_ms < p.expires_at_ms:
        reasons.append("PLAN_EXPIRED")
    i = p.instrument
    if i is None:
        return Decision(status="BLOCKED", reasons=("INSTRUMENT_MISSING",),
                        missing_capabilities=profile.required_capabilities)
    if (i.product != profile.product or i.base != profile.base
            or i.quote != ("USDT" if i.product == "SPOT" else "USDC")
            or (i.product in {"CHAIN", "LP"} and (i.chain != "eip155:1" or i.pool is None))
            or (p.spec.identity.strategy_id == "RX05" and i.venue != "BINANCE")):
        reasons.append("INSTRUMENT_IDENTITY_MISMATCH")
    if any(v is None for v in (i.tick, i.step, i.min_quantity, i.min_notional, i.multiplier,
                               i.fee_currency, i.maker_fee, i.taker_fee)):
        reasons.append("INSTRUMENT_OR_FEES_MISSING")
    ih = contract_hash(i)
    required = (
        *(("DATA", name, p.data_profile_revision) for name in profile.required_data),
        *(("CAPABILITY", name, p.capability_profile_revision)
          for name in profile.required_capabilities),
        ("FEES", "FEE_SCHEDULE", i.fee_revision),
    )
    for kind, name, version in required:
        e = next((e for e in request.evidence if (e.kind, e.name) == (kind, name)), None)
        if (e is None or e.profile_revision != version or e.subject_sha256 != ih
                or not _usable(e, p.binding, now_ms) or not _source_matches(e, i)):
            reasons.append(kind + "_EVIDENCE_MISSING_OR_INVALID")
            if kind == "CAPABILITY":
                missing.append(name)
        elif p.spec.identity.strategy_id == "S03":
            if ((name == "MARKET_WINDOW" and now_ms - e.window_end_ms > 2000)
                    or (name == "NEWS_HEALTH" and now_ms - e.window_end_ms > 120000)):
                reasons.append("SOURCE_STALE")
    if reasons:
        return Decision(status="BLOCKED", reasons=tuple(dict.fromkeys(reasons)),
                        missing_capabilities=tuple(missing))
    if p.spec.identity.kind != "S03_ORIGINAL":
        return Decision(status="RESEARCH_ONLY", reasons=("EXECUTION_OR_REVIEW_ADAPTER_PENDING",))
    if request.approval is None:
        return Decision(status="BLOCKED", reasons=("PRIVATE_APPROVAL_REFERENCE_MISSING",),
                        missing_roles=S03_DUTIES)
    return check_approval(p, request.approval, now_ms=now_ms)


def state_policy(value: StateSnapshot) -> StatePolicy:
    s = canonical(value, StateSnapshot, extra=_TYPES)
    return StatePolicy(new_risk_blocked=(
        s.lifecycle != "ACTIVE_REFERENCE" or s.order in {"PENDING", "ACK", "PARTIAL", "UNKNOWN"}
        or s.protection not in {"NOT_REQUIRED", "SUFFICIENT_REFERENCE"}
        or s.reconciliation != "MATCHED_REFERENCE"
    ))


def budget_policy(value: BudgetSnapshot) -> BudgetPolicy:
    b = canonical(value, BudgetSnapshot, extra=_TYPES)
    unknown = b.supplier.liability == "UNKNOWN_PENDING_RECONCILE"
    return BudgetPolicy(
        new_research_blocked=(not b.key_valid or not b.within_limits or unknown
                              or b.customer.state == "RELEASED_REFERENCE"),
        supplier_liability_unresolved=unknown,
    )


def check_replay(previous: Request | None, request: Request) -> Literal["NEW", "REPLAY"]:
    """Compare one synthetic slot, not a persistent or atomic idempotency ledger."""
    current = canonical(request, Request, extra=_TYPES)
    if previous is None:
        return "NEW"
    old = canonical(previous, Request, extra=_TYPES)
    if old.key != current.key:
        return "NEW"
    if old.payload_sha256 != current.payload_sha256:
        raise ValueError("REQUEST_PAYLOAD_CONFLICT")
    return "REPLAY"


def request_for(key: str, payload: PreflightInput) -> Request:
    """Hash the actual closed payload, not a caller's unverified digest assertion."""
    valid = canonical(payload, PreflightInput, extra=_TYPES)
    return Request(key=key, payload_sha256=contract_hash(valid))


def check_revision(previous: PlanRevision, proposed: PlanRevision) -> str:
    """Pure predecessor comparison. Revision uniqueness/persistence belongs to D1."""
    old = canonical(previous, PlanRevision, extra=_TYPES)
    new = canonical(proposed, PlanRevision, extra=_TYPES)
    if old.plan_id != new.plan_id:
        raise ValueError("PLAN_ID_MISMATCH")
    oh, nh = contract_hash(old), contract_hash(new)
    if oh != nh and old.revision == new.revision:
        raise ValueError("NEW_PLAN_REVISION_REQUIRED")
    if (contract_hash(old.spec) != contract_hash(new.spec)
            and old.spec.parameter_revision == new.spec.parameter_revision):
        raise ValueError("NEW_PARAMETER_REVISION_REQUIRED")
    return nh
