"""Synthetic-only service restart, failure, fencing and cancellation evidence."""

from __future__ import annotations

import asyncio
import math
import sqlite3
from pathlib import Path

import pytest

from stark_trading_os.control.public_data_models import (
    PublicDataPayload,
    PublicDataQuery,
    PublicDataResource,
)
from stark_trading_os.control.public_data_service import PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError
from stark_trading_os.integrations.public_data.models import Mode

NOW = 1793268000000
RESOURCES: tuple[PublicDataResource, ...] = ("markets", "assets", "news", "explorer/capabilities")


def synthetic_payload(
    resource: PublicDataResource, *, mode: Mode = "offline_fixture", now: int = NOW,
    empty: bool = False,
) -> PublicDataPayload:
    subjects = (
        ["bitcoin", "ethereum", "solana"] if resource in {"markets", "assets"} else
        ["news"] if resource == "news" else ["1", "56", "8453", "42161", "137", "10"]
    )
    items: list[dict[str, object]] = []
    for subject in subjects:
        data: dict[str, object]
        if resource == "markets":
            base = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL"}[subject]
            data = {"instrument": {"venue": "BINANCE", "market_kind": "SPOT",
                    "symbol": base + "USDT", "base_asset": base, "quote_asset": "USDT"},
                    "last_price": "60000", "base_volume": "10", "quote_volume": "600000",
                    "window_open_at_ms": now - 86400000, "window_close_at_ms": now - 2000}
        elif resource == "assets":
            data = {"asset_id": subject, "name": subject, "symbol": "TEST"}
        elif resource == "news":
            data = {"news_id": "synthetic:1", "title": "Synthetic news", "summary": "fixture",
                    "url": "https://www.theblockbeats.info/flash/1",
                    "published_at_ms": now - 2000}
        else:
            data = {"chain_id": subject, "capability_id": "contract.abi"}
        items.append({
            "record_id": f"synthetic:{resource}:{subject}", "subject_id": subject,
            "provider_id": "synthetic-source", "venue_or_chain": None,
            "event_time_ms": now - 2000, "received_at_ms": now - 1500,
            "available_at_ms": now - 1000, "valid_until_ms": now + 30000,
            "source_revision": "synthetic.v1", "quality": "fresh", "data": data,
        })
    return PublicDataPayload.model_validate({
        "mode": mode, "as_of_ms": now - 1000, "quality": "fresh",
        "coverage": {"scope": "NEWS_FEED" if resource == "news" else resource,
                     "requested_subjects": subjects, "returned_subjects": [] if empty else subjects,
                     "gaps": []},
        "sources": [{"provider_id": "synthetic-source", "status": "OK",
                     "last_success_at_ms": now - 1000}],
        "items": [] if empty else items,
    })


async def forbidden_fetch(query: PublicDataQuery) -> object:
    raise AssertionError(f"unexpected upstream call: {query.resource}")


@pytest.mark.asyncio
@pytest.mark.parametrize("resource", RESOURCES)
async def test_service_reopen_restores_canonical_collection_and_source_times(
    tmp_path: Path, resource: PublicDataResource,
) -> None:
    path = tmp_path / "public.sqlite"
    calls: list[PublicDataQuery] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        return synthetic_payload(query.resource)

    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(fetch, clock_ms=lambda: NOW, store=store)
    selected = PublicDataQuery(resource=resource, asset_ids=("bitcoin",), limit=1, chain_id="1")
    first = await service.read(selected)
    assert calls == [PublicDataQuery(resource=resource, limit=50 if resource == "news" else 20)]
    await service.close()
    assert store.load(resource) is not None  # Service must not own store.close().
    store.close()
    restored = PublicDataStore(path, mode="offline_fixture")
    reopened = PublicDataService(forbidden_fetch, clock_ms=lambda: NOW + 1, store=restored)
    assert await reopened.read(selected) == first
    all_items = await reopened.read(PublicDataQuery(resource=resource, limit=50))
    assert all_items == synthetic_payload(resource)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM public_data_cache").fetchone()[0] == 1
    await reopened.close()
    restored.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("empty", [False, True])
async def test_last_good_and_full_429_backoff_survive_repeated_reopens(
    tmp_path: Path, empty: bool,
) -> None:
    path = tmp_path / "public.sqlite"
    original = synthetic_payload("news", empty=empty)

    async def success(query: PublicDataQuery) -> object:
        return original

    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(success, clock_ms=lambda: NOW, store=store)
    assert await service.read(PublicDataQuery(resource="news")) == original
    await service.close()
    store.close()
    later = NOW + 61000
    calls = 0

    async def rate_limited(query: PublicDataQuery) -> object:
        nonlocal calls
        calls += 1
        raw = original.model_dump(mode="json")
        raw.update(quality="unavailable", as_of_ms=None, items=[], sources=[{
            "provider_id": "synthetic-source", "status": "RATE_LIMITED",
            "retry_after_seconds": 7200.25, "reason_code": "UPSTREAM_RATE_LIMITED",
        }])
        return raw

    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(rate_limited, clock_ms=lambda: later, store=store)
    failed = await service.read(PublicDataQuery(resource="news"))
    assert failed.quality == "stale"
    assert failed.as_of_ms == original.as_of_ms
    assert failed.sources[0].last_success_at_ms == original.sources[0].last_success_at_ms
    assert failed.sources[0].retry_after_seconds == 7200.25
    assert [item.model_dump(exclude={"quality"}) for item in failed.items] == [
        item.model_dump(exclude={"quality"}) for item in original.items
    ]
    state = store.load("news")
    assert state is not None and state.last_good == original
    assert state.refresh_at_ms == later + math.ceil(7200.25) * 1000
    await service.close()
    store.close()
    later += 3600001
    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(rate_limited, clock_ms=lambda: later, store=store)
    assert await service.read(PublicDataQuery(resource="news")) == failed
    assert calls == 1
    later = state.refresh_at_ms
    assert (await service.read(PublicDataQuery(resource="news"))).quality == "stale"
    assert calls == 2
    state = store.load("news")
    assert state is not None and state.last_good == original
    await service.close()
    store.close()


@pytest.mark.asyncio
async def test_empty_news_expiry_during_backoff_keeps_success_identity(tmp_path: Path) -> None:
    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")
    original = synthetic_payload("news", empty=True)
    store.save("news", payload=original, last_good=original, fetched_at_ms=NOW,
               refresh_at_ms=NOW + 300000, expected_revision=0)
    service = PublicDataService(forbidden_fetch, clock_ms=lambda: NOW + 61000, store=store)
    result = await service.read(PublicDataQuery(resource="news"))
    assert result.quality == "stale" and result.items == ()
    assert result.as_of_ms == original.as_of_ms
    assert result.sources == original.sources
    await service.close()
    store.close()


@pytest.mark.asyncio
async def test_two_services_late_fetch_returns_winner_without_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    older = PublicDataStore(path, mode="offline_fixture")
    newer = PublicDataStore(path, mode="offline_fixture")
    started, release = asyncio.Event(), asyncio.Event()

    async def slow(query: PublicDataQuery) -> object:
        started.set()
        await release.wait()
        return synthetic_payload(query.resource)

    async def fast(query: PublicDataQuery) -> object:
        # Acquiring a separate write transaction proves no DB transaction spans fetch.
        with sqlite3.connect(path) as probe:
            probe.execute("BEGIN IMMEDIATE")
        return synthetic_payload(query.resource, now=NOW + 1000)

    old_service = PublicDataService(slow, clock_ms=lambda: NOW, store=older)
    new_service = PublicDataService(fast, clock_ms=lambda: NOW + 1000, store=newer)
    query = PublicDataQuery(resource="markets")
    task = asyncio.create_task(old_service.read(query))
    await started.wait()
    winner = await new_service.read(query)
    release.set()
    assert await task == winner
    assert await old_service.read(query) == winner
    assert older.load("markets") == newer.load("markets")
    await old_service.close()
    await new_service.close()
    older.close()
    newer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["exception", "unavailable"])
@pytest.mark.parametrize("has_last_good", [False, True], ids=["empty", "last-good"])
async def test_late_failure_after_same_service_restores_winner(
    tmp_path: Path, failure: str, has_last_good: bool,
) -> None:
    path = tmp_path / "public.sqlite"
    older = PublicDataStore(path, mode="offline_fixture")
    newer = PublicDataStore(path, mode="offline_fixture")
    if has_last_good:
        original = synthetic_payload("markets")
        assert older.save(
            "markets", payload=original, last_good=original, fetched_at_ms=NOW,
            refresh_at_ms=NOW + 10000, expected_revision=0,
        ) is not None
    started, release = asyncio.Event(), asyncio.Event()
    slow_calls = fast_calls = 0
    now = NOW + 61000
    expected = synthetic_payload("markets", now=now)

    async def slow(query: PublicDataQuery) -> object:
        nonlocal slow_calls
        slow_calls += 1
        started.set()
        await release.wait()
        if failure == "exception":
            raise RuntimeError("synthetic upstream failure")
        raw = synthetic_payload(query.resource).model_dump(mode="json")
        raw.update(quality="unavailable", as_of_ms=None, items=[], sources=[{
            "provider_id": "synthetic-source", "status": "RATE_LIMITED",
            "retry_after_seconds": 7200.25, "reason_code": "UPSTREAM_RATE_LIMITED",
        }])
        return raw

    async def fast(query: PublicDataQuery) -> object:
        nonlocal fast_calls
        fast_calls += 1
        return expected

    old_service = PublicDataService(slow, clock_ms=lambda: now, store=older)
    new_service = PublicDataService(fast, clock_ms=lambda: now, store=newer)
    query = PublicDataQuery(resource="markets")
    task = asyncio.create_task(old_service.read(query))
    try:
        # First read captures its last-good before the other connection commits.
        await asyncio.wait_for(started.wait(), timeout=2.0)
        winner = await new_service.read(query)
        assert winner == expected
        committed = newer.load("markets")
        assert committed is not None
        assert committed.revision == (2 if has_last_good else 1)
        assert committed.last_good == expected
        assert committed.refresh_at_ms == now + 10000

        # Third read restores winner into S1 while S1's original fetch is suspended.
        restored = await asyncio.wait_for(old_service.read(query), timeout=2.0)
        assert restored == winner
        assert not task.done()
        assert (slow_calls, fast_calls) == (1, 1)
        release.set()
        late = await task
        for result in (restored, late):
            assert result == winner
            assert result.sources == expected.sources
            assert result.as_of_ms == expected.as_of_ms
            assert result.quality == expected.quality == "fresh"
        # Losing failure must not alter revision, last-good, sources or backoff.
        assert older.load("markets") == newer.load("markets") == committed
        assert (slow_calls, fast_calls) == (1, 1)
    finally:
        release.set()
        await old_service.close()
        await new_service.close()
        await asyncio.gather(task, return_exceptions=True)
        older.close()
        newer.close()


@pytest.mark.asyncio
async def test_singleflight_reader_cancellation_and_shutdown(tmp_path: Path) -> None:
    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return synthetic_payload(query.resource)

    service = PublicDataService(fetch, clock_ms=lambda: NOW, store=store)
    query = PublicDataQuery(resource="markets")
    disconnected = asyncio.create_task(service.read(query))
    await started.wait()
    readers = [asyncio.create_task(service.read(query)) for _ in range(10)]
    disconnected.cancel()
    with pytest.raises(asyncio.CancelledError):
        await disconnected
    release.set()
    assert all(value.quality == "fresh" for value in await asyncio.gather(*readers))
    assert calls == 1
    release.clear()
    started.clear()
    pending = asyncio.create_task(service.read(PublicDataQuery(resource="assets")))
    await started.wait()
    await service.close()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert store.load("assets") is None
    assert store.load("markets") is not None
    store.close()


@pytest.mark.asyncio
async def test_commit_failure_does_not_publish_memory_or_last_good(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    blocker = sqlite3.connect(path, isolation_level=None)
    calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal calls
        calls += 1
        if calls == 1:
            blocker.execute("BEGIN")
            blocker.execute("SELECT * FROM public_data_cache").fetchall()
            return synthetic_payload(query.resource)
        raise RuntimeError("synthetic private diagnostic")

    service = PublicDataService(fetch, clock_ms=lambda: NOW, store=store)
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        await service.read(PublicDataQuery(resource="markets"))
    blocker.rollback()
    blocker.close()
    assert store.load("markets") is None
    response = await service.read(PublicDataQuery(resource="markets"))
    assert response.quality == "unavailable"
    assert response.mode == "offline_fixture"
    assert response.items == () and response.as_of_ms is None
    state = store.load("markets")
    assert state is not None and state.last_good is None
    assert calls == 2
    await service.close()
    store.close()


@pytest.mark.asyncio
async def test_mode_mismatch_cannot_poison_live_store(tmp_path: Path) -> None:
    store = PublicDataStore(tmp_path / "public.sqlite", mode="live_readonly")

    async def fixture(query: PublicDataQuery) -> object:
        return synthetic_payload(query.resource)

    service = PublicDataService(fixture, clock_ms=lambda: NOW, store=store)
    with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
        await service.read(PublicDataQuery(resource="markets"))
    assert store.load("markets") is None
    await service.close()
    store.close()


@pytest.mark.asyncio
async def test_initial_429_without_success_is_recovered_as_unavailable(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    calls = 0

    async def unavailable(query: PublicDataQuery) -> object:
        nonlocal calls
        calls += 1
        raw = synthetic_payload(query.resource).model_dump(mode="json")
        raw.update(quality="unavailable", items=[], as_of_ms=None, sources=[{
            "provider_id": "synthetic-source", "status": "RATE_LIMITED",
            "retry_after_seconds": 7200,
        }])
        return raw

    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(unavailable, clock_ms=lambda: NOW, store=store)
    first = await service.read(PublicDataQuery(resource="news"))
    assert first.quality == "unavailable" and first.as_of_ms is None
    await service.close()
    store.close()
    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(unavailable, clock_ms=lambda: NOW + 3600001, store=store)
    assert await service.read(PublicDataQuery(resource="news")) == first
    assert calls == 1
    state = store.load("news")
    assert state is not None and state.last_good is None
    assert state.refresh_at_ms == NOW + 7200000
    await service.close()
    store.close()
