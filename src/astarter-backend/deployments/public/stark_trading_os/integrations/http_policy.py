"""Canonical, finite HTTP capabilities. This is not an outbound authorization grant."""

from __future__ import annotations

import re
from typing import Literal

from stark_trading_os.integrations.transport import (
    MAX_RESPONSE_BYTES,
    HttpRequest,
    TransportReason,
    TransportRejected,
)

type Service = Literal["BINANCE_SPOT", "OPENROUTER_RESEARCH"]
MAX_HEADER_BYTES = 16384
MAX_HEADER_COUNT = 64
MAX_REQUEST_BYTES = 262144
_BINANCE = re.compile(
    r"https://api\.binance\.com/api/v3/"
    r"(?:ticker/24hr\?symbol=[A-Z0-9]{2,32}&type=FULL|exchangeInfo\?symbol=[A-Z0-9]{2,32})"
)
_MODEL_URL = "https://openrouter.ai/api/v1/chat/completions"
_HEADER_NAME = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


def request_headers(service: Service, request: HttpRequest) -> tuple[tuple[str, str], ...]:
    """Validate the original spelling before HTTPX can normalize ambiguous URLs."""
    reject = TransportRejected(TransportReason.REQUEST)
    if (
        type(request) is not HttpRequest
        or type(request.url) is not str
        or len(request.url) > 256
        or type(request.method) is not str
        or type(request.headers) is not tuple
        or len(request.headers) > 2
        or type(request.body) is not bytes
        or len(request.body) > MAX_REQUEST_BYTES
    ):
        raise reject
    headers: dict[str, str] = {}
    for pair in request.headers:
        if type(pair) is not tuple or len(pair) != 2:
            raise reject
        name, value = pair
        if (
            type(name) is not str
            or type(value) is not str
            or len(name) > 32
            or len(value) > 1024
            or not name.isascii()
            or not value.isascii()
            or any(not 32 <= ord(c) <= 126 for c in name + value)
            or name.lower() in headers
        ):
            raise reject
        headers[name.lower()] = value
    if service == "BINANCE_SPOT":
        if (
            request.method != "GET"
            or not _BINANCE.fullmatch(request.url)
            or headers
            or request.body
        ):
            raise reject
    elif service == "OPENROUTER_RESEARCH":
        if (
            request.method != "POST"
            or request.url != _MODEL_URL
            or not request.body
            or headers.get("content-type") != "application/json"
            or headers.keys() - {"content-type", "authorization"}
        ):
            raise reject
        if "authorization" in headers and not re.fullmatch(
            r"Bearer [A-Za-z0-9._~+/-]{1,512}={0,2}", headers["authorization"]
        ):
            raise reject
    else:
        raise reject
    return (*headers.items(), ("accept-encoding", "identity"))


def response_headers(
    raw: list[tuple[bytes, bytes]],
) -> tuple[int | None, tuple[tuple[str, str], ...]]:
    """Post-parser bound only; it does not limit HTTPX/h11 parsing allocations."""
    reject = TransportRejected(TransportReason.RESPONSE)
    if len(raw) > MAX_HEADER_COUNT or sum(len(k) + len(v) + 4 for k, v in raw) > MAX_HEADER_BYTES:
        raise reject
    fields: dict[bytes, bytes] = {}
    for name, value in raw:
        if not _HEADER_NAME.fullmatch(name) or any(b < 32 or b > 126 for b in value):
            raise reject
        key = name.lower()
        if key in fields and key != b"set-cookie":
            raise reject
        fields[key] = value.strip()
    if fields.get(b"content-encoding", b"identity").lower() != b"identity":
        raise reject
    if b"content-type" in fields:
        content_type = fields[b"content-type"].lower().replace(b" ", b"")
        if content_type not in {b"application/json", b"application/json;charset=utf-8"}:
            raise reject
    if b"transfer-encoding" in fields and (
        fields[b"transfer-encoding"].lower() != b"chunked" or b"content-length" in fields
    ):
        raise reject
    length: int | None = None
    if b"content-length" in fields:
        value = fields[b"content-length"]
        if not re.fullmatch(rb"0|[1-9][0-9]{0,5}", value):
            raise reject
        length = int(value)
        if length > MAX_RESPONSE_BYTES:
            raise reject
    safe: tuple[tuple[str, str], ...] = ()
    if b"retry-after" in fields:
        value = fields[b"retry-after"]
        if not 1 <= len(value) <= 256:
            raise reject
        safe = (("retry-after", value.decode("ascii")),)
    return length, safe
