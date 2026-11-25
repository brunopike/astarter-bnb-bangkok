"""Independent R1 review counterexamples, asserted against real pure code."""

import pytest

from stark_trading_os.audit.hash_chain import canonical_sha256
from tests.unit.domain.test_opportunity_recommendations import (
    api,
    build,
    candidate,
    change,
    clock_ref,
    context,
)


def test_required_profile_parameter_cannot_be_omitted_and_valid_value_prepares():
    value, ctx = candidate(), context()
    parameter = dict(name="spacing", unit="bps", minimum="2", maximum="3")
    ctx = change(ctx, profile=change(ctx.profile, parameters=(parameter,)))
    missing = build(value, ctx)
    assert missing.status == "research" and not missing.canPrepare
    assert "PARAMETER_MISSING" in missing.reasonCodes
    complete = change(value, parameters=(parameter | dict(value="2.5", evidenceRef="range"),))
    assert build(complete, ctx).status == "preparable"


@pytest.mark.parametrize("product", ["PERP", "CHAIN", "LP"])
def test_spot_variant_cannot_be_enabled_for_another_product_by_consistent_dto_copies(product):
    value, ctx = candidate(), context()
    instrument = change(value.instrument, product=product, native_id="BTCUSDT-OTHER")
    value = change(
        value,
        instrument=instrument,
        direction="short",
        evidence=tuple(change(e, instrument=instrument) for e in value.evidence),
    )
    ctx = change(ctx, profile=change(ctx.profile, instrument=instrument))
    out = build(value, ctx)
    assert out.status == "blocked" and not out.canPrepare
    assert "STRATEGY_PRODUCT_MISMATCH" in out.reasonCodes


def test_or03_and_or15_neutral_spot_grid_positive_is_not_rewritten_to_long():
    out = build(candidate(direction="neutral"))
    assert out.status == "preparable" and out.canPrepare
    assert out.candidate.direction == "neutral" and out.candidate.strategy.strategy == "S01"


def test_known_fee_negative_edge_is_blocked_even_when_other_costs_are_unknown():
    value = candidate()
    out = build(change(value, costs=change(value.costs, state="UNKNOWN", edgeBps="10")))
    assert out.status == "blocked" and "COST_INFEASIBLE" in out.reasonCodes


def test_empty_evidence_never_claims_complete_coverage():
    value = candidate(
        evidence=(), entry=None, invalidation=None, exits=None, protection=None, rationale=()
    )
    value = change(value, costs=change(value.costs, state="UNKNOWN", evidenceRefs=()))
    row = build(value)
    wire = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    assert wire["coverage"]["complete"] is False


@pytest.mark.parametrize("kind", ["SIM", "REPLAY"])
def test_generation_utc_is_metadata_not_simulated_source_clock_time(kind):
    value, ctx = candidate(), context()
    ref = clock_ref(kind, "test-epoch")
    value = change(
        value,
        generatedAt=1794129606828,
        clockRef=ref,
        evidence=tuple(change(e, clock=change(e.clock, clockRef=ref)) for e in value.evidence),
    )
    ctx = change(ctx, clockRef=ref)
    out = build(value, ctx)
    assert out.status == "preparable" and out.canPrepare
    wire = api().to_wire(out, ctx, current_candidate=value, now_ms=10000)
    assert wire["generatedAt"] == 1794129606828
    assert wire["clockKind"] == ("sim" if kind == "SIM" else "historical")


def test_read_before_publication_is_rejected_even_if_the_current_head_changed():
    from stark_trading_os.integrations.research_egress import ResearchRejected

    value = candidate()
    row = build(value)
    head = change(value, sourceRef=change(value.sourceRef, revision="new-head"))
    with pytest.raises(ResearchRejected, match="CLOCK_INVALID"):
        api().to_wire(row, context(), current_candidate=head, now_ms=9000)


def immutable(wire):
    return {k: v for k, v in wire.items() if k != "currentEligibility"}


def test_canonical_public_content_hash_binds_the_full_immutable_wire_snapshot():
    value = candidate()
    wire = api().to_wire(build(value), context(), current_candidate=value, now_ms=10000)
    frozen = immutable(wire)
    assert frozen["contentHash"] == canonical_sha256(
        {k: v for k, v in frozen.items() if k != "contentHash"}
    )


def test_expiry_only_changes_current_eligibility_not_the_published_dto():
    value = candidate()
    row = build(value)
    first = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    expired = api().to_wire(row, context(), current_candidate=value, now_ms=13000)
    assert immutable(first) == immutable(expired)
    assert first["status"] == expired["status"] == "preparable"
    assert first["currentEligibility"]["canPrepare"] is True
    assert expired["currentEligibility"]["status"] == "blocked"
    assert expired["currentEligibility"]["canPrepare"] is False
    assert "EXPIRED" in expired["currentEligibility"]["reasonCodes"]


def test_cache_read_does_not_upgrade_a_published_blocked_snapshot_when_time_passes():
    value = candidate()
    future = change(value.evidence[0].clock, receivedAt=11000, availableAt=11100)
    value = change(value, evidence=(change(value.evidence[0], clock=future), *value.evidence[1:]))
    row = build(value, now=10000)
    assert row.status == "blocked"
    later = api().read_cached(row, context(), current_candidate=value, now_ms=12000)
    assert later.status == "blocked" and not later.canPrepare
    first = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    second = api().to_wire(later, context(), current_candidate=value, now_ms=12000)
    assert immutable(first) == immutable(second)
    assert second["currentEligibility"]["canPrepare"] is False


def test_wire_parameter_keys_evaluation_enum_and_actual_rule_version_match_v1():
    value, ctx = candidate(), context()
    parameter = dict(name="spacing", unit="bps", minimum="2", maximum="3")
    value = change(value, parameters=(parameter | dict(value="2.5", evidenceRef="range"),))
    ctx = change(ctx, profile=change(ctx.profile, parameters=(parameter,)))
    wire = api().to_wire(build(value, ctx), ctx, current_candidate=value, now_ms=10000)
    assert wire["parameters"] == [
        dict(key="spacing", value="2.5", unit="bps", evidenceRefs=["range"])
    ]
    assert wire["entry"]["evaluation"] == "TRUE"
    assert wire["entry"]["ruleRef"]["version"] == "rules-v1"
    assert wire["entry"]["ruleRef"]["version"] != ctx.profile.revision


def test_retracted_current_head_keeps_old_content_and_explains_its_hard_veto():
    value = candidate()
    row = build(value)
    first = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    withdrawn = change(
        value, evidence=(change(value.evidence[0], withdrawn=True), *value.evidence[1:])
    )
    later = api().to_wire(row, context(), current_candidate=withdrawn, now_ms=11000)
    assert immutable(first) == immutable(later)
    assert later["currentEligibility"]["status"] == "blocked"
    assert "RECOMMENDATION_REVISION_CHANGED" in later["currentEligibility"]["reasonCodes"]
    assert "SOURCE_WITHDRAWN" in later["currentEligibility"]["reasonCodes"]


def test_replay_reuses_first_public_generation_version_and_canonical_hash():
    value = candidate()
    row = build(value)
    first = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    retry = change(value, generatedAt=1794129606828)
    cached = api().read_cached(row, context(), current_candidate=retry, now_ms=11000)
    repeated = api().to_wire(cached, context(), current_candidate=retry, now_ms=11000)
    assert immutable(first) == immutable(repeated)
    assert repeated["generatedAt"] == value.generatedAt


def test_historical_read_path_does_not_bypass_scope_authorization():
    from stark_trading_os.integrations.research_egress import ResearchRejected

    value, ctx = candidate(), context()
    private = dict(
        visibility="PRIVATE",
        tenant_id="tenant-a",
        principal_scope_id="user-a",
        account_scope_id="account-a",
    )
    private_value = change(value, visibility=private)
    private_ctx = change(ctx, visibility=private, risk=change(ctx.risk, visibility=private))
    row = build(private_value, private_ctx)
    with pytest.raises(ResearchRejected, match="DENIED"):
        api().to_wire(row, ctx, current_candidate=value, now_ms=10000)


def test_future_utc_result_cannot_be_published_before_its_generation_time():
    value = candidate(generatedAt=20000)
    row = build(value, now=10000)
    assert row.status == "blocked" and not row.canPrepare
    assert "RESULT_NOT_YET_AVAILABLE" in row.reasonCodes


def test_coverage_keeps_catalog_requirements_when_a_required_source_is_missing():
    value = candidate()
    value = change(value, evidence=tuple(e for e in value.evidence if e.dataKind != "NEWS_HEALTH"))
    row = build(value)
    assert row.status == "research" and "DATA_MISSING" in row.reasonCodes
    wire = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    assert set(wire["coverage"]["requiredData"]) == {"MARKET_WINDOW", "NEWS_HEALTH", "RANGE_BARS"}
    assert set(wire["coverage"]["providedData"]) == {"MARKET_WINDOW", "RANGE_BARS"}
    assert wire["coverage"]["complete"] is False


def test_unknown_catalog_cannot_claim_complete_coverage_from_a_nonempty_evidence_list():
    value = candidate()
    value = change(value, strategy=change(value.strategy, strategy="unknown-family"))
    row = build(value)
    wire = api().to_wire(row, context(), current_candidate=value, now_ms=10000)
    assert wire["coverage"]["complete"] is False
