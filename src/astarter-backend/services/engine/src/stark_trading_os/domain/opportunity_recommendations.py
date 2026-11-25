"""R1 closed offline recommendations; no IO, dispatch, budget or scheduler authority.

Hashes bind immutable evidence/profile inputs, not read-time eligibility. Reading
or refreshing a recommendation cannot renew its sources or grant execution.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Annotated, Literal, Self, cast

from pydantic import BaseModel, BeforeValidator, Field, StrictBool, StrictStr, model_validator

from stark_trading_os.audit.hash_chain import canonical_sha256
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.contracts import DecimalText, Identifier, Timestamp
from stark_trading_os.integrations.research_delivery import PrivateScope, PublicScope
from stark_trading_os.integrations.research_egress import (
    Closed,
    Digest,
    ResearchRejected,
    canonical,
    digest_text,
    encode,
)

type Visibility = PublicScope | PrivateScope
type Status = Literal["research", "preparable", "blocked"]
Names = Annotated[tuple[Identifier, ...], Field(max_length=32)]
Text = Annotated[StrictStr, Field(min_length=1, max_length=1000)]


def _no_authority(value: object) -> Literal[False]:
    if value is not False:
        raise ValueError("REFERENCE_CANNOT_GRANT_AUTHORITY")
    return False


NoAuthority = Annotated[Literal[False], BeforeValidator(_no_authority)]


class ClockRefV1(Closed):
    kind: Literal["UTC", "REPLAY", "SIM"]
    ref: Identifier
    unit: Literal["ms"] = "ms"

    @model_validator(mode="after")
    def epoch(self) -> Self:
        if (self.kind == "UTC") != (self.ref == "unix"):
            raise ValueError("CLOCK_EPOCH_REQUIRED")
        return self


class SourceRefV1(Closed):
    type: Literal["signal", "research", "market", "news", "onchain"]
    sourceId: Identifier
    revision: c.Revision | None
    recordId: Identifier | None = None
    taskId: Identifier | None = None
    signalId: Identifier | None = None
    runId: Identifier | None = None

    @model_validator(mode="after")
    def exact_record(self) -> Self:
        if self.recordId is None and self.taskId is None:
            raise ValueError("EXACT_SOURCE_RECORD_REQUIRED")
        return self


class SourceClockV1(Closed):
    clockRef: ClockRefV1
    eventAt: Timestamp | None
    receivedAt: Timestamp | None
    availableAt: Timestamp | None
    validUntil: Timestamp | None
    windowStart: Timestamp
    windowEnd: Timestamp
    confirmedAt: Timestamp | None = None
    availabilityKind: Literal["SOURCE", "PRODUCT"]
    maxAgeMs: Annotated[int, Field(strict=True, gt=0, le=86400000)]

    @model_validator(mode="after")
    def chronology(self) -> Self:
        if self.windowStart >= self.windowEnd:
            raise ValueError("SOURCE_WINDOW_INVALID")
        known = [t for t in (self.receivedAt, self.availableAt) if t is not None]
        if self.availableAt is not None and self.receivedAt is not None:
            ordered = (
                self.availableAt <= self.receivedAt
                if self.availabilityKind == "SOURCE"
                else self.receivedAt <= self.availableAt
            )
            if not ordered:
                raise ValueError("SOURCE_CLOCK_INVALID")
        if self.eventAt is not None and (
            self.eventAt < self.windowEnd or (known and self.eventAt > min(known))
        ):
            raise ValueError("SOURCE_CLOCK_INVALID")
        if self.confirmedAt is not None and not (
            self.windowEnd <= self.confirmedAt and (not known or self.confirmedAt <= max(known))
        ):
            raise ValueError("SOURCE_CONFIRMATION_INVALID")
        if self.validUntil is not None and self.validUntil <= max(known or [self.windowEnd]):
            raise ValueError("SOURCE_EXPIRY_INVALID")
        return self


class RecommendationEvidenceV1(Closed):
    evidenceId: Identifier
    dataKind: Identifier
    instrument: c.InstrumentProfile | None
    sourceRef: SourceRefV1
    rawHash: Digest | None
    contentHash: Digest | None = None
    clock: SourceClockV1
    visibility: Visibility
    rightsUntil: Timestamp
    useAllowed: StrictBool
    shareAllowed: StrictBool
    funding: Literal["PLATFORM", "BYOK"]
    coverage: Literal["complete", "partial", "unknown"]
    quality: Literal["fresh", "partial", "stale", "unavailable", "unknown"]
    withdrawn: StrictBool = False

    @model_validator(mode="after")
    def evidence_hash(self) -> Self:
        if self.rawHash is None and self.contentHash is None:
            raise ValueError("SOURCE_CONTENT_REFERENCE_REQUIRED")
        return self


class StrategyRefV1(Closed):
    strategy: Identifier
    planVariant: Identifier | None
    strategyVersion: c.Revision | None
    strategyRulesHash: Digest | None


class ParameterRuleV1(Closed):
    name: Identifier
    unit: Identifier
    minimum: DecimalText
    maximum: DecimalText

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if Decimal(self.minimum) > Decimal(self.maximum):
            raise ValueError("PARAMETER_RANGE_INVALID")
        return self


class ParameterV1(ParameterRuleV1):
    value: DecimalText
    evidenceRef: Identifier

    @model_validator(mode="after")
    def bounded(self) -> Self:
        if not Decimal(self.minimum) <= Decimal(self.value) <= Decimal(self.maximum):
            raise ValueError("PARAMETER_OUT_OF_RANGE")
        return self


class RuleRefV1(Closed):
    id: Identifier
    version: c.Revision | None
    hash: Digest | None = None


class RuleConditionV1(Closed):
    op: Literal["entry-rule", "invalidation-rule", "exit-rule", "protection-rule"]
    ruleRef: RuleRefV1
    evidenceRefs: Annotated[tuple[Identifier, ...], Field(min_length=1, max_length=8)]
    confirmedAt: Timestamp | None
    evaluation: Literal["PASS", "UNKNOWN", "FAIL"]


class ExplanationV1(Closed):
    text: Text
    evidenceRefs: Annotated[tuple[Identifier, ...], Field(min_length=1, max_length=8)]

    @model_validator(mode="after")
    def plain_text(self) -> Self:
        if re.search(r"<\s*/?\s*[A-Za-z][^>]*>", self.text):
            raise ValueError("RECOMMENDATION_TEXT_IS_NOT_HTML")
        return self


class CostAssessmentV1(Closed):
    state: Literal["PASS", "UNKNOWN", "FAIL"]
    currency: Identifier
    feeBps: DecimalText | None
    edgeBps: DecimalText | None
    origin: Literal["FIXTURE", "OBSERVED", "UNKNOWN"]
    evidenceRefs: Annotated[tuple[Identifier, ...], Field(max_length=8)]

    @model_validator(mode="after")
    def known_cost(self) -> Self:
        if self.state == "PASS" and (
            self.feeBps is None
            or self.edgeBps is None
            or self.origin == "UNKNOWN"
            or not self.evidenceRefs
            or Decimal(self.edgeBps) <= Decimal(self.feeBps)
        ):
            raise ValueError("COST_PASS_REQUIRES_EVIDENCE_AND_POSITIVE_EDGE")
        return self


class RiskStateV1(Closed):
    state: Literal["CLEAR", "UNKNOWN", "BLOCKED"]
    policyRevision: c.Revision
    validUntil: Timestamp
    reasonCodes: Names
    visibility: Visibility

    @model_validator(mode="after")
    def reasons(self) -> Self:
        if (self.state == "CLEAR" and self.reasonCodes) or (
            self.state == "BLOCKED" and not self.reasonCodes
        ):
            raise ValueError("RISK_STATE_REASON_MISMATCH")
        return self


class FitProfileV1(Closed):
    profileId: Identifier
    revision: c.Revision
    policyRef: Identifier
    instrument: c.InstrumentProfile
    registeredStrategy: StrategyRefV1
    mode: Literal["LOCAL_SIMULATION", "NATIVE_PAPER", "LIVE"]
    configurationPassed: StrictBool
    nativeAccepted: NoAuthority = False
    validUntil: Timestamp
    modelRouteRevision: c.Revision
    allowedRuleRefs: Annotated[tuple[RuleRefV1, ...], Field(max_length=32)]
    parameters: Annotated[tuple[ParameterRuleV1, ...], Field(max_length=64)] = ()

    @model_validator(mode="after")
    def unique_rules(self) -> Self:
        if len(set(self.allowedRuleRefs)) != len(self.allowedRuleRefs) or len(
            {p.name for p in self.parameters}
        ) != len(self.parameters):
            raise ValueError("DUPLICATE_PROFILE_RULE")
        return self


class RecommendationCandidateV1(Closed):
    opportunityId: Identifier
    strategy: StrategyRefV1
    instrument: c.InstrumentProfile
    visibility: Visibility
    clockRef: ClockRefV1
    sourceRef: SourceRefV1
    evidence: Annotated[tuple[RecommendationEvidenceV1, ...], Field(max_length=32)]
    generatedAt: Timestamp
    opportunityExpiresAt: Timestamp
    direction: Literal["long", "short", "neutral", "reduce", "wait"]
    intent: Literal["prepare_entry", "manage_existing", "watch"]
    signalAction: Literal["candidate", "retain", "confirmed", "conflict", "no_trade"]
    parameters: Annotated[tuple[ParameterV1, ...], Field(max_length=64)]
    entry: RuleConditionV1 | None
    invalidation: RuleConditionV1 | None
    exits: RuleConditionV1 | None
    protection: RuleConditionV1 | None
    costs: CostAssessmentV1
    rationale: Annotated[tuple[ExplanationV1, ...], Field(max_length=20)]
    notSuitable: Annotated[tuple[ExplanationV1, ...], Field(max_length=20)]

    @model_validator(mode="after")
    def unique_inputs(self) -> Self:
        if len({e.evidenceId for e in self.evidence}) != len(self.evidence) or len(
            {p.name for p in self.parameters}
        ) != len(self.parameters):
            raise ValueError("DUPLICATE_RECOMMENDATION_INPUT")
        return self


class RecommendationContextV1(Closed):
    visibility: Visibility
    clockRef: ClockRefV1
    profile: FitProfileV1
    risk: RiskStateV1
    researchState: Literal["READY", "WAIT", "BLOCKED"] = "READY"


class RecommendationAuthorityV1(Closed):
    executionAuthorized: NoAuthority = False
    preserveProtection: Literal[True] = True

    @model_validator(mode="after")
    def exact_flags(self) -> Self:
        if type(self.executionAuthorized) is not bool or type(self.preserveProtection) is not bool:
            raise ValueError("RECOMMENDATION_IS_NOT_AUTHORITY")
        return self


class RecommendationCapabilityV1(Closed):
    mode: Literal["LOCAL_SIMULATION", "NATIVE_PAPER", "LIVE"]
    nativeAccepted: NoAuthority = False


class StrategyRecommendationV1(Closed):
    schemaVersion: Literal["AstarterRecommendationProjection.r1"] = (
        "AstarterRecommendationProjection.r1"
    )
    provenance: Literal["OFFLINE_REFERENCE"] = "OFFLINE_REFERENCE"
    candidate: RecommendationCandidateV1
    context: RecommendationContextV1
    recommendationId: Digest
    revision: Digest
    semanticHash: Digest
    cacheKey: Digest
    dataAsOf: Timestamp | None
    asOf: Timestamp | None
    expiresAt: Timestamp
    publishedAt: Timestamp
    evaluatedAt: Timestamp
    status: Status
    reasonCodes: Names
    canPrepare: StrictBool
    capability: RecommendationCapabilityV1
    authority: RecommendationAuthorityV1 = RecommendationAuthorityV1()

    @model_validator(mode="after")
    def derived_projection(self) -> Self:
        expected = _derived(self.candidate, self.context, self.evaluatedAt, self.publishedAt)
        if any(getattr(self, key) != value for key, value in expected.items()):
            raise ValueError("RECOMMENDATION_PROJECTION_MISMATCH")
        return self


class RecommendationPageV1(Closed):
    items: Annotated[tuple[StrategyRecommendationV1, ...], Field(max_length=50)]
    nextCursor: Identifier | None = None

    @model_validator(mode="after")
    def unique_choices(self) -> Self:
        if len({(r.recommendationId, r.revision) for r in self.items}) != len(self.items):
            raise ValueError("DUPLICATE_RECOMMENDATION_CHOICE")
        return self


_TYPES: tuple[type[BaseModel], ...] = (
    *c._TYPES,
    PublicScope,
    PrivateScope,
    ClockRefV1,
    SourceRefV1,
    SourceClockV1,
    RecommendationEvidenceV1,
    StrategyRefV1,
    ParameterRuleV1,
    ParameterV1,
    RuleRefV1,
    RuleConditionV1,
    ExplanationV1,
    CostAssessmentV1,
    RiskStateV1,
    FitProfileV1,
    RecommendationCandidateV1,
    RecommendationContextV1,
    RecommendationAuthorityV1,
    RecommendationCapabilityV1,
    StrategyRecommendationV1,
    RecommendationPageV1,
)


def _hash(value: object) -> str:
    return digest_text(encode(value))


def _derived(
    value: RecommendationCandidateV1,
    ctx: RecommendationContextV1,
    now: int,
    published_at: int,
) -> dict[str, object]:
    if (
        type(now) is not int
        or type(published_at) is not int
        or not 0 <= published_at <= now <= 253402300799999
    ):
        raise ResearchRejected("CLOCK_INVALID")
    if value.visibility != ctx.visibility or ctx.risk.visibility != ctx.visibility:
        raise ResearchRejected("DENIED")
    hard: set[str] = set()
    missing: set[str] = set()
    if value.clockRef != ctx.clockRef:
        hard.add("CLOCK_DOMAIN_MISMATCH")
    if value.sourceRef.revision is None:
        missing.add("SOURCE_VERSION_UNKNOWN")
    deadlines = [value.opportunityExpiresAt, ctx.profile.validUntil, ctx.risk.validUntil]
    times: list[int] = []
    ids = {e.evidenceId for e in value.evidence}
    if not value.evidence:
        missing.add("DATA_MISSING")
    for e in value.evidence:
        private = type(e.visibility) is PrivateScope
        if (
            type(ctx.visibility) is PublicScope
            and (private or e.funding == "BYOK" or not e.shareAllowed)
        ) or (private and e.visibility != ctx.visibility):
            raise ResearchRejected("DENIED")
        clock = e.clock
        if e.sourceRef.revision is None:
            missing.add("SOURCE_VERSION_UNKNOWN")
        if e.rawHash is None:
            missing.add("RAW_SOURCE_HASH_UNKNOWN")
        deadlines.append(e.rightsUntil)
        if clock.validUntil is None:
            missing.add("SOURCE_EXPIRY_UNKNOWN")
        else:
            deadlines.append(clock.validUntil)
        if clock.eventAt is None or clock.receivedAt is None or clock.availableAt is None:
            missing.add("SOURCE_TIME_UNKNOWN")
        if clock.eventAt is not None:
            times.append(clock.eventAt)
            deadlines.append(clock.eventAt + clock.maxAgeMs)
        if clock.clockRef != ctx.clockRef or value.clockRef != ctx.clockRef:
            hard.add("CLOCK_DOMAIN_MISMATCH")
        if max(clock.receivedAt or 0, clock.availableAt or 0, clock.confirmedAt or 0) > now:
            hard.add("SOURCE_NOT_YET_AVAILABLE")
        if e.withdrawn:
            hard.add("SOURCE_WITHDRAWN")
        if not e.useAllowed:
            hard.add("SOURCE_USE_DENIED")
        if e.quality == "stale":
            hard.add("SOURCE_STALE")
        elif e.coverage != "complete" or e.quality != "fresh":
            missing.add("DATA_INCOMPLETE")
        if e.instrument is not None and e.instrument != value.instrument:
            hard.add("INSTRUMENT_MISMATCH")
        if e.instrument is None and e.dataKind != "NEWS_HEALTH":
            missing.add("SOURCE_INSTRUMENT_UNKNOWN")
    if value.instrument != ctx.profile.instrument:
        hard.add("INSTRUMENT_MISMATCH")
    try:
        catalog = c.catalog_profile(value.strategy.strategy)
        required = set(catalog.required_data)
        if value.instrument.product != catalog.product:
            hard.add("STRATEGY_PRODUCT_MISMATCH")
    except ValueError:
        required = set()
        missing.add("STRATEGY_UNREGISTERED")
    if required - {e.dataKind for e in value.evidence}:
        missing.add("DATA_MISSING")
    s = value.strategy
    if not all((s.planVariant, s.strategyVersion, s.strategyRulesHash)):
        missing.add("STRATEGY_VERSION_MISSING")
    elif s != ctx.profile.registeredStrategy or s.strategyRulesHash != c.SOURCE_SHA256:
        missing.add("STRATEGY_UNREGISTERED")
    # Frozen correspondence to the two existing local configuration variants;
    # this is not Nautilus acceptance or a runtime strategy registry.
    local_variant = (s.strategy, s.planVariant, s.strategyVersion) in {
        ("S01", "S01-SIM", "paper-v1"),
        ("S02", "S02-SIM", "paper-v1"),
    }
    if (
        ctx.profile.mode != "LOCAL_SIMULATION"
        or not ctx.profile.configurationPassed
        or not local_variant
    ):
        missing.add("CAPABILITY_UNVERIFIED")
    for name, op in (
        ("entry", "entry-rule"),
        ("invalidation", "invalidation-rule"),
        ("exits", "exit-rule"),
        ("protection", "protection-rule"),
    ):
        condition = getattr(value, name)
        if condition is None:
            missing.add("CONDITION_MISSING")
            continue
        if condition.op != op or not set(condition.evidenceRefs) <= ids:
            raise ResearchRejected("BINDING_MISMATCH")
        if condition.ruleRef not in ctx.profile.allowedRuleRefs or (
            condition.ruleRef.version is None and condition.ruleRef.hash is None
        ):
            missing.add("CONDITION_UNREGISTERED")
        if condition.evaluation == "FAIL":
            hard.add("CONDITION_FAILED")
        elif condition.evaluation != "PASS":
            missing.add("CONDITION_UNCONFIRMED")
        referenced = [e.clock for e in value.evidence if e.evidenceId in condition.evidenceRefs]
        confirmed_after = max(c.confirmedAt or c.windowEnd for c in referenced)
        if (
            condition.confirmedAt is None
            or condition.confirmedAt > now
            or condition.confirmedAt < confirmed_after
        ):
            missing.add("CONDITION_UNCONFIRMED")
    rules = {p.name: p for p in ctx.profile.parameters}
    if set(rules) - {p.name for p in value.parameters}:
        missing.add("PARAMETER_MISSING")
    for parameter in value.parameters:
        if parameter.evidenceRef not in ids:
            raise ResearchRejected("BINDING_MISMATCH")
        rule = rules.get(parameter.name)
        if rule is None or (
            parameter.model_dump(exclude={"value", "evidenceRef"}) != rule.model_dump()
        ):
            missing.add("PARAMETER_UNREGISTERED")
    if not set(value.costs.evidenceRefs) <= ids:
        raise ResearchRejected("BINDING_MISMATCH")
    for explanation in (*value.rationale, *value.notSuitable):
        if not set(explanation.evidenceRefs) <= ids:
            raise ResearchRejected("BINDING_MISMATCH")
    if value.costs.currency != value.instrument.quote:
        hard.add("COST_CURRENCY_MISMATCH")
    known_loss = (
        value.costs.feeBps is not None
        and value.costs.edgeBps is not None
        and Decimal(value.costs.edgeBps) <= Decimal(value.costs.feeBps)
    )
    if value.costs.state == "FAIL" or known_loss:
        hard.add("COST_INFEASIBLE")
    elif value.costs.state == "UNKNOWN":
        missing.add("COST_UNKNOWN")
    if value.costs.origin == "OBSERVED" and any(
        e.dataKind != "FEES" for e in value.evidence if e.evidenceId in value.costs.evidenceRefs
    ):
        missing.add("COST_EVIDENCE_MISSING")
    if ctx.risk.state == "BLOCKED":
        hard.update(ctx.risk.reasonCodes)
    elif ctx.risk.state != "CLEAR":
        missing.add("RISK_UNKNOWN")
    if ctx.researchState == "BLOCKED":
        hard.add("RESEARCH_BLOCKED")
    elif ctx.researchState != "READY":
        missing.add("RESEARCH_PENDING")
    if value.direction == "short" and value.instrument.product == "SPOT":
        hard.add("SPOT_SHORT_UNSUPPORTED")
    if value.direction == "reduce" or value.intent == "manage_existing":
        if type(ctx.visibility) is PublicScope:
            hard.add("PRIVATE_CONTEXT_REQUIRED")
        else:
            missing.add("PRIVATE_POSITION_UNVERIFIED")
    if value.strategy.strategy == "RX04" and value.intent == "prepare_entry":
        hard.add("DEFENSIVE_STRATEGY_NOT_ENTRY")
    if value.signalAction == "conflict":
        hard.add("EVIDENCE_CONFLICT")
    elif (
        value.signalAction != "confirmed"
        or value.direction == "wait"
        or (value.direction == "neutral" and value.strategy.strategy != "S01")
        or value.intent != "prepare_entry"
    ):
        missing.add("RESEARCH_JUDGEMENT_ONLY")
    expires = min(deadlines)
    if ctx.clockRef.kind == "UTC" and value.generatedAt > published_at:
        hard.add("RESULT_NOT_YET_AVAILABLE")
    if now >= expires:
        hard.add("EXPIRED")
    if now != published_at:
        # One bounded evaluation at publication; GET may downgrade, never promote
        # an old blocked/research decision just because time has passed.
        published = _derived(value, ctx, published_at, published_at)
        if published["status"] == "blocked":
            hard.update(cast(tuple[str, ...], published["reasonCodes"]))
        elif published["status"] == "research":
            missing.update(cast(tuple[str, ...], published["reasonCodes"]))
    status: Status = "blocked" if hard else "research" if missing else "preparable"
    semantic = dict(candidate=value.model_dump(exclude={"generatedAt"}), context=ctx.model_dump())
    content = _hash(semantic)
    identity = _hash(
        dict(
            visibility=value.visibility.model_dump(),
            instrument=dict(
                nativeId=value.instrument.native_id,
                venue=value.instrument.venue,
                product=value.instrument.product,
                base=value.instrument.base,
                quote=value.instrument.quote,
                chain=value.instrument.chain,
                pool=value.instrument.pool,
            ),
            opportunityId=value.opportunityId,
            strategy=dict(strategy=value.strategy.strategy, planVariant=value.strategy.planVariant),
            clockRef=value.clockRef.model_dump(),
        )
    )
    as_of = min(times) if times and len(times) == len(value.evidence) else None
    return dict(
        recommendationId=identity,
        revision=_hash(
            dict(semanticHash=content, generatedAt=value.generatedAt, publishedAt=published_at)
        ),
        semanticHash=content,
        cacheKey=_hash(dict(schema="RecommendationCache.v1", contentHash=content)),
        dataAsOf=as_of,
        asOf=as_of,
        expiresAt=expires,
        status=status,
        reasonCodes=tuple(sorted(hard | missing)),
        canPrepare=status == "preparable",
        capability=RecommendationCapabilityV1(mode=ctx.profile.mode),
    )


def build_recommendation(
    value: object,
    context: object,
    *,
    now_ms: int,
) -> StrategyRecommendationV1:
    """Pure offline projection. Callers must obtain inputs through their existing DAL."""
    candidate = canonical(value, RecommendationCandidateV1, extra=_TYPES)
    ctx = canonical(context, RecommendationContextV1, extra=_TYPES)
    return _project(candidate, ctx, published_at=now_ms, now_ms=now_ms)


def _project(
    candidate: RecommendationCandidateV1,
    ctx: RecommendationContextV1,
    *,
    published_at: int,
    now_ms: int,
) -> StrategyRecommendationV1:
    return StrategyRecommendationV1.model_validate(
        dict(
            candidate=candidate,
            context=ctx,
            publishedAt=published_at,
            evaluatedAt=now_ms,
        )
        | _derived(candidate, ctx, now_ms, published_at)
    )


def read_cached(
    value: object,
    context: object,
    *,
    current_candidate: object,
    now_ms: int,
) -> StrategyRecommendationV1:
    """Require the trusted caller's current head; no stale-source/time-only cache hit."""
    cached = canonical(value, StrategyRecommendationV1, extra=_TYPES)
    current = build_recommendation(current_candidate, context, now_ms=now_ms)
    if current.cacheKey != cached.cacheKey:
        raise ResearchRejected("BINDING_MISMATCH")
    ctx = canonical(context, RecommendationContextV1, extra=_TYPES)
    return _project(cached.candidate, ctx, published_at=cached.publishedAt, now_ms=now_ms)


def _snapshot_wire(row: StrategyRecommendationV1) -> dict[str, object]:
    """The immutable published DTO, without the separate currentEligibility view."""
    row = _project(row.candidate, row.context, published_at=row.publishedAt, now_ms=row.publishedAt)
    item, profile = row.candidate, row.context.profile
    instrument, strategy = item.instrument, item.strategy
    try:
        required_data = c.catalog_profile(strategy.strategy).required_data
    except ValueError:
        required_data = ()
    provided_data = {e.dataKind for e in item.evidence}
    evidence = [
        dict(
            evidenceId=e.evidenceId,
            provider=e.sourceRef.sourceId,
            sourceKind=e.dataKind,
            sourceRevision=e.sourceRef.revision,
            sourceRef=e.sourceRef.model_dump(mode="json"),
            rawHash=e.rawHash,
            contentHash=e.contentHash,
            clockKind=e.clock.clockRef.kind,
            clockRef=e.clock.clockRef.model_dump(mode="json"),
            eventAt=e.clock.eventAt,
            receivedAt=e.clock.receivedAt,
            availableAt=e.clock.availableAt,
            availabilityKind=e.clock.availabilityKind,
            validUntil=e.clock.validUntil,
            confirmedAt=e.clock.confirmedAt,
            windowStart=e.clock.windowStart,
            windowEnd=e.clock.windowEnd,
            maxAgeMs=e.clock.maxAgeMs,
            rightsUntil=e.rightsUntil,
            quality=e.quality,
            coverage=e.coverage,
        )
        for e in item.evidence
    ]
    conditions: dict[str, object] = {}
    for name in ("entry", "invalidation", "exits", "protection"):
        rule = getattr(item, name)
        conditions[name] = (
            None
            if rule is None
            else dict(
                op=rule.op,
                ruleRef=rule.ruleRef.model_dump(mode="json"),
                evaluation={"PASS": "TRUE", "FAIL": "FALSE", "UNKNOWN": "UNKNOWN"}[rule.evaluation],
                evidenceRefs=list(rule.evidenceRefs),
                confirmedAt=rule.confirmedAt,
            )
        )
    result: dict[str, object] = dict(
        schemaVersion="StrategyRecommendation.v1",
        recommendationId=row.recommendationId,
        revision=row.revision,
        opportunityId=item.opportunityId,
        sourceId=item.sourceRef.sourceId,
        sourceRevision=item.sourceRef.revision,
        sourceRef=item.sourceRef.model_dump(mode="json"),
        evidence=evidence,
        asset=instrument.base,
        assetId=None,
        market=f"{instrument.base}/{instrument.quote}",
        marketType=instrument.product,
        profileId=instrument.profile_id,
        venueId=instrument.venue,
        instrument=dict(
            providerSymbol=instrument.native_id,
            base=instrument.base,
            quote=instrument.quote,
            chainId=instrument.chain,
            contractAddress=None,
            poolId=instrument.pool,
        ),
        clockKind={"UTC": "utc", "REPLAY": "historical", "SIM": "sim"}[item.clockRef.kind],
        clockRef=dict(id=item.clockRef.ref, timeUnit=item.clockRef.unit),
        dataAsOf=row.dataAsOf,
        asOf=row.asOf,
        generatedAt=item.generatedAt,
        expiresAt=row.expiresAt,
        expiryKind="time",
        strategy=strategy.strategy,
        planVariant=strategy.planVariant,
        strategyVersion=strategy.strategyVersion,
        strategyRulesHash=strategy.strategyRulesHash,
        policyRef=profile.policyRef,
        fitProfileRef=dict(
            id=profile.profileId,
            version=profile.revision,
            hash=_hash(profile.model_dump(mode="json")),
        ),
        direction=item.direction,
        intent=item.intent,
        parameters=[
            dict(key=p.name, value=p.value, unit=p.unit, evidenceRefs=[p.evidenceRef])
            for p in item.parameters
        ],
        **conditions,
        capitalConstraints=dict(
            currency=instrument.quote,
            userBudget=None,
            availableBalance=None,
            suggestedQuantity=None,
            verification="NOT_BOUND",
        ),
        costs=dict(
            feeCurrency=item.costs.currency,
            buyRate=None,
            sellRate=None,
            gas=None,
            funding=None,
            totalCostBps=item.costs.feeBps,
            edgeBps=item.costs.edgeBps,
            verification=item.costs.state,
            assumptionOrigin=item.costs.origin,
            evidenceRefs=list(item.costs.evidenceRefs),
        ),
        status=row.status,
        reasonCodes=list(row.reasonCodes),
        canPrepare=row.canPrepare,
        capability=row.capability.model_dump(mode="json"),
        authority=dict(
            executionAuthorized=False,
            paymentAuthorized=False,
            mandateId=None,
            preserveProtection=True,
        ),
        rationale=[x.model_dump(mode="json") for x in item.rationale],
        notSuitable=[x.model_dump(mode="json") for x in item.notSuitable],
        missing=list(row.reasonCodes),
        provenance=dict(
            producerKind="OFFLINE_REFERENCE",
            model=None,
            modelCalls=0,
            decisionAt=row.publishedAt,
            decisionClockRef=item.clockRef.model_dump(),
        ),
        coverage=dict(
            requiredData=list(required_data),
            providedData=sorted(provided_data),
            complete=bool(required_data)
            and set(required_data) <= provided_data
            and all(e.coverage == "complete" for e in item.evidence),
        ),
    )
    try:
        result["contentHash"] = canonical_sha256(result)
    except ValueError:
        raise ResearchRejected("INVALID_OUTPUT") from None
    return result


def to_wire(
    value: object,
    context: object,
    *,
    current_candidate: object,
    now_ms: int,
) -> dict[str, object]:
    """Immutable v1 snapshot plus separately evaluated, non-upgrading read state."""
    cached = canonical(value, StrategyRecommendationV1, extra=_TYPES)
    ctx = canonical(context, RecommendationContextV1, extra=_TYPES)
    head = canonical(current_candidate, RecommendationCandidateV1, extra=_TYPES)
    if type(now_ms) is not int or not cached.publishedAt <= now_ms <= 253402300799999:
        raise ResearchRejected("CLOCK_INVALID")
    if (
        cached.candidate.visibility != ctx.visibility
        or head.visibility != ctx.visibility
        or ctx.risk.visibility != ctx.visibility
    ):
        raise ResearchRejected("DENIED")
    current_head = build_recommendation(head, ctx, now_ms=now_ms)
    result = _snapshot_wire(cached)
    try:
        current = read_cached(cached, ctx, current_candidate=head, now_ms=now_ms)
        eligibility: dict[str, object] = dict(
            status=current.status,
            reasonCodes=list(current.reasonCodes),
            canPrepare=current.canPrepare,
        )
    except ResearchRejected as exc:
        if exc.reason != "BINDING_MISMATCH":
            raise
        # Exact historical content remains readable; a different current head is
        # not silently substituted and cannot make this old version adoptable.
        eligibility = dict(
            status="blocked",
            reasonCodes=sorted({"RECOMMENDATION_REVISION_CHANGED", *current_head.reasonCodes}),
            canPrepare=False,
        )
    eligibility.update(evaluatedAt=now_ms, clockRef=ctx.clockRef.model_dump(mode="json"))
    result["currentEligibility"] = eligibility
    return result
