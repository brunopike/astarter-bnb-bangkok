"""Internal native SMA component. No publication, filesystem or run authority.

The eventual trusted runner must revalidate publication files, installed runtime and
engine profile before constructing this component. Here canonical inputs, all supplied
in-memory bars, native instrument/cash state and actual fills are checked. No route or
registry exposes this component as an executable published strategy yet.
"""

from __future__ import annotations

from collections.abc import Sequence
from copy import deepcopy
from decimal import Decimal
from fractions import Fraction
from hashlib import sha256
from typing import Any, cast

from nautilus_trader.model import (
    Bar,
    BarType,
    CashAccount,
    ClientOrderId,
    CurrencyPair,
    InstrumentId,
    OrderFilled,
    OrderSide,
    Quantity,
)
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.audit.historical_input import (
    parse_input_manifest_bytes,
    validate_input_bindings,
)
from stark_trading_os.catalog.historical_catalog import (
    _native_instrument,
    canonical_historical_bytes,
    parse_historical_manifest_bytes,
)
from stark_trading_os.runner.historical_cash_reconciliation import (
    apply_native_fill_cash,
    initial_native_cash,
    native_position_matches_cash,
)
from stark_trading_os.runner.historical_sma_policy import (
    SmaCrossSignal,
    SmaGuardState,
    SmaSide,
    check_sma_intent,
)


def _number(value: Decimal) -> str:
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def _money_values(values: Any) -> dict[str, str]:
    if isinstance(values, dict):
        values = values.values()
    result: dict[str, str] = {}
    for money in values:
        currency = str(money.currency)
        if currency in result:
            raise ValueError("NATIVE_DUPLICATE_CURRENCY")
        result[currency] = _number(money.as_decimal())
    return result


def _bar_value(bar: Bar) -> dict[str, str]:
    return {
        "open": str(bar.open),
        "high": str(bar.high),
        "low": str(bar.low),
        "close": str(bar.close),
        "volume": str(bar.volume),
        "ts_event": str(bar.ts_event),
        "ts_init": str(bar.ts_init),
    }


class HistoricalSmaStrategy(Strategy):
    """Single-instrument long/flat strategy; callbacks never send follow-up orders."""

    def __new__(cls, **kwargs: Any) -> HistoricalSmaStrategy:
        # rc3 accepts native config in __new__; its stub omits that signature.
        return cast(
            HistoricalSmaStrategy,
            cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False)),
        )

    def __init__(
        self,
        *,
        input_bytes: bytes,
        expected_input_sha256: str,
        catalog_manifest_bytes: bytes,
        bars: Sequence[Bar],
    ) -> None:
        manifest = parse_input_manifest_bytes(input_bytes, expected_sha256=expected_input_sha256)
        # This verifies declared internal bindings, NOT the currently installed runtime.
        validate_input_bindings(
            manifest,
            catalog_manifest_bytes=catalog_manifest_bytes,
            expected_runtime=manifest.runtime,
        )
        catalog = parse_historical_manifest_bytes(catalog_manifest_bytes)
        if len(bars) != manifest.dataset.record_count:
            raise ValueError("SMA_COMPONENT_BARS_INVALID")
        values: list[dict[str, str]] = []
        first = int(manifest.dataset.window.first_close_ns)
        period = int(manifest.dataset.timeframe_ns)
        for index, bar in enumerate(bars):
            if (
                type(bar) is not Bar
                or str(bar.bar_type) != manifest.dataset.bar_type
                or bar.ts_event != first + index * period
                or bar.ts_init != bar.ts_event
            ):
                raise ValueError("SMA_COMPONENT_BARS_INVALID")
            values.append(_bar_value(bar))
        if sha256(canonical_historical_bytes({"bars": values})).hexdigest() != (
            manifest.dataset.bar_values_sha256
        ):
            raise ValueError("SMA_COMPONENT_BARS_INVALID")
        config = StrategyConfig(manage_stop=False)
        if config.manage_stop is not False:
            raise ValueError("SMA_MANAGED_STOP_UNSUPPORTED")
        super().__init__(config)
        self._manifest = manifest
        self._input_hash = expected_input_sha256
        self._configuration = manifest.configuration.configuration
        self._instrument_id = InstrumentId.from_str(manifest.dataset.instrument_id)
        self._bar_type = BarType.from_str(manifest.dataset.bar_type)
        self._expected_bars = tuple(values)
        expected_instrument = _native_instrument(catalog.inventory.instrument).to_dict()
        expected_instrument["maker_fee"] = self._configuration.execution_cost.maker_fee
        expected_instrument["taker_fee"] = self._configuration.execution_cost.taker_fee
        self._expected_instrument = expected_instrument
        parameters = self._configuration.parameters
        self._signal = SmaCrossSignal(
            fast_period=parameters.fast_period, slow_period=parameters.slow_period
        )
        self._sequence = 0
        self._last_bar: Bar | None = None
        self._instrument: CurrencyPair | None = None
        self._expected_cash = initial_native_cash(
            (manifest.dataset.base_currency, manifest.dataset.quote_currency),
            self._configuration.execution_cost.starting_cash,
        )
        self._submitted: dict[str, SmaSide] = {}
        self._cancel_requested: set[str] = set()
        self._fill_ids: set[tuple[str, str]] = set()
        self._exit_requested = False
        self._failures: list[str] = []
        self._checkpoints: list[dict[str, Any]] = []
        self._decisions: list[dict[str, Any]] = []
        self._fills: list[dict[str, Any]] = []
        self._order_events: list[dict[str, Any]] = []
        self._final_output: dict[str, Any] | None = None

    def _fail(self, code: str) -> None:
        if code not in self._failures:
            self._failures.append(code)

    def on_start(self) -> None:
        try:
            instrument = self.cache.instrument(self._instrument_id)
            account = self.cache.account_for_venue(self._instrument_id.venue)
            if (
                type(instrument) is not CurrencyPair
                or instrument.to_dict() != self._expected_instrument
                or type(account) is not CashAccount
                or account.base_currency is not None
                or self.cache.positions_open(instrument_id=self._instrument_id)
            ):
                self._fail("SMA_NATIVE_START_STATE_INVALID")
                return
            self._instrument = instrument
            self.subscribe_bars(self._bar_type)
        except Exception:
            self._fail("SMA_NATIVE_START_FAILED")

    def _pending(self) -> dict[str, Any]:
        pending = {
            str(order.client_order_id): order
            for order in (
                *self.cache.orders_open(instrument_id=self._instrument_id),
                *self.cache.orders_inflight(instrument_id=self._instrument_id),
            )
        }
        for key in tuple(self._submitted):
            order = self.cache.order(ClientOrderId(key))
            if order is not None and order.is_closed:
                del self._submitted[key]
                self._cancel_requested.discard(key)
                pending.pop(key, None)
            else:
                # Keep an ID reservation even when native cache has not exposed the order yet.
                pending[key] = order
        if any(key not in self._submitted for key in pending):
            self._fail("SMA_UNEXPECTED_NATIVE_ORDER")
        return pending

    def _checkpoint(self, phase: str) -> tuple[dict[str, Any], SmaGuardState, dict[str, Any]]:
        instrument, bar = self._instrument, self._last_bar
        if instrument is None or bar is None:
            raise ValueError("SMA_NATIVE_STATE_UNAVAILABLE")
        account = self.cache.account_for_venue(self._instrument_id.venue)
        if type(account) is not CashAccount:
            raise ValueError("SMA_NATIVE_ACCOUNT_UNAVAILABLE")
        balances = {
            str(currency): {
                "total": _number(balance.total.as_decimal()),
                "free": _number(balance.free.as_decimal()),
                "locked": _number(balance.locked.as_decimal()),
            }
            for currency, balance in account.balances().items()
        }
        totals = {currency: Fraction(values["total"]) for currency, values in balances.items()}
        if totals != self._expected_cash:
            self._fail("NATIVE_CASH_RECONCILIATION_FAILED")
        positions = [
            {"quantity": _number(position.quantity.as_decimal()), "side": position.side.name}
            for position in self.cache.positions_open(instrument_id=self._instrument_id)
        ]
        base, quote = self._manifest.dataset.base_currency, self._manifest.dataset.quote_currency
        position_qty = sum((Fraction(row["quantity"]) for row in positions), Fraction(0))
        if not native_position_matches_cash(positions, totals.get(base)):
            self._fail("NATIVE_POSITION_RECONCILIATION_FAILED")
        pending = self._pending()
        snapshot = self.portfolio.build_snapshot(account.id)
        if snapshot is None:
            raise ValueError("SMA_NATIVE_SNAPSHOT_UNAVAILABLE")
        if (
            snapshot.is_stale
            or snapshot.stale_instruments
            or snapshot.stale_currencies
            or snapshot.unpriced_instruments
            or snapshot.base_currency_equity is not None
        ):
            self._fail("NATIVE_SNAPSHOT_UNSUPPORTED")
        row = {
            "phase": phase,
            "sequence": self._sequence,
            "clock_ns": self.clock.timestamp_ns(),
            "bar_ts_event": bar.ts_event,
            "balances": balances,
            "positions": positions,
            "pending_orders": [
                {
                    "id": key,
                    "status": "AWAITING_NATIVE_CACHE" if order is None else order.status.name,
                    "leaves_quantity": None if order is None else str(order.leaves_qty),
                }
                for key, order in sorted(pending.items())
            ],
            "realized_pnls": _money_values(self.portfolio.realized_pnls(venue=instrument.id.venue)),
            "unrealized_pnls": _money_values(
                self.portfolio.unrealized_pnls(venue=instrument.id.venue)
            ),
            "total_pnls": _money_values(self.portfolio.total_pnls(venue=instrument.id.venue)),
            "mark_values": _money_values(self.portfolio.mark_values(venue=instrument.id.venue)),
            "total_equity": _money_values(snapshot.total_equity),
            "base_currency_equity": None
            if snapshot.base_currency_equity is None
            else (_money_values([snapshot.base_currency_equity])),
            "is_stale": snapshot.is_stale,
            "stale_instruments": [str(item) for item in snapshot.stale_instruments],
            "stale_currencies": [str(item) for item in snapshot.stale_currencies],
            "unpriced_instruments": [str(item) for item in snapshot.unpriced_instruments],
        }
        self._checkpoints.append(row)
        state = SmaGuardState(
            position_quantity=position_qty,
            base_free=Fraction(balances[base]["free"]),
            quote_free=Fraction(balances[quote]["free"]),
            pending=bool(pending),
        )
        return row, state, pending

    def on_bar(self, bar: Bar) -> None:
        try:
            if (
                self._final_output is not None
                or self._sequence >= len(self._expected_bars)
                or str(bar.bar_type) != self._manifest.dataset.bar_type
                or _bar_value(bar) != self._expected_bars[self._sequence]
                or self.clock.timestamp_ns() != bar.ts_init
            ):
                self._fail("SMA_BAR_SEQUENCE_INVALID")
                return
            self._last_bar = bar
            self._sequence += 1
            _, state, pending = self._checkpoint("PRE_INTENT")
            if self._failures:
                return
            side = self._signal.update(sequence=self._sequence, close=str(bar.close))
            if (side == "SELL" or self._exit_requested) and any(
                self._submitted.get(key) == "BUY" for key in pending
            ):
                self._exit_requested = True
                for key, order in pending.items():
                    if self._submitted.get(key) == "BUY" and order is not None:
                        if key not in self._cancel_requested:
                            self._cancel_requested.add(key)
                            self.cancel_order(ClientOrderId(key))
                self._decisions.append(
                    {"sequence": self._sequence, "side": "SELL", "code": "WAIT_PENDING_ENTRY"}
                )
                return
            if self._exit_requested:
                if pending:
                    return
                self._exit_requested = False
                side = "SELL" if state.position_quantity > 0 else None
            if side is not None:
                self._intent(side, state, bar)
        except Exception:
            self._fail("SMA_CALLBACK_FAILED")

    def _intent(self, side: SmaSide, state: SmaGuardState, bar: Bar) -> None:
        instrument = self._instrument
        if instrument is None:
            raise ValueError("SMA_NATIVE_INSTRUMENT_UNAVAILABLE")
        quantity = (
            Fraction(self._configuration.parameters.order_quantity)
            if side == "BUY"
            else state.position_quantity
        )
        if side == "SELL" and quantity == 0:
            self._decisions.append(
                {"sequence": self._sequence, "side": side, "code": "NO_CONFIRMED_POSITION"}
            )
            return
        risk = self._configuration.risk
        decision = check_sma_intent(
            side=side,
            quantity=quantity,
            price=Fraction(str(bar.close)),
            taker_fee=Fraction(self._configuration.execution_cost.taker_fee),
            quote_quantum=Fraction(1, 10**instrument.quote_currency.precision),
            size_increment=Fraction(str(instrument.size_increment)),
            max_order_notional=Fraction(risk.max_order_notional),
            max_position_quantity=Fraction(risk.max_position_quantity),
            state=state,
        )
        row: dict[str, Any] = {
            "sequence": self._sequence,
            "side": side,
            "code": decision.code,
            "required_quote_numerator": str(decision.required_quote.numerator),
            "required_quote_denominator": str(decision.required_quote.denominator),
        }
        self._decisions.append(row)
        if decision.code != "ALLOW":
            return
        if side == "BUY":
            native_quantity = Quantity.from_decimal_dp(
                Decimal(self._configuration.parameters.order_quantity), instrument.size_precision
            )
        else:
            native_quantity = self.cache.positions_open(instrument_id=self._instrument_id)[
                0
            ].quantity
        if Fraction(native_quantity.as_decimal()) != quantity:
            raise ValueError("SMA_QUANTITY_ROUNDING_UNSUPPORTED")
        order_id = f"SMA-{self._input_hash[:24]}-{self._sequence}-{side}"
        order = self.order_factory.market(
            instrument_id=self._instrument_id,
            order_side=OrderSide.BUY if side == "BUY" else OrderSide.SELL,
            quantity=native_quantity,
            reduce_only=False,
            client_order_id=ClientOrderId(order_id),
        )
        self._submitted[order_id] = side  # Reserve before native submission/cache visibility.
        row["client_order_id"] = order_id
        self.submit_order(order)
        row["code"] = "SUBMITTED"

    def on_order_filled(self, event: OrderFilled) -> None:
        try:
            account = self.cache.account_for_venue(self._instrument_id.venue)
            instrument = self._instrument
            key = (str(event.client_order_id), str(event.trade_id))
            if (
                instrument is None
                or type(account) is not CashAccount
                or event.instrument_id != self._instrument_id
                or key in self._fill_ids
                or key[0] not in self._submitted
                or event.commission is None
                or str(event.commission.currency) != self._manifest.dataset.quote_currency
                or event.commission.as_decimal() < 0
            ):
                self._fail("SMA_NATIVE_FILL_INVALID")
                return
            deltas = _money_values(account.calculate_pnls(instrument, event))
            commission = _money_values([event.commission])
            if set(deltas) != set(self._expected_cash):
                self._fail("SMA_NATIVE_FILL_CURRENCY_INVALID")
                return
            self._fill_ids.add(key)
            self._fills.append(
                {
                    "client_order_id": key[0],
                    "trade_id": key[1],
                    "last_quantity": str(event.last_qty),
                    "last_price": str(event.last_px),
                    "cash_delta": deltas,
                    "commission": commission,
                    "ts_event": event.ts_event,
                }
            )
            apply_native_fill_cash(self._expected_cash, deltas, commission)
        except Exception:
            self._fail("SMA_NATIVE_FILL_CALLBACK_FAILED")

    def on_order_event(self, event: Any) -> None:
        try:
            self._order_events.append(
                {
                    "event_type": type(event).__name__,
                    "client_order_id": str(event.client_order_id),
                    "ts_event": event.ts_event,
                    "reason": getattr(event, "reason", None),
                }
            )
        except Exception:
            self._fail("SMA_NATIVE_ORDER_EVENT_FAILED")

    def finalize_component(self) -> dict[str, Any]:
        """Call only after native run() returns, before the owner disposes the engine."""
        if self.is_running():
            raise ValueError("SMA_FINALIZE_REQUIRES_STOPPED_STRATEGY")
        if self._final_output is not None:
            return deepcopy(self._final_output)
        if self._sequence != len(self._expected_bars):
            self._fail("SMA_INCOMPLETE_BAR_STREAM")
        try:
            self._checkpoint("FINAL_POST_RUN")
        except Exception:
            self._fail("SMA_FINAL_CHECKPOINT_FAILED")
        self._final_output = {
            "scope": "IN_MEMORY_COMPONENT_CHECK",
            "status": "COMPONENT_CHECK_FAILED" if self._failures else "COMPONENT_CHECK_PASSED",
            "input_manifest_sha256": self._input_hash,
            "failure_codes": list(self._failures),
            "checkpoints": deepcopy(self._checkpoints),
            "decisions": deepcopy(self._decisions),
            "native_fill_facts": deepcopy(self._fills),
            "native_order_events": deepcopy(self._order_events),
        }
        return deepcopy(self._final_output)
