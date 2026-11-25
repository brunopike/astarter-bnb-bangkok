"""R1 "Missing keys cause zero upstream calls." at the adapter, the wire and the shared layer.

Synthetic inputs only. No test reads the environment, loads a real credential or uses the
network: every transport here is an in-memory fixture or an offline mock, and the live wire
constructor is replaced by a function that fails the test.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
import pytest

from stark_trading_os.control.public_data_models import PublicDataQuery
from stark_trading_os.control.public_data_providers import SharedPublicProviders
from stark_trading_os.integrations.public_data import PublicDataProvider
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport
from stark_trading_os.integrations.transport import (
    FixtureTransport,
    HttpRequest,
    HttpResponse,
    TransportRejected,
)

NOW = 1700000000000
NEWS_URL = "https://api-pro.theblockbeats.info/v1/newsflash?page=1&size=20&lang=cn"


@pytest.mark.asyncio
@pytest.mark.parametrize("resource", ["news", "assets"])
async def test_missing_key_makes_zero_calls_even_with_a_transport_wired(resource):
    # The dev's unconfigured test builds the provider without transports, so the transport
    # check alone already answers UNCONFIGURED there. Here a transport is wired and only
    # the missing key keeps the read from reaching it.
    transport = FixtureTransport((HttpResponse(200, b"{}"),))
    if resource == "news":
        batch = await PublicDataProvider(
            news_transport=transport, clock_ms=lambda: NOW
        ).fetch_news()
    else:
        batch = await PublicDataProvider(
            asset_transport=transport, clock_ms=lambda: NOW
        ).fetch_assets(("bitcoin",))
    assert transport.calls == 0
    assert batch.quality == "unavailable"
    assert batch.items == () and batch.as_of_ms is None
    assert [source.status for source in batch.sources] == ["UNCONFIGURED"]
    assert batch.sources[0].reason_code == "UPSTREAM_UNCONFIGURED"
    assert batch.sources[0].last_success_at_ms is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [(), (("api-key", None),), (("api-key", ""),)],
    ids=["no_header", "header_without_value", "header_with_empty_value"],
)
async def test_news_wire_refuses_a_request_without_a_key_before_lookup_or_dispatch(headers):
    calls: list[str] = []

    async def resolver(host: str) -> tuple[str, ...]:
        calls.append("resolver")
        return ()

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append("wire")
        return httpx.Response(200, json={"status": 0, "data": {"data": []}})

    async with PublicReadHttpTransport(
        "BLOCKBEATS_NEWS", resolver=resolver, offline_transport=httpx.MockTransport(handler)
    ) as wire:
        with pytest.raises(TransportRejected, match="REQUEST_POLICY_REJECTED"):
            await wire.send(HttpRequest("GET", NEWS_URL, headers))
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scope,resource", [("blockbeats", "news"), ("coingecko", "assets")], ids=["news", "assets"]
)
async def test_shared_scope_without_a_key_is_not_configured_and_opens_no_transport(
    scope, resource
):
    entered: list[str] = []

    @asynccontextmanager
    async def factory(service):
        entered.append(service)
        yield FixtureTransport((HttpResponse(200, b"{}"),))

    config = SharedPublicProviders(
        mode="offline_fixture", enabled_scopes=(scope,), transport_factory=factory
    )
    assert config.configured_scopes == ()
    async with config.open() as fetch:
        with pytest.raises(ValueError, match="PUBLIC_PROVIDER_NOT_CONFIGURED"):
            await fetch(PublicDataQuery(resource=resource, limit=50))
    assert entered == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scope,resource", [("blockbeats", "news"), ("coingecko", "assets")], ids=["news", "assets"]
)
async def test_live_scope_without_a_key_never_builds_the_external_wire(
    monkeypatch, scope, resource
):
    import stark_trading_os.control.public_data_providers as wiring

    def forbidden(*args, **kwargs):
        raise AssertionError("the external wire must not be built without a key")

    monkeypatch.setattr(wiring, "PublicReadHttpTransport", forbidden)
    config = SharedPublicProviders(
        mode="live_readonly", enabled_scopes=(scope,), enable_external=True
    )
    assert config.configured_scopes == ()
    async with config.open() as fetch:
        with pytest.raises(ValueError, match="PUBLIC_PROVIDER_NOT_CONFIGURED"):
            await fetch(PublicDataQuery(resource=resource, limit=50))
