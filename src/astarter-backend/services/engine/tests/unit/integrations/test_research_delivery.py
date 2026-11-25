"""T3-07/08: research reuse never shares account approval or supplier invoices."""

from __future__ import annotations

import json
from typing import Any

import pytest
from test_research_egress import api, raw_request, request


def output() -> Any:
    from stark_trading_os.integrations.contracts import ResearchOutput

    return ResearchOutput(
        stance="OBSERVE",
        summary="Synthetic research only.",
        evidence_ids=("fixture-evidence-1",),
    )


def another(*, private: bool = False, byok: bool = False) -> Any:
    raw = raw_request()
    raw["identity"].update(
        tenant_id="fixture-tenant-b",
        principal_scope_id="fixture-principal-b",
        account_scope_id="fixture-account-b",
        task_id="fixture-task-2",
        attempt_id="fixture-attempt-2",
        logical_request_id="fixture-root-2",
    )
    raw["task"]["task_id"] = "fixture-task-2"
    if private:
        raw["context"]["classification"] = "PRIVATE"
    if byok:
        raw["context"]["funding"] = "BYOK"
    return api().prepare_fixture(raw)


def artifact(req: Any | None = None) -> Any:
    return api("research_delivery").make_artifact(
        request() if req is None else req,
        output(),
        artifact_id="fixture-artifact",
        created_at_ms=2200,
    )


def test_t3_07_public_key_shared_across_tenants_without_control_or_billing_fields() -> None:
    d = api("research_delivery")
    first, second = request(), another()
    assert d.semantic_key(first) == d.semantic_key(second)
    item = artifact(first)
    checked = d.check_artifact(second, item, now_ms=2300, clock_epoch="fixture-clock-v1")
    assert checked.output.summary == "Synthetic research only."
    serialized = checked.model_dump_json()
    for forbidden in [
        "fixture-platform",
        "fixture-tenant-a",
        "fixture-principal-a",
        "fixture-account-a",
        "fixture-attempt-1",
        "cost_credits",
        "reservation",
    ]:
        assert forbidden not in serialized


@pytest.mark.parametrize("classification,funding", [("PRIVATE", "PLATFORM"), ("PUBLIC", "BYOK")])
def test_t3_07_private_and_byok_cannot_share_across_principal_or_account(
    classification: str,
    funding: str,
) -> None:
    e, d = api(), api("research_delivery")
    raw = raw_request()
    raw["context"].update(classification=classification, funding=funding)
    first = e.prepare_fixture(raw)
    item = artifact(first)
    for field in ["tenant_id", "principal_scope_id", "account_scope_id"]:
        changed = json.loads(json.dumps(raw))
        changed["identity"][field] = "fixture-other"
        second = e.prepare_fixture(changed)
        assert d.semantic_key(first) != d.semantic_key(second)
        with pytest.raises(e.ResearchRejected):
            d.check_artifact(second, item, now_ms=2300, clock_epoch="fixture-clock-v1")


@pytest.mark.parametrize("kind", ["source", "rights", "policy", "strategy", "role"])
def test_t3_07_text_equality_is_not_semantic_or_license_equality(kind: str) -> None:
    e, d = api(), api("research_delivery")
    raw = raw_request()
    if kind in {"source", "rights"}:
        raw["bindings"][0][kind + "_revision"] = "v2"
    elif kind == "policy":
        raw["policy"]["revision"] = "v2"
    elif kind == "strategy":
        raw["context"]["strategy_revision"] = "fixture-other"
    else:
        raw["task"]["role_id"] = "A02"
    with pytest.raises(e.ResearchRejected):
        d.check_artifact(
            e.prepare_fixture(raw), artifact(), now_ms=2300, clock_epoch="fixture-clock-v1"
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("output_sha256", "0" * 64),
        ("use_until_ms", 12000),
        ("created_at_ms", 2400),
        ("key_owner_id", "fixture-sensitive-sentinel"),
    ],
)
def test_t3_07_forged_hash_time_or_private_metadata_is_rejected(field: str, value: Any) -> None:
    e, d = api(), api("research_delivery")
    bad = artifact().model_copy(update={field: value})
    with pytest.raises(e.ResearchRejected):
        d.check_artifact(request(), bad, now_ms=2300, clock_epoch="fixture-clock-v1")


def test_t3_04_cache_usage_not_extended_by_reads_and_not_bound_to_spent_grant() -> None:
    e, d = api(), api("research_delivery")
    item = artifact()
    assert item.use_until_ms == 11000
    assert (
        d.check_artifact(request(), item, now_ms=9500, clock_epoch="fixture-clock-v1").use_until_ms
        == 11000
    )
    raw = raw_request()
    raw["deadline_ms"] = 12000
    raw["quote"]["valid_until_ms"] = 2100
    later = e.prepare_fixture(raw)
    assert (
        d.check_artifact(later, item, now_ms=2300, clock_epoch="fixture-clock-v1").output
        == output()
    )
    with pytest.raises(e.ResearchRejected):
        d.check_artifact(later, item, now_ms=11000, clock_epoch="fixture-clock-v1")


def test_t3_08_cache_delivery_has_no_new_dispatch_or_supplier_charge() -> None:
    d = api("research_delivery")
    item = artifact()
    result = d.ready_delivery(item, origin="CACHE", dispatch_started=False)
    assert result.status == "READY"
    assert result.origin == "CACHE"
    assert result.dispatch_started is False
    assert "usage" not in result.model_dump()
    assert "cost_credits" not in result.model_dump_json()


def test_t3_08_delivery_and_artifact_invariants_fail_closed() -> None:
    e, d = api(), api("research_delivery")
    with pytest.raises(e.ResearchRejected):
        d.ready_delivery(artifact(), origin="CACHE", dispatch_started=True)
    bad = output().model_copy(update={"evidence_ids": ("fixture-invented",)})
    with pytest.raises(e.ResearchRejected):
        d.make_artifact(request(), bad, artifact_id="fixture-artifact", created_at_ms=2200)
