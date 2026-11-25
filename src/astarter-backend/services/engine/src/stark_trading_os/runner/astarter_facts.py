"""Opaque finite native venue source. No scalar snapshot import or account writes."""

from __future__ import annotations

import hmac
import secrets
from dataclasses import asdict, replace
from decimal import Decimal
from fractions import Fraction as F
from hashlib import sha256
from typing import Any
from uuid import uuid4

from nautilus_trader.model import CashAccount, CurrencyPair, OrderFilled
from nautilus_trader.trading import Strategy

from stark_trading_os.domain.astarter_simulation import (
    AstarterIntegrityError,
    NativeFill,
    NativeOrder,
    NativeSnapshot,
    digest,
    encode,
    text,
)


class NativeFactsSource:
    """One actual native venue session; creating another source never reuses its identity."""

    def __init__(self, instrument: CurrencyPair, strategy: Strategy) -> None:
        if (
            type(instrument) is not CurrencyPair
            or not isinstance(strategy, Strategy)
            or str(instrument.id) != "BTC/USDT.SIM"
            or instrument.size_precision != 5
            or instrument.quote_currency.precision != 8
            or instrument.price_precision != 2
            or instrument.size_increment.as_decimal() != Decimal("0.00001")
            or str(instrument.base_currency) != "BTC"
            or str(instrument.quote_currency) != "USDT"
            or instrument.maker_fee != Decimal("0.001")
            or instrument.taker_fee != Decimal("0.001")
        ):
            raise AstarterIntegrityError("ASTARTER_NATIVE_SOURCE_INVALID")
        # rc3 mutably borrows BacktestEngine during run(); callback code must use
        # the registered strategy's native cache handle, not reborrow engine.cache.
        cache = strategy.cache
        native_item = cache.instrument(instrument.id)
        if native_item is None or native_item.to_dict() != instrument.to_dict():
            raise AstarterIntegrityError("ASTARTER_NATIVE_INSTRUMENT_INVALID")
        account = cache.account_for_venue(instrument.id.venue)
        if (
            type(account) is not CashAccount
            or cache.orders()
            or cache.positions_open()
            or str(account.id) != "SIM-001"
        ):
            raise AstarterIntegrityError("ASTARTER_NATIVE_INITIAL_BASELINE_INVALID")
        balances = {str(k): F(v.as_decimal()) for k, v in account.balances_total().items()}
        if set(balances) != {"BTC", "USDT"} or balances["BTC"] != 0 or balances["USDT"] <= 0:
            raise AstarterIntegrityError("ASTARTER_NATIVE_INITIAL_BASELINE_INVALID")
        self._cache, self._instrument, self._strategy = cache, instrument, strategy
        self._instrument_sha256 = digest(instrument.to_dict())
        self._session = str(uuid4())
        self._account_id = str(account.id)
        self._initial_quote = balances["USDT"]
        self._key = secrets.token_bytes(32)
        self._sequence = 0
        self._closed = False

    @property
    def initial_quote(self) -> str:
        return text(self._initial_quote)

    @property
    def account_id(self) -> str:
        return self._account_id

    @property
    def venue_session(self) -> str:
        return self._session

    def bound_instrument(self) -> dict[str, str]:
        if self._closed:
            raise AstarterIntegrityError("ASTARTER_NATIVE_SOURCE_CLOSED")
        self._verify_instrument()
        item = self._instrument
        precision = int(item.quote_currency.precision)
        notional = item.min_notional
        quantity = item.min_quantity
        min_notional = "unset" if notional is None else text(notional.as_decimal())
        min_quantity = "unset" if quantity is None else text(quantity.as_decimal())
        return {
            "instrument_id": str(item.id),
            "base": str(item.base_currency),
            "quote": str(item.quote_currency),
            "venue": str(item.id.venue),
            "price_precision": str(item.price_precision),
            "price_increment": text(item.price_increment.as_decimal()),
            "size_precision": str(item.size_precision),
            "size_increment": text(item.size_increment.as_decimal()),
            "min_quantity": min_quantity,
            "min_notional": min_notional,
            "quote_unit": text(F(1, 10**precision)),
            "maker_fee": text(item.maker_fee),
            "taker_fee": text(item.taker_fee),
            "instrument_sha256": self._instrument_sha256,
            "account_id": self._account_id,
            "venue_session": self._session,
        }

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._key = b""
        # Break source→Strategy→source on the native owner thread. Rust handles
        # are unsendable; leaving the cycle for a later API thread GC is unsafe.
        del self._strategy
        del self._cache

    def _signature(self, snapshot: NativeSnapshot) -> str:
        body = asdict(replace(snapshot, seal=""))
        return hmac.new(self._key, encode(body), sha256).hexdigest()

    def verify(self, snapshot: NativeSnapshot) -> None:
        if self._closed:
            raise AstarterIntegrityError("ASTARTER_NATIVE_SOURCE_CLOSED")
        self._verify_instrument()
        if (
            self._closed
            or type(snapshot) is not NativeSnapshot
            or snapshot.account_id != self._account_id
            or snapshot.venue_session != self._session
            or snapshot.now_ns != self._strategy.clock.timestamp_ns()
            or not hmac.compare_digest(snapshot.seal, self._signature(snapshot))
        ):
            raise AstarterIntegrityError("ASTARTER_NATIVE_ATTESTATION_INVALID")

    def _verify_instrument(self) -> None:
        current = self._cache.instrument(self._instrument.id)
        if current is None or digest(current.to_dict()) != self._instrument_sha256:
            raise AstarterIntegrityError("ASTARTER_NATIVE_INSTRUMENT_CHANGED")

    def capture(self) -> NativeSnapshot:
        if self._closed:
            raise AstarterIntegrityError("ASTARTER_NATIVE_SOURCE_CLOSED")
        self._verify_instrument()
        cache, instrument = self._cache, self._instrument
        account = cache.account_for_venue(instrument.id.venue)
        if type(account) is not CashAccount or str(account.id) != self._account_id:
            raise AstarterIntegrityError("ASTARTER_NATIVE_ACCOUNT_MISSING")
        quote = cache.quote(instrument.id)
        if quote is None:
            raise AstarterIntegrityError("ASTARTER_NATIVE_QUOTE_MISSING")
        totals = {str(k): F(v.as_decimal()) for k, v in account.balances_total().items()}
        free = {str(k): F(v.as_decimal()) for k, v in account.balances_free().items()}
        if set(totals) != {"BTC", "USDT"} or set(free) != set(totals):
            raise AstarterIntegrityError("ASTARTER_NATIVE_CURRENCY_INVALID")
        orders: list[NativeOrder] = []
        fills: dict[tuple[str, str], NativeFill] = {}
        for order in cache.orders():
            if order.instrument_id != instrument.id:
                raise AstarterIntegrityError("ASTARTER_NATIVE_FOREIGN_ORDER")
            events = order.events()
            accepted = [e.ts_event for e in events if type(e).__name__ == "OrderAccepted"]
            trigger = getattr(order, "trigger_price", None)
            limit = getattr(order, "price", None)
            orders.append(
                NativeOrder(
                    str(order.client_order_id),
                    order.side.name,
                    order.order_type.name,
                    order.status.name,
                    text(order.quantity.as_decimal()),
                    text(order.filled_qty.as_decimal()),
                    None if trigger is None else text(trigger.as_decimal()),
                    min(accepted) if accepted else None,
                    None if limit is None else text(limit.as_decimal()),
                    int(order.ts_last),
                )
            )
            for event in events:
                if type(event) is not OrderFilled:
                    continue
                if (
                    event.commission is None
                    or str(event.commission.currency) != "USDT"
                    or event.commission.as_decimal() < 0
                ):
                    raise AstarterIntegrityError("ASTARTER_NATIVE_FEE_UNKNOWN")
                fact = NativeFill(
                    str(event.client_order_id),
                    str(event.trade_id),
                    event.order_side.name,
                    text(event.last_qty.as_decimal()),
                    text(event.last_px.as_decimal()),
                    text(event.commission.as_decimal()),
                    str(event.commission.currency),
                    event.ts_event,
                )
                key = (fact.order_id, fact.trade_id)
                if key in fills and fills[key] != fact:
                    raise AstarterIntegrityError("ASTARTER_NATIVE_FILL_CONFLICT")
                fills[key] = fact
        expected_quote, expected_base = self._initial_quote, F(0)
        for fill in fills.values():
            q, price, fee = F(fill.quantity), F(fill.price), F(fill.fee)
            if fill.side not in {"BUY", "SELL"} or q <= 0 or price <= 0:
                raise AstarterIntegrityError("ASTARTER_NATIVE_FILL_INVALID")
            expected_quote += (-q * price if fill.side == "BUY" else q * price) - fee
            expected_base += q if fill.side == "BUY" else -q
        positions: list[Any] = cache.positions_open(instrument_id=instrument.id)
        if any(p.side.name != "LONG" for p in positions):
            raise AstarterIntegrityError("ASTARTER_NATIVE_SHORT_UNSUPPORTED")
        position_q = sum((F(p.quantity.as_decimal()) for p in positions), F(0))
        self._sequence += 1
        snapshot = NativeSnapshot(
            self._account_id,
            self._session,
            self._sequence,
            self._strategy.clock.timestamp_ns(),
            quote.ts_init,
            text(quote.bid_price.as_decimal()),
            text(quote.ask_price.as_decimal()),
            text(totals["USDT"]),
            text(free["USDT"]),
            text(totals["BTC"]),
            text(free["BTC"]),
            text(position_q),
            tuple(sorted(orders, key=lambda v: v.order_id)),
            tuple(sorted(fills.values(), key=lambda v: (v.time_ns, v.order_id, v.trade_id))),
            expected_quote == totals["USDT"] and expected_base == totals["BTC"] == position_q,
            source_event_time_ns=quote.ts_event,
            bid_size=text(quote.bid_size.as_decimal()),
            ask_size=text(quote.ask_size.as_decimal()),
        )
        return replace(snapshot, seal=self._signature(snapshot))
