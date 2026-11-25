"""Owned HTTPX client and bounded I/O, currently constructible only for offline tests.

No external factory/activation is provided until DNS/egress, parser allocation,
budget and evidence authorization gates are accepted. A supplied Python transport
is trusted test code, not a security sandbox for plugins.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import AsyncIterator
from contextvars import ContextVar
from http.cookiejar import Cookie, CookieJar
from types import TracebackType
from typing import Any, Literal, Self

import httpx

from stark_trading_os.integrations.cleanup import CloseResult, OwnedClose, join_owned
from stark_trading_os.integrations.http_policy import Service, request_headers, response_headers
from stark_trading_os.integrations.transport import (
    MAX_RESPONSE_BYTES,
    HttpRequest,
    HttpResponse,
    TransportReason,
    TransportRejected,
)

_IN_BOUNDARY: ContextVar[bool] = ContextVar("ports_http_log_suppression", default=False)


class _BoundaryLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not _IN_BOUNDARY.get()


_LOG_FILTER = _BoundaryLogFilter()


def _install_log_filter() -> None:
    # Only these pinned HTTPX/httpcore loggers, only in this boundary's context.
    # No level/global-disable mutations; unrelated tasks retain their logging.
    for name in (
        "httpx",
        "httpcore.connection",
        "httpcore.http11",
        "httpcore.http2",
        "httpcore.proxy",
        "httpcore.socks",
    ):
        logger = logging.getLogger(name)
        if _LOG_FILTER not in logger.filters:
            logger.addFilter(_LOG_FILTER)


class _NoCookies(CookieJar):
    """Never parse/store/send cookies, including while concurrent responses await I/O."""

    def extract_cookies(self, response: Any, request: Any) -> None:
        pass

    def add_cookie_header(self, request: Any) -> None:
        pass

    def set_cookie(self, cookie: Cookie) -> None:
        pass


def _offline_client(
    wire: httpx.AsyncBaseTransport, seconds: float, connections: int
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=wire,
        auth=None,
        cookies=_NoCookies(),
        trust_env=False,
        follow_redirects=False,
        http2=False,
        verify=True,
        timeout=httpx.Timeout(seconds),
        limits=httpx.Limits(max_connections=connections, max_keepalive_connections=connections),
        event_hooks={"request": [], "response": []},
    )


async def _raw_chunks(response: httpx.Response) -> AsyncIterator[bytes]:
    # MockTransport may return an already buffered Response(json=...). Actual
    # socket-based streaming and parser memory limits are not accepted in T1.
    if response.is_stream_consumed:
        yield response.content
    else:
        async for chunk in response.aiter_raw():
            yield chunk


def _check_close(result: CloseResult) -> None:
    if not result.release_confirmed:
        reason = (
            TransportReason.CLEANUP_TIMEOUT
            if result.state == "TIMED_OUT"
            else TransportReason.UNAVAILABLE
        )
        raise TransportRejected(reason)


class _OwnedStream(httpx.AsyncByteStream):
    def __init__(self, stream: httpx.AsyncByteStream, close: OwnedClose) -> None:
        self._stream = stream
        self._close = close

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._stream:
            yield chunk

    async def aclose(self) -> None:
        _check_close(await self._close.wait())


class _OwnedWire(httpx.AsyncBaseTransport):
    def __init__(self, boundary: BoundedHttpTransport, wire: httpx.AsyncBaseTransport) -> None:
        self._boundary = boundary
        self._wire = wire

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._wire.handle_async_request(request)
        if isinstance(response.stream, httpx.AsyncByteStream):
            # Own the physical stream before HTTPX can auto-close it at EOF or
            # during redirect/error handling and set is_closed prematurely.
            response.stream = self._boundary._own_stream(response.stream)
        return response

    async def aclose(self) -> None:
        _check_close(await self._boundary._wire_close.wait())


class BoundedHttpTransport:
    purpose: Literal["OFFLINE_FIXTURE"] = "OFFLINE_FIXTURE"

    def __init__(
        self,
        service: Service,
        *,
        offline_transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float | None = None,
        max_connections: int = 8,
        cleanup_timeout_seconds: float = 1.0,
    ) -> None:
        if offline_transport is None:
            raise TransportRejected(TransportReason.EXTERNAL_DISABLED)
        if (
            not isinstance(offline_transport, httpx.AsyncBaseTransport)
            or isinstance(offline_transport, httpx.AsyncHTTPTransport)
            or type(service) is not str
            or service not in {"BINANCE_SPOT", "OPENROUTER_RESEARCH"}
            or type(max_connections) is not int
            or not 1 <= max_connections <= 16
        ):
            raise TransportRejected(TransportReason.CONFIGURATION)
        maximum = 3.0 if service == "BINANCE_SPOT" else 30.0
        seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else (3.0 if service == "BINANCE_SPOT" else 6.0)
        )
        if (
            type(seconds) not in {int, float}
            or not 0 < seconds <= maximum
            or not math.isfinite(seconds)
        ):
            raise TransportRejected(TransportReason.CONFIGURATION)
        if (
            type(cleanup_timeout_seconds) not in {int, float}
            or not 0 < cleanup_timeout_seconds <= 1
            or not math.isfinite(cleanup_timeout_seconds)
        ):
            raise TransportRejected(TransportReason.CONFIGURATION)
        self._service: Service = service
        self._seconds: float = seconds
        self._slots: asyncio.Semaphore = asyncio.Semaphore(max_connections)
        self._cleanup_seconds: float = cleanup_timeout_seconds
        self._shutdown_deadline: float | None = None
        self._shutdown_task: asyncio.Task[CloseResult] | None = None
        self._close_result: CloseResult | None = None
        self._cleanup_failure: CloseResult | None = None
        self._response_closes: set[OwnedClose] = set()
        self._wire_close: OwnedClose = OwnedClose(
            offline_transport.aclose, self._cleanup_deadline, self._cleanup_completed
        )
        self._client: httpx.AsyncClient = _offline_client(
            _OwnedWire(self, offline_transport), seconds, max_connections
        )
        self._pending: set[asyncio.Task[HttpResponse]] = set()
        self._closed: bool = False
        _install_log_filter()

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
                # Preserve the body exception. A NEW CancelledError is BaseException
                # and must still propagate after owned cleanup has been joined.
                pass

    @property
    def close_result(self) -> CloseResult | None:
        """None until shutdown is joined; CLOSED alone confirms all owned releases."""
        return self._close_result

    def _cleanup_deadline(self) -> float:
        own_deadline = asyncio.get_running_loop().time() + self._cleanup_seconds
        if self._shutdown_deadline is not None:
            return min(own_deadline, self._shutdown_deadline)
        return own_deadline

    def _cleanup_completed(self, close: OwnedClose, result: CloseResult) -> None:
        self._response_closes.discard(close)
        if not result.release_confirmed:
            self._closed = True
            if self._cleanup_failure is None or result.state == "TIMED_OUT":
                self._cleanup_failure = result

    def _own_stream(self, stream: httpx.AsyncByteStream) -> _OwnedStream:
        close = OwnedClose(stream.aclose, self._cleanup_deadline, self._cleanup_completed)
        self._response_closes.add(close)
        return _OwnedStream(stream, close)

    async def aclose(self) -> None:
        _check_close(await self.wait_closed())

    async def wait_closed(self) -> CloseResult:
        """Start/join the single shutdown; failure remains observable on later calls."""
        self._closed = True
        if self._shutdown_task is None:
            self._shutdown_deadline = asyncio.get_running_loop().time() + self._cleanup_seconds
            token = _IN_BOUNDARY.set(True)
            try:
                self._shutdown_task = asyncio.create_task(self._shutdown())
            finally:
                _IN_BOUNDARY.reset(token)
        return await join_owned(self._shutdown_task)

    async def _shutdown(self) -> CloseResult:
        active = tuple(self._pending)
        for task in active:
            if not task.cancelling():
                task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        # Includes a response returned by the wire but not delivered to _exchange.
        await asyncio.gather(*(close.wait() for close in tuple(self._response_closes)))
        try:
            await self._client.aclose()
        except Exception:
            if self._cleanup_failure is None:
                self._cleanup_failure = CloseResult("FAILED")
        # HTTPX may already say CLOSED; the owned wire result is authoritative.
        await self._wire_close.wait()
        self._close_result = self._cleanup_failure or CloseResult("CLOSED")
        return self._close_result

    async def send(self, request: HttpRequest) -> HttpResponse:
        deadline = asyncio.get_running_loop().time() + self._seconds
        if self._closed:
            raise TransportRejected(TransportReason.CLOSED)
        headers = request_headers(self._service, request)
        token = _IN_BOUNDARY.set(True)
        task = asyncio.create_task(self._exchange(request, headers, deadline))
        self._pending.add(task)
        try:
            return await task
        finally:
            self._pending.discard(task)
            _IN_BOUNDARY.reset(token)

    async def _exchange(
        self,
        request: HttpRequest,
        headers: tuple[tuple[str, str], ...],
        deadline: float,
    ) -> HttpResponse:
        reason: TransportReason
        try:
            async with asyncio.timeout_at(deadline):
                async with self._slots:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise TimeoutError
                    # Explicit Request avoids merging client headers/cookies/auth.
                    raw_request = httpx.Request(
                        request.method, request.url, headers=headers, content=request.body
                    )
                    response = await self._client.send(raw_request, stream=True, auth=None)
                    stream = response.stream
                    if not isinstance(stream, httpx.AsyncByteStream):
                        raise TransportRejected(TransportReason.RESPONSE)
                    try:
                        if not 200 <= response.status_code <= 599:
                            raise TransportRejected(TransportReason.RESPONSE)
                        expected, safe_headers = response_headers(response.headers.raw)
                        body = bytearray()
                        async for chunk in _raw_chunks(response):
                            if asyncio.get_running_loop().time() >= deadline:
                                raise TimeoutError
                            if len(chunk) > MAX_RESPONSE_BYTES - len(body):
                                raise TransportRejected(TransportReason.RESPONSE)
                            body.extend(chunk)
                        if expected is not None and expected != len(body):
                            raise TransportRejected(TransportReason.RESPONSE)
                        result = HttpResponse(response.status_code, bytes(body), safe_headers)
                    except BaseException:
                        try:
                            await stream.aclose()
                        except Exception:
                            # Preserve the original rejection/cancellation; cleanup
                            # failures may contain secrets and cannot replace it.
                            pass
                        raise
                    else:
                        await stream.aclose()
                        if asyncio.get_running_loop().time() >= deadline:
                            raise TimeoutError
                        return result
        except TransportRejected as rejection:
            reason = rejection.reason
        except (TimeoutError, httpx.TimeoutException):
            reason = TransportReason.TIMEOUT
        except (httpx.RemoteProtocolError, httpx.DecodingError):
            reason = TransportReason.RESPONSE
        except Exception:
            reason = TransportReason.UNAVAILABLE
        # Raise outside the exception handler: no provider exception in __context__.
        # CancelledError is BaseException and propagates after resource cleanup.
        raise TransportRejected(reason)
