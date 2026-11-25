"""Explicit BTC fixture composition, deliberately kept out of application source."""

import json

from stark_trading_os.integrations.assistant_tools import (
    SOURCE_ID,
    FixtureToolRequest,
    FixtureToolResponse,
    project_fixture_result,
    tool_capabilities,
)
from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
from stark_trading_os.integrations.contracts import DataResult
from stark_trading_os.integrations.research_egress import canonical
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

RECEIVED_AT_MS = 1700000002000


class AssistantToolsStub:
    def __init__(self, *, enabled: bool = False) -> None:
        self._capabilities = tool_capabilities(enabled=enabled)
        self.fixture_calls = 0

    async def run(
        self,
        request: FixtureToolRequest,
        *,
        now_ms: int = RECEIVED_AT_MS,
    ) -> FixtureToolResponse:
        # Validate the entire immutable tree before looking at capability or enabled.
        from stark_trading_os.integrations.assistant_tools import _TYPES

        request = canonical(request, FixtureToolRequest, extra=_TYPES)
        cap = next(x for x in self._capabilities if x.capability == request.capability)
        if not cap.enabled:
            return FixtureToolResponse(
                request_id=request.request_id, capability=cap, checked_at_ms=now_ms
            )
        body = json.dumps(
            {
                "symbol": "BTCUSDT",
                "lastPrice": "65000.12000000",
                "volume": "12.34000000",
                "quoteVolume": "802101.48080000",
                "openTime": 1699913600000,
                "closeTime": 1700000000000,
            }
        ).encode()
        transport = FixtureTransport((HttpResponse(200, body),))
        provider = BinanceSpotTickerProvider(transport, clock_ms=lambda: RECEIVED_AT_MS)
        assert request.instrument is not None
        raw = await provider.fetch_snapshot(request.instrument)
        self.fixture_calls += transport.calls
        value = raw.model_dump()
        value["provider_id"] = SOURCE_ID
        if raw.provenance is not None:
            assert raw.provenance.purpose == "OFFLINE_FIXTURE"
            value["provenance"]["provider_id"] = SOURCE_ID
        return project_fixture_result(request, DataResult.model_validate(value), now_ms=now_ms)
