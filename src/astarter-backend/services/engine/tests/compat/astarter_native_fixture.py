"""Actual pinned native quote/IOC/stop capability harness; test use only."""

from decimal import Decimal
from typing import Any, cast

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.execution import FillModel, MakerTakerFeeModel, StaticLatencyModel
from nautilus_trader.model import (
    AccountType,
    BookType,
    ClientOrderId,
    CurrencyPair,
    Money,
    OmsType,
    OrderFilled,
    OrderSide,
    Price,
    Quantity,
    QuoteTick,
    TimeInForce,
    TriggerType,
)
from nautilus_trader.trading import Strategy, StrategyConfig

from tests.compat.rc3_bar_fixture import _instrument


def text(value):
    raw = format(value, "f")
    return raw.rstrip("0").rstrip(".") if "." in raw else raw


def instrument():
    fields = _instrument().to_dict()
    fields.update(
        id="BTC/USDT.SIM",
        raw_symbol="BTC/USDT",
        base_currency="BTC",
        size_precision=5,
        size_increment="0.00001",
        lot_size="0.00001",
        min_quantity="0.00001",
        maker_fee="0.001",
        taker_fee="0.001",
    )
    return CurrencyPair.from_dict(fields)


class NativeCase(Strategy):
    def __new__(cls, **kwargs):
        return cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False))

    def __init__(self, *, case_instrument, mode):
        super().__init__(StrategyConfig(manage_stop=False))
        self.instrument = case_instrument
        self.mode = mode
        self.result = dict(
            errors=[],
            fills=[],
            accepted_stops=[],
            canceled_stops=[],
            stop_acceptance_times=[],
            entry_submissions=0,
        )
        self.sequence = 0
        self.stops = []
        self.exit_sent = False

    def on_start(self):
        self.subscribe_quotes(self.instrument.id)

    def on_quote(self, tick):
        self.sequence += 1
        if self.sequence == 1:
            order = self.order_factory.limit(
                instrument_id=self.instrument.id,
                order_side=OrderSide.BUY,
                quantity=Quantity.from_str("0.00368"),
                price=Price.from_str("60120.00"),
                time_in_force=TimeInForce.IOC,
                client_order_id=ClientOrderId("AST-ENTRY"),
            )
            self.result["entry_submissions"] += 1
            self.submit_order(order)
        elif self.sequence == 2 and self.mode == "round_trip":
            for key in self.stops:
                self.cancel_order(ClientOrderId(key))

    def on_order_filled(self, event: OrderFilled):
        self.result["fills"].append(
            dict(
                side=event.order_side.name,
                quantity=text(event.last_qty.as_decimal()),
                price=text(event.last_px.as_decimal()),
                fee=text(event.commission.as_decimal()),
                order_id=str(event.client_order_id),
                time_ns=event.ts_event,
            )
        )
        if str(event.client_order_id) == "AST-ENTRY":
            key = f"AST-STOP-{len(self.stops) + 1}"
            self.stops.append(key)
            stop = self.order_factory.stop_market(
                instrument_id=self.instrument.id,
                order_side=OrderSide.SELL,
                quantity=event.last_qty,
                trigger_price=Price.from_str("59000.00"),
                trigger_type=TriggerType.BID_ASK,
                time_in_force=TimeInForce.GTC,
                reduce_only=False,
                client_order_id=ClientOrderId(key),
            )
            self.submit_order(stop)

    def on_order_accepted(self, event):
        if str(event.client_order_id) in self.stops:
            self.result["accepted_stops"].append(str(event.client_order_id))
            self.result["stop_acceptance_times"].append(event.ts_event)

    def on_order_canceled(self, event):
        if str(event.client_order_id) in self.stops:
            self.result["canceled_stops"].append(str(event.client_order_id))
            if len(self.result["canceled_stops"]) == len(self.stops) and not self.exit_sent:
                self.exit_sent = True
                positions = self.cache.positions_open(instrument_id=self.instrument.id)
                if len(positions) != 1:
                    self.result["errors"].append("CLOSE_REQUIRES_NATIVE_POSITION")
                    return
                self.submit_order(
                    self.order_factory.market(
                        instrument_id=self.instrument.id,
                        order_side=OrderSide.SELL,
                        quantity=positions[0].quantity,
                        time_in_force=TimeInForce.IOC,
                        client_order_id=ClientOrderId("AST-EXIT"),
                    )
                )

    def on_order_rejected(self, event):
        self.result["errors"].append(str(event.reason))

    def on_order_denied(self, event):
        self.result["errors"].append(str(event.reason))


def run_case(mode):
    item = instrument()
    strategy = NativeCase(case_instrument=item, mode=mode)
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True, run_analysis=False, logging=LoggerConfig(bypass_logging=True)
        )
    )
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
            fill_model=FillModel(),
            latency_model=StaticLatencyModel(),
            book_type=BookType.L1_MBP,
            routing=False,
            use_position_ids=True,
            use_random_ids=False,
            use_reduce_only=False,
            use_market_order_acks=False,
            bar_execution=False,
            trade_execution=False,
            liquidity_consumption=True,
            allow_cash_borrowing=False,
        )
        engine.add_instrument(item)
        engine.add_strategy(strategy)
        quotes = (
            [("60199.00", "60200.00", "10.00000")]
            if mode == "zero"
            else [("59999.00", "60000.00", "0.00100" if mode == "partial" else "10.00000")]
        )
        next_quote = (
            ("58900.00", "58901.00", "10.00000")
            if mode in ("partial", "stop")
            else ("61000.00", "61001.00", "10.00000")
        )
        quotes += [next_quote, next_quote]
        ticks = [
            QuoteTick(
                item.id,
                Price.from_str(bid),
                Price.from_str(ask),
                Quantity.from_str("10.00000"),
                Quantity.from_str(size),
                1_700_000_000_000_000_000 + i * 1_000_000_000,
                1_700_000_000_000_000_000 + i * 1_000_000_000,
            )
            for i, (bid, ask, size) in enumerate(quotes)
        ]
        engine.add_data(ticks)
        engine.run()
        account = engine.cache.account_for_venue(item.id.venue)
        result = strategy.result
        result["balances"] = {
            str(c): text(v.as_decimal()) for c, v in account.balances_total().items()
        }
        result["open_orders"] = len(engine.cache.orders_open(instrument_id=item.id))
        result["open_positions"] = len(engine.cache.positions_open(instrument_id=item.id))
        result["orders"] = engine.generate_orders_report().reset_index().to_dict(orient="records")
        return result
    finally:
        engine.dispose()
