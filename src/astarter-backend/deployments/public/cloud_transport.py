"""Only the original adapter's three public ticker GETs; no keys or trade hosts."""

import httpx

from stark_trading_os.integrations.contracts import Purpose
from stark_trading_os.integrations.transport import (
    MAX_RESPONSE_BYTES,
    HttpRequest,
    HttpResponse,
    TransportReason,
    TransportRejected,
)

TARGETS = {
    f"https://api.binance.com/api/v3/ticker/24hr?symbol={symbol}&type=FULL": f"https://data-api.binance.vision/api/v3/ticker/24hr?symbol={symbol}&type=FULL"
    for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT")
}


class PublicMarketTransport:
    purpose: Purpose = "EXTERNAL_OBSERVATION"

    async def send(self, request: HttpRequest) -> HttpResponse:
        if request.method != "GET" or request.url not in TARGETS or request.headers or request.body:
            raise TransportRejected(TransportReason.REQUEST)
        try:
            async with (
                httpx.AsyncClient(timeout=2.5, follow_redirects=False, trust_env=False) as client,
                client.stream(
                    "GET", TARGETS[request.url], headers={"Accept": "application/json"}
                ) as response,
            ):
                headers = tuple(response.headers.multi_items())
                if len(headers) > 100 or sum(len(k) + len(v) for k, v in headers) > 16384:
                    raise TransportRejected(TransportReason.RESPONSE)
                if response.status_code == 200 and "application/json" not in response.headers.get(
                    "content-type", ""
                ):
                    raise TransportRejected(TransportReason.RESPONSE)
                body = bytearray()
                async for part in response.aiter_bytes():
                    body.extend(part)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise TransportRejected(TransportReason.RESPONSE)
                return HttpResponse(response.status_code, bytes(body), headers)
        except httpx.TimeoutException:
            raise TransportRejected(TransportReason.TIMEOUT) from None
        except httpx.HTTPError:
            raise TransportRejected(TransportReason.UNAVAILABLE) from None
