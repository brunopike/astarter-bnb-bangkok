from nautilus_trader.backtest import (
    BacktestDataConfig,
    BacktestEngineConfig,
    BacktestNode,
    BacktestRunConfig,
    BacktestVenueConfig,
)
from nautilus_trader.persistence import ParquetDataCatalog
from nautilus_trader.trading import ImportableStrategyConfig, Strategy, StrategyConfig
from rc3_fixture import create_fixture_catalog


def test_locked_rc3_surface() -> None:
    import nautilus_trader

    assert nautilus_trader.__version__ == "2.0.0rc3"
    assert callable(BacktestNode)
    assert callable(ParquetDataCatalog)
    assert all(
        callable(symbol)
        for symbol in (
            BacktestDataConfig,
            BacktestEngineConfig,
            BacktestRunConfig,
            BacktestVenueConfig,
            ImportableStrategyConfig,
            Strategy,
            StrategyConfig,
        )
    )


def test_clean_room_catalog_round_trips_quote_ticks(tmp_path) -> None:
    fixture = create_fixture_catalog(tmp_path)
    catalog = ParquetDataCatalog(str(fixture.catalog_path))

    assert catalog.instruments() == [fixture.instrument]
    assert catalog.query_quote_ticks(identifiers=[fixture.instrument.id.value]) == list(
        fixture.quotes,
    )
