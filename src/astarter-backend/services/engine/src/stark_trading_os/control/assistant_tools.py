"""Immutable B1a snapshot projected through the public BFF; no fetch or storage."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from stark_trading_os.control.public_data_models import PublicDataPayload, PublicDataQuery
from stark_trading_os.control.public_data_service import PublicDataService, utc_ms
from stark_trading_os.integrations.assistant_tools import (
    _TYPES,
    SOURCE_ID,
    FixtureOnly,
    FixtureToolRequest,
    FixtureToolResponse,
    ToolCapability,
    project_fixture_result,
    tool_capabilities,
)
from stark_trading_os.integrations.contracts import Identifier, Status, Timestamp
from stark_trading_os.integrations.public_data.models import (
    Coverage,
    MarketData,
    PublicDataItem,
    PublicSource,
    Quality,
)
from stark_trading_os.integrations.research_egress import canonical


class CapabilityView(ToolCapability):
    account_binding_id: None = None
    source_id: Literal["astarter-fixture-btc-spot-v1"] | None = None
    data_status: Status = "UNSUPPORTED"
    data_age_ms: Timestamp | None = None
    coverage: Coverage | None = None
    quality: Quality = "unavailable"
    retry_after_seconds: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    next_action: Literal["USE_FIXTURE_ONLY", "CONFIGURE_FIXTURE", "WAIT_FOR_IMPLEMENTATION"]


class ToolProvidersResponse(FixtureOnly):
    schema_version: Literal["AstarterAssistantToolProviders.v1"] = (
        "AstarterAssistantToolProviders.v1"
    )
    provider_id: Literal["binance-agent-os"] = "binance-agent-os"
    tenant_scope: Literal["PUBLIC"] = "PUBLIC"
    request_id: Identifier
    requested_at_ms: Timestamp
    capabilities: tuple[CapabilityView, CapabilityView, CapabilityView, CapabilityView]


@dataclass(frozen=True, slots=True)
class AssistantFixtureReadSide:
    snapshot: FixtureToolResponse | None = None
    clock_ms: Callable[[], int] = utc_ms

    def __post_init__(self) -> None:
        if not callable(self.clock_ms):
            raise ValueError("ASSISTANT_FIXTURE_CONFIGURATION")
        if self.snapshot is not None:
            value = canonical(self.snapshot, FixtureToolResponse, extra=_TYPES)
            if value.capability.capability != "market":
                raise ValueError("ASSISTANT_FIXTURE_CONFIGURATION")
            object.__setattr__(self, "snapshot", value)

    def _market(self, now: int) -> PublicDataPayload:
        if type(now) is not int or now < 0:
            raise ValueError("ASSISTANT_FIXTURE_CLOCK")
        query = PublicDataQuery(resource="markets", asset_ids=("bitcoin",))
        original = self.snapshot
        status: Status = "UNCONFIGURED"
        data = None
        result = None
        if original is not None and original.capability.enabled and original.data is not None:
            result = project_fixture_result(
                FixtureToolRequest(
                    request_id=original.request_id,
                    capability="market",
                    instrument=original.data.instrument,
                ),
                original.data,
                now_ms=now,
            )
            data = result.data
            assert data is not None
            status = data.status
        source = PublicSource(
            provider_id=SOURCE_ID,
            status=status,
            reason_code="ASTARTER_FIXTURE_ONLY",
            retry_after_seconds=None if data is None else data.retry_after_seconds,
        )
        if data is None or data.snapshot is None or data.provenance is None or result is None:
            return PublicDataService._failed(query, None, (source,), mode="offline_fixture")
        p, ticker = data.provenance, data.snapshot
        assert result.valid_until_ms is not None
        item = PublicDataItem(
            record_id="fixture:" + p.raw_sha256,
            subject_id="bitcoin",
            provider_id=SOURCE_ID,
            venue_or_chain="BINANCE:SPOT",
            event_time_ms=p.source_event_at_ms,
            received_at_ms=p.received_at_ms,
            available_at_ms=p.available_at_ms,
            valid_until_ms=result.valid_until_ms,
            source_revision="astarter-b1a-fixture.v1",
            quality="fresh" if status == "OK" else "stale",
            data=MarketData(
                instrument=ticker.instrument,
                last_price=ticker.last_price,
                base_volume=ticker.base_volume,
                quote_volume=ticker.quote_volume,
                window_open_at_ms=ticker.window_open_at_ms,
                window_close_at_ms=ticker.window_close_at_ms,
            ),
        )
        return PublicDataPayload(
            mode="offline_fixture",
            as_of_ms=p.available_at_ms,
            quality=item.quality,
            coverage=Coverage(
                scope="BINANCE_SPOT_24H_STATISTICS",
                requested_subjects=("bitcoin",),
                returned_subjects=("bitcoin",),
                gaps=(),
            ),
            sources=(source.model_copy(update={"last_success_at_ms": p.available_at_ms}),),
            items=(item,),
        )

    async def read(self, query: PublicDataQuery) -> PublicDataPayload:
        if query.resource != "markets":
            return PublicDataService._failed(
                query,
                None,
                (
                    PublicSource(
                        provider_id=SOURCE_ID,
                        status="UNSUPPORTED",
                        reason_code="FIXTURE_NOT_IMPLEMENTED",
                    ),
                ),
                mode="offline_fixture",
            )
        return PublicDataService._select(self._market(self.clock_ms()), query)

    def catalog(self, request_id: str) -> ToolProvidersResponse:
        now = self.clock_ms()
        payload = self._market(now)
        enabled = self.snapshot is not None and self.snapshot.capability.enabled
        views = []
        for cap in tool_capabilities(enabled=enabled):
            market = cap.capability == "market"
            views.append(
                CapabilityView(
                    **cap.model_dump(),
                    source_id="astarter-fixture-btc-spot-v1" if market else None,
                    data_status=payload.sources[0].status if market else "UNSUPPORTED",
                    data_age_ms=(
                        now - payload.items[0].event_time_ms
                        if market and payload.items and payload.items[0].event_time_ms is not None
                        else None
                    ),
                    coverage=payload.coverage if market else None,
                    quality=payload.quality if market else "unavailable",
                    retry_after_seconds=payload.sources[0].retry_after_seconds if market else None,
                    next_action=("USE_FIXTURE_ONLY" if enabled else "CONFIGURE_FIXTURE")
                    if market
                    else "WAIT_FOR_IMPLEMENTATION",
                )
            )
        return ToolProvidersResponse(
            request_id=request_id,
            requested_at_ms=now,
            capabilities=(views[0], views[1], views[2], views[3]),
        )
