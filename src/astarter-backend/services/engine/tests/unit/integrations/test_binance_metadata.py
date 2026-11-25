import asyncio
import hashlib
import json
from importlib import import_module, util
from pathlib import Path

import pytest

from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

FIXTURES = Path(__file__).parents[2] / "fixtures" / "data-model-ports-t2"
T0 = 1_700_000_000_000_000_000
TTL = 300_000_000_000


def api():
    name = "stark_trading_os.integrations.binance_metadata"
    assert util.find_spec(name), "T2 metadata provider is missing"
    return import_module(name)


def query(**changes):
    m = import_module("stark_trading_os.integrations.instrument_metadata")
    return m.InstrumentQuery(
        **(
            dict(
                venue="BINANCE",
                market="SPOT",
                symbol="BTCUSDT",
                expected_base="BTC",
                expected_quote="USDT",
            )
            | changes
        )
    )


def body():
    return json.loads((FIXTURES / "btcusdt-exchange-info.v1.json").read_text())


def parse(data=None, **changes):
    m = api()
    args = dict(
        query=query(),
        received_at_ns=T0,
        available_at_ns=T0 + 1,
        receipt_id="receipt-1",
        source_policy_id="offline-test",
        source_policy_revision="v1",
    )
    return m.parse_metadata(
        json.dumps(body() if data is None else data).encode(), **(args | changes)
    )


def test_metadata_normalizes_and_binds_separate_receipt():
    result = parse()
    assert result.status == "OK"
    assert result.facts.lot.step.canonical == "0.00001"
    assert result.facts.price.tick.canonical == "0.1"
    assert result.facts.price.tick.raw == "0.10000000"
    assert result.receipt.timestamp_semantics == "METADATA_OBSERVATION"
    assert result.receipt.facts_revision == result.facts.revision()


def test_delayed_processing_is_stale_with_real_availability():
    result = parse(available_at_ns=T0 + TTL)
    assert result.status == "STALE"
    assert result.receipt.available_at_ns == T0 + TTL


def test_source_identity_does_not_follow_callers_concatenation():
    result = parse(query=query(expected_base="BTCU", expected_quote="SDT"))
    assert result.status == "INVALID_RESPONSE"
    assert result.facts is None


@pytest.mark.parametrize(
    "mutation",
    [
        "duplicate_symbol",
        "duplicate_filter",
        "bad_numeric",
        "numeric_json",
        "wrong_flag",
        "bad_precision",
        "too_many_filters",
        "inverted_bounds",
    ],
)
def test_invalid_source_is_closed_failure(mutation):
    data = body()
    symbol = data["symbols"][0]
    if mutation == "duplicate_symbol":
        data["symbols"].append(symbol.copy())
    if mutation == "duplicate_filter":
        symbol["filters"].append(symbol["filters"][0].copy())
    if mutation == "bad_numeric":
        symbol["filters"][0]["tickSize"] = "1e-8"
    if mutation == "numeric_json":
        symbol["filters"][0]["tickSize"] = 1
    if mutation == "wrong_flag":
        symbol["isSpotTradingAllowed"] = 1
    if mutation == "bad_precision":
        symbol["quotePrecision"] = True
    if mutation == "too_many_filters":
        symbol["filters"] *= 30
    if mutation == "inverted_bounds":
        symbol["filters"][0]["maxPrice"] = "0.01"
    result = parse(data)
    assert result.status == "INVALID_RESPONSE"
    assert result.facts is None and result.receipt is None


def test_unknown_rule_and_unknown_rule_field_are_observable_not_supported():
    data = body()
    data["symbols"][0]["filters"].append({"filterType": "FUTURE_RULE", "newLimit": "1"})
    result = parse(data)
    assert result.status == "OK"
    assert result.facts.unsupported
    data = body()
    data["symbols"][0]["filters"][0]["newSafetyRule"] = True
    assert parse(data).facts.unsupported


def test_semantic_revision_ignores_known_decimal_padding_but_receipt_does_not():
    first = parse()
    data = body()
    data["symbols"][0]["filters"][0]["tickSize"] = "0.1"
    second = parse(data, receipt_id="receipt-2")
    assert first.facts.revision() == second.facts.revision()
    assert first.receipt.raw_sha256 != second.receipt.raw_sha256
    data["symbols"][0]["filters"][0]["tickSize"] = "0.2"
    assert parse(data).facts.revision() != first.facts.revision()


def test_unknown_content_is_in_facts_revision():
    data = body()
    data["symbols"][0]["newExecutionRule"] = 1
    first = parse(data)
    data["symbols"][0]["newExecutionRule"] = 2
    assert parse(data).facts.revision() != first.facts.revision()


@pytest.mark.asyncio
async def test_default_provider_has_no_environment_or_network(monkeypatch):
    import socket

    m = api()

    def forbidden(*args, **kwargs):
        raise AssertionError("network")

    monkeypatch.setattr(socket, "socket", forbidden)
    assert (await m.BinanceMetadataProvider().fetch(query())).status == "UNCONFIGURED"


@pytest.mark.asyncio
async def test_provider_dispatches_one_fixed_request_and_records_processing_time():
    m = api()

    class Wire:
        purpose = "OFFLINE_FIXTURE"
        calls = 0

        async def send(self, request):
            self.calls += 1
            assert request.url == "https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT"
            assert request.method == "GET" and not request.headers and not request.body
            return HttpResponse(200, json.dumps(body()).encode())

    wire = Wire()
    times = iter([T0, T0 + TTL + 1])
    result = await m.BinanceMetadataProvider(
        wire,
        clock_ns=lambda: next(times),
        source_policy_id="offline-test",
        source_policy_revision="v1",
    ).fetch(query())
    assert wire.calls == 1 and result.status == "STALE"
    assert result.receipt.expires_at_ns == T0 + TTL


@pytest.mark.asyncio
async def test_duplicate_json_and_external_transport_never_become_usable():
    m = api()
    wire = FixtureTransport((HttpResponse(200, b'{"symbols":[],"symbols":[]}'),))
    p = m.BinanceMetadataProvider(wire, clock_ns=lambda: T0)
    assert (await p.fetch(query())).status == "INVALID_RESPONSE"
    wire.purpose = "EXTERNAL_OBSERVATION"
    assert (await p.fetch(query())).status == "UNSUPPORTED"
    assert wire.calls == 1


@pytest.mark.asyncio
async def test_cancellation_is_not_an_empty_opportunity():
    m = api()

    class Wire:
        purpose = "OFFLINE_FIXTURE"

        async def send(self, request):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await m.BinanceMetadataProvider(Wire()).fetch(query())


@pytest.mark.asyncio
async def test_rate_limit_has_no_payload_and_no_retry():
    m = api()
    wire = FixtureTransport((HttpResponse(429, b"ignored", (("Retry-After", "2"),)),))
    result = await m.BinanceMetadataProvider(wire, clock_ns=lambda: T0).fetch(query())
    assert result.status == "RATE_LIMITED" and result.retry_after_seconds == 2
    assert result.facts is None and wire.calls == 1


def test_fixture_manifest_hashes_are_full_and_match():
    manifest = json.loads((FIXTURES / "manifest.v1.json").read_text())
    for item in manifest["files"]:
        assert hashlib.sha256((FIXTURES / item["path"]).read_bytes()).hexdigest() == item["sha256"]


@pytest.mark.asyncio
async def test_invalid_query_exception_has_no_untrusted_input_echo():
    m = api()
    bad = query().model_copy(update={"symbol": "untrusted input sentinel"})
    with pytest.raises(ValueError) as error:
        await m.BinanceMetadataProvider().fetch(bad)
    assert str(error.value) == "METADATA_INPUT_INVALID"


def test_permission_groups_are_not_flattened():
    data = body()
    data["symbols"][0]["permissionSets"] = [["SPOT"], ["GROUP_A", "GROUP_B"]]
    assert parse(data).facts.permission_sets == (("SPOT",), ("GROUP_A", "GROUP_B"))


def test_intersecting_notional_bounds_and_conflict():
    data = body()
    data["symbols"][0]["filters"].append(
        {
            "filterType": "MIN_NOTIONAL",
            "minNotional": "10",
            "applyToMarket": False,
            "avgPriceMins": 5,
        }
    )
    assert parse(data).status == "OK"
    data["symbols"][0]["filters"][2]["maxNotional"] = "9"
    assert parse(data).status == "INVALID_RESPONSE"


def test_duplicate_exchange_filters_and_unknown_exchange_rule():
    data = body()
    data["exchangeFilters"] = [{"filterType": "EXCHANGE_MAX_NUM_ORDERS", "maxNumOrders": 3}]
    assert parse(data).facts.rules[-1].category == "DYNAMIC"
    data["exchangeFilters"] *= 2
    assert parse(data).status == "INVALID_RESPONSE"
    data["exchangeFilters"] = [{"filterType": "EXCHANGE_FUTURE", "value": 1}]
    assert parse(data).facts.unsupported


@pytest.mark.parametrize("value", ["9" * 65, "1." + "0" * 127, "0.00000x"])
def test_parser_does_not_relax_decimal_boundary(value):
    data = body()
    data["symbols"][0]["filters"][0]["tickSize"] = value
    assert parse(data).status == "INVALID_RESPONSE"


def test_stale_observation_cannot_be_relabelled_ok():
    from stark_trading_os.integrations.instrument_metadata import MetadataResult, checked

    result = parse(available_at_ns=T0 + TTL + 1)
    with pytest.raises(ValueError):
        checked(MetadataResult, result.model_copy(update={"status": "OK"}))
