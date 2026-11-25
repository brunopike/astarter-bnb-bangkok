"""Native source setup only; all business operations use production services."""

from contextlib import contextmanager
from decimal import Decimal
from typing import Any, cast

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.execution import MakerTakerFeeModel
from nautilus_trader.model import AccountType, BookType, Money, OmsType, Price, Quantity, QuoteTick
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.runner.astarter_facts import NativeFactsSource
from tests.compat.astarter_native_fixture import instrument


class IdleStrategy(Strategy):
    def __new__(cls, **kwargs):
        return cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False))

    def __init__(self, *, engine, item):
        super().__init__(StrategyConfig(manage_stop=False))
        self.engine, self.item, self.source = engine, item, None
        self.source_error = None

    def on_start(self):
        self.subscribe_quotes(self.item.id)

    def on_quote(self, quote):
        if self.source is None:
            try:
                self.source = NativeFactsSource(self.item, self)
            except Exception as error:
                self.source_error = error


@contextmanager
def native_source():
    item = instrument()
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True, run_analysis=False, logging=LoggerConfig(bypass_logging=True)
        )
    )
    strategy = IdleStrategy(engine=engine, item=item)
    try:
        engine.add_venue(
            venue=item.id.venue,
            oms_type=OmsType.NETTING,
            account_type=AccountType.CASH,
            base_currency=None,
            starting_balances=[
                Money.zero(item.base_currency),
                Money.from_decimal(Decimal("10000"), item.quote_currency),
            ],
            fee_model=MakerTakerFeeModel(),
            book_type=BookType.L1_MBP,
            routing=False,
            use_random_ids=False,
            use_reduce_only=False,
            bar_execution=False,
            trade_execution=False,
            allow_cash_borrowing=False,
        )
        engine.add_instrument(item)
        engine.add_strategy(strategy)
        engine.add_data(
            [
                QuoteTick(
                    item.id,
                    Price.from_str("59999.00"),
                    Price.from_str("60000.00"),
                    Quantity.from_str("10.00000"),
                    Quantity.from_str("10.00000"),
                    1_700_000_000_000_000_000,
                    1_700_000_000_000_000_000,
                )
            ]
        )
        engine.run()
        if strategy.source_error is not None:
            raise strategy.source_error
        assert strategy.source is not None
        yield strategy.source
    finally:
        if strategy.source is not None:
            strategy.source.close()
        strategy.engine = None  # break test-only strategy→engine→strategy on its owner
        engine.dispose()
