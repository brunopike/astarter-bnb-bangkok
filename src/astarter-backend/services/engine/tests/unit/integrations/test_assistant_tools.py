"""B1a contract/fixture checks; no runtime, credentials or database."""

import importlib
import importlib.util
import socket
from typing import Any, Literal

import pytest

from stark_trading_os.integrations.contracts import DataResult, Instrument

MODULE = "stark_trading_os.integrations.assistant_tools"


def btc(**changes: Any) -> Instrument:
    return Instrument(
        **(
            {
                "venue": "BINANCE",
                "market_kind": "SPOT",
                "symbol": "BTCUSDT",
                "base_asset": "BTC",
                "quote_asset": "USDT",
            }
            | changes
        )
    )


def test_contract_module_exists() -> None:
    assert importlib.util.find_spec(MODULE) is not None, "B1a contract is missing"


@pytest.fixture
def api() -> Any:
    return importlib.import_module(MODULE)


def test_catalog_is_closed_and_default_disabled(api: Any) -> None:
    entries = api.tool_capabilities()
    assert tuple(x.capability for x in entries) == ("market", "account", "onchain", "plan")
    assert all(x.provider_id == "binance-agent-os" and not x.enabled for x in entries)
    assert all(x.state == "unavailable" and x.verified_at_ms is None for x in entries)
    assert all(x.granted_scopes == () and not x.execution_authorized for x in entries)
    assert entries[0].supported and not any(x.supported for x in entries[1:])


def test_explicit_fixture_never_claims_live_connection(api: Any) -> None:
    entries = api.tool_capabilities(enabled=True)
    assert entries[0].enabled and entries[0].state == "not_connected"
    assert entries[0].transport == "fixture"
    assert entries[0].reason_code == "OFFLINE_FIXTURE_ONLY"
    assert all(not x.enabled and x.state == "unavailable" for x in entries[1:])


@pytest.mark.parametrize("enabled", [1, 0, "true", None])
def test_config_does_not_coerce_enabled(api: Any, enabled: Any) -> None:
    with pytest.raises(ValueError, match="ASSISTANT_TOOLS_CONFIGURATION"):
        api.tool_capabilities(enabled=enabled)


@pytest.mark.parametrize(
    "extra",
    [
        {"scope": "Trade"},
        {"token": "synthetic-secret-never-echo"},
        {"enabled": True},
        {"tool": "place_order"},
        {"url": "https://example.invalid"},
        {"payer": "platform"},
        {"question": "not the B1a research HTTP body"},
        {"account_binding_id": "another-account"},
    ],
)
def test_request_rejects_extra_authority_and_arbitrary_tools(api: Any, extra: Any) -> None:
    with pytest.raises(ValueError) as caught:
        api.FixtureToolRequest(
            request_id="request-1", capability="market", instrument=btc(), **extra
        )
    assert "synthetic-secret-never-echo" not in str(caught.value)


@pytest.mark.parametrize("capability", ["trade", "transfer", "withdraw", "sign", "MARKET", 1])
def test_unknown_capability_is_not_a_tool_dispatch(api: Any, capability: Any) -> None:
    with pytest.raises(ValueError):
        api.FixtureToolRequest(request_id="request-1", capability=capability)


@pytest.mark.parametrize(
    "change",
    [
        {"venue": "OKX"},
        {"market_kind": "PERP"},
        {"symbol": "ETHUSDT", "base_asset": "ETH"},
        {"symbol": "BTCUSD", "quote_asset": "USD"},
    ],
)
def test_only_exact_registered_btc_spot_fixture_is_supported(api: Any, change: Any) -> None:
    with pytest.raises(ValueError):
        api.FixtureToolRequest(
            request_id="request-1", capability="market", instrument=btc(**change)
        )
    with pytest.raises(ValueError):
        api.FixtureToolRequest(request_id="request-1", capability="market")


@pytest.mark.parametrize("capability", ["account", "onchain", "plan"])
def test_unimplemented_capabilities_cannot_carry_market_data(api: Any, capability: str) -> None:
    with pytest.raises(ValueError):
        api.FixtureToolRequest(request_id="request-1", capability=capability, instrument=btc())


@pytest.mark.parametrize(
    "change",
    [
        {"state": "ready"},
        {"verified_at_ms": 1700000002000},
        {"transport": "mcp"},
        {"granted_scopes": ("Account",)},
        {"execution_authorized": True},
        {"execution_authorized": 0},
        {"purpose": "EXTERNAL_OBSERVATION"},
    ],
)
def test_fixture_catalog_cannot_be_upgraded_to_live(api: Any, change: Any) -> None:
    item = api.tool_capabilities(enabled=True)[0].model_dump()
    with pytest.raises(ValueError):
        api.ToolCapability.model_validate(item | change)


@pytest.mark.asyncio
async def test_default_stub_and_private_tasks_never_read_transport(api: Any) -> None:
    from tests.stubs.assistant_tools import AssistantToolsStub

    stub = AssistantToolsStub()
    result = await stub.run(
        api.FixtureToolRequest(request_id="disabled", capability="market", instrument=btc())
    )
    assert result.data is None and result.capability.state == "unavailable"
    assert stub.fixture_calls == 0
    enabled = AssistantToolsStub(enabled=True)
    for cap in ("account", "onchain", "plan"):
        result = await enabled.run(api.FixtureToolRequest(request_id="unsupported", capability=cap))
        assert result.data is None and result.capability.reason_code == "NOT_IMPLEMENTED"
    assert enabled.fixture_calls == 0


@pytest.mark.asyncio
async def test_btc_source_precision_and_original_times_are_fixture_only(
    api: Any, monkeypatch: Any
) -> None:
    from tests.stubs.assistant_tools import RECEIVED_AT_MS, AssistantToolsStub

    def forbidden(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("NETWORK_OR_DNS_ATTEMPT")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    stub = AssistantToolsStub(enabled=True)
    request = api.FixtureToolRequest(
        request_id="btc-fixture", capability="market", instrument=btc()
    )
    result = await stub.run(request)
    assert stub.fixture_calls == 1 and result.data.status == "OK"
    assert result.data.provider_id == "astarter-fixture-btc-spot-v1"
    assert result.data.provenance.provider_id == result.data.provider_id
    assert result.data.provenance.purpose == "OFFLINE_FIXTURE"
    assert result.data.provenance.received_at_ms == RECEIVED_AT_MS
    assert result.data.snapshot.last_price == "65000.12000000"
    assert result.data.snapshot.base_volume == "12.34000000"
    assert result.data.snapshot.instrument == btc()
    assert not result.execution_authorized and result.capability.state == "not_connected"
    late = await stub.run(request, now_ms=RECEIVED_AT_MS + 5001)
    assert late.data.status == "STALE"
    assert late.data.provenance == result.data.provenance
    assert late.data.snapshot == result.data.snapshot
    assert late.valid_until_ms == result.valid_until_ms == RECEIVED_AT_MS + 5001


@pytest.mark.asyncio
async def test_projection_rejects_external_or_forged_payloads(api: Any) -> None:
    from tests.stubs.assistant_tools import RECEIVED_AT_MS, AssistantToolsStub

    req = api.FixtureToolRequest(request_id="btc", capability="market", instrument=btc())
    response = await AssistantToolsStub(enabled=True).run(req)
    data = response.data.model_dump()
    data["provenance"]["purpose"] = "EXTERNAL_OBSERVATION"
    with pytest.raises(ValueError):
        api.project_fixture_result(req, DataResult.model_validate(data), now_ms=RECEIVED_AT_MS)
    forged = response.model_copy(update={"execution_authorized": True})
    with pytest.raises(ValueError):
        api.FixtureToolResponse.model_validate(forged)


def test_failure_metadata_is_preserved_without_retry_or_live_evidence(api: Any) -> None:
    request = api.FixtureToolRequest(request_id="limited", capability="market", instrument=btc())
    data = DataResult(instrument=btc(), status="RATE_LIMITED", retry_after_seconds=60.0)
    with pytest.raises(ValueError, match="DENIED"):
        api.project_fixture_result(request, data, now_ms=1700000002000)
    data = DataResult(
        provider_id=api.SOURCE_ID, instrument=btc(), status="RATE_LIMITED", retry_after_seconds=60.0
    )
    result = api.project_fixture_result(request, data, now_ms=1700000002000)
    assert result.data.status == "RATE_LIMITED" and result.data.retry_after_seconds == 60
    assert result.data.snapshot is None and result.data.provenance is None
    assert result.valid_until_ms is None and result.capability.state == "not_connected"


@pytest.mark.asyncio
async def test_consumption_clock_cannot_make_future_fixture_fresh(api: Any) -> None:
    from tests.stubs.assistant_tools import RECEIVED_AT_MS, AssistantToolsStub

    stub = AssistantToolsStub(enabled=True)
    req = api.FixtureToolRequest(request_id="clock", capability="market", instrument=btc())
    response = await stub.run(req, now_ms=RECEIVED_AT_MS - 1)
    assert response.data.status == "INVALID_RESPONSE"
    assert response.data.snapshot is None and response.data.provenance is None
    assert response.valid_until_ms is None
    with pytest.raises(ValueError):
        await stub.run(req, now_ms=True)


@pytest.mark.asyncio
async def test_expiry_boundary_and_raw_hash_survive_reuse(api: Any) -> None:
    from tests.stubs.assistant_tools import RECEIVED_AT_MS, AssistantToolsStub

    req = api.FixtureToolRequest(request_id="age", capability="market", instrument=btc())
    stub = AssistantToolsStub(enabled=True)
    fresh = await stub.run(req, now_ms=RECEIVED_AT_MS + 5000)
    stale = await stub.run(req, now_ms=RECEIVED_AT_MS + 5001)
    assert fresh.data.status == "OK" and stale.data.status == "STALE"
    assert fresh.data.provenance.raw_sha256 == stale.data.provenance.raw_sha256
    assert fresh.data.snapshot == stale.data.snapshot
    assert fresh.valid_until_ms == stale.valid_until_ms


@pytest.mark.asyncio
async def test_forged_request_rejected_before_fixture_transport(api: Any) -> None:
    from tests.stubs.assistant_tools import AssistantToolsStub

    stub = AssistantToolsStub(enabled=True)
    req = api.FixtureToolRequest(request_id="forged", capability="market", instrument=btc())
    for change in (
        {"purpose": "EXTERNAL_OBSERVATION"},
        {"execution_authorized": True},
        {"instrument": btc(venue="OKX")},
        {"capability": "trade"},
    ):
        with pytest.raises(ValueError):
            await stub.run(req.model_copy(update=change))
    assert stub.fixture_calls == 0


@pytest.mark.parametrize("status", ["INVALID_RESPONSE", "RATE_LIMITED"])
def test_original_failure_retry_interval_survives(
    api: Any, status: Literal["INVALID_RESPONSE", "RATE_LIMITED"]
) -> None:
    req = api.FixtureToolRequest(request_id="retry-metadata", capability="market", instrument=btc())
    failed = DataResult(
        provider_id=api.SOURCE_ID, instrument=btc(), status=status, retry_after_seconds=60.25
    )
    result = api.project_fixture_result(req, failed, now_ms=1700000002000)
    assert result.data == failed
    assert result.valid_until_ms is None


@pytest.mark.asyncio
async def test_clock_rejection_keeps_retry_hint_but_strips_unusable_data(api: Any) -> None:
    from tests.stubs.assistant_tools import RECEIVED_AT_MS, AssistantToolsStub

    req = api.FixtureToolRequest(request_id="clock-retry", capability="market", instrument=btc())
    source = await AssistantToolsStub(enabled=True).run(req)
    assert source.data is not None
    hinted = DataResult.model_validate(source.data.model_dump() | {"retry_after_seconds": 60.25})
    result = api.project_fixture_result(req, hinted, now_ms=RECEIVED_AT_MS - 1)
    assert result.data.status == "INVALID_RESPONSE"
    assert result.data.retry_after_seconds == 60.25
    assert result.data.snapshot is None and result.data.provenance is None
    assert result.valid_until_ms is None
