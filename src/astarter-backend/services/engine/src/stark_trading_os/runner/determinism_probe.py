"""The single server-owned strategy registered by the v0.1 runner."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from nautilus_trader.config import RiskEngineConfig
from nautilus_trader.core import UUID4
from nautilus_trader.model import (
    ClientOrderId,
    InstrumentId,
    LimitOrder,
    MarketOrder,
    OrderFilled,
    OrderSide,
    OrderStatus,
    Price,
    Quantity,
    QuoteTick,
    TimeInForce,
)
from nautilus_trader.trading import ImportableStrategyConfig, Strategy, StrategyConfig

from stark_trading_os.audit.canonical_json import canonical_decimal_string
from stark_trading_os.domain.models import (
    CatalogInstrumentV1,
    CatalogSourceRecordV1,
    DeterminismProbeConfigV1,
    ProbeRiskPolicyV1,
)
from stark_trading_os.runner.protocol import RunnerCandidateV1, sanitize_native_reason

PROBE_STRATEGY_PATH = (
    "stark_trading_os.runner.determinism_probe:DeterminismProbeStrategy"
)
PROBE_CONFIG_PATH = "stark_trading_os.runner.determinism_probe:DeterminismProbeConfig"

_OBSERVATION_CONTEXT: ProbeObservationContext | None = None


@dataclass
class ProbeObservationContext:
    run_id: str
    input_manifest_hash: str
    catalog_revision: str
    instrument: CatalogInstrumentV1
    records: tuple[CatalogSourceRecordV1, ...]

    def __post_init__(self) -> None:
        self.candidates: list[RunnerCandidateV1] = []
        self._next_source_seq = 1
        self._record_cursor = 0
        self._quote_records: dict[tuple[object, ...], deque[CatalogSourceRecordV1]] = (
            defaultdict(deque)
        )
        for record in self.records:
            self._quote_records[_record_quote_key(record)].append(record)

    def bind_native_instrument(self, instrument: Any) -> None:
        expected = self.instrument
        actual = (
            str(instrument.id),
            str(instrument.raw_symbol),
            str(instrument.id.venue),
            str(instrument.base_currency),
            str(instrument.quote_currency),
            instrument.price_precision,
            instrument.size_precision,
            str(instrument.price_increment),
            str(instrument.size_increment),
            str(instrument.min_quantity),
            str(instrument.margin_init),
            str(instrument.margin_maint),
            str(instrument.maker_fee),
            str(instrument.taker_fee),
            str(instrument.ts_event),
            str(instrument.ts_init),
        )
        declared = (
            expected.instrument_id,
            expected.raw_symbol,
            expected.venue,
            expected.base_currency,
            expected.quote_currency,
            expected.price_precision,
            expected.size_precision,
            expected.price_increment,
            expected.size_increment,
            expected.minimum_quantity,
            expected.margin_init,
            expected.margin_maint,
            expected.maker_fee,
            expected.taker_fee,
            expected.ts_event_ns,
            expected.ts_available_ns,
        )
        if actual != declared:
            raise RuntimeError("NATIVE_INSTRUMENT_CATALOG_MISMATCH")

    def observe_quote(
        self,
        quote: QuoteTick,
        *,
        decision_ts_ns: int,
    ) -> CatalogSourceRecordV1:
        quote_key = _native_quote_key(quote)
        matches = self._quote_records.get(quote_key)
        if matches is None or not matches:
            raise RuntimeError("QUOTE_IDENTITY_UNMAPPED")
        if self._record_cursor >= len(self.records):
            raise RuntimeError("QUOTE_IDENTITY_UNMAPPED")
        expected = self.records[self._record_cursor]
        if quote_key != _record_quote_key(expected) or matches[0] != expected:
            raise RuntimeError("QUOTE_SOURCE_ORDER_INVALID")
        record = matches.popleft()
        self._record_cursor += 1
        self.emit(
            event_type="run.progress",
            ts_event_ns=record.ts_event_ns,
            payload={
                "progress": "decision",
                "decision_ts_ns": str(decision_ts_ns),
                "quote_identity": {
                    "instrument_id": record.instrument_id,
                    "ts_event_ns": record.ts_event_ns,
                    "ts_available_ns": record.ts_available_ns,
                    "source_seq": record.source_seq,
                    "source_revision": record.source_revision,
                    "record_hash": record.record_hash,
                },
            },
        )
        return record

    def emit(self, *, event_type: str, ts_event_ns: str, payload: dict[str, object]) -> None:
        self.candidates.append(
            RunnerCandidateV1.model_validate(
                {
                    "schema": "RunnerCandidate.v1",
                    "run_id": self.run_id,
                    "input_manifest_hash": self.input_manifest_hash,
                    "catalog_revision": self.catalog_revision,
                    "source_seq": self._next_source_seq,
                    "ts_event_ns": ts_event_ns,
                    "type": event_type,
                    "payload": payload,
                }
            )
        )
        self._next_source_seq += 1

    def require_all_quotes_observed(self) -> None:
        if self._record_cursor != len(self.records) or any(
            records for records in self._quote_records.values()
        ):
            raise RuntimeError("QUOTE_IDENTITY_UNOBSERVED")


def install_probe_observation_context(context: ProbeObservationContext) -> None:
    global _OBSERVATION_CONTEXT
    if _OBSERVATION_CONTEXT is not None:
        raise RuntimeError("PROBE_CONTEXT_ALREADY_INSTALLED")
    _OBSERVATION_CONTEXT = context


def clear_probe_observation_context() -> None:
    global _OBSERVATION_CONTEXT
    _OBSERVATION_CONTEXT = None


class DeterminismProbeConfig(StrategyConfig):
    _CUSTOM_FIELDS = (
        "instrument_id",
        "entry_limit_price",
        "entry_quantity",
        "metric_round_trip_quantity",
        "metric_round_trips",
        "risk_probe_quantity",
        "venue_rejection_quantity",
    )

    def __new__(cls, *args: Any, **kwargs: Any) -> DeterminismProbeConfig:
        for field in cls._CUSTOM_FIELDS:
            kwargs.pop(field, None)
        return super().__new__(cls, *args, **kwargs)

    def __init__(
        self,
        instrument_id: str,
        entry_limit_price: str,
        entry_quantity: str,
        metric_round_trip_quantity: str,
        metric_round_trips: int,
        risk_probe_quantity: str,
        venue_rejection_quantity: str,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.instrument_id = instrument_id
        self.entry_limit_price = entry_limit_price
        self.entry_quantity = entry_quantity
        self.metric_round_trip_quantity = metric_round_trip_quantity
        self.metric_round_trips = metric_round_trips
        self.risk_probe_quantity = risk_probe_quantity
        self.venue_rejection_quantity = venue_rejection_quantity


class DeterminismProbeStrategy(Strategy):
    def __init__(self, config: DeterminismProbeConfig) -> None:
        super().__init__(config)
        self.instrument_id = InstrumentId.from_str(config.instrument_id)
        self._entry_limit_price_value = Decimal(config.entry_limit_price)
        self._entry_quantity_value = Decimal(config.entry_quantity)
        self._metric_round_trip_quantity_value = Decimal(
            config.metric_round_trip_quantity
        )
        self.metric_round_trips = config.metric_round_trips
        self._risk_probe_quantity_value = Decimal(config.risk_probe_quantity)
        self._venue_rejection_quantity_value = Decimal(
            config.venue_rejection_quantity
        )
        self.entry_limit_price: Price | None = None
        self.entry_quantity: Quantity | None = None
        self.metric_round_trip_quantity: Quantity | None = None
        self.risk_probe_quantity: Quantity | None = None
        self.venue_rejection_quantity: Quantity | None = None
        self._quote_count = 0
        self._entry_cancelled = False
        self._entry_cancel_requested = False
        self._metric_position_id: Any | None = None
        self._metric_rounds_opened = 0
        self._metric_rounds_closed = 0

    def on_start(self) -> None:
        context = _observation_context()
        instrument = self.cache.instrument(self.instrument_id)
        if instrument is None:
            raise RuntimeError("NATIVE_INSTRUMENT_CACHE_MISS")
        context.bind_native_instrument(instrument)
        self.entry_limit_price = instrument.make_price(self._entry_limit_price_value)
        self.entry_quantity = instrument.make_qty(self._entry_quantity_value)
        self.metric_round_trip_quantity = instrument.make_qty(
            self._metric_round_trip_quantity_value
        )
        self.risk_probe_quantity = instrument.make_qty(self._risk_probe_quantity_value)
        self.venue_rejection_quantity = instrument.make_qty(
            self._venue_rejection_quantity_value
        )
        self.subscribe_quotes(self.instrument_id)

    def on_quote(self, quote: QuoteTick) -> None:
        context = _observation_context()
        record = context.observe_quote(quote, decision_ts_ns=self.clock.timestamp_ns())
        self._quote_count += 1
        if self._quote_count == 1:
            self._submit_initial_probes()
            return
        if record.source_seq == 7:
            return
        if not self._entry_cancelled:
            return
        if (
            self._metric_position_id is None
            and self._metric_rounds_opened < self.metric_round_trips
        ):
            self._metric_rounds_opened += 1
            self.submit_order(
                self._market_order(
                    client_order_id=f"METRIC-OPEN-{self._metric_rounds_opened}",
                    side=OrderSide.BUY,
                    quantity=_required_quantity(self.metric_round_trip_quantity),
                )
            )
        elif (
            self._metric_position_id is not None
            and self._metric_rounds_closed < self._metric_rounds_opened
        ):
            self.submit_order(
                self._market_order(
                    client_order_id=f"METRIC-CLOSE-{self._metric_rounds_opened}",
                    side=OrderSide.SELL,
                    quantity=_required_quantity(self.metric_round_trip_quantity),
                ),
                position_id=self._metric_position_id,
            )

    def on_order_submitted(self, event: Any) -> None:
        order = self.cache.order(event.client_order_id)
        if order is None:
            raise RuntimeError("NATIVE_ORDER_CACHE_MISS")
        payload: dict[str, object] = {
            "client_order_id": str(event.client_order_id),
            "instrument_id": str(event.instrument_id),
            "side": str(order.side),
            "type": str(order.order_type),
            "quantity": _native_decimal(order.quantity),
            "status": str(order.status),
        }
        if order.has_price:
            payload["price"] = _native_decimal(order.price)
        elif str(order.order_type) != "MARKET":
            raise RuntimeError("NATIVE_PRICED_ORDER_PRICE_MISSING")
        self._emit_native(event, "order.submitted", payload)

    def on_order_accepted(self, event: Any) -> None:
        self._emit_native(
            event,
            "order.accepted",
            {
                "client_order_id": str(event.client_order_id),
                "instrument_id": str(event.instrument_id),
                "venue_order_id": str(event.venue_order_id),
                "status": "ACCEPTED",
            },
        )

    def on_order_rejected(self, event: Any) -> None:
        self._emit_native(
            event,
            "order.rejected",
            {
                "client_order_id": str(event.client_order_id),
                "instrument_id": str(event.instrument_id),
                "reason": sanitize_native_reason(str(event.reason)),
                "status": "REJECTED",
            },
        )

    def on_order_denied(self, event: Any) -> None:
        self._emit_native(
            event,
            "risk.rejected",
            {
                "rule_id": "NAUTILUS_MAX_NOTIONAL_PER_ORDER",
                "reason": sanitize_native_reason(str(event.reason)),
                "client_order_id": str(event.client_order_id),
                "instrument_id": str(event.instrument_id),
            },
        )

    def on_order_filled(self, event: OrderFilled) -> None:
        order = self.cache.order(event.client_order_id)
        if order is None:
            raise RuntimeError("NATIVE_ORDER_CACHE_MISS")
        event_type = (
            "order.partially_filled"
            if order.status is OrderStatus.PARTIALLY_FILLED
            else "order.filled"
        )
        payload: dict[str, object] = {
            "client_order_id": str(event.client_order_id),
            "instrument_id": str(event.instrument_id),
            "last_qty": _native_decimal(event.last_qty),
            "last_px": _native_decimal(event.last_px),
            "filled_qty": _native_decimal(order.filled_qty),
            "trade_id": str(event.trade_id),
            "commission": _native_money(event.commission),
            "currency": str(event.currency),
            "liquidity_side": str(event.liquidity_side),
        }
        self._emit_native(event, event_type, payload)
        if (
            str(event.client_order_id) == "ENTRY-PARTIAL"
            and order.status is OrderStatus.PARTIALLY_FILLED
            and not self._entry_cancel_requested
        ):
            self._entry_cancel_requested = True
            self.cancel_order(event.client_order_id)

    def on_order_pending_cancel(self, event: Any) -> None:
        self._emit_native(
            event,
            "order.cancel_pending",
            {
                "client_order_id": str(event.client_order_id),
                "instrument_id": str(event.instrument_id),
                "status": "PENDING_CANCEL",
            },
        )

    def on_order_canceled(self, event: Any) -> None:
        self._emit_native(
            event,
            "order.cancelled",
            {
                "client_order_id": str(event.client_order_id),
                "instrument_id": str(event.instrument_id),
                "status": "CANCELED",
            },
        )
        if str(event.client_order_id) == "ENTRY-PARTIAL":
            self._entry_cancelled = True

    def on_position_opened(self, event: Any) -> None:
        self._emit_native(event, "position.opened", _position_payload(event, opened=True))
        if str(event.opening_order_id).startswith("METRIC-OPEN-"):
            self._metric_position_id = event.position_id

    def on_position_changed(self, event: Any) -> None:
        self._emit_native(event, "position.changed", _position_payload(event, opened=False))

    def on_position_closed(self, event: Any) -> None:
        payload = _position_payload(event, opened=False)
        payload["realized_pnl"] = _native_money(event.realized_pnl)
        self._emit_native(event, "position.closed", payload)
        if event.position_id == self._metric_position_id:
            self._metric_rounds_closed += 1
            self._metric_position_id = None

    def _submit_initial_probes(self) -> None:
        entry_quantity = _required_quantity(self.entry_quantity)
        entry_limit_price = _required_price(self.entry_limit_price)
        risk_probe_quantity = _required_quantity(self.risk_probe_quantity)
        venue_rejection_quantity = _required_quantity(
            self.venue_rejection_quantity
        )
        self.submit_order(
            self._limit_order(
                client_order_id="ENTRY-PARTIAL",
                side=OrderSide.BUY,
                quantity=entry_quantity,
                price=entry_limit_price,
                post_only=False,
            )
        )
        self.submit_order(
            self._limit_order(
                client_order_id="RISK-PROBE",
                side=OrderSide.BUY,
                quantity=risk_probe_quantity,
                price=entry_limit_price,
                post_only=False,
            )
        )
        self.submit_order(
            self._limit_order(
                client_order_id="VENUE-REJECTION",
                side=OrderSide.BUY,
                quantity=venue_rejection_quantity,
                price=entry_limit_price,
                post_only=True,
            )
        )

    def _limit_order(
        self,
        *,
        client_order_id: str,
        side: OrderSide,
        quantity: Quantity,
        price: Price,
        post_only: bool,
    ) -> LimitOrder:
        if self.trader_id is None:
            raise RuntimeError("NATIVE_TRADER_ID_MISSING")
        return LimitOrder(
            trader_id=self.trader_id,
            strategy_id=self.strategy_id,
            instrument_id=self.instrument_id,
            client_order_id=ClientOrderId(client_order_id),
            order_side=side,
            quantity=quantity,
            price=price,
            time_in_force=TimeInForce.GTC,
            post_only=post_only,
            reduce_only=False,
            quote_quantity=False,
            init_id=UUID4(),
            ts_init=self.clock.timestamp_ns(),
        )

    def _market_order(
        self,
        *,
        client_order_id: str,
        side: OrderSide,
        quantity: Quantity,
    ) -> MarketOrder:
        if self.trader_id is None:
            raise RuntimeError("NATIVE_TRADER_ID_MISSING")
        return MarketOrder(
            trader_id=self.trader_id,
            strategy_id=self.strategy_id,
            instrument_id=self.instrument_id,
            client_order_id=ClientOrderId(client_order_id),
            order_side=side,
            quantity=quantity,
            init_id=UUID4(),
            ts_init=self.clock.timestamp_ns(),
            time_in_force=TimeInForce.GTC,
            reduce_only=False,
            quote_quantity=False,
        )

    @staticmethod
    def _emit_native(event: Any, event_type: str, payload: dict[str, object]) -> None:
        _observation_context().emit(
            event_type=event_type,
            ts_event_ns=str(event.ts_event),
            payload=payload,
        )


def build_probe_registration(
    *,
    instrument_id: str,
    definition: DeterminismProbeConfigV1,
) -> ImportableStrategyConfig:
    validated = DeterminismProbeConfigV1.model_validate(
        definition.model_dump(mode="json", by_alias=True)
    )
    InstrumentId.from_str(instrument_id)
    return ImportableStrategyConfig(
        strategy_path=PROBE_STRATEGY_PATH,
        config_path=PROBE_CONFIG_PATH,
        config={
            "instrument_id": instrument_id,
            **validated.model_dump(mode="json", by_alias=True),
        },
    )


def build_probe_risk_config(
    *,
    instrument_id: str,
    policy: ProbeRiskPolicyV1,
) -> RiskEngineConfig:
    validated = ProbeRiskPolicyV1.model_validate(
        policy.model_dump(mode="json", by_alias=True)
    )
    InstrumentId.from_str(instrument_id)
    return RiskEngineConfig(
        bypass=False,
        max_notional_per_order={instrument_id: validated.max_notional},
    )


def _observation_context() -> ProbeObservationContext:
    if _OBSERVATION_CONTEXT is None:
        raise RuntimeError("PROBE_CONTEXT_NOT_INSTALLED")
    return _OBSERVATION_CONTEXT


def _record_quote_key(record: CatalogSourceRecordV1) -> tuple[object, ...]:
    return (
        record.instrument_id,
        record.bid_price,
        record.ask_price,
        record.bid_size,
        record.ask_size,
        int(record.ts_event_ns),
        int(record.ts_available_ns),
    )


def _native_quote_key(quote: QuoteTick) -> tuple[object, ...]:
    return (
        str(quote.instrument_id),
        str(quote.bid_price),
        str(quote.ask_price),
        str(quote.bid_size),
        str(quote.ask_size),
        quote.ts_event,
        quote.ts_init,
    )


def _position_payload(event: Any, *, opened: bool) -> dict[str, object]:
    client_order_id = event.opening_order_id if opened else getattr(
        event, "closing_order_id", None
    )
    if client_order_id is None:
        client_order_id = event.opening_order_id
    return {
        "position_id": str(event.position_id),
        "instrument_id": str(event.instrument_id),
        "side": str(event.side),
        "quantity": _native_decimal(event.quantity),
        "price": _native_decimal(event.last_px),
        "client_order_id": str(client_order_id),
    }


def _required_price(value: Price | None) -> Price:
    if value is None:
        raise RuntimeError("NATIVE_PRICE_NOT_BOUND")
    return value


def _required_quantity(value: Quantity | None) -> Quantity:
    if value is None:
        raise RuntimeError("NATIVE_QUANTITY_NOT_BOUND")
    return value


def _native_decimal(value: object) -> str:
    return canonical_decimal_string(Decimal(str(value)))


def _native_money(value: object) -> str:
    amount, currency = str(value).rsplit(" ", maxsplit=1)
    return f"{canonical_decimal_string(Decimal(amount))} {currency}"
