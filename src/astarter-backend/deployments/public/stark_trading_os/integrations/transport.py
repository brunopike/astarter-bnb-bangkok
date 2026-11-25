"""Bounded injected HTTP boundary. This module supplies no network implementation."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from decimal import Decimal, DecimalException
from email.utils import parsedate_to_datetime
from enum import Enum
from typing import Any, Literal, Protocol

from stark_trading_os.integrations.contracts import Purpose, Status

MAX_RESPONSE_BYTES = 262144


class TransportReason(Enum):
    REQUEST = "REQUEST_POLICY_REJECTED"
    RESPONSE = "RESPONSE_POLICY_REJECTED"
    TIMEOUT = "TRANSPORT_TIMEOUT"
    UNAVAILABLE = "TRANSPORT_UNAVAILABLE"
    CLOSED = "TRANSPORT_CLOSED"
    CONFIGURATION = "CONFIGURATION_REJECTED"
    EXTERNAL_DISABLED = "EXTERNAL_DISABLED"
    CLEANUP_TIMEOUT = "TRANSPORT_CLEANUP_TIMEOUT"


class TransportRejected(ValueError):
    """Fixed diagnostics only; never construct with a provider exception/message."""

    def __init__(self, reason: TransportReason) -> None:
        self.reason = reason if type(reason) is TransportReason else TransportReason.CONFIGURATION
        super().__init__(self.reason.value)

    @property
    def status(self) -> Status:
        if self.reason in {TransportReason.REQUEST, TransportReason.RESPONSE}:
            # The configured Provider counted an adapter attempt, even if no HTTP
            # dispatch occurred. UNSUPPORTED is reserved for zero-attempt results.
            return "INVALID_RESPONSE"
        if self.reason is TransportReason.TIMEOUT:
            return "TIMEOUT"
        return "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class HttpRequest:
    method: Literal["GET", "POST"]
    url: str
    headers: tuple[tuple[str, str], ...] = field(default=(), repr=False)
    body: bytes = field(default=b"", repr=False)


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes = field(repr=False)
    headers: tuple[tuple[str, str], ...] = field(default=(), repr=False)


class HttpTransport(Protocol):
    purpose: Purpose

    async def send(self, request: HttpRequest) -> HttpResponse: ...


class FixtureTransport:
    """Finite synthetic responses; no requests, credentials or prompts retained."""

    purpose: Purpose = "OFFLINE_FIXTURE"

    def __init__(self, responses: tuple[HttpResponse, ...]) -> None:
        self._responses = responses
        self.calls = 0

    async def send(self, request: HttpRequest) -> HttpResponse:
        del request
        index = self.calls
        self.calls += 1
        if index >= len(self._responses):
            raise RuntimeError("FIXTURE_EXHAUSTED")
        return self._responses[index]


@dataclass(frozen=True, slots=True)
class Failure:
    status: Status
    retry_after_seconds: float | None = None


def parse_object(body: bytes) -> dict[str, Any]:
    """Reject duplicate keys/nonfinite numbers before schema validation."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("DUPLICATE_FIELD")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise ValueError("NONFINITE_JSON")

    if not body or len(body) > MAX_RESPONSE_BYTES:
        raise ValueError("RESPONSE_SIZE")
    try:
        value = json.loads(
            body, object_pairs_hook=pairs, parse_float=Decimal, parse_constant=invalid_constant
        )
    except DecimalException:
        raise ValueError("JSON_NUMBER_OUT_OF_RANGE") from None
    if not isinstance(value, dict):
        raise ValueError("OBJECT_REQUIRED")
    return value


def http_failure(status: int, headers: tuple[tuple[str, str], ...], now_ms: int) -> Failure:
    codes: dict[int, Status] = {
        401: "UNAUTHORIZED",
        403: "UNAUTHORIZED",
        402: "BUDGET_EXCEEDED",
        418: "RATE_LIMITED",
        429: "RATE_LIMITED",
        408: "TIMEOUT",
        504: "TIMEOUT",
    }
    code = codes.get(status, "UNAVAILABLE")
    retry: float | None = None
    for key, value in headers:
        if key.lower() != "retry-after":
            continue
        try:
            if value.isascii() and value.isdigit():
                retry = float(int(value))
            else:
                dt = parsedate_to_datetime(value)
                if dt.tzinfo is not None:
                    retry = max(0.0, dt.timestamp() - now_ms / 1000)
            if retry is not None and not 0 <= retry < float("inf"):
                retry = None
        except (ValueError, TypeError, OverflowError):
            retry = None
        break
    return Failure(code, retry)


async def send_once(
    transport: HttpTransport,
    request: HttpRequest,
    *,
    timeout_seconds: float,
) -> HttpResponse | Failure:
    try:
        response = await asyncio.wait_for(transport.send(request), timeout_seconds)
        if (
            not isinstance(response, HttpResponse)
            or type(response.status) is not int
            or not 100 <= response.status <= 599
            or type(response.body) is not bytes
            or len(response.body) > MAX_RESPONSE_BYTES
            or type(response.headers) is not tuple
            or any(
                type(pair) is not tuple or len(pair) != 2 or any(type(v) is not str for v in pair)
                for pair in response.headers
            )
        ):
            return Failure("INVALID_RESPONSE")
        return response
    except TransportRejected as rejection:
        return Failure(rejection.status)
    except TimeoutError:
        return Failure("TIMEOUT")
    except Exception:
        # Provider exceptions can embed credentials, payloads and URLs. Never echo them.
        # asyncio.CancelledError is BaseException and still propagates to the caller.
        return Failure("UNAVAILABLE")
