"""Bounded shared reads with optional explicit PUBLIC projection persistence."""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from decimal import Decimal

from stark_trading_os.control.public_data_models import (
    PublicDataPayload,
    PublicDataQuery,
    PublicDataResource,
)
from stark_trading_os.control.public_data_store import (
    PublicDataStoreError,
    PublicSnapshotStore,
    StoredPublicData,
)
from stark_trading_os.integrations.public_data import PublicDataProvider
from stark_trading_os.integrations.public_data.models import (
    MarketData,
    PublicDataItem,
    PublicSource,
)
from stark_trading_os.integrations.public_data.providers import ASSETS

type PublicDataFetcher = Callable[[PublicDataQuery], Awaitable[object]]
CADENCE_MS: dict[PublicDataResource, int] = {
    "markets": 10000, "assets": 300000, "news": 60000, "explorer/capabilities": 300000,
}
_MARKET_SCOPE = "BINANCE_SPOT_24H_STATISTICS"
_MARKET_PROVIDER = "binance-spot-ticker-v1"


def _binance_markets(payload: PublicDataPayload) -> bool:
    # Other injected read-side scopes retain their existing behavior. A mismatched
    # scope cannot hide a Binance row/source from the canonical identity checks.
    return (
        payload.coverage.scope == _MARKET_SCOPE
        or any(item.provider_id == _MARKET_PROVIDER or item.venue_or_chain == "BINANCE:SPOT"
               for item in payload.items)
        or any(source.provider_id == _MARKET_PROVIDER for source in payload.sources)
    )


def _market_rows(payload: PublicDataPayload) -> dict[str, PublicDataItem]:
    """Index only after checking the FULL identity, never the shared provider ID."""
    rows: dict[str, PublicDataItem] = {}
    records: set[str] = set()
    if payload.coverage.scope != _MARKET_SCOPE:
        raise ValueError("INVALID_PUBLIC_MARKET_SCOPE")
    for item in payload.items:
        base = ASSETS.get(item.subject_id)
        data = item.data
        if (
            base is None or item.subject_id in rows or item.record_id in records
            or item.provider_id != _MARKET_PROVIDER or item.venue_or_chain != "BINANCE:SPOT"
            or not isinstance(data, MarketData)
            or data.instrument.venue != "BINANCE" or data.instrument.market_kind != "SPOT"
            or data.instrument.base_asset != base or data.instrument.quote_asset != "USDT"
            or data.instrument.symbol != base + "USDT"
            or data.window_open_at_ms > data.window_close_at_ms
            or data.window_close_at_ms != item.event_time_ms or Decimal(data.last_price) <= 0
            or item.quality not in {"fresh", "stale"}
            or (item.subject_id in payload.coverage.gaps and item.quality != "stale")
        ):
            raise ValueError("INVALID_PUBLIC_MARKET_OBSERVATION")
        rows[item.subject_id] = item
        records.add(item.record_id)
    return rows


def _merge_markets(
    query: PublicDataQuery, current: PublicDataPayload, previous: PublicDataPayload | None,
) -> PublicDataPayload:
    rows = _market_rows(current)
    # Incoming failures cannot masquerade as current observations. Only the
    # explicit history branch below creates returned/gap intersections.
    if set(rows) & set(current.coverage.gaps):
        raise ValueError("INVALID_PUBLIC_MARKET_COVERAGE")
    gaps = set(current.coverage.gaps) | (set(query.asset_ids) - rows.keys())
    if previous is not None and previous.mode == current.mode and _binance_markets(previous):
        for subject, item in _market_rows(previous).items():
            if subject in gaps and subject not in rows:
                rows[subject] = item.model_copy(update={"quality": "stale"})
    value = current.model_dump(mode="json")
    items = [rows[subject] for subject in query.asset_ids if subject in rows]
    value.update(
        items=[item.model_dump(mode="json") for item in items],
        as_of_ms=max((item.available_at_ms for item in items), default=None),
        quality=("unavailable" if not items else
                 "stale" if all(item.quality == "stale" for item in items) else
                 "partial" if gaps or any(item.quality != "fresh" for item in items) else "fresh"),
    )
    value["coverage"].update(requested_subjects=list(query.asset_ids),
                             returned_subjects=[item.subject_id for item in items],
                             gaps=sorted(gaps))
    value["missing_capabilities"] = sorted(set(current.missing_capabilities) | {
        f"market.statistics:{subject}" for subject in gaps
    })
    # Current source evidence is deliberately untouched: sources have no subject
    # identity, so ETH/SOL success cannot be attributed to historical BTC.
    return PublicDataPayload.model_validate(value)


def provider_fetcher(provider: PublicDataProvider) -> PublicDataFetcher:
    async def fetch(query: PublicDataQuery) -> object:
        if query.resource == "markets":
            batch = await provider.fetch_markets(query.asset_ids)
        elif query.resource == "assets":
            batch = await provider.fetch_assets(query.asset_ids)
        elif query.resource == "news":
            batch = await provider.fetch_news(query.limit)
        else:
            batch = await provider.fetch_explorer_capabilities(query.chain_id)
        return batch.model_dump(mode="json")

    return fetch


def utc_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True, slots=True)
class _Entry:
    payload: PublicDataPayload
    fetched_at_ms: int
    refresh_at_ms: int


class PublicDataService:
    def __init__(
        self, fetcher: PublicDataFetcher, *, clock_ms: Callable[[], int] = utc_ms,
        store: PublicSnapshotStore | None = None,
        snapshot_only: bool = False,
    ) -> None:
        if snapshot_only and store is None:
            raise ValueError("PUBLIC_SNAPSHOT_STORE_REQUIRED")
        self._fetcher = fetcher
        self._store = store
        self.snapshot_only = snapshot_only
        self.clock_ms = clock_ms
        self._cache: dict[PublicDataQuery, _Entry] = {}
        self._last_good: dict[PublicDataQuery, PublicDataPayload] = {}
        self._pending: dict[PublicDataQuery, asyncio.Task[PublicDataPayload]] = {}
        self._closed = False

    async def read(self, query: PublicDataQuery) -> PublicDataPayload:
        if self._closed:
            raise RuntimeError("DATA_SERVICE_CLOSED")
        # Page filters are projections of one bounded public collection, not
        # separate permits to hit the same provider for each user/filter.
        key = PublicDataQuery(resource=query.resource, limit=50) if query.resource == "news" else (
            PublicDataQuery(resource=query.resource)
        )
        now = self.clock_ms()
        revision = 0
        if self._store is not None:
            stored = self._store.load(key.resource)
            if self.snapshot_only:
                return self.project_snapshot(query, stored, now=now, mode=self.store.mode)
            self._restore(key, stored)
            revision = 0 if stored is None else stored.revision
        entry = self._cache.get(key)
        if entry is not None and now < entry.refresh_at_ms:
            return self._select(self._quality_at(entry.payload, now), query)
        task = self._pending.get(key)
        if task is None:
            task = asyncio.create_task(self._load(key, revision))
            self._pending[key] = task
        # A disconnected reader must not cancel the shared fetch for other readers.
        return self._select(await asyncio.shield(task), query)

    def project_snapshot(
        self, query: PublicDataQuery, stored: StoredPublicData | None, *, now: int, mode: str,
    ) -> PublicDataPayload:
        """Project one authoritative read; no RAM fallback or provider permit."""
        key = PublicDataQuery(resource=query.resource, limit=50 if query.resource == "news" else 20)
        self._restore(key, stored)
        entry = self._cache.get(key)
        payload = entry.payload if entry is not None else self._failed(
            key, None, (PublicSource(provider_id="public-data-collector",
                status="UNAVAILABLE", reason_code="SNAPSHOT_NOT_AVAILABLE"),), mode=mode,
        )
        return self._select(self._quality_at(payload, now), query)

    @property
    def store(self) -> PublicSnapshotStore:
        if self._store is None:
            raise PublicDataStoreError()
        return self._store

    async def collect(
        self, resource: PublicDataResource, *, interval_ms: int,
        before_save: Callable[[int], None],
    ) -> PublicDataPayload:
        """Trusted collector lane only; caller must reserve budget before entry.

        before_save durably records the resulting deadline before snapshot commit.
        The collector retains an unresolved reservation until both commits succeed.
        """
        if self._closed or not self.snapshot_only or interval_ms < CADENCE_MS[resource]:
            raise RuntimeError("PUBLIC_COLLECTION_NOT_ALLOWED")
        key = PublicDataQuery(resource=resource, limit=50 if resource == "news" else 20)
        if key in self._pending:
            raise RuntimeError("PUBLIC_COLLECTION_ALREADY_PENDING")
        stored = self.store.load(resource)
        self._restore(key, stored)
        if stored is not None and self.clock_ms() < stored.refresh_at_ms:
            raise RuntimeError("PUBLIC_COLLECTION_NOT_DUE")
        task = asyncio.create_task(self._load(
            key, 0 if stored is None else stored.revision,
            minimum_ttl_ms=interval_ms, before_save=before_save,
        ))
        self._pending[key] = task
        return await task

    @staticmethod
    def _select(payload: PublicDataPayload, query: PublicDataQuery) -> PublicDataPayload:
        value = payload.model_dump(mode="json")
        coverage = payload.coverage.model_dump(mode="json")
        selected = payload.items
        missing: list[str] = []
        if query.resource in {"markets", "assets"}:
            selected = tuple(item for item in selected if item.subject_id in query.asset_ids)
            present = {item.subject_id for item in selected}
            absent = set(query.asset_ids) - present
            missing = sorted(absent)
            if query.resource == "markets":
                missing = sorted(set(missing) | (set(payload.coverage.gaps) & set(query.asset_ids)))
            coverage.update(requested_subjects=list(query.asset_ids),
                            returned_subjects=sorted(present), gaps=missing)
            unrelated = {"bitcoin", "ethereum", "solana"} - set(query.asset_ids)
            value["missing_capabilities"] = sorted({
                capability for capability in payload.missing_capabilities
                if not any(capability.endswith(":" + asset) for asset in unrelated)
            } | {f"{query.resource}:{asset}" for asset in absent})
        elif query.resource == "news":
            selected = selected[:query.limit]
            missing = list(payload.coverage.gaps)
        elif query.chain_id is not None:
            selected = tuple(
                item for item in selected if getattr(item.data, "chain_id", None) == query.chain_id
            )
            missing = [] if selected else [query.chain_id]
            coverage.update(requested_subjects=[query.chain_id],
                            returned_subjects=[query.chain_id] if selected else [], gaps=missing)
            value["missing_capabilities"] = [
                cap for cap in payload.missing_capabilities if cap.endswith(":" + query.chain_id)
            ]
        if selected:
            if all(item.quality == "stale" for item in selected):
                value["quality"] = "stale"
            elif missing or any(item.quality != "fresh" for item in selected):
                value["quality"] = "partial"
            else:
                value["quality"] = "fresh"
            value["as_of_ms"] = max(item.available_at_ms for item in selected)
        elif query.resource != "news" or payload.quality == "unavailable":
            value.update(quality="unavailable", as_of_ms=None)
        value["items"] = [item.model_dump(mode="json") for item in selected]
        value["coverage"] = coverage
        return PublicDataPayload.model_validate(value)

    def _restore(self, query: PublicDataQuery, stored: StoredPublicData | None) -> None:
        if stored is None:
            self._cache.pop(query, None)
            self._last_good.pop(query, None)
            return
        if query.resource == "markets" and (
            _binance_markets(stored.payload)
            or (stored.last_good is not None and _binance_markets(stored.last_good))
        ):
            try:
                _market_rows(stored.payload)
                if stored.last_good is not None:
                    _market_rows(stored.last_good)
            except ValueError:
                raise PublicDataStoreError() from None
        self._cache[query] = _Entry(stored.payload, stored.fetched_at_ms, stored.refresh_at_ms)
        if stored.last_good is None:
            self._last_good.pop(query, None)
        else:
            self._last_good[query] = stored.last_good

    async def _load(
        self, query: PublicDataQuery, revision: int = 0, *, minimum_ttl_ms: int = 0,
        before_save: Callable[[int], None] | None = None,
    ) -> PublicDataPayload:
        try:
            # Failure projection and save must share this immutable observation.
            last_good = self._last_good.get(query)
            try:
                raw = await asyncio.wait_for(self._fetcher(query), timeout=6.0)
                payload = PublicDataPayload.model_validate(raw)
                if self.snapshot_only:
                    try:
                        self.store.validate_payload(query.resource, payload)
                    except PublicDataStoreError:
                        raise ValueError("INVALID_PUBLIC_OBSERVATION") from None
                if self._store is not None and payload.mode != self._store.mode:
                    raise PublicDataStoreError()
                if query.resource == "markets" and (
                    _binance_markets(payload)
                    or (last_good is not None and _binance_markets(last_good))
                ):
                    payload = _merge_markets(query, payload, last_good)
                elif payload.quality == "unavailable":
                    payload = self._failed(query, last_good, payload.sources, payload.mode)
                else:
                    last_good = payload
            except (asyncio.CancelledError, PublicDataStoreError):
                raise
            except Exception:
                payload = self._failed(
                    query, last_good,
                    mode=(self._store.mode if self._store is not None else
                          last_good.mode if last_good is not None else "live_readonly")
                )
            if query.resource == "markets" and _binance_markets(payload):
                # Store equality includes coverage/times/identity, not just rows.
                # Persist one merged observation; history quality may only decay.
                last_good = payload if payload.items else None
            now = self.clock_ms()
            ttl = max(CADENCE_MS[query.resource], minimum_ttl_ms)
            if payload.quality == "unavailable":
                ttl = max(ttl, 60000)
            if self.snapshot_only and any(s.status not in {"OK", "STALE"} for s in payload.sources):
                ttl = max(ttl, 60000)
            for source in payload.sources:
                if source.retry_after_seconds is not None:
                    ttl = max(ttl, math.ceil(source.retry_after_seconds) * 1000)
            if before_save is not None:
                before_save(now + ttl)
            if self._store is not None:
                stored = self._store.save(
                    query.resource, payload=payload, last_good=last_good,
                    fetched_at_ms=now, refresh_at_ms=now + ttl, expected_revision=revision,
                )
                if stored is None:
                    # A later completion already committed. Never publish this
                    # fetch over its current/last-good/backoff state, even in RAM.
                    stored = self._store.load(query.resource)
                    if stored is None:
                        raise PublicDataStoreError()
                self._restore(query, stored)
                return self._quality_at(stored.payload, now)
            if last_good is not None:
                self._last_good[query] = last_good
            self._cache[query] = _Entry(payload, now, now + ttl)
            return self._quality_at(payload, now)
        finally:
            self._pending.pop(query, None)

    @staticmethod
    def _failed(
        query: PublicDataQuery, previous: PublicDataPayload | None,
        sources: tuple[PublicSource, ...] = (), mode: str = "live_readonly",
    ) -> PublicDataPayload:
        if not sources:
            sources = (PublicSource(
                provider_id="public-data-service", status="UNAVAILABLE",
                reason_code="READ_SIDE_FETCH_FAILED", retry_after_seconds=60,
            ),)
        if query.resource == "markets" and (previous is None or _binance_markets(previous)):
            current = PublicDataPayload.model_validate({
                "mode": mode, "as_of_ms": None, "quality": "unavailable",
                "coverage": {"scope": _MARKET_SCOPE,
                             "requested_subjects": query.asset_ids,
                             "returned_subjects": [], "gaps": query.asset_ids},
                "missing_capabilities": [f"market.statistics:{asset}" for asset in query.asset_ids],
                "sources": sources, "items": [],
            })
            return _merge_markets(query, current, previous)
        if previous is not None:
            old_sources = {source.provider_id: source for source in previous.sources}
            error_sources = []
            for source in sources:
                old = old_sources.get(source.provider_id)
                observed = old.last_success_at_ms if old is not None else previous.as_of_ms
                error_sources.append(source.model_copy(update={"last_success_at_ms": observed}))
            value = previous.model_dump(mode="json")
            value.update(
                quality="stale",
                items=[{**item.model_dump(mode="json"), "quality": "stale"}
                       for item in previous.items],
                sources=[source.model_dump(mode="json") for source in error_sources],
            )
            return PublicDataPayload.model_validate(value)
        subjects = (
            ["news"] if query.resource == "news" else
            list(query.asset_ids) if query.resource in {"markets", "assets"} else
            ["1", "56", "8453", "42161", "137", "10"]
        )
        return PublicDataPayload.model_validate({
            "mode": mode, "as_of_ms": None, "quality": "unavailable",
            "coverage": {"scope": query.resource, "requested_subjects": subjects,
                         "returned_subjects": [], "gaps": subjects},
            "missing_capabilities": [query.resource],
            "sources": [source.model_dump(mode="json") for source in sources], "items": [],
        })

    @staticmethod
    def _quality_at(payload: PublicDataPayload, now: int) -> PublicDataPayload:
        if not payload.items:
            if (
                payload.coverage.scope == "NEWS_FEED" and payload.as_of_ms is not None
                and now > payload.as_of_ms + 60000
            ):
                return payload.model_copy(update={"quality": "stale"})
            return payload
        value = payload.model_dump(mode="json")
        items = [
            item.model_copy(update={"quality": "stale"})
            if (item.valid_until_ms is not None and now > item.valid_until_ms)
            else item
            for item in payload.items
        ]
        if any(item.quality == "stale" for item in items):
            value["quality"] = (
                "stale" if all(item.quality == "stale" for item in items) else "partial"
            )
            value["items"] = [item.model_dump(mode="json") for item in items]
        return PublicDataPayload.model_validate(value)

    async def close(self) -> None:
        self._closed = True
        tasks = tuple(self._pending.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._pending.clear()
