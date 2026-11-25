"""Public data is an observation-only HTTP surface, never execution authority."""

from __future__ import annotations

import copy
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.control.public_data_models import PublicDataQuery
from stark_trading_os.control.public_data_store import PublicDataStore, PublicDataStoreError
from tests.unit.control.test_public_data_persistence import RESOURCES, synthetic_payload

ORIGIN = "http://127.0.0.1:4188"
NOW = 1793268000000
PAYLOAD = {
    "mode": "offline_fixture", "as_of_ms": NOW - 1000, "quality": "fresh",
    "coverage": {"requested_subjects": ["bitcoin"], "returned_subjects": ["bitcoin"],
                 "gaps": [], "scope": "BINANCE_SPOT_24H_STATISTICS"},
    "missing_capabilities": [],
    "sources": [{"provider_id": "binance-spot-ticker-v1", "status": "OK",
                 "last_success_at_ms": NOW - 1000, "reason_code": None,
                 "retry_after_seconds": None}],
    "items": [{"record_id": "fixture:market:bitcoin", "subject_id": "bitcoin",
               "provider_id": "binance-spot-ticker-v1", "venue_or_chain": "BINANCE:SPOT",
               "event_time_ms": NOW - 2000, "received_at_ms": NOW - 1500,
               "available_at_ms": NOW - 1000, "valid_until_ms": NOW + 30000,
               "source_revision": "synthetic-v1", "quality": "fresh",
               "data": {"instrument": {"venue": "BINANCE", "market_kind": "SPOT",
                        "symbol": "BTCUSDT", "base_asset": "BTC", "quote_asset": "USDT"},
                        "last_price": "60000", "base_volume": "10", "quote_volume": "600000",
                        "window_open_at_ms": NOW - 86400000, "window_close_at_ms": NOW - 2000,
                        "price_change_pct": None, "metric_kind": "SPOT_24H_STATISTICS"}}],
}


class FakeReadService:
    def __init__(self, scenario: str = "market_fresh") -> None:
        self.payload = copy.deepcopy(PAYLOAD)
        quality = scenario.removeprefix("market_")
        self.payload["quality"] = quality
        if quality == "stale":
            for item in self.payload["items"]:
                item["quality"] = "stale"
        if quality == "unavailable":
            self.payload["items"] = []
            self.payload["as_of_ms"] = None
        self.calls: list[object] = []

    async def read(self, query: object) -> dict[str, object]:
        self.calls.append(query)
        payload = copy.deepcopy(self.payload)
        if query.resource == "news":
            payload["coverage"] = {"requested_subjects": ["news"],
                "returned_subjects": ["news"], "gaps": [], "scope": "NEWS_FEED"}
            for item in payload["items"]:
                item.update(subject_id="news", venue_or_chain=None,
                    provider_id="blockbeats-news-v1",
                    data={"news_id": "fixture:1", "title": "Test", "summary": "Test",
                          "url": "https://www.theblockbeats.info/flash/1",
                          "published_at_ms": NOW - 2000, "asset_ids": []})
        return payload

    async def close(self) -> None:
        pass


def app_with_service(service: FakeReadService | None) -> TestClient:
    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True)
    app.state.public_data_fetcher = None if service is None else service.read
    app.state.public_data_clock = lambda: NOW
    return TestClient(app)


def test_public_data_get_is_bound_to_public_scope_and_selection() -> None:
    service = FakeReadService()
    with app_with_service(service) as client:
        response = client.get(
            "/v1/data/markets?asset_ids=bitcoin,ethereum,solana&selection_version=7",
            headers={"Origin": ORIGIN},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "AstarterPublicData.v1"
    assert body["tenant_scope"] == "PUBLIC"
    assert body["projection_version"] == "public-data-projection.v1"
    assert body["selection_version"] == 7
    assert body["request_id"] != "fixture-request-001"
    assert body["mode"] == "offline_fixture"
    assert body["real_trading_connected"] is False
    assert body["execution_binding"] == "NONE"
    assert body["items"][0]["data"]["last_price"] == "60000"
    assert len(service.calls) == 1


@pytest.mark.parametrize("quality", ["partial", "stale", "unavailable"])
def test_public_data_upstream_quality_is_not_replaced_with_demo(quality: str) -> None:
    service = FakeReadService("market_" + quality)
    with app_with_service(service) as client:
        response = client.get("/v1/data/markets", headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.json()["quality"] == quality
    if quality == "unavailable":
        assert response.json()["items"] == []
        assert response.json()["as_of_ms"] is None


@pytest.mark.parametrize("query", [
    "asset_ids=bitcoin,bitcoin", "asset_ids=WBTC", "selection_version=-1",
    "selection_version=1&selection_version=2", "url=https://example.com",
    "limit=51", "asset_ids=bitcoin&chain_id=56",
])
def test_public_data_bad_query_does_not_dispatch(query: str) -> None:
    service = FakeReadService()
    with app_with_service(service) as client:
        response = client.get("/v1/data/markets?" + query, headers={"Origin": ORIGIN})
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_QUERY"
    assert service.calls == []


def test_public_data_unconfigured_is_explicitly_unavailable() -> None:
    with app_with_service(None) as client:
        response = client.get("/v1/data/news", headers={"Origin": ORIGIN})
    assert response.status_code == 503
    assert response.json()["code"] == "DATA_SERVICE_UNAVAILABLE"


def test_public_data_origin_and_method_stay_restricted() -> None:
    service = FakeReadService()
    with app_with_service(service) as client:
        assert client.get("/v1/data/markets").status_code == 403
        assert client.post("/v1/data/markets", headers={"Origin": ORIGIN}).status_code == 405
        response = client.get(
            "/v1/data/markets",
            headers={"Origin": ORIGIN, "X-Forwarded-Host": "localhost"},
        )
        assert response.status_code == 400
    assert service.calls == []


def test_public_data_one_hundred_readers_share_one_fetch_and_keep_request_identity() -> None:
    service = FakeReadService()
    with app_with_service(service) as client:
        def read(index: int) -> dict[str, object]:
            response = client.get(
                f"/v1/data/markets?selection_version={index}", headers={"Origin": ORIGIN}
            )
            assert response.status_code == 200
            return response.json()

        with ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(read, range(100)))
    assert len(service.calls) == 1
    assert len({result["request_id"] for result in results}) == 100
    assert {result["selection_version"] for result in results} == set(range(100))
    assert all(result["as_of_ms"] == NOW - 1000 for result in results)


def test_public_data_expired_cache_keeps_source_time_and_marks_stale_on_failure() -> None:
    service = FakeReadService()
    current = [NOW]
    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True)
    app.state.public_data_clock = lambda: current[0]

    async def fetch(query: object) -> dict[str, object]:
        if service.calls:
            raise RuntimeError("secret upstream diagnostic must not escape")
        return await service.read(query)

    app.state.public_data_fetcher = fetch
    with TestClient(app) as client:
        first = client.get("/v1/data/markets", headers={"Origin": ORIGIN})
        assert first.status_code == 200
        current[0] += 60000
        second = client.get("/v1/data/markets", headers={"Origin": ORIGIN})
    assert second.status_code == 200
    assert second.json()["quality"] == "stale"
    assert second.json()["as_of_ms"] == NOW - 1000
    assert second.json()["items"][0]["quality"] == "stale"
    assert "secret upstream" not in second.text


def test_public_data_asset_filters_share_collection_and_filter_each_response() -> None:
    service = FakeReadService()
    with app_with_service(service) as client:
        bitcoin = client.get(
            "/v1/data/markets?asset_ids=bitcoin", headers={"Origin": ORIGIN}
        )
        ethereum = client.get(
            "/v1/data/markets?asset_ids=ethereum", headers={"Origin": ORIGIN}
        )
    assert bitcoin.status_code == ethereum.status_code == 200
    assert len(service.calls) == 1
    assert bitcoin.json()["items"][0]["subject_id"] == "bitcoin"
    assert ethereum.json()["items"] == []
    assert ethereum.json()["quality"] == "unavailable"
    assert ethereum.json()["coverage"]["requested_subjects"] == ["ethereum"]


def test_public_data_news_limits_share_one_collection() -> None:
    service = FakeReadService()
    with app_with_service(service) as client:
        for limit in (1, 5, 20, 50):
            response = client.get(
                f"/v1/data/news?limit={limit}", headers={"Origin": ORIGIN}
            )
            assert response.status_code == 200
    assert len(service.calls) == 1


def test_public_data_default_app_does_not_expand_frozen_routes() -> None:
    app = create_app(testing=True, web_local_origin=ORIGIN)
    with TestClient(app) as client:
        assert client.get("/v1/data/markets", headers={"Origin": ORIGIN}).status_code == 404
    assert not any(path.startswith("/v1/data/") for path in app.openapi()["paths"])


@pytest.mark.parametrize("quality", ["unavailable", "exception"])
def test_review_refresh_failure_preserves_last_good_snapshot(quality: str) -> None:
    service = FakeReadService()
    current = [NOW]

    async def fetch(query: object) -> dict[str, object]:
        if not service.calls:
            return await service.read(query)
        if quality == "exception":
            raise RuntimeError("private diagnostic")
        body = copy.deepcopy(PAYLOAD)
        body.update(quality="unavailable", items=[], as_of_ms=None)
        body["sources"][0].update(status="RATE_LIMITED", reason_code="UPSTREAM_RATE_LIMITED")
        return body

    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                     public_data_fetcher=fetch)
    app.state.public_data_clock = lambda: current[0]
    with TestClient(app) as client:
        first = client.get("/v1/data/markets?asset_ids=bitcoin", headers={"Origin": ORIGIN})
        current[0] += 60000
        second = client.get("/v1/data/markets?asset_ids=bitcoin", headers={"Origin": ORIGIN})
    assert first.status_code == second.status_code == 200
    assert second.json()["quality"] == "stale"
    assert second.json()["items"][0]["data"]["last_price"] == "60000"
    assert second.json()["as_of_ms"] == first.json()["as_of_ms"]
    assert second.json()["sources"][0]["status"] in {"RATE_LIMITED", "UNAVAILABLE"}


def test_review_filtered_quality_uses_selected_facts() -> None:
    service = FakeReadService("market_partial")
    eth = copy.deepcopy(service.payload["items"][0])
    eth.update(record_id="fixture:market:ethereum", subject_id="ethereum", quality="stale")
    eth["data"]["instrument"].update(symbol="ETHUSDT", base_asset="ETH")
    service.payload["items"].append(eth)
    with app_with_service(service) as client:
        eth_response = client.get("/v1/data/markets?asset_ids=ethereum", headers={"Origin": ORIGIN})
        btc_response = client.get("/v1/data/markets?asset_ids=bitcoin", headers={"Origin": ORIGIN})
    assert eth_response.json()["quality"] == "stale"
    assert btc_response.json()["quality"] == "fresh"


def test_review_full_retry_after_is_respected() -> None:
    service = FakeReadService("market_unavailable")
    service.payload["sources"][0].update(status="RATE_LIMITED", retry_after_seconds=7200)
    current = [NOW]
    client = app_with_service(service)
    client.app.state.public_data_clock = lambda: current[0]
    with client:
        assert client.get("/v1/data/markets", headers={"Origin": ORIGIN}).status_code == 200
        current[0] += 3600001
        assert client.get("/v1/data/markets", headers={"Origin": ORIGIN}).status_code == 200
    assert len(service.calls) == 1


def test_review_empty_news_requires_success_and_explicit_coverage() -> None:
    async def fetch(query: object) -> dict[str, object]:
        body = copy.deepcopy(PAYLOAD)
        body.update(items=[], sources=[], coverage={})
        return body

    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                     public_data_fetcher=fetch)
    app.state.public_data_clock = lambda: NOW
    with TestClient(app) as client:
        response = client.get("/v1/data/news", headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.json()["quality"] == "unavailable"


def test_review_past_validity_is_legal_for_stale_observation() -> None:
    service = FakeReadService("market_stale")
    service.payload["items"][0]["valid_until_ms"] = NOW - 1100
    with app_with_service(service) as client:
        response = client.get("/v1/data/markets?asset_ids=bitcoin", headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.json()["quality"] == "stale"
    assert response.json()["items"][0]["valid_until_ms"] == NOW - 1100



def test_readside_only_app_cannot_build_control_or_expose_mutations(monkeypatch) -> None:
    def forbidden(*args, **kwargs):
        raise AssertionError("read side must not initialize a Control database")

    monkeypatch.setattr("stark_trading_os.control.app.build_default_dependencies", forbidden)
    app = create_app(web_local_origin=ORIGIN, public_data_enabled=True, public_data_only=True)
    with TestClient(app) as client:
        assert client.get("/v1/data/news", headers={"Origin": ORIGIN}).status_code == 503
        assert client.post("/v1/backtests", headers={"Origin": ORIGIN}).status_code == 404
    assert app.state.allow_external_agent_review is False
    assert set(app.openapi()["paths"]) == {
        "/v1/data/markets", "/v1/data/assets", "/v1/data/news",
        "/v1/data/explorer/capabilities",
    }


def test_readside_resource_owner_closes_even_without_first_query() -> None:
    closed = []

    async def cleanup() -> None:
        closed.append(True)

    app = create_app(web_local_origin=ORIGIN, public_data_enabled=True, public_data_only=True,
                     public_data_cleanup=cleanup)
    with TestClient(app):
        pass
    assert closed == [True]



def test_actual_provider_dto_crosses_readside_without_execution_binding() -> None:
    import json

    from stark_trading_os.integrations.public_data import PublicDataProvider
    from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

    responses = tuple(HttpResponse(200, json.dumps({
        "symbol": symbol, "lastPrice": price, "volume": "10", "quoteVolume": "100000",
        "openTime": NOW - 86400000, "closeTime": NOW - 1000,
    }).encode()) for symbol, price in [
        ("BTCUSDT", "60000"), ("ETHUSDT", "3000"), ("SOLUSDT", "150"),
    ])
    transport = FixtureTransport(responses)
    provider = PublicDataProvider(market_transport=transport, clock_ms=lambda: NOW)
    closed = []

    async def cleanup() -> None:
        closed.append(True)

    app = create_app(web_local_origin=ORIGIN, public_data_enabled=True, public_data_only=True,
                     public_data_provider=provider, public_data_cleanup=cleanup)
    app.state.public_data_clock = lambda: NOW
    with TestClient(app) as client:
        body = client.get("/v1/data/markets?asset_ids=bitcoin", headers={"Origin": ORIGIN}).json()
    assert body["quality"] == "fresh"
    assert body["mode"] == "offline_fixture"
    assert body["items"][0]["data"]["instrument"]["symbol"] == "BTCUSDT"
    assert body["items"][0]["data"]["last_price"] == "60000"
    assert body["execution_binding"] == "NONE"
    assert transport.calls == 3
    assert closed == [True]


def test_persistent_app_four_gets_reopen_without_fetching(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    calls = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        return synthetic_payload(query.resource)

    def application(store: PublicDataStore):
        app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                         public_data_only=True, public_data_fetcher=fetch, public_data_store=store)
        app.state.public_data_clock = lambda: NOW
        return app

    bodies = {}
    first = PublicDataStore(path, mode="offline_fixture")
    with TestClient(application(first)) as client:
        for resource in RESOURCES:
            response = client.get(f"/v1/data/{resource}?selection_version=7",
                                  headers={"Origin": ORIGIN})
            assert response.status_code == 200
            bodies[resource] = response.json()
    with pytest.raises(PublicDataStoreError):
        first.load("news")
    second = PublicDataStore(path, mode="offline_fixture")
    with TestClient(application(second)) as client:
        for resource in RESOURCES:
            response = client.get(f"/v1/data/{resource}?selection_version=8",
                                  headers={"Origin": ORIGIN})
            assert response.status_code == 200
            body = response.json()
            assert body["selection_version"] == 8
            assert body["request_id"] != bodies[resource]["request_id"]
            for key in body.keys() - {"request_id", "selection_version"}:
                assert body[key] == bodies[resource][key]
        assert client.get("/v1/data/markets").status_code == 403
        assert client.post("/v1/data/news", headers={"Origin": ORIGIN}).status_code == 405
    assert len(calls) == 4
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM public_data_cache").fetchone()[0] == 4


@pytest.mark.parametrize("get_first", [False, True])
@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_persistent_app_is_unique_close_owner_even_when_cleanup_fails(
    tmp_path: Path, get_first: bool, cleanup_fails: bool,
) -> None:
    closes = []

    class CountingStore(PublicDataStore):
        def close(self) -> None:
            closes.append("store")
            super().close()

    async def fetch(query: PublicDataQuery) -> object:
        return synthetic_payload(query.resource)

    async def cleanup() -> None:
        closes.append("transport")
        if cleanup_fails:
            raise RuntimeError("synthetic cleanup failure")

    store = CountingStore(tmp_path / "public.sqlite", mode="offline_fixture")
    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                     public_data_only=True, public_data_fetcher=fetch, public_data_store=store,
                     public_data_cleanup=cleanup)
    app.state.public_data_clock = lambda: NOW

    def run() -> None:
        with TestClient(app) as client:
            if get_first:
                assert client.get("/v1/data/news", headers={"Origin": ORIGIN}).status_code == 200

    if cleanup_fails:
        with pytest.raises(RuntimeError, match="synthetic cleanup failure"):
            run()
    else:
        run()
    assert closes.count("store") == closes.count("transport") == 1
    with pytest.raises(PublicDataStoreError):
        store.load("news")


def test_persistent_http_write_failure_is_sanitized_503_not_success(tmp_path: Path) -> None:
    path = tmp_path / "synthetic-private-location.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    blocker = sqlite3.connect(path, check_same_thread=False, isolation_level=None)

    async def fetch(query: PublicDataQuery) -> object:
        blocker.execute("BEGIN IMMEDIATE")
        return synthetic_payload(query.resource)

    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                     public_data_only=True, public_data_fetcher=fetch, public_data_store=store)
    app.state.public_data_clock = lambda: NOW
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/data/markets?selection_version=9", headers={"Origin": ORIGIN}
            )
            assert response.status_code == 503
            body = response.json()
            assert body["code"] == "DATA_SERVICE_UNAVAILABLE"
            assert body["selection_version"] == 9 and body["retryable"] is True
            assert "synthetic-private" not in response.text
            assert "locked" not in response.text
    finally:
        blocker.rollback()
        blocker.close()
    reopened = PublicDataStore(path, mode="offline_fixture")
    assert reopened.load("markets") is None
    reopened.close()


def test_default_app_never_opens_public_store(monkeypatch) -> None:
    def forbidden(*args, **kwargs):
        raise AssertionError("default app must not open SQLite public store")

    monkeypatch.setattr(PublicDataStore, "__init__", forbidden)
    with TestClient(create_app(testing=True, web_local_origin=ORIGIN)) as client:
        assert client.get("/v1/data/news", headers={"Origin": ORIGIN}).status_code == 404


@pytest.mark.parametrize("stage", ["startup", "service_close"])
def test_persistent_store_closes_when_other_lifecycle_stages_fail(
    tmp_path: Path, stage: str,
) -> None:
    from stark_trading_os.control.public_data_service import PublicDataService

    events = []

    class CountingStore(PublicDataStore):
        def close(self) -> None:
            events.append("store")
            super().close()

    class FailingService(PublicDataService):
        async def close(self) -> None:
            await super().close()
            raise RuntimeError("synthetic lifecycle failure")

    def bad_factory():
        raise RuntimeError("synthetic lifecycle failure")

    async def fetch(query: PublicDataQuery) -> object:
        return synthetic_payload(query.resource)

    async def cleanup() -> None:
        events.append("transport")

    store = CountingStore(tmp_path / "public.sqlite", mode="offline_fixture")
    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                     dependency_factory=bad_factory if stage == "startup" else None,
                     public_data_store=store, public_data_cleanup=cleanup)
    if stage == "service_close":
        app.state.public_data_service = FailingService(fetch, store=store)
    with pytest.raises(RuntimeError, match="synthetic lifecycle failure"):
        with TestClient(app):
            pass
    assert events == ["transport", "store"]
    with pytest.raises(PublicDataStoreError):
        store.load("news")


def test_persistent_assembly_rejects_disabled_routes_and_provider_mode_mismatch(tmp_path: Path):
    from stark_trading_os.integrations.public_data import PublicDataProvider

    store = PublicDataStore(tmp_path / "public.sqlite", mode="offline_fixture")

    async def cleanup() -> None:
        pass

    with pytest.raises(ValueError, match="matching provider mode"):
        create_app(testing=True, public_data_store=store)
    with pytest.raises(ValueError, match="matching provider mode"):
        create_app(testing=True, public_data_enabled=True, public_data_store=store,
                   public_data_provider=PublicDataProvider(), public_data_cleanup=cleanup)
    # Ownership transfers only to a successfully assembled app lifespan.
    assert store.load("news") is None
    store.close()


def test_persistent_corruption_never_serves_memory_as_success(tmp_path: Path) -> None:
    path = tmp_path / "public.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    calls = []

    async def fetch(query: PublicDataQuery) -> object:
        calls.append(query)
        return synthetic_payload(query.resource)

    app = create_app(testing=True, web_local_origin=ORIGIN, public_data_enabled=True,
                     public_data_only=True, public_data_fetcher=fetch, public_data_store=store)
    app.state.public_data_clock = lambda: NOW
    with TestClient(app) as client:
        assert client.get("/v1/data/news", headers={"Origin": ORIGIN}).status_code == 200
        with sqlite3.connect(path) as db:
            db.execute("UPDATE public_data_cache SET last_good_json = "
                       "json_set(last_good_json, '$.as_of_ms', 'synthetic-private-diagnostic')")
        response = client.get("/v1/data/news", headers={"Origin": ORIGIN})
        assert response.status_code == 503
        assert response.json()["code"] == "DATA_SERVICE_UNAVAILABLE"
        assert "synthetic-private" not in response.text
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_binance_fallback_http_filters_keep_display_coverage_and_collection_gaps(
    tmp_path: Path,
) -> None:
    import json

    import httpx

    from stark_trading_os.control.public_data_service import PublicDataService
    from tests.unit.control.test_public_market_fallback import MarketScenario

    scenario = MarketScenario()
    path = tmp_path / "synthetic.sqlite"
    store = PublicDataStore(path, mode="offline_fixture")
    service = PublicDataService(scenario, store=store, snapshot_only=True,
                                clock_ms=lambda: scenario.now)
    envelopes = []
    try:
        original = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        scenario.now += 10000
        scenario.future = {"bitcoin": 63}
        merged = await service.collect("markets", interval_ms=10000, before_save=lambda _: None)
        await service.close()
        store.close()
        store = PublicDataStore(path, mode="offline_fixture")
        service = PublicDataService(scenario, store=store, snapshot_only=True,
                                    clock_ms=lambda: scenario.now)
        app = create_app(web_local_origin=ORIGIN, public_data_enabled=True, public_data_only=True)
        app.state.public_data_service = service
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver",
            headers={"Origin": ORIGIN},
        ) as client:
            for ids, quality, gaps in (
                (None, "partial", ["bitcoin"]), ("bitcoin", "stale", ["bitcoin"]),
                ("ethereum", "fresh", []),
            ):
                params = {"selection_version": "7"}
                if ids is not None:
                    params["asset_ids"] = ids
                response = await client.get("/v1/data/markets", params=params)
                assert response.status_code == 200
                body = response.json()
                assert body["quality"] == quality
                assert body["coverage"]["gaps"] == gaps
                subjects = [item["subject_id"] for item in body["items"]]
                # Actual consumer public-data-client.mjs:70 requires this equality.
                assert body["coverage"]["returned_subjects"] == subjects
                assert body["real_trading_connected"] is False
                assert body["execution_binding"] == "NONE"
                assert body["sources"] == [s.model_dump(mode="json") for s in merged.sources]
                if "bitcoin" in subjects:
                    btc = next(i for i in body["items"] if i["subject_id"] == "bitcoin")
                    assert btc == {**original.items[0].model_dump(mode="json"), "quality": "stale"}
                    assert body["missing_capabilities"] == ["market.statistics:bitcoin"]
                else:
                    assert body["missing_capabilities"] == []
                envelopes.append({"input": params, "body": body})
        assert scenario.calls == 6  # ALL reopened snapshot-only GETs made zero provider calls.
        (tmp_path / "synthetic-market-http-envelopes.json").write_text(json.dumps(envelopes))
    finally:
        await service.close()
        store.close()
