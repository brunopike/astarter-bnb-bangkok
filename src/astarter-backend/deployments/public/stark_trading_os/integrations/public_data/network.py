"""Explicitly enabled, fixed-destination public reads with connection-time IP pinning.

This does not change the offline-only T1 transport. No order/model endpoints exist.
"""

from __future__ import annotations

import asyncio
import ipaddress
import math
import re
import socket
from collections.abc import Awaitable, Callable
from decimal import Decimal
from types import TracebackType
from typing import Any, Literal, Self
from urllib.parse import parse_qsl, urlsplit

import httpx

from stark_trading_os.integrations.bounded_http import (
    _IN_BOUNDARY,
    _install_log_filter,
    _NoCookies,
    _OwnedStream,
    _raw_chunks,
)
from stark_trading_os.integrations.cleanup import CloseResult, OwnedClose, join_owned
from stark_trading_os.integrations.contracts import Purpose
from stark_trading_os.integrations.http_policy import response_headers
from stark_trading_os.integrations.public_data.response_policy import public_response_headers
from stark_trading_os.integrations.transport import (
    MAX_RESPONSE_BYTES,
    HttpRequest,
    HttpResponse,
    TransportReason,
    TransportRejected,
)

type PublicService = Literal["BINANCE_SPOT", "COINGECKO_ASSETS", "BLOCKBEATS_NEWS"]
type Resolver = Callable[[str], Awaitable[tuple[str, ...]]]


async def _resolve(host: str) -> tuple[str, ...]:
    rows = await asyncio.get_running_loop().getaddrinfo(
        host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
    )
    return tuple(dict.fromkeys(str(row[4][0]) for row in rows))


def _request_policy(service: PublicService, request: HttpRequest) -> tuple[str, str]:
    if (
        type(request) is not HttpRequest
        or request.method != "GET"
        or request.body != b""
        or type(request.url) is not str
        or len(request.url) > 512
        or not request.url.startswith("https://")
        or type(request.headers) is not tuple
        or len(request.headers) > 1
    ):
        raise TransportRejected(TransportReason.REQUEST)
    u = urlsplit(request.url)
    if u.scheme != "https" or not u.hostname or u.netloc != u.hostname or u.fragment:
        raise TransportRejected(TransportReason.REQUEST)
    pairs = parse_qsl(u.query, keep_blank_values=True, strict_parsing=True, max_num_fields=8)
    query = dict(pairs)
    if len(pairs) != len(query):
        raise TransportRejected(TransportReason.REQUEST)
    header: tuple[str, str] = ("", "")
    if request.headers:
        pair = request.headers[0]
        if type(pair) is not tuple or len(pair) != 2:
            raise TransportRejected(TransportReason.REQUEST)
        name, value = pair
        if (
            type(name) is not str
            or type(value) is not str
            or not 1 <= len(value) <= 1024
            or len(name) > 32
            or not (name + value).isascii()
            or any(not 33 <= ord(c) <= 126 for c in name + value)
        ):
            raise TransportRejected(TransportReason.REQUEST)
        header = (name.lower(), value)
    valid = False
    if service == "BINANCE_SPOT":
        valid = (
            u.hostname == "api.binance.com"
            and u.path == "/api/v3/ticker/24hr"
            and query.keys() == {"symbol", "type"}
            and query["type"] == "FULL"
            and query["symbol"] in {"BTCUSDT", "ETHUSDT", "SOLUSDT"}
            and not request.headers
        )
    elif service == "COINGECKO_ASSETS":
        tokens = query.get("ids", "").split(",")
        valid = (
            (u.hostname, header[0])
            in {
                ("pro-api.coingecko.com", "x-cg-pro-api-key"),
                ("api.coingecko.com", "x-cg-demo-api-key"),
            }
            and u.path == "/api/v3/coins/markets"
            and query.keys() == {"vs_currency", "ids", "per_page", "page", "sparkline"}
            and query["vs_currency"] == "usd"
            and query["page"] == "1"
            and query["sparkline"] == "false"
            and 1 <= len(tokens) <= 3
            and len(set(tokens)) == len(tokens)
            and set(tokens) <= {"bitcoin", "ethereum", "solana"}
            and query["per_page"] == str(len(tokens))
        )
    elif service == "BLOCKBEATS_NEWS":
        valid = (
            u.hostname == "api-pro.theblockbeats.info"
            and u.path == "/v1/newsflash"
            and query.keys() == {"page", "size", "lang"}
            and query["page"] == "1"
            and query["lang"] == "cn"
            and query["size"].isascii()
            and query["size"].isdigit()
            and 1 <= int(query["size"]) <= 50
            and query["size"] == str(int(query["size"]))
            and header[0] == "api-key"
        )
    if not valid:
        raise TransportRejected(TransportReason.REQUEST)
    return u.hostname, header[0]


class PublicReadHttpTransport:
    def __init__(
        self,
        service: PublicService,
        *,
        enable_external: bool = False,
        offline_transport: httpx.AsyncBaseTransport | None = None,
        resolver: Resolver = _resolve,
        timeout_seconds: float = 6.0,
        before_io: Callable[[], None] | None = None,
    ) -> None:
        if not enable_external and offline_transport is None:
            raise TransportRejected(TransportReason.EXTERNAL_DISABLED)
        if (
            type(enable_external) is not bool
            or (before_io is not None and not callable(before_io))
            or type(service) is not str
            or service not in {"BINANCE_SPOT", "COINGECKO_ASSETS", "BLOCKBEATS_NEWS"}
            or (enable_external and offline_transport is not None)
            or (
                offline_transport is not None
                and not isinstance(offline_transport, httpx.AsyncBaseTransport)
            )
            or isinstance(offline_transport, httpx.AsyncHTTPTransport)
            or type(timeout_seconds) not in {int, float}
            or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 6
        ):
            raise TransportRejected(TransportReason.CONFIGURATION)
        self.purpose: Purpose = (
            "OFFLINE_FIXTURE" if offline_transport is not None else "EXTERNAL_OBSERVATION"
        )
        self._service: PublicService = service
        self._resolver: Resolver = resolver
        self._before_io: Callable[[], None] | None = before_io
        self._seconds: float = timeout_seconds
        self._slots: asyncio.Semaphore = asyncio.Semaphore(3)
        self._closed: bool = False
        self._pending: set[asyncio.Task[Any]] = set()
        self._cleanup_seconds: float = min(0.5, self._seconds / 4)
        self._shutdown_deadline: float | None = None
        self._shutdown_task: asyncio.Task[CloseResult] | None = None
        self._close_result: CloseResult | None = None
        self._cleanup_failure: CloseResult | None = None
        self._response_closes: set[OwnedClose] = set()
        _install_log_filter()
        wire: httpx.AsyncBaseTransport
        if offline_transport is not None:
            wire = offline_transport
        else:
            wire = httpx.AsyncHTTPTransport(
                verify=True,
                trust_env=False,
                retries=0,
                # A checked IP may serve multiple origins. Do not reuse an IP-keyed TLS
                # connection across a later original hostname with a different SNI.
                limits=httpx.Limits(max_connections=3, max_keepalive_connections=0),
            )
        self._wire_close: OwnedClose = OwnedClose(
            wire.aclose, self._cleanup_deadline, self._completed
        )
        self._client: httpx.AsyncClient = httpx.AsyncClient(
            transport=_PublicWire(wire, self),
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(timeout_seconds),
            cookies=_NoCookies(),
        )

    async def __aenter__(self) -> Self:
        if self._closed:
            raise TransportRejected(TransportReason.CLOSED)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc is None:
            await self.aclose()
        else:
            try:
                await self.aclose()
            except Exception:
                pass

    @property
    def close_result(self) -> CloseResult | None:
        return self._close_result

    def _cleanup_deadline(self) -> float:
        deadline = asyncio.get_running_loop().time() + self._cleanup_seconds
        return min(deadline, self._shutdown_deadline or deadline)

    def _completed(self, close: OwnedClose, result: CloseResult) -> None:
        self._response_closes.discard(close)
        if not result.release_confirmed:
            self._closed = True
            if self._cleanup_failure is None or result.state == "TIMED_OUT":
                self._cleanup_failure = result

    def _own_stream(self, stream: httpx.AsyncByteStream) -> _OwnedStream:
        close = OwnedClose(stream.aclose, self._cleanup_deadline, self._completed)
        self._response_closes.add(close)
        return _OwnedStream(stream, close)

    async def aclose(self) -> None:
        self._closed = True
        if self._shutdown_task is None:
            self._shutdown_deadline = asyncio.get_running_loop().time() + 1.0
            token = _IN_BOUNDARY.set(True)
            try:
                self._shutdown_task = asyncio.create_task(self._shutdown())
            finally:
                _IN_BOUNDARY.reset(token)
        result = await join_owned(self._shutdown_task)
        _check_close(result)

    async def _shutdown(self) -> CloseResult:
        pending = tuple(self._pending)
        for task in pending:
            if not task.cancelling():
                task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.gather(*(close.wait() for close in tuple(self._response_closes)))
        try:
            await self._client.aclose()
        except Exception:
            if self._cleanup_failure is None:
                self._cleanup_failure = CloseResult("FAILED")
        await self._wire_close.wait()
        self._close_result = self._cleanup_failure or CloseResult("CLOSED")
        return self._close_result

    async def send(self, request: HttpRequest) -> HttpResponse:
        if self._closed:
            raise TransportRejected(TransportReason.CLOSED)
        token = _IN_BOUNDARY.set(True)
        task = asyncio.create_task(self._exchange(request))
        self._pending.add(task)
        try:
            return await task
        finally:
            self._pending.discard(task)
            _IN_BOUNDARY.reset(token)

    async def _exchange(self, request: HttpRequest) -> HttpResponse:
        reason: TransportReason
        try:
            host, _ = _request_policy(self._service, request)
            async with asyncio.timeout(self._seconds - self._cleanup_seconds), self._slots:
                if self._before_io is not None:
                    self._before_io()
                ips = await self._resolver(host)
                if not ips or len(ips) > 32:
                    raise TransportRejected(TransportReason.REQUEST)
                for address in ips:
                    if type(address) is not str or "%" in address:
                        raise TransportRejected(TransportReason.REQUEST)
                    ip = ipaddress.ip_address(address)
                    if (
                        not ip.is_global
                        or ip.is_multicast
                        or ip.is_reserved
                        or (
                            isinstance(ip, ipaddress.IPv6Address)
                            and ip.ipv4_mapped is not None
                            and not ip.ipv4_mapped.is_global
                        )
                    ):
                        raise TransportRejected(TransportReason.REQUEST)
                # Connect to the checked numerical IP, while verifying the original TLS hostname.
                url = httpx.URL(request.url).copy_with(host=ips[0])
                headers = {
                    **dict(request.headers),
                    "host": host,
                    "accept": "application/json",
                    "accept-encoding": "identity",
                }
                req = self._client.build_request("GET", url, headers=headers)
                req.extensions["sni_hostname"] = host
                response = await self._client.send(req, stream=True, follow_redirects=False)
                stream = response.stream
                if not isinstance(stream, httpx.AsyncByteStream):
                    raise TransportRejected(TransportReason.RESPONSE)
                try:
                    if not 200 <= response.status_code <= 599:
                        raise TransportRejected(TransportReason.RESPONSE)
                    length, safe = (
                        public_response_headers(self._service, response.headers.raw)
                        if self._service in {"BLOCKBEATS_NEWS", "COINGECKO_ASSETS"}
                        else response_headers(response.headers.raw)
                    )
                    body = bytearray()
                    async for chunk in _raw_chunks(response):
                        if len(chunk) > MAX_RESPONSE_BYTES - len(body):
                            raise TransportRejected(TransportReason.RESPONSE)
                        body.extend(chunk)
                    if length is not None and length != len(body):
                        raise TransportRejected(TransportReason.RESPONSE)
                    # The existing adapters parse integer seconds or HTTP dates.
                    # Preserve fractional vendor delays conservatively, only AFTER
                    # the unchanged strict header/body checks. Never round down or
                    # admit an additional header/host/request shape.
                    safe = tuple(
                        (key, str(math.ceil(Decimal(value))))
                        if key == "retry-after" and re.fullmatch(r"[0-9]+\.[0-9]+", value)
                        else (key, value)
                        for key, value in safe
                    )
                    result = HttpResponse(response.status_code, bytes(body), safe)
                except BaseException:
                    try:
                        await stream.aclose()
                    except Exception:
                        pass
                    raise
                else:
                    await stream.aclose()
                    return result
        except TransportRejected as rejection:
            reason = rejection.reason
        except (TimeoutError, httpx.TimeoutException):
            reason = TransportReason.TIMEOUT
        except (httpx.RemoteProtocolError, httpx.DecodingError):
            reason = TransportReason.RESPONSE
        except Exception:
            reason = TransportReason.UNAVAILABLE
        raise TransportRejected(reason)


def _check_close(result: CloseResult) -> None:
    if not result.release_confirmed:
        raise TransportRejected(
            TransportReason.CLEANUP_TIMEOUT
            if result.state == "TIMED_OUT"
            else TransportReason.UNAVAILABLE
        )


class _PublicWire(httpx.AsyncBaseTransport):
    """Capture physical streams before HTTPX may mark its response as closed."""

    def __init__(self, wire: httpx.AsyncBaseTransport, owner: PublicReadHttpTransport) -> None:
        self._wire = wire
        self._owner = owner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._owner._before_io is not None:
            self._owner._before_io()
        response = await self._wire.handle_async_request(request)
        if isinstance(response.stream, httpx.AsyncByteStream):
            response.stream = self._owner._own_stream(response.stream)
        return response

    async def aclose(self) -> None:
        _check_close(await self._owner._wire_close.wait())
