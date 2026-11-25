"""In-process ASGI fixture BFF checks, never an actual connector/server."""

import importlib
import importlib.util
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest

from stark_trading_os.control.app import create_app
from stark_trading_os.integrations.assistant_tools import (
    SOURCE_ID,
    FixtureToolRequest,
    FixtureToolResponse,
    tool_capabilities,
)
from stark_trading_os.integrations.contracts import DataResult, Instrument
from tests.stubs.assistant_tools import RECEIVED_AT_MS, AssistantToolsStub

ORIGIN = "http://127.0.0.1:4188"


def test_readside_module_exists() -> None:
    assert importlib.util.find_spec("stark_trading_os.control.assistant_tools") is not None


async def snapshot() -> FixtureToolResponse:
    return await AssistantToolsStub(enabled=True).run(
        FixtureToolRequest(
            request_id="snapshot-only",
            capability="market",
            instrument=Instrument(
                venue="BINANCE",
                market_kind="SPOT",
                symbol="BTCUSDT",
                base_asset="BTC",
                quote_asset="USDT",
            ),
        )
    )


def reader(value: FixtureToolResponse | None, clock: Any = None) -> Any:
    module = importlib.import_module("stark_trading_os.control.assistant_tools")
    return module.AssistantFixtureReadSide(value, clock_ms=clock or (lambda: RECEIVED_AT_MS))


def app(value: Any) -> Any:
    return create_app(
        testing=True,
        web_local_origin=ORIGIN,
        public_data_only=True,
        public_data_enabled=True,
        assistant_fixture=value,
    )


@asynccontextmanager
async def client(application: Any) -> Any:
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://test",
            headers={"Origin": ORIGIN},
        ) as c:
            yield c


@pytest.mark.asyncio
async def test_default_app_does_not_register_assistant_or_research_routes() -> None:
    application = create_app(
        testing=True, web_local_origin=ORIGIN, public_data_only=True, public_data_enabled=True
    )
    async with client(application) as c:
        assert (await c.get("/v1/assistant/tool-providers")).status_code == 404
        assert (await c.get("/v1/data/markets")).status_code == 503
        assert (await c.post("/v1/assistant/research-jobs", json={})).status_code == 404


@pytest.mark.asyncio
async def test_capabilities_are_public_fixture_only_and_do_not_claim_live_ready() -> None:
    async with client(app(reader(await snapshot()))) as c:
        response = await c.get("/v1/assistant/tool-providers")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    result = response.json()
    assert result["schema_version"] == "AstarterAssistantToolProviders.v1"
    assert result["purpose"] == "OFFLINE_FIXTURE" and result["tenant_scope"] == "PUBLIC"
    assert result["execution_authorized"] is False
    caps = result["capabilities"]
    assert [x["capability"] for x in caps] == ["market", "account", "onchain", "plan"]
    assert caps[0]["state"] == "not_connected" and caps[0]["data_status"] == "OK"
    assert caps[0]["source_id"] == SOURCE_ID and caps[0]["data_age_ms"] == 2000
    assert caps[0]["coverage"]["returned_subjects"] == ["bitcoin"]
    assert caps[0]["next_action"] == "USE_FIXTURE_ONLY"
    assert all(
        x["verified_at_ms"] is None
        and x["granted_scopes"] == []
        and x["account_binding_id"] is None
        for x in caps
    )
    assert all(not x["enabled"] and x["data_status"] == "UNSUPPORTED" for x in caps[1:])


@pytest.mark.asyncio
async def test_market_snapshot_uses_existing_schema_precision_and_original_times() -> None:
    original = await snapshot()
    async with client(app(reader(original))) as c:
        response = await c.get("/v1/data/markets?asset_ids=bitcoin&selection_version=7")
        again = await c.get("/v1/data/markets?asset_ids=bitcoin&selection_version=8")
    result = response.json()
    assert response.status_code == 200 and result["schema_version"] == "AstarterPublicData.v1"
    assert result["mode"] == "offline_fixture" and result["tenant_scope"] == "PUBLIC"
    assert result["real_trading_connected"] is False and result["execution_binding"] == "NONE"
    assert result["selection_version"] == 7 and result["quality"] == "fresh"
    item = result["items"][0]
    assert item["provider_id"] == result["sources"][0]["provider_id"] == SOURCE_ID
    assert item["data"]["last_price"] == "65000.12000000"
    assert item["data"]["base_volume"] == "12.34000000"
    assert item["event_time_ms"] == 1700000000000
    assert item["received_at_ms"] == item["available_at_ms"] == result["as_of_ms"] == RECEIVED_AT_MS
    assert again.json()["items"] == result["items"]
    assert again.json()["request_id"] != result["request_id"]


@pytest.mark.asyncio
async def test_default_and_filtered_coverage_never_invent_other_assets() -> None:
    async with client(app(reader(await snapshot()))) as c:
        all_assets = (await c.get("/v1/data/markets")).json()
        missing = (await c.get("/v1/data/markets?asset_ids=ethereum")).json()
    assert all_assets["quality"] == "partial"
    assert all_assets["coverage"]["returned_subjects"] == ["bitcoin"]
    assert all_assets["coverage"]["gaps"] == ["ethereum", "solana"]
    assert missing["quality"] == "unavailable" and missing["as_of_ms"] is None
    assert missing["items"] == [] and missing["coverage"]["gaps"] == ["ethereum"]


@pytest.mark.asyncio
async def test_snapshot_expiry_is_exclusive_and_never_advances_source_time() -> None:
    now = [RECEIVED_AT_MS + 5000]
    async with client(app(reader(await snapshot(), lambda: now[0]))) as c:
        fresh = (await c.get("/v1/data/markets?asset_ids=bitcoin")).json()
        now[0] += 1
        stale = (await c.get("/v1/data/markets?asset_ids=bitcoin")).json()
        catalog = (await c.get("/v1/assistant/tool-providers")).json()
        now[0] = RECEIVED_AT_MS - 1
        invalid = (await c.get("/v1/data/markets?asset_ids=bitcoin")).json()
    assert fresh["quality"] == "fresh" and stale["quality"] == "stale"
    assert fresh["as_of_ms"] == stale["as_of_ms"] == RECEIVED_AT_MS
    assert fresh["items"][0]["data"] == stale["items"][0]["data"]
    assert catalog["capabilities"][0]["data_status"] == "STALE"
    assert catalog["capabilities"][0]["state"] == "not_connected"
    assert invalid["quality"] == "unavailable" and invalid["items"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["RATE_LIMITED", "TIMEOUT", "INVALID_RESPONSE"])
async def test_failed_snapshot_preserves_retry_hint_and_is_not_an_empty_success(
    status: Any,
) -> None:
    original = await snapshot()
    failed = FixtureToolResponse(
        request_id="failed",
        capability=tool_capabilities(enabled=True)[0],
        checked_at_ms=RECEIVED_AT_MS,
        data=DataResult(
            provider_id=SOURCE_ID,
            instrument=original.data.instrument,
            status=status,
            retry_after_seconds=60.25,
        ),
    )
    async with client(app(reader(failed))) as c:
        result = (await c.get("/v1/data/markets?asset_ids=bitcoin")).json()
        catalog = (await c.get("/v1/assistant/tool-providers")).json()
    assert result["quality"] == "unavailable" and result["items"] == []
    assert result["sources"][0]["status"] == status
    assert result["sources"][0]["retry_after_seconds"] == 60.25
    assert catalog["capabilities"][0]["retry_after_seconds"] == 60.25


@pytest.mark.asyncio
async def test_unconfigured_and_other_public_resources_do_not_dispatch() -> None:
    async with client(app(reader(None))) as c:
        result = (await c.get("/v1/data/markets?asset_ids=bitcoin")).json()
        caps = (await c.get("/v1/assistant/tool-providers")).json()["capabilities"]
    assert result["quality"] == "unavailable" and caps[0]["enabled"] is False
    async with client(app(reader(await snapshot()))) as c:
        for path in ("/v1/data/assets", "/v1/data/news", "/v1/data/explorer/capabilities"):
            response = await c.get(path)
            assert response.status_code == 200 and response.json()["quality"] == "unavailable"
        for path in (
            "/v1/assistant/research-jobs",
            "/v1/strategy-references/plans",
            "/v1/agent/run-review",
            "/v1/backtests",
        ):
            assert (await c.post(path, json={})).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/v1/assistant/tool-providers", "/v1/data/markets"])
async def test_origin_and_methods_are_not_relaxed(path: str) -> None:
    async with client(app(reader(await snapshot()))) as c:
        assert (await c.get(path, headers={"Origin": "https://evil.invalid"})).status_code == 403
        assert (await c.get(path, headers={"X-Forwarded-Host": "evil.invalid"})).status_code == 400
        assert (await c.post(path, json={"enabled": True})).status_code == 405


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query",
    [
        "account_binding_id=private",
        "enabled=true",
        "scope=Trade",
        "url=https://example.invalid",
        "capability=trade",
    ],
)
async def test_queries_cannot_override_fixture_authority(query: str) -> None:
    async with client(app(reader(await snapshot()))) as c:
        for path in ("/v1/assistant/tool-providers", "/v1/data/markets"):
            result = await c.get(path + "?" + query)
            assert result.status_code == 400
            assert "example.invalid" not in result.text


@pytest.mark.asyncio
async def test_assembly_rejects_mixed_owners_and_normal_control_mode() -> None:
    value = reader(await snapshot())
    for key in (
        "public_data_fetcher",
        "public_data_provider",
        "public_data_store",
        "public_data_cleanup",
        "public_data_runtime",
        "strategy_reference_runtime",
        "dependency_factory",
    ):
        with pytest.raises(ValueError, match="ASSISTANT_FIXTURE_CONFIGURATION"):
            create_app(
                testing=True,
                web_local_origin=ORIGIN,
                public_data_only=True,
                public_data_enabled=True,
                assistant_fixture=value,
                **{key: object()},
            )
    for flags in (
        {},
        {"public_data_only": True},
        {"public_data_enabled": True},
        {"public_data_enabled": 1, "public_data_only": True},
    ):
        with pytest.raises(ValueError, match="ASSISTANT_FIXTURE_CONFIGURATION"):
            create_app(testing=True, web_local_origin=ORIGIN, assistant_fixture=value, **flags)


@pytest.mark.asyncio
async def test_snapshot_is_copied_and_forged_or_private_objects_are_rejected() -> None:
    original = await snapshot()
    value = reader(original)
    original.data.__dict__["provider_id"] = "evil"
    async with client(app(value)) as c:
        assert (await c.get("/v1/data/markets?asset_ids=bitcoin")).json()["items"][0][
            "provider_id"
        ] == SOURCE_ID
    for change in ({"execution_authorized": True}, {"purpose": "EXTERNAL_OBSERVATION"}):
        with pytest.raises(ValueError):
            reader((await snapshot()).model_copy(update=change))


@pytest.mark.asyncio
async def test_gets_never_fetch_open_database_read_credentials_or_start_control(
    monkeypatch: Any,
) -> None:
    import asyncio
    import socket
    import sqlite3

    import stark_trading_os.control.app as app_module
    from stark_trading_os.control.dependencies import ApiCommandScheduler
    from stark_trading_os.integrations.transport import FixtureTransport

    value = reader(await snapshot())
    attempts = []

    def forbidden(*args: Any, **kwargs: Any) -> None:
        attempts.append("FORBIDDEN_IO")
        raise AssertionError("B1B_IO_ATTEMPT")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    monkeypatch.setattr(app_module, "build_default_dependencies", forbidden)
    monkeypatch.setattr(ApiCommandScheduler, "start", forbidden)
    monkeypatch.setattr(FixtureTransport, "send", forbidden)
    async with client(app(value)) as c:
        results = await asyncio.gather(
            *[
                c.get(path)
                for path in (
                    "/v1/data/markets?asset_ids=bitcoin",
                    "/v1/assistant/tool-providers",
                )
                * 4
            ]
        )
        assert all(x.status_code == 200 for x in results)
        assert len({x.json()["request_id"] for x in results}) == 8
    assert attempts == []


@pytest.mark.asyncio
async def test_clock_failures_return_fixed_errors_without_sensitive_details() -> None:
    def clock() -> int:
        raise RuntimeError("synthetic-private-detail-must-not-echo")

    async with client(app(reader(await snapshot(), clock))) as c:
        for path in ("/v1/assistant/tool-providers", "/v1/data/markets"):
            result = await c.get(path)
            assert result.status_code == 500
            assert "synthetic-private-detail" not in result.text
