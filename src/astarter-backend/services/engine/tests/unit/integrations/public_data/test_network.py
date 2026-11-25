"""Offline wire tests; public test IPs are never contacted."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

import httpx
import pytest

from stark_trading_os.integrations import http_policy
from stark_trading_os.integrations.bounded_http import BoundedHttpTransport
from stark_trading_os.integrations.public_data import response_policy
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport, PublicService
from stark_trading_os.integrations.transport import (
    Failure,
    HttpRequest,
    TransportRejected,
    send_once,
)

URL = "https://api-pro.theblockbeats.info/v1/newsflash?page=1&size=1&lang=cn"
REQUEST = HttpRequest("GET", URL, (("api-key", "unit-test-token"),))
CG_URL = (
    "https://pro-api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd&ids=bitcoin&per_page=1&page=1&sparkline=false"
)
CG_REQUEST = HttpRequest("GET", CG_URL, (("x-cg-pro-api-key", "fake-cg-fixture-token"),))
CG_STS = [
    (b"Strict-Transport-Security", b"max-age=0"),
    (b"sTrIcT-tRaNsPoRt-SeCuRiTy", b"max-age=31536000; includeSubDomains"),
]


async def public_dns(host: str) -> tuple[str, ...]:
    return ("8.8.8.8",)


def factory(**kwargs):
    from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport

    return PublicReadHttpTransport("BLOCKBEATS_NEWS", resolver=public_dns, **kwargs)


def test_no_network_client_by_default():
    with pytest.raises(TransportRejected, match="EXTERNAL_DISABLED"):
        factory()


@pytest.mark.asyncio
async def test_pins_public_ip_but_preserves_tls_name_and_host():
    seen = []

    async def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"status": 0, "data": {"data": []}})

    async with factory(offline_transport=httpx.MockTransport(handler)) as t:
        assert t.purpose == "OFFLINE_FIXTURE"
        result = await t.send(REQUEST)
    assert result.status == 200
    assert len(seen) == 1
    assert seen[0].url.host == "8.8.8.8"
    assert seen[0].headers["host"] == "api-pro.theblockbeats.info"
    assert seen[0].extensions["sni_hostname"] == "api-pro.theblockbeats.info"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ip", ["127.0.0.1", "10.1.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "224.0.0.1"]
)
async def test_private_or_mapped_private_dns_is_refused_before_wire(ip):
    from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport

    calls = []

    async def resolve(host):
        return (ip,)

    async def handler(request):
        calls.append(1)
        return httpx.Response(200, json={})

    async with PublicReadHttpTransport(
        "BLOCKBEATS_NEWS", resolver=resolve, offline_transport=httpx.MockTransport(handler)
    ) as t:
        with pytest.raises(TransportRejected):
            await t.send(REQUEST)
    assert not calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://api-pro.theblockbeats.info/v1/newsflash?page=1&size=1&lang=cn",
        URL + "&size=2",
        URL + "&url=https://example.com/",
        "https://evil.example/v1/newsflash?page=1&size=1&lang=cn",
        "https://api-pro.theblockbeats.info/v1/%6eewsflash?page=1&size=1&lang=cn",
        URL + "#fragment",
    ],
)
async def test_unknown_destination_or_ambiguous_query_is_refused_without_dispatch(url):
    calls = []

    async def handler(request):
        calls.append(1)
        return httpx.Response(200, json={})

    async with factory(offline_transport=httpx.MockTransport(handler)) as t:
        with pytest.raises(TransportRejected):
            await t.send(HttpRequest("GET", url, REQUEST.headers))
    assert not calls


@pytest.mark.asyncio
async def test_redirect_is_returned_without_following_or_forwarding_credentials():
    calls = []

    async def handler(request):
        calls.append(1)
        return httpx.Response(302, headers={"location": "https://evil.example/"})

    async with factory(offline_transport=httpx.MockTransport(handler)) as t:
        result = await t.send(REQUEST)
    assert result.status == 302 and calls == [1]
    assert not result.headers


@pytest.mark.asyncio
async def test_compressed_and_oversized_responses_are_rejected():
    for headers, content in [({"content-encoding": "gzip"}, b"{}"), ({}, b"x" * 262145)]:

        async def handler(request):
            return httpx.Response(200, headers=headers, content=content)

        async with factory(offline_transport=httpx.MockTransport(handler)) as t:
            with pytest.raises(TransportRejected):
                await t.send(REQUEST)


@pytest.mark.asyncio
async def test_cookie_is_not_replayed_and_vendor_exception_is_not_exposed(caplog):
    seen = []

    async def handler(request):
        logging.getLogger("httpcore.connection").debug("wire headers: %s", request.headers)
        seen.append(request.headers.get("cookie"))
        if len(seen) == 1:
            return httpx.Response(200, json={}, headers={"set-cookie": "session=unit-test-token"})
        raise RuntimeError("unit-test-token should never be reported")

    caplog.set_level(logging.DEBUG)
    async with factory(offline_transport=httpx.MockTransport(handler)) as t:
        await t.send(REQUEST)
        with pytest.raises(TransportRejected) as error:
            await t.send(REQUEST)
    assert seen == [None, None]
    assert "unit-test-token" not in str(error.value)
    assert "unit-test-token" not in caplog.text
    assert error.value.__context__ is None


@pytest.mark.asyncio
async def test_timeout_is_single_attempt_and_cancellation_propagates():
    calls = []

    async def slow(request):
        calls.append(1)
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    async with factory(offline_transport=httpx.MockTransport(slow), timeout_seconds=0.02) as t:
        with pytest.raises(TransportRejected, match="TRANSPORT_TIMEOUT"):
            await t.send(REQUEST)
    assert calls == [1]
    async with factory(offline_transport=httpx.MockTransport(slow)) as t:
        task = asyncio.create_task(t.send(REQUEST))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_repeated_cancellation_joins_one_owned_stream_close():
    started, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    calls = []

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"{}"

        async def aclose(self):
            calls.append(1)
            started.set()
            await release.wait()
            closed.set()

    async def handler(request):
        return httpx.Response(200, stream=Stream())

    t = factory(offline_transport=httpx.MockTransport(handler))
    task = asyncio.create_task(t.send(REQUEST))
    try:
        await asyncio.wait_for(started.wait(), 0.3)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        await t.aclose()
    assert calls == [1] and closed.is_set()


@pytest.mark.asyncio
async def test_failed_wire_close_is_retained_instead_of_repeated_close_claiming_success():
    class Wire(httpx.MockTransport):
        async def aclose(self):
            raise RuntimeError("unit-test-token must not escape")

    t = factory(offline_transport=Wire(lambda request: httpx.Response(200, json={})))
    for _ in range(2):
        with pytest.raises(TransportRejected) as error:
            await t.aclose()
        assert "unit-test-token" not in str(error.value)
    assert not t.close_result.release_confirmed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "service,url,headers",
    [
        ("BINANCE_SPOT", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL", ()),
        (
            "COINGECKO_ASSETS",
            "https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin%2Cethereum%2Csolana&per_page=3&page=1&sparkline=false",
            (("x-cg-pro-api-key", "unit-test-token"),),
        ),
        (
            "COINGECKO_ASSETS",
            "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1&sparkline=false",
            (("x-cg-demo-api-key", "unit-test-token"),),
        ),
    ],
)
async def test_each_other_registered_read_is_accepted(service, url, headers):
    from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport

    async def handler(request):
        assert request.url.host == "8.8.8.8"
        return httpx.Response(200, json={})

    async with PublicReadHttpTransport(
        service, resolver=public_dns, offline_transport=httpx.MockTransport(handler)
    ) as t:
        assert (await t.send(HttpRequest("GET", url, headers))).status == 200


@pytest.mark.asyncio
async def test_mixed_public_private_dns_answers_are_all_checked_before_dispatch():
    from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport

    seen = []

    async def resolver(host):
        return ("8.8.8.8", "127.0.0.1")

    async def handler(request):
        seen.append(1)
        return httpx.Response(200, json={})

    async with PublicReadHttpTransport(
        "BLOCKBEATS_NEWS", resolver=resolver, offline_transport=httpx.MockTransport(handler)
    ) as t:
        with pytest.raises(TransportRejected):
            await t.send(REQUEST)
    assert not seen


@pytest.mark.asyncio
async def test_review_falsey_offline_transport_never_constructs_a_real_wire(monkeypatch):
    from stark_trading_os.integrations.public_data import network

    seen = []

    class Falsey(httpx.MockTransport):
        def __bool__(self):
            return False

    class ForbiddenExternalWire(httpx.AsyncBaseTransport):
        def __init__(self, *args, **kwargs):
            raise AssertionError("offline selection must not construct a real wire")

    async def handler(request):
        seen.append(1)
        return httpx.Response(200, json={})

    monkeypatch.setattr(network.httpx, "AsyncHTTPTransport", ForbiddenExternalWire)
    async with factory(offline_transport=Falsey(handler)) as t:
        assert t.purpose == "OFFLINE_FIXTURE"
        assert (await t.send(REQUEST)).status == 200
    assert seen == [1]


@pytest.mark.asyncio
@pytest.mark.parametrize("first,second", [
    (b" max-age=0 ", b"max-age=31536000; includeSubDomains"),
    (b"max-age=31536000; includeSubDomains", b"max-age=0"),
    (b"max-age=0", b"max-age=0"),
])
async def test_cg_mock_transport_first_sts_only_and_real_strict_still_rejects(
    first: bytes, second: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = [
        (b"X-Before", b"one"),
        (b"Strict-Transport-Security", first),
        (b"retry-after", b"1.25"),
        (b"sTrIcT-tRaNsPoRt-SeCuRiTy", second),
        (b"content-length", b"2"),
    ]
    before = list(raw)
    with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
        http_policy.response_headers(raw)
    folded: list[list[tuple[bytes, bytes]]] = []
    requests: list[httpx.Request] = []

    def spy(value: list[tuple[bytes, bytes]]) -> tuple[int | None, tuple[tuple[str, str], ...]]:
        folded.append(list(value))
        return http_policy.response_headers(value)

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, headers=raw, content=b"{}")

    monkeypatch.setattr(response_policy, "strict_response_headers", spy)
    async with PublicReadHttpTransport(
        "COINGECKO_ASSETS", resolver=public_dns, offline_transport=httpx.MockTransport(handler)
    ) as t:
        result = await t.send(CG_REQUEST)
    assert result.status == 200 and result.body == b"{}"
    assert result.headers == (("retry-after", "2"),)
    assert raw == before
    assert folded == [[
        (b"X-Before", b"one"), (b"Strict-Transport-Security", first),
        (b"retry-after", b"1.25"), (b"content-length", b"2"),
    ]]
    assert len(requests) == 1
    assert requests[0].url.scheme == "https" and requests[0].url.host == "8.8.8.8"
    assert requests[0].headers["host"] == "pro-api.coingecko.com"
    assert requests[0].extensions["sni_hostname"] == "pro-api.coingecko.com"
    assert requests[0].headers["accept-encoding"] == "identity"
    assert "cookie" not in requests[0].headers
    assert t.close_result is not None and t.close_result.release_confirmed


class CgStream(httpx.AsyncByteStream):
    def __init__(self, body: bytes = b"{}") -> None:
        self.body = body
        self.reads = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        self.reads += 1
        yield self.body

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    [(b"content-length", b"2"), (b"Content-Length", b"2")],
    [(b"transfer-encoding", b"chunked"), (b"Transfer-Encoding", b"chunked")],
    [(b"content-type", b"application/json"), (b"Content-Type", b"application/json")],
    [(b"content-encoding", b"identity"), (b"Content-Encoding", b"identity")],
    [(b"retry-after", b"1"), (b"Retry-After", b"1")],
    [(b"vary", b"Origin"), (b"Vary", b"Accept-Encoding")],
    [(b"x-other", b"x"), (b"X-Other", b"x")],
    [(b"content-type", b"text/html")],
    [(b"content-encoding", b"gzip")],
    [(b"content-length", b"2"), (b"transfer-encoding", b"chunked")],
    [(b"content-length", b"262145")],
    [(b"retry-after", b"1" * 257)],
    [(b"strict-transport-security", b"max-age=1\r")],
    [(b"strict-transport-security", b"max-age=1\xff")],
    [(b"strict-transport-security\t", b"max-age=1")],
    [(b"strict-transport-security\xff", b"max-age=1")],
    [(f"x-{i}".encode(), b"a") for i in range(63)],
    [(b"strict-transport-security", b"x" * 16384)],
])
async def test_cg_mock_invalid_original_headers_reject_before_body_and_close(
    extra: list[tuple[bytes, bytes]],
) -> None:
    stream = CgStream()
    wire = httpx.MockTransport(
        lambda request: httpx.Response(200, headers=CG_STS + extra, stream=stream)
    )
    async with PublicReadHttpTransport(
        "COINGECKO_ASSETS", resolver=public_dns, offline_transport=wire
    ) as t:
        assert await send_once(t, CG_REQUEST, timeout_seconds=1) == Failure("INVALID_RESPONSE")
    assert stream.reads == 0 and stream.closed
    assert t.close_result is not None and t.close_result.release_confirmed


@pytest.mark.asyncio
@pytest.mark.parametrize("headers,body", [
    ([(b"content-length", b"3")], b"{}"),
    ([], b"x" * 262145),
])
async def test_cg_sts_does_not_bypass_body_length_or_stream_limit(
    headers: list[tuple[bytes, bytes]], body: bytes,
) -> None:
    stream = CgStream(body)
    wire = httpx.MockTransport(
        lambda request: httpx.Response(200, headers=CG_STS + headers, stream=stream)
    )
    async with PublicReadHttpTransport(
        "COINGECKO_ASSETS", resolver=public_dns, offline_transport=wire
    ) as t:
        assert await send_once(t, CG_REQUEST, timeout_seconds=1) == Failure("INVALID_RESPONSE")
    assert stream.reads == 1 and stream.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("service,sample", [
    ("BINANCE_SPOT", HttpRequest(
        "GET", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL"
    )),
    ("BLOCKBEATS_NEWS", REQUEST),
])
async def test_other_public_network_services_still_reject_duplicate_sts(
    service: PublicService, sample: HttpRequest,
) -> None:
    wire = httpx.MockTransport(lambda r: httpx.Response(200, headers=CG_STS, content=b"{}"))
    async with PublicReadHttpTransport(service, resolver=public_dns, offline_transport=wire) as t:
        assert await send_once(t, sample, timeout_seconds=1) == Failure("INVALID_RESPONSE")


@pytest.mark.asyncio
@pytest.mark.parametrize("service,sample", [
    ("BINANCE_SPOT", HttpRequest(
        "GET", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL"
    )),
    ("OPENROUTER_RESEARCH", HttpRequest(
        "POST", "https://openrouter.ai/api/v1/chat/completions",
        (("content-type", "application/json"),), b"{}",
    )),
])
async def test_shared_strict_network_keeps_identical_cg_sts_input_rejected(
    service: http_policy.Service, sample: HttpRequest,
) -> None:
    wire = httpx.MockTransport(lambda r: httpx.Response(200, headers=CG_STS, content=b"{}"))
    async with BoundedHttpTransport(service, offline_transport=wire) as t:
        with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED") as error:
            await t.send(sample)
        assert error.value.status == "INVALID_RESPONSE"


@pytest.mark.asyncio
async def test_cg_sts_keeps_no_redirect_no_cookies_and_fixed_error_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        logging.getLogger("httpcore.connection").debug("fake-cg-fixture-token")
        if len(seen) == 3:
            raise RuntimeError("fake-cg-fixture-token")
        return httpx.Response(302, content=b"{}", headers=CG_STS + [
            (b"location", b"https://other.invalid/"),
            (b"set-cookie", b"session=synthetic; Path=/"),
            (b"Set-Cookie", b"other=synthetic; Path=/"),
        ])

    caplog.set_level(logging.DEBUG)
    async with PublicReadHttpTransport(
        "COINGECKO_ASSETS", resolver=public_dns, offline_transport=httpx.MockTransport(handler)
    ) as t:
        for _ in range(2):
            result = await t.send(CG_REQUEST)
            assert result.status == 302 and result.headers == ()
        with pytest.raises(TransportRejected, match="TRANSPORT_UNAVAILABLE") as error:
            await t.send(CG_REQUEST)
    assert len(seen) == 3 and all("cookie" not in r.headers for r in seen)
    assert all(r.headers["host"] == "pro-api.coingecko.com" for r in seen)
    assert error.value.__context__ is None
    assert "fake-cg-fixture-token" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("sample", [
    HttpRequest("GET", CG_URL.replace("https:", "http:"), CG_REQUEST.headers),
    HttpRequest(
        "GET", CG_URL.replace("pro-api.coingecko.com", "other.invalid"), CG_REQUEST.headers
    ),
    HttpRequest("GET", CG_URL + "&page=2", CG_REQUEST.headers),
    HttpRequest("POST", CG_URL, CG_REQUEST.headers),
    HttpRequest("GET", CG_URL, CG_REQUEST.headers + (("cookie", "synthetic=yes"),)),
])
async def test_cg_request_guards_remain_before_resolver_and_wire(sample: HttpRequest) -> None:
    calls: list[str] = []

    async def resolver(host: str) -> tuple[str, ...]:
        calls.append("resolver")
        return ("8.8.8.8",)

    async def handler(req: httpx.Request) -> httpx.Response:
        calls.append("wire")
        return httpx.Response(200, headers=CG_STS, content=b"{}")

    async with PublicReadHttpTransport(
        "COINGECKO_ASSETS", resolver=resolver, offline_transport=httpx.MockTransport(handler)
    ) as t:
        with pytest.raises(TransportRejected, match="REQUEST_POLICY_REJECTED"):
            await t.send(sample)
    assert calls == []
