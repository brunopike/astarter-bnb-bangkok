"""B1a offline-only contracts; no routes, transport, identity or runtime startup."""

from typing import Literal, Self

from pydantic import StrictBool, model_validator

from stark_trading_os.integrations.contracts import (
    DataResult,
    Identifier,
    Instrument,
    Provenance,
    SpotTicker,
    Timestamp,
)
from stark_trading_os.integrations.research_egress import Closed, ResearchRejected, canonical

type Capability = Literal["market", "account", "onchain", "plan"]
type CapabilityState = Literal[
    "not_connected",
    "auth_required",
    "ready",
    "stale",
    "permission_denied",
    "rate_limited",
    "unavailable",
]
SOURCE_ID = "astarter-fixture-btc-spot-v1"
_CAPABILITIES: tuple[Capability, ...] = ("market", "account", "onchain", "plan")


def _btc(value: Instrument) -> bool:
    return (value.venue, value.market_kind, value.symbol, value.base_asset, value.quote_asset) == (
        "BINANCE",
        "SPOT",
        "BTCUSDT",
        "BTC",
        "USDT",
    )


class FixtureOnly(Closed):
    purpose: Literal["OFFLINE_FIXTURE"] = "OFFLINE_FIXTURE"
    execution_authorized: StrictBool = False

    @model_validator(mode="after")
    def no_authority(self) -> Self:
        if self.execution_authorized:
            raise ValueError("ASSISTANT_FIXTURE_NO_AUTHORITY")
        return self


class ToolCapability(FixtureOnly):
    provider_id: Literal["binance-agent-os"] = "binance-agent-os"
    capability: Capability
    supported: StrictBool
    enabled: StrictBool = False
    state: CapabilityState = "unavailable"
    reason_code: Literal["INTEGRATION_DISABLED", "OFFLINE_FIXTURE_ONLY", "NOT_IMPLEMENTED"]
    transport: Literal["fixture"] | None = None
    verified_at_ms: None = None
    granted_scopes: tuple[()] = ()

    @model_validator(mode="after")
    def fixture_catalog(self) -> Self:
        market = self.capability == "market"
        if self.supported != market or self.enabled and not market:
            raise ValueError("ASSISTANT_CAPABILITY_UNIMPLEMENTED")
        expected = (
            ("not_connected", "fixture", "OFFLINE_FIXTURE_ONLY")
            if self.enabled
            else ("unavailable", None, "INTEGRATION_DISABLED" if market else "NOT_IMPLEMENTED")
        )
        if (self.state, self.transport, self.reason_code) != expected:
            raise ValueError("ASSISTANT_FIXTURE_NOT_LIVE")
        return self


class FixtureToolRequest(FixtureOnly):
    provider_id: Literal["binance-agent-os"] = "binance-agent-os"
    request_id: Identifier
    capability: Capability
    instrument: Instrument | None = None

    @model_validator(mode="after")
    def registered_subject(self) -> Self:
        if self.capability == "market":
            if self.instrument is None or not _btc(self.instrument):
                raise ValueError("ASSISTANT_FIXTURE_INSTRUMENT")
        elif self.instrument is not None:
            raise ValueError("ASSISTANT_CAPABILITY_UNIMPLEMENTED")
        return self


class FixtureToolResponse(FixtureOnly):
    request_id: Identifier
    capability: ToolCapability
    checked_at_ms: Timestamp
    data: DataResult | None = None
    valid_until_ms: Timestamp | None = None

    @model_validator(mode="after")
    def fixture_evidence(self) -> Self:
        data = self.data
        end = None
        if data is not None:
            if (
                not self.capability.enabled
                or data.provider_id != SOURCE_ID
                or not _btc(data.instrument)
            ):
                raise ValueError("ASSISTANT_FIXTURE_SOURCE")
            if data.provenance is not None:
                p = data.provenance
                if p.purpose != "OFFLINE_FIXTURE" or p.provider_id != SOURCE_ID:
                    raise ValueError("ASSISTANT_FIXTURE_SOURCE")
                status = data.freshness_at(
                    self.checked_at_ms, max_source_age_ms=30000, max_receipt_age_ms=5000
                )
                if status == "INVALID_RESPONSE" or data.status == "OK" and status != "OK":
                    raise ValueError("ASSISTANT_FIXTURE_TIME")
                end = min(p.source_event_at_ms + 30000, p.received_at_ms + 5000) + 1
        if self.valid_until_ms != end:
            raise ValueError("ASSISTANT_FIXTURE_EXPIRY")
        return self


_TYPES = (
    Instrument,
    Provenance,
    SpotTicker,
    DataResult,
    ToolCapability,
    FixtureToolRequest,
    FixtureToolResponse,
)


def tool_capabilities(*, enabled: bool = False) -> tuple[ToolCapability, ...]:
    if type(enabled) is not bool:
        raise ValueError("ASSISTANT_TOOLS_CONFIGURATION")
    return tuple(
        ToolCapability(
            capability=cap,
            supported=cap == "market",
            enabled=enabled and cap == "market",
            state="not_connected" if enabled and cap == "market" else "unavailable",
            transport="fixture" if enabled and cap == "market" else None,
            reason_code=("OFFLINE_FIXTURE_ONLY" if enabled else "INTEGRATION_DISABLED")
            if cap == "market"
            else "NOT_IMPLEMENTED",
        )
        for cap in _CAPABILITIES
    )


def project_fixture_result(
    request: FixtureToolRequest,
    data: DataResult,
    *,
    now_ms: int,
) -> FixtureToolResponse:
    request = canonical(request, FixtureToolRequest, extra=_TYPES)
    data = canonical(data, DataResult, extra=_TYPES)
    if request.capability != "market" or data.instrument != request.instrument:
        raise ResearchRejected("BINDING_MISMATCH")
    if data.provider_id != SOURCE_ID or (
        data.provenance is not None and data.provenance.purpose != "OFFLINE_FIXTURE"
    ):
        raise ResearchRejected("DENIED")
    status = data.freshness_at(now_ms, max_source_age_ms=30000, max_receipt_age_ms=5000)
    if status == "INVALID_RESPONSE":
        data = DataResult(
            provider_id=SOURCE_ID,
            instrument=data.instrument,
            status=status,
            retry_after_seconds=data.retry_after_seconds,
        )
    elif status != data.status and status != "OK":
        data = DataResult.model_validate(data.model_dump() | {"status": status})
    end = (
        None
        if data.provenance is None
        else min(
            data.provenance.source_event_at_ms + 30000,
            data.provenance.received_at_ms + 5000,
        )
        + 1
    )
    return FixtureToolResponse(
        request_id=request.request_id,
        capability=tool_capabilities(enabled=True)[0],
        checked_at_ms=now_ms,
        data=data,
        valid_until_ms=end,
    )
