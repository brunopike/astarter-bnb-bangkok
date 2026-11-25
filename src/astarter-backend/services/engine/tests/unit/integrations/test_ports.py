"""Offline behavior at the provider/model boundary; no real secrets or inference."""

from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import FrozenInstanceError
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr, ValidationError

FIXTURES = Path(__file__).parents[2] / "fixtures" / "integrations"
NOW = 1700000002000


def data_body() -> bytes:
    return (FIXTURES / "binance_spot_ticker.json").read_bytes()


def model_body() -> dict[str, Any]:
    return json.loads((FIXTURES / "openrouter_research.json").read_bytes())


def instrument(**changes: Any) -> Any:
    from stark_trading_os.integrations.contracts import Instrument

    return Instrument(
        venue="BINANCE",
        market_kind=changes.pop("market_kind", "SPOT"),
        symbol="BTCUSDT",
        base_asset="BTC",
        quote_asset="USDT",
        **changes,
    )


def task(**changes: Any) -> Any:
    from stark_trading_os.integrations.contracts import Evidence, ResearchTask

    values = dict(
        task_id="task-1",
        role_id="A01",
        profile_version="local-v1",
        evidence=(
            Evidence(
                evidence_id="ticker-1",
                text="Synthetic BTC ticker",
                available_at_ms=NOW - 1,
                valid_until_ms=NOW + 10000,
            ),
        ),
    )
    return ResearchTask(**(values | changes))


def model_config(**changes: Any) -> Any:
    from stark_trading_os.integrations.openrouter import ModelConfig

    return ModelConfig(model="example/research-model", **changes)


def transport(body: bytes, status: int = 200, headers: tuple[Any, ...] = ()) -> Any:
    from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse

    return FixtureTransport((HttpResponse(status=status, body=body, headers=headers),))


@pytest.mark.asyncio
async def test_default_ports_have_no_environment_or_network_side_effects(monkeypatch: Any) -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    def forbidden(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("network attempted")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-environment-value")
    assert (await BinanceSpotTickerProvider().fetch_snapshot(instrument())).status == "UNCONFIGURED"
    assert (
        await OpenRouterModelPort(model_config()).generate_structured(task())
    ).status == "UNCONFIGURED"


@pytest.mark.asyncio
async def test_ticker_preserves_precision_identity_provenance_and_is_immutable() -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    provider = BinanceSpotTickerProvider(transport(data_body()), clock_ms=lambda: NOW)
    result = await provider.fetch_snapshot(instrument())
    assert result.status == "OK"
    assert result.snapshot.last_price == "65000.12000000"
    assert result.snapshot.base_volume == "12.34000000"
    assert result.snapshot.instrument.market_kind == "SPOT"
    assert result.provenance.purpose == "OFFLINE_FIXTURE"
    assert result.provenance.source_event_at_ms == 1700000000000
    assert result.provenance.available_at_ms == NOW
    assert result.provenance.timestamp_semantics == "STATISTICS_WINDOW_END"
    assert result.snapshot.executable is False
    assert len(result.provenance.raw_sha256) == 64
    with pytest.raises((ValidationError, FrozenInstanceError)):
        result.snapshot.last_price = "0"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        {"symbol": "ETHUSDT"},
        {"lastPrice": "NaN"},
        {"lastPrice": 65000.12},
        {"lastPrice": "-1"},
        {"volume": "-1"},
        {"closeTime": NOW + 1},
        {"openTime": NOW + 1},
        {"closeTime": True},
    ],
)
async def test_ticker_invalid_data_fails_closed(mutation: dict[str, Any]) -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    body = json.dumps(json.loads(data_body()) | mutation).encode()
    result = await BinanceSpotTickerProvider(transport(body), clock_ms=lambda: NOW).fetch_snapshot(
        instrument()
    )
    assert result.status == "INVALID_RESPONSE"
    assert result.snapshot is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,expected",
    [
        (b"{}", "MISSING"),
        (b"null", "INVALID_RESPONSE"),
        (b'[{"symbol":"BTCUSDT"}]', "INVALID_RESPONSE"),
        (b"oops", "INVALID_RESPONSE"),
        (b'{"symbol":"BTCUSDT","symbol":"ETHUSDT"}', "INVALID_RESPONSE"),
    ],
)
async def test_ticker_missing_malformed_or_duplicate_fields(body: bytes, expected: str) -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    result = await BinanceSpotTickerProvider(transport(body), clock_ms=lambda: NOW).fetch_snapshot(
        instrument()
    )
    assert result.status == expected
    assert result.snapshot is None


@pytest.mark.asyncio
async def test_wrong_market_never_calls_transport() -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    wire = transport(data_body())
    result = await BinanceSpotTickerProvider(wire).fetch_snapshot(instrument(market_kind="PERP"))
    assert result.status == "UNSUPPORTED"
    assert wire.calls == 0


@pytest.mark.asyncio
async def test_source_and_receipt_age_are_independently_checked() -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    result = await BinanceSpotTickerProvider(
        transport(data_body()), clock_ms=lambda: NOW
    ).fetch_snapshot(instrument())
    assert result.freshness_at(NOW, max_source_age_ms=1000, max_receipt_age_ms=5000) == "STALE"
    assert (
        result.freshness_at(NOW + 500, max_source_age_ms=10000, max_receipt_age_ms=100) == "STALE"
    )
    assert (
        result.freshness_at(NOW - 1, max_source_age_ms=10000, max_receipt_age_ms=10000)
        == "INVALID_RESPONSE"
    )
    assert result.freshness_at(NOW, max_source_age_ms=5000, max_receipt_age_ms=5000) == "OK"
    stale = await BinanceSpotTickerProvider(
        transport(data_body()), clock_ms=lambda: NOW + 60000
    ).fetch_snapshot(instrument())
    assert stale.status == "STALE"


@pytest.mark.asyncio
async def test_repeated_snapshot_has_stable_hash_no_fake_uniqueness() -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    a = await BinanceSpotTickerProvider(
        transport(data_body()), clock_ms=lambda: NOW
    ).fetch_snapshot(instrument())
    b = await BinanceSpotTickerProvider(
        transport(data_body()), clock_ms=lambda: NOW + 1
    ).fetch_snapshot(instrument())
    assert a.provenance.raw_sha256 == b.provenance.raw_sha256
    assert a.provenance.received_at_ms != b.provenance.received_at_ms


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["data", "model"])
async def test_rate_limit_preserves_retry_after_without_retries(kind: str) -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    wire = transport(b"upstream detail must not leak", 429, (("Retry-After", "12"),))
    result = await (
        BinanceSpotTickerProvider(wire).fetch_snapshot(instrument())
        if kind == "data"
        else OpenRouterModelPort(model_config(), wire, clock_ms=lambda: NOW).generate_structured(
            task()
        )
    )
    assert result.status == "RATE_LIMITED"
    assert result.retry_after_seconds == 12
    assert wire.calls == 1
    assert "upstream detail" not in repr(result)


@pytest.mark.asyncio
async def test_openrouter_strict_structure_and_reported_usage() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    wire = transport(json.dumps(model_body()).encode())
    result = await OpenRouterModelPort(
        model_config(), wire, clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "OK"
    assert result.output.stance == "WAIT"
    assert result.output.evidence_ids == ("ticker-1",)
    assert result.usage.input_tokens == 100
    assert result.usage.output_tokens == 30
    assert result.usage.cached_input_tokens == 20
    assert result.usage.reasoning_tokens == 10  # subset of output, not added a second time
    assert result.usage.cost_credits == "0.00012"
    assert result.purpose == "OFFLINE_FIXTURE"
    assert result.usage.status == "REPORTED"


@pytest.mark.asyncio
async def test_missing_usage_is_unknown_not_zero() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    body = model_body()
    del body["usage"]
    result = await OpenRouterModelPort(
        model_config(), transport(json.dumps(body).encode()), clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "OK"
    assert result.usage.status == "MISSING"
    assert result.usage.cost_credits is None
    assert result.usage.input_tokens is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        {"cost": float("nan")},
        {"cost": float("inf")},
        {"cost": -1},
        {"prompt_tokens": True},
        {"completion_tokens": -2},
        {"completion_tokens_details": {"reasoning_tokens": 31}},
        {"prompt_tokens_details": {"cached_tokens": 101}},
        {"total_tokens": 999},
    ],
)
async def test_invalid_usage_is_not_trusted(mutation: dict[str, Any]) -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    body = model_body()
    body["usage"].update(mutation)
    result = await OpenRouterModelPort(
        model_config(), transport(json.dumps(body).encode()), clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"
    assert result.output is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        {"finish_reason": "length"},
        {"finish_reason": "tool_calls"},
        {"message": {"content": "not JSON"}},
        {"message": {"content": '{"stance":"BUY","summary":"x","evidence_ids":["ticker-1"]}'}},
        {"message": {"content": '{"stance":"WAIT","summary":"x","evidence_ids":["invented"]}'}},
        {
            "message": {
                "content": '{"stance":"WAIT","summary":"x","evidence_ids":["ticker-1","ticker-1"]}'
            }
        },
        {"message": {"content": "{}", "refusal": "no"}},
        {"message": {"content": "{}", "tool_calls": [{"name": "execute"}]}},
    ],
)
async def test_model_response_rejected_but_usage_retained(mutation: dict[str, Any]) -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    body = model_body()
    body["choices"][0].update(mutation)
    result = await OpenRouterModelPort(
        model_config(), transport(json.dumps(body).encode()), clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"
    assert result.output is None
    assert result.usage.cost_credits == "0.00012"


@pytest.mark.asyncio
async def test_wrong_model_and_embedded_error_are_rejected() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    for mutation in ({"model": "other/model"}, {"error": {"code": 429, "message": "secret"}}):
        body = model_body() | mutation
        result = await OpenRouterModelPort(
            model_config(), transport(json.dumps(body).encode()), clock_ms=lambda: NOW
        ).generate_structured(task())
        assert result.status in {"INVALID_RESPONSE", "RATE_LIMITED"}
        assert result.output is None


@pytest.mark.asyncio
async def test_stale_or_duplicate_evidence_never_calls_model() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    wire = transport(json.dumps(model_body()).encode())
    result = await OpenRouterModelPort(
        model_config(), wire, clock_ms=lambda: NOW + 10000
    ).generate_structured(task())
    assert result.status == "STALE"
    assert wire.calls == 0
    with pytest.raises(ValidationError):
        task(evidence=(task().evidence[0], task().evidence[0]))


@pytest.mark.asyncio
async def test_timeout_is_bounded_and_does_not_repeat() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    class Slow:
        purpose = "OFFLINE_FIXTURE"
        calls = 0

        async def send(self, request: Any) -> Any:
            self.calls += 1
            await asyncio.Event().wait()

    wire = Slow()
    result = await OpenRouterModelPort(
        model_config(timeout_seconds=0.01), wire, clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "TIMEOUT"
    assert wire.calls == 1


@pytest.mark.asyncio
async def test_transport_exceptions_and_credentials_do_not_leak() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    class Broken:
        purpose = "EXTERNAL_OBSERVATION"

        async def send(self, request: Any) -> Any:
            assert "synthetic-test-credential" not in repr(request)
            raise RuntimeError("synthetic-test-credential")

    config = model_config(api_key=SecretStr("synthetic-test-credential"))
    assert "synthetic-test-credential" not in repr(config)
    result = await OpenRouterModelPort(config, Broken(), clock_ms=lambda: NOW).generate_structured(
        task()
    )
    assert result.status == "UNAVAILABLE"
    assert "synthetic-test-credential" not in repr(result)


@pytest.mark.asyncio
async def test_request_has_closed_schema_no_tools_and_no_credentials_in_prompt() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort
    from stark_trading_os.integrations.transport import HttpResponse

    class Capture:
        purpose = "OFFLINE_FIXTURE"

        async def send(self, request: Any) -> Any:
            body = json.loads(request.body)
            assert request.url == "https://openrouter.ai/api/v1/chat/completions"
            assert body["response_format"]["json_schema"]["strict"] is True
            assert body["provider"] == {"require_parameters": True, "allow_fallbacks": False}
            assert "tools" not in body
            assert "synthetic-test-credential" not in request.body.decode()
            assert request.headers == (("Content-Type", "application/json"),)
            return HttpResponse(status=200, body=json.dumps(model_body()).encode())

    result = await OpenRouterModelPort(
        model_config(api_key=SecretStr("synthetic-test-credential")),
        Capture(),
        clock_ms=lambda: NOW,
    ).generate_structured(task())
    assert result.status == "OK"


@pytest.mark.asyncio
async def test_demo_runs_entirely_with_synthetic_data() -> None:
    from stark_trading_os.integrations.demo import run_demo

    result = await run_demo()
    assert result["data_status"] == "OK"
    assert result["model_status"] == "OK"
    assert result["purpose"] == "OFFLINE_FIXTURE"
    assert result["execution_enabled"] is False
    assert Decimal(result["reported_fixture_cost_credits"]) > 0


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_cost", ["1e1000", "1e-1000"])
async def test_extreme_cost_exponent_is_rejected_before_expansion(raw_cost: str) -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    body = json.dumps(model_body()).replace('"cost": 0.00012', f'"cost": {raw_cost}').encode()
    result = await OpenRouterModelPort(
        model_config(), transport(body), clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"
    assert result.usage.status == "INVALID"


@pytest.mark.asyncio
@pytest.mark.parametrize("details", [[], False, ""])
async def test_malformed_usage_details_are_not_missing(details: Any) -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    body = model_body()
    body["usage"]["prompt_tokens_details"] = details
    result = await OpenRouterModelPort(
        model_config(), transport(json.dumps(body).encode()), clock_ms=lambda: NOW
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"


def test_data_contract_can_be_used_by_another_provider_and_rejects_mixed_identity() -> None:
    from stark_trading_os.integrations.contracts import DataResult

    result = DataResult(
        provider_id="other-spot-provider", instrument=instrument(), status="UNCONFIGURED"
    )
    assert result.provider_id == "other-spot-provider"
    with pytest.raises(ValidationError):
        DataResult(instrument=instrument(), status="OK")


@pytest.mark.asyncio
async def test_caller_cancellation_propagates_without_retry() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    started = asyncio.Event()

    class Blocked:
        purpose = "OFFLINE_FIXTURE"
        calls = 0

        async def send(self, request: Any) -> Any:
            self.calls += 1
            started.set()
            await asyncio.Event().wait()

    wire = Blocked()
    pending = asyncio.create_task(
        OpenRouterModelPort(model_config(), wire, clock_ms=lambda: NOW).generate_structured(task())
    )
    await started.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert wire.calls == 1


@pytest.mark.asyncio
async def test_retry_after_http_date_and_bad_header() -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider

    for value, expected in (("Tue, 14 Nov 2023 22:13:32 GMT", 10.0), ("NaN", None), ("-2", None)):
        wire = transport(b"{}", 503, (("retry-after", value),))
        result = await BinanceSpotTickerProvider(wire, clock_ms=lambda: NOW).fetch_snapshot(
            instrument()
        )
        assert result.status == "UNAVAILABLE"
        assert result.retry_after_seconds == expected
        assert wire.calls == 1


@pytest.mark.asyncio
async def test_evidence_expiring_during_generation_does_not_return_success() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    now = [NOW]
    from stark_trading_os.integrations.transport import HttpResponse

    class Delayed:
        purpose = "OFFLINE_FIXTURE"

        async def send(self, request: Any) -> Any:
            now[0] = NOW + 10000
            return HttpResponse(200, json.dumps(model_body()).encode())

    result = await OpenRouterModelPort(
        model_config(), Delayed(), clock_ms=lambda: now[0]
    ).generate_structured(task())
    assert result.status == "STALE"
    assert result.output is None
    assert result.usage.cost_credits == "0.00012"


@pytest.mark.asyncio
async def test_provider_metadata_cannot_echo_a_configured_credential() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    body = model_body() | {"provider": "synthetic-test-credential"}
    result = await OpenRouterModelPort(
        model_config(api_key=SecretStr("synthetic-test-credential")),
        transport(json.dumps(body).encode()),
        clock_ms=lambda: NOW,
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"
    assert "synthetic-test-credential" not in result.model_dump_json()
    assert result.usage.cost_credits == "0.00012"


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ["partial", "all"])
async def test_review_h1_decoded_output_rejects_escaped_credential(encoding: str) -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    probe = "synthetic-probe-credential"
    escaped = (
        ("\\u0073" + probe[1:])
        if encoding == "partial"
        else "".join(f"\\u{ord(character):04x}" for character in probe)
    )
    content = json.dumps({"stance": "WAIT", "summary": probe, "evidence_ids": ["ticker-1"]})
    content = content.replace(probe, escaped)
    assert probe not in content
    body = model_body()
    body["choices"][0]["message"]["content"] = content
    wire = transport(json.dumps(body).encode())
    result = await OpenRouterModelPort(
        model_config(api_key=SecretStr(probe)),
        wire,
        clock_ms=lambda: NOW,
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"
    assert result.output is None
    assert probe not in result.model_dump_json()
    assert result.usage.cost_credits == "0.00012"
    assert wire.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("location", ["task_id", "profile_version", "evidence_id", "text"])
async def test_review_h1_sensitive_input_has_safe_rejection_before_transport(location: str) -> None:
    from stark_trading_os.integrations.contracts import Evidence
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    probe = "synthetic-probe-credential"
    wire = transport(json.dumps(model_body()).encode())
    if location in {"task_id", "profile_version"}:
        request = task(**{location: probe})
    else:
        evidence = Evidence(**(task().evidence[0].model_dump() | {location: probe}))
        request = task(evidence=(evidence,))
    with pytest.raises(ValueError, match="^SENSITIVE_INPUT_REJECTED$") as caught:
        await OpenRouterModelPort(
            model_config(api_key=SecretStr(probe)),
            wire,
            clock_ms=lambda: NOW,
        ).generate_structured(request)
    assert probe not in str(caught.value)
    assert wire.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["data", "model"])
async def test_review_m1_decimal_constructor_overflow_is_a_safe_invalid_response(kind: str) -> None:
    from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort

    wire = transport(b'{"unexpected":1e9999999999999999999}')
    if kind == "data":
        result = await BinanceSpotTickerProvider(wire, clock_ms=lambda: NOW).fetch_snapshot(
            instrument()
        )
        assert result.snapshot is None
    else:
        result = await OpenRouterModelPort(
            model_config(), wire, clock_ms=lambda: NOW
        ).generate_structured(task())
        assert result.output is None
    assert result.status == "INVALID_RESPONSE"
    assert wire.calls == 1


def successful_result_fields() -> dict[str, Any]:
    from stark_trading_os.integrations.contracts import ResearchOutput

    return dict(
        task_id="task-1",
        role_id="A01",
        profile_version="local-v1",
        requested_model="example/research-model",
        status="OK",
        purpose="OFFLINE_FIXTURE",
        started_at_ms=NOW,
        completed_at_ms=NOW,
        attempts=1,
        output=ResearchOutput(stance="WAIT", summary="synthetic", evidence_ids=("ticker-1",)),
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"output": None},
        {"purpose": None},
        {"attempts": 0},
        {"status": "UNAUTHORIZED"},
        {"completed_at_ms": NOW - 1},
        {"role_id": "not-a-role"},
    ],
)
def test_review_m2_contradictory_results_are_rejected(changes: dict[str, Any]) -> None:
    from stark_trading_os.integrations.contracts import ModelResult

    with pytest.raises(ValidationError):
        ModelResult(**(successful_result_fields() | changes))


@pytest.mark.parametrize(
    "changes",
    [
        {"purpose": None},
        {"status": "UNCONFIGURED"},
        {"status": "UNSUPPORTED"},
        {"attempts": 0},
    ],
)
def test_review_m2_failed_attempt_metadata_is_consistent(changes: dict[str, Any]) -> None:
    from stark_trading_os.integrations.contracts import ModelResult, Usage

    values = successful_result_fields() | {
        "status": "INVALID_RESPONSE",
        "output": None,
        "response_id": "gen-synthetic-001",
        "usage": Usage(status="REPORTED", cost_credits="0.00012"),
    }
    with pytest.raises(ValidationError):
        ModelResult(**(values | changes))


def test_review_m2_valid_early_rejection_and_failed_billed_attempt_remain_supported() -> None:
    from stark_trading_os.integrations.contracts import ModelResult, Usage

    values = successful_result_fields() | {"status": "INVALID_RESPONSE", "output": None}
    assert (
        ModelResult(
            **values, usage=Usage(status="REPORTED", cost_credits="0.00012")
        ).usage.cost_credits
        == "0.00012"
    )
    early = values | {"attempts": 0, "status": "STALE"}
    assert ModelResult(**early).usage.cost_credits is None
    assert ModelResult(**(early | {"purpose": None, "status": "UNCONFIGURED"})).attempts == 0


@pytest.mark.asyncio
async def test_review_m2_clock_regression_returns_invalid_with_ordered_completion() -> None:
    from stark_trading_os.integrations.openrouter import OpenRouterModelPort
    from stark_trading_os.integrations.transport import HttpResponse

    now = [NOW]

    class RegressingClock:
        purpose = "OFFLINE_FIXTURE"

        async def send(self, request: Any) -> Any:
            now[0] = NOW - 1
            return HttpResponse(200, json.dumps(model_body()).encode())

    result = await OpenRouterModelPort(
        model_config(),
        RegressingClock(),
        clock_ms=lambda: now[0],
    ).generate_structured(task())
    assert result.status == "INVALID_RESPONSE"
    assert result.output is None
    assert result.completed_at_ms >= result.started_at_ms
    assert result.usage.cost_credits == "0.00012"
