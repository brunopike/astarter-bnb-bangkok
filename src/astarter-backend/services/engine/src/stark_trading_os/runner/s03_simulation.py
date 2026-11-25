"""Finite S03 native simulation. Raw synthetic data is never execution authority."""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from decimal import Decimal
from importlib.metadata import version
from pathlib import Path
from time import perf_counter_ns
from typing import Any, cast

from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.execution import FillModel, MakerTakerFeeModel, StaticLatencyModel
from nautilus_trader.model import (
    AccountType,
    BookType,
    ClientId,
    ClientOrderId,
    CurrencyPair,
    CustomData,
    DataType,
    Money,
    OmsType,
    Price,
    Quantity,
    QuoteTick,
)
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.astarter.transaction_service import AdmissionContext
from stark_trading_os.control.database import _immediate_transaction
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.s03_bridge import S03BridgeControl
from stark_trading_os.domain.astarter_simulation import (
    TERMINAL,
    AstarterBlocked,
    AstarterConflict,
    OrderCommand,
    Reservation,
    amount,
    encode,
)
from stark_trading_os.domain.s03_bridge import (
    S03_FINITE_AUTHORITY,
    S03BridgePlan,
    S03BridgeRejected,
    S03DataManifest,
    S03Owner,
    S03RawBar,
    S03RawNews,
    S03RawQuote,
    _native_bar,
    local_simulation_case,
    s03_bound_source_event_time,
    s03_entry_locked,
    s03_quote_clock,
    validate_s03_plan,
)
from stark_trading_os.runner.astarter_facts import NativeFactsSource
from stark_trading_os.runner.astarter_simulation import (
    SimulationEvidence,
    SyntheticControllerBackend,
    _instrument,
    native_order,
)
from stark_trading_os.runner.s03_bridge_source import (
    S03InputEvent,
    S03QuoteBody,
    S03SimulationInputSource,
    s03_event_key,
)
from stark_trading_os.runner.s03_indicators import S03SignalStream
from stark_trading_os.runner.s03_simulation_cases import SCENARIOS, build_s03_case

_MARKER_TYPE = DataType("S03FiniteClockMarker")
_MARKER_CLIENT = ClientId("S03-FINITE")


@dataclass(frozen=True, slots=True)
class _ClockMarker:
    ts_event: int
    ts_init: int


def quote_event(raw: S03RawQuote) -> S03InputEvent:
    event = S03InputEvent(
        kind="QUOTE",
        event_key="0" * 64,
        source_event_time_ns=raw.source_event_time_ns,
        received_time_ns=raw.received_time_ns,
        available_at_ns=raw.received_time_ns,
        quote=S03QuoteBody(
            source_sequence=raw.source_sequence,
            bid=raw.bid,
            ask=raw.ask,
            bid_size=raw.bid_size,
            ask_size=raw.ask_size,
            instrument_id=raw.instrument_id,
        ),
    )
    return event.model_copy(update={"event_key": s03_event_key(event)})


class S03ControllerBackend(SyntheticControllerBackend):
    """Explicit offline host identity; no user-auth or product admission mapping."""

    def resolve_context(self) -> AdmissionContext:
        return AdmissionContext(
            self.identity.assignment.binding.account_id,
            self.identity.assignment.venue_session,
            S03_FINITE_AUTHORITY, "LEGACY_FINITE",
        )


class S03NativeStrategy(Strategy):
    def __new__(cls, **kwargs: object) -> Any:
        return cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False))

    def __init__(
        self,
        *,
        path: Path,
        item: CurrencyPair,
        plan: S03BridgePlan,
        manifest: S03DataManifest,
        scenario: str,
    ) -> None:
        super().__init__(StrategyConfig(manage_stop=False))
        self.path, self.item, self.plan, self.manifest = path, item, plan, manifest
        self.scenario = scenario
        self.source: NativeFactsSource | None = None
        self.feed: S03SimulationInputSource | None = None
        self.owner: S03Owner | None = None
        self.receipt: Reservation | None = None
        self.stream = S03SignalStream(
            plan.parameters,
            plan.s03_instrument_id,
            plan.source_revision,
            seed_close_ns=plan.seed_close_ns,
        )
        self.pending_quote: S03InputEvent | None = None
        self.errors: list[str] = []
        self.trace: list[dict[str, Any]] = []
        self.latencies: list[dict[str, Any]] = []
        self.observations: list[dict[str, Any]] = []
        self.feed_records: list[dict[str, Any]] = []
        self.indicator_bars = self.signal_count = self.entry_submissions = (
            self.native_quote_count
        ) = 0
        self._driving = False
        self._dispatching = False
        self._deferred_events: list[Any] = []
        self._timers: dict[str, int] = {}
        self._last_news: S03RawNews | None = None
        opened_at = perf_counter_ns()
        self.store = ControlStore.open(path)
        self.control_open_ns = perf_counter_ns() - opened_at
        self.control: AstarterControl
        self.bridge: S03BridgeControl

    def on_start(self) -> None:
        self.subscribe_quotes(self.item.id)
        self.subscribe_data(_MARKER_TYPE, client_id=_MARKER_CLIENT)
        self.source = NativeFactsSource(self.item, self)
        self.control = S03ControllerBackend.for_source(self.source).control(self.store)
        self.bridge = S03BridgeControl(self.store, control=self.control)
        self.feed = S03SimulationInputSource.open(
            case_id=self.manifest.case_id,
            case=local_simulation_case(),
            plan=self.plan,
            manifest=self.manifest,
            native=self.source,
        )

    def on_quote(self, quote: QuoteTick) -> None:
        started = perf_counter_ns()
        try:
            if self.source is None or self.pending_quote is None:
                raise RuntimeError("S03_UNADMITTED_NATIVE_QUOTE")
            event, self.pending_quote = self.pending_quote, None
            if quote.ts_init != self.clock.timestamp_ns() or quote.ts_init != event.available_at_ns:
                raise RuntimeError("S03_NATIVE_QUOTE_CLOCK_MISMATCH")
            self.native_quote_count += 1
            if self.owner is None:
                self.owner = self.bridge.activate(self.source, self.plan, self.manifest)
            self.bridge.ingest(self.owner, self.source, event)
            self.trace.append(
                dict(
                    event="QUOTE",
                    time_ns=self.clock.timestamp_ns(),
                    source_event_time_ns=quote.ts_event,
                )
            )
            self._drive()
        except Exception as error:
            self._error(error)
        finally:
            self._latency("QUOTE", started)

    def news(self, raw: S03RawNews) -> None:
        started = perf_counter_ns()
        try:
            if self.owner is None or self.source is None:
                raise RuntimeError("S03_NEWS_BEFORE_NATIVE_BASELINE")
            event = S03InputEvent(
                kind="NEWS",
                event_key="0" * 64,
                news=raw,
                source_event_time_ns=raw.source_event_time_ns,
                received_time_ns=raw.received_time_ns,
                available_at_ns=raw.available_at_ns,
            )
            event = event.model_copy(update={"event_key": s03_event_key(event)})
            try:
                self.bridge.ingest(self.owner, self.source, event)
            except S03BridgeRejected as error:
                if not error.code.startswith("S03_NEWS_"):
                    raise
                # Control has persisted the health fault; existing native protection must run.
                self.trace.append(
                    dict(
                        event="NEWS_REJECTED", reason=error.code, time_ns=self.clock.timestamp_ns()
                    )
                )
            else:
                self._last_news = raw
                self.trace.append(dict(event="NEWS", time_ns=self.clock.timestamp_ns()))
            self._drive()
        except Exception as error:
            self._error(error)
        finally:
            self._latency("NEWS", started)

    def bar(self, raw: S03RawBar, *, warmup: bool = False) -> None:
        started = perf_counter_ns()
        try:
            if not warmup and raw.available_at_ns != self.clock.timestamp_ns():
                raise RuntimeError("S03_BAR_AVAILABLE_CLOCK_MISMATCH")
            observation = self.stream.update(
                _native_bar(raw, self.plan.s03_instrument_id),
                source_revision=self.plan.source_revision,
                available_at_ns=raw.available_at_ns,
            )
            self.indicator_bars += 1
            if warmup:
                return
            self.observations.append(
                dict(
                    bar_close_ns=observation.bar_close_ns,
                    available_at_ns=observation.available_at_ns,
                    prefix_sha256=observation.prefix_sha256,
                    source_revision=observation.source_revision,
                    continuous_bars=observation.continuous_bars,
                    ready=observation.ready,
                    gap_reset=observation.gap_reset,
                    expired=observation.expired,
                    numeric_mode=observation.numeric_mode,
                    # Lossless text of the analysis floats; no conversion of financial amounts.
                    snapshot={
                        k: None if v is None else repr(v)
                        for k, v in observation.snapshot.model_dump().items()
                    },
                    facts=asdict(observation.facts),
                    signal_id=None if observation.signal is None else observation.signal.signal_id,
                )
            )
            if self.owner is None or self.source is None:
                raise RuntimeError("S03_BAR_BEFORE_NATIVE_BASELINE")
            self.bridge.apply_bar(self.owner, self.source, observation)
            self.trace.append(
                dict(event="BAR", time_ns=self.clock.timestamp_ns(), bar_close_ns=raw.bar_close_ns)
            )
            self._drive()
            if observation.signal is not None:
                self.signal_count += 1
                state = self.control.account(self.source.account_id)
                try:
                    receipt = self.bridge.reserve_signal(
                        self.owner,
                        self.source,
                        observation.signal,
                        observation,
                        expected_epoch=state.epoch,
                        expected_sequence=state.latest_sequence,
                    )
                    self.receipt = receipt
                    claim_owner = self.owner
                    command = self.bridge.claim_entry(
                        claim_owner, self.source, receipt.entry_order_id
                    )
                    if command is not None:
                        self._submit(cast(OrderCommand, command), claim_owner=claim_owner)
                except (S03BridgeRejected, AstarterBlocked) as error:
                    self.trace.append(
                        dict(
                            event="SIGNAL_REJECTED",
                            reason=str(error),
                            time_ns=self.clock.timestamp_ns(),
                        )
                    )
            self._drive()
        except Exception as error:
            self._error(error)
        finally:
            if not warmup:
                self._latency("BAR", started)

    @contextmanager
    def _dispatch_as(self, claim_owner: S03Owner) -> Iterator[None]:
        # Serialize takeover with dispatch; a failed send keeps the earlier committed claim unknown.
        try:
            with _immediate_transaction(self.store._connection):
                self.bridge._auth(claim_owner)
                self._dispatching = True
                yield
        finally:
            self._dispatching = False
            events, self._deferred_events = self._deferred_events, []
            for event in events:
                self._native_event(event)

    def _submit(self, command: OrderCommand, *, claim_owner: S03Owner) -> None:
        order = native_order(self, self.item, command)
        with self._dispatch_as(claim_owner):
            if command.role == "ENTRY":
                self.entry_submissions += 1
            self.trace.append(
                dict(
                    event="SUBMIT",
                    role=command.role,
                    order_id=command.order_id,
                    time_ns=self.clock.timestamp_ns(),
                )
            )
            self.submit_order(order)

    def _native_event(self, event: Any) -> None:
        if self._dispatching:
            self._deferred_events.append(event)
            return
        started = perf_counter_ns()
        try:
            if self.owner is None or self.source is None or self.errors:
                return
            self.bridge.resolve_exit(self.owner, self.source)
            self.trace.append(
                dict(
                    event=type(event).__name__,
                    order_id=str(event.client_order_id),
                    time_ns=self.clock.timestamp_ns(),
                )
            )
            self._drive()
        except Exception as error:
            self._error(error)
        finally:
            self._latency("NATIVE", started)

    def on_order_filled(self, event: Any) -> None:
        self._native_event(event)

    def on_order_accepted(self, event: Any) -> None:
        self._native_event(event)

    def on_order_canceled(self, event: Any) -> None:
        self._native_event(event)

    def on_order_rejected(self, event: Any) -> None:
        self._native_event(event)

    def on_order_denied(self, event: Any) -> None:
        self._native_event(event)

    def on_order_expired(self, event: Any) -> None:
        self._native_event(event)

    def on_order_cancel_rejected(self, event: Any) -> None:
        self._native_event(event)

    def _timer(self, event: Any) -> None:
        started = perf_counter_ns()
        try:
            self._timers.pop(str(event.name), None)
            if self.owner is None or self.source is None or self.errors:
                return
            now = self.clock.timestamp_ns()
            life = self.bridge.note_timer(self.owner, now, source=self.source)
            self.trace.append(
                dict(
                    event="TIMER",
                    time_ns=now,
                    reasons=list(life.reasons),
                    quote_time_ns=self.source.capture().quote_time_ns,
                )
            )
            self._drive()
        except Exception as error:
            self._error(error)
        finally:
            self._latency("TIMER", started)

    def _arm(self) -> None:
        if self.owner is None or self.source is None:
            return
        now = self.clock.timestamp_ns()
        life = self.bridge.life(self.owner.run_id)
        deadlines = [self.plan.expires_at_ns]
        deadlines.extend(
            x + 1
            for x in (life.exit_deadline_ns, life.protection_deadline_ns, life.residual_deadline_ns)
            if x is not None
        )
        for audit in self.control.audit(self.source.account_id):
            if audit["kind"] in {"NATIVE_DISPATCH_CLAIMED", "NATIVE_CANCEL_INTENT"}:
                deadline = audit["fact"].get("deadline_ns")
                if deadline is not None:
                    deadlines.append(int(deadline) + 1)
        if life.last_exit_ns is not None and life.exit_target is not None and life.exit_claims < 3:
            deadlines.append(life.last_exit_ns + 250_000_000)
        snapshot = self.source.capture()
        deadlines.append(
            min(snapshot.quote_time_ns, s03_bound_source_event_time(snapshot)) + 2_000_000_001
        )
        if self._last_news is not None:
            deadlines.append(
                min(self._last_news.source_event_time_ns, self._last_news.received_time_ns)
                + 120_000_000_001
            )
        if life.first_fill_ns is not None:
            deadlines.append(
                (life.first_fill_ns // 300_000_000_000 + self.plan.parameters.hold_boundaries)
                * 300_000_000_000
            )
        deadlines.append((now // 86_400_000_000_000 + 1) * 86_400_000_000_000)
        future = [at for at in deadlines if at > now]
        if not future:
            return
        at = min(future)
        if self._timers.get("s03-deadline") == at:
            return
        if "s03-deadline" in self._timers:
            self.clock.cancel_timer("s03-deadline")
        self.clock.set_time_alert_ns("s03-deadline", at, self._timer)
        self._timers["s03-deadline"] = at

    def _drive(self) -> None:
        if self._driving or self.owner is None or self.source is None or self.errors:
            return
        self._driving = True
        claim_owner = self.owner
        try:
            if self.receipt is None:
                return
            life = self.bridge.life(self.owner.run_id)
            account = self.control.account(self.source.account_id)
            if set(account.locks) & {"NATIVE_INTEGRITY", "RECONCILE_REQUIRED"}:
                return
            if not s03_quote_clock(self.source.capture(), self.clock.timestamp_ns()):
                self.trace.append(
                    dict(event="QuoteTrustDeferred", time_ns=self.clock.timestamp_ns())
                )
                return  # Existing native STOP remains; stale data cannot authorize its replacement.
            if life.exit_target is not None:
                self.control.request_exit(self.receipt.intent_id, owner=self.owner)
            protection = self.control.prepare_protection(self.receipt.intent_id, owner=self.owner)
            if protection is not None and self.scenario not in {
                "protection_timeout",
                "timer_no_quote",
            }:
                command = self.control.claim_order(
                    protection.order_id,
                    fence=self.control.account(self.source.account_id).fence,
                    owner=claim_owner,
                    source=self.source,
                )
                if command is not None:
                    self._submit(command, claim_owner=claim_owner)
            account = self.control.account(self.source.account_id)
            if set(account.locks) & {"NATIVE_INTEGRITY", "RECONCILE_REQUIRED"}:
                return
            paused = s03_entry_locked(
                replace(
                    life,
                    reasons=tuple(
                        reason
                        for reason in life.reasons
                        if reason not in {"POSITION_OPEN", "ORDER_UNKNOWN"}
                    ),
                )
            )
            for order in self.control.orders(self.receipt.intent_id):
                if (
                    (life.exit_target is not None or (order.role == "ENTRY" and paused))
                    and order.role != "EXIT"
                    and order.order_id != life.residual_order_id
                    and order.native_state not in TERMINAL
                ):
                    if self.control.claim_cancel(
                        order.order_id,
                        fence=self.control.account(self.source.account_id).fence,
                        owner=claim_owner,
                        source=self.source,
                    ):
                        with self._dispatch_as(claim_owner):
                            self.trace.append(
                                dict(
                                    event="CANCEL",
                                    order_id=order.order_id,
                                    time_ns=self.clock.timestamp_ns(),
                                )
                            )
                            self.cancel_order(ClientOrderId(order.order_id))
            life = self.bridge.life(self.owner.run_id)
            if (
                life.exit_target is not None
                and "EXIT_PENDING" not in life.reasons
                and life.exit_claims < 3
                and (
                    life.last_exit_ns is None
                    or self.clock.timestamp_ns() - life.last_exit_ns >= 250_000_000
                )
                and amount(self.source.capture().position_quantity) > 0
            ):
                try:
                    life = self.bridge.claim_exit(
                        claim_owner, self.source, self.clock.timestamp_ns()
                    )
                    order = next(
                        x
                        for x in self.control.orders(self.receipt.intent_id)
                        if x.order_id == life.exit_order_id
                    )
                    self._submit(
                        OrderCommand(order.order_id, order.intent_id, "EXIT", order.quantity, None),
                        claim_owner=claim_owner,
                    )
                except S03BridgeRejected as error:
                    if error.code not in {
                        "S03_EXIT_UNAVAILABLE",
                        "S03_EXIT_INVALID",
                        "S03_EXIT_UNRESOLVED",
                    }:
                        raise
            life = self.bridge.life(self.owner.run_id)
            if (
                life.exit_claims == 3
                and not life.residual_used
                and "EXIT_PENDING" not in life.reasons
            ):
                try:
                    life = self.bridge.claim_residual(claim_owner, self.source)
                    command = self.control.claim_order(
                        cast(str, life.residual_order_id),
                        fence=self.control.account(self.source.account_id).fence,
                        owner=claim_owner,
                        source=self.source,
                    )
                    if command is not None:
                        self._submit(command, claim_owner=claim_owner)
                except S03BridgeRejected as error:
                    if error.code != "S03_RESIDUAL_UNAVAILABLE":
                        raise
        except S03BridgeRejected as error:
            if error.code != "S03_OWNER_STALE":
                raise
            self.trace.append(
                dict(
                    event="DISPATCH_REJECTED", reason=error.code, time_ns=self.clock.timestamp_ns()
                )
            )
        finally:
            self._driving = False
            self._arm()

    def _error(self, error: Exception) -> None:
        self.errors.append(f"{type(error).__name__}:{error}")

    def _latency(self, path: str, started: int) -> None:
        self.latencies.append(dict(path=path, duration_ns=perf_counter_ns() - started))


def run_s03_simulation(*, database_path: Path, scenario: str = "round_trip") -> SimulationEvidence:
    if scenario not in SCENARIOS:
        raise ValueError("S03_SCENARIO_UNSUPPORTED")
    path = Path(database_path).resolve()
    if path.exists():
        raise ValueError("S03_NEW_SIMULATION_DATABASE_REQUIRED")
    plan, manifest = build_s03_case(scenario)
    validate_s03_plan(plan, manifest, local_simulation_case())
    path.parent.mkdir(parents=True, exist_ok=True)
    # Claim the new file atomically before ControlStore can migrate anything.
    with path.open("xb"):
        pass
    item = _instrument()
    strategy = S03NativeStrategy(
        path=path, item=item, plan=plan, manifest=manifest, scenario=scenario
    )
    engine = None
    evidence: dict[str, Any] | None = None
    try:
        engine = BacktestEngine(
            config=BacktestEngineConfig(
                bypass_logging=True,
                run_analysis=False,
                logging=LoggerConfig(bypass_logging=True),
            )
        )
        engine.add_venue(
            venue=item.id.venue,
            oms_type=OmsType.NETTING,
            account_type=AccountType.CASH,
            base_currency=None,
            starting_balances=[
                Money.zero(item.base_currency),
                Money.from_decimal(Decimal("10000"), item.quote_currency),
            ],
            fill_model=FillModel(),
            fee_model=MakerTakerFeeModel(),
            latency_model=StaticLatencyModel(
                insert_latency_nanos=1_000_000, cancel_latency_nanos=1_000_000
            ),
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

        def advance(at_ns: int) -> None:
            engine.add_data(
                [CustomData(_MARKER_TYPE, _ClockMarker(at_ns, at_ns))], client_id=_MARKER_CLIENT
            )
            engine.run(streaming=True)
            if strategy.clock.timestamp_ns() != at_ns:
                raise RuntimeError("S03_NATIVE_CLOCK_NOT_ADVANCED")

        start_ns = min(x.received_time_ns for x in manifest.quotes)
        warmup_started = perf_counter_ns()
        for raw in manifest.bars:
            if raw.available_at_ns < start_ns:
                strategy.bar(raw, warmup=True)
        warmup_elapsed = perf_counter_ns() - warmup_started
        schedule: list[tuple[int, int, str, Any]] = []
        schedule.extend((x.received_time_ns, 0, "QUOTE", x) for x in manifest.quotes)
        schedule.extend((x.available_at_ns, 1, "NEWS", x) for x in manifest.news)
        schedule.extend(
            (x.available_at_ns, 2, "BAR", x) for x in manifest.bars if x.available_at_ns >= start_ns
        )
        clock: int | None = None
        for at_ns, _, kind, raw in sorted(schedule, key=lambda x: (x[0], x[1])):
            input_started = perf_counter_ns()
            if clock != at_ns:
                advance(at_ns)
                clock = at_ns
            if strategy.errors:
                break
            if kind == "QUOTE":
                if strategy.feed is None:
                    raise RuntimeError("S03_FEED_NOT_ESTABLISHED")
                event = quote_event(raw)
                if event.available_at_ns != strategy.clock.timestamp_ns():
                    raise RuntimeError("S03_FEED_CLOCK_UNBOUND")
                admitted = strategy.feed.admit(event)
                strategy.feed_records.append(asdict(admitted))
                if admitted.disposition == "REJECTED":
                    if strategy.owner is not None and strategy.source is not None:
                        # The existing rejection path persists health without changing native data.
                        try:
                            strategy.bridge.ingest(strategy.owner, strategy.source, event)
                        except S03BridgeRejected as error:
                            strategy.trace.append(
                                dict(
                                    event="QUOTE_REJECTED",
                                    reason=error.code,
                                    time_ns=strategy.clock.timestamp_ns(),
                                )
                            )
                        strategy._drive()
                    strategy._latency("INPUT_QUOTE_REJECTED", input_started)
                    continue
                strategy.pending_quote = event
                engine.add_data(
                    [
                        QuoteTick(
                            item.id,
                            Price.from_decimal_dp(Decimal(raw.bid), 2),
                            Price.from_decimal_dp(Decimal(raw.ask), 2),
                            Quantity.from_decimal_dp(Decimal(raw.bid_size), 5),
                            Quantity.from_decimal_dp(Decimal(raw.ask_size), 5),
                            raw.source_event_time_ns,
                            raw.received_time_ns,
                        )
                    ]
                )
                engine.run(streaming=True)
            elif kind == "NEWS":
                strategy.news(raw)
            else:
                strategy.bar(raw)
            strategy._latency(f"INPUT_{kind}", input_started)
        if scenario == "timer_no_quote" and not strategy.errors:
            advance(plan.expires_at_ns - 1)
        source, owner = strategy.source, strategy.owner
        if source is None or owner is None:
            raise RuntimeError("S03_NATIVE_BASELINE_NOT_ESTABLISHED")
        reconciliation_rejection = None
        try:
            strategy.bridge.resolve_exit(owner, source)
        except (AstarterBlocked, AstarterConflict, S03BridgeRejected) as error:
            # A fenced driver reports existing facts without borrowing the new owner's writes.
            reconciliation_rejection = str(error)
            strategy._error(error)
        snap = source.capture()
        source.verify(snap)
        settlement = duplicate = None
        settlement_rejection = None
        live_orders = sum(o.state not in TERMINAL for o in snap.orders)
        if (
            reconciliation_rejection is None
            and strategy.receipt is not None
            and not live_orders
            and amount(snap.position_quantity) == 0
        ):
            try:
                settlement = strategy.control.settle(
                    source.account_id, request_id="s03-close-A", owner=owner, source=source
                )
                duplicate = strategy.control.settle(
                    source.account_id, request_id="s03-close-B", owner=owner, source=source
                )
            except (AstarterBlocked, AstarterConflict, S03BridgeRejected) as error:
                # Native flatness cannot settle a durable, still-unknown dispatch claim.
                settlement_rejection = str(error)
        account = strategy.control.account(source.account_id)
        life = strategy.bridge.life(owner.run_id)
        orders = (
            () if strategy.receipt is None else strategy.control.orders(strategy.receipt.intent_id)
        )
        status = (
            "FAILED"
            if strategy.errors
            else "NO_OPPORTUNITY"
            if strategy.receipt is None
            else "RECONCILIATION_REQUIRED"
            if ("RECONCILE_REQUIRED" in account.locks)
            else "COMPLETE"
            if settlement is not None and snap.fills
            else "NO_FILL"
            if settlement is not None
            else "FLAT_UNSETTLED"
            if amount(snap.position_quantity) == 0
            else "OPEN_POSITION"
        )
        evidence = dict(
            scope="S03_FINITE_NATIVE_SIMULATION",
            scenario=scenario,
            synthetic_data=True,
            status=status,
            real_trading_enabled=False,
            fast_path_model_calls=0,
            plan=plan.model_dump(mode="json"),
            manifest_sha256=plan.manifest_sha256,
            native_profile=source.bound_instrument(),
            matching_assumptions=dict(
                engine_version=version("nautilus_trader"),
                insert_latency_ns=1_000_000,
                cancel_latency_ns=1_000_000,
                account_type="CASH",
                oms_type="NETTING",
                book_type="L1_MBP",
                bar_execution=False,
                trade_execution=False,
                liquidity_consumption=True,
                allow_cash_borrowing=False,
                use_reduce_only=False,
                use_market_order_acks=False,
                use_random_ids=False,
                fee_model="MakerTakerFeeModel",
                fill_model="FillModel",
                clock="finite native streaming clock; original source/receipt retained",
                frozen_spec_delta=(
                    "1ms insert/cancel latency, not the historical zero-latency assumption"
                ),
            ),
            indicator_bars=strategy.indicator_bars,
            signal_count=strategy.signal_count,
            entry_submissions=strategy.entry_submissions,
            native_quote_count=strategy.native_quote_count,
            protected_acceptances=sum(
                o.role == "STOP"
                and o.accepted_at_ns is not None
                and o.deadline_ns is not None
                and o.accepted_at_ns <= o.deadline_ns
                for o in orders
            ),
            reservation=None if strategy.receipt is None else asdict(strategy.receipt),
            native_snapshot=asdict(snap),
            account=asdict(account),
            life=asdict(life),
            settlement=None if settlement is None else asdict(settlement),
            duplicate_settlement=None if duplicate is None else asdict(duplicate),
            settlement_rejection=settlement_rejection,
            reconciliation_rejection=reconciliation_rejection,
            live_orders=live_orders,
            open_positions=len(engine.cache.positions_open(instrument_id=item.id)),
            errors=strategy.errors,
            trace=strategy.trace,
            observations=strategy.observations,
            feed_records=strategy.feed_records,
            latency_samples=strategy.latencies,
            initialization=dict(
                control_open_ns=strategy.control_open_ns, historical_warmup_ns=warmup_elapsed
            ),
            audit=strategy.control.audit(source.account_id),
            s03_audit=[
                dict(seq=row[0], kind=row[1], fact=json.loads(bytes(row[2])))
                for row in strategy.store._connection.execute(
                    "SELECT seq,kind,fact_bytes FROM s03_audit WHERE run_id=? ORDER BY seq",
                    (owner.run_id,),
                )
            ],
            native_orders_csv=engine.generate_orders_report().to_csv(),
            native_fills_csv=engine.generate_fills_report().to_csv(),
            native_positions_csv=engine.generate_positions_report().to_csv(),
            native_account_csv=engine.generate_account_report(item.id.venue).to_csv(),
        )
    finally:
        try:
            if strategy.source is not None:
                strategy.source.close()
        finally:
            try:
                strategy.store.close()
            finally:
                if engine is not None:
                    try:
                        engine.end()
                    finally:
                        engine.dispose()
    if evidence is None:
        raise RuntimeError("S03_SIMULATION_EVIDENCE_MISSING")
    evidence["cleanup"] = dict(source_closed=True, store_closed=True, engine_disposed=True)
    return SimulationEvidence(encode(evidence), True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Finite synthetic S03 native simulation")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="round_trip")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("S03_NEW_EVIDENCE_PATH_REQUIRED")
    result = run_s03_simulation(database_path=args.database, scenario=args.scenario)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("xb") as output:
        output.write(result.evidence_bytes + b"\n")
    print(
        encode(
            dict(engine_disposed=result.engine_disposed, evidence_path=str(args.output.resolve()))
        ).decode()
    )


if __name__ == "__main__":
    main()
