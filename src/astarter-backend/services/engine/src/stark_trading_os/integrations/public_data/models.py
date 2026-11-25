"""Public observations, deliberately unable to grant execution authority."""

from __future__ import annotations

import re
from typing import Annotated, Literal, Self

from pydantic import Field, StrictStr, field_validator, model_validator

from stark_trading_os.integrations.contracts import (
    Contract,
    DecimalText,
    Instrument,
    SignedDecimalText,
    Status,
    Timestamp,
)

type Quality = Literal["fresh", "stale", "partial", "unavailable"]
type Mode = Literal["offline_fixture", "live_readonly"]
type ChainId = Literal["1", "56", "8453", "42161", "137", "10"]
type AssetId = Literal["bitcoin", "ethereum", "solana"]

_COINGECKO_IMAGE = re.compile(
    r"https://(?:coin-images|assets)\.coingecko\.com/coins/images/[1-9][0-9]{0,9}/"
    r"(?:thumb|small|large)/[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\."
    r"(?i:png|jpe?g|webp|svg)(?:\?[0-9]{1,13})?"
)


class MarketData(Contract):
    instrument: Instrument
    metric_kind: Literal["SPOT_24H_STATISTICS"] = "SPOT_24H_STATISTICS"
    last_price: DecimalText
    base_volume: DecimalText
    quote_volume: DecimalText
    window_open_at_ms: Timestamp
    window_close_at_ms: Timestamp
    price_change_pct: SignedDecimalText | None = None


class AssetContract(Contract):
    chain_id: StrictStr
    address: StrictStr


class AssetData(Contract):
    asset_id: AssetId
    name: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    symbol: Annotated[StrictStr, Field(pattern=r"^[A-Z0-9]{1,24}$")]
    image_url: StrictStr | None = None
    quote_currency: Literal["USD"] = "USD"
    market_cap: DecimalText | None = None
    total_volume: DecimalText | None = None
    circulating_supply: DecimalText | None = None
    total_supply: DecimalText | None = None
    max_supply: DecimalText | None = None
    contracts: tuple[AssetContract, ...] = ()

    @field_validator("image_url", mode="before")
    @classmethod
    def public_cdn_image(cls, value: object) -> str | None:
        # Metadata only: do not fetch images or derive identity from the filename.
        # A full URL allowlist excludes credentials, ports, encoded paths, fragments
        # and arbitrary parameters. Existing projection checks still reject keys.
        if type(value) is str and len(value) <= 2048 and _COINGECKO_IMAGE.fullmatch(value):
            return value
        return None


class NewsData(Contract):
    news_id: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    title: Annotated[StrictStr, Field(min_length=1, max_length=512)]
    summary: Annotated[StrictStr, Field(max_length=2000)]
    url: Annotated[StrictStr, Field(min_length=1, max_length=2048)]
    published_at_ms: Timestamp
    asset_ids: tuple[AssetId, ...] = ()


class ExplorerCapability(Contract):
    chain_id: ChainId
    capability_id: Literal["proxy.block_number", "contract.abi"]
    verification_state: Literal["VERIFIED", "UNTESTED"] = "UNTESTED"
    status: Status = "UNCONFIGURED"
    verified_at_ms: Timestamp | None = None
    reason_code: Annotated[StrictStr, Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")] | None = None

    @model_validator(mode="after")
    def verification(self) -> Self:
        if self.verification_state == "VERIFIED":
            if self.verified_at_ms is None:
                raise ValueError("VERIFICATION_TIME_REQUIRED")
        elif self.verified_at_ms is not None or self.status != "UNCONFIGURED":
            raise ValueError("UNTESTED_CAPABILITY")
        return self


class PublicDataItem(Contract):
    record_id: StrictStr
    subject_id: StrictStr
    provider_id: StrictStr
    venue_or_chain: StrictStr | None
    event_time_ms: Timestamp | None
    received_at_ms: Timestamp
    available_at_ms: Timestamp
    valid_until_ms: Timestamp
    source_revision: StrictStr
    quality: Quality
    data: MarketData | AssetData | NewsData | ExplorerCapability

    @model_validator(mode="after")
    def chronology(self) -> Self:
        if (
            self.event_time_ms is not None
            and (
                self.event_time_ms > self.received_at_ms or self.valid_until_ms < self.event_time_ms
            )
        ) or self.received_at_ms > self.available_at_ms:
            raise ValueError("INVALID_OBSERVATION_TIME")
        if self.quality == "fresh" and self.valid_until_ms < self.available_at_ms:
            raise ValueError("EXPIRED_FRESH_OBSERVATION")
        return self


class PublicSource(Contract):
    provider_id: StrictStr
    status: Status
    last_success_at_ms: Timestamp | None = None
    reason_code: Annotated[StrictStr, Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")] | None = None
    retry_after_seconds: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None


class Coverage(Contract):
    requested_subjects: tuple[StrictStr, ...]
    returned_subjects: tuple[StrictStr, ...]
    gaps: tuple[StrictStr, ...]
    scope: StrictStr


class PublicDataBatch(Contract):
    mode: Mode
    as_of_ms: Timestamp | None
    quality: Quality
    coverage: Coverage
    missing_capabilities: tuple[StrictStr, ...] = ()
    sources: tuple[PublicSource, ...]
    items: tuple[PublicDataItem, ...] = ()
