"""Independent Q01-C offline contract expectations; synthetic inputs only."""

import builtins
import hashlib
import io
import json
import os
import socket
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.domain.s03_signal import S03Parameters

PACKET = json.loads(
    (Path(__file__).parents[2] / "fixtures/q01_c_registry_v1.json").read_text()
)
IDS = (
    "S00", "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09-A", "S09-L",
    "RX01", "RX02-P", "RX02-A", "RX03-S", "RX03-B", "RX04", "RX05", "S02-VP",
)
ROLES = ("A01", "A02", "A07", "A10", "A12", "A14", "A15", "A16", "A13")
CAPS = ("LIMIT_IOC", "SELL_STOP_MARKET_GTC_BID_ASK", "SELL_MARKET_IOC")


def text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def changed(obj, **updates):
    return type(obj).model_validate(obj.model_dump() | updates)


def strategy(sid="S03", parameters=None):
    row = next(row for row in PACKET["entries"] if row["id"] == sid)
    identity = c.StrategyIdentity(
        strategy_id=sid,
        kind="S03_ORIGINAL" if sid == "S03" else "VP" if sid == "S02-VP" else "RESEARCH",
        version=row["version"],
    )
    return c.StrategySpec(
        identity=identity, profile=c.catalog_profile(sid), parameter_revision="parameters-v1",
        abc=c.ABCReference(identity=identity),
        parameters=(parameters or S03Parameters()) if sid == "S03" else None,
        frozen_defaults_json=None if sid == "S03" else text(row["defaults"]),
    )


def plan(sid="S03", parameters=None):
    return c.PlanRevision(
        plan_id="fixture-plan", revision="plan-v1", spec=strategy(sid, parameters),
        binding=c.PrivateBinding(
            tenant_id="tenant-a", account_id="account-a", environment="OFFLINE"
        ),
        instrument=c.InstrumentProfile(
            profile_id="fixture-btc", revision="instrument-v1", native_id="BTC/USDT.SIM",
            venue="SIM", base="BTC", quote="USDT", product="SPOT", fee_currency="USDT",
            fee_revision="fee-v1", tick="0.01", step="0.00001",
            min_quantity="0.0001", min_notional="5",
            multiplier="1", maker_fee="0.001", taker_fee="0.001",
        ),
        data_profile_revision="data-v1", capability_profile_revision="cap-v1",
        risk_policy_revision="risk-v1", starts_at_ms=900, expires_at_ms=5000,
    )


def evidence(kind, name, subject, revision, **updates):
    return c.EvidenceSnapshot.model_validate(dict(
        evidence_id="fixture-" + name, kind=kind, name=name, profile_revision=revision,
        subject_sha256=subject, content_sha256="b" * 64, origin="SYNTHETIC_REFERENCE",
        status="PASS", source_id="fixture-source", source_revision="source-v1",
        source_product="SPOT", source_instrument_id="BTC/USDT.SIM",
        source_venue="SIM", source_chain=None,
        coverage="COMPLETE_REFERENCE", rights_revision="rights-v1", use_allowed=True,
        share_allowed=True, classification="PUBLIC", funding="PLATFORM", binding=None,
        window_start_ms=100, window_end_ms=800, event_at_ms=800, available_at_ms=850,
        received_at_ms=900, expires_at_ms=5000, rights_until_ms=5000, max_age_ms=2000,
    ) | updates)


def approval(p, calls=6, roles=ROLES):
    ph = c.contract_hash(p)
    return c.ApprovalSnapshot(
        reference_id="fixture-review", issuer_reference="NOT-A-TRUSTED-ISSUER",
        plan_revision=p.revision, plan_sha256=ph, binding=p.binding,
        risk_policy_revision=p.risk_policy_revision, starts_at_ms=900, expires_at_ms=4000,
        research_call_budget=calls,
        duties=tuple(c.DutyEvidence(
            role=role, method="SIMULATED_PRIVATE_REVIEW_REF",
            source=evidence("REVIEW", role, ph, "Q01_S03_NINE_DUTIES_REF_V1",
                            classification="PRIVATE", share_allowed=False, binding=p.binding),
        ) for role in roles),
    )


def ready():
    p = plan()
    ih = c.contract_hash(p.instrument)
    observations = (
        *(evidence("DATA", name, ih, "data-v1") for name in
          ("MARKET_WINDOW", "NEWS_HEALTH", "S03_CONTINUOUS_BARS")),
        *(evidence("CAPABILITY", name, ih, "cap-v1") for name in CAPS),
        evidence("FEES", "FEE_SCHEDULE", ih, "fee-v1"),
    )
    p = changed(p, evidence_sha256s=tuple(c.contract_hash(e) for e in observations))
    return c.PreflightInput(plan=p, evidence=observations, approval=approval(p))


def budget(**updates):
    return c.BudgetSnapshot.model_validate(dict(
        simulation=c.SimBudget(atoms=1000000),
        supplier=c.SupplierBudget(unit="USD", provider="fixture-provider", meter="tokens",
                                  meter_revision="meter-v1", scale=6, cost_atoms=None,
                                  liability="UNKNOWN_PENDING_RECONCILE"),
        customer=c.CustomerBudget(atoms=0, state="RELEASED_REFERENCE"),
        payer="BYOK", upstream_retry_responsibility="UNRESOLVED",
        key_valid=True, within_limits=True,
    ) | updates)


def test_identical_request_is_a_replay_not_new_work():
    request = c.Request(key="fixture-request-1", payload_sha256="a" * 64)
    assert c.check_replay(request, request) == "REPLAY"


def test_registry_identity_count_and_s03_source_mapping():
    assert tuple(row["id"] for row in PACKET["entries"]) == IDS
    row = next(row for row in PACKET["entries"] if row["id"] == "S03")
    defaults = row["defaults"].copy()
    for key, value in PACKET["s03_mapping"]["fixed_source_only"].items():
        assert defaults.pop(key) == value
    assert defaults["notional_fraction"] == "0.20"
    defaults["notional_fraction"] = "0.2"
    assert S03Parameters(**defaults) == S03Parameters()
    assert c.S03Parameters is S03Parameters
    with pytest.raises(ValueError):
        S03Parameters(notional_fraction="0.20")


@pytest.mark.parametrize("sid", IDS)
def test_all_19_frozen_profiles_and_missing_evidence_block(sid):
    s = strategy(sid)
    row = next(row for row in PACKET["entries"] if row["id"] == sid)
    assert s.profile.defaults_sha256 == hashlib.sha256(text(row["defaults"]).encode()).hexdigest()
    assert s.profile.source_sha256 == PACKET["source_sha256"]
    assert s.identity.version == row["version"]
    result = c.preflight(c.PreflightInput(plan=plan(sid)), now_ms=1000)
    assert result.status == "BLOCKED"
    assert not result.execution_authorized
    assert result.fast_path_llm_calls == 0
    if sid == "S01":
        assert "LIMIT_GTC_POST_ONLY" in s.profile.required_capabilities
    elif sid == "S09-A":
        assert s.profile.product == "CHAIN" and "ATOMIC_ROUTE" in s.profile.required_capabilities
    elif sid == "S09-L":
        assert s.profile.product == "LP" and "CLMM_POSITION" in s.profile.required_capabilities
    else:
        assert s.profile.required_capabilities == CAPS
    if sid != "S03":
        for invalid in (row["defaults"] | {"unknown": 1}, {}, row["defaults"] | {"ema_fast": 6}):
            with pytest.raises(ValueError):
                changed(s, frozen_defaults_json=text(invalid))


@pytest.mark.parametrize("sid,kind,version", [
    ("S03", "RESEARCH", "research-v0.1"), ("S02-VP", "RESEARCH", "research-v0.1"),
    ("SMA", "S03_ORIGINAL", "sma-cross-long-flat@v1"),
    ("S03", "S03_ORIGINAL", "s03-ema-rsi-long-flat@v2"),
    ("S99", "RESEARCH", "research-v0.1"),
])
def test_unknown_and_cross_kind_versions_rejected(sid, kind, version):
    with pytest.raises(ValueError):
        c.StrategyIdentity(strategy_id=sid, kind=kind, version=version)


def test_sma_and_composition_are_separate_nonexecuting_references():
    sma = c.StrategyIdentity(strategy_id="SMA", kind="SMA_LEGACY_REF",
                             version="sma-cross-long-flat@v1")
    assert not sma.execution_authorized
    with pytest.raises(ValueError):
        changed(strategy(), identity=sma, abc=c.ABCReference(identity=sma))
    original = strategy()
    identity = changed(
        original.identity, kind="ASTARTER_COMPOSITION", version=c.COMPOSITION_VERSION
    )
    composed = changed(original, identity=identity, abc=c.ABCReference(identity=identity))
    assert c.contract_hash(original) != c.contract_hash(composed)
    r = ready()
    result = c.preflight(changed(r, plan=changed(r.plan, spec=composed)), now_ms=1000)
    assert result.status == "RESEARCH_ONLY"


@pytest.mark.parametrize("changes", [
    {"ema_fast": 10, "ema_slow": 60}, {"risk_fraction": "0.004", "notional_fraction": "0.1"},
    {"rsi_cross": "55", "rsi_ceiling": "70", "rsi_fail": "40"},
    {"stop_atr": "3", "hold_boundaries": 12, "cooldown_full_bars": 4},
])
def test_s03_nondefault_parameters_reuse_actual_domain_and_invalidate_approval(changes):
    p = plan()
    new_spec = changed(
        p.spec, parameters=S03Parameters(**changes), parameter_revision="parameters-v2"
    )
    new = changed(p, spec=new_spec, revision="plan-v2")
    assert c.check_revision(p, new) == c.contract_hash(new)
    assert c.check_approval(new, approval(p), now_ms=1000).status == "BLOCKED"
    assert new.spec.parameters.parameters_sha256 != p.spec.parameters.parameters_sha256


@pytest.mark.parametrize("changes", [
    {"ema_fast": True}, {"ema_fast": 50}, {"ema_slow": 251}, {"risk_fraction": 0.005},
    {"risk_fraction": "NaN"}, {"notional_fraction": "0.21"}, {"stop_atr": "0.5"},
    {"rsi_cross": "66"}, {"unknown": 1},
])
def test_s03_forged_nested_parameters_rejected_at_public_boundary(changes):
    r = ready()
    params = S03Parameters().model_copy(update=changes)
    bad_spec = r.plan.spec.model_copy(update={"parameters": params})
    forged = r.model_copy(update={"plan": r.plan.model_copy(update={"spec": bad_spec})})
    with pytest.raises(ValueError):
        c.preflight(forged, now_ms=1000)
    with pytest.raises(ValueError):
        c.contract_hash(forged)


def test_revision_reuse_cannot_hide_parameter_changes():
    p = plan()
    altered = changed(p, spec=changed(p.spec, parameters=S03Parameters(ema_fast=10)))
    with pytest.raises(ValueError, match="NEW_PLAN_REVISION"):
        c.check_revision(p, altered)
    with pytest.raises(ValueError, match="NEW_PARAMETER_REVISION"):
        c.check_revision(p, changed(altered, revision="plan-v2"))


@pytest.mark.parametrize("calls", [0, 6, 8, 12])
def test_valid_private_evidence_reuse_does_not_require_nine_new_calls(calls):
    r = ready()
    a = changed(r.approval, research_call_budget=calls)
    for now in (1000, 1100):
        result = c.preflight(changed(r, approval=a), now_ms=now)
        assert result.status == "ELIGIBLE"
        assert result.reasons == ("OFFLINE_REFERENCE_MATCH_ONLY",)
        assert result.execution_authorized is False
    assert c.preflight(changed(r, approval=a), now_ms=4000).status == "BLOCKED"


@pytest.mark.parametrize("calls", [6, 8, 12])
@pytest.mark.parametrize("missing_role", ROLES)
def test_call_count_and_role_names_never_replace_each_required_duty(calls, missing_role):
    p = plan()
    a = approval(p, calls, tuple(role for role in ROLES if role != missing_role))
    decision = c.check_approval(p, a, now_ms=1000)
    assert decision.status == "BLOCKED"
    assert missing_role in decision.missing_roles


@pytest.mark.parametrize("field,value", [
    ("revision", "plan-v2"), ("risk_policy_revision", "risk-v2"),
    ("data_profile_revision", "data-v2"), ("capability_profile_revision", "cap-v2"),
    ("plan_id", "other-plan"),
])
def test_approval_binds_all_plan_dependencies(field, value):
    p = plan()
    result = c.check_approval(changed(p, **{field: value}), approval(p), now_ms=1000)
    assert result.status == "BLOCKED"


@pytest.mark.parametrize("field,value", [
    ("tenant_id", "tenant-b"), ("account_id", "account-b"), ("environment", "PAPER"),
])
def test_private_scope_not_portable(field, value):
    p = plan()
    other = changed(p, binding=changed(p.binding, **{field: value}))
    assert c.check_approval(other, approval(p), now_ms=1000).status == "BLOCKED"


@pytest.mark.parametrize("field,value", [
    ("method", "ROLE_STRING_ONLY"), ("method", "MODEL_CONCLUSION"),
    ("method", "DETERMINISTIC_RULE"), ("role_semantics_revision", "roles-v2"),
])
def test_unsupported_methods_or_role_semantics_fail_closed(field, value):
    p = plan()
    a = approval(p)
    duty = a.duties[0].model_copy(update={field: value})
    with pytest.raises(ValueError):
        c.check_approval(p, a.model_copy(update={"duties": (duty, *a.duties[1:])}), now_ms=1000)


@pytest.mark.parametrize("field,value", [
    ("origin", "BACKEND_REFERENCE_UNVERIFIED"), ("status", "UNKNOWN"),
    ("status", "BLOCK"), ("use_allowed", False), ("rights_until_ms", 1000),
    ("expires_at_ms", 1000), ("max_age_ms", 100), ("coverage", "UNKNOWN"),
    ("profile_revision", "wrong-v2"), ("subject_sha256", "c" * 64),
])
def test_source_and_capability_claims_are_not_trusted_success(field, value):
    r = ready()
    e = changed(r.evidence[3], **{field: value})
    observations = (*r.evidence[:3], e, *r.evidence[4:])
    # Rebuild all local hashes: even internally consistent self-claims cannot
    # override missing rights, unknown results, expiry or unresolved issuer.
    p = changed(r.plan, evidence_sha256s=tuple(c.contract_hash(x) for x in observations))
    result = c.preflight(
        changed(r, plan=p, evidence=observations, approval=approval(p)), now_ms=1000
    )
    assert result.status == "BLOCKED"
    assert "LIMIT_IOC" in result.missing_capabilities


def test_source_manifest_and_current_source_time_not_refreshable_by_hashing():
    r = ready()
    e = changed(r.evidence[0], source_revision="source-v2")
    observations = (e, *r.evidence[1:])
    assert "EVIDENCE_MANIFEST_MISMATCH" in c.preflight(
        changed(r, evidence=observations), now_ms=1000
    ).reasons
    p = changed(r.plan, evidence_sha256s=tuple(c.contract_hash(x) for x in observations))
    assert c.check_approval(p, r.approval, now_ms=1000).status == "BLOCKED"
    # A caller cannot extend the original S03 2-second market freshness bound.
    observations = tuple(changed(x, max_age_ms=86400000) for x in r.evidence)
    p = changed(r.plan, evidence_sha256s=tuple(c.contract_hash(x) for x in observations))
    assert "SOURCE_STALE" in c.preflight(
        changed(r, plan=p, evidence=observations, approval=approval(p)), now_ms=3000
    ).reasons


@pytest.mark.parametrize("bad", ["PERP", "CHAIN", "LP"])
def test_execution_product_identity_cannot_be_swapped(bad):
    r = ready()
    i = changed(r.plan.instrument, product=bad)
    result = c.preflight(changed(r, plan=changed(r.plan, instrument=i)), now_ms=1000)
    assert "INSTRUMENT_IDENTITY_MISMATCH" in result.reasons


def test_no_instrument_no_fees_no_data_no_approval_are_blocked():
    r = ready()
    missing = changed(r, plan=changed(r.plan, instrument=None))
    assert c.preflight(missing, now_ms=1000).status == "BLOCKED"
    i = changed(r.plan.instrument, maker_fee=None)
    missing = changed(r, plan=changed(r.plan, instrument=i))
    assert c.preflight(missing, now_ms=1000).status == "BLOCKED"
    assert c.preflight(changed(r, evidence=()), now_ms=1000).status == "BLOCKED"
    assert c.preflight(changed(r, approval=None), now_ms=1000).status == "BLOCKED"


def test_private_byok_evidence_cannot_be_public_approval():
    p = plan()
    source = approval(p).duties[0].source
    with pytest.raises(ValueError):
        changed(source, classification="PUBLIC")
    with pytest.raises(ValueError):
        changed(source, classification="PUBLIC", binding=None, share_allowed=True, funding="BYOK")
    public = changed(source, classification="PUBLIC", binding=None, share_allowed=True)
    a = approval(p)
    a = changed(a, duties=(changed(a.duties[0], source=public), *a.duties[1:]))
    assert c.check_approval(p, a, now_ms=1000).status == "BLOCKED"


@pytest.mark.parametrize("bad", [True, 1.0, "1000", -1])
def test_explicit_strict_clock(bad):
    with pytest.raises(ValueError):
        c.preflight(ready(), now_ms=bad)


def test_immutability_and_nested_model_construct_model_copy_boundaries():
    r = ready()
    old_hash = c.contract_hash(r)
    wire = r.model_dump()
    wire["plan"]["spec"]["parameters"]["ema_fast"] = 10
    assert c.contract_hash(r) == old_hash
    with pytest.raises(ValueError):
        r.plan.spec.parameters.ema_fast = 10
    with pytest.raises(ValueError):
        c.preflight(r.model_copy(update={"evidence": list(r.evidence)}), now_ms=1000)
    fake = c.InstrumentProfile.model_construct(**(r.plan.instrument.model_dump() | {"tick": 0.1}))
    with pytest.raises(ValueError):
        forged = r.model_copy(update={"plan": r.plan.model_copy(update={"instrument": fake})})
        c.preflight(forged, now_ms=1000)
    with pytest.raises(ValueError):
        c.preflight(r.model_copy(update={"supported": True}), now_ms=1000)
    # Bypass frozen=True with hostile Python mutation: every use must revalidate.
    object.__getattribute__(r.plan.spec.parameters, "__dict__")["ema_fast"] = False
    with pytest.raises(ValueError):
        c.contract_hash(r)


def test_subclasses_and_oversized_or_extra_input_are_rejected():
    class Pretend(c.Request):
        pass

    with pytest.raises(ValueError):
        c.check_replay(None, Pretend(key="k", payload_sha256="a" * 64))
    with pytest.raises(ValueError):
        c.Request(key="k" * 129, payload_sha256="a" * 64)
    with pytest.raises(ValueError):
        changed(ready(), evidence=ready().evidence * 6)
    for bad in (True, 0, 1):
        with pytest.raises(ValueError):
            c.Request(key="k", payload_sha256="a" * 64, execution_authorized=bad)


@pytest.mark.parametrize("field,value", [
    ("lifecycle", "FILLED"), ("order", "ELIGIBLE"),
    ("protection", "ACK"), ("reconciliation", "ACTIVE_REFERENCE"),
])
def test_state_domains_not_interchangeable(field, value):
    data = dict(lifecycle="PAUSED", order="UNKNOWN", protection="UNKNOWN", reconciliation="UNKNOWN")
    with pytest.raises(ValueError):
        c.StateSnapshot(**(data | {field: value}))


def test_unknown_ack_and_insufficient_protection_never_release_risk():
    for order in ("UNKNOWN", "ACK", "PARTIAL", "FILLED"):
        s = c.StateSnapshot(lifecycle="PAUSED", order=order, protection="INSUFFICIENT",
                            reconciliation="UNKNOWN")
        result = c.state_policy(s)
        assert result.new_risk_blocked and not result.risk_release_allowed
        assert result.preserve_protection and result.allow_exit_reconciliation_checks


@pytest.mark.parametrize("unit", ["USD", "points", "CU", "USDT", "ASTARTER_CREDITS"])
def test_simulation_credit_unit_not_reinterpreted(unit):
    with pytest.raises(ValueError):
        c.SimBudget(unit=unit, atoms=1)


@pytest.mark.parametrize("bad", [1.0, float("nan"), float("inf"), "1", True, -1])
def test_exact_budget_atoms_reject_floats_nonfinite_and_coercion(bad):
    with pytest.raises(ValueError):
        c.SimBudget(atoms=bad)
    with pytest.raises(ValueError):
        changed(budget().supplier, cost_atoms=bad, liability="OBSERVED_REFERENCE")


def test_three_units_and_versions_are_not_interchangeable():
    b = budget()
    assert b.simulation.scale == 6
    with pytest.raises(ValueError):
        c.budget_policy(b.model_copy(update={"customer": b.simulation}))
    with pytest.raises(ValueError):
        c.budget_policy(b.model_copy(update={"simulation": b.customer}))
    with pytest.raises(ValueError):
        changed(b.supplier, unit="ASTARTER_CREDITS")
    for field in ("provider", "meter", "meter_revision"):
        with pytest.raises(ValueError):
            changed(b.supplier, **{field: ""})
    with pytest.raises(ValueError):
        changed(b.simulation, scale=0)
    with pytest.raises(ValueError):
        changed(b.customer, version="unversioned")


def test_customer_release_and_zero_byok_do_not_erase_supplier_liability_or_retry_payer():
    for key_valid, within_limits in ((True, True), (False, True), (True, False)):
        b = budget(key_valid=key_valid, within_limits=within_limits)
        result = c.budget_policy(b)
        assert result.new_research_blocked and result.supplier_liability_unresolved
        assert not result.automatic_charged_retry_allowed
        assert result.transaction_actions == ()
        assert result.preserve_protection and result.allow_exit_reconciliation_checks
        assert b.customer.atoms == 0 and b.supplier.cost_atoms is None and b.payer == "BYOK"
    with pytest.raises(ValueError):
        changed(b.supplier, cost_atoms=0)


def test_actual_payload_hash_replay_conflicts_without_global_state():
    r = ready()
    old = c.request_for("request-1", r)
    assert c.check_replay(None, old) == "NEW"
    assert c.check_replay(old, c.request_for("request-1", r)) == "REPLAY"
    altered = changed(r, plan=changed(r.plan, revision="plan-v2"))
    with pytest.raises(ValueError, match="REQUEST_PAYLOAD_CONFLICT"):
        c.check_replay(old, c.request_for("request-1", altered))
    assert c.check_replay(None, old) == "NEW"


@pytest.mark.parametrize("sid", IDS)
def test_complete_synthetic_profiles_never_implement_research_algorithms(sid):
    if sid == "S03":
        assert c.preflight(ready(), now_ms=1000).status == "ELIGIBLE"
        return
    p = plan(sid)
    profile = p.spec.profile
    assert p.instrument is not None
    i = changed(p.instrument, base=profile.base, product=profile.product,
                native_id="BTCUSDT" if sid == "RX05" else p.instrument.native_id,
                quote="USDT" if profile.product == "SPOT" else "USDC",
                venue="BINANCE" if sid == "RX05" else "SIM",
                chain="eip155:1" if profile.product in {"CHAIN", "LP"} else None,
                pool="synthetic-pool" if profile.product in {"CHAIN", "LP"} else None)
    ih = c.contract_hash(i)
    observations = (
        *(evidence("DATA", n, ih, "data-v1", source_product=i.product,
                   source_instrument_id=i.native_id,
                   source_chain=i.chain, source_venue=i.venue) for n in profile.required_data),
        *(evidence("CAPABILITY", n, ih, "cap-v1", source_product=i.product,
                   source_instrument_id=i.native_id,
                   source_chain=i.chain, source_venue=i.venue)
          for n in profile.required_capabilities),
        evidence("FEES", "FEE_SCHEDULE", ih, "fee-v1", source_product=i.product,
                 source_instrument_id=i.native_id,
                 source_chain=i.chain, source_venue=i.venue),
    )
    if sid in {"RX05", "RX03-S", "RX03-B"}:
        special = changed(
            observations[2], source_product="PERP" if sid == "RX05" else "CHAIN",
            source_chain=None if sid == "RX05" else "eip155:1" if sid == "RX03-S" else "BITCOIN",
            source_instrument_id="BTCUSDT-PERP" if sid == "RX05" else "synthetic-distinct-source",
            source_base="BTC" if sid == "RX05" else None,
            source_quote="USDT" if sid == "RX05" else None,
            source_settlement="USDT" if sid == "RX05" else None,
        )
        observations = (*observations[:2], special, *observations[3:])
    p = changed(p, instrument=i, evidence_sha256s=tuple(c.contract_hash(e) for e in observations))
    result = c.preflight(c.PreflightInput(plan=p, evidence=observations), now_ms=1000)
    assert result.status == "RESEARCH_ONLY"
    assert result.execution_authorized is False


@pytest.mark.parametrize("field,value", [
    ("role_schema_revision", "roles-v2"), ("research_call_budget", True),
    ("research_call_budget", 6.0), ("research_call_budget", 9),
])
def test_invalid_approval_version_or_call_budget_not_coerced(field, value):
    p = plan()
    with pytest.raises(ValueError):
        c.check_approval(p, approval(p).model_copy(update={field: value}), now_ms=1000)


def test_duty_content_window_and_supported_claim_cannot_replace_evidence():
    p = plan()
    a = approval(p)
    for updates in (
        {"status": "UNKNOWN"}, {"rights_until_ms": 1000},
        {"subject_sha256": "d" * 64}, {"profile_revision": "wrong-roles"},
        {"origin": "BACKEND_REFERENCE_UNVERIFIED"},
    ):
        duty = changed(a.duties[0], source=changed(a.duties[0].source, **updates))
        bad = changed(a, duties=(duty, *a.duties[1:]))
        result = c.check_approval(p, bad, now_ms=1000)
        assert result.status == "BLOCKED" and "A01" in result.missing_roles
    with pytest.raises(ValueError):
        changed(a, duties=(*a.duties, a.duties[0]))
    with pytest.raises(ValueError):
        changed(a.duties[0].source, supported=True)
    with pytest.raises(ValueError):
        changed(a.duties[0].source, window_start_ms=801)
    with pytest.raises(ValueError):
        c.request_for("key", c.SimBudget(atoms=0))


def test_data_source_product_and_future_clock_not_usable():
    r = ready()
    for updates in ({"source_product": "PERP"}, {"source_instrument_id": "ETH/USDT.SIM"},
                    {"received_at_ms": 1200}):
        observations = (changed(r.evidence[0], **updates), *r.evidence[1:])
        p = changed(r.plan, evidence_sha256s=tuple(c.contract_hash(e) for e in observations))
        result = c.preflight(changed(r, plan=p, evidence=observations,
                                    approval=approval(p)), now_ms=1000)
        assert result.status == "BLOCKED"


def test_existing_sim_budget_quote_receipt_scale_six_compatibility():
    from stark_trading_os.integrations.research_egress import BudgetQuote, ResearchIdentity
    from stark_trading_os.integrations.research_gate import BudgetReceipt

    ident = ResearchIdentity(
        logical_request_id="request", task_id="task", attempt_id="attempt",
        parent_attempt_id=None, tenant_id="tenant", principal_scope_id="principal",
        account_scope_id="account", key_owner_id="owner", credential_binding_revision="fixture-v1",
        purpose="OFFLINE_FIXTURE",
    )
    quote = BudgetQuote(quote_id="quote", revision="v1", unit_id="SIM_MODEL_CREDIT_V1", scale=6,
                        reserve_atoms=1234567, pricing_revision="v1", coverage_revision="v1",
                        valid_until_ms=5000)
    receipt = BudgetReceipt(
        reservation_id="reservation", identity=ident, request_sha256="e" * 64, version=1,
        state="UNKNOWN_PENDING_RECONCILE", unit_id="SIM_MODEL_CREDIT_V1", scale=6,
        reserve_atoms=1234567, charged_atoms=None, settlement_ref=None,
    )
    new = c.SimBudget(atoms=1234567)
    assert new.unit == quote.unit_id == receipt.unit_id
    assert new.scale == quote.scale == receipt.scale == 6
    assert new.atoms == quote.reserve_atoms == receipt.reserve_atoms
    assert receipt.charged_atoms is None


def test_public_functions_perform_no_io_or_clock_read_after_fixture_construction(monkeypatch):
    r = ready()
    rx = rx05_ready()
    rx_wrong = reseal_observations(rx, (
        *rx.evidence[:2], changed(rx.evidence[2], source_base="ETH"), *rx.evidence[3:]
    ))
    b = budget()
    s = c.StateSnapshot(lifecycle="PAUSED", order="UNKNOWN", protection="UNKNOWN",
                        reconciliation="UNKNOWN")

    def forbidden(*args, **kwargs):
        raise AssertionError("IO_OR_CLOCK_FORBIDDEN")

    with monkeypatch.context() as guard:
        for obj, name in (
            (builtins, "open"), (io, "open"), (os, "open"), (socket, "socket"),
            (socket, "getaddrinfo"), (socket, "create_connection"), (sqlite3, "connect"),
            (subprocess, "Popen"), (time, "time"),
        ):
            guard.setattr(obj, name, forbidden)
        assert c.preflight(r, now_ms=1000).status == "ELIGIBLE"
        assert c.preflight(rx, now_ms=1000).status == "RESEARCH_ONLY"
        assert c.preflight(rx_wrong, now_ms=1000).status == "BLOCKED"
        assert c.check_approval(r.plan, r.approval, now_ms=1000).status == "ELIGIBLE"
        assert c.check_revision(r.plan, r.plan) == c.contract_hash(r.plan)
        assert c.catalog_profile("S03").strategy_id == "S03"
        assert c.budget_policy(b).transaction_actions == ()
        assert c.state_policy(s).risk_release_allowed is False
        request = c.request_for("offline-only", r)
        assert c.check_replay(request, request) == "REPLAY"


def rx05_ready():
    p = plan("RX05")
    i = changed(p.instrument, native_id="BTCUSDT", venue="BINANCE")
    ih = c.contract_hash(i)
    observations = (
        *(evidence("DATA", n, ih, "data-v1", source_instrument_id=i.native_id,
                   source_venue=i.venue) for n in p.spec.profile.required_data),
        *(evidence("CAPABILITY", n, ih, "cap-v1", source_instrument_id=i.native_id,
                   source_venue=i.venue) for n in p.spec.profile.required_capabilities),
        evidence("FEES", "FEE_SCHEDULE", ih, "fee-v1", source_instrument_id=i.native_id,
                 source_venue=i.venue),
    )
    special = changed(observations[2], source_product="PERP",
                      source_instrument_id="BTCUSDT-PERP", source_base="BTC",
                      source_quote="USDT", source_settlement="USDT")
    observations = (*observations[:2], special, *observations[3:])
    p = changed(p, instrument=i, evidence_sha256s=tuple(c.contract_hash(e) for e in observations))
    return c.PreflightInput(plan=p, evidence=observations)


def reseal_observations(r, observations):
    p = changed(r.plan, evidence_sha256s=tuple(c.contract_hash(e) for e in observations))
    return changed(r, plan=p, evidence=observations,
                   approval=approval(p) if r.approval is not None else None)


def rebind_instrument(r, instrument):
    observations = tuple(changed(e, subject_sha256=c.contract_hash(instrument)) for e in r.evidence)
    return reseal_observations(
        changed(r, plan=changed(r.plan, instrument=instrument)), observations
    )


def test_reviewfix1_rx05_wrong_asset_native_reference_is_blocked():
    r = rx05_ready()
    assert c.preflight(r, now_ms=1000).status == "RESEARCH_ONLY"
    e = changed(r.evidence[2], source_instrument_id="ETHUSDT-PERP")
    bad = reseal_observations(r, (*r.evidence[:2], e, *r.evidence[3:]))
    decision = c.preflight(bad, now_ms=1000)
    assert decision.status == "BLOCKED"
    assert "DATA_EVIDENCE_MISSING_OR_INVALID" in decision.reasons


@pytest.mark.parametrize("field", ["min_quantity", "min_notional"])
def test_reviewfix1_each_minimum_fact_is_required(field):
    r = ready()
    assert r.plan.instrument is not None
    wire = r.plan.instrument.model_dump()
    wire.pop(field, None)
    incomplete = c.InstrumentProfile.model_validate(wire)
    bad = rebind_instrument(r, incomplete)
    decision = c.preflight(bad, now_ms=1000)
    assert decision.status == "BLOCKED"
    assert "INSTRUMENT_OR_FEES_MISSING" in decision.reasons


@pytest.mark.parametrize("received,expected", [(900, "ELIGIBLE"), (901, "BLOCKED"),
                                               (1100, "BLOCKED")])
def test_reviewfix1_received_must_not_postdate_approval_start(received, expected):
    r = ready()
    assert r.approval is not None
    a = changed(r.approval, duties=tuple(
        changed(d, source=changed(d.source, received_at_ms=received)) for d in r.approval.duties
    ))
    assert a.starts_at_ms == 900
    assert all(d.source.available_at_ms == 850 for d in a.duties)
    decision = c.check_approval(r.plan, a, now_ms=1200)
    assert decision.status == expected
    assert c.preflight(changed(r, approval=a), now_ms=1200).status == expected
    if expected == "BLOCKED":
        assert decision.missing_roles == ROLES
        assert "INVALID_DUTY_EVIDENCE" in decision.reasons


@pytest.mark.parametrize("order", ["PENDING", "ACK"])
def test_reviewfix1_active_inflight_order_blocks_new_risk(order):
    s = c.StateSnapshot(lifecycle="ACTIVE_REFERENCE", order=order,
                        protection="NOT_REQUIRED", reconciliation="MATCHED_REFERENCE")
    result = c.state_policy(s)
    assert result.new_risk_blocked
    assert not result.risk_release_allowed
    assert result.preserve_protection and result.allow_exit_reconciliation_checks


@pytest.mark.parametrize("calls", [0, 6, 8, 12])
def test_reviewfix1_composition_has_no_original_approval_adapter(calls):
    r = ready()
    identity = changed(r.plan.spec.identity, kind="ASTARTER_COMPOSITION",
                       version="q01-c-s03-astarter@v1")
    spec = changed(r.plan.spec, identity=identity, abc=c.ABCReference(identity=identity))
    p = changed(r.plan, spec=spec)
    a = approval(p, calls=calls)
    assert c.preflight(changed(r, plan=p, approval=a), now_ms=1000).status == "RESEARCH_ONLY"
    decision = c.check_approval(p, a, now_ms=1000)
    assert decision.status == "BLOCKED"
    assert decision.reasons == ("NO_REVIEW_ADAPTER",)
    assert not decision.execution_authorized


@pytest.mark.parametrize("field,value", [
    ("source_base", "ETH"), ("source_quote", "USDC"), ("source_settlement", "BTC"),
    ("source_venue", "OKX"), ("source_product", "SPOT"), ("source_product", "CHAIN"),
    ("source_product", "LP"), ("source_chain", "BITCOIN"),
    ("source_instrument_id", "BTCUSDC-PERP"), ("source_instrument_id", "BTCUSD-INVERSE"),
    ("source_instrument_id", "opaque-unregistered"), ("source_instrument_id", "BTCUSDT"),
    ("source_base", None), ("source_quote", None), ("source_settlement", None),
])
def test_reviewfix1_rx05_rehashed_wrong_or_missing_identity_is_not_adapter_pending(field, value):
    r = rx05_ready()
    e = changed(r.evidence[2], **{field: value})
    assert c.contract_hash(e) != c.contract_hash(r.evidence[2])
    bad = reseal_observations(r, (*r.evidence[:2], e, *r.evidence[3:]))
    result = c.preflight(bad, now_ms=1000)
    assert result.status == "BLOCKED"
    assert result.reasons == ("DATA_EVIDENCE_MISSING_OR_INVALID",)
    assert not result.execution_authorized


@pytest.mark.parametrize("field", ["source_base", "source_quote", "source_settlement"])
def test_reviewfix1_rx05_omitted_normalized_identity_is_blocked(field):
    r = rx05_ready()
    wire = r.evidence[2].model_dump()
    wire.pop(field)
    e = c.EvidenceSnapshot.model_validate(wire)
    bad = reseal_observations(r, (*r.evidence[:2], e, *r.evidence[3:]))
    assert c.preflight(bad, now_ms=1000).status == "BLOCKED"


@pytest.mark.parametrize("field", ["source_instrument_id", "source_product", "source_venue"])
def test_reviewfix1_rx05_missing_required_reference_rejected_at_public_boundary(field):
    r = rx05_ready()
    wire = r.evidence[2].model_dump()
    wire.pop(field)
    e = c.EvidenceSnapshot.model_construct(**wire)
    bad = r.model_copy(update={"evidence": (*r.evidence[:2], e, *r.evidence[3:])})
    with pytest.raises(ValueError):
        c.preflight(bad, now_ms=1000)


@pytest.mark.parametrize("field,value", [
    ("native_id", "ETHUSDT"), ("base", "ETH"), ("quote", "USDC"),
    ("venue", "OKX"), ("product", "PERP"),
])
def test_reviewfix1_rx05_execution_side_must_match_frozen_correspondence(field, value):
    r = rx05_ready()
    bad = rebind_instrument(r, changed(r.plan.instrument, **{field: value}))
    assert c.preflight(bad, now_ms=1000).status == "BLOCKED"


def test_reviewfix1_minima_are_separate_base_quantity_and_quote_notional():
    r = ready()
    i = r.plan.instrument
    assert i is not None and r.approval is not None
    assert (i.min_quantity, i.base) == ("0.0001", "BTC")
    assert (i.min_notional, i.quote) == ("5", "USDT")
    assert "min_order" not in i.model_dump()
    assert c.preflight(r, now_ms=1000).status == "ELIGIBLE"
    with pytest.raises(ValueError):
        changed(i, min_order="5")
    # Q03 permits an explicit zero notional floor, not a missing fact or zero quantity.
    zero_notional = rebind_instrument(r, changed(i, min_notional="0"))
    assert c.preflight(zero_notional, now_ms=1000).status == "ELIGIBLE"
    with pytest.raises(ValueError):
        changed(i, min_quantity="0")
    for field, value in (("min_quantity", "0.001"), ("min_notional", "10")):
        new = rebind_instrument(r, changed(i, **{field: value}))
        assert c.contract_hash(new.plan) != c.contract_hash(r.plan)
        assert c.check_approval(new.plan, r.approval, now_ms=1000).status == "BLOCKED"
        assert c.preflight(new, now_ms=1000).status == "ELIGIBLE"


@pytest.mark.parametrize("field", ["min_quantity", "min_notional"])
def test_reviewfix1_null_minimum_is_missing_not_zero(field):
    r = ready()
    bad = rebind_instrument(r, changed(r.plan.instrument, **{field: None}))
    assert c.preflight(bad, now_ms=1000).status == "BLOCKED"


@pytest.mark.parametrize("field", ["min_quantity", "min_notional"])
@pytest.mark.parametrize("value", [True, 0.0001, "NaN", "Infinity", "-1"])
def test_reviewfix1_forged_minimum_rejected_without_coercion(field, value):
    r = ready()
    assert r.plan.instrument is not None
    i = r.plan.instrument.model_copy(update={field: value})
    bad = r.model_copy(update={"plan": r.plan.model_copy(update={"instrument": i})})
    with pytest.raises(ValueError):
        c.preflight(bad, now_ms=1000)


@pytest.mark.parametrize("role", ROLES)
def test_reviewfix1_each_duty_must_have_been_received_at_approval(role):
    r = ready()
    for calls in (0, 6, 8, 12):
        a = approval(r.plan, calls=calls)
        assert c.check_approval(r.plan, a, now_ms=900).status == "ELIGIBLE"
        late = changed(a, duties=tuple(
            changed(d, source=changed(d.source, received_at_ms=901)) if d.role == role else d
            for d in a.duties
        ))
        result = c.check_approval(r.plan, late, now_ms=1200)
        assert result.status == "BLOCKED"
        assert result.missing_roles == (role,)
        assert c.preflight(changed(r, approval=late), now_ms=1200).status == "BLOCKED"
        assert all(d.source.available_at_ms == 850 for d in late.duties)
        assert next(d for d in late.duties if d.role == role).source.received_at_ms == 901


@pytest.mark.parametrize("received", [850, 899, 900])
def test_reviewfix1_already_received_evidence_is_reusable(received):
    r = ready()
    assert r.approval is not None
    a = changed(r.approval, duties=tuple(
        changed(d, source=changed(d.source, received_at_ms=received)) for d in r.approval.duties
    ))
    for now in (900, 1200):
        assert c.check_approval(r.plan, a, now_ms=now).status == "ELIGIBLE"


@pytest.mark.parametrize("protection", ["NOT_REQUIRED", "SUFFICIENT_REFERENCE"])
@pytest.mark.parametrize("order,blocked", [
    ("NONE", False), ("PENDING", True), ("ACK", True), ("PARTIAL", True),
    ("FILLED", False), ("CANCELLED", False), ("UNKNOWN", True),
])
def test_reviewfix1_state_projection_preserves_exit_and_protection(order, blocked, protection):
    s = c.StateSnapshot(lifecycle="ACTIVE_REFERENCE", order=order, protection=protection,
                        reconciliation="MATCHED_REFERENCE")
    result = c.state_policy(s)
    assert result.new_risk_blocked is blocked
    assert result.risk_release_allowed is False
    assert result.preserve_protection and result.allow_exit_reconciliation_checks
    assert result.execution_authorized is False


def test_reviewfix1_approval_does_not_accept_other_kinds_or_forged_original_version():
    for sid in ("RX05", "S02-VP"):
        p = plan(sid)
        result = c.check_approval(p, approval(p), now_ms=1000)
        assert result.status == "BLOCKED"
        assert result.reasons == ("NO_REVIEW_ADAPTER",)
    p = plan()
    identity = p.spec.identity.model_copy(update={"version": "s03-ema-rsi-long-flat@v2"})
    spec = p.spec.model_copy(update={"identity": identity})
    with pytest.raises(ValueError):
        c.check_approval(p.model_copy(update={"spec": spec}), approval(p), now_ms=1000)
