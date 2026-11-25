"""Credential echo check at and past its decode bound.

Synthetic inputs only; these tests never load a real credential or use the network. The only
credential is a plain word, and every transport is an in-memory fixture.
"""

from __future__ import annotations

import json
from urllib.parse import quote

import pytest

from stark_trading_os.integrations.public_data import PublicDataCredentials, PublicDataProvider
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

NOW = 1700000000000
# Synthetic value only, the same plain word test_providers.py uses. It is never a real key.
ECHO_CREDENTIAL = "unit-test-token"


def provider(**kwargs):
    return PublicDataProvider(clock_ms=lambda: NOW, **kwargs)


def transport(body):
    return FixtureTransport((HttpResponse(200, json.dumps(body).encode()),))


def _percent_encoded(value: str, times: int) -> str:
    """Encode every byte once, then the percent signs again for each further level."""
    text = "".join(f"%{byte:02X}" for byte in value.encode())
    for _ in range(times - 1):
        text = quote(text, safe="")
    return text


async def _projected(target: str, value: str):
    credentials = PublicDataCredentials(
        coingecko_api_key=ECHO_CREDENTIAL, blockbeats_api_key=ECHO_CREDENTIAL
    )
    if target == "asset_name":
        return await provider(
            asset_transport=transport([{"id": "bitcoin", "symbol": "btc", "name": value}]),
            credentials=credentials,
        ).fetch_assets(("bitcoin",))
    row = {
        "id": 1,
        "title": value,
        "content": "Text",
        "url": "https://www.theblockbeats.info/flash/1",
        "create_time": "1699999990",
    }
    return await provider(
        news_transport=transport({"status": 0, "data": {"data": [row]}}),
        credentials=credentials,
    ).fetch_news()


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["news_title", "asset_name"])
@pytest.mark.parametrize("times", [4, 5], ids=["encoded_4_times", "encoded_5_times"])
async def test_credential_encoded_past_the_decode_bound_fails_closed(target, times):
    # The check decodes at most four times. Four levels end on the plain value, which must be
    # checked; five levels end on a value that one more decode would still change.
    echo = _percent_encoded(ECHO_CREDENTIAL, times)
    batch = await _projected(target, echo)
    assert batch.quality == "unavailable"
    assert not batch.items and batch.as_of_ms is None
    assert batch.sources[0].status == "INVALID_RESPONSE"
    output = batch.model_dump_json()
    assert ECHO_CREDENTIAL not in output
    for level in range(1, times + 1):
        assert _percent_encoded(ECHO_CREDENTIAL, level) not in output


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["news_title", "asset_name"])
async def test_harmless_value_encoded_twice_is_still_projected(target):
    harmless = _percent_encoded("Bitcoin", 2)
    batch = await _projected(target, harmless)
    assert batch.quality == "fresh"
    assert batch.sources[0].status == "OK"
    assert len(batch.items) == 1
    data = batch.items[0].data
    assert (data.title if target == "news_title" else data.name) == harmless
