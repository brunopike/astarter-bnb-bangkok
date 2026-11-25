"""Synthetic news: explicit BlockBeats wall time must not relax other clocks."""

import json
from datetime import datetime

import pytest

from stark_trading_os.integrations.public_data import PublicDataCredentials, PublicDataProvider
from stark_trading_os.integrations.public_data.providers import _timestamp
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

NOW = int(datetime.fromisoformat("2026-10-29T15:30:00+00:00").timestamp() * 1000)


async def news(stamp, title="Synthetic news"):
    body = {
        "status": 0,
        "data": {
            "data": [
                {
                    "id": 1,
                    "title": title,
                    "content": "Synthetic only",
                    "link": "https://www.theblockbeats.info/flash/1",
                    "create_time": stamp,
                }
            ]
        },
    }
    transport = FixtureTransport((HttpResponse(200, json.dumps(body).encode()),))
    result = await PublicDataProvider(
        news_transport=transport,
        credentials=PublicDataCredentials(blockbeats_api_key="unit-test-token"),
        clock_ms=lambda: NOW,
    ).fetch_news(1)
    assert transport.calls == 1
    return result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wall,utc",
    [
        ("2026-10-29 23:21:32", "2026-10-29T15:21:32+00:00"),
        ("2026-10-29 23:16:30", "2026-10-29T15:16:30+00:00"),
        ("2026-10-29 23:14:28", "2026-10-29T15:14:28+00:00"),
        ("2026-10-29 00:00:00", "2026-10-28T16:00:00+00:00"),
        ("2024-02-29 00:00:00", "2024-02-28T16:00:00+00:00"),
        ("2024-03-01 00:00:00", "2024-02-29T16:00:00+00:00"),
    ],
)
async def test_blockbeats_exact_wall_format_maps_to_fixed_utc8(wall, utc):
    batch = await news(wall)
    assert batch.quality == "fresh"
    item = batch.items[0]
    assert item.event_time_ms == int(datetime.fromisoformat(utc).timestamp() * 1000)
    assert item.data.published_at_ms == item.event_time_ms
    assert item.received_at_ms == NOW
    assert item.valid_until_ms == NOW + 60000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stamp",
    [
        "2026-02-29 12:00:00",
        "2026-13-29 12:00:00",
        "2026-10-29 24:00:00",
        "0000-10-29 12:00:00",
        "2026-1-29 12:00:00",
        "2026-10-9 12:00:00",
        "2026-10-29 2:00:00",
        "2026-10-29T12:00:00",
        "20261029 120000",
        "2026-10-29 12:00:00.000",
        "2026-10-29 12:00:00 ",
        " 2026-10-29 12:00:00",
        "2026-10-29\t12:00:00",
        "2026-10-29 12:00:00\n",
        "2026-10-29 12:00:00\0",
        "２０２６-10-29 12:00:00",
        True,
        None,
    ],
)
async def test_ambiguous_or_malformed_naive_news_is_still_rejected(stamp):
    batch = await news(stamp)
    assert batch.quality == "unavailable"
    assert batch.sources[0].status == "INVALID_RESPONSE"
    assert not batch.items


@pytest.mark.parametrize("stamp", ["2026-10-29 23:21:32", "2026-10-29T23:21:32"])
def test_global_parser_still_rejects_naive_dates(stamp):
    with pytest.raises(ValueError):
        _timestamp(stamp)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stamp",
    [
        1793287292,
        "1793287292",
        "1793287292000",
        "2026-10-29T15:21:32Z",
        "2026-10-29 23:21:32+08:00",
        "2026-10-29T11:21:32-04:00",
    ],
)
async def test_original_epoch_and_aware_semantics_are_preserved(stamp):
    batch = await news(stamp)
    assert batch.quality == "fresh"
    assert batch.items[0].event_time_ms == 1793287292000


@pytest.mark.asyncio
async def test_future_news_is_not_replaced_by_received_time():
    batch = await news("2026-10-29 23:31:00")
    assert batch.quality == "unavailable" and not batch.items
    assert batch.sources[0].status == "INVALID_RESPONSE"


@pytest.mark.asyncio
async def test_naive_asset_time_does_not_inherit_news_offset():
    body = [
        {"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "last_updated": "2026-10-29 23:21:32"}
    ]
    batch = await PublicDataProvider(
        asset_transport=FixtureTransport((HttpResponse(200, json.dumps(body).encode()),)),
        credentials=PublicDataCredentials(coingecko_api_key="unit-test-token"),
        clock_ms=lambda: NOW,
    ).fetch_assets(("bitcoin",))
    assert batch.quality == "unavailable" and not batch.items


@pytest.mark.asyncio
async def test_new_wall_time_does_not_bypass_decoded_credential_guard():
    batch = await news("2026-10-29 23:21:32", "%75nit%2Dtest%2Dtoken")
    assert batch.quality == "unavailable" and not batch.items
    assert "unit-test-token" not in batch.model_dump_json()
