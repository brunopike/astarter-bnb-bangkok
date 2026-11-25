"""R1 hand-derived DTO, scope, clock, eligibility and cache counterexamples."""

import importlib
import importlib.util

import pytest
from pydantic import ValidationError

from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.research_egress import ResearchRejected
from tests.unit.domain.test_research_jobs import PLAN


def api():
    name = "stark_trading_os.domain.opportunity_recommendations"
    assert importlib.util.find_spec(name) is not None, "R1 opportunity contracts are missing"
    return importlib.import_module(name)


def clock_ref(kind="UTC", ref="unix"):
    return dict(kind=kind, ref=ref, unit="ms")


def source(identifier, kind, event, *, valid_until=20000, **changes):
    return (
        dict(
            evidenceId=identifier,
            dataKind=kind,
            instrument=PLAN.instrument,
            sourceRef=dict(
                type="market",
                sourceId="fixture-market",
                revision="source-v1",
                recordId="full-record-" + identifier,
            ),
            rawHash="a" * 64,
            clock=dict(
                clockRef=clock_ref(),
                eventAt=event,
                receivedAt=event + 100,
                availableAt=event + 200,
                validUntil=valid_until,
                windowStart=event - 1000,
                windowEnd=event,
                confirmedAt=event,
                availabilityKind="PRODUCT",
                maxAgeMs=5000 if kind == "MARKET_WINDOW" else 20000,
            ),
            visibility=dict(visibility="PUBLIC"),
            rightsUntil=20000,
            useAllowed=True,
            shareAllowed=True,
            funding="PLATFORM",
            coverage="complete",
            quality="fresh",
            withdrawn=False,
        )
        | changes
    )


def candidate(**changes):
    r = api()

    def rule(op):
        return dict(
            op=op,
            ruleRef=dict(id="registered-rule-v1", version="rules-v1", hash=None),
            evidenceRefs=("range",),
            confirmedAt=6000,
            evaluation="PASS",
        )

    return r.RecommendationCandidateV1.model_validate(
        dict(
            opportunityId="btc-range-event-1",
            strategy=dict(
                strategy="S01",
                planVariant="S01-SIM",
                strategyVersion="paper-v1",
                strategyRulesHash=c.SOURCE_SHA256,
            ),
            instrument=PLAN.instrument,
            visibility=dict(visibility="PUBLIC"),
            clockRef=clock_ref(),
            sourceRef=dict(
                type="signal",
                sourceId="signal-feed",
                revision="signal-v1",
                recordId="full-signal-record",
                signalId="original-signal",
            ),
            evidence=(
                source("market", "MARKET_WINDOW", 8000),
                source("news", "NEWS_HEALTH", 4000, valid_until=15000),
                source("range", "RANGE_BARS", 6000),
            ),
            generatedAt=9000,
            opportunityExpiresAt=16000,
            direction="long",
            intent="prepare_entry",
            signalAction="confirmed",
            parameters=(),
            entry=rule("entry-rule"),
            invalidation=rule("invalidation-rule"),
            exits=rule("exit-rule"),
            protection=rule("protection-rule"),
            costs=dict(
                state="PASS",
                currency="USDT",
                feeBps="20",
                edgeBps="50",
                origin="FIXTURE",
                evidenceRefs=("market",),
            ),
            rationale=(
                dict(
                    text="A fixture range, not a current trading instruction",
                    evidenceRefs=("range",),
                ),
            ),
            notSuitable=(),
        )
        | changes
    )


def context(**changes):
    r = api()
    return r.RecommendationContextV1.model_validate(
        dict(
            clockRef=clock_ref(),
            visibility=dict(visibility="PUBLIC"),
            profile=dict(
                profileId="fixture-fit",
                revision="fit-v1",
                policyRef="risk-rule-v1",
                instrument=PLAN.instrument,
                registeredStrategy=dict(
                    strategy="S01",
                    planVariant="S01-SIM",
                    strategyVersion="paper-v1",
                    strategyRulesHash=c.SOURCE_SHA256,
                ),
                mode="LOCAL_SIMULATION",
                configurationPassed=True,
                nativeAccepted=False,
                validUntil=18000,
                modelRouteRevision="rules-only-v1",
                allowedRuleRefs=(dict(id="registered-rule-v1", version="rules-v1", hash=None),),
            ),
            risk=dict(
                state="CLEAR",
                policyRevision="risk-v1",
                validUntil=17000,
                reasonCodes=(),
                visibility=dict(visibility="PUBLIC"),
            ),
        )
        | changes
    )


def change(model, **updates):
    return type(model).model_validate(model.model_dump() | updates)


def build(value=None, ctx=None, now=10000):
    return api().build_recommendation(value or candidate(), ctx or context(), now_ms=now)


def test_missing_variant_stays_research_without_rewriting_family():
    value = candidate(
        strategy=dict(
            strategy="S03", planVariant=None, strategyVersion=None, strategyRulesHash=None
        )
    )
    out = build(value)
    assert out.candidate.strategy.strategy == "S03"
    assert out.candidate.strategy.planVariant is None
    assert out.status == "research" and not out.canPrepare
    assert "STRATEGY_VERSION_MISSING" in out.reasonCodes
    assert out.authority.executionAuthorized is False


def test_complete_local_sim_is_only_preparable_with_oldest_required_source_time():
    out = build()
    assert out.status == "preparable" and out.canPrepare
    assert out.dataAsOf == out.asOf == 4000
    assert out.expiresAt == 13000  # market event 8000 + max age 5000
    assert out.capability.mode == "LOCAL_SIMULATION" and not out.capability.nativeAccepted
    assert not out.authority.executionAuthorized and out.provenance == "OFFLINE_REFERENCE"
    assert out.candidate.sourceRef.recordId == "full-signal-record"


@pytest.mark.parametrize("field", ["entry", "invalidation", "exits", "protection"])
def test_missing_condition_is_research_and_cannot_prepare(field):
    out = build(candidate(**{field: None}))
    assert out.status == "research" and not out.canPrepare
    assert "CONDITION_MISSING" in out.reasonCodes


def test_retain_never_becomes_long_or_ready():
    out = build(candidate(signalAction="retain", direction="neutral", intent="watch"))
    assert out.status == "research" and not out.canPrepare
    assert out.candidate.direction == "neutral" and out.candidate.strategy.strategy == "S01"


@pytest.mark.parametrize("now", [13000, 13001, 20000])
def test_exact_expiry_and_late_result_are_blocked_without_new_lifetime(now):
    out = build(now=now)
    assert out.status == "blocked" and not out.canPrepare and out.expiresAt == 13000
    assert "EXPIRED" in out.reasonCodes


def test_receipt_only_book_time_is_not_fabricated_as_source_time():
    value = candidate()
    book = source("range", "RANGE_BARS", 6000)
    book["clock"] |= dict(eventAt=None, confirmedAt=None)
    value = change(value, evidence=(*value.evidence[:2], book))
    out = build(value)
    assert out.dataAsOf is None and out.status == "research" and not out.canPrepare
    assert out.candidate.evidence[2].clock.eventAt is None
    assert "SOURCE_TIME_UNKNOWN" in out.reasonCodes


def test_unknown_or_partial_data_is_not_fresh_and_known_withdrawal_blocks():
    value = candidate()
    partial = change(value.evidence[0], coverage="partial", quality="partial")
    out = build(change(value, evidence=(partial, *value.evidence[1:])))
    assert out.status == "research" and "DATA_INCOMPLETE" in out.reasonCodes
    withdrawn = change(partial, withdrawn=True)
    out = build(change(value, evidence=(withdrawn, *value.evidence[1:])))
    assert out.status == "blocked" and "SOURCE_WITHDRAWN" in out.reasonCodes


@pytest.mark.parametrize("direction", ["short", "reduce"])
def test_public_spot_cannot_offer_short_or_private_position_reduction(direction):
    out = build(candidate(direction=direction, intent="manage_existing"))
    assert out.status == "blocked" and not out.canPrepare


def test_hard_risk_veto_survives_confirmed_proposal():
    ctx = context()
    ctx = change(ctx, risk=change(ctx.risk, state="BLOCKED", reasonCodes=("EVENT_HARD_LOCK",)))
    out = build(ctx=ctx)
    assert out.status == "blocked" and "EVENT_HARD_LOCK" in out.reasonCodes
    assert out.authority.preserveProtection is True


def test_unknown_costs_stay_research_and_fee_insufficient_blocks():
    value = candidate()
    out = build(change(value, costs=change(value.costs, state="UNKNOWN", feeBps=None)))
    assert out.status == "research" and "COST_UNKNOWN" in out.reasonCodes
    out = build(change(value, costs=change(value.costs, state="FAIL", edgeBps="10")))
    assert out.status == "blocked" and "COST_INFEASIBLE" in out.reasonCodes


def test_changed_source_revision_rules_risk_and_model_profile_invalidate_cache():
    r = api()
    first = build()
    value, ctx = candidate(), context()
    mutations = [
        (
            change(
                value,
                evidence=(
                    change(
                        value.evidence[0],
                        sourceRef=change(value.evidence[0].sourceRef, revision="source-v2"),
                    ),
                    *value.evidence[1:],
                ),
            ),
            ctx,
        ),
        (value, change(ctx, profile=change(ctx.profile, revision="fit-v2"))),
        (value, change(ctx, profile=change(ctx.profile, modelRouteRevision="route-v2"))),
        (value, change(ctx, risk=change(ctx.risk, policyRevision="risk-v2"))),
    ]
    for other, policy in mutations:
        assert build(other, policy).cacheKey != first.cacheKey
    with pytest.raises(ResearchRejected):
        r.read_cached(
            first,
            change(ctx, profile=change(ctx.profile, revision="fit-v2")),
            current_candidate=value,
            now_ms=11000,
        )


def test_refresh_does_not_change_identity_revision_or_extend_expiry():
    r = api()
    a = build()
    b = r.read_cached(
        a, context(), current_candidate=change(candidate(), generatedAt=11000), now_ms=11000
    )
    assert (a.recommendationId, a.revision, a.semanticHash, a.cacheKey, a.expiresAt) == (
        b.recommendationId,
        b.revision,
        b.semanticHash,
        b.cacheKey,
        b.expiresAt,
    )
    expired = r.read_cached(a, context(), current_candidate=candidate(), now_ms=13000)
    assert expired.status == "blocked" and not expired.canPrepare
    assert expired.candidate.generatedAt == 9000 and expired.dataAsOf == 4000


def test_private_scopes_do_not_share_and_public_cannot_absorb_private_evidence():
    value, ctx = candidate(), context()
    private = dict(
        visibility="PRIVATE",
        tenant_id="tenant-a",
        principal_scope_id="user-a",
        account_scope_id="account-a",
    )
    private_value = change(value, visibility=private)
    private_ctx = change(ctx, visibility=private, risk=change(ctx.risk, visibility=private))
    assert build(private_value, private_ctx).cacheKey != build().cacheKey
    with pytest.raises(ResearchRejected):
        build(private_value, ctx)
    bad = change(value.evidence[0], visibility=private, shareAllowed=False, funding="BYOK")
    with pytest.raises(ResearchRejected):
        build(change(value, evidence=(bad, *value.evidence[1:])))


def test_clock_domain_and_sim_epoch_are_never_silently_converted():
    ctx = change(context(), clockRef=clock_ref("SIM", "simulation-a"))
    out = build(ctx=ctx)
    assert out.status == "blocked" and "CLOCK_DOMAIN_MISMATCH" in out.reasonCodes
    with pytest.raises(ValidationError):
        api().ClockRefV1.model_validate(dict(kind="SIM", ref="simulation-a", unit="s"))


def test_source_and_product_availability_orders_are_explicit_and_raw_times_preserved():
    value = candidate()
    evidence = value.evidence[0]
    upstream = change(evidence.clock, availabilityKind="SOURCE", availableAt=8050)
    out = build(change(value, evidence=(change(evidence, clock=upstream), *value.evidence[1:])))
    assert out.candidate.evidence[0].clock.availableAt == 8050
    assert out.candidate.evidence[0].clock.receivedAt == 8100
    with pytest.raises(ValidationError):
        change(upstream, availabilityKind="PRODUCT")


@pytest.mark.parametrize("mutation", ["extra", "authority", "bad_hash", "forged_status"])
def test_closed_dto_and_cache_reject_forged_authority_or_derived_fields(mutation):
    r = api()
    out = build()
    if mutation == "extra":
        with pytest.raises(ValidationError):
            r.RecommendationCandidateV1.model_validate(
                candidate().model_dump() | {"apiKey": "fake"}
            )
        return
    forged = out.model_copy(
        update={"authority": out.authority.model_copy(update={"executionAuthorized": True})}
        if mutation == "authority"
        else {"semanticHash": "f" * 64}
        if mutation == "bad_hash"
        else {"status": "research", "canPrepare": False}
    )
    with pytest.raises(ResearchRejected):
        r.read_cached(forged, context(), current_candidate=candidate(), now_ms=11000)


def test_invalid_evidence_links_parameter_units_and_future_confirmations_are_rejected():
    value = candidate()
    with pytest.raises(ResearchRejected):
        build(change(value, entry=change(value.entry, evidenceRefs=("unknown",))))
    with pytest.raises(ValidationError):
        api().ParameterV1.model_validate(
            dict(
                name="spacing",
                value="1.5",
                unit="bps",
                evidenceRef="range",
                minimum="2",
                maximum="3",
            )
        )
    out = build(change(value, entry=change(value.entry, confirmedAt=11000)))
    assert out.status == "research" and "CONDITION_UNCONFIRMED" in out.reasonCodes


def test_mismatched_instrument_or_plan_version_does_not_become_another_ready_strategy():
    value = candidate()
    wrong_instrument = change(value.instrument, venue="OTHER")
    out = build(change(value, instrument=wrong_instrument))
    assert out.status == "blocked" and "INSTRUMENT_MISMATCH" in out.reasonCodes
    out = build(change(value, strategy=change(value.strategy, strategyVersion="unknown-v2")))
    assert out.status == "research" and "STRATEGY_UNREGISTERED" in out.reasonCodes
    assert out.candidate.strategy.strategy == "S01"


def test_unimplemented_sim_variant_cannot_be_enabled_by_a_configuration_flag():
    value, ctx = candidate(), context()
    strategy = change(value.strategy, strategy="S03", planVariant="S03-SIM")
    evidence = change(value.evidence[2], dataKind="S03_CONTINUOUS_BARS")
    value = change(value, strategy=strategy, evidence=(*value.evidence[:2], evidence))
    ctx = change(ctx, profile=change(ctx.profile, registeredStrategy=strategy))
    out = build(value, ctx)
    assert out.status == "research" and "CAPABILITY_UNVERIFIED" in out.reasonCodes
    assert out.candidate.strategy.strategy == "S03"


def test_watch_intent_never_creates_a_preparable_entry():
    out = build(candidate(intent="watch"))
    assert out.status == "research" and not out.canPrepare


def test_condition_cannot_claim_confirmation_before_its_referenced_closed_window():
    value = candidate()
    out = build(change(value, entry=change(value.entry, confirmedAt=1000)))
    assert out.status == "research" and "CONDITION_UNCONFIRMED" in out.reasonCodes


def test_unregistered_rule_reference_cannot_make_a_complete_plan():
    value = candidate()
    out = build(
        change(
            value, entry=change(value.entry, ruleRef=change(value.entry.ruleRef, id="unknown-rule"))
        )
    )
    assert out.status == "research" and "CONDITION_UNREGISTERED" in out.reasonCodes


def test_unknown_source_revision_is_preserved_as_research():
    value = candidate()
    evidence = change(
        value.evidence[0], sourceRef=change(value.evidence[0].sourceRef, revision=None)
    )
    out = build(change(value, evidence=(evidence, *value.evidence[1:])))
    assert out.status == "research" and "SOURCE_VERSION_UNKNOWN" in out.reasonCodes


def test_sanitized_content_hash_is_not_relabelled_as_raw_provider_evidence():
    value = candidate()
    evidence = change(value.evidence[0], rawHash=None, contentHash="b" * 64)
    out = build(change(value, evidence=(evidence, *value.evidence[1:])))
    assert out.status == "research" and "RAW_SOURCE_HASH_UNKNOWN" in out.reasonCodes
    assert out.candidate.evidence[0].rawHash is None


def test_recommendation_page_is_bounded_and_rejects_duplicate_versioned_choices():
    r = api()
    out = build()
    with pytest.raises(ValidationError):
        r.RecommendationPageV1(items=(out,) * 51)
    with pytest.raises(ValidationError):
        r.RecommendationPageV1(items=(out, out))


def test_public_wire_matches_flat_contract_and_rechecks_expiry_without_private_context():
    r = api()
    wire = r.to_wire(build(), context(), current_candidate=candidate(), now_ms=13000)
    assert wire["schemaVersion"] == "StrategyRecommendation.v1"
    assert wire["strategy"] == "S01" and wire["planVariant"] == "S01-SIM"
    assert wire["sourceRef"]["recordId"] == "full-signal-record"
    assert wire["dataAsOf"] == wire["asOf"] == 4000
    assert wire["generatedAt"] == 9000 and wire["expiresAt"] == 13000
    assert wire["status"] == "preparable" and wire["canPrepare"] is True
    assert wire["currentEligibility"]["status"] == "blocked"
    assert wire["currentEligibility"]["canPrepare"] is False
    assert wire["authority"] == dict(
        executionAuthorized=False, paymentAuthorized=False, mandateId=None, preserveProtection=True
    )
    assert wire["capitalConstraints"]["userBudget"] is None
    assert wire["capitalConstraints"]["availableBalance"] is None
    assert wire["capitalConstraints"]["suggestedQuantity"] is None
    assert "context" not in wire and "candidate" not in wire
    assert all("rawFile" not in item for item in wire["evidence"])


def test_known_false_entry_and_unknown_entry_never_prepare():
    value = candidate()
    for evaluation, expected in [("FAIL", "blocked"), ("UNKNOWN", "research")]:
        out = build(change(value, entry=change(value.entry, evaluation=evaluation)))
        assert out.status == expected and not out.canPrepare


def test_unknown_receipt_is_not_filled_from_event_or_availability_time():
    value = candidate()
    evidence = change(value.evidence[0], clock=change(value.evidence[0].clock, receivedAt=None))
    out = build(change(value, evidence=(evidence, *value.evidence[1:])))
    assert out.status == "research" and out.candidate.evidence[0].clock.receivedAt is None


def test_rationale_cites_only_bound_evidence():
    value = candidate(rationale=(dict(text="Confirmed fixture range", evidenceRefs=("range",)),))
    wire = api().to_wire(build(value), context(), current_candidate=value, now_ms=10000)
    assert wire["rationale"][0]["evidenceRefs"] == ["range"]
    bad = change(value, rationale=(dict(text="Unknown source", evidenceRefs=("foreign",)),))
    with pytest.raises(ResearchRejected):
        build(bad)


def test_observed_fee_claim_requires_a_fee_evidence_source():
    value = candidate()
    out = build(change(value, costs=change(value.costs, origin="OBSERVED")))
    assert out.status == "research" and "COST_EVIDENCE_MISSING" in out.reasonCodes


def test_numeric_false_cannot_replace_fixed_authority_or_native_flags():
    r = api()
    with pytest.raises(ValidationError):
        r.RecommendationAuthorityV1.model_validate(dict(executionAuthorized=0))
    with pytest.raises(ValidationError):
        change(context().profile, nativeAccepted=0)


def test_rules_revision_changes_version_not_the_logical_opportunity_identity():
    first = build()
    value = candidate()
    strategy = change(value.strategy, strategyVersion="paper-v2")
    newer = build(change(value, strategy=strategy))
    assert newer.recommendationId == first.recommendationId
    assert newer.revision != first.revision and newer.semanticHash != first.semanticHash
    assert not newer.canPrepare


def test_cache_requires_current_head_and_rejects_withdrawn_or_revised_sources():
    r = api()
    stored = build()
    for field in ["withdrawn", "revision"]:
        current = candidate()
        source = (
            change(current.evidence[0], withdrawn=True)
            if field == "withdrawn"
            else change(
                current.evidence[0], sourceRef=change(current.evidence[0].sourceRef, revision="v2")
            )
        )
        current = change(current, evidence=(source, *current.evidence[1:]))
        with pytest.raises(ResearchRejected, match="BINDING_MISMATCH"):
            r.read_cached(stored, context(), current_candidate=current, now_ms=11000)


def test_cache_without_a_current_head_is_not_a_valid_read_contract():
    with pytest.raises(TypeError):
        api().read_cached(build(), context(), now_ms=11000)
