"""Finite observations of direct-engine CASH state, never a production runner."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.model import Bar, BarType, CurrencyPair, Money, OrderFilled, Price, Quantity

from stark_trading_os.runner.historical_cost import build_historical_execution_profile
from tests.compat.rc3_bar_fixture import (
    _BarCaseConfig,
    _BarCaseStrategy,
    _bars,
    _instrument,
    _native_case_reports,
)
from tests.unit.runner.test_historical_cost import _parsed_cost


def _number(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _money_values(values: Any) -> dict[str, str]:
    if isinstance(values, dict):
        values = values.values()
    result: dict[str, str] = {}
    for money in values:
        currency = str(money.currency)
        assert currency not in result, "native vector repeated a currency"
        result[currency] = _number(money.as_decimal())
    return result


def _sample(
    cache: Any, portfolio: Any, instrument: CurrencyPair, *, price: Price, phase: str
) -> dict[str, object]:
    account = cache.account_for_venue(instrument.id.venue)
    assert account is not None
    balances = {
        str(currency): {
            "total": _number(balance.total.as_decimal()),
            "free": _number(balance.free.as_decimal()),
            "locked": _number(balance.locked.as_decimal()),
        }
        for currency, balance in account.balances().items()
    }
    active = {
        str(order.client_order_id): order
        for order in (
            *cache.orders_open(instrument_id=instrument.id),
            *cache.orders_inflight(instrument_id=instrument.id),
        )
    }
    result: dict[str, object] = {
        "phase": phase,
        "balances": balances,
        "open_positions": [
            {
                "quantity": _number(position.quantity.as_decimal()),
                "side": position.side.name,
            }
            for position in cache.positions_open(instrument_id=instrument.id)
        ],
        "active_orders": [
            {
                "id": key,
                "status": order.status.name,
                "leaves_qty": _number(order.leaves_qty.as_decimal()),
            }
            for key, order in sorted(active.items())
        ],
    }
    if phase in {"PRE_INTENT", "FINAL_POST_RUN"}:
        snapshot = portfolio.build_snapshot(account.id)
        assert snapshot is not None
        unrealized = portfolio.unrealized_pnl(instrument.id, price=price)
        result.update(
            explicit_price_unrealized_pnl=(
                {} if unrealized is None else _money_values([unrealized])
            ),
            realized_pnls=_money_values(portfolio.realized_pnls(venue=instrument.id.venue)),
            unrealized_pnls=_money_values(portfolio.unrealized_pnls(venue=instrument.id.venue)),
            total_pnls=_money_values(portfolio.total_pnls(venue=instrument.id.venue)),
            mark_values=_money_values(portfolio.mark_values(venue=instrument.id.venue)),
            snapshot={
                "total_equity": _money_values(snapshot.total_equity),
                "base_currency_equity": (
                    None
                    if snapshot.base_currency_equity is None
                    else _money_values([snapshot.base_currency_equity])
                ),
                "is_stale": snapshot.is_stale,
                "stale_instruments": [str(item) for item in snapshot.stale_instruments],
                "stale_currencies": [str(item) for item in snapshot.stale_currencies],
                "unpriced_instruments": [str(item) for item in snapshot.unpriced_instruments],
            },
        )
    return result


class _CheckpointConfig(_BarCaseConfig):
    def __new__(cls, *args: Any, **kwargs: Any) -> _CheckpointConfig:
        kwargs["manage_stop"] = False
        return super().__new__(cls, *args, **kwargs)


class _CheckpointStrategy(_BarCaseStrategy):
    def __init__(self, config: _CheckpointConfig) -> None:
        super().__init__(config)
        self.checkpoints: list[dict[str, object]] = []
        self.callbacks: list[dict[str, object]] = []
        self.native_fill_deltas: list[dict[str, object]] = []
        self._last_bar: Bar | None = None

    def _capture(self, phase: str) -> dict[str, object]:
        instrument = self.cache.instrument(self._instrument_id)
        assert instrument is not None and self._last_bar is not None
        result = _sample(
            self.cache, self.portfolio, instrument, price=self._last_bar.close, phase=phase
        )
        result["clock_ns"] = self.clock.timestamp_ns()
        result["bar_ts_event"] = self._last_bar.ts_event
        return result

    def on_bar(self, bar: Bar) -> None:
        self._last_bar = bar
        self.checkpoints.append(self._capture("PRE_INTENT"))
        super().on_bar(bar)
        self.callbacks.append(self._capture("AFTER_SUBMIT_RETURN"))

    def on_order_filled(self, event: OrderFilled) -> None:
        super().on_order_filled(event)
        self.callbacks.append(self._capture("ORDER_FILLED_CALLBACK"))
        account = self.cache.account_for_venue(self._instrument_id.venue)
        instrument = self.cache.instrument(self._instrument_id)
        assert account is not None and instrument is not None
        self.native_fill_deltas.append(
            {
                "trade_id": str(event.trade_id),
                "last_qty": _number(event.last_qty.as_decimal()),
                "last_px": _number(event.last_px.as_decimal()),
                "cash_delta": _money_values(account.calculate_pnls(instrument, event)),
                "commission": _money_values([event.commission]),
            }
        )

    def on_stop(self) -> None:
        self.callbacks.append(self._capture("STOP_CALLBACK"))


def run_cash_checkpoint_case(
    *,
    cash: str = "1000",
    quantity: str = "1.000",
    sell_on_second: bool = False,
    final_bar_only: bool = False,
) -> dict[str, object]:
    source_data = _instrument().to_dict()
    source_data["maker_fee"] = source_data["taker_fee"] = "0"
    source = CurrencyPair.from_dict(source_data)
    before = source.to_dict()
    profile = build_historical_execution_profile(source, _parsed_cost(starting_cash=cash))
    bar_type = BarType.from_str(str(source.id) + "-1-MINUTE-LAST-EXTERNAL")
    bars = _bars(bar_type)
    if final_bar_only:
        bars = bars[-1:]
    config = _CheckpointConfig(
        instrument_id=source.id,
        bar_type=bar_type,
        quantity=Quantity.from_str(quantity),
        sell_on_second=sell_on_second,
        observations=[],
    )
    assert config.manage_stop is False
    strategy = _CheckpointStrategy(config)
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True,
            run_analysis=False,
            logging=LoggerConfig(bypass_logging=True),
        )
    )
    result: dict[str, object] = {}
    try:
        engine.add_venue(
            venue=source.id.venue,
            oms_type=profile.oms_type,
            account_type=profile.account_type,
            starting_balances=[Money.zero(source.base_currency), profile.starting_quote_balance],
            base_currency=None,
            fill_model=profile.fill_model,
            fee_model=profile.fee_model,
            latency_model=profile.latency_model,
            book_type=profile.book_type,
            routing=profile.routing,
            use_position_ids=profile.use_position_ids,
            use_random_ids=profile.use_random_ids,
            use_reduce_only=profile.use_reduce_only,
            use_market_order_acks=profile.use_market_order_acks,
            bar_execution=profile.bar_execution,
            bar_adaptive_high_low_ordering=profile.bar_adaptive_high_low_ordering,
            trade_execution=profile.trade_execution,
            liquidity_consumption=profile.liquidity_consumption,
            allow_cash_borrowing=profile.allow_cash_borrowing,
        )
        engine.add_instrument(profile.instrument)
        engine.add_strategy(strategy)
        engine.add_data(bars)
        engine.run()
        result = _native_case_reports(engine, strategy._observations, venue=source.id.venue)
        result.update(
            checkpoints=[
                *strategy.checkpoints,
                strategy._capture("FINAL_POST_RUN"),
            ],
            callbacks=strategy.callbacks,
            native_fill_deltas=strategy.native_fill_deltas,
            source_unchanged=source.to_dict() == before,
        )
    finally:
        engine.dispose()
    result["engine_disposed"] = True
    return result
