"""Real SQLite and event-driven worker/HTTP tests; no network or wall-time sleeps."""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import httpx
import pytest

from stark_trading_os.control.app import create_app
from stark_trading_os.control.public_data_collector import (
    SCOPES,
    PublicCollectorOwner,
    PublicDataCollector,
)
from stark_trading_os.control.public_data_models import PublicDataPayload, PublicDataQuery
from stark_trading_os.control.public_data_policy import ProviderPolicy, PublicPolicyStore
from stark_trading_os.control.public_data_service import PublicDataFetcher, PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStore
from stark_trading_os.integrations.public_data.models import ExplorerCapability
from tests.unit.control.test_public_data_persistence import NOW, RESOURCES, synthetic_payload

POLICIES = (
    ProviderPolicy("binance", 6, 10000), ProviderPolicy("coingecko", 2, 300000),
    ProviderPolicy("blockbeats", 4, 60000),
)


@dataclass
class Clock:
    now: int = NOW

    def __call__(self) -> int:
        return self.now


class GateSleep:
    def __init__(self) -> None:
        self.parked: asyncio.Queue[str] = asyncio.Queue()
        self.gates: dict[str, asyncio.Event] = {}
        self.seconds: dict[str, float] = {}

    async def __call__(self, seconds: float) -> None:
        task = asyncio.current_task()
        assert task is not None
        resource = task.get_name().removeprefix("public-collector:")
        gate = asyncio.Event()
        self.gates[resource] = gate
        self.seconds[resource] = seconds
        self.parked.put_nowait(resource)
        await gate.wait()

    async def settled(self, count: int = 4) -> set[str]:
        return {await asyncio.wait_for(self.parked.get(), 2) for _ in range(count)}

    async def wake(self, resource: str) -> None:
        self.gates[resource].set()
        assert await self.settled(1) == {resource}


class CoupledClockCollector(PublicDataCollector):
    """Legacy scenarios advance UTC and elapsed together; recovery tests split them."""

    def _monotonic_ms(self) -> int:
        return self.service.clock_ms()


@asynccontextmanager
async def managed(
    path: Path, fetch: PublicDataFetcher, clock: Clock, sleep: GateSleep,
    policies: tuple[ProviderPolicy, ...] = POLICIES,
) -> AsyncIterator[PublicDataCollector]:
    owner = PublicCollectorOwner(path)
    owner.acquire()
    store = PublicDataStore(path, mode="offline_fixture")
    policy = PublicPolicyStore(path, mode=store.mode, policies=policies)
    service = PublicDataService(fetch, store=store, clock_ms=clock, snapshot_only=True)
    collector = CoupledClockCollector(service, policy, owner, sleep=sleep)
    try:
        collector.start()
        yield collector
    finally:
        await collector.close()
        await service.close()
        policy.close()
        store.close()
        owner.close()


@pytest.mark.asyncio
async def test_no_get_collection_and_100_http_reads_finish_before_slow_provider(
    tmp_path: Path,
) -> None:
    clock, sleep = Clock(), GateSleep()
    started, release = asyncio.Event(), asyncio.Event()
    calls: list[PublicDataQuery] = []
    path = tmp_path / "public.sqlite"

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        # Both SQLite transactions must have ended before any upstream await.
        for db_path in (path, path.with_name(path.name + ".collector-policy.sqlite3")):
            with sqlite3.connect(db_path, timeout=0) as probe:
                probe.execute("BEGIN IMMEDIATE")
        if query.resource == "assets":
            started.set()
            await release.wait()
        return synthetic_payload(query.resource, now=clock.now)

    async with managed(path, fetch, clock, sleep) as collector:
        await asyncio.wait_for(started.wait(), 2)
        assert await sleep.settled(3) == {"markets", "news", "explorer/capabilities"}
        assert collector.service.store.load("news") is not None  # No GET yet.
        assert collector.service.store.load("assets") is None

        @asynccontextmanager
        async def runtime() -> AsyncIterator[PublicDataCollector]:
            yield collector

        app = create_app(public_data_enabled=True, public_data_only=True,
                         public_data_runtime=runtime, web_local_origin="http://127.0.0.1:4188")
        async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
            headers={"Origin": "http://127.0.0.1:4188"},
        ) as client:
            paths = (
                "markets?asset_ids=bitcoin", "assets?asset_ids=ethereum", "news?limit=20",
                "news?limit=50", "explorer/capabilities?chain_id=1",
            )
            responses = await asyncio.wait_for(asyncio.gather(*(
                client.get(f"/v1/data/{paths[i % 5]}&selection_version={i}") for i in range(100)
            )), 5)
            assert not release.is_set(), "responses must finish BEFORE releasing the slow source"
            assert all(r.status_code == 200 for r in responses)
            assert len({r.json()["request_id"] for r in responses}) == 100
            assert responses[1].json()["quality"] == "unavailable"
            assert len(calls) == 4
            assert next(q for q in calls if q.resource == "news").limit == 50
            assert app.state.public_data_service is collector.service
            forbidden = await client.get(
                "/v1/data/news", headers={"Origin": "http://localhost:4188"},
            )
            assert forbidden.status_code == 403
            assert (await client.post("/v1/data/news")).status_code == 405
            assert (await client.post("/v1/backtests")).status_code == 404
        # Slow assets cannot stop the next market collection.
        clock.now += 10000
        await sleep.wake("markets")
        assert len([q for q in calls if q.resource == "markets"]) == 2
        assert not release.is_set()
        release.set()
        assert await sleep.settled(1) == {"assets"}
        clock.now += 10000
        await sleep.wake("markets")
        # cap is weight 6, not six batches
        assert len([q for q in calls if q.resource == "markets"]) == 2
        assert collector.policy.snapshot("binance").reserved_weight == 6


@pytest.mark.asyncio
async def test_cadence_no_storm_restart_deadlines_and_no_catchup(tmp_path: Path) -> None:
    clock, sleep = Clock(), GateSleep()
    path = tmp_path / "public.sqlite"
    calls: list[PublicDataQuery] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        return synthetic_payload(query.resource, now=clock.now)

    async with managed(path, fetch, clock, sleep) as collector:
        await sleep.settled()
        for _ in range(10):
            await sleep.wake("markets")
        assert len(calls) == 4
        assert sleep.seconds["markets"] == 10
        assert collector.policy.snapshot("binance").reserved_weight == 3
    async with managed(path, fetch, clock, GateSleep()) as collector:
        second_sleep = cast(GateSleep, collector._sleep)
        await second_sleep.settled()
        assert len(calls) == 4
        clock.now += 1800000
        await second_sleep.wake("markets")
        assert len(calls) == 5  # no replay of missed 10-second intervals
        state = collector.service.store.load("markets")
        assert state is not None and state.refresh_at_ms == clock.now + 10000
        assert collector.policy.snapshot("binance").reserved_weight == 6


def failed_news(retry: float | None = None) -> dict[str, object]:
    value = synthetic_payload("news").model_dump(mode="json")
    value.update(quality="unavailable", as_of_ms=None, items=[], sources=[{
        "provider_id": "synthetic-source", "status": "RATE_LIMITED",
        "retry_after_seconds": retry,
    }])
    return value


@pytest.mark.asyncio
@pytest.mark.parametrize("empty", [False, True])
async def test_retry_after_beyond_day_fractional_persists_then_recovers(
    tmp_path: Path, empty: bool,
) -> None:
    clock, sleep = Clock(), GateSleep()
    path = tmp_path / "public.sqlite"
    news_calls = 0
    original = synthetic_payload("news", empty=empty)

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
            if news_calls == 1:
                return original
            if news_calls == 2:
                return failed_news(172800.25)
        return synthetic_payload(
            query.resource, now=clock.now, empty=empty and query.resource == "news",
        )

    async with managed(path, fetch, clock, sleep) as collector:
        await sleep.settled()
        clock.now += 60000
        await sleep.wake("news")
        failed = collector.service.store.load("news")
        assert failed is not None and failed.payload.quality == "stale"
        assert failed.last_good == original
        assert failed.payload.as_of_ms == original.as_of_ms
        assert (failed.payload.sources[0].last_success_at_ms
                == original.sources[0].last_success_at_ms)
        assert failed.refresh_at_ms == clock.now + 172801000
        assert sleep.seconds["news"] == 172801
        assert collector.policy.snapshot("blockbeats").next_at_ms == failed.refresh_at_ms
    sleep = GateSleep()
    clock.now += 86400000
    restarted_at = clock.now
    async with managed(path, fetch, clock, sleep) as collector:
        await sleep.settled()
        assert news_calls == 2
        result = await collector.service.read(PublicDataQuery(resource="news", limit=50))
        assert result.quality == "stale" and result.as_of_ms == original.as_of_ms
        clock.now = failed.refresh_at_ms
        await sleep.wake("news")
        assert news_calls == 2  # elapsed downtime is not trusted on a new owner
        clock.now = restarted_at + 172801000
        await sleep.wake("news")
        assert news_calls == 3
        recovered = collector.service.store.load("news")
        assert recovered is not None and recovered.payload.quality == "fresh"
        assert recovered.refresh_at_ms == clock.now + 60000
        assert collector.policy.snapshot("blockbeats").reserved_weight == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "malformed", "wrong_resource", "unavailable"])
async def test_failure_keeps_last_good_floor_then_valid_observation_resets(
    tmp_path: Path, failure: str,
) -> None:
    clock, sleep = Clock(), GateSleep()
    calls = 0
    original = synthetic_payload("markets")

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal calls
        if query.resource != "markets":
            return synthetic_payload(query.resource)
        calls += 1
        if calls == 2:
            if failure == "timeout":
                raise TimeoutError("synthetic private upstream diagnostic")
            if failure == "malformed":
                return {"items": "bad"}
            if failure == "wrong_resource":
                return synthetic_payload("assets")
            raw = original.model_dump(mode="json")
            raw.update(quality="unavailable", as_of_ms=None, items=[], sources=[{
                "provider_id": "synthetic-source", "status": "UNAVAILABLE",
            }])
            return raw
        return synthetic_payload(query.resource, now=clock.now)

    policies = (ProviderPolicy("binance", 12, 10000), *POLICIES[1:])
    async with managed(tmp_path / "public.sqlite", fetch, clock, sleep, policies) as collector:
        await sleep.settled()
        clock.now += 10000
        await sleep.wake("markets")
        failed = collector.service.store.load("markets")
        assert failed is not None and failed.last_good == original
        assert failed.payload.quality == "stale" and failed.payload.as_of_ms == original.as_of_ms
        assert failed.refresh_at_ms >= clock.now + 60000
        assert collector.state["markets"] == "DEGRADED"
        clock.now += 10000
        await sleep.wake("markets")
        assert calls == 2
        clock.now = failed.refresh_at_ms
        await sleep.wake("markets")
        assert calls == 3
        recovered = collector.service.store.load("markets")
        assert recovered is not None and recovered.refresh_at_ms == clock.now + 10000
        assert collector.state["markets"] == "OK"


@pytest.mark.asyncio
async def test_partial_observation_and_unconfigured_source_are_truthful(tmp_path: Path) -> None:
    from stark_trading_os.integrations.public_data import PublicDataProvider

    clock, sleep = Clock(), GateSleep()

    async def fetch(query: PublicDataQuery) -> object:
        if query.resource == "news":
            batch = await PublicDataProvider().fetch_news(50)
            return batch.model_copy(update={"mode": "offline_fixture"}).model_dump(mode="json")
        value = synthetic_payload(query.resource).model_dump(mode="json")
        if query.resource == "markets":
            value["items"] = value["items"][:1]
            value["quality"] = "partial"
            value["coverage"].update(returned_subjects=["bitcoin"], gaps=["ethereum", "solana"])
            value["sources"].append({"provider_id": "synthetic-failed", "status": "TIMEOUT"})
        return value

    async with managed(tmp_path / "public.sqlite", fetch, clock, sleep) as collector:
        await sleep.settled()
        market = collector.service.store.load("markets")
        assert market is not None and market.payload.quality == "partial"
        assert market.refresh_at_ms == NOW + 60000
        news = await collector.service.read(PublicDataQuery(resource="news"))
        assert news.quality == "unavailable" and news.as_of_ms is None
        assert news.sources[0].status == "UNCONFIGURED"
        assert collector.policy.snapshot("blockbeats").reserved_weight == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("which", ["policy", "snapshot"])
async def test_background_sqlite_error_is_observed_failclosed_no_new_fetch(
    tmp_path: Path, which: str, caplog: pytest.LogCaptureFixture,
) -> None:
    clock, sleep = Clock(), GateSleep()
    calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal calls
        calls += 1
        return synthetic_payload(query.resource)

    async with managed(tmp_path / "public.sqlite", fetch, clock, sleep) as collector:
        await sleep.settled()
        clock.now += 10000
        db_path = collector.policy.path if which == "policy" else collector.service.store.path
        with sqlite3.connect(db_path, isolation_level=None) as blocker:
            blocker.execute("BEGIN EXCLUSIVE")
            sleep.gates["markets"].set()
            await asyncio.wait_for(collector.failed.wait(), 2)
            assert collector.state["markets"] == "FAILED_CLOSED"
            assert calls == 4
            assert "PUBLIC_COLLECTOR_FAILED_CLOSED resource=markets" in caplog.text
            assert str(tmp_path) not in caplog.text and "locked" not in caplog.text
        assert collector.service.store.load("markets") is not None
        assert calls == 4


@pytest.mark.asyncio
async def test_successful_empty_feed_expires_without_fetch(tmp_path: Path) -> None:
    clock, sleep = Clock(), GateSleep()

    async def fetch(query: PublicDataQuery) -> PublicDataPayload:
        return synthetic_payload(query.resource, empty=query.resource == "news")

    async with managed(tmp_path / "public.sqlite", fetch, clock, sleep) as collector:
        await sleep.settled()
        original = await collector.service.read(PublicDataQuery(resource="news"))
        assert original.quality == "fresh" and not original.items
        clock.now += 61000
        expired = await collector.service.read(PublicDataQuery(resource="news"))
        assert expired.quality == "stale" and expired.as_of_ms == original.as_of_ms
        assert expired.sources == original.sources
        assert collector.policy.snapshot("blockbeats").reserved_weight == 1
        assert set(collector.state) == set(RESOURCES)


@pytest.mark.asyncio
async def test_fractional_wire_retry_after_and_actual_weighted_provider_requests(
    tmp_path: Path,
) -> None:
    from stark_trading_os.control.public_data_service import provider_fetcher
    from stark_trading_os.integrations.public_data import PublicDataProvider
    from stark_trading_os.integrations.public_data.network import (
        PublicReadHttpTransport,
        PublicService,
    )
    from stark_trading_os.integrations.public_data.providers import PublicDataCredentials

    clock, sleep = Clock(), GateSleep()
    attempts: dict[str, int] = {}
    dns: list[str] = []

    async def resolver(host: str) -> tuple[str, ...]:
        dns.append(host)
        return ("8.8.8.8",)

    def response(request: httpx.Request) -> httpx.Response:
        host = request.headers["host"]
        attempts[host] = attempts.get(host, 0) + 1
        return httpx.Response(429, content=b"{}", headers={"retry-after": "172800.25"})

    scopes: tuple[PublicService, ...] = ("BINANCE_SPOT", "COINGECKO_ASSETS", "BLOCKBEATS_NEWS")
    async with AsyncExitStack() as stack:
        transports = [await stack.enter_async_context(PublicReadHttpTransport(
            scope, offline_transport=httpx.MockTransport(response), resolver=resolver,
        )) for scope in scopes]
        provider = PublicDataProvider(
            market_transport=transports[0], asset_transport=transports[1],
            news_transport=transports[2], clock_ms=clock,
            credentials=PublicDataCredentials(
                coingecko_api_key="synthetic-fixture-only",
                blockbeats_api_key="synthetic-fixture-only",
            ),
        )
        async with managed(tmp_path / "public.sqlite", provider_fetcher(provider),
                           clock, sleep) as collector:
            await sleep.settled()
            assert attempts == {
                "api.binance.com": 3, "pro-api.coingecko.com": 1,
                "api-pro.theblockbeats.info": 1,
            }
            assert len(dns) == 5  # injected resolver, zero real DNS
            for resource, scope in SCOPES.items():
                if scope is None:
                    continue
                state = collector.service.store.load(resource)
                assert state is not None and state.payload.quality == "unavailable"
                assert state.refresh_at_ms == NOW + 172801000
                assert all(s.retry_after_seconds == 172801 for s in state.payload.sources)
                assert collector.policy.snapshot(scope).next_at_ms == state.refresh_at_ms
            registry = collector.service.store.load("explorer/capabilities")
            assert registry is not None and len(registry.payload.items) == 12
            assert all(isinstance(item.data, ExplorerCapability)
                       and item.data.verification_state == "UNTESTED"
                       for item in registry.payload.items)
            assert collector.policy.snapshot("binance").reserved_weight == 3
            assert collector.policy.snapshot("coingecko").reserved_weight == 1
            assert collector.policy.snapshot("blockbeats").reserved_weight == 1


@pytest.mark.asyncio
async def test_retry_deadline_is_durable_even_when_snapshot_commit_fails(tmp_path: Path) -> None:
    clock, sleep = Clock(), GateSleep()
    path = tmp_path / "public.sqlite"
    blocker = sqlite3.connect(path, isolation_level=None)
    news_calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
            if news_calls == 2:
                blocker.execute("BEGIN")
                blocker.execute("SELECT * FROM public_data_cache").fetchall()
                return failed_news(172800.25)
        return synthetic_payload(query.resource, now=clock.now)

    try:
        async with managed(path, fetch, clock, sleep) as collector:
            await sleep.settled()
            original = collector.service.store.load("news")
            clock.now += 60000
            sleep.gates["news"].set()
            await asyncio.wait_for(collector.failed.wait(), 2)
            assert collector.state["news"] == "FAILED_CLOSED"
            blocker.rollback()
            assert collector.service.store.load("news") == original
            policy = collector.policy.snapshot("blockbeats")
            assert policy.pending and policy.reserved_weight == 2
            assert policy.next_at_ms == clock.now + 172801000
    finally:
        blocker.close()
    reopened = PublicPolicyStore(path, mode="offline_fixture", policies=POLICIES)
    assert reopened.snapshot("blockbeats") == policy
    reopened.close()


@pytest.mark.asyncio
async def test_budget_commit_failure_rolls_back_and_never_dispatches(tmp_path: Path) -> None:
    clock, sleep = Clock(), GateSleep()
    calls: list[PublicDataQuery] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        return synthetic_payload(query.resource)

    async with managed(tmp_path / "public.sqlite", fetch, clock, sleep) as collector:
        await sleep.settled()
        before = collector.policy.snapshot("binance")
        with sqlite3.connect(collector.policy.path, isolation_level=None) as blocker:
            blocker.execute("BEGIN")
            blocker.execute("SELECT * FROM collector_budget").fetchall()
            clock.now += 10000
            sleep.gates["markets"].set()
            await asyncio.wait_for(collector.failed.wait(), 2)
            blocker.rollback()
        assert collector.state["markets"] == "FAILED_CLOSED"
        assert collector.policy.snapshot("binance") == before
        assert len(calls) == 4


@pytest.mark.asyncio
async def test_unexpected_provider_cancellation_is_not_a_silent_stopped_worker(
    tmp_path: Path,
) -> None:
    clock, sleep = Clock(), GateSleep()

    async def fetch(query: PublicDataQuery) -> object:
        if query.resource == "news":
            raise asyncio.CancelledError()
        return synthetic_payload(query.resource)

    async with managed(tmp_path / "public.sqlite", fetch, clock, sleep) as collector:
        await asyncio.wait_for(collector.failed.wait(), 2)
        assert collector.state["news"] == "FAILED_CLOSED"
        assert await sleep.settled(3) == {"markets", "assets", "explorer/capabilities"}
        assert collector.policy.snapshot("blockbeats").pending


@pytest.mark.asyncio
async def test_slow_operator_cadence_and_interrupted_collection_stay_charged(
    tmp_path: Path,
) -> None:
    clock, sleep = Clock(), GateSleep()
    started = asyncio.Event()
    calls: list[PublicDataQuery] = []
    path = tmp_path / "public.sqlite"
    policies = (ProviderPolicy("binance", 6, 20000), *POLICIES[1:])

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        if query.resource == "news" and not started.is_set():
            started.set()
            await asyncio.Event().wait()
        return synthetic_payload(query.resource)

    async with managed(path, fetch, clock, sleep, policies) as collector:
        await asyncio.wait_for(started.wait(), 2)
        await sleep.settled(3)
        market = collector.service.store.load("markets")
        assert market is not None and market.refresh_at_ms == NOW + 20000
        assert sleep.seconds["markets"] == 20
        clock.now += 10000
        await sleep.wake("markets")
        assert len(calls) == 4
    policy = PublicPolicyStore(path, mode="offline_fixture", policies=policies)
    state = policy.snapshot("blockbeats")
    assert state.pending and state.reserved_weight == 1
    policy.close()
    sleep = GateSleep()
    async with managed(path, fetch, clock, sleep, policies) as collector:
        await sleep.settled()
        recovered = collector.policy.snapshot("blockbeats")
        assert not recovered.pending and recovered.reserved_weight == 1
        assert recovered.day == state.day and recovered.last_wall_ms == state.last_wall_ms
        assert recovered.next_at_ms == state.next_at_ms  # guard no longer rewrites policy time
        assert sleep.seconds["news"] == 60
        assert len(calls) == 4
        clock.now += 59999
        await sleep.wake("news")
        assert len(calls) == 4
        clock.now += 1
        await sleep.wake("news")
        assert len(calls) == 5
        assert collector.policy.snapshot("blockbeats").reserved_weight == 2
        assert collector.state["news"] == "OK"
