"""Synthetic inputs only; these tests never load a real credential or use the network."""

from __future__ import annotations

import asyncio
import json
from hashlib import sha256

import httpx
import pytest

from stark_trading_os.integrations.public_data import PublicDataCredentials, PublicDataProvider
from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

NOW = 1700000000000


def provider(**kwargs):
    from stark_trading_os.integrations.public_data import PublicDataProvider

    return PublicDataProvider(clock_ms=lambda: NOW, **kwargs)


def transport(body, status=200, headers=()):
    return FixtureTransport((HttpResponse(status, json.dumps(body).encode(), headers),))


def ticker(symbol="BTCUSDT", price="60000"):
    return {
        "symbol": symbol,
        "lastPrice": price,
        "volume": "2",
        "quoteVolume": "120000",
        "openTime": NOW - 86400000,
        "closeTime": NOW - 1000,
    }


@pytest.mark.asyncio
async def test_unconfigured_provider_returns_no_data_or_execution_authority():
    p = provider()
    for batch in [
        await p.fetch_markets(("bitcoin",)),
        await p.fetch_assets(("bitcoin",)),
        await p.fetch_news(),
    ]:
        assert batch.quality == "unavailable"
        assert not batch.items
        assert batch.as_of_ms is None
        assert batch.sources[0].status == "UNCONFIGURED"


@pytest.mark.asyncio
async def test_market_projection_preserves_identity_decimal_and_source_time():
    t = transport(ticker())
    batch = await provider(market_transport=t).fetch_markets(("bitcoin",))
    assert batch.mode == "offline_fixture"
    assert batch.quality == "fresh"
    item = batch.items[0]
    assert item.subject_id == "bitcoin"
    assert item.event_time_ms == NOW - 1000
    assert item.data.instrument.quote_asset == "USDT"
    assert item.data.last_price == "60000"
    assert item.data.metric_kind == "SPOT_24H_STATISTICS"
    assert item.data.price_change_pct is None
    assert t.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["2.500", "-95.960", "0.000", "-0.000", "125.001"])
async def test_native_percentage_preserves_units_precision_and_all_source_clocks(change):
    body = ticker(price="60000.12000000") | {"priceChangePercent": change}
    t = transport(body)
    batch = await provider(market_transport=t).fetch_markets(("bitcoin",))
    item = batch.items[0]
    assert item.data.price_change_pct == change  # Percent, not a fractional return.
    assert item.data.last_price == body["lastPrice"]
    assert item.data.base_volume == body["volume"]
    assert item.data.quote_volume == body["quoteVolume"]
    assert item.data.window_open_at_ms == body["openTime"]
    assert item.data.window_close_at_ms == item.event_time_ms == body["closeTime"]
    assert item.received_at_ms == item.available_at_ms == NOW
    assert item.valid_until_ms == body["closeTime"] + 30000
    assert item.source_revision == sha256(json.dumps(body).encode()).hexdigest()
    assert batch.as_of_ms == NOW and batch.quality == "fresh"
    assert t.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", [None, True, 2.5, 0, "", "NaN", "Infinity", "1e2", "+1", " 1", "01", "1\n", "9" * 81]
)
async def test_present_invalid_percentage_rejects_row_and_preserves_partial_coverage(change):
    t = FixtureTransport(
        (
            HttpResponse(200, json.dumps(ticker() | {"priceChangePercent": change}).encode()),
            HttpResponse(
                200, json.dumps(ticker("ETHUSDT") | {"priceChangePercent": "-1.250"}).encode()
            ),
        )
    )
    batch = await provider(market_transport=t).fetch_markets(("bitcoin", "ethereum"))
    assert batch.quality == "partial"
    assert batch.coverage.gaps == ("bitcoin",)
    assert [s.status for s in batch.sources] == ["INVALID_RESPONSE", "OK"]
    assert [i.subject_id for i in batch.items] == ["ethereum"]
    assert batch.items[0].data.price_change_pct == "-1.250"


@pytest.mark.asyncio
@pytest.mark.parametrize("offset", [1, 63, 86400000])
async def test_valid_percentage_never_masks_future_source(offset):
    body = ticker() | {"priceChangePercent": "1.250", "closeTime": NOW + offset}
    batch = await provider(market_transport=transport(body)).fetch_markets(("bitcoin",))
    assert batch.quality == "unavailable" and not batch.items
    assert batch.as_of_ms is None
    assert batch.sources[0].status == "INVALID_RESPONSE"


@pytest.mark.asyncio
async def test_stale_percentage_keeps_original_source_and_expiry():
    body = ticker() | {"priceChangePercent": "-1.250", "closeTime": NOW - 30001}
    batch = await provider(market_transport=transport(body)).fetch_markets(("bitcoin",))
    item = batch.items[0]
    assert batch.quality == item.quality == "stale"
    assert item.data.price_change_pct == "-1.250"
    assert item.event_time_ms == NOW - 30001
    assert batch.as_of_ms == NOW
    assert item.received_at_ms == item.available_at_ms == NOW
    assert item.valid_until_ms == NOW - 1


@pytest.mark.asyncio
async def test_partial_market_failures_do_not_zero_fill_or_hide_missing_asset():
    t = FixtureTransport(
        (
            HttpResponse(200, json.dumps(ticker()).encode()),
            HttpResponse(429, b"{}", (("retry-after", "30"),)),
        )
    )
    b = await provider(market_transport=t).fetch_markets(("bitcoin", "solana"))
    assert b.quality == "partial"
    assert b.coverage.gaps == ("solana",)
    assert b.missing_capabilities == ("market.statistics:solana",)
    assert len(b.items) == 1
    assert any(s.status == "RATE_LIMITED" for s in b.sources)


@pytest.mark.asyncio
async def test_three_markets_start_together_and_preserve_selection_order_and_partial_data():
    class Concurrent:
        purpose = "OFFLINE_FIXTURE"

        def __init__(self):
            self.entered = []
            self.all_started = asyncio.Event()

        async def send(self, request):
            from urllib.parse import parse_qs, urlsplit

            symbol = parse_qs(urlsplit(request.url).query)["symbol"][0]
            self.entered.append(symbol)
            if len(self.entered) == 3:
                self.all_started.set()
            await self.all_started.wait()
            if symbol == "ETHUSDT":
                return HttpResponse(429, b"{}", (("retry-after", "30"),))
            return HttpResponse(200, json.dumps(ticker(symbol=symbol)).encode())

    t = Concurrent()
    b = await asyncio.wait_for(
        provider(market_transport=t).fetch_markets(("solana", "ethereum", "bitcoin")), 0.3
    )
    assert len(t.entered) == 3
    assert tuple(i.subject_id for i in b.items) == ("solana", "bitcoin")
    assert b.quality == "partial" and b.coverage.gaps == ("ethereum",)
    assert [s.status for s in b.sources] == ["OK", "RATE_LIMITED", "OK"]


@pytest.mark.asyncio
async def test_one_market_timeout_keeps_other_results_within_bff_batch_deadline():
    finished = asyncio.Event()

    class SlowOne:
        purpose = "OFFLINE_FIXTURE"

        async def send(self, request):
            if "ETHUSDT" in request.url:
                try:
                    await asyncio.sleep(30)
                finally:
                    finished.set()
            if "SOLUSDT" in request.url:
                return HttpResponse(429, b"{}", (("retry-after", "30"),))
            return HttpResponse(200, json.dumps(ticker()).encode())

    b = await asyncio.wait_for(
        provider(market_transport=SlowOne()).fetch_markets(("ethereum", "bitcoin", "solana")),
        4.0,
    )
    assert finished.is_set()
    assert [i.subject_id for i in b.items] == ["bitcoin"]
    assert b.quality == "partial" and b.coverage.gaps == ("ethereum", "solana")
    assert [s.status for s in b.sources] == ["TIMEOUT", "OK", "RATE_LIMITED"]


@pytest.mark.asyncio
@pytest.mark.parametrize("ids", [("WBTC",), ("bitcoin", "bitcoin"), (), ("BTCUSDT",)])
async def test_unsupported_or_duplicate_assets_are_rejected_without_dispatch(ids):
    t = transport(ticker())
    with pytest.raises(ValueError, match="INVALID_ASSET_SELECTION"):
        await provider(market_transport=t).fetch_markets(ids)
    assert t.calls == 0


@pytest.mark.asyncio
async def test_asset_numbers_remain_decimal_text_and_null_does_not_become_zero():
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    body = (
        b'[{"id":"bitcoin","symbol":"btc","name":"Bitcoin",'
        b'"market_cap":12345678901234567890.123456789,"total_volume":null,'
        b'"circulating_supply":12.5,"last_updated":"2023-11-14T22:13:19Z"}]'
    )
    t = FixtureTransport((HttpResponse(200, body),))
    b = await provider(
        asset_transport=t, credentials=PublicDataCredentials(coingecko_api_key="unit-test-token")
    ).fetch_assets(("bitcoin",))
    assert b.quality == "fresh"
    assert b.items[0].data.market_cap == "12345678901234567890.123456789"
    assert b.items[0].data.total_volume is None
    assert b.items[0].data.symbol == "BTC"
    assert b.items[0].data.contracts == ()


@pytest.mark.asyncio
async def test_news_nested_payload_strips_active_markup_and_preserves_epoch_seconds():
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    body = {
        "status": 0,
        "data": {
            "data": [
                {
                    "id": 1,
                    "title": "<b>News</b>",
                    "content": "<script>bad()</script><p>Read &amp; verify</p>",
                    "url": "https://www.theblockbeats.info/flash/1",
                    "create_time": "1699999990",
                }
            ]
        },
    }
    b = await provider(
        news_transport=transport(body),
        credentials=PublicDataCredentials(blockbeats_api_key="unit-test-token"),
    ).fetch_news(limit=1)
    assert b.quality == "fresh"
    d = b.items[0].data
    assert d.title == "News"
    assert d.summary == "Read & verify"
    assert d.published_at_ms == 1699999990000
    assert d.asset_ids == ()


@pytest.mark.asyncio
async def test_successful_empty_news_is_distinct_from_failed_empty_news():
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    credentials = PublicDataCredentials(blockbeats_api_key="unit-test-token")
    good = await provider(
        news_transport=transport({"status": 0, "data": {"data": []}}), credentials=credentials
    ).fetch_news()
    bad = await provider(
        news_transport=transport({}, status=403), credentials=credentials
    ).fetch_news()
    assert good.quality == "fresh" and good.sources[0].status == "OK"
    assert not good.items and good.as_of_ms == NOW
    assert bad.quality == "unavailable" and bad.as_of_ms is None


@pytest.mark.asyncio
async def test_credential_echo_and_invalid_url_do_not_escape_as_news():
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    for title, url in [
        ("unit-test-token", "https://www.theblockbeats.info/"),
        ("News", "javascript:alert(1)"),
    ]:
        b = await provider(
            news_transport=transport(
                {
                    "status": 0,
                    "data": {
                        "data": [
                            {
                                "id": 1,
                                "title": title,
                                "content": "text",
                                "url": url,
                                "create_time": "1699999990",
                            }
                        ]
                    },
                }
            ),
            credentials=PublicDataCredentials(blockbeats_api_key="unit-test-token"),
        ).fetch_news()
        assert b.quality == "unavailable" and not b.items
        assert "unit-test-token" not in b.model_dump_json()


@pytest.mark.asyncio
async def test_cancellation_propagates_instead_of_becoming_empty_data():
    class Cancelled:
        purpose = "OFFLINE_FIXTURE"

        async def send(self, request):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await provider(market_transport=Cancelled()).fetch_markets(("bitcoin",))


@pytest.mark.asyncio
async def test_explorer_chain_and_capability_are_independent_and_default_untested():
    from stark_trading_os.integrations.public_data import ExplorerCapability

    observations = (
        ExplorerCapability(
            chain_id="56",
            capability_id="proxy.block_number",
            verification_state="VERIFIED",
            status="UNAUTHORIZED",
            verified_at_ms=NOW,
            reason_code="ENTITLEMENT_REQUIRED",
        ),
        ExplorerCapability(
            chain_id="56",
            capability_id="contract.abi",
            verification_state="VERIFIED",
            status="OK",
            verified_at_ms=NOW,
        ),
    )
    b = await provider(explorer_observations=observations).fetch_explorer_capabilities("56")
    by_id = {i.data.capability_id: i.data for i in b.items}
    assert by_id["contract.abi"].status == "OK"
    assert by_id["proxy.block_number"].status == "UNAUTHORIZED"
    other = await provider().fetch_explorer_capabilities("10")
    assert all(i.data.verification_state == "UNTESTED" for i in other.items)
    assert all(i.data.verified_at_ms is None for i in other.items)


@pytest.mark.asyncio
async def test_stale_market_is_returned_with_original_expired_deadline():
    old = ticker()
    old["closeTime"] = NOW - 60000
    b = await provider(market_transport=transport(old)).fetch_markets(("bitcoin",))
    assert b.quality == "stale"
    assert b.items[0].valid_until_ms == NOW - 30000
    assert b.items[0].event_time_ms == NOW - 60000


@pytest.mark.asyncio
async def test_html_encoded_credential_is_not_projected_in_news():
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    body = {
        "status": 0,
        "data": {
            "data": [
                {
                    "id": 1,
                    "title": "&#117;nit-test-token",
                    "content": "text",
                    "url": "https://www.theblockbeats.info/",
                    "create_time": "1699999990",
                }
            ]
        },
    }
    b = await provider(
        news_transport=transport(body),
        credentials=PublicDataCredentials(blockbeats_api_key="unit-test-token"),
    ).fetch_news()
    assert b.quality == "unavailable" and not b.items
    assert "unit-test-token" not in b.model_dump_json()


@pytest.mark.asyncio
async def test_future_or_duplicate_key_asset_payload_is_rejected():
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    for raw in [
        b'[{"id":"bitcoin","symbol":"btc","name":"Bitcoin","last_updated":"2099-01-01T00:00:00Z"}]',
        b'[{"id":"bitcoin","id":"ethereum","symbol":"eth","name":"Ethereum"}]',
    ]:
        b = await provider(
            asset_transport=FixtureTransport((HttpResponse(200, raw),)),
            credentials=PublicDataCredentials(coingecko_api_key="unit-test-token"),
        ).fetch_assets(("bitcoin",))
        assert b.quality == "unavailable" and not b.items


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["news_title", "news_summary", "asset_name"])
@pytest.mark.parametrize(
    "secret,echo",
    [
        ("unit-test-token", "unit-<!--join-->test-token"),
        ("unit-test-token", "unit-<b>test-token</b>"),
        ('unit-test-"token', 'unit-test-"token'),
        (r"unit-test-\token", r"unit-test-\token"),
        ('unit-test-"token', "unit-<!--join-->test-%22token"),
    ],
    ids=["comment_join", "tag_join", "json_quote", "json_backslash", "join_and_url_decode"],
)
async def test_review_credentials_cannot_escape_decoded_or_final_projection(target, secret, echo):
    from stark_trading_os.integrations.public_data import PublicDataCredentials

    credentials = PublicDataCredentials(coingecko_api_key=secret, blockbeats_api_key=secret)
    if target == "asset_name":
        batch = await provider(
            asset_transport=transport([{"id": "bitcoin", "symbol": "btc", "name": echo}]),
            credentials=credentials,
        ).fetch_assets(("bitcoin",))
    else:
        row = {
            "id": 1,
            "title": "News",
            "content": "Text",
            "url": "https://www.theblockbeats.info/flash/1",
            "create_time": "1699999990",
        }
        row["title" if target == "news_title" else "content"] = echo
        batch = await provider(
            news_transport=transport({"status": 0, "data": {"data": [row]}}),
            credentials=credentials,
        ).fetch_news()
    assert batch.quality == "unavailable"
    assert not batch.items and batch.as_of_ms is None
    assert batch.sources[0].status == "INVALID_RESPONSE"
    # Inspect decoded output too: JSON serialization could escape a quoted key.
    pending = [batch.model_dump(mode="json")]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            assert secret not in value
        elif isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)


@pytest.mark.asyncio
async def test_review_untested_registry_does_not_claim_an_etherscan_success():
    batch = await provider().fetch_explorer_capabilities()
    assert len(batch.items) == 12
    assert all(i.data.verification_state == "UNTESTED" for i in batch.items)
    assert all(i.data.verified_at_ms is None for i in batch.items)
    assert all(s.provider_id != "etherscan-v2" for s in batch.sources)
    assert batch.sources[0].provider_id == "local-explorer-capability-registry-v1"
    assert batch.sources[0].reason_code == "LOCAL_REGISTRY_ONLY"
    assert batch.sources[0].last_success_at_ms == NOW


@pytest.mark.asyncio
async def test_review_old_explorer_evidence_is_preserved_without_new_external_health():
    from stark_trading_os.integrations.public_data import ExplorerCapability

    old = NOW - 86400000
    observation = ExplorerCapability(
        chain_id="56",
        capability_id="proxy.block_number",
        verification_state="VERIFIED",
        status="UNAUTHORIZED",
        verified_at_ms=old,
        reason_code="ENTITLEMENT_REQUIRED",
    )
    batch = await provider(explorer_observations=(observation,)).fetch_explorer_capabilities("56")
    by_id = {i.data.capability_id: i for i in batch.items}
    measured = by_id["proxy.block_number"]
    assert measured.data == observation and measured.event_time_ms == old
    assert by_id["contract.abi"].data.verification_state == "UNTESTED"
    assert all(s.provider_id != "etherscan-v2" for s in batch.sources)
    assert batch.sources[0].reason_code == "LOCAL_REGISTRY_ONLY"


@pytest.mark.asyncio
async def test_review_falsey_transport_preserves_offline_mode_and_mixed_purpose_guard():
    class Falsey(FixtureTransport):
        def __bool__(self):
            return False

    t = Falsey((HttpResponse(200, json.dumps(ticker()).encode()),))
    batch = await provider(market_transport=t).fetch_markets(("bitcoin",))
    assert batch.mode == "offline_fixture" and batch.quality == "fresh"
    assert t.calls == 1

    class External:
        purpose = "EXTERNAL_OBSERVATION"

    with pytest.raises(ValueError, match="MIXED_OR_INVALID_DATA_PURPOSE"):
        provider(market_transport=t, asset_transport=External())


@pytest.mark.asyncio
@pytest.mark.parametrize("duplicate", [False, True], ids=["single-sts-control", "different-sts"])
async def test_cg_provider_three_assets_through_real_mock_transport(duplicate: bool) -> None:
    # Auth, headers and payload are wholly synthetic; this is not a live-response replay.
    raw = [
        {"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "market_cap": "123.45",
         "last_updated": "2023-11-14T22:13:19Z"},
        {"id": "ethereum", "symbol": "eth", "name": "Ethereum", "market_cap": "67.89",
         "last_updated": "2023-11-14T22:13:19Z"},
        {"id": "solana", "symbol": "sol", "name": "Solana", "market_cap": None,
         "last_updated": "2023-11-14T22:13:19Z"},
    ]
    headers = [(b"Strict-Transport-Security", b"max-age=0")]
    if duplicate:
        headers.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
    calls: list[httpx.Request] = []

    async def resolver(host: str) -> tuple[str, ...]:
        assert host == "pro-api.coingecko.com"
        return ("8.8.8.8",)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, headers=headers, json=raw)

    async with PublicReadHttpTransport(
        "COINGECKO_ASSETS", resolver=resolver, offline_transport=httpx.MockTransport(handler)
    ) as t:
        batch = await PublicDataProvider(
            asset_transport=t, clock_ms=lambda: NOW,
            credentials=PublicDataCredentials(coingecko_api_key="fake-cg-fixture-token"),
        ).fetch_assets(("bitcoin", "ethereum", "solana"))
    assert batch.mode == "offline_fixture"
    assert [s.status for s in batch.sources] == ["OK"]
    assert batch.quality == "fresh" and batch.coverage.gaps == ()
    assert batch.coverage.returned_subjects == ("bitcoin", "ethereum", "solana")
    assert [i.subject_id for i in batch.items] == ["bitcoin", "ethereum", "solana"]
    assert all(i.event_time_ms == 1699999999000 for i in batch.items)
    assert all(i.received_at_ms == NOW and i.available_at_ms == NOW for i in batch.items)
    assert len(calls) == 1
    assert calls[0].url.params["ids"] == "bitcoin,ethereum,solana"
    assert calls[0].url.params["per_page"] == "3"
    assert "strict-transport-security" not in batch.model_dump_json().lower()
    assert "fake-cg-fixture-token" not in batch.model_dump_json()
    assert t.close_result is not None and t.close_result.release_confirmed
