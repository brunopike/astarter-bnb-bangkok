"""T3-01/02/04/10: precise immutable fixture inputs, never real authorization."""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import traceback
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).parents[2] / "fixtures" / "data-model-ports-t3"


def api(name: str = "research_egress") -> Any:
    path = "stark_trading_os.integrations." + name
    assert importlib.util.find_spec(path) is not None, f"T3 component absent: {name}"
    return importlib.import_module(path)


def raw_request() -> dict[str, Any]:
    return json.loads((FIXTURES / "scenarios.v1.json").read_text())["request"]


def request(**changes: Any) -> Any:
    raw = raw_request()
    raw.update(changes)
    return api().prepare_fixture(raw)


def grant(req: Any, **changes: Any) -> Any:
    e = api()
    values = dict(
        grant_id="fixture-grant",
        grant_revision="v1",
        issuer_revision="fixture-issuer-v1",
        revocation_epoch=0,
        identity=req.spec.identity,
        request_sha256=e.request_digest(req),
        payload_sha256=req.payload_sha256,
        evidence=req.spec.bindings,
        model_policy_id=req.spec.policy.policy_id,
        model_policy_revision=req.spec.policy.revision,
        model=req.spec.policy.model,
        dispatch_before_ms=9000,
        quote_id=req.spec.quote.quote_id,
        quote_revision=req.spec.quote.revision,
    )
    return e.EgressGrant(**(values | changes))


def test_t3_01_fixture_byte_identity_is_exact_and_no_private_control_in_payload() -> None:
    e = api()
    req = request()
    checked = e.check_request(req, now_ms=2000, clock_epoch="fixture-clock-v1")
    assert checked.payload_sha256 == hashlib.sha256(checked.payload.encode()).hexdigest()
    body = json.loads(checked.payload)
    assert body["format"] == "FIXTURE_REQUEST_V1"
    assert body["task"]["evidence"][0]["text"] == "Synthetic BTC public observation"
    assert "fixture-tenant-a" not in checked.payload
    assert "fixture-platform" not in checked.payload
    assert checked.spec.task.evidence[0].available_at_ms == 1000
    assert e.check_grant(req, grant(req), now_ms=2000).grant_id == "fixture-grant"


@pytest.mark.parametrize(
    "field,value",
    [
        ("utf8_sha256", "0" * 64),
        ("available_at_ms", 999),
        ("valid_until_ms", 12000),
        ("evidence_id", "fixture-other"),
        ("egress_allowed", False),
        ("use_allowed", False),
        ("share_allowed", False),
        ("classification", "PRIVATE"),
    ],
)
def test_t3_01_rejects_evidence_bytes_times_rights_and_public_private_mix(
    field: str,
    value: Any,
) -> None:
    e = api()
    raw = raw_request()
    raw["bindings"][0][field] = value
    with pytest.raises(e.ResearchRejected):
        e.prepare_fixture(raw)


@pytest.mark.parametrize(
    "field,value",
    [
        ("request_sha256", "0" * 64),
        ("payload_sha256", "0" * 64),
        ("model", "fixture/other"),
        ("model_policy_revision", "v2"),
        ("quote_revision", "v2"),
        ("dispatch_before_ms", 2000),
    ],
)
def test_t3_02_grant_cannot_be_rebound(field: str, value: Any) -> None:
    e = api()
    req = request()
    with pytest.raises(e.ResearchRejected):
        e.check_grant(req, grant(req, **{field: value}), now_ms=2000)


@pytest.mark.parametrize(
    "field",
    [
        "tenant_id",
        "principal_scope_id",
        "account_scope_id",
        "key_owner_id",
        "credential_binding_revision",
        "logical_request_id",
        "attempt_id",
        "task_id",
    ],
)
def test_t3_02_identity_changes_invalidate_grant(field: str) -> None:
    e = api()
    req = request()
    changed = req.spec.identity.model_copy(update={field: "fixture-other"})
    with pytest.raises(e.ResearchRejected):
        e.check_grant(req, grant(req, identity=changed), now_ms=2000)


@pytest.mark.parametrize("change", ["provider", "schema", "system", "source", "version"])
def test_t3_01_payload_and_source_revision_cannot_reuse_old_grant(change: str) -> None:
    e = api()
    req = request()
    raw = raw_request()
    if change == "provider":
        raw["policy"]["providers"] = ["fixture-other"]
    elif change in {"schema", "system"}:
        raw["policy"][change + "_sha256"] = "1" * 64
    elif change == "source":
        raw["bindings"][0]["source_id"] = "fixture-source-b"
    else:
        raw["bindings"][0]["rights_revision"] = "v2"
    with pytest.raises(e.ResearchRejected):
        e.check_grant(e.prepare_fixture(raw), grant(req), now_ms=2000)


@pytest.mark.parametrize(
    "now,epoch",
    [(999, "fixture-clock-v1"), (10000, "fixture-clock-v1"), (2000, "fixture-clock-v2")],
)
def test_t3_04_no_future_evidence_expiry_or_recovered_clock_extension(
    now: int,
    epoch: str,
) -> None:
    e = api()
    with pytest.raises(e.ResearchRejected):
        e.check_request(request(), now_ms=now, clock_epoch=epoch)


@pytest.mark.parametrize("mutation", ["nan", "float", "negative", "unit", "scale", "large"])
def test_t3_10_only_exact_nonnegative_synthetic_budget_units(mutation: str) -> None:
    e = api()
    raw = raw_request()
    if mutation == "unit":
        raw["quote"]["unit_id"] = "USD"
    elif mutation == "scale":
        raw["quote"]["scale"] = 3
    else:
        raw["quote"]["reserve_atoms"] = {
            "nan": "NaN",
            "float": 0.1,
            "negative": -1,
            "large": 2**127,
        }[mutation]
    with pytest.raises(e.ResearchRejected):
        e.prepare_fixture(raw)


@pytest.mark.parametrize("kind", ["external", "fallback", "duplicate", "extra", "bool"])
def test_t3_12_rejects_real_purpose_fallback_and_coercion(kind: str) -> None:
    e = api()
    raw = raw_request()
    if kind == "external":
        raw["identity"]["purpose"] = "EXTERNAL_OBSERVATION"
    elif kind == "fallback":
        raw["policy"]["allow_fallbacks"] = True
    elif kind == "duplicate":
        raw["bindings"].append(raw["bindings"][0].copy())
    elif kind == "extra":
        raw["confirmed"] = True
    else:
        raw["quote"]["reserve_atoms"] = True
    with pytest.raises(e.ResearchRejected):
        e.prepare_fixture(raw)


def test_t3_01_subclasses_custom_equality_and_errors_never_echo_inputs() -> None:
    e = api()
    req = request()
    called: list[str] = []

    class Hostile(str):
        def __eq__(self, other: object) -> bool:
            called.append("eq")
            return True

    bad = req.model_copy(update={"payload_sha256": Hostile("fixture-sensitive-sentinel")})
    try:
        e.check_request(bad, now_ms=2000, clock_epoch="fixture-clock-v1")
    except e.ResearchRejected as exc:
        formatted = "".join(traceback.format_exception(exc))
        assert "fixture-sensitive-sentinel" not in formatted
        assert exc.__context__ is None
        assert exc.__cause__ is None
    else:
        pytest.fail("hostile primitive accepted")
    assert called == []


def test_t3_01_fixture_manifest_matches_complete_bytes() -> None:
    manifest = json.loads((FIXTURES / "manifest.v1.json").read_text())
    assert manifest["purpose"] == "OFFLINE_FIXTURE"
    for entry in manifest["files"]:
        assert (
            hashlib.sha256((FIXTURES / entry["name"]).read_bytes()).hexdigest() == entry["sha256"]
        )
