"""Offline deterministic evidence for managed public collection, not vendor entitlements."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from stark_trading_os.control.public_data_models import PublicDataQuery, PublicDataResource
from stark_trading_os.control.public_data_service import PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStore
from tests.unit.control.test_public_data_persistence import NOW, RESOURCES, synthetic_payload


@pytest.mark.asyncio
async def test_managed_reads_never_join_or_start_upstream(tmp_path: Path) -> None:
    """Business RED on the existing service, without importing a missing module."""
    started, release = asyncio.Event(), asyncio.Event()
    calls: list[PublicDataQuery] = []

    async def slow(query: PublicDataQuery) -> object:
        calls.append(query)
        started.set()
        await release.wait()
        return synthetic_payload(query.resource)

    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")
    service = PublicDataService(slow, clock_ms=lambda: NOW, store=store, snapshot_only=True)
    query = PublicDataQuery(resource="news", limit=20)
    reader = asyncio.create_task(service.read(query))
    completed = asyncio.Event()
    reader.add_done_callback(lambda _: completed.set())
    waiter = asyncio.create_task(started.wait())
    completion = asyncio.create_task(completed.wait())
    try:
        await asyncio.wait_for(
            asyncio.wait((waiter, completion), return_when=asyncio.FIRST_COMPLETED), 2
        )
        assert reader.done(), "managed cold GET must complete before upstream is released"
        assert (await reader).quality == "unavailable"
        assert calls == []
        assert not release.is_set()
    finally:
        release.set()
        await service.close()
        await asyncio.gather(reader, return_exceptions=True)
        waiter.cancel()
        completion.cancel()
        await asyncio.gather(waiter, completion, return_exceptions=True)
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("resource", RESOURCES)
async def test_managed_expired_snapshot_never_renews_source_times(
    tmp_path: Path, resource: PublicDataResource,
) -> None:
    original = synthetic_payload(resource)
    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")
    store.save(resource, payload=original, last_good=original, fetched_at_ms=NOW,
               refresh_at_ms=NOW + 10000, expected_revision=0)
    calls: list[PublicDataQuery] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        return synthetic_payload(query.resource, now=NOW + 120000)

    service = PublicDataService(
        fetch, clock_ms=lambda: NOW + 120000, store=store, snapshot_only=True,
    )
    try:
        result = await service.read(PublicDataQuery(resource=resource))
        assert calls == [], "expired managed reads must not refresh the provider"
        assert result.quality == "stale"
        assert result.as_of_ms == original.as_of_ms
        assert result.sources == original.sources
    finally:
        await service.close()
        store.close()
