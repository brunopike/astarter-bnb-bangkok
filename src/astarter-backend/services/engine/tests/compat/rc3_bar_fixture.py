from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Any

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.execution import FeeModel, FillModel, StaticLatencyModel
from nautilus_trader.model import (
    AccountType,
    AggregationSource,
    Bar,
    BarAggregation,
    BarSpecification,
    BarType,
    BookType,
    ClientOrderId,
    Currency,
    CurrencyPair,
    InstrumentId,
    Money,
    OmsType,
    OrderAccepted,
    OrderDenied,
    OrderFilled,
    OrderRejected,
    OrderSide,
    OrderSubmitted,
    PositionClosed,
    PositionOpened,
    Price,
    PriceType,
    Quantity,
    Symbol,
    Venue,
)
from nautilus_trader.trading import Strategy, StrategyConfig

VENUE = Venue("SIM")
INSTRUMENT_ID = InstrumentId(Symbol("ETH/USDT"), VENUE)
FIRST_CLOSE_NS = 1_700_000_060_000_000_000
SECOND_CLOSE_NS = 1_700_000_120_000_000_000


class _BarCaseConfig(StrategyConfig):
    _CUSTOM_FIELDS = (
        "instrument_id",
        "bar_type",
        "quantity",
        "sell_on_second",
        "observations",
    )

    def __new__(cls, *args: Any, **kwargs: Any) -> _BarCaseConfig:
        for key in cls._CUSTOM_FIELDS:
            kwargs.pop(key, None)
        return super().__new__(cls, *args, **kwargs)

    def __init__(
        self,
        *,
        instrument_id: InstrumentId,
        bar_type: BarType,
        quantity: Quantity,
        sell_on_second: bool,
        observations: list[dict[str, object]],
    ) -> None:
        super().__init__()
        self.instrument_id = instrument_id
        self.bar_type = bar_type
        self.quantity = quantity
        self.sell_on_second = sell_on_second
        self.observations = observations


class _BarCaseStrategy(Strategy):
    def __init__(self, config: _BarCaseConfig) -> None:
        super().__init__(config)
        self._instrument_id = config.instrument_id
        self._bar_type = config.bar_type
        self._quantity = config.quantity
        self._sell_on_second = config.sell_on_second
        self._observations = config.observations
        self._bar_count = 0

    def on_start(self) -> None:
        self.subscribe_bars(self._bar_type)

    def on_bar(self, bar: Bar) -> None:
        self._bar_count += 1
        self._observations.append(
            {
                "event": "bar_callback",
                "clock_ns": self.clock.timestamp_ns(),
                "bar_ts_event": bar.ts_event,
                "bar_ts_init": bar.ts_init,
                "bar_close": str(bar.close),
            },
        )
        if self._bar_count == 1:
            self._submit_market_order(
                side=OrderSide.BUY,
                quantity=self._quantity,
                client_order_id=ClientOrderId("BAR-CASE-BUY"),
            )
        elif self._bar_count == 2 and self._sell_on_second:
            positions = self.cache.positions_open(instrument_id=self._instrument_id)
            if len(positions) != 1:
                self._observations.append(
                    {
                        "event": "sell_skipped_no_confirmed_position",
                        "clock_ns": self.clock.timestamp_ns(),
                        "position_count": len(positions),
                    },
                )
                return
            self._submit_market_order(
                side=OrderSide.SELL,
                quantity=positions[0].quantity,
                client_order_id=ClientOrderId("BAR-CASE-SELL"),
            )

    def on_order_submitted(self, event: OrderSubmitted) -> None:
        self._record_order_event("order_submitted", event)

    def on_order_accepted(self, event: OrderAccepted) -> None:
        self._record_order_event("order_accepted", event)

    def on_order_denied(self, event: OrderDenied) -> None:
        self._record_order_event("order_denied", event)

    def on_order_rejected(self, event: OrderRejected) -> None:
        self._record_order_event("order_rejected", event)

    def on_order_filled(self, event: OrderFilled) -> None:
        self._observations.append(
            {
                "event": "order_filled",
                "clock_ns": self.clock.timestamp_ns(),
                "event_ts": event.ts_event,
                "client_order_id": event.client_order_id.value,
                "last_qty": str(event.last_qty),
                "last_px": str(event.last_px),
                "commission": str(event.commission),
            },
        )

    def on_position_opened(self, event: PositionOpened) -> None:
        self._record_position_event("position_opened", event)

    def on_position_closed(self, event: PositionClosed) -> None:
        self._record_position_event("position_closed", event)

    def _submit_market_order(
        self,
        *,
        side: OrderSide,
        quantity: Quantity,
        client_order_id: ClientOrderId,
    ) -> None:
        self._observations.append(
            {
                "event": "order_submit",
                "clock_ns": self.clock.timestamp_ns(),
                "client_order_id": client_order_id.value,
                "side": side.name,
                "quantity": str(quantity),
            },
        )
        order = self.order_factory.market(
            instrument_id=self._instrument_id,
            order_side=side,
            quantity=quantity,
            reduce_only=False,
            client_order_id=client_order_id,
        )
        self.submit_order(order)

    def _record_order_event(self, name: str, event: Any) -> None:
        self._observations.append(
            {
                "event": name,
                "clock_ns": self.clock.timestamp_ns(),
                "client_order_id": event.client_order_id.value,
                "event_ts": event.ts_event,
                "reason": getattr(event, "reason", None),
            },
        )

    def _record_position_event(self, name: str, event: Any) -> None:
        self._observations.append(
            {
                "event": name,
                "clock_ns": self.clock.timestamp_ns(),
                "position_id": event.position_id.value,
                "quantity": str(event.quantity),
                "event_ts": event.ts_event,
            },
        )


def run_bar_case(
    *,
    quantity: str = "1.000",
    cash: str = "1000",
    sell_on_second: bool = False,
    instrument: CurrencyPair | None = None,
    bars: Sequence[Bar] | None = None,
    starting_quote_balance: Money | None = None,
    fee_model: FeeModel | None = None,
    fill_model: FillModel | None = None,
    latency_model: StaticLatencyModel | None = None,
    book_type: BookType = BookType.L1_MBP,
    oms_type: OmsType = OmsType.NETTING,
    account_type: AccountType = AccountType.CASH,
    routing: bool = False,
    use_position_ids: bool = True,
    use_random_ids: bool = False,
    use_reduce_only: bool = False,
    use_market_order_acks: bool = False,
    bar_execution: bool = True,
    bar_adaptive_high_low_ordering: bool = False,
    trade_execution: bool = False,
    liquidity_consumption: bool = True,
    allow_cash_borrowing: bool = False,
) -> dict[str, object]:
    case_instrument = instrument if instrument is not None else _instrument()
    if bars is None:
        bar_type = BarType(
            case_instrument.id,
            BarSpecification(1, BarAggregation.MINUTE, PriceType.LAST),
            AggregationSource.EXTERNAL,
        )
        case_bars = _bars(bar_type)
    else:
        case_bars = list(bars)
        if not case_bars:
            raise ValueError("bar case requires at least one bar")
        bar_type = case_bars[0].bar_type
    quote_balance = (
        starting_quote_balance
        if starting_quote_balance is not None
        else Money.from_str(f"{cash} {case_instrument.quote_currency}")
    )
    observations: list[dict[str, object]] = []
    strategy = _BarCaseStrategy(
        _BarCaseConfig(
            instrument_id=case_instrument.id,
            bar_type=bar_type,
            quantity=Quantity.from_str(quantity),
            sell_on_second=sell_on_second,
            observations=observations,
        ),
    )
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True,
            run_analysis=False,
            logging=LoggerConfig(bypass_logging=True),
        ),
    )
    try:
        engine.add_venue(
            venue=case_instrument.id.venue,
            oms_type=oms_type,
            account_type=account_type,
            starting_balances=[
                Money.zero(case_instrument.base_currency),
                quote_balance,
            ],
            base_currency=None,
            fill_model=fill_model if fill_model is not None else FillModel(),
            fee_model=fee_model,
            latency_model=(latency_model if latency_model is not None else StaticLatencyModel()),
            book_type=book_type,
            routing=routing,
            use_position_ids=use_position_ids,
            use_random_ids=use_random_ids,
            use_reduce_only=use_reduce_only,
            use_market_order_acks=use_market_order_acks,
            bar_execution=bar_execution,
            bar_adaptive_high_low_ordering=bar_adaptive_high_low_ordering,
            trade_execution=trade_execution,
            liquidity_consumption=liquidity_consumption,
            allow_cash_borrowing=allow_cash_borrowing,
        )
        engine.add_instrument(case_instrument)
        engine.add_strategy(strategy)
        engine.add_data(case_bars)
        engine.run()
        return _native_case_reports(engine, observations, venue=case_instrument.id.venue)
    finally:
        engine.dispose()


def _instrument() -> CurrencyPair:
    return CurrencyPair(
        instrument_id=INSTRUMENT_ID,
        raw_symbol=Symbol("ETH/USDT"),
        base_currency=Currency.from_str("ETH"),
        quote_currency=Currency.from_str("USDT"),
        price_precision=2,
        size_precision=3,
        price_increment=Price.from_str("0.01"),
        size_increment=Quantity.from_str("0.001"),
        lot_size=Quantity.from_str("0.001"),
        min_quantity=Quantity.from_str("0.001"),
        ts_event=FIRST_CLOSE_NS,
        ts_init=FIRST_CLOSE_NS,
        margin_init=Decimal("0"),
        margin_maint=Decimal("0"),
        maker_fee=Decimal("0"),
        taker_fee=Decimal("0.001"),
    )


def _bars(bar_type: BarType) -> list[Bar]:
    return [
        Bar(
            bar_type=bar_type,
            open=Price.from_str("100.00"),
            high=Price.from_str("110.00"),
            low=Price.from_str("90.00"),
            close=Price.from_str("105.00"),
            volume=Quantity.from_str("100.000"),
            ts_event=FIRST_CLOSE_NS,
            ts_init=FIRST_CLOSE_NS,
        ),
        Bar(
            bar_type=bar_type,
            open=Price.from_str("200.00"),
            high=Price.from_str("220.00"),
            low=Price.from_str("180.00"),
            close=Price.from_str("210.00"),
            volume=Quantity.from_str("100.000"),
            ts_event=SECOND_CLOSE_NS,
            ts_init=SECOND_CLOSE_NS,
        ),
    ]


def _native_case_reports(
    engine: BacktestEngine,
    observations: list[dict[str, object]],
    *,
    venue: Venue = VENUE,
) -> dict[str, object]:
    return {
        "observations": observations,
        "orders": _native_rows(engine.generate_orders_report()),
        "fills": _native_rows(engine.generate_fills_report()),
        "positions": _native_rows(engine.generate_positions_report()),
        "account": _native_rows(engine.generate_account_report(venue=venue)),
    }


def _native_rows(report: Any) -> list[dict[str, object]]:
    return report.reset_index().to_dict(orient="records")
