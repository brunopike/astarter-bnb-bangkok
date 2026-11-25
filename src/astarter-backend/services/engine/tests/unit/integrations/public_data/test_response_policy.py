"""Synthetic Vary/STS fields only; never use recorded vendor headers or network."""

from __future__ import annotations

import httpx
import pytest

from stark_trading_os.integrations import http_policy
from stark_trading_os.integrations.public_data import response_policy
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport
from stark_trading_os.integrations.transport import HttpRequest, TransportReason, TransportRejected


def policy(raw, service="BLOCKBEATS_NEWS"):
    from stark_trading_os.integrations.public_data.response_policy import public_response_headers

    return public_response_headers(service, raw)


def vary():
    return [(b"Vary", b"Origin"), (b"vary", b"Accept-Encoding")]


@pytest.mark.asyncio
async def test_blockbeats_two_vary_headers_keep_original_news_body_and_cleanup():
    seen = []

    async def dns(host):
        return ("8.8.8.8",)

    async def handler(request):
        seen.append(request)
        return httpx.Response(200, headers=vary(), json={"status": 0, "data": {"data": []}})

    t = PublicReadHttpTransport(
        "BLOCKBEATS_NEWS", resolver=dns, offline_transport=httpx.MockTransport(handler)
    )
    async with t:
        response = await t.send(
            HttpRequest(
                "GET",
                "https://api-pro.theblockbeats.info/v1/newsflash?page=1&size=50&lang=cn",
                (("api-key", "unit-test-token"),),
            )
        )
    assert response.status == 200 and response.body == b'{"status":0,"data":{"data":[]}}'
    assert len(seen) == 1 and seen[0].extensions["sni_hostname"] == "api-pro.theblockbeats.info"
    assert t.close_result.release_confirmed


def test_duplicate_vary_fold_preserves_order_values_raw_input_and_strict_output(monkeypatch):
    from stark_trading_os.integrations.public_data import response_policy

    raw = [
        (b"content-length", b"2"),
        (b"Vary", b" Origin, Accept-Language "),
        (b"retry-after", b"30"),
        (b"vArY", b"Accept-Encoding"),
        (b"Vary", b"Origin"),
    ]
    before = list(raw)
    original = response_policy.strict_response_headers
    seen = []

    def spy(value):
        seen.append(list(value))
        return original(value)

    monkeypatch.setattr(response_policy, "strict_response_headers", spy)
    assert policy(raw) == (2, (("retry-after", "30"),))
    assert raw == before
    assert seen == [
        [
            (b"content-length", b"2"),
            (b"Vary", b"Origin, Accept-Language, Accept-Encoding, Origin"),
            (b"retry-after", b"30"),
        ]
    ]


@pytest.mark.parametrize("service", ["BINANCE_SPOT", "COINGECKO_ASSETS"])
def test_other_services_delegate_same_raw_object_and_return_value(service, monkeypatch):
    from stark_trading_os.integrations.public_data import response_policy

    raw, result, calls = vary(), (None, ()), []

    def original(value):
        assert value is raw
        calls.append(True)
        return result

    monkeypatch.setattr(response_policy, "strict_response_headers", original)
    assert policy(raw, service) is result
    assert calls == [True]


@pytest.mark.parametrize("service", ["BINANCE_SPOT", "COINGECKO_ASSETS"])
def test_other_services_and_old_t1_still_reject_duplicate_vary(service):
    with pytest.raises(TransportRejected):
        policy(vary(), service)
    with pytest.raises(TransportRejected):
        http_policy.response_headers(vary())


@pytest.mark.parametrize(
    "member", [b"*", b"", b",Origin", b"Origin,", b"Origin,,Accept-Encoding", b"bad:name"]
)
def test_duplicate_only_conservative_star_and_empty_member_policy(member):
    with pytest.raises(TransportRejected):
        policy([(b"Vary", b"Origin"), (b"Vary", member)])


@pytest.mark.parametrize("value", [b"*", b"", b"Origin, Accept-Encoding"])
def test_single_vary_retains_original_policy_including_star_and_empty(value):
    raw = [(b"Vary", value)]
    assert policy(raw) == http_policy.response_headers(raw)


def test_raw_count_and_byte_limits_cannot_be_bypassed_by_folding():
    # 65 raw lines would shrink to 64, and 16390 raw bytes would shrink to
    # 16384. Both must fail before folding rather than fit the post-fold bounds.
    count_raw = vary() + [(f"x-{i}".encode(), b"a") for i in range(63)]
    bytes_raw = [(b"vary", b"a" * 8187), (b"vary", b"b" * 8187)]
    assert len(count_raw) == 65
    assert sum(len(k) + len(v) + 4 for k, v in bytes_raw) == 16390
    for raw in (count_raw, bytes_raw):
        with pytest.raises(TransportRejected):
            policy(raw)


@pytest.mark.parametrize("control", [b"\r", b"\n", b"\t", b"\0", b"\xff"])
def test_original_control_bytes_are_rejected_before_value_strip_or_fold(control):
    with pytest.raises(TransportRejected):
        policy([(b"vary", b"Origin" + control), (b"vary", b"Accept-Encoding")])


def test_malformed_original_name_is_not_hidden_by_duplicate_compatibility():
    with pytest.raises(TransportRejected):
        policy(vary() + [(b"bad:name", b"x")])


@pytest.mark.parametrize(
    "name,value",
    [
        (b"content-length", b"2"),
        (b"transfer-encoding", b"chunked"),
        (b"content-encoding", b"identity"),
        (b"content-type", b"application/json"),
        (b"retry-after", b"30"),
        (b"server", b"example"),
        (b"x-unknown", b"x"),
    ],
)
def test_every_other_duplicate_stays_rejected_even_when_values_match(name, value):
    with pytest.raises(TransportRejected):
        policy(vary() + [(name, value), (name.upper(), value)])


@pytest.mark.parametrize(
    "extra",
    [
        [(b"content-encoding", b"gzip")],
        [(b"content-type", b"text/html")],
        [(b"transfer-encoding", b"chunked"), (b"content-length", b"2")],
        [(b"content-length", b"262145")],
    ],
)
def test_original_encoding_media_framing_and_length_guards_remain(extra):
    with pytest.raises(TransportRejected):
        policy(vary() + extra)


def test_set_cookie_existing_exception_is_unchanged():
    assert policy(vary() + [(b"set-cookie", b"a=one"), (b"set-cookie", b"b=two")]) == (None, ())


def cg_sts() -> list[tuple[bytes, bytes]]:
    return [
        (b"Strict-Transport-Security", b"max-age=0"),
        (b"strict-transport-security", b"max-age=31536000; includeSubDomains"),
    ]


@pytest.mark.parametrize(
    "first,second",
    [
        (b" max-age=0 ", b"max-age=31536000; includeSubDomains"),
        (b"max-age=31536000; includeSubDomains", b"max-age=0"),
        (b"max-age=0", b"max-age=0"),
    ],
    ids=["different-first-zero", "different-first-long", "identical"],
)
def test_cg_sts_first_only_preserves_order_and_global_strict_rejection(
    first: bytes, second: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = [
        (b"X-Before", b"one"),
        (b"Strict-Transport-Security", first),
        (b"retry-after", b"30"),
        (b"sTrIcT-tRaNsPoRt-SeCuRiTy", second),
        (b"content-length", b"2"),
        (b"STRICT-TRANSPORT-SECURITY", b"max-age=123"),
    ]
    before = list(raw)
    with pytest.raises(TransportRejected) as error:
        http_policy.response_headers(raw)
    assert error.value.reason is TransportReason.RESPONSE
    assert error.value.status == "INVALID_RESPONSE"
    calls: list[list[tuple[bytes, bytes]]] = []

    def spy(value: list[tuple[bytes, bytes]]) -> tuple[int | None, tuple[tuple[str, str], ...]]:
        calls.append(list(value))
        return http_policy.response_headers(value)

    monkeypatch.setattr(response_policy, "strict_response_headers", spy)
    assert response_policy.public_response_headers("COINGECKO_ASSETS", raw) == (
        2, (("retry-after", "30"),)
    )
    assert raw == before
    assert calls == [[
        (b"X-Before", b"one"),
        (b"Strict-Transport-Security", first),
        (b"retry-after", b"30"),
        (b"content-length", b"2"),
    ]]


@pytest.mark.parametrize("sts", [[], [(b"Strict-Transport-Security", b"")],
                                 [(b"Strict-Transport-Security", b"opaque; not parsed")]])
def test_cg_no_or_single_sts_delegates_same_raw_to_real_strict(
    sts: list[tuple[bytes, bytes]], monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = [(b"content-length", b"2"), *sts]
    calls: list[bool] = []

    def spy(value: list[tuple[bytes, bytes]]) -> tuple[int | None, tuple[tuple[str, str], ...]]:
        assert value is raw
        calls.append(True)
        return http_policy.response_headers(value)

    monkeypatch.setattr(response_policy, "strict_response_headers", spy)
    assert response_policy.public_response_headers("COINGECKO_ASSETS", raw) == (2, ())
    assert calls == [True]


@pytest.mark.parametrize("service", ["BINANCE_SPOT", "BLOCKBEATS_NEWS",
                                    "OPENROUTER_RESEARCH", "UNKNOWN"])
def test_cg_sts_exception_is_not_shared_with_any_other_service(service: str) -> None:
    raw = cg_sts()
    if service == "BLOCKBEATS_NEWS":
        raw += [(b"Vary", b"Origin"), (b"vary", b"Accept-Encoding")]
    with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
        response_policy.public_response_headers(service, raw)


@pytest.mark.parametrize(
    "name,value",
    [
        (b"content-length", b"2"),
        (b"transfer-encoding", b"chunked"),
        (b"content-encoding", b"identity"),
        (b"content-type", b"application/json"),
        (b"retry-after", b"30"),
        (b"vary", b"Origin"),
        (b"server", b"synthetic"),
        (b"x-unknown", b"opaque"),
    ],
)
def test_cg_sts_does_not_allow_any_other_duplicate(name: bytes, value: bytes) -> None:
    raw = cg_sts() + [(name, value), (name.upper(), value)]
    with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
        response_policy.public_response_headers("COINGECKO_ASSETS", raw)


@pytest.mark.parametrize("invalid", [b"\r", b"\n", b"\t", b"\0", b"\x7f", b"\xff"])
@pytest.mark.parametrize("target", ["second-sts-value", "second-sts-name", "other-value"])
def test_cg_all_original_fields_validated_before_discarding_second_sts(
    invalid: bytes, target: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = cg_sts()
    if target == "second-sts-value":
        raw[1] = (b"strict-transport-security", b"max-age=1" + invalid)
    elif target == "second-sts-name":
        raw[1] = (b"strict-transport-security" + invalid, b"max-age=1")
        # Still exercise the folding path with two valid STS names present.
        raw.append((b"STRICT-TRANSPORT-SECURITY", b"max-age=2"))
    else:
        raw.append((b"x-other", b"opaque" + invalid))
    calls: list[bool] = []

    def spy(value: list[tuple[bytes, bytes]]) -> tuple[int | None, tuple[tuple[str, str], ...]]:
        calls.append(True)
        return http_policy.response_headers(value)

    monkeypatch.setattr(response_policy, "strict_response_headers", spy)
    with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
        response_policy.public_response_headers("COINGECKO_ASSETS", raw)
    assert not calls


@pytest.mark.parametrize(
    "name", [b"", b"strict-transport-security:", b"strict-transport-security "]
)
def test_cg_invalid_second_sts_name_cannot_be_normalized(name: bytes) -> None:
    with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
        response_policy.public_response_headers("COINGECKO_ASSETS", [*cg_sts(), (name, b"x")])


def test_cg_raw_count_and_byte_limits_include_discarded_sts() -> None:
    count_raw = cg_sts() + [(f"x-{i}".encode(), b"a") for i in range(63)]
    bytes_raw = [(b"strict-transport-security", b"max-age=0"),
                 (b"strict-transport-security", b"x" * 16318)]
    assert len(count_raw) == 65
    assert sum(len(k) + len(v) + 4 for k, v in bytes_raw) == 16385
    for raw in (count_raw, bytes_raw):
        with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
            response_policy.public_response_headers("COINGECKO_ASSETS", raw)
    assert response_policy.public_response_headers("COINGECKO_ASSETS", count_raw[:-1]) == (None, ())
    exact_bytes = [bytes_raw[0], (b"strict-transport-security", b"x" * 16317)]
    assert sum(len(k) + len(v) + 4 for k, v in exact_bytes) == 16384
    assert response_policy.public_response_headers("COINGECKO_ASSETS", exact_bytes) == (None, ())


@pytest.mark.parametrize("extra", [
    [(b"content-encoding", b"gzip")],
    [(b"content-type", b"text/html")],
    [(b"transfer-encoding", b"chunked"), (b"content-length", b"2")],
    [(b"content-length", b"262145")],
    [(b"content-length", b"02")],
    [(b"retry-after", b"1" * 257)],
])
def test_cg_sts_keeps_original_strict_field_rules(extra: list[tuple[bytes, bytes]]) -> None:
    with pytest.raises(TransportRejected, match="RESPONSE_POLICY_REJECTED"):
        response_policy.public_response_headers("COINGECKO_ASSETS", cg_sts() + extra)


def test_cg_sts_preserves_set_cookie_exception_without_forwarding_metadata() -> None:
    raw = cg_sts() + [(b"set-cookie", b"a=one"), (b"Set-Cookie", b"b=two")]
    assert response_policy.public_response_headers("COINGECKO_ASSETS", raw) == (None, ())
