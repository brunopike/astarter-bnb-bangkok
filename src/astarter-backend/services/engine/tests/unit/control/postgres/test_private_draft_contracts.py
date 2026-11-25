"""R3: explicit user choices stay private, incomplete and non-executable."""

import copy
import importlib
import json
from hashlib import sha256

import pytest
from pydantic import ValidationError

DAY = 1_794_787_200
NOW = (DAY + 3600) * 1000
OWNER = ("wallet:56:alice", "wallet:56:alice")
BINDING = {"leaseId": "lease", "targetId": "target", "audience": "astarter-research"}


def module():
    try:
        return importlib.import_module("stark_trading_os.control.postgres.private_draft_contracts")
    except ModuleNotFoundError:
        pytest.fail("R3 strict private report-to-draft contract is not implemented")


def content(values=None):
    m = module()
    selected = m.DraftFields.model_validate(fields() if values is None else values)
    return m.DraftContent.model_validate(
        {
            "catalogVersion": m.CATALOG_VERSION,
            "templateVersion": selected.plan_variant + "@paper-v1",
            "parameterOrigin": "user-confirmed",
            "fields": selected.model_dump(by_alias=True),
            "source": m.report_source(
                report_row(), owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW
            ).model_dump(by_alias=True),
            "missingFields": m.missing_fields(selected),
            "executionAuthority": "NONE",
        }
    )


def test_preview_difference_groups_are_exact_ordered_unique_and_bounded():
    m = module()
    c = content()
    groups = ["source"] + ["fields." + key for key in fields()]
    assert m.changed_groups(None, c) == groups and len(groups) == 13
    value = {
        "schema": "private-draft-preview-v1",
        "scope": OWNER[0],
        "draftId": "draft-01",
        "expectedRevision": 0,
        "workspaceRevision": 0,
        "proposalRevision": "a" * 64,
        "listed": False,
        "current": None,
        "proposal": c.model_dump(by_alias=True),
        "changedFields": groups,
    }
    m.DraftPreviewResult.model_validate(value)
    for wrong in ([], groups[::-1], groups[1:], groups + [groups[0]], ["fields.amount.price"]):
        with pytest.raises(ValidationError):
            m.DraftPreviewResult.model_validate(value | {"changedFields": wrong})
    document = {
        "schema": "private-strategy-draft-v1",
        "scope": OWNER[0],
        "draftId": "draft-01",
        "revision": 1,
        "savedAt": NOW,
        "content": c.model_dump(by_alias=True),
    }
    same = value | {"expectedRevision": 1, "current": document, "changedFields": []}
    m.DraftPreviewResult.model_validate(same)
    with pytest.raises(ValidationError):
        m.DraftPreviewResult.model_validate(same | {"expectedRevision": 0})
    assert m.changed_groups(c, content(fields() | {"name": "New"})) == ["fields.name"]


def test_stored_sources_and_document_times_cannot_be_retimed_or_inverted():
    m = module()
    c = content()
    source = c.source.model_dump(by_alias=True)
    for bad in (
        source | {"createdAt": source["validUntil"]},
        source | {"sourceClock": source["sourceClock"] | {"closedAt": DAY + 1}},
    ):
        with pytest.raises(ValidationError):
            m.ReportSource.model_validate(bad)
    document = {
        "schema": "private-strategy-draft-v1",
        "scope": OWNER[0],
        "draftId": "draft-01",
        "revision": 1,
        "savedAt": source["validUntil"],
        "content": c.model_dump(by_alias=True),
    }
    with pytest.raises(ValidationError):
        m.DraftDocument.model_validate(document)


def fields(strategy="S01"):
    return {
        "name": "BTC research draft",
        "strategy": strategy,
        "planVariant": strategy + "-SIM",
        "market": "BTC/USDT",
        "environment": "DEMO",
        "mode": "auto",
        "amount": None,
        "cap": None,
        "researchBudget": None,
        "botParameters": None,
        "protection": None,
        "executionRoute": None,
    }


def filled(strategy="S01"):
    value = fields(strategy) | {
        "amount": 20,
        "cap": 300,
        "researchBudget": 0,
        "protection": {"id": "original", "version": "strategy-original"},
        "executionRoute": {
            "profileId": "cex-spot",
            "venueId": "binance",
            "accountId": "SIM-01",
            "connectionId": "sim-connection",
            "chainId": "",
        },
    }
    value["botParameters"] = (
        {
            "lower": 60000,
            "upper": 70000,
            "count": 4,
            "spacing": "arithmetic",
            "triggerPrice": None,
            "takeProfitPrice": None,
            "stopLossPrice": None,
        }
        if strategy == "S01"
        else {
            "deviationPct": 2,
            "sizeMultiplier": 1.5,
            "maxEntries": 3,
            "takeProfitPct": 2,
            "stopLossPct": 8,
            "triggerPrice": None,
        }
    )
    return value


def report_row(now=NOW, *, owner=OWNER, request="research-01"):
    closed = now // 86400000 * 86400
    source = {
        "symbol": "BTC",
        "source": "Binance Spot",
        "timezone": "UTC",
        "unit": "USDT",
        "period": "1D",
        "methodVersion": "ema20-atr14-rsi14-v1",
        "sampleAt": closed - 86400,
        "closedAt": closed,
        "validUntil": closed + 86400,
        "metrics": {"close": 65000, "changePercent": 1, "ema20DeviationAtr14": 0.5, "rsi14": 55},
        "bars": 250,
    }
    source["id"] = (
        "market-" + sha256(json.dumps(source, separators=(",", ":")).encode()).hexdigest()[:32]
    )
    result = {
        "method": "ai",
        "model": "openai/gpt-4.1-mini",
        "responseId": "synthetic-response",
        "usage": {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150},
        "billing": None,
        "output": {
            "outcome": "watch",
            "headline": "Synthetic closed-bar evidence",
            "summary": "Synthetic research; no executable strategy.",
            "claims": [{"text": "A test claim", "evidenceIds": [source["id"]]}],
        },
        "sources": [source],
        "missingDimensions": ["depth", "macro", "social", "chain", "risk"],
        "createdAt": now - 1000,
        "validUntil": (closed + 86400) * 1000,
        "executionAuthority": "NONE",
        "methodVersion": "closed-market-research-v1",
    }
    return {
        "tenant_id": owner[0],
        "subject_id": owner[1],
        "request_id": request,
        "fingerprint": "a" * 64,
        "lease_id": "lease",
        "state": "complete",
        "result": result,
        "created_at_ms": now - 2000,
        "expires_at_ms": now - 500,
        "finished_at_ms": now - 900,
        "error_code": None,
        "settled_microusd": None,
    }


def test_null_user_choices_are_preserved_and_never_defaulted_from_market_price():
    m = module()
    parsed = m.DraftFields.model_validate(fields())
    assert parsed.model_dump(by_alias=True) == fields()
    assert set(m.missing_fields(parsed)) == {
        "amount",
        "cap",
        "researchBudget",
        "botParameters",
        "protection",
        "executionRoute",
    }
    assert m.DraftFields.model_validate(filled()).strategy == "S01"
    assert m.missing_fields(m.DraftFields.model_validate(filled())) == []


@pytest.mark.parametrize(
    "change",
    [
        {"strategy": "S03", "planVariant": "S03-SIM"},
        {"planVariant": "S02-SIM"},
        {"executionAuthority": "APPROVED"},
        {"environment": "LIVE"},
        {"market": "BTC/USDC"},
        {"amount": True},
        {"cap": float("nan")},
        {"researchBudget": 0.5},
        {"owner": "another-user"},
        {"name": "credential\ntext"},
        {"protection": {"id": "original", "version": "strategy-original", "admin": True}},
    ],
)
def test_extra_authority_wrong_variant_units_and_invalid_values_fail_closed(change):
    with pytest.raises(ValidationError):
        module().DraftFields.model_validate(filled() | change)


def test_required_capital_and_percent_fraction_contracts_are_distinct():
    m = module()
    # Four 20-USDT buys with 0.1% fee need 80.08 USDT, not 80.
    with pytest.raises(ValidationError):
        m.DraftFields.model_validate(filled() | {"cap": 80})
    m.DraftFields.model_validate(filled() | {"cap": 80.08})
    m.DraftFields.model_validate(filled("S02"))
    bad = filled("S02")
    bad["botParameters"]["maxEntries"] = 4
    with pytest.raises(ValidationError):
        m.DraftFields.model_validate(bad)

    bad = filled() | {
        "protection": {
            "id": "astarter",
            "version": "astarter-research-v0.1/sim-3",
            "mode": "normal",
            "parameters": {
                "episode": 0.25,
                "notional": 0.1,
                "daily": 0.02,
                "epoch": 0.05,
                "soft": 0.03,
                "hard": 0.08,
            },
        }
    }
    with pytest.raises(ValidationError):
        m.DraftFields.model_validate(bad)


@pytest.mark.parametrize("reference", ["sk-" + "x" * 24, "0x" + "a" * 64])
def test_connection_reference_rejects_synthetic_credential_shapes(reference):
    value = filled()
    value["executionRoute"]["connectionId"] = reference
    with pytest.raises(ValidationError):
        module().DraftFields.model_validate(value)


def test_connection_reference_preserves_normal_demo_alias():
    value = filled()
    value["executionRoute"]["connectionId"] = "cex-sim:connection-01"
    assert module().DraftFields.model_validate(value).execution_route.connection_id == (
        "cex-sim:connection-01"
    )


def test_source_uses_original_report_clocks_and_ignores_later_billing_settlement():
    m = module()
    row = report_row()
    source = m.report_source(row, owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW)
    assert source.source_request_id == "research-01"
    assert source.created_at == NOW - 1000
    assert source.valid_until == row["result"]["validUntil"]
    assert source.source_clock.closed_at == DAY
    assert source.source_clock.unit == "seconds"
    changed = copy.deepcopy(row)
    changed["settled_microusd"] = 449
    assert (
        m.report_source(changed, owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW + 1)
        == source
    )


def test_node_report_clock_can_follow_pg_completion_without_retiming_source():
    row = report_row()
    row["finished_at_ms"] = row["result"]["createdAt"] - 1
    before = copy.deepcopy(row)
    source = module().report_source(row, owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW)
    assert row == before
    assert source.created_at == row["result"]["createdAt"]
    assert source.valid_until == row["result"]["validUntil"]
    row["finished_at_ms"] += 2
    assert (
        module().report_source(row, owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW)
        == source
    )


@pytest.mark.parametrize(
    "clocks",
    [
        {"finished_at_ms": NOW + 1},
        {"finished_at_ms": NOW - 2001},
        {"created_at_ms": NOW - 999},
        {"report_created": NOW + 1},
        {"report_created": NOW - 2001},
    ],
)
def test_split_clocks_still_reject_future_or_inverted_lifecycles(clocks):
    row = report_row()
    for key, value in clocks.items():
        if key == "report_created":
            row["result"]["createdAt"] = value
        else:
            row[key] = value
    with pytest.raises(ValueError):
        module().report_source(row, owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW)


@pytest.mark.parametrize(
    "case",
    [
        "owner",
        "lease",
        "expired",
        "future",
        "asset",
        "claim",
        "authority",
        "unknown",
        "extra",
        "clock",
        "validity",
    ],
)
def test_source_cannot_be_borrowed_retimed_or_promoted(case):
    row = report_row()
    if case == "owner":
        row["subject_id"] = "bob"
    elif case == "lease":
        row["lease_id"] = "old-lease"
    elif case == "expired":
        row["result"]["validUntil"] = NOW
    elif case == "future":
        row["result"]["createdAt"] = NOW + 1
    elif case == "asset":
        row["result"]["sources"][0]["symbol"] = "ETH"
    elif case == "claim":
        row["result"]["output"]["claims"][0]["evidenceIds"] = ["other"]
    elif case == "authority":
        row["result"]["executionAuthority"] = "APPROVED"
    elif case == "unknown":
        row["state"] = "unknown"
    elif case == "extra":
        row["result"]["strategyId"] = "S01"
    elif case == "clock":
        row["result"]["sources"][0]["closedAt"] = DAY + 86400
    else:
        row["result"]["sources"][0]["validUntil"] += 1
    with pytest.raises(ValueError):
        module().report_source(row, owner=OWNER, lease_id="lease", market="BTC/USDT", now=NOW)


def test_rpc_inputs_never_accept_client_identity_report_or_implicit_versions():
    m = module()
    value = BINDING | {"sourceRequestId": "research-01", "draftId": "draft-01", "fields": fields()}
    assert m.draft_input("drafts/preview", value).source_request_id == "research-01"
    for wrong in (value | {"tenantId": "alice"}, value | {"report": report_row()["result"]}):
        with pytest.raises(ValueError):
            m.draft_input("drafts/preview", wrong)
    with pytest.raises(ValueError):
        m.draft_input("drafts/adopt", value | {"requestId": "command-01"})
