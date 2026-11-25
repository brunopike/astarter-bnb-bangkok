"""Offline receipt admission; no schema discovery, provider IO or authorization."""

import importlib
import importlib.util
from typing import Any

import pytest

from stark_trading_os.integrations.assistant_tools import SOURCE_ID, FixtureToolRequest
from stark_trading_os.integrations.research_egress import ResearchRejected
from stark_trading_os.integrations.transport import MAX_RESPONSE_BYTES
from tests.stubs.assistant_fixture_receipts import (
    fixture_request,
    receipt_bytes,
    receipt_document,
)
from tests.stubs.assistant_tools import RECEIVED_AT_MS

MODULE = "stark_trading_os.integrations.assistant_fixture_receipts"


def admission() -> Any:
    assert importlib.util.find_spec(MODULE) is not None, "B1c receipt admission is missing"
    return importlib.import_module(MODULE).admit_fixture_receipt


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["rest_fixture", "mcp_fixture"])
async def test_admitted_receipt_preserves_fixture_identity_precision_and_source_clocks(
    channel: str,
) -> None:
    admit = admission()
    document = await receipt_document(channel)
    result = admit(
        fixture_request(),
        receipt_bytes(document),
        expected_transport=channel,
        now_ms=RECEIVED_AT_MS,
    )
    assert result.request_id == "receipt-btc" and result.data.status == "OK"
    assert result.capability.state == "not_connected" and result.capability.transport == "fixture"
    assert result.capability.verified_at_ms is None and result.capability.granted_scopes == ()
    assert not result.execution_authorized and result.purpose == "OFFLINE_FIXTURE"
    assert result.data.provider_id == result.data.provenance.provider_id == SOURCE_ID
    assert result.data.provenance.purpose == "OFFLINE_FIXTURE"
    assert result.data.snapshot.last_price == "65000.12000000"
    assert result.data.snapshot.base_volume == "12.34000000"
    assert result.data.snapshot.quote_volume == "802101.48080000"
    assert result.data.provenance.source_event_at_ms == 1700000000000
    assert result.data.provenance.received_at_ms == 1700000002000
    assert result.data.provenance.available_at_ms == 1700000002000
    assert result.valid_until_ms == 1700000007001
    assert (
        result.data.provenance.raw_sha256
        == document["response"]["data"]["provenance"]["raw_sha256"]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["rest_fixture", "mcp_fixture"])
async def test_body_cannot_select_a_different_server_channel(channel: str) -> None:
    document = await receipt_document(channel)
    other = "mcp_fixture" if channel == "rest_fixture" else "rest_fixture"
    with pytest.raises(ResearchRejected, match="BINDING_MISMATCH"):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport=other,
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"schema_version": "AstarterAssistantFixtureReceipt.v2"},
        {"transport": "mcp"},
        {"tool_id": "place_order"},
        {"tool_id": "cancel_order"},
        {"tool_id": "astarter.fixture.mcp.btc-24h.v1"},
        {"coverage": "S03_CONTINUOUS_BARS"},
        {"coverage": "LEVEL_2"},
        {"tenant_scope": "PRIVATE"},
        {"purpose": "EXTERNAL_OBSERVATION"},
        {"execution_authorized": True},
        {"account_binding_id": "synthetic-private-marker"},
        {"token": "synthetic-private-marker"},
        {"url": "https://synthetic-private-marker.invalid"},
        {"granted_scopes": ["Trade"]},
        {"annotations": {"readOnlyHint": True, "instruction": "synthetic-private-marker"}},
    ],
)
async def test_schema_tool_coverage_and_authority_are_closed(change: dict[str, Any]) -> None:
    document = (await receipt_document()) | change
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT") as caught:
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )
    assert "synthetic-private-marker" not in str(caught.value)
    assert caught.value.__context__ is None


@pytest.mark.asyncio
@pytest.mark.parametrize("level", ["outer", "inner", "request"])
async def test_request_correlation_cannot_be_rebound(level: str) -> None:
    document = await receipt_document()
    request = fixture_request("other" if level == "request" else "receipt-btc")
    if level == "outer":
        document["request_id"] = "other"
    if level == "inner":
        document["response"]["request_id"] = "other"
    with pytest.raises(ResearchRejected):
        admission()(
            request,
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["venue", "symbol", "base_asset", "market_kind"])
async def test_tampered_instrument_is_rejected_instead_of_projected(field: str) -> None:
    document = await receipt_document()
    instrument = document["response"]["data"]["instrument"]
    instrument[field] = {
        "venue": "OKX",
        "symbol": "ETHUSDT",
        "base_asset": "ETH",
        "market_kind": "PERP",
    }[field]
    with pytest.raises(ResearchRejected):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["provider", "purpose", "future", "expiry", "ready", "disabled"])
async def test_nested_response_cannot_override_b1a_source_time_or_readiness(case: str) -> None:
    document = await receipt_document()
    response = document["response"]
    if case == "provider":
        response["data"]["provider_id"] = "binance-spot-ticker-v1"
        response["data"]["provenance"]["provider_id"] = "binance-spot-ticker-v1"
    elif case == "purpose":
        response["data"]["provenance"]["purpose"] = "EXTERNAL_OBSERVATION"
    elif case == "future":
        response["data"]["provenance"]["source_event_at_ms"] = RECEIVED_AT_MS + 63
        response["data"]["snapshot"]["window_close_at_ms"] = RECEIVED_AT_MS + 63
    elif case == "expiry":
        response["valid_until_ms"] += 1000
    elif case == "ready":
        response["capability"]["state"] = "ready"
    else:
        response["capability"].update(
            enabled=False, state="unavailable", transport=None, reason_code="INTEGRATION_DISABLED"
        )
    with pytest.raises(ResearchRejected):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
async def test_consumption_rechecks_exclusive_expiry_without_changing_source_times() -> None:
    raw = receipt_bytes(await receipt_document())
    fresh = admission()(
        fixture_request(), raw, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS + 5000
    )
    stale = admission()(
        fixture_request(), raw, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS + 5001
    )
    assert fresh.data.status == "OK" and stale.data.status == "STALE"
    assert fresh.data.snapshot == stale.data.snapshot
    assert fresh.data.provenance == stale.data.provenance
    assert fresh.valid_until_ms == stale.valid_until_ms == 1700000007001
    assert stale.checked_at_ms == 1700000007001


@pytest.mark.asyncio
@pytest.mark.parametrize("now", [True, -1, 1.5, "1700000002000", RECEIVED_AT_MS - 1])
async def test_invalid_or_earlier_consumer_clock_does_not_admit_a_future_receipt(now: Any) -> None:
    raw = receipt_bytes(await receipt_document())
    with pytest.raises(ResearchRejected, match="CLOCK_INVALID"):
        admission()(fixture_request(), raw, expected_transport="rest_fixture", now_ms=now)


@pytest.mark.asyncio
async def test_receipt_checked_clock_is_bound_even_if_its_data_could_be_valid() -> None:
    document = await receipt_document()
    document["response"]["checked_at_ms"] += 1
    with pytest.raises(ResearchRejected, match="CLOCK_INVALID"):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status",
    [
        "RATE_LIMITED",
        "TIMEOUT",
        "UNAVAILABLE",
        "UNAUTHORIZED",
        "BUDGET_EXCEEDED",
        "INVALID_RESPONSE",
        "MISSING",
    ],
)
async def test_failed_read_preserves_status_retry_and_never_becomes_a_snapshot(status: str) -> None:
    document = await receipt_document("mcp_fixture")
    document["response"]["data"].update(
        status=status, snapshot=None, provenance=None, retry_after_seconds=60.25
    )
    document["response"]["valid_until_ms"] = None
    result = admission()(
        fixture_request(),
        receipt_bytes(document),
        expected_transport="mcp_fixture",
        now_ms=RECEIVED_AT_MS,
    )
    assert result.data.status == status and result.data.retry_after_seconds == 60.25
    assert result.data.snapshot is None and result.data.provenance is None
    assert result.valid_until_ms is None and result.capability.state == "not_connected"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"[]",
        b"{",
        b'{"x":NaN}',
        b'{"x":1,"x":2}',
        b" " * (MAX_RESPONSE_BYTES + 1),
        "synthetic-private-marker",
        bytearray(b"{}"),
    ],
)
async def test_wire_boundary_is_bounded_and_never_echoes_untrusted_input(body: Any) -> None:
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT") as caught:
        admission()(
            fixture_request(), body, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS
        )
    assert "synthetic-private-marker" not in str(caught.value) and caught.value.__context__ is None


@pytest.mark.asyncio
async def test_duplicate_nested_fields_are_rejected_before_dto_projection() -> None:
    raw = receipt_bytes(await receipt_document())
    raw = raw.replace(
        b'"last_price":"65000.12000000"', b'"last_price":"65000.12000000","last_price":"1"'
    )
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT"):
        admission()(
            fixture_request(), raw, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS
        )


@pytest.mark.asyncio
async def test_request_canonicalization_refuses_forged_dto_and_detaches_valid_tree() -> None:
    raw = receipt_bytes(await receipt_document())
    request = fixture_request()
    forged = request.model_copy(update={"purpose": "EXTERNAL_OBSERVATION"})
    with pytest.raises(ResearchRejected):
        admission()(forged, raw, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS)
    result = admission()(request, raw, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS)
    object.__setattr__(request.instrument, "venue", "OKX")
    assert result.data.instrument.venue == "BINANCE"
    assert result.data.snapshot.instrument.venue == "BINANCE"
    private_request = FixtureToolRequest(request_id="receipt-btc", capability="account")
    with pytest.raises(ResearchRejected):
        admission()(private_request, raw, expected_transport="rest_fixture", now_ms=RECEIVED_AT_MS)


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", [None, True, "mcp", "rest", "unknown"])
async def test_unknown_server_channel_does_not_dispatch_or_accept_a_body(channel: Any) -> None:
    with pytest.raises(ResearchRejected, match="INVALID_INPUT"):
        admission()(
            fixture_request(),
            receipt_bytes(await receipt_document()),
            expected_transport=channel,
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("retry", [True, False, "60.25", "0"])
async def test_original_json_retry_type_cannot_be_hidden_by_dto_coercion(retry: Any) -> None:
    document = await receipt_document()
    document["response"]["data"].update(
        status="RATE_LIMITED",
        snapshot=None,
        provenance=None,
        retry_after_seconds=retry,
    )
    document["response"]["valid_until_ms"] = None
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT"):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("price", ["0", "0.00000000"])
async def test_raw_receipt_cannot_bypass_adapter_positive_price_rule(price: str) -> None:
    document = await receipt_document()
    document["response"]["data"]["snapshot"]["last_price"] = price
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT"):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
async def test_raw_receipt_cannot_bypass_adapter_window_chronology_rule() -> None:
    document = await receipt_document()
    document["response"]["data"]["snapshot"]["window_open_at_ms"] = RECEIVED_AT_MS + 1
    with pytest.raises(ResearchRejected, match="INVALID_OUTPUT"):
        admission()(
            fixture_request(),
            receipt_bytes(document),
            expected_transport="rest_fixture",
            now_ms=RECEIVED_AT_MS,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("retry", [0, 60, 60.25])
async def test_strict_wire_schema_keeps_valid_numeric_retry_and_json_tuples(retry: float) -> None:
    document = await receipt_document("mcp_fixture")
    document["response"]["data"].update(
        status="RATE_LIMITED",
        snapshot=None,
        provenance=None,
        retry_after_seconds=retry,
    )
    document["response"]["valid_until_ms"] = None
    result = admission()(
        fixture_request(),
        receipt_bytes(document),
        expected_transport="mcp_fixture",
        now_ms=RECEIVED_AT_MS,
    )
    assert result.data.status == "RATE_LIMITED" and result.data.retry_after_seconds == retry
    assert result.capability.granted_scopes == ()


@pytest.mark.asyncio
async def test_positive_small_price_is_not_rounded_or_rejected_by_statistics_guard() -> None:
    document = await receipt_document()
    document["response"]["data"]["snapshot"]["last_price"] = "0.00000001"
    result = admission()(
        fixture_request(),
        receipt_bytes(document),
        expected_transport="rest_fixture",
        now_ms=RECEIVED_AT_MS,
    )
    assert result.data.status == "OK" and result.data.snapshot.last_price == "0.00000001"
