"""S03 and legacy Astarter share the actual native precision boundary."""

import pytest
from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.domain.astarter_simulation import OrderCommand
from stark_trading_os.runner.astarter_simulation import _instrument, native_order


def test_profile_keeps_quote_fee_and_nonzero_step_contract():
    item = _instrument()
    assert str(item.id) == "BTC/USDT.SIM"
    assert str(item.price_increment) == "0.01" and str(item.size_increment) == "0.00001"
    assert item.price_precision == 2 and item.size_precision == 5
    assert item.quote_currency.precision == 8
    assert str(item.maker_fee) == str(item.taker_fee) == "0.001"


@pytest.mark.parametrize("role", ["ENTRY", "STOP"])
def test_shared_factory_cannot_round_off_grid_price_before_dispatch(role):
    strategy = Strategy(StrategyConfig(manage_stop=False))
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True, logging=LoggerConfig(bypass_logging=True), run_analysis=False
        )
    )
    try:
        engine.add_strategy(strategy)
        with pytest.raises(ValueError, match="ASTARTER_NATIVE_PRICE_ROUNDED"):
            native_order(
                strategy, _instrument(), OrderCommand("test-P", "test", role, "0.01", "100.001")
            )
    finally:
        engine.dispose()
