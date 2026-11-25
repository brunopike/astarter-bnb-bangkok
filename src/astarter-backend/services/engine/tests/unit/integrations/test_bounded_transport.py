"""Offline counterexamples at the real HTTPX boundary; no sockets or API keys."""

import asyncio
import importlib
import importlib.util
import logging
import socket
import time
from collections.abc import AsyncIterator

import httpx
import pytest

from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
from stark_trading_os.integrations.contracts import Evidence, Instrument, ResearchTask
from stark_trading_os.integrations.openrouter import ModelConfig, OpenRouterModelPort
from stark_trading_os.integrations.transport import Failure, HttpRequest, send_once

URL = "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL"
MODEL_URL = "https://openrouter.ai/api/v1/chat/completions"


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("T1_NETWORK_FORBIDDEN")

    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def make_boundary(wire=None, service="BINANCE_SPOT", **kwargs):
    name = "stark_trading_os.integrations.bounded_http"
    assert importlib.util.find_spec(name) is not None, "bounded transport is not implemented"
    module = importlib.import_module(name)
    return module.BoundedHttpTransport(service, offline_transport=wire, **kwargs)


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks, *, delay=0, gate=None):
        self.chunks = chunks
        self.delay = delay
        self.gate = gate
        self.started = asyncio.Event()
        self.closed = False
        self.reads = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        self.started.set()
        if self.gate is not None:
            await self.gate.wait()
        for chunk in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_default_external_construction_is_closed():
    with pytest.raises(ValueError, match="EXTERNAL_DISABLED"):
        make_boundary()


@pytest.mark.asyncio
async def test_caller_client_is_not_a_transport_injection():
    async with httpx.AsyncClient() as client:
        with pytest.raises(ValueError, match="CONFIGURATION_REJECTED"):
            make_boundary(client)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        URL.replace("https:", "http:"),
        URL.replace("api.binance.com", "api.binance.com.evil"),
        URL.replace("api.binance.com", "API.BINANCE.COM"),
        URL.replace("api.binance.com", "user:example@api.binance.com"),
        URL.replace("api.binance.com", "127.0.0.1"),
        URL.replace("api.binance.com", "api.binance.com:444"),
        URL.replace("api.binance.com", "api.binance.com."),
        URL + "#fragment",
        URL + "&symbol=ETHUSDT",
        URL + "&signature=example",
        URL.replace("ticker/24hr", "order"),
        URL.replace("ticker", "%74icker"),
        URL.replace("BTCUSDT", "%42TCUSDT"),
        URL.replace("BTCUSDT", "btcUSDT"),
        URL.replace("type=FULL", "type=MINI"),
        URL.replace("symbol=BTCUSDT&", ""),
        URL + "\n",
        MODEL_URL,
    ],
)
async def test_bad_targets_reject_before_dispatch(url):
    seen = []
    async with make_boundary(httpx.MockTransport(lambda r: seen.append(r))) as boundary:
        result = await send_once(boundary, HttpRequest("GET", url), timeout_seconds=1)
    assert result == Failure("INVALID_RESPONSE")
    assert seen == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sample",
    [
        HttpRequest("POST", URL),
        HttpRequest("GET", URL, body=b"{}"),
        HttpRequest("GET", URL, (("Authorization", "Bearer example"),)),
        HttpRequest("GET", URL, (("X-MBX-APIKEY", "example"),)),
        HttpRequest("GET", URL, (("Cookie", "session=example"),)),
        HttpRequest("GET", URL, (("Host", "other.example"),)),
        HttpRequest("GET", URL, (("Accept-Encoding", "gzip"),)),
        HttpRequest("GET", URL, (("X-Trace", "example\r\nCookie: example"),)),
    ],
)
async def test_bad_request_headers_and_methods_do_not_dispatch(sample):
    seen = []
    async with make_boundary(httpx.MockTransport(lambda r: seen.append(r))) as boundary:
        assert await send_once(boundary, sample, timeout_seconds=1) == Failure("INVALID_RESPONSE")
    assert seen == []


@pytest.mark.asyncio
async def test_fixed_metadata_target_and_request_defaults():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200, stream=Chunks([b"{}"]), headers={"content-type": "application/json"}
        )

    async with make_boundary(httpx.MockTransport(handler)) as boundary:
        result = await boundary.send(
            HttpRequest("GET", "https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT")
        )
    assert result.body == b"{}"
    assert len(seen) == 1
    assert seen[0].headers["accept-encoding"] == "identity"
    assert not any(k in seen[0].headers for k in ["cookie", "authorization", "x-mbx-apikey"])


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308, 429, 418, 503])
async def test_no_redirect_or_retry_and_only_safe_response_headers(status):
    seen = []
    stream = Chunks([b"{}"])

    def handler(request):
        seen.append(request)
        return httpx.Response(
            status,
            stream=stream,
            headers={
                "Location": "https://other.example/?token=example",
                "Retry-After": "3",
                "Set-Cookie": "secret=example",
                "X-Request-Id": "example",
            },
        )

    async with make_boundary(httpx.MockTransport(handler)) as boundary:
        result = await boundary.send(HttpRequest("GET", URL))
    assert result.status == status
    assert result.headers == (("retry-after", "3"),)
    assert len(seen) == 1
    assert stream.closed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        [("Content-Encoding", "gzip")],
        [("Content-Encoding", "br")],
        [("Content-Length", "262145")],
        [("Content-Length", "-1")],
        [("Content-Length", "2"), ("content-length", "3")],
        [("Content-Type", "application/json"), ("content-type", "text/plain")],
        [("Content-Type", "text/html")],
        [("Retry-After", "2" * 257)],
        [("Content-Length", "2"), ("Transfer-Encoding", "chunked")],
        [("X-Something", "x" * 16385)],
        [(f"X-{i}", "a") for i in range(65)],
        [("X-Something", "secret\r\nCookie: example")],
    ],
)
async def test_response_headers_reject_without_consuming_body(headers):
    stream = Chunks([b"{}"])
    async with make_boundary(
        httpx.MockTransport(lambda r: httpx.Response(200, stream=stream, headers=headers))
    ) as boundary:
        result = await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1)
    assert result == Failure("INVALID_RESPONSE")
    assert stream.reads == 0
    assert stream.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("length", ["1", "3"])
async def test_declared_length_must_equal_stream_length(length):
    stream = Chunks([b"{}"])
    async with make_boundary(
        httpx.MockTransport(
            lambda r: httpx.Response(200, stream=stream, headers={"Content-Length": length})
        )
    ) as boundary:
        assert await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) == Failure(
            "INVALID_RESPONSE"
        )
    assert stream.closed


@pytest.mark.asyncio
async def test_body_limit_is_checked_while_reading_not_after_join():
    stream = Chunks([b"x" * 131072, b"x" * 131072, b"x", b"never read"])
    async with make_boundary(
        httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
    ) as boundary:
        assert await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) == Failure(
            "INVALID_RESPONSE"
        )
    assert stream.reads == 3
    assert stream.closed


@pytest.mark.asyncio
async def test_exact_body_limit_is_preserved():
    payload = b"x" * 262144
    async with make_boundary(
        httpx.MockTransport(lambda r: httpx.Response(200, stream=Chunks([payload])))
    ) as boundary:
        assert (await boundary.send(HttpRequest("GET", URL))).body == payload


@pytest.mark.asyncio
async def test_request_body_limit_and_duplicate_auth_reject_before_dispatch():
    seen = []
    async with make_boundary(
        httpx.MockTransport(lambda r: seen.append(r)), "OPENROUTER_RESEARCH"
    ) as boundary:
        for headers, body in [
            ((("Content-Type", "application/json"),), b"x" * 262145),
            ((("Authorization", "Bearer example"), ("authorization", "Bearer example")), b"{}"),
            ((("Authorization", "Bearer example\nsecret"),), b"{}"),
        ]:
            assert await send_once(
                boundary, HttpRequest("POST", MODEL_URL, headers, body), timeout_seconds=1
            ) == Failure("INVALID_RESPONSE")
    assert seen == []


@pytest.mark.asyncio
async def test_cookies_never_store_or_send_during_concurrent_responses():
    streams = []
    seen = []
    both = asyncio.Event()
    release = asyncio.Event()

    async def handler(request):
        seen.append(request)
        if len(seen) == 2:
            both.set()
        stream = Chunks([b"{}"], gate=release)
        streams.append(stream)
        return httpx.Response(
            200, stream=stream, headers={"Set-Cookie": f"s{len(seen)}=example; Path=/"}
        )

    async with make_boundary(httpx.MockTransport(handler), max_connections=2) as boundary:
        first = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
        await asyncio.sleep(0)
        second = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
        await asyncio.wait_for(both.wait(), 1)
        # This also catches response-then-clear implementations with an await in between.
        assert len(boundary._client.cookies) == 0
        release.set()
        await asyncio.gather(first, second)
        for _ in range(8):
            await boundary.send(HttpRequest("GET", URL))
        assert len(boundary._client.cookies) == 0
    assert len(seen) == 10
    assert all("cookie" not in r.headers for r in seen)
    assert all(s.closed for s in streams)


@pytest.mark.asyncio
async def test_slow_stream_total_deadline_does_not_reset_per_chunk():
    stream = Chunks([b"a"] * 30, delay=0.01)
    async with make_boundary(
        httpx.MockTransport(lambda r: httpx.Response(200, stream=stream)), timeout_seconds=0.045
    ) as boundary:
        result = await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1)
    assert result == Failure("TIMEOUT")
    assert 0 < stream.reads < 30
    assert stream.closed


@pytest.mark.asyncio
async def test_cancellation_propagates_and_closes_stream():
    stream = Chunks([b"{}"], gate=asyncio.Event())
    async with make_boundary(
        httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
    ) as boundary:
        task = asyncio.create_task(send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1))
        await asyncio.wait_for(stream.started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stream.closed


@pytest.mark.asyncio
async def test_queued_call_cancellation_is_zero_dispatch_and_capacity_recovers():
    stream = Chunks([b"{}"], gate=asyncio.Event())
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, stream=stream if len(seen) == 1 else Chunks([b"{}"]))

    async with make_boundary(httpx.MockTransport(handler), max_connections=1) as boundary:
        first = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
        await asyncio.wait_for(stream.started.wait(), 1)
        second = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
        await asyncio.sleep(0.01)
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await second
        assert len(seen) == 1
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert (await boundary.send(HttpRequest("GET", URL))).body == b"{}"
    assert len(seen) == 2
    assert stream.closed


@pytest.mark.asyncio
async def test_pool_wait_uses_the_same_local_deadline_as_stream():
    seen = []

    async def handler(request):
        seen.append(request)
        await asyncio.sleep(0.04)
        return httpx.Response(200, stream=Chunks([b"{}"], delay=0.03))

    async with make_boundary(
        httpx.MockTransport(handler), max_connections=1, timeout_seconds=0.12
    ) as boundary:
        first, second = await asyncio.gather(
            *[send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) for _ in range(2)]
        )
    assert not isinstance(first, Failure)
    assert second == Failure("TIMEOUT")
    assert len(seen) == 2


@pytest.mark.asyncio
async def test_close_cancels_active_work_and_rejects_later_sends():
    stream = Chunks([b"{}"], gate=asyncio.Event())
    boundary = make_boundary(httpx.MockTransport(lambda r: httpx.Response(200, stream=stream)))
    task = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
    await asyncio.wait_for(stream.started.wait(), 1)
    await boundary.aclose()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed
    assert await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) == Failure(
        "UNAVAILABLE"
    )
    await boundary.aclose()


@pytest.mark.asyncio
async def test_network_exceptions_and_library_logs_do_not_echo_payload(caplog):
    marker = "synthetic-private-marker"

    def handler(request):
        logging.getLogger("httpcore.http11").debug("wire %s", marker)
        raise httpx.ConnectError(marker, request=request)

    with caplog.at_level(logging.DEBUG):
        async with make_boundary(httpx.MockTransport(handler), "OPENROUTER_RESEARCH") as boundary:
            with pytest.raises(ValueError) as exc:
                await boundary.send(
                    HttpRequest("POST", MODEL_URL, (("Content-Type", "application/json"),), b"{}")
                )
        logging.getLogger("httpx").info("unrelated request remains visible")
    assert str(exc.value) == "TRANSPORT_UNAVAILABLE"
    assert exc.value.__context__ is None and exc.value.__cause__ is None
    assert marker not in caplog.text and MODEL_URL not in caplog.text
    assert "unrelated request remains visible" in caplog.text


@pytest.mark.asyncio
async def test_httpx_success_log_does_not_expose_request_url(caplog):
    with caplog.at_level(logging.DEBUG):
        async with make_boundary(
            httpx.MockTransport(lambda r: httpx.Response(200, stream=Chunks([b"{}"])))
        ) as boundary:
            await boundary.send(HttpRequest("GET", URL))
    assert "BTCUSDT" not in caplog.text and "api.binance.com" not in caplog.text


@pytest.mark.asyncio
async def test_binance_provider_works_through_new_boundary():
    body = (
        b'{"symbol":"BTCUSDT","lastPrice":"65000.12000000","volume":"1.0",'
        b'"quoteVolume":"65000.12","openTime":1,"closeTime":999}'
    )
    async with make_boundary(
        httpx.MockTransport(lambda r: httpx.Response(200, stream=Chunks([body])))
    ) as boundary:
        result = await BinanceSpotTickerProvider(boundary, clock_ms=lambda: 1000).fetch_snapshot(
            Instrument(
                venue="BINANCE",
                market_kind="SPOT",
                symbol="BTCUSDT",
                base_asset="BTC",
                quote_asset="USDT",
            )
        )
    assert result.status == "OK" and not result.snapshot.executable
    assert result.provenance.purpose == "OFFLINE_FIXTURE"


@pytest.mark.asyncio
async def test_openrouter_provider_works_without_any_key_or_real_billing():
    payload = {
        "id": "fixture-response",
        "model": "test/model",
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "content": '{"stance":"WAIT","summary":"Fixture only","evidence_ids":["e1"]}'
                },
            }
        ],
    }
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=payload)

    async with make_boundary(httpx.MockTransport(handler), "OPENROUTER_RESEARCH") as boundary:
        result = await OpenRouterModelPort(
            ModelConfig(model="test/model"), boundary, clock_ms=lambda: 1000
        ).generate_structured(
            ResearchTask(
                task_id="t1",
                role_id="A01",
                profile_version="p1",
                evidence=(
                    Evidence(
                        evidence_id="e1", text="synthetic", available_at_ms=1, valid_until_ms=9999
                    ),
                ),
            )
        )
    assert result.status == "OK" and result.purpose == "OFFLINE_FIXTURE"
    assert result.usage.cost_credits is None
    assert len(seen) == 1 and "authorization" not in seen[0].headers


@pytest.mark.asyncio
async def test_model_serialized_evidence_over_limit_returns_valid_failure_not_exception():
    seen = []
    task = ResearchTask(
        task_id="t1",
        role_id="A01",
        profile_version="p1",
        evidence=tuple(
            Evidence(
                evidence_id=f"e{i}",
                text="中" * 8000,
                available_at_ms=1,
                valid_until_ms=9999,
            )
            for i in range(8)
        ),
    )
    async with make_boundary(
        httpx.MockTransport(lambda r: seen.append(r)), "OPENROUTER_RESEARCH"
    ) as boundary:
        result = await OpenRouterModelPort(
            ModelConfig(model="test/model"),
            boundary,
            clock_ms=lambda: 1000,
        ).generate_structured(task)
    assert result.status == "INVALID_RESPONSE" and result.output is None
    assert result.attempts == 1 and result.usage.cost_credits is None
    assert seen == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure,expected",
    [
        (httpx.ReadTimeout, "TIMEOUT"),
        (httpx.RemoteProtocolError, "INVALID_RESPONSE"),
        (httpx.ConnectError, "UNAVAILABLE"),
    ],
)
async def test_library_failure_mapping_is_fixed_and_single_attempt(failure, expected):
    seen = []

    def handler(request):
        seen.append(request)
        raise failure("synthetic-private-error", request=request)

    async with make_boundary(httpx.MockTransport(handler)) as boundary:
        assert await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) == Failure(
            expected
        )
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_cancel_while_waiting_for_headers_stops_dispatch_task():
    started = asyncio.Event()
    closed = asyncio.Event()

    async def handler(request):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()

    async with make_boundary(httpx.MockTransport(handler)) as boundary:
        task = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed.is_set()
        assert not boundary._pending


@pytest.mark.asyncio
async def test_unrelated_task_logs_are_not_suppressed_while_request_is_active(caplog):
    stream = Chunks([b"{}"], gate=asyncio.Event())
    with caplog.at_level(logging.INFO):
        async with make_boundary(
            httpx.MockTransport(lambda r: httpx.Response(200, stream=stream))
        ) as boundary:
            task = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
            await asyncio.wait_for(stream.started.wait(), 1)
            logging.getLogger("httpx").info("other task visible")
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    assert "other task visible" in caplog.text
    assert "api.binance.com" not in caplog.text


@pytest.mark.asyncio
async def test_builtin_socket_transport_cannot_be_injected_as_offline():
    wire = httpx.AsyncHTTPTransport(retries=0, trust_env=False, http2=False)
    try:
        with pytest.raises(ValueError, match="CONFIGURATION_REJECTED"):
            make_boundary(wire)
    finally:
        await wire.aclose()


def test_pinned_h11_incomplete_limit_is_not_a_complete_header_cap():
    """Characterize the parser constraint that keeps the external factory disabled."""
    import h11
    from httpcore import AsyncHTTP11Connection

    limit = AsyncHTTP11Connection.MAX_INCOMPLETE_EVENT_SIZE
    field = b"x-large: " + b"a" * (limit + 1)
    complete = h11.Connection(h11.CLIENT, max_incomplete_event_size=limit)
    complete.receive_data(b"HTTP/1.1 200 OK\r\n" + field + b"\r\n\r\n")
    assert isinstance(complete.next_event(), h11.Response)
    incomplete = h11.Connection(h11.CLIENT, max_incomplete_event_size=limit)
    incomplete.receive_data(b"HTTP/1.1 200 OK\r\n" + field)
    with pytest.raises(h11.RemoteProtocolError):
        incomplete.next_event()


@pytest.mark.asyncio
async def test_expired_local_deadline_rejects_before_dispatch_after_scheduling_delay():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, stream=Chunks([b"{}"]))

    async with make_boundary(httpx.MockTransport(handler), timeout_seconds=0.005) as boundary:
        task = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
        # Run send() first; delay its newly scheduled owned worker, not the caller.
        asyncio.get_running_loop().call_soon(time.sleep, 0.025)
        with pytest.raises(ValueError, match="TRANSPORT_TIMEOUT"):
            await task
    assert seen == []


@pytest.mark.asyncio
async def test_cleanup_exception_does_not_replace_cancellation():
    class CloseFails(Chunks):
        async def aclose(self):
            self.closed = True
            raise RuntimeError("synthetic-private-close-error")

    stream = CloseFails([b"{}"], gate=asyncio.Event())
    boundary = make_boundary(httpx.MockTransport(lambda r: httpx.Response(200, stream=stream)))
    with pytest.raises(ValueError, match="TRANSPORT_UNAVAILABLE"):
        async with boundary:
            task = asyncio.create_task(boundary.send(HttpRequest("GET", URL)))
            await asyncio.wait_for(stream.started.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert stream.closed
    assert (await boundary.wait_closed()).state == "FAILED"
    assert not boundary.close_result.release_confirmed


@pytest.mark.asyncio
async def test_cleanup_exception_does_not_replace_invalid_response():
    class CloseFails(Chunks):
        async def aclose(self):
            self.closed = True
            raise RuntimeError("synthetic-private-close-error")

    stream = CloseFails([b"never read"])
    boundary = make_boundary(
        httpx.MockTransport(
            lambda r: httpx.Response(200, stream=stream, headers={"Content-Encoding": "gzip"})
        )
    )
    with pytest.raises(ValueError, match="TRANSPORT_UNAVAILABLE"):
        async with boundary:
            assert await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) == Failure(
                "INVALID_RESPONSE"
            )
    assert stream.closed and stream.reads == 0
    assert (await boundary.wait_closed()).state == "FAILED"
    assert not boundary.close_result.release_confirmed


@pytest.mark.asyncio
async def test_late_synchronously_available_response_cannot_be_reported_successful():
    stream = Chunks([b"{}"])

    def handler(request):
        time.sleep(0.025)  # A trusted test double can block the loop before returning.
        return httpx.Response(200, stream=stream)

    async with make_boundary(httpx.MockTransport(handler), timeout_seconds=0.005) as boundary:
        assert await send_once(boundary, HttpRequest("GET", URL), timeout_seconds=1) == Failure(
            "TIMEOUT"
        )
    assert stream.closed
