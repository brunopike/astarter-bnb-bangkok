"""Finite provider reads; no automatic configuration, network client, or execution."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, DecimalException
from hashlib import sha256
from html import unescape
from html.parser import HTMLParser
from typing import Any, Literal
from urllib.parse import unquote, urlencode, urlsplit

from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
from stark_trading_os.integrations.contracts import DataResult, Instrument, Status
from stark_trading_os.integrations.public_data.models import (
    AssetData,
    Coverage,
    ExplorerCapability,
    MarketData,
    Mode,
    NewsData,
    PublicDataBatch,
    PublicDataItem,
    PublicSource,
    Quality,
)
from stark_trading_os.integrations.transport import (
    MAX_RESPONSE_BYTES,
    Failure,
    HttpRequest,
    HttpResponse,
    HttpTransport,
    http_failure,
    parse_object,
    send_once,
)

ASSETS = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL"}
CHAINS = ("1", "56", "8453", "42161", "137", "10")


def utc_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True, slots=True)
class PublicDataCredentials:
    coingecko_api_key: str | None = field(default=None, repr=False)
    blockbeats_api_key: str | None = field(default=None, repr=False)
    coingecko_tier: Literal["pro", "demo"] = "pro"

    def __post_init__(self) -> None:
        if self.coingecko_tier not in {"pro", "demo"} or any(
            value is not None
            and (
                type(value) is not str
                or not 1 <= len(value) <= 1024
                or not value.isascii()
                or any(not 33 <= ord(c) <= 126 for c in value)
            )
            for value in (self.coingecko_api_key, self.blockbeats_api_key)
        ):
            raise ValueError("INVALID_PUBLIC_DATA_CONFIGURATION")


def _selection(ids: tuple[str, ...]) -> tuple[str, ...]:
    if (
        type(ids) is not tuple
        or not 1 <= len(ids) <= 3
        or any(type(i) is not str or i not in ASSETS for i in ids)
        or len(set(ids)) != len(ids)
    ):
        raise ValueError("INVALID_ASSET_SELECTION")
    return ids


def _number(value: Any) -> str | None:
    if value is None:
        return None
    if type(value) not in {str, int, Decimal}:
        raise ValueError("INVALID_NUMBER")
    try:
        number = Decimal(value)
        if not number.is_finite() or number < 0 or number.adjusted() > 100:
            raise ValueError("INVALID_NUMBER")
        if number == 0:
            return "0"
        exponent = number.as_tuple().exponent
        if not isinstance(exponent, int) or exponent < -128 or len(number.as_tuple().digits) > 128:
            raise ValueError("INVALID_NUMBER")
        text = format(number, "f")
        if len(text) > 128:
            raise ValueError("INVALID_NUMBER")
        return "0" if number == 0 else text
    except DecimalException:
        raise ValueError("INVALID_NUMBER") from None


def _timestamp(value: Any) -> int:
    if type(value) is int or (type(value) is str and value.isascii() and value.isdigit()):
        text = str(value)
        if len(text) not in {10, 13}:
            raise ValueError("INVALID_SOURCE_TIME")
        return int(text) * (1000 if len(text) == 10 else 1)
    if type(value) is str:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            return int(dt.timestamp() * 1000)
    raise ValueError("INVALID_SOURCE_TIME")


def _blockbeats_timestamp(value: Any) -> int:
    # shortcut: UTC+8 matched official pages 374443/374442/374441; recheck vendor time changes.
    if type(value) is str and re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}", value
    ):
        return _timestamp(value + "+08:00")
    return _timestamp(value)


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "iframe", "object"}:
            self.hidden += 1
        elif tag in {"br", "p", "div", "li"}:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "iframe", "object"}:
            self.hidden = max(0, self.hidden - 1)
        self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def _plain(value: Any, maximum: int) -> str:
    if type(value) is not str or len(value) > 100000:
        raise ValueError("INVALID_TEXT")
    parser = _Text()
    parser.feed(value)
    parser.close()
    return " ".join("".join(parser.parts).split())[:maximum]


def _url(value: Any) -> str:
    if (
        type(value) is not str
        or len(value) > 2048
        or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise ValueError("INVALID_NEWS_URL")
    u = urlsplit(value)
    if (
        u.scheme != "https"
        or not u.hostname
        or u.username
        or u.password
        or u.port not in {None, 443}
    ):
        raise ValueError("INVALID_NEWS_URL")
    return value


class PublicDataProvider:
    def __init__(
        self,
        *,
        market_transport: HttpTransport | None = None,
        asset_transport: HttpTransport | None = None,
        news_transport: HttpTransport | None = None,
        credentials: PublicDataCredentials | None = None,
        explorer_observations: tuple[ExplorerCapability, ...] = (),
        clock_ms: Callable[[], int] = utc_ms,
    ) -> None:
        purposes = {
            t.purpose for t in (market_transport, asset_transport, news_transport) if t is not None
        }
        if purposes - {"OFFLINE_FIXTURE", "EXTERNAL_OBSERVATION"} or len(purposes) > 1:
            raise ValueError("MIXED_OR_INVALID_DATA_PURPOSE")
        self.mode: Mode = "offline_fixture" if purposes == {"OFFLINE_FIXTURE"} else "live_readonly"
        self._market = market_transport
        self._assets = asset_transport
        self._news = news_transport
        self._credentials = credentials if credentials is not None else PublicDataCredentials()
        self._clock = clock_ms
        self._explorer: dict[tuple[str, str], ExplorerCapability] = {}
        for observed in explorer_observations:
            row = ExplorerCapability.model_validate(observed)
            key = (row.chain_id, row.capability_id)
            if key in self._explorer:
                raise ValueError("DUPLICATE_EXPLORER_OBSERVATION")
            self._explorer[key] = row

    def _batch(
        self,
        requested: tuple[str, ...],
        scope: str,
        items: list[PublicDataItem],
        sources: list[PublicSource],
        capability: str,
        *,
        empty_success: bool = False,
    ) -> PublicDataBatch:
        returned = tuple(i for i in requested if any(x.subject_id == i for x in items))
        gaps = () if empty_success else tuple(i for i in requested if i not in returned)
        if not items and not empty_success:
            quality: Literal["fresh", "stale", "partial", "unavailable"] = "unavailable"
        elif gaps:
            quality = "partial"
        elif items and all(i.quality == "stale" for i in items):
            quality = "stale"
        elif any(i.quality != "fresh" for i in items):
            quality = "partial"
        else:
            quality = "fresh"
        batch = PublicDataBatch(
            mode=self.mode,
            as_of_ms=max(
                (i.available_at_ms for i in items),
                default=(self._clock() if empty_success else None),
            ),
            quality=quality,
            coverage=Coverage(
                requested_subjects=requested, returned_subjects=returned, gaps=gaps, scope=scope
            ),
            missing_capabilities=tuple(f"{capability}:{i}" for i in gaps),
            sources=tuple(sources),
            items=tuple(items),
        )
        try:
            # Projection can join text separated by markup. Check the entire final
            # output, including decoded string leaves, before returning any item.
            self._check_strings(batch.model_dump(mode="json"))
        except ValueError:
            return PublicDataBatch(
                mode=self.mode,
                as_of_ms=None,
                quality="unavailable",
                coverage=Coverage(
                    requested_subjects=requested,
                    returned_subjects=(),
                    gaps=requested,
                    scope=scope,
                ),
                missing_capabilities=tuple(f"{capability}:{i}" for i in requested),
                sources=tuple(
                    PublicSource(
                        provider_id=s.provider_id,
                        status="INVALID_RESPONSE",
                        reason_code="UPSTREAM_INVALID_RESPONSE",
                    )
                    for s in sources
                ),
                items=(),
            )
        return batch

    def _source(self, provider: str, status: Status, retry: float | None = None) -> PublicSource:
        return PublicSource(
            provider_id=provider,
            status=status,
            last_success_at_ms=self._clock() if status in {"OK", "STALE"} else None,
            reason_code=None if status in {"OK", "STALE"} else f"UPSTREAM_{status}",
            retry_after_seconds=retry,
        )

    async def fetch_markets(self, asset_ids: tuple[str, ...]) -> PublicDataBatch:
        ids = _selection(asset_ids)
        items: list[PublicDataItem] = []
        sources: list[PublicSource] = []

        async def read(asset: str) -> DataResult:
            base = ASSETS[asset]
            instrument = Instrument(
                venue="BINANCE",
                market_kind="SPOT",
                symbol=base + "USDT",
                base_asset=base,
                quote_asset="USDT",
            )
            return await BinanceSpotTickerProvider(
                self._market, clock_ms=self._clock
            ).fetch_snapshot(instrument)

        # The validated selection has at most three assets. Each existing adapter
        # has its own 3 s deadline; a slow asset must not consume a serial 9 s
        # budget or discard another asset's completed observation at the BFF.
        results = await asyncio.gather(*(read(asset) for asset in ids))
        for asset, result in zip(ids, results, strict=True):
            sources.append(
                self._source(result.provider_id, result.status, result.retry_after_seconds)
            )
            if result.snapshot is None or result.provenance is None:
                continue
            s, p = result.snapshot, result.provenance
            items.append(
                PublicDataItem(
                    record_id=f"market:{asset}:{p.source_event_at_ms}",
                    subject_id=asset,
                    provider_id=result.provider_id,
                    venue_or_chain="BINANCE:SPOT",
                    event_time_ms=p.source_event_at_ms,
                    received_at_ms=p.received_at_ms,
                    available_at_ms=p.available_at_ms,
                    valid_until_ms=p.source_event_at_ms + 30000,
                    source_revision=p.raw_sha256,
                    quality="fresh" if result.status == "OK" else "stale",
                    data=MarketData(
                        instrument=s.instrument,
                        last_price=s.last_price,
                        base_volume=s.base_volume,
                        quote_volume=s.quote_volume,
                        window_open_at_ms=s.window_open_at_ms,
                        window_close_at_ms=s.window_close_at_ms,
                        price_change_pct=s.price_change_pct,
                    ),
                )
            )
        return self._batch(ids, "BINANCE_SPOT_24H_STATISTICS", items, sources, "market.statistics")

    async def _read(
        self,
        transport: HttpTransport | None,
        request: HttpRequest,
        provider: str,
    ) -> tuple[HttpResponse | None, PublicSource]:
        if transport is None:
            return None, self._source(provider, "UNCONFIGURED")
        response = await send_once(transport, request, timeout_seconds=6.0)
        if isinstance(response, Failure):
            return None, self._source(provider, response.status, response.retry_after_seconds)
        if response.status != 200:
            f = http_failure(response.status, response.headers, self._clock())
            return None, self._source(provider, f.status, f.retry_after_seconds)
        return response, self._source(provider, "OK")

    def _check_strings(self, value: Any) -> None:
        secrets = tuple(
            s
            for s in (
                self._credentials.coingecko_api_key,
                self._credentials.blockbeats_api_key,
            )
            if s
        )
        pending: list[Any] = [value]
        while pending:
            current = pending.pop()
            if isinstance(current, str):
                # Inspect leaves themselves: reserializing JSON would re-escape
                # legitimate quotes/backslashes in credentials and hide a match.
                for _ in range(4):
                    if any(secret in current for secret in secrets):
                        raise ValueError("CREDENTIAL_ECHO")
                    decoded = unquote(unescape(current))
                    if decoded == current:
                        break
                    current = decoded
                else:
                    # The bound ended on a decoded value that was not checked yet. Check it,
                    # and fail closed when one more decode would still change it.
                    if secrets and (
                        any(secret in current for secret in secrets)
                        or unquote(unescape(current)) != current
                    ):
                        raise ValueError("CREDENTIAL_ECHO")
            elif isinstance(current, dict):
                pending.extend(current.keys())
                pending.extend(current.values())
            elif isinstance(current, (list, tuple)):
                pending.extend(current)

    def _check_echo(self, body: bytes) -> None:
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("RESPONSE_SIZE")
        text = body.decode("utf-8")
        self._check_strings(text)
        self._check_strings(json.loads(text))

    async def fetch_assets(self, asset_ids: tuple[str, ...]) -> PublicDataBatch:
        ids = _selection(asset_ids)
        provider = "coingecko-assets-v1"
        credential = self._credentials.coingecko_api_key
        if not credential:
            return self._batch(
                ids, "ASSET_PROFILES", [], [self._source(provider, "UNCONFIGURED")], "asset.profile"
            )
        pro = self._credentials.coingecko_tier == "pro"
        host = "pro-api.coingecko.com" if pro else "api.coingecko.com"
        header = "x-cg-pro-api-key" if pro else "x-cg-demo-api-key"
        query = urlencode(
            {
                "vs_currency": "usd",
                "ids": ",".join(ids),
                "per_page": len(ids),
                "page": 1,
                "sparkline": "false",
            }
        )
        response, source = await self._read(
            self._assets,
            HttpRequest(
                "GET", f"https://{host}/api/v3/coins/markets?{query}", ((header, credential),)
            ),
            provider,
        )
        if response is None:
            return self._batch(ids, "ASSET_PROFILES", [], [source], "asset.profile")
        try:
            self._check_echo(response.body)
            # Reuse duplicate-key and Decimal parsing by placing the array in an object.
            data = parse_object(b'{"rows":' + response.body + b"}")["rows"]
            if not isinstance(data, list) or len(data) > len(ids):
                raise ValueError("INVALID_ASSET_ROWS")
            items: list[PublicDataItem] = []
            seen: set[str] = set()
            now = self._clock()
            for row in data:
                asset = row["id"]
                if (
                    asset not in ids
                    or asset in seen
                    or row.get("symbol", "").upper() != ASSETS[asset]
                ):
                    raise ValueError("ASSET_IDENTITY_MISMATCH")
                seen.add(asset)
                event = _timestamp(row["last_updated"]) if row.get("last_updated") else None
                quality: Quality = (
                    "stale" if event is not None and now - event > 300000 else "fresh"
                )
                items.append(
                    PublicDataItem(
                        record_id=f"asset:{asset}:{now}",
                        subject_id=asset,
                        provider_id=provider,
                        venue_or_chain=None,
                        event_time_ms=event,
                        received_at_ms=now,
                        available_at_ms=now,
                        valid_until_ms=(event or now) + 300000,
                        source_revision=sha256(response.body).hexdigest(),
                        quality=quality,
                        data=AssetData(
                            asset_id=asset,
                            name=_plain(row["name"], 256),
                            symbol=ASSETS[asset],
                            image_url=row.get("image"),
                            market_cap=_number(row.get("market_cap")),
                            total_volume=_number(row.get("total_volume")),
                            circulating_supply=_number(row.get("circulating_supply")),
                            total_supply=_number(row.get("total_supply")),
                            max_supply=_number(row.get("max_supply")),
                        ),
                    )
                )
            return self._batch(ids, "ASSET_PROFILES", items, [source], "asset.profile")
        except (ValueError, TypeError, KeyError, AttributeError, DecimalException, RecursionError):
            return self._batch(
                ids,
                "ASSET_PROFILES",
                [],
                [self._source(provider, "INVALID_RESPONSE")],
                "asset.profile",
            )

    async def fetch_news(self, limit: int = 20) -> PublicDataBatch:
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError("INVALID_NEWS_LIMIT")
        provider = "blockbeats-news-v1"
        requested = ("news",)
        credential = self._credentials.blockbeats_api_key
        if not credential:
            return self._batch(
                requested, "NEWS_FEED", [], [self._source(provider, "UNCONFIGURED")], "news.feed"
            )
        query = urlencode({"page": 1, "size": limit, "lang": "cn"})
        response, source = await self._read(
            self._news,
            HttpRequest(
                "GET",
                f"https://api-pro.theblockbeats.info/v1/newsflash?{query}",
                (("api-key", credential),),
            ),
            provider,
        )
        if response is None:
            return self._batch(requested, "NEWS_FEED", [], [source], "news.feed")
        try:
            self._check_echo(response.body)
            body = parse_object(response.body)
            if type(body.get("status")) is not int or body["status"] not in {0, 200}:
                raise ValueError("NEWS_APPLICATION_ERROR")
            rows = body["data"]["data"]
            if not isinstance(rows, list) or len(rows) > limit:
                raise ValueError("INVALID_NEWS_ROWS")
            now = self._clock()
            items: list[PublicDataItem] = []
            seen: set[str] = set()
            for row in rows:
                if type(row.get("id")) not in {int, str}:
                    raise ValueError("INVALID_NEWS_ID")
                identifier = str(row["id"])
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier):
                    raise ValueError("INVALID_NEWS_ID")
                if identifier in seen:
                    continue
                seen.add(identifier)
                event = _blockbeats_timestamp(row["create_time"])
                d = NewsData(
                    news_id="blockbeats:" + identifier,
                    title=_plain(row["title"], 512),
                    summary=_plain(row.get("content", ""), 2000),
                    url=_url(row.get("url") or row.get("link")),
                    published_at_ms=event,
                )
                items.append(
                    PublicDataItem(
                        record_id="news:" + identifier,
                        subject_id="news",
                        provider_id=provider,
                        venue_or_chain=None,
                        event_time_ms=event,
                        received_at_ms=now,
                        available_at_ms=now,
                        valid_until_ms=now + 60000,
                        source_revision=sha256(response.body).hexdigest(),
                        quality="fresh",
                        data=d,
                    )
                )
            # Query freshness reflects a successful feed read, not how recent its last article is.
            return self._batch(
                requested, "NEWS_FEED", items, [source], "news.feed", empty_success=not rows
            )
        except (ValueError, TypeError, KeyError, AttributeError, DecimalException, RecursionError):
            return self._batch(
                requested,
                "NEWS_FEED",
                [],
                [self._source(provider, "INVALID_RESPONSE")],
                "news.feed",
            )

    async def fetch_explorer_capabilities(self, chain_id: str | None = None) -> PublicDataBatch:
        if chain_id is not None and chain_id not in CHAINS:
            raise ValueError("INVALID_CHAIN_SELECTION")
        chains = (chain_id,) if chain_id is not None else CHAINS
        now = self._clock()
        items: list[PublicDataItem] = []
        for chain in chains:
            for capability in ("proxy.block_number", "contract.abi"):
                d = self._explorer.get((chain, capability)) or ExplorerCapability.model_validate(
                    {
                        "chain_id": chain,
                        "capability_id": capability,
                        "reason_code": "CAPABILITY_UNTESTED",
                    }
                )
                items.append(
                    PublicDataItem(
                        record_id=f"explorer:{chain}:{capability}",
                        subject_id=chain,
                        provider_id="etherscan-v2",
                        venue_or_chain=chain,
                        event_time_ms=d.verified_at_ms,
                        received_at_ms=now,
                        available_at_ms=now,
                        valid_until_ms=now + 300000,
                        source_revision="capability-registry.v1",
                        quality="fresh",
                        data=d,
                    )
                )
        return self._batch(
            chains,
            "EXPLORER_CAPABILITY_REGISTRY",
            items,
            [
                PublicSource(
                    provider_id="local-explorer-capability-registry-v1",
                    status="OK",
                    last_success_at_ms=now,
                    reason_code="LOCAL_REGISTRY_ONLY",
                )
            ],
            "explorer.capability",
        )
