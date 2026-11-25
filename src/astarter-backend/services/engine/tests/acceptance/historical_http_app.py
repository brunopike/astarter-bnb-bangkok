"""Acceptance-only factory: production dependencies in a new synthetic runtime."""

import json
import os
from pathlib import Path

from stark_trading_os.catalog.historical_source import validate_historical_source
from stark_trading_os.control.app import create_app
from stark_trading_os.control.dependencies import build_default_dependencies
from stark_trading_os.domain.historical_input import SmaConfigurationInputV2
from tests.integration.catalog.test_historical_publication import _metadata_bytes


def create_historical_acceptance_app():
    repository = Path(__file__).resolve().parents[4]
    root = Path(os.environ["STARK_HISTORICAL_SMOKE_ROOT"])
    allowed = (repository / "var/acceptance").resolve()
    if not root.is_absolute() or not root.resolve().is_relative_to(allowed) or root.exists():
        raise RuntimeError("historical acceptance requires a new owned runtime")
    root.mkdir(mode=0o700)

    def dependencies():
        configured = build_default_dependencies(root)
        try:
            if configured.historical is not None:
                start, step = 1_700_000_000_000_000_000, 60_000_000_000
                closes = [100, 100, 100, 110, 100, 90]
                rows = ["open_time_ns,close_time_ns,available_time_ns,open,high,low,close,volume"]
                for index, close in enumerate(closes):
                    opened, ended = start + index * step, start + (index + 1) * step
                    rows.append(
                        f"{opened},{ended},{ended},{close}.00,{close}.00,"
                        f"{close}.00,{close}.00,100.000"
                    )
                raw = ("\n".join(rows) + "\n").encode()
                metadata = json.loads(_metadata_bytes(raw))
                metadata["source"]["retrieved_at_ns"] = str(start + len(closes) * step + 1)
                source = validate_historical_source(
                    raw, json.dumps(metadata).encode(), now_ns=start + len(closes) * step + 2
                )
                publication = configured.fixture_publisher.publish_historical(source)
                config = SmaConfigurationInputV2.model_validate(
                    dict(
                        name="HTTP acceptance SMA",
                        strategy_ref="sma-cross-long-flat@v1",
                        purpose="ENGINEERING_BASELINE",
                        catalog_revision=publication.catalog_revision,
                        parameters=dict(fast_period=2, slow_period=3, order_quantity="1"),
                        risk={
                            "schema": "SmaLocalRisk.v1",
                            "max_order_notional": "1000",
                            "max_position_quantity": "2",
                        },
                        execution_cost={
                            "schema": "HistoricalExecutionCost.v1",
                            "profile": "HISTORICAL_BAR_CLOSE_CASH_V1",
                            "starting_cash": "1000",
                            "maker_fee": "0.0002",
                            "taker_fee": "0.001",
                            "fee_source": "synthetic explicit assumption",
                            "fill_model": "NATIVE_BASE_FILL",
                            "latency": "ZERO",
                            "execution_timing": "CLOSED_BAR_NATIVE",
                            "random_seed_support": "UNSUPPORTED",
                        },
                    )
                )
                with (root / "seed.json").open("x") as file:
                    file.write(config.model_dump_json(by_alias=True))
            return configured
        except BaseException:
            configured.store.close()
            raise

    return create_app(
        testing=True,
        dependency_factory=dependencies,
        web_local_origin=os.environ["WEB_LOCAL_ORIGIN"],
    )
