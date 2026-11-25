"""Run `python -m stark_trading_os.integrations.demo`; entirely synthetic and offline."""

from __future__ import annotations

import asyncio
import json

from stark_trading_os.integrations.binance import BinanceSpotTickerProvider
from stark_trading_os.integrations.contracts import Evidence, Instrument, ResearchTask
from stark_trading_os.integrations.openrouter import ModelConfig, OpenRouterModelPort
from stark_trading_os.integrations.transport import FixtureTransport, HttpResponse


async def run_demo() -> dict[str, object]:
    now = 1700000002000
    ticker = {
        "symbol": "BTCUSDT",
        "lastPrice": "65000.12000000",
        "volume": "12.34000000",
        "quoteVolume": "802101.48080000",
        "openTime": 1699913600000,
        "closeTime": 1700000000000,
    }
    provider = BinanceSpotTickerProvider(
        FixtureTransport((HttpResponse(200, json.dumps(ticker).encode()),)),
        clock_ms=lambda: now,
    )
    data = await provider.fetch_snapshot(
        Instrument(
            venue="BINANCE",
            market_kind="SPOT",
            symbol="BTCUSDT",
            base_asset="BTC",
            quote_asset="USDT",
        )
    )
    if data.status != "OK" or data.provenance is None:
        return {"data_status": data.status, "model_status": "NOT_CALLED"}
    evidence_id = f"sha256:{data.provenance.raw_sha256}"
    model_payload = {
        "id": "gen-synthetic-demo",
        "model": "example/research-model",
        "provider": "SyntheticProvider",
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "content": json.dumps(
                        {
                            "stance": "WAIT",
                            "summary": "Synthetic ticker only; wait.",
                            "evidence_ids": [evidence_id],
                        }
                    ),
                },
            }
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 30,
            "total_tokens": 130,
            "cost": 0.00012,
        },
    }
    port = OpenRouterModelPort(
        ModelConfig(model="example/research-model"),
        FixtureTransport((HttpResponse(200, json.dumps(model_payload).encode()),)),
        clock_ms=lambda: now,
    )
    research = await port.generate_structured(
        ResearchTask(
            task_id="synthetic-demo",
            role_id="A01",
            profile_version="local-v1",
            evidence=(
                Evidence(
                    evidence_id=evidence_id,
                    text=data.model_dump_json(),
                    available_at_ms=now,
                    valid_until_ms=now + 10000,
                ),
            ),
        )
    )
    return {
        "purpose": "OFFLINE_FIXTURE",
        "data_status": data.status,
        "model_status": research.status,
        "stance": research.output.stance if research.output else None,
        "reported_fixture_cost_credits": research.usage.cost_credits,
        "execution_enabled": False,
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run_demo()), ensure_ascii=False, indent=2))
