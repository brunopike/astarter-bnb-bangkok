"""Synthetic published input and exact-profile engine harness for the SMA component."""

import json
from hashlib import sha256
from pathlib import Path

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.model import Money
from nautilus_trader.persistence import ParquetDataCatalog
from nautilus_trader.risk import RiskEngineConfig

from stark_trading_os.audit.historical_input import configuration_bytes, input_manifest_bytes
from stark_trading_os.catalog.historical_source import validate_historical_source
from stark_trading_os.domain.historical_input import InputManifestV2, SmaConfigurationInputV2
from stark_trading_os.runner.historical_cost import (
    build_historical_execution_profile,
    historical_cost_bytes,
)
from stark_trading_os.runner.historical_sma import HistoricalSmaStrategy
from tests.integration.catalog.test_historical_publication import _metadata_bytes, _publisher
from tests.unit.audit.test_historical_input_codec import manifest_for


def prepare_sma_case(
    tmp_path: Path,
    closes: list[int],
    *,
    cash: str = "1000",
    quantity: str = "1",
    max_notional: str = "1000",
    max_position: str = "2",
    volume: str = "100.000",
):
    start, period = 1_700_000_000_000_000_000, 60_000_000_000
    rows = ["open_time_ns,close_time_ns,available_time_ns,open,high,low,close,volume"]
    for i, close in enumerate(closes):
        opened, ended = start + i * period, start + (i + 1) * period
        rows.append(
            f"{opened},{ended},{ended},{close}.00,{close}.00,{close}.00,{close}.00,{volume}"
        )
    raw = ("\n".join(rows) + "\n").encode()
    metadata = json.loads(_metadata_bytes(raw))
    metadata["source"]["retrieved_at_ns"] = str(start + len(closes) * period + 1)
    source = validate_historical_source(
        raw, json.dumps(metadata).encode(), now_ns=start + len(closes) * period + 2
    )
    publisher, store = _publisher(tmp_path)
    try:
        publication = publisher.publish_historical(source)
        publisher.revalidate(publication.catalog_revision)
        directory = tmp_path / "runtime/catalogs" / publication.catalog_revision
        catalog_raw = (directory / "catalog-manifest.json").read_bytes()
        reader = ParquetDataCatalog(str(directory.resolve()))
        (instrument,) = reader.instruments()
        bars = reader.query_bars()
    finally:
        store.close()
    payload = manifest_for(catalog_raw).model_dump(mode="json", by_alias=True)
    config = payload["configuration"]["configuration"]
    config["parameters"] = dict(fast_period=2, slow_period=3, order_quantity=quantity)
    config["risk"].update(max_order_notional=max_notional, max_position_quantity=max_position)
    config["execution_cost"]["starting_cash"] = cash
    model = SmaConfigurationInputV2.model_validate(config)
    payload["configuration_content_sha256"] = sha256(configuration_bytes(model)).hexdigest()
    payload["cost_sha256"] = sha256(historical_cost_bytes(model.execution_cost)).hexdigest()
    fingerprint = json.loads(catalog_raw)["inventory"]["native_fingerprint"]
    for field in (
        "python_version",
        "platform_system",
        "platform_machine",
        "native_extension_sha256",
    ):
        payload["runtime"][field] = fingerprint[field]
    manifest = InputManifestV2.model_validate(payload)
    input_raw = input_manifest_bytes(manifest)
    return instrument, bars, catalog_raw, input_raw, model


def execute_sma_case(
    prepared, *, strategy_class=HistoricalSmaStrategy, after_run=None, native_order_cap=None
):
    instrument, bars, catalog_raw, input_raw, config = prepared
    before = instrument.to_dict()
    profile = build_historical_execution_profile(instrument, config.execution_cost)
    strategy = strategy_class(
        input_bytes=input_raw,
        expected_input_sha256=sha256(input_raw).hexdigest(),
        catalog_manifest_bytes=catalog_raw,
        bars=bars,
    )
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True,
            run_analysis=False,
            logging=LoggerConfig(bypass_logging=True),
            risk_engine=RiskEngineConfig(
                max_notional_per_order=(
                    {} if native_order_cap is None else {str(instrument.id): native_order_cap}
                )
            ),
        )
    )
    try:
        flags = {
            name: getattr(profile, name)
            for name in (
                "oms_type",
                "account_type",
                "fill_model",
                "fee_model",
                "latency_model",
                "book_type",
                "routing",
                "use_position_ids",
                "use_random_ids",
                "use_reduce_only",
                "use_market_order_acks",
                "bar_execution",
                "bar_adaptive_high_low_ordering",
                "trade_execution",
                "liquidity_consumption",
                "allow_cash_borrowing",
            )
        }
        engine.add_venue(
            venue=instrument.id.venue,
            base_currency=None,
            starting_balances=[
                Money.zero(instrument.base_currency),
                profile.starting_quote_balance,
            ],
            **flags,
        )
        engine.add_instrument(profile.instrument)
        engine.add_strategy(strategy)
        engine.add_data(bars)
        engine.run()
        if after_run:
            after_run(strategy, engine)
        result = strategy.finalize_component()
        result["native_orders"] = (
            engine.generate_orders_report().reset_index().to_dict(orient="records")
        )
        result["native_fills"] = (
            engine.generate_fills_report().reset_index().to_dict(orient="records")
        )
        result["source_unchanged"] = instrument.to_dict() == before
        return result
    finally:
        engine.dispose()
