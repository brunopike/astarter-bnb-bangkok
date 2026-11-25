"""Interrupted local owners and independent UTC/elapsed clocks; no real network/sleeps."""

from __future__ import annotations

import asyncio
import multiprocessing
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from multiprocessing.connection import Connection
from pathlib import Path

import pytest

from stark_trading_os.control.public_data_collector import (
    PublicCollectorOwner,
    PublicCollectorOwnerError,
    PublicDataCollector,
)
from stark_trading_os.control.public_data_models import PublicDataQuery, PublicDataResource
from stark_trading_os.control.public_data_policy import (
    DAY_MS,
    ProviderPolicy,
    ProviderScope,
    PublicPolicyError,
    PublicPolicyStore,
)
from stark_trading_os.control.public_data_service import PublicDataFetcher, PublicDataService
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError
from tests.unit.control.test_public_data_collection import POLICIES, GateSleep, failed_news
from tests.unit.control.test_public_data_persistence import NOW, synthetic_payload


@dataclass
class Clocks:
    wall: int = NOW
    elapsed: int = 0

    def __call__(self) -> int:
        return self.wall

    def advance(self, ms: int) -> None:
        self.wall += ms
        self.elapsed += ms


class TimedCollector(PublicDataCollector):
    clocks: Clocks

    def _monotonic_ms(self) -> int:
        return self.clocks.elapsed


@asynccontextmanager
async def running(
    path: Path, fetch: PublicDataFetcher, clocks: Clocks, sleep: GateSleep,
    policies: tuple[ProviderPolicy, ...] = POLICIES,
) -> AsyncIterator[TimedCollector]:
    owner = PublicCollectorOwner(path)
    owner.acquire()
    store = PublicDataStore(path, mode="offline_fixture")
    policy = PublicPolicyStore(path, mode=store.mode, policies=policies)
    service = PublicDataService(fetch, store=store, clock_ms=clocks, snapshot_only=True)
    collector = TimedCollector(service, policy, owner, sleep=sleep)
    collector.clocks = clocks
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
@pytest.mark.parametrize("days_later", [0, 20, 30])
async def test_cancelled_inflight_new_owner_recovers_without_refund(
    tmp_path: Path, days_later: int,
) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    started = asyncio.Event()
    calls: list[str] = []
    interrupt = True

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query.resource)
        if query.resource == "news" and calls.count("news") == 2 and interrupt:
            started.set()
            await asyncio.Event().wait()
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        original = collector.service.store.load("news")
        clocks.advance(60000)
        sleep.gates["news"].set()
        await asyncio.wait_for(started.wait(), 2)
        charged = collector.policy.snapshot("blockbeats")
        assert charged.pending and charged.reserved_weight == 2
        # Policy readers, even with an expired wall clock, cannot reconcile.
        reader = PublicPolicyStore(path, mode="offline_fixture", policies=POLICIES)
        try:
            with pytest.raises(PublicPolicyError):
                reader.reserve("blockbeats", clocks.wall + 30 * DAY_MS, 0)
            assert reader.snapshot("blockbeats") == charged
        finally:
            reader.close()
        # A second collector sharing the live owner's object is not a new session.
        duplicate = PublicDataCollector(collector.service, collector.policy, collector.owner)
        with pytest.raises(PublicCollectorOwnerError):
            duplicate.start()
    interrupt = False
    clocks.wall += days_later * DAY_MS
    sleep = GateSleep()
    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        recovered = collector.policy.snapshot("blockbeats")
        assert not recovered.pending
        assert (recovered.day, recovered.reserved_weight, recovered.last_wall_ms) == (
            charged.day, charged.reserved_weight, charged.last_wall_ms,
        )
        assert recovered.next_at_ms == charged.next_at_ms
        assert sleep.seconds["news"] == 60  # startup guard is runtime-only
        assert collector.service.store.load("news") == original
        assert calls.count("news") == 2
        clocks.advance(59999)
        await sleep.wake("news")
        assert calls.count("news") == 2
        clocks.advance(1)
        await sleep.wake("news")
        assert calls.count("news") == 3
        state = collector.policy.snapshot("blockbeats")
        assert not state.pending and state.reserved_weight == (3 if days_later == 0 else 1)
        fresh = collector.service.store.load("news")
        assert fresh is not None and fresh.payload.quality == "fresh"
        assert fresh.payload == synthetic_payload("news", now=clocks.wall)
        await sleep.wake("markets")
        assert calls.count("markets") == 2  # interrupted news does not disable other lanes


async def _crash_session(path: Path, channel: Connection) -> None:
    clocks, sleep = Clocks(), GateSleep()
    admitted = asyncio.Event()

    async def fetch(query: PublicDataQuery) -> object:
        if query.resource == "assets":
            admitted.set()
            await asyncio.Event().wait()
        return synthetic_payload(query.resource)

    async with running(path, fetch, clocks, sleep) as collector:
        await admitted.wait()
        await sleep.settled(3)
        assert collector.policy.snapshot("coingecko").pending
        channel.send("charged-provider-waiting")
        await asyncio.Event().wait()


def _crash_child(path: str, channel: Connection) -> None:
    asyncio.run(_crash_session(Path(path), channel))


@pytest.mark.asyncio
async def test_actual_process_kill_releases_lease_and_charged_pending_recovers(
    tmp_path: Path,
) -> None:
    path = tmp_path / "public.sqlite"
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(target=_crash_child, args=(str(path), child))
    process.start()
    child.close()
    try:
        assert parent.poll(10) and parent.recv() == "charged-provider-waiting"
        contender = PublicCollectorOwner(path)
        with pytest.raises(PublicCollectorOwnerError):
            contender.acquire()
        process.kill()  # Real SIGKILL: no Python finally/close/reconciliation can execute.
        process.join(10)
        assert process.exitcode == -9
        reader = PublicPolicyStore(path, mode="offline_fixture", policies=POLICIES)
        before = reader.snapshot("coingecko")
        reader.close()
        assert before.pending and before.reserved_weight == 1
        clocks, sleep = Clocks(), GateSleep()
        calls: list[str] = []

        async def fetch(query: PublicDataQuery) -> object:
            calls.append(query.resource)
            return synthetic_payload(query.resource, now=clocks.wall)

        async with running(path, fetch, clocks, sleep) as collector:
            await sleep.settled()
            assert not calls
            state = collector.policy.snapshot("coingecko")
            assert not state.pending and state.reserved_weight == 1
            clocks.advance(299999)
            await sleep.wake("assets")
            assert not calls
            clocks.advance(1)
            await sleep.wake("assets")
            assert calls == ["assets"]
            assert collector.policy.snapshot("coingecko").reserved_weight == 2
            await sleep.wake("news")
            assert calls == ["assets", "news"]
    finally:
        if process.is_alive():
            process.kill()
            process.join(10)
        parent.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("window", ["deadline", "snapshot"])
@pytest.mark.parametrize("rate_limited", [False, True])
async def test_cross_db_interruption_retains_long_fractional_deadline_and_last_good(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, window: str, rate_limited: bool,
) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    news_calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
            if news_calls == 2 and rate_limited:
                return failed_news(172800.25)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        original = collector.service.store.load("news")
        assert original is not None
        clocks.advance(60000)
        with monkeypatch.context() as patch:
            if window == "deadline":
                # Fail after policy deadline commit, before public snapshot commit.
                def fail_save(*args: object, **kwargs: object) -> None:
                    raise PublicDataStoreError()
                patch.setattr(collector.service.store, "save", fail_save)
            else:
                # Fail only after service has successfully committed the snapshot.
                def fail_complete(scope: ProviderScope) -> None:
                    raise PublicPolicyError()
                patch.setattr(collector.policy, "complete", fail_complete)
            sleep.gates["news"].set()
            await asyncio.wait_for(collector.failed.wait(), 2)
        saved = collector.service.store.load("news")
        expected_good = (original.last_good if rate_limited or window == "deadline" else
                         synthetic_payload("news", now=clocks.wall))
        assert expected_good is not None
        assert saved is not None and saved.last_good == expected_good
        assert saved.payload.as_of_ms == expected_good.as_of_ms
        assert saved.payload.sources[0].last_success_at_ms == (
            expected_good.sources[0].last_success_at_ms
        )
        assert saved.revision == original.revision + (window == "snapshot")
        charged = collector.policy.snapshot("blockbeats")
        assert charged.pending and charged.reserved_weight == 2
        duration = 172801000 if rate_limited else 60000
        assert charged.next_at_ms == clocks.wall + duration
    sleep = GateSleep()
    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        state = collector.policy.snapshot("blockbeats")
        assert state.next_at_ms == charged.next_at_ms  # no shortening or fractional loss
        assert state.reserved_weight == charged.reserved_weight and not state.pending
        assert collector.service.store.load("news") == saved  # entire snapshot unchanged
        clocks.wall = charged.next_at_ms  # UTC allows, real elapsed does not.
        clocks.elapsed += 59999
        await sleep.wake("news")
        assert news_calls == 2
        clocks.elapsed += duration
        clocks.wall = charged.next_at_ms - 1  # real elapsed allows, UTC does not.
        await sleep.wake("news")
        assert news_calls == 2
        clocks.wall += 1
        await sleep.wake("news")
        assert news_calls == 3
        fresh = collector.service.store.load("news")
        assert fresh is not None and fresh.payload.quality == "fresh"
        assert fresh.payload == synthetic_payload("news", now=clocks.wall)
        assert fresh.refresh_at_ms == clocks.wall + 60000
        assert collector.policy.snapshot("blockbeats").reserved_weight == (1 if rate_limited else 3)


@pytest.mark.asyncio
async def test_running_retry_after_survives_forward_jump_and_early_wakes(tmp_path: Path) -> None:
    clocks, sleep = Clocks(), GateSleep()
    news_calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
            if news_calls == 1:
                return failed_news(172800.25)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(tmp_path / "public.sqlite", fetch, clocks, sleep):
        await sleep.settled()
        clocks.wall += 3 * DAY_MS
        for elapsed in (60000, 172800999):
            clocks.elapsed = elapsed
            await sleep.wake("news")
            assert news_calls == 1
        clocks.elapsed = 172801000
        await sleep.wake("news")
        assert news_calls == 2


@pytest.mark.asyncio
async def test_before_start_jump_retains_completed_retry_duration(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    news_calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
            if news_calls == 1:
                return failed_news(172800.25)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        saved = collector.service.store.load("news")
        assert saved is not None and saved.refresh_at_ms == NOW + 172801000
        charged = collector.policy.snapshot("blockbeats")
        assert not charged.pending and charged.reserved_weight == 1
        assert not collector.failed.is_set()
    # Exact counterexample: no elapsed time, UTC jumps BEFORE constructing a new owner.
    clocks.wall += 3 * DAY_MS
    assert clocks.elapsed == 0
    sleep = GateSleep()
    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        assert news_calls == 1 and not collector.failed.is_set()
        assert collector.service.store.load("news") == saved
        for elapsed in (60000, 172800999):
            clocks.advance(elapsed - clocks.elapsed)
            await sleep.wake("news")
            assert news_calls == 1, "startup must retain the full known 172801-second duration"
            assert not collector.failed.is_set()
        clocks.advance(1)
        await sleep.wake("news")
        assert news_calls == 2
        assert collector.policy.snapshot("blockbeats").reserved_weight == 1  # new UTC day
        await sleep.wake("news")
        assert news_calls == 2


@pytest.mark.asyncio
async def test_forward_jump_short_wakes_cannot_bypass_real_assets_interval(tmp_path: Path) -> None:
    clocks, sleep = Clocks(), GateSleep()
    calls: list[str] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query.resource)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(tmp_path / "public.sqlite", fetch, clocks, sleep) as collector:
        await sleep.settled()
        assert calls.count("assets") == 1  # new empty DB can collect immediately
        clocks.wall += DAY_MS
        clocks.elapsed += 60000
        await sleep.wake("assets")  # deterministic 60s timer/checkpoint wake, not a real wait
        assert calls.count("assets") == 1, "UTC jump must not admit after only 60 real seconds"
        for _ in range(5):
            await sleep.wake("assets")
        assert calls.count("assets") == 1
        clocks.elapsed = 299999
        await sleep.wake("assets")
        assert calls.count("assets") == 1
        clocks.elapsed = 300000
        await sleep.wake("assets")
        assert calls.count("assets") == 2
        assert collector.policy.snapshot("coingecko").reserved_weight == 1  # new day, no credits
        clocks.advance(100 * 300000)  # oversleep/resume permits ONE batch, not catch-up
        await sleep.wake("assets")
        assert calls.count("assets") == 3
        for _ in range(5):
            await sleep.wake("assets")
        assert calls.count("assets") == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("window", ["completed", "deadline"])
async def test_before_start_jump_repeated_recovery_keeps_duration_and_both_gates(
    tmp_path: Path, window: str,
) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    news_calls = 0
    blocker = sqlite3.connect(path, isolation_level=None)

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
            if news_calls == 2:
                if window == "deadline":
                    # Real public-DB COMMIT failure, after the policy deadline was saved.
                    blocker.execute("BEGIN")
                    blocker.execute("SELECT * FROM public_data_cache").fetchall()
                return failed_news(172800.25)
        return synthetic_payload(query.resource, now=clocks.wall)

    try:
        async with running(path, fetch, clocks, sleep) as collector:
            await sleep.settled()
            original = collector.service.store.load("news")
            assert original is not None
            clocks.advance(60000)
            if window == "deadline":
                sleep.gates["news"].set()
                await asyncio.wait_for(collector.failed.wait(), 2)
                blocker.rollback()
            else:
                await sleep.wake("news")
                assert not collector.failed.is_set()
            saved = collector.service.store.load("news")
            assert saved is not None and saved.last_good == original.last_good
            assert saved.payload.as_of_ms == original.payload.as_of_ms
            assert saved.revision == original.revision + (window == "completed")
            charged = collector.policy.snapshot("blockbeats")
            assert charged.pending == (window == "deadline")
            assert charged.reserved_weight == 2
            assert charged.next_at_ms - charged.last_wall_ms == 172801000
    finally:
        blocker.close()

    clocks.wall += 3 * DAY_MS  # before every new owner/guard, not after setup
    for restart in range(3):
        sleep = GateSleep()
        start_wall, start_elapsed = clocks.wall, clocks.elapsed
        async with running(path, fetch, clocks, sleep) as collector:
            await sleep.settled()
            assert sleep.seconds["news"] == 172801  # same full duration, never downtime + duration
            assert collector.policy.snapshot("blockbeats") == replace(charged, pending=False)
            assert collector.service.store.load("news") == saved  # no metadata renewal
            clocks.advance(60000)
            await sleep.wake("news")
            assert news_calls == 2
            assert collector.policy.snapshot("blockbeats") == replace(charged, pending=False)
            if restart == 2:
                clocks.elapsed = start_elapsed + 172800999
                clocks.wall = start_wall + 172801000  # UTC gate opens first
                await sleep.wake("news")
                assert news_calls == 2
                clocks.elapsed += 1
                clocks.wall -= 1  # elapsed opens, runtime UTC floor still blocks
                await sleep.wake("news")
                assert news_calls == 2 and not collector.failed.is_set()
                clocks.wall += 1
                await sleep.wake("news")
                assert news_calls == 3
                assert collector.policy.snapshot("blockbeats").reserved_weight == 1
                await sleep.wake("news")
                assert news_calls == 3
        clocks.wall += DAY_MS


@pytest.mark.asyncio
@pytest.mark.parametrize("history", ["snapshot_only", "policy_only"])
async def test_before_start_jump_independent_persisted_duration_sources(
    tmp_path: Path, history: str,
) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    policy = PublicPolicyStore(path, mode=store.mode, policies=POLICIES)
    if history == "snapshot_only":
        payload = synthetic_payload("news")
        store.save("news", payload=payload, last_good=payload, fetched_at_ms=NOW,
                   refresh_at_ms=NOW + 172801000, expected_revision=0)
    else:
        assert policy.reserve("blockbeats", NOW, 0) is None
        policy.record_deadline("blockbeats", NOW, NOW + 172801000)
        policy.complete("blockbeats")  # non-pending history, no public snapshot
    saved, charged = store.load("news"), policy.snapshot("blockbeats")
    store.close()
    policy.close()
    clocks, sleep = Clocks(wall=NOW + 3 * DAY_MS), GateSleep()
    calls: list[str] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query.resource)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        assert "news" not in calls
        assert collector.service.store.load("news") == saved
        assert collector.policy.snapshot("blockbeats") == charged
        clocks.advance(172800999)
        await sleep.wake("news")
        assert "news" not in calls
        clocks.advance(1)
        await sleep.wake("news")
        assert calls.count("news") == 1 and not collector.failed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("resource,scope,interval,duration", [
    ("markets", "binance", 10000, 60000),
    ("news", "blockbeats", 240000, 240000),
    ("assets", "coingecko", 600000, 600000),
])
async def test_before_start_jump_configured_interval_and_failure_floor(
    tmp_path: Path, resource: PublicDataResource, scope: ProviderScope,
    interval: int, duration: int,
) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    policies = tuple(replace(p, interval_ms=interval) if p.scope == scope else p for p in POLICIES)
    calls: list[str] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query.resource)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep, policies) as collector:
        await sleep.settled()
        assert calls.count(resource) == 1  # new DB is still immediately eligible
        charged = collector.policy.snapshot(scope)
    clocks.wall += 3 * DAY_MS
    sleep = GateSleep()
    async with running(path, fetch, clocks, sleep, policies) as collector:
        await sleep.settled()
        assert collector.policy.snapshot(scope) == charged
        clocks.advance(duration - 1)
        await sleep.wake(resource)
        assert calls.count(resource) == 1
        clocks.advance(1)
        await sleep.wake(resource)
        assert calls.count(resource) == 2 and not collector.failed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("cap", [1, 4])
async def test_repeated_restart_same_day_never_refunds_or_grows_startup_duration(
    tmp_path: Path, cap: int,
) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    policies = (*POLICIES[:2], ProviderPolicy("blockbeats", cap, 60000))
    news_calls = 0

    async def fetch(query: PublicDataQuery) -> object:
        nonlocal news_calls
        if query.resource == "news":
            news_calls += 1
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep, policies) as collector:
        await sleep.settled()
        charged = collector.policy.snapshot("blockbeats")
    for restart in range(3):
        clocks.advance(10000)
        sleep = GateSleep()
        async with running(path, fetch, clocks, sleep, policies) as collector:
            await sleep.settled()
            assert collector.policy.snapshot("blockbeats") == charged
            assert sleep.seconds["news"] == 60
            if restart == 2:
                clocks.advance(59999)
                await sleep.wake("news")
                assert news_calls == 1
                clocks.advance(1)
                await sleep.wake("news")
                assert news_calls == (1 if cap == 1 else 2)
                assert collector.policy.snapshot("blockbeats").reserved_weight == news_calls
                assert not collector.failed.is_set()


@pytest.mark.asyncio
async def test_backward_jump_requires_both_persisted_and_elapsed_gates(tmp_path: Path) -> None:
    clocks, sleep = Clocks(), GateSleep()
    calls: list[str] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query.resource)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(tmp_path / "public.sqlite", fetch, clocks, sleep) as collector:
        await sleep.settled()
        clocks.wall -= DAY_MS
        clocks.elapsed = 300000
        await sleep.wake("assets")
        assert calls.count("assets") == 1
        assert collector.policy.snapshot("coingecko").last_wall_ms == NOW
        clocks.wall = NOW + 299999
        await sleep.wake("assets")
        assert calls.count("assets") == 1
        clocks.wall += 1
        await sleep.wake("assets")
        assert calls.count("assets") == 2


@pytest.mark.asyncio
async def test_restart_prior_admission_cannot_use_forward_utc_to_burst(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    clocks, sleep = Clocks(), GateSleep()
    calls: list[str] = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query.resource)
        return synthetic_payload(query.resource, now=clocks.wall)

    async with running(path, fetch, clocks, sleep):
        await sleep.settled()
    clocks.wall += DAY_MS
    for _ in range(2):  # restarting again while waiting is not a way around the guard
        sleep = GateSleep()
        async with running(path, fetch, clocks, sleep):
            await sleep.settled()
            assert calls.count("assets") == 1, "prior admission requires a real restart guard"
    sleep = GateSleep()
    async with running(path, fetch, clocks, sleep) as collector:
        await sleep.settled()
        clocks.advance(299999)
        await sleep.wake("assets")
        assert calls.count("assets") == 1
        clocks.advance(1)
        await sleep.wake("assets")
        assert calls.count("assets") == 2
        assert collector.policy.snapshot("coingecko").reserved_weight == 1
