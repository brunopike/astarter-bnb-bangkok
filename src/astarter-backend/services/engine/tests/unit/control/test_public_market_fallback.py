"""Offline synthetic Binance cases, NOT a replay of the unsaved live +63ms body."""

from __future__ import annotations

import asyncio
import copy
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from stark_trading_os.control.public_data_models import PublicDataPayload, PublicDataQuery
from stark_trading_os.control.public_data_service import PublicDataService, provider_fetcher
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError
from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
from stark_trading_os.integrations.contracts import Instrument
from stark_trading_os.integrations.public_data import PublicDataProvider
from stark_trading_os.integrations.public_data.models import MarketData
from stark_trading_os.integrations.public_data.providers import ASSETS
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse
from tests.unit.control.test_public_data_persistence import NOW

QUERY = PublicDataQuery(resource="markets")


class MarketScenario:
    """Use the original strict adapter/provider with deterministic, local wire bodies."""

    def __init__(self) -> None:
        self.now = NOW
        self.future: dict[str, int] = {}
        self.failed: set[str] = set()
        self.retry = "120"
        self.calls = 0
        self.current: PublicDataPayload | None = None

    async def __call__(self, query: PublicDataQuery) -> object:
        responses = tuple(
            HttpResponse(429, b"{}", (("retry-after", self.retry),)) if asset in self.failed else
            HttpResponse(200, json.dumps({
                "symbol": base + "USDT", "lastPrice": "60000.123456789012345678",
                "volume": "2.00000000", "quoteVolume": "120000.00000000",
                "openTime": self.now - 86400000,
                "closeTime": self.now + self.future.get(asset, -1000),
            }).encode()) for asset, base in ASSETS.items()
        )
        transport = FixtureTransport(responses)
        provider = PublicDataProvider(market_transport=transport, clock_ms=lambda: self.now)
        raw = await provider_fetcher(provider)(query)
        self.calls += transport.calls
        self.current = PublicDataPayload.model_validate(raw)
        return raw


@pytest.mark.asyncio
@pytest.mark.parametrize("future_ms", [63, 600000])
async def test_future_btc_keeps_last_legal_row_through_partials_reopen_and_recovery(
    tmp_path: Path, future_ms: int,
) -> None:
    scenario = MarketScenario()
    path = tmp_path / "synthetic-public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(scenario, clock_ms=lambda: scenario.now,
                                store=store, snapshot_only=True)
    deadlines: list[int] = []
    try:
        initial = await service.collect("markets", interval_ms=10000, before_save=deadlines.append)
        assert initial.quality == "fresh"
        original = initial.items[0]
        assert original.subject_id == "bitcoin"
        scenario.future = {"bitcoin": future_ms}
        for iteration in range(3):
            if iteration == 2:
                await service.close()
                store.close()
                store = PublicDataStore(path, mode="offline_fixture")
                service = PublicDataService(scenario, clock_ms=lambda: scenario.now,
                                            store=store, snapshot_only=True)
            scenario.now = deadlines[-1]
            result = await service.collect("markets", interval_ms=10000,
                                           before_save=deadlines.append)
            current = scenario.current
            assert current is not None
            assert tuple(item.subject_id for item in current.items) == ("ethereum", "solana")
            assert [s.status for s in current.sources] == ["INVALID_RESPONSE", "OK", "OK"]
            assert current.sources[0].last_success_at_ms is None
            rows = {item.subject_id: item for item in result.items}
            assert set(rows) == set(ASSETS), "old legal BTC must not be dropped by a partial"
            assert rows["bitcoin"].quality == "stale"
            assert rows["bitcoin"].model_dump(exclude={"quality"}) == original.model_dump(
                exclude={"quality"},
            )
            assert rows["ethereum"] == current.items[0]
            assert rows["solana"] == current.items[1]
            assert rows["ethereum"].available_at_ms == scenario.now
            assert isinstance(rows["bitcoin"].data, MarketData)
            assert rows["bitcoin"].data.last_price == "60000.123456789012345678"
            assert result.quality == "partial" and result.as_of_ms == scenario.now
            assert result.sources == current.sources  # shared provider ID is NOT an asset key
            assert result.coverage.returned_subjects == tuple(ASSETS)
            assert result.coverage.gaps == ("bitcoin",)
            assert result.missing_capabilities == ("market.statistics:bitcoin",)
            assert deadlines[-1] == scenario.now + 60000
            state = store.load("markets")
            assert state is not None and state.last_good == state.payload
            assert state.payload == result
            # A GET, filter or store reopen may not freshen BTC or clear its collection gap.
            selected = await service.read(PublicDataQuery(
                resource="markets", asset_ids=("bitcoin",),
            ))
            assert selected.items == (rows["bitcoin"],)
            assert selected.quality == "stale" and selected.coverage.gaps == ("bitcoin",)
            eth = await service.read(PublicDataQuery(resource="markets", asset_ids=("ethereum",)))
            assert eth.quality == "fresh" and eth.coverage.gaps == ()
            assert eth.missing_capabilities == ()
        assert scenario.calls == 12
        scenario.now = deadlines[-1]
        scenario.future.clear()
        recovered = await service.collect("markets", interval_ms=10000,
                                          before_save=deadlines.append)
        assert recovered.quality == "fresh" and recovered.coverage.gaps == ()
        assert recovered.missing_capabilities == ()
        assert recovered.items[0].event_time_ms == scenario.now - 1000
        assert recovered.items[0].record_id != original.record_id
        assert deadlines[-1] == scenario.now + 10000
        assert scenario.calls == 15
    finally:
        await service.close()
        store.close()


@pytest.mark.asyncio
async def test_selection_preserves_current_gap_when_historical_row_is_displayed() -> None:
    scenario = MarketScenario()
    raw = await scenario(QUERY)
    value = PublicDataPayload.model_validate(raw).model_dump(mode="json")
    value["items"][0]["quality"] = "stale"
    value["quality"] = "partial"
    value["coverage"]["gaps"] = ["bitcoin"]
    value["missing_capabilities"] = ["market.statistics:bitcoin"]
    payload = PublicDataPayload.model_validate(value)
    selected = PublicDataService._select(payload, PublicDataQuery(
        resource="markets", asset_ids=("bitcoin",),
    ))
    assert selected.coverage.returned_subjects == ("bitcoin",)
    assert selected.coverage.gaps == ("bitcoin",), "displayed history is not current coverage"
    assert selected.quality == "stale"


@pytest.mark.asyncio
@pytest.mark.parametrize("seed", ["none", "partial", "full"])
@pytest.mark.parametrize("expired", [False, True])
async def test_full_failure_uses_only_legal_history_and_current_retry_evidence(
    tmp_path: Path, seed: str, expired: bool,
) -> None:
    scenario = MarketScenario()
    store = PublicDataStore(tmp_path / "synthetic.sqlite", mode="offline_fixture")
    service = PublicDataService(scenario, store=store, snapshot_only=True,
                                clock_ms=lambda: scenario.now)
    original: PublicDataPayload | None = None
    try:
        if seed != "none":
            scenario.future = {"bitcoin": 63} if seed == "partial" else {}
            original = await service.collect(
                "markets", interval_ms=10000, before_save=lambda _: None,
            )
            if seed == "partial":
                assert original.coverage.gaps == ("bitcoin",)
                assert original.coverage.returned_subjects == ("ethereum", "solana")
        # Partial seeds have a 60s floor. Full seeds also exercise unexpired reuse.
        scenario.now += 60001 if expired or seed == "partial" else 10000
        scenario.failed = set(ASSETS)
        scenario.retry = "7201"
        result = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        assert scenario.current is not None
        assert result.sources == scenario.current.sources
        assert all(s.status == "RATE_LIMITED" and s.last_success_at_ms is None
                   and s.retry_after_seconds == 7201 for s in result.sources)
        assert result.coverage.gaps == tuple(ASSETS)
        assert result.coverage.returned_subjects == tuple(item.subject_id for item in result.items)
        assert set(result.missing_capabilities) == {f"market.statistics:{a}" for a in ASSETS}
        if original is None:
            assert result.quality == "unavailable" and result.items == ()
            assert result.as_of_ms is None
        else:
            assert result.quality == "stale" and result.as_of_ms == original.as_of_ms
            assert [i.model_dump(exclude={"quality"}) for i in result.items] == [
                i.model_dump(exclude={"quality"}) for i in original.items
            ]
            assert all(i.quality == "stale" for i in result.items)
        saved = store.load("markets")
        assert saved is not None and saved.refresh_at_ms == scenario.now + 7201000
        assert saved.last_good == (result if result.items else None)
        calls = scenario.calls
        for _ in range(2):
            scenario.now += 100000
            observed = await service.read(QUERY)
            assert observed.items == result.items and observed.sources == result.sources
            assert observed.coverage == result.coverage and observed.quality == result.quality
            assert scenario.calls == calls
    finally:
        await service.close()
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["exception", "timeout"])
async def test_entire_fetch_failure_preserves_history_without_success_attribution(
    tmp_path: Path, failure: str,
) -> None:
    scenario = MarketScenario()
    finished = asyncio.Event()

    async def fetch(query: PublicDataQuery) -> object:
        if scenario.calls == 0:
            return await scenario(query)
        if failure == "exception":
            raise RuntimeError("synthetic failure")
        try:
            await asyncio.Event().wait()  # Exercise the UNCHANGED six-second service deadline.
            raise AssertionError("unreachable without releasing the timeout fixture")
        finally:
            finished.set()

    store = PublicDataStore(tmp_path / "synthetic.sqlite", mode="offline_fixture")
    service = PublicDataService(fetch, store=store, snapshot_only=True,
                                clock_ms=lambda: scenario.now)
    try:
        original = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        scenario.now += 10000
        failed = await asyncio.wait_for(service.collect(
            "markets", interval_ms=10000, before_save=lambda _: None,
        ), timeout=8)
        assert failure != "timeout" or finished.is_set()
        assert failed.quality == "stale" and failed.coverage.gaps == tuple(ASSETS)
        assert failed.as_of_ms == original.as_of_ms
        assert all(i.quality == "stale" for i in failed.items)
        assert [i.model_dump(exclude={"quality"}) for i in failed.items] == [
            i.model_dump(exclude={"quality"}) for i in original.items
        ]
        assert len(failed.sources) == 1
        assert failed.sources[0].reason_code == "READ_SIDE_FETCH_FAILED"
        assert failed.sources[0].last_success_at_ms is None
        assert failed.sources[0].retry_after_seconds == 60
        saved = store.load("markets")
        assert saved is not None and saved.last_good == saved.payload == failed
        assert saved.refresh_at_ms == scenario.now + 60000
    finally:
        await service.close()
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("warm", [False, True])
@pytest.mark.parametrize("mutation", [
    "provider", "venue", "instrument_venue", "base", "quote", "symbol", "kind", "subject",
    "duplicate_subject", "duplicate_record", "mode", "scope", "future", "decimal",
    "window", "quality", "fresh_gap",
])
async def test_malformed_current_batch_cannot_launder_new_observations(
    tmp_path: Path, warm: bool, mutation: str,
) -> None:
    scenario = MarketScenario()
    original = PublicDataPayload.model_validate(await scenario(QUERY))
    scenario.now += 10000
    raw: dict[str, Any] = PublicDataPayload.model_validate(await scenario(QUERY)).model_dump(
        mode="json",
    )
    item = raw["items"][0]
    instrument = item["data"]["instrument"]
    if mutation in {"provider", "venue", "subject", "quality"}:
        key, value = {"provider": ("provider_id", "other-provider"),
                      "venue": ("venue_or_chain", "OTHER:SPOT"),
                      "subject": ("subject_id", "wrapped-bitcoin"),
                      "quality": ("quality", "unavailable")}[mutation]
        item[key] = value
    elif mutation in {"instrument_venue", "base", "quote", "symbol", "kind"}:
        key, value = {"instrument_venue": ("venue", "OTHER"), "base": ("base_asset", "ETH"),
                      "quote": ("quote_asset", "USDC"), "symbol": ("symbol", "ETHUSDT"),
                      "kind": ("market_kind", "PERP")}[mutation]
        instrument[key] = value
    elif mutation == "duplicate_subject":
        raw["items"][1] = copy.deepcopy(item)
        raw["items"][1]["record_id"] = "distinct-record-same-subject"
    elif mutation == "duplicate_record":
        raw["items"][1]["record_id"] = item["record_id"]
    elif mutation == "mode":
        raw["mode"] = "live_readonly"
    elif mutation == "scope":
        raw["coverage"]["scope"] = "ASSET_PROFILES"
    elif mutation == "future":
        item["event_time_ms"] = item["received_at_ms"] + 63
    elif mutation == "decimal":
        item["data"]["last_price"] = "NaN"
    elif mutation == "window":
        item["data"]["window_open_at_ms"] = item["data"]["window_close_at_ms"] + 1
    elif mutation == "fresh_gap":
        raw["coverage"]["gaps"] = ["bitcoin"]

    async def fetch(query: PublicDataQuery) -> object:
        return raw

    store = PublicDataStore(tmp_path / "synthetic.sqlite", mode="offline_fixture")
    if warm:
        store.save("markets", payload=original, last_good=original, fetched_at_ms=NOW,
                   refresh_at_ms=NOW + 10000, expected_revision=0)
    service = PublicDataService(fetch, store=store, snapshot_only=True,
                                clock_ms=lambda: scenario.now)
    try:
        result = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        assert result.quality == ("stale" if warm else "unavailable")
        assert result.coverage.gaps == tuple(ASSETS)
        assert all(s.status == "UNAVAILABLE" for s in result.sources)
        assert [i.model_dump(exclude={"quality"}) for i in result.items] == (
            [i.model_dump(exclude={"quality"}) for i in original.items] if warm else []
        )
        saved = store.load("markets")
        assert saved is not None and saved.payload == result
    finally:
        await service.close()
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["provider", "scope", "quote", "duplicate", "chronology"])
async def test_corrupt_history_is_fail_closed_even_if_store_observation_equality_holds(
    tmp_path: Path, mutation: str,
) -> None:
    scenario = MarketScenario()
    path = tmp_path / "synthetic.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(scenario, store=store, snapshot_only=True,
                                clock_ms=lambda: scenario.now)
    try:
        original = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        raw = original.model_dump(mode="json")
        if mutation == "provider":
            raw["items"][0]["provider_id"] = "other-provider"
        elif mutation == "scope":
            raw["coverage"]["scope"] = "ASSET_PROFILES"
        elif mutation == "quote":
            raw["items"][0]["data"]["instrument"]["quote_asset"] = "USDC"
        elif mutation == "duplicate":
            raw["items"][1] = copy.deepcopy(raw["items"][0])
            raw["items"][1]["record_id"] = "different-record-same-identity"
        else:
            raw["items"][0]["event_time_ms"] = NOW + 63
        with sqlite3.connect(path) as db:
            db.execute("UPDATE public_data_cache SET payload_json=?, last_good_json=?",
                       (json.dumps(raw), json.dumps(raw)))
        with pytest.raises(PublicDataStoreError, match="^PUBLIC_DATA_STORE_FAILED$"):
            await service.read(QUERY)
        assert scenario.calls == 3
    finally:
        await service.close()
        store.close()


@pytest.mark.asyncio
async def test_no_cross_mode_history_and_store_inequality_still_rejected(tmp_path: Path) -> None:
    scenario = MarketScenario()
    original = PublicDataPayload.model_validate(await scenario(QUERY))
    failed = PublicDataService._failed(QUERY, original, mode="live_readonly")
    assert failed.items == () and failed.quality == "unavailable"
    scenario.now += 10000
    scenario.future = {"bitcoin": 63}
    store = PublicDataStore(tmp_path / "synthetic.sqlite", mode="offline_fixture")
    current = PublicDataPayload.model_validate(await scenario(QUERY))
    try:
        with pytest.raises(PublicDataStoreError):
            store.save("markets", payload=current, last_good=original,
                       fetched_at_ms=scenario.now, refresh_at_ms=scenario.now + 60000,
                       expected_revision=0)
        assert store.load("markets") is None
    finally:
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["exception", "unavailable"])
async def test_canonical_late_failure_returns_cas_winner_after_same_service_restore(
    tmp_path: Path, failure: str,
) -> None:
    scenario = MarketScenario()
    original = PublicDataPayload.model_validate(await scenario(QUERY))
    path = tmp_path / "synthetic.sqlite"
    older = PublicDataStore(path, mode="offline_fixture")
    newer = PublicDataStore(path, mode="offline_fixture")
    older.save("markets", payload=original, last_good=original, fetched_at_ms=NOW,
               refresh_at_ms=NOW + 10000, expected_revision=0)
    started, release = asyncio.Event(), asyncio.Event()
    scenario.now += 10000

    async def slow(query: PublicDataQuery) -> object:
        started.set()
        await release.wait()
        if failure == "exception":
            raise RuntimeError("synthetic failure")
        scenario.failed = set(ASSETS)
        return await scenario(query)

    old_service = PublicDataService(slow, store=older, clock_ms=lambda: scenario.now)
    new_service = PublicDataService(scenario, store=newer, clock_ms=lambda: scenario.now)
    task = asyncio.create_task(old_service.read(QUERY))
    try:
        await asyncio.wait_for(started.wait(), 2)
        winner = await new_service.read(QUERY)
        committed = newer.load("markets")
        assert committed is not None and committed.revision == 2
        assert await old_service.read(QUERY) == winner
        release.set()
        assert await task == winner
        assert older.load("markets") == committed
        assert committed.last_good == winner and committed.refresh_at_ms == scenario.now + 10000
    finally:
        release.set()
        await old_service.close()
        await new_service.close()
        await asyncio.gather(task, return_exceptions=True)
        older.close()
        newer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["cancel", "before_save"])
async def test_uncommitted_merge_cannot_publish_history_or_current(
    tmp_path: Path, failure: str,
) -> None:
    scenario = MarketScenario()
    started = asyncio.Event()

    async def fetch(query: PublicDataQuery) -> object:
        if scenario.calls and failure == "cancel":
            started.set()
            await asyncio.Event().wait()
        return await scenario(query)

    def reject_save(deadline: int) -> None:
        raise RuntimeError("synthetic save failure")

    store = PublicDataStore(tmp_path / "synthetic.sqlite", mode="offline_fixture")
    service = PublicDataService(fetch, store=store, snapshot_only=True,
                                clock_ms=lambda: scenario.now)
    try:
        original = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        committed = store.load("markets")
        scenario.now += 10000
        scenario.future = {"bitcoin": 63}
        task = asyncio.create_task(service.collect(
            "markets", interval_ms=10000, before_save=reject_save,
        ))
        if failure == "cancel":
            await asyncio.wait_for(started.wait(), 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(RuntimeError, match="synthetic save failure"):
                await task
        assert store.load("markets") == committed
        assert await service.read(QUERY) == original
    finally:
        await service.close()
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("future_ms", [63, 600000])
async def test_strict_adapter_samples_receipt_once_and_rejects_future(future_ms: int) -> None:
    clock_calls = 0

    def clock() -> int:
        nonlocal clock_calls
        clock_calls += 1
        return NOW

    instrument = Instrument(venue="BINANCE", market_kind="SPOT", symbol="BTCUSDT",
                            base_asset="BTC", quote_asset="USDT")
    transport = FixtureTransport((HttpResponse(200, json.dumps({
        "symbol": "BTCUSDT", "lastPrice": "60000", "volume": "2", "quoteVolume": "120000",
        "openTime": NOW - 86400000, "closeTime": NOW + future_ms,
    }).encode()),))
    result = await BinanceSpotTickerProvider(transport, clock_ms=clock).fetch_snapshot(instrument)
    assert result.status == "INVALID_RESPONSE"
    assert result.snapshot is None and result.provenance is None
    assert clock_calls == transport.calls == 1
