"""Single-symbol Binance Spot statistics, explicitly not an executable quote."""

from __future__ import annotations

import time
from collections.abc import Callable
from decimal import Decimal
from hashlib import sha256

from pydantic import ValidationError

from stark_trading_os.integrations.contracts import DataResult, Instrument, Provenance, SpotTicker
from stark_trading_os.integrations.transport import (
    Failure,
    HttpRequest,
    HttpTransport,
    http_failure,
    parse_object,
    send_once,
)


def utc_ms() -> int:
    return time.time_ns() // 1_000_000


class BinanceSpotTickerProvider:
    def __init__(
        self, transport: HttpTransport | None = None, *, clock_ms: Callable[[], int] = utc_ms
    ) -> None:
        self._transport = transport
        self._clock_ms = clock_ms

    async def fetch_snapshot(self, instrument: Instrument) -> DataResult:
        instrument = Instrument.model_validate(instrument)
        if (
            instrument.venue != "BINANCE"
            or instrument.market_kind != "SPOT"
            or instrument.symbol != instrument.base_asset + instrument.quote_asset
        ):
            return DataResult(instrument=instrument, status="UNSUPPORTED")
        if self._transport is None:
            return DataResult(instrument=instrument, status="UNCONFIGURED")
        if self._transport.purpose not in {"OFFLINE_FIXTURE", "EXTERNAL_OBSERVATION"}:
            return DataResult(instrument=instrument, status="UNSUPPORTED")
        response = await send_once(
            self._transport,
            HttpRequest(
                "GET",
                f"https://api.binance.com/api/v3/ticker/24hr?symbol={instrument.symbol}&type=FULL",
            ),
            timeout_seconds=3.0,
        )
        now = self._clock_ms()
        if isinstance(response, Failure):
            return DataResult(instrument=instrument, status=response.status)
        if response.status != 200:
            failure = http_failure(response.status, response.headers, now)
            return DataResult(
                instrument=instrument,
                status=failure.status,
                retry_after_seconds=failure.retry_after_seconds,
            )
        try:
            data = parse_object(response.body)
            required = {"symbol", "lastPrice", "volume", "quoteVolume", "openTime", "closeTime"}
            if not required.issubset(data):
                return DataResult(instrument=instrument, status="MISSING")
            if data["symbol"] != instrument.symbol:
                raise ValueError("IDENTITY_MISMATCH")
            # Legacy absence is unknown; an explicitly invalid value is not absence.
            if "priceChangePercent" in data and not isinstance(data["priceChangePercent"], str):
                raise ValueError("INVALID_STATISTICS")
            snapshot = SpotTicker(
                instrument=instrument,
                last_price=data["lastPrice"],
                base_volume=data["volume"],
                quote_volume=data["quoteVolume"],
                window_open_at_ms=data["openTime"],
                window_close_at_ms=data["closeTime"],
                price_change_pct=data.get("priceChangePercent"),
            )
            if (
                Decimal(snapshot.last_price) <= 0
                or snapshot.window_open_at_ms > snapshot.window_close_at_ms
            ):
                raise ValueError("INVALID_STATISTICS")
            provenance = Provenance(
                provider_id="binance-spot-ticker-v1",
                purpose=self._transport.purpose,
                source_event_at_ms=snapshot.window_close_at_ms,
                received_at_ms=now,
                available_at_ms=now,
                raw_sha256=sha256(response.body).hexdigest(),
            )
            result = DataResult(
                instrument=instrument, status="OK", snapshot=snapshot, provenance=provenance
            )
            status = result.freshness_at(now, max_source_age_ms=30000, max_receipt_age_ms=5000)
            return DataResult(
                instrument=instrument, status=status, snapshot=snapshot, provenance=provenance
            )
        except (ValueError, TypeError, ValidationError, RecursionError):
            return DataResult(instrument=instrument, status="INVALID_RESPONSE")
