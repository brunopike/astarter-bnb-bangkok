"""Node-default-fill report boundary; not the approved historical fill profile."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from nautilus_trader.backtest import (
    BacktestDataConfig,
    BacktestEngineConfig,
    BacktestNode,
    BacktestResult,
    BacktestRunConfig,
    BacktestVenueConfig,
)
from nautilus_trader.common import LoggerConfig
from nautilus_trader.config import PortfolioConfig
from nautilus_trader.model import (
    AggregationSource,
    BarAggregation,
    BarSpecification,
    BarType,
    CurrencyPair,
    InstrumentId,
    PriceType,
    Quantity,
)
from nautilus_trader.persistence import ParquetDataCatalog
from nautilus_trader.trading import ImportableStrategyConfig, StrategyConfig

from stark_trading_os.runner.historical_cost import (
    HistoricalExecutionCostV1,
    build_historical_execution_profile,
)
from tests.compat.rc3_bar_fixture import (
    _BarCaseConfig,
    _BarCaseStrategy,
    _bars,
    _instrument,
)


class CashReportProbeConfig(StrategyConfig):
    def __new__(cls, *args: Any, **kwargs: Any) -> CashReportProbeConfig:
        for field in ("instrument_id", "bar_type", "sell_on_second"):
            kwargs.pop(field, None)
        return super().__new__(cls, *args, **kwargs)

    def __init__(
        self, instrument_id: str, bar_type: str, sell_on_second: bool, **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self.instrument_id = instrument_id
        self.bar_type = bar_type
        self.sell_on_second = sell_on_second


class CashReportProbeStrategy(_BarCaseStrategy):
    def __init__(self, config: CashReportProbeConfig) -> None:
        super().__init__(
            _BarCaseConfig(
                instrument_id=InstrumentId.from_str(config.instrument_id),
                bar_type=BarType.from_str(config.bar_type),
                quantity=Quantity.from_str("1.000"),
                sell_on_second=config.sell_on_second,
                observations=[],
            )
        )


@dataclass(frozen=True)
class CashNodeCase:
    node: BacktestNode
    run_config_id: str
    result: BacktestResult
    source_root: Path
    source_hashes: dict[str, str]


def catalog_file_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


@contextmanager
def cash_node_case(
    tmp_path: Path, *, taker_fee: str = "0.001", sell_on_second: bool = False
) -> Iterator[CashNodeCase]:
    source_root = tmp_path / "source"
    runtime_root = tmp_path / "run-local-cost-catalog"
    source_root.mkdir()
    runtime_root.mkdir()
    values = _instrument().to_dict()
    values.update(maker_fee="0", taker_fee="0")
    instrument = CurrencyPair.from_dict(values)
    bar_type = BarType(
        instrument.id,
        BarSpecification(1, BarAggregation.MINUTE, PriceType.LAST),
        AggregationSource.EXTERNAL,
    )
    bars = _bars(bar_type)
    source = ParquetDataCatalog(str(source_root))
    source.write_instruments([instrument])
    source.write_bars(bars)
    before = catalog_file_hashes(source_root)
    cost = HistoricalExecutionCostV1.model_validate(
        {
            "schema": "HistoricalExecutionCost.v1",
            "profile": "HISTORICAL_BAR_CLOSE_CASH_V1",
            "starting_cash": "1000",
            "maker_fee": "0.0002",
            "taker_fee": taker_fee,
            "fee_source": "synthetic explicit assumption",
            "fill_model": "NATIVE_BASE_FILL",
            "latency": "ZERO",
            "execution_timing": "CLOSED_BAR_NATIVE",
            "random_seed_support": "UNSUPPORTED",
        }
    )
    profile = build_historical_execution_profile(source.instruments()[0], cost)
    runtime = ParquetDataCatalog(str(runtime_root))
    runtime.write_instruments([profile.instrument])
    runtime.write_bars(source.query_bars())
    config = BacktestRunConfig(
        venues=[
            BacktestVenueConfig(
                name="SIM",
                oms_type=profile.oms_type,
                account_type=profile.account_type,
                book_type=profile.book_type,
                starting_balances=["0 ETH", str(profile.starting_quote_balance)],
                base_currency=None,
                # Node rejects the historical base FillModel instance. Its native
                # default is used ONLY to characterize the separate report boundary.
                fill_model=None,
                fee_model=profile.fee_model,
                latency_model=profile.latency_model,
                routing=profile.routing,
                use_random_ids=profile.use_random_ids,
                use_position_ids=profile.use_position_ids,
                use_reduce_only=profile.use_reduce_only,
                use_market_order_acks=profile.use_market_order_acks,
                bar_execution=profile.bar_execution,
                bar_adaptive_high_low_ordering=profile.bar_adaptive_high_low_ordering,
                trade_execution=profile.trade_execution,
                liquidity_consumption=profile.liquidity_consumption,
                allow_cash_borrowing=profile.allow_cash_borrowing,
            )
        ],
        data=[
            BacktestDataConfig(
                data_type="Bar", catalog_path=str(runtime_root), bar_types=[str(bar_type)]
            )
        ],
        engine=BacktestEngineConfig(
            bypass_logging=True,
            run_analysis=True,
            logging=LoggerConfig(bypass_logging=True),
            portfolio=PortfolioConfig(
                bar_updates=True, equity_curve=True, convert_to_account_base_currency=True
            ),
        ),
        id="cash-report-probe",
        raise_exception=True,
        dispose_on_completion=False,
    )
    node = BacktestNode([config])
    try:
        node.build()
        node.add_strategy_from_config(
            config.id,
            ImportableStrategyConfig(
                strategy_path="tests.compat.rc3_cash_node_fixture:CashReportProbeStrategy",
                config_path="tests.compat.rc3_cash_node_fixture:CashReportProbeConfig",
                config={
                    "instrument_id": str(instrument.id),
                    "bar_type": str(bar_type),
                    "sell_on_second": sell_on_second,
                },
            ),
        )
        results = node.run()
        assert len(results) == 1
        yield CashNodeCase(node, config.id, results[0], source_root, before)
    finally:
        node.dispose()
