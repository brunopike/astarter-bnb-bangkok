"""Existing asset reads carry optional public CDN metadata; never fetch an image."""

from __future__ import annotations

import json

import pytest

from stark_trading_os.integrations.public_data import PublicDataCredentials, PublicDataProvider
from stark_trading_os.integrations.public_data.models import AssetData
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

NOW = 1700000000000
IMAGE = "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400"


async def fetch(rows, ids=("bitcoin",)):
    t = FixtureTransport((HttpResponse(200, json.dumps(rows).encode()),))
    p = PublicDataProvider(
        asset_transport=t,
        credentials=PublicDataCredentials(coingecko_api_key="unit-test-token"),
        clock_ms=lambda: NOW,
    )
    return await p.fetch_assets(ids), t


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        IMAGE,
        "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
        "https://coin-images.coingecko.com/coins/images/4128/thumb/solana.webp?123",
        "https://coin-images.coingecko.com/coins/images/1/large/btc-logo.svg",
    ],
)
async def test_public_cdn_image_uses_existing_request_and_decimal_identity(url):
    batch, t = await fetch([{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "image": url}])
    assert batch.quality == "fresh"
    data = batch.items[0].data
    assert data.asset_id == "bitcoin" and data.symbol == "BTC"
    assert data.image_url == url
    assert t.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        123,
        False,
        {"image": IMAGE},
        IMAGE.replace("https://", "http://"),
        IMAGE.replace("coin-images.coingecko.com", "coin-images.coingecko.com.evil.example"),
        IMAGE.replace("coin-images.coingecko.com", "evil.example"),
        IMAGE.replace("coin-images.coingecko.com", "user@coin-images.coingecko.com"),
        IMAGE.replace("coin-images.coingecko.com", "coin-images.coingecko.com:443"),
        IMAGE + "#fragment",
        IMAGE + "&api_key=other-token",
        IMAGE.replace("bitcoin.png", "%62itcoin.png"),
        IMAGE.replace("/coins/images/1/", "/coins/images/../1/"),
        IMAGE.replace("/coins/images/", "/nft/images/"),
        IMAGE.replace("/large/", "/original/"),
        "data:image/png;base64,AA",
        "javascript:alert(1)",
    ],
)
async def test_missing_or_unsafe_image_becomes_null_without_dropping_asset_data(url):
    batch, t = await fetch([{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "image": url}])
    assert batch.quality == "fresh"
    assert batch.items[0].data.image_url is None
    assert batch.items[0].data.asset_id == "bitcoin"
    assert t.calls == 1


@pytest.mark.asyncio
async def test_absent_image_is_explicit_null_and_old_asset_dto_is_compatible():
    batch, _ = await fetch([{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin"}])
    assert batch.items[0].data.model_dump(mode="json")["image_url"] is None
    data = AssetData(asset_id="bitcoin", name="Bitcoin", symbol="BTC")
    assert data.image_url is None


def test_direct_dto_also_rejects_unsafe_image_metadata():
    data = AssetData(
        asset_id="bitcoin", name="Bitcoin", symbol="BTC", image_url="https://evil.example/image.png"
    )
    assert data.image_url is None


@pytest.mark.asyncio
async def test_batched_image_binding_uses_asset_id_and_symbol_and_one_call():
    eth_image = "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png"
    batch, t = await fetch(
        [
            {"id": "ethereum", "symbol": "eth", "name": "Ethereum", "image": eth_image},
            {"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "image": IMAGE},
        ],
        ("bitcoin", "ethereum"),
    )
    assert {i.data.asset_id: i.data.image_url for i in batch.items} == {
        "bitcoin": IMAGE,
        "ethereum": eth_image,
    }
    assert t.calls == 1
    invalid, _ = await fetch(
        [{"id": "bitcoin", "symbol": "eth", "name": "Bitcoin", "image": IMAGE}]
    )
    assert invalid.quality == "unavailable" and not invalid.items


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "https://coin-images.coingecko.com/coins/images/1/large/unit-test-token.png",
        "https://coin-images.coingecko.com/coins/images/1/large/unit-test-%74oken.png",
    ],
)
async def test_image_metadata_never_bypasses_existing_credential_echo_rejection(url):
    batch, _ = await fetch([{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "image": url}])
    assert batch.quality == "unavailable" and not batch.items
    assert batch.sources[0].status == "INVALID_RESPONSE"
    assert "unit-test-token" not in batch.model_dump_json()
