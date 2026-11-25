"""Bounded synthetic receipt admission, not a vendor schema or live connector."""

from decimal import Decimal
from typing import Literal, Self

from pydantic import model_validator

from stark_trading_os.integrations.assistant_tools import (
    _TYPES,
    FixtureOnly,
    FixtureToolRequest,
    FixtureToolResponse,
    project_fixture_result,
)
from stark_trading_os.integrations.contracts import Identifier
from stark_trading_os.integrations.research_egress import ResearchRejected, canonical
from stark_trading_os.integrations.transport import parse_object

type FixtureChannel = Literal["rest_fixture", "mcp_fixture"]

_TOOLS = {
    "rest_fixture": "astarter.fixture.rest.btc-24h.v1",
    "mcp_fixture": "astarter.fixture.mcp.btc-24h.v1",
}


class FixtureReadReceipt(FixtureOnly):
    schema_version: Literal["AstarterAssistantFixtureReceipt.v1"]
    transport: FixtureChannel
    tool_id: Literal["astarter.fixture.rest.btc-24h.v1", "astarter.fixture.mcp.btc-24h.v1"]
    coverage: Literal["BINANCE_SPOT_24H_STATISTICS"]
    tenant_scope: Literal["PUBLIC"]
    request_id: Identifier
    response: FixtureToolResponse

    @model_validator(mode="after")
    def fixture_read_binding(self) -> Self:
        response = self.response
        if (
            self.tool_id != _TOOLS[self.transport]
            or self.request_id != response.request_id
            or response.capability.capability != "market"
            or not response.capability.enabled
            or response.data is None
        ):
            raise ValueError("ASSISTANT_FIXTURE_RECEIPT_BINDING")
        snapshot = response.data.snapshot
        if snapshot is not None and (
            Decimal(snapshot.last_price) <= 0
            or snapshot.window_open_at_ms > snapshot.window_close_at_ms
        ):
            raise ValueError("ASSISTANT_FIXTURE_STATISTICS")
        return self


def admit_fixture_receipt(
    request: FixtureToolRequest,
    body: bytes,
    *,
    expected_transport: FixtureChannel,
    now_ms: int,
) -> FixtureToolResponse:
    """Validate one local fixture; the caller's channel cannot be chosen by its body."""
    request = canonical(request, FixtureToolRequest, extra=_TYPES)
    if type(expected_transport) is not str or expected_transport not in _TOOLS:
        raise ResearchRejected("INVALID_INPUT")
    if type(now_ms) is not int or not 0 <= now_ms <= 253402300799999:
        raise ResearchRejected("CLOCK_INVALID")
    receipt = None
    try:
        if type(body) is bytes:
            # The preparse rejects duplicate keys; strict JSON retains original wire types.
            parse_object(body)
            receipt = FixtureReadReceipt.model_validate_json(body, strict=True)
    except Exception:
        pass
    if receipt is None:
        raise ResearchRejected("INVALID_OUTPUT")
    response = receipt.response
    data = response.data
    assert data is not None
    if (
        receipt.transport != expected_transport
        or receipt.request_id != request.request_id
        or request.capability != "market"
        or data.instrument != request.instrument
    ):
        raise ResearchRejected("BINDING_MISMATCH")
    if now_ms < response.checked_at_ms:
        raise ResearchRejected("CLOCK_INVALID")
    return project_fixture_result(request, data, now_ms=now_ms)
