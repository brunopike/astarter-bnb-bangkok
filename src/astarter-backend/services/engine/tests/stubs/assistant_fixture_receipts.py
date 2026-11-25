"""Two local receipt shapes, not captured vendor REST or MCP schemas."""

import json
from typing import Any

from stark_trading_os.integrations.assistant_tools import FixtureToolRequest
from stark_trading_os.integrations.contracts import Instrument
from tests.stubs.assistant_tools import AssistantToolsStub


def fixture_request(request_id: str = "receipt-btc") -> FixtureToolRequest:
    return FixtureToolRequest(
        request_id=request_id,
        capability="market",
        instrument=Instrument(
            venue="BINANCE",
            market_kind="SPOT",
            symbol="BTCUSDT",
            base_asset="BTC",
            quote_asset="USDT",
        ),
    )


async def receipt_document(channel: str = "rest_fixture") -> dict[str, Any]:
    response = await AssistantToolsStub(enabled=True).run(fixture_request())
    return {
        "schema_version": "AstarterAssistantFixtureReceipt.v1",
        "transport": channel,
        "tool_id": (
            "astarter.fixture.rest.btc-24h.v1"
            if channel == "rest_fixture"
            else "astarter.fixture.mcp.btc-24h.v1"
        ),
        "coverage": "BINANCE_SPOT_24H_STATISTICS",
        "tenant_scope": "PUBLIC",
        "request_id": "receipt-btc",
        "response": response.model_dump(mode="json"),
    }


def receipt_bytes(document: dict[str, Any]) -> bytes:
    return json.dumps(document, separators=(",", ":"), allow_nan=False).encode()
