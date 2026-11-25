"""Synthetic receipt → existing B1a/B1b → ASGI only; never a live MCP endpoint."""

from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest

from stark_trading_os.control.app import create_app
from stark_trading_os.control.assistant_tools import AssistantFixtureReadSide
from stark_trading_os.integrations.assistant_fixture_receipts import admit_fixture_receipt
from stark_trading_os.integrations.assistant_tools import SOURCE_ID
from stark_trading_os.integrations.transport import FixtureTransport
from tests.stubs.assistant_fixture_receipts import (
    fixture_request,
    receipt_bytes,
    receipt_document,
)
from tests.stubs.assistant_tools import RECEIVED_AT_MS

ORIGIN = "http://127.0.0.1:4188"


@asynccontextmanager
async def fixture_client(document: dict[str, Any], now: list[int]) -> Any:
    response = admit_fixture_receipt(
        fixture_request(),
        receipt_bytes(document),
        expected_transport=document["transport"],
        now_ms=RECEIVED_AT_MS,
    )
    application = create_app(
        testing=True,
        web_local_origin=ORIGIN,
        public_data_only=True,
        public_data_enabled=True,
        assistant_fixture=AssistantFixtureReadSide(response, clock_ms=lambda: now[0]),
    )
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://test",
            headers={"Origin": ORIGIN},
        ) as client:
            yield client


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["rest_fixture", "mcp_fixture"])
async def test_both_fixture_channels_use_original_public_readside_without_fetching(
    channel: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = await receipt_document(channel)
    now = [RECEIVED_AT_MS]

    async def no_transport(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("GET attempted a provider fetch")

    monkeypatch.setattr(FixtureTransport, "send", no_transport)
    async with fixture_client(document, now) as client:
        market = await client.get("/v1/data/markets?asset_ids=bitcoin&selection_version=5")
        first = market.json()
        assert market.status_code == 200 and first["selection_version"] == 5
        assert first["quality"] == "fresh" and first["mode"] == "offline_fixture"
        assert first["tenant_scope"] == "PUBLIC" and first["execution_binding"] == "NONE"
        assert first["real_trading_connected"] is False
        item = first["items"][0]
        assert item["provider_id"] == SOURCE_ID and item["data"]["last_price"] == "65000.12000000"
        assert item["event_time_ms"] == 1700000000000
        assert item["received_at_ms"] == item["available_at_ms"] == 1700000002000
        assert item["valid_until_ms"] == 1700000007001
        again = (await client.get("/v1/data/markets?asset_ids=bitcoin")).json()
        assert again["items"] == first["items"] and again["as_of_ms"] == first["as_of_ms"]
        partial = (await client.get("/v1/data/markets")).json()
        assert partial["quality"] == "partial"
        assert partial["coverage"]["returned_subjects"] == ["bitcoin"]
        assert partial["coverage"]["gaps"] == ["ethereum", "solana"]
        now[0] += 5001
        stale = (await client.get("/v1/data/markets?asset_ids=bitcoin")).json()
        assert stale["quality"] == "stale" and stale["as_of_ms"] == 1700000002000
        assert stale["items"][0]["data"] == item["data"]
        assert stale["items"][0]["event_time_ms"] == item["event_time_ms"]
        catalog = await client.get("/v1/assistant/tool-providers")
        assert catalog.status_code == 200 and catalog.headers["Cache-Control"] == "no-store"
        capabilities = catalog.json()["capabilities"]
        assert capabilities[0]["state"] == "not_connected"
        assert (
            capabilities[0]["transport"] == "fixture" and capabilities[0]["data_status"] == "STALE"
        )
        assert all(
            x["verified_at_ms"] is None
            and x["account_binding_id"] is None
            and x["granted_scopes"] == []
            for x in capabilities
        )
        for path in ("/v1/assistant/research-jobs", "/v1/agent/run-review", "/v1/orders"):
            assert (await client.post(path, json={})).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["rest_fixture", "mcp_fixture"])
@pytest.mark.parametrize("status", ["RATE_LIMITED", "TIMEOUT", "INVALID_RESPONSE"])
async def test_failed_fixture_receipts_reach_http_without_empty_success_or_retry_loss(
    channel: str,
    status: str,
) -> None:
    document = await receipt_document(channel)
    document["response"]["data"].update(
        status=status,
        snapshot=None,
        provenance=None,
        retry_after_seconds=60.25,
    )
    document["response"]["valid_until_ms"] = None
    async with fixture_client(document, [RECEIVED_AT_MS]) as client:
        result = (await client.get("/v1/data/markets?asset_ids=bitcoin")).json()
        catalog = (await client.get("/v1/assistant/tool-providers")).json()
    assert result["quality"] == "unavailable" and result["items"] == []
    assert result["as_of_ms"] is None and result["coverage"]["gaps"] == ["bitcoin"]
    assert result["sources"][0]["status"] == status
    assert result["sources"][0]["retry_after_seconds"] == 60.25
    assert catalog["capabilities"][0]["state"] == "not_connected"
    assert catalog["capabilities"][0]["data_status"] == status
    assert catalog["capabilities"][0]["retry_after_seconds"] == 60.25
