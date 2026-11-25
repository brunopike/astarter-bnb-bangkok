"""R1 news on the deployed on-demand road: a service without a store, built as cloud.py builds it.

Synthetic inputs only. The provider reads an in-memory fixture transport with a plain-word test
key; nothing reads the environment or uses the network. These tests pin the per-instance shared
read and the no-store failure branch; cross-instance collection is not covered here.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from stark_trading_os.control.public_data_models import PublicDataQuery
from stark_trading_os.control.public_data_service import PublicDataService, provider_fetcher
from stark_trading_os.integrations.public_data import PublicDataCredentials, PublicDataProvider
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

NOW = 1700000000000
# Synthetic value only, the plain word the dev's provider tests use. It is never a real key.
CREDENTIAL = "unit-test-token"
CLOCKS = ("event_time_ms", "received_at_ms", "available_at_ms", "valid_until_ms")


def newsflash(count: int) -> bytes:
    rows = [
        {
            "id": number,
            "title": f"Synthetic news {number}",
            "content": "<p>fixture</p>",
            "url": f"https://www.theblockbeats.info/flash/{number}",
            "create_time": "1699999990",
        }
        for number in range(1, count + 1)
    ]
    return json.dumps({"status": 0, "data": {"data": rows}}).encode()


def news_provider(transport: FixtureTransport, clock) -> PublicDataProvider:
    return PublicDataProvider(
        news_transport=transport,
        credentials=PublicDataCredentials(blockbeats_api_key=CREDENTIAL),
        clock_ms=clock,
    )


@pytest.mark.asyncio
async def test_twenty_concurrent_first_news_reads_share_one_collection_at_limit_50():
    transport = FixtureTransport((HttpResponse(200, newsflash(50)),))
    collect = provider_fetcher(news_provider(transport, lambda: NOW))
    queries: list[PublicDataQuery] = []
    entered, release = asyncio.Event(), asyncio.Event()

    async def counting(query: PublicDataQuery) -> object:
        queries.append(query)
        entered.set()
        await release.wait()
        return await collect(query)

    # Same construction as deployments/public/cloud.py L31: no store, not snapshot-only.
    service = PublicDataService(counting, clock_ms=lambda: NOW)
    limits = (1, 5, 20, 50) * 5
    try:
        readers = [
            asyncio.create_task(service.read(PublicDataQuery(resource="news", limit=limit)))
            for limit in limits
        ]
        await asyncio.wait_for(entered.wait(), 2)
        release.set()
        results = await asyncio.wait_for(asyncio.gather(*readers), 5)
    finally:
        release.set()
        await service.close()
    assert queries == [PublicDataQuery(resource="news", limit=50)]
    assert transport.calls == 1
    assert [len(result.items) for result in results] == list(limits)
    assert {result.as_of_ms for result in results} == {NOW}
    assert {result.quality for result in results} == {"fresh"}
    full = [item.record_id for item in results[limits.index(50)].items]
    assert len(set(full)) == 50
    for result in results:
        assert [item.record_id for item in result.items] == full[: len(result.items)]


@pytest.mark.asyncio
async def test_no_store_news_failure_keeps_original_clocks_and_holds_retry_after():
    clock = [NOW]
    transport = FixtureTransport(
        (
            HttpResponse(200, newsflash(3)),
            HttpResponse(429, b"{}", (("retry-after", "7200"),)),
            HttpResponse(503, b"{}"),
        )
    )
    calls: list[PublicDataQuery] = []
    collect = provider_fetcher(news_provider(transport, lambda: clock[0]))

    async def counting(query: PublicDataQuery) -> object:
        calls.append(query)
        return await collect(query)

    service = PublicDataService(counting, clock_ms=lambda: clock[0])
    query = PublicDataQuery(resource="news")
    try:
        original = await service.read(query)
        assert original.quality == "fresh" and len(original.items) == 3
        assert original.as_of_ms == NOW
        assert original.sources[0].last_success_at_ms == NOW

        clock[0] = NOW + 61000  # past the 60 s news cadence
        failed = await service.read(query)
        assert len(calls) == 2
        assert failed.quality == "stale"
        assert failed.as_of_ms == original.as_of_ms
        source = failed.sources[0]
        assert source.status == "RATE_LIMITED"
        assert source.retry_after_seconds == 7200
        assert source.last_success_at_ms == original.sources[0].last_success_at_ms
        assert [item.quality for item in failed.items] == ["stale"] * 3
        for kept, first in zip(failed.items, original.items, strict=True):
            for name in CLOCKS:
                assert getattr(kept, name) == getattr(first, name)
            assert kept.model_dump(exclude={"quality"}) == first.model_dump(exclude={"quality"})

        retry_at = clock[0] + 7200 * 1000
        clock[0] = retry_at - 1  # inside the publisher's hold: served from memory
        assert await service.read(query) == failed
        assert await service.read(PublicDataQuery(resource="news", limit=50)) == failed
        assert len(calls) == 2 and transport.calls == 2

        clock[0] = retry_at  # the hold has ended: exactly one new read
        later = await service.read(query)
        assert len(calls) == 3 and transport.calls == 3
        assert later.quality == "stale"
        assert later.sources[0].status == "UNAVAILABLE"
        assert later.sources[0].last_success_at_ms == original.sources[0].last_success_at_ms
        for kept, first in zip(later.items, original.items, strict=True):
            assert kept.model_dump(exclude={"quality"}) == first.model_dump(exclude={"quality"})
    finally:
        await service.close()
