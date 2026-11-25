"""Finite BTC native simulator using the production Control risk/settlement service.

Synthetic quotes, not live market data. No HTTP run registration or live adapter.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict, dataclass, replace
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

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
    OrderSide,
    Price,
    Quantity,
    QuoteTick,
    TimeInForce,
    TriggerType,
)
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.astarter.strategy_repository import ScopeAssignment
from stark_trading_os.control.astarter.transaction_service import (
    AdmissionContext,
    AdmissionUpdate,
    ControllerIdentity,
)
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    TERMINAL,
    AstarterBlocked,
    Opportunity,
    OrderCommand,
    Reservation,
    SimulationPolicy,
    amount,
    encode,
    text,
)
from stark_trading_os.domain.strategy_contracts import PrivateBinding
from stark_trading_os.runner.astarter_facts import NativeFactsSource

SCENARIOS = frozenset(
    {
        "round_trip",
        "partial_stop",
        "stop",
        "zero",
        "recover",
        "halt_exit",
        "stop_rejected",
        "stop_late",
        "cancel_race",
        "expired_dispatch",
        "accepted_at_deadline",
        "recover_after_settlement",
        "recover_before_protection",
        "exit_above_cap",
        "revoke_holding",
        "open_dip",
        "partial_exit",
        "recover_before_exit",
        "integrity_hold",
        "reconcile_pause",
        "integrity_after_cancel",
        "short_ttl",
    }
)
START_NS = 1_700_000_000_000_000_000


@dataclass(frozen=True, slots=True)
class SyntheticControllerBackend:
    """Finite fixture wiring only; not a user/authentication issuer."""

    identity: ControllerIdentity

    @classmethod
    def for_source(cls, source: NativeFactsSource) -> SyntheticControllerBackend:
        return cls(ControllerIdentity(
            ScopeAssignment(
                binding=PrivateBinding(tenant_id="finite-native-fixture",
                                       account_id=source.account_id, environment="OFFLINE"),
                venue_session=source.venue_session,
                authority_ref="SYNTHETIC-OWNERSHIP-NOT-AUTH",
            ),
            "fixture-" + uuid4().hex,
            1,
        ))

    def resolve_controller(self) -> ControllerIdentity:
        return self.identity

    def resolve_context(self) -> AdmissionContext:
        return AdmissionContext(
            self.identity.assignment.binding.account_id, self.identity.assignment.venue_session,
            "SYNTHETIC-LEGACY-FINITE-NOT-Q01", "LEGACY_FINITE",
        )

    def resolve_update(self) -> AdmissionUpdate:
        raise AstarterBlocked("ASTARTER_LEGACY_NOT_PLAN_ADMISSION")

    def control(self, store: ControlStore) -> AstarterControl:
        # Explicit finite fixture composition root, never identity-only admission.
        return AstarterControl(store, backend=self, admission_backend=self)


@dataclass(frozen=True, slots=True)
class SimulationEvidence:
    evidence_bytes: bytes
    engine_disposed: bool


def native_order(strategy: Strategy, item: CurrencyPair, command: OrderCommand) -> Any:
    """Build the existing native order only after the caller commits its claim."""
    q = Quantity.from_decimal_dp(Decimal(command.quantity), item.size_precision)
    if q.as_decimal() != Decimal(command.quantity):
        raise ValueError("ASTARTER_NATIVE_QUANTITY_ROUNDED")
    price = None
    if command.role in {"ENTRY", "STOP"}:
        price = Price.from_decimal_dp(Decimal(cast(str, command.price)), item.price_precision)
        if price.as_decimal() != Decimal(cast(str, command.price)):
            raise ValueError("ASTARTER_NATIVE_PRICE_ROUNDED")
    if command.role == "ENTRY":
        order = strategy.order_factory.limit(
            instrument_id=item.id,
            quantity=q,
            client_order_id=ClientOrderId(command.order_id),
            order_side=OrderSide.BUY,
            price=cast(Price, price),
            time_in_force=TimeInForce.IOC,
        )
    elif command.role == "STOP":
        order = strategy.order_factory.stop_market(
            instrument_id=item.id,
            quantity=q,
            client_order_id=ClientOrderId(command.order_id),
            order_side=OrderSide.SELL,
            trigger_price=cast(Price, price),
            trigger_type=TriggerType.BID_ASK,
            time_in_force=TimeInForce.GTC,
            reduce_only=False,
        )
    else:
        order = strategy.order_factory.market(
            instrument_id=item.id,
            quantity=q,
            client_order_id=ClientOrderId(command.order_id),
            order_side=OrderSide.SELL,
            time_in_force=TimeInForce.IOC,
            reduce_only=False,
        )
    return order


def _instrument() -> CurrencyPair:
    return CurrencyPair.from_dict(
        dict(
            type="CurrencyPair",
            id="BTC/USDT.SIM",
            raw_symbol="BTC/USDT",
            base_currency="BTC",
            quote_currency="USDT",
            price_precision=2,
            size_precision=5,
            price_increment="0.01",
            size_increment="0.00001",
            multiplier="1",
            maker_fee="0.001",
            taker_fee="0.001",
            margin_init="0",
            margin_maint="0",
            info={},
            ts_event=START_NS,
            ts_init=START_NS,
            lot_size="0.00001",
            min_quantity="0.00001",
            max_quantity=None,
            min_notional=None,
            max_notional=None,
            min_price=None,
            max_price=None,
            tick_scheme=None,
        )
    )


class AstarterNativeStrategy(Strategy):
    def __new__(cls, **kwargs: Any) -> AstarterNativeStrategy:
        return cast(
            AstarterNativeStrategy,
            cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False)),
        )

    def __init__(
        self, *, database_path: Path, scenario: str, instrument: CurrencyPair, component_id: str
    ) -> None:
        super().__init__(StrategyConfig(manage_stop=False))
        self.path, self.scenario, self.item, self.component_id = (
            database_path,
            scenario,
            instrument,
            component_id,
        )
        self.store = ControlStore.open(database_path)
        self.control = AstarterControl(self.store)
        self.source: NativeFactsSource | None = None
        self.binding: str | None = None
        self.receipt: Reservation | None = None
        self.policy = SimulationPolicy()
        if scenario == "short_ttl":
            self.policy = replace(self.policy, snapshot_ttl_ns=1_000_000_000)
        self.sequence = 0
        self.errors: list[str] = []
        self.trace: list[dict[str, Any]] = []
        self.entry_submissions = 0
        self.controller_reopened = False
        self.recovery_process: dict[str, Any] | None = None
        self._driving = False
        self._halted_once = False

    def on_start(self) -> None:
        self.subscribe_quotes(self.item.id)

    def _error(self, error: Exception) -> None:
        self.errors.append(type(error).__name__ + ":" + str(error))
        if self.source is not None:
            try:
                self.control.halt(self.source.account_id, "NATIVE_INTEGRITY")
            except Exception as halt_error:
                self.errors.append("ASTARTER_HALT_PERSIST_FAILED:" + type(halt_error).__name__)

    def on_quote(self, quote: QuoteTick) -> None:
        if self.errors:
            return
        try:
            self.sequence += 1
            if self.source is None:
                self.source = NativeFactsSource(self.item, self)
                self.control = SyntheticControllerBackend.for_source(self.source).control(
                    self.store
                )
                self.binding = self.control.activate(
                    self.source, self.policy, component_id=self.component_id
                )
                state = self.control.account(self.source.account_id)
                op = Opportunity(
                    "btc-synthetic-opportunity", quote.ts_init, quote.ts_init + 5_000_000_000, "5"
                )
                self.receipt = self.control.reserve(
                    self.binding,
                    op,
                    expected_epoch=state.epoch,
                    expected_sequence=state.latest_sequence,
                    fence=self.control.controller_identity.fence,
                )
                if self.scenario != "expired_dispatch":
                    self._send(self.receipt.entry_order_id)
            else:
                self.control.observe(self.source)
            if self.scenario == "recover" and self.sequence == 2:
                self._recover_controller()
            if self.scenario == "recover_before_protection" and self.sequence == 3:
                self._recover_controller()
            if self.scenario == "recover_before_exit" and self.sequence == 3:
                self._recover_controller()
            if self.scenario == "integrity_hold" and self.sequence == 2:
                self.control.halt(self.source.account_id, "NATIVE_INTEGRITY")
            if self.scenario == "reconcile_pause" and self.sequence == 2:
                self.control.begin_recovery(self.source.account_id)
            if self.scenario == "halt_exit" and self.sequence == 2 and not self._halted_once:
                self.control.halt(self.source.account_id, "DAY_LOSS")
                self._halted_once = True
            if (
                self.scenario == "revoke_holding"
                and self.sequence == 2
                and self.binding is not None
            ):
                self.control.revoke(self.binding)
            if (
                self.scenario == "expired_dispatch"
                and self.sequence == 7
                and self.receipt is not None
            ):
                self._send(self.receipt.entry_order_id)
            self._drive()
        except Exception as error:
            self._error(error)

    def _recover_controller(self) -> None:
        if self.source is None:
            raise RuntimeError("ASTARTER_NATIVE_SOURCE_MISSING")
        identity = self.control.controller_identity
        self.store.close()
        child = subprocess.run(
            [
                sys.executable,
                "-m",
                "stark_trading_os.runner.astarter_recover",
                "--database",
                str(self.path),
                "--account",
                self.source.account_id,
                "--tenant",
                identity.assignment.binding.tenant_id,
                "--venue-session",
                identity.assignment.venue_session,
                "--owner",
                identity.owner_id,
                "--expected-fence",
                str(identity.fence),
            ],
            capture_output=True,
            check=True,
            timeout=20,
        )
        self.recovery_process = json.loads(child.stdout)
        if self.recovery_process["account"]["fence"] != identity.fence + 1:
            raise RuntimeError("ASTARTER_RECOVERY_FENCE_CONFLICT")
        self.store = ControlStore.open(self.path)
        self.control = SyntheticControllerBackend(
            replace(identity, fence=identity.fence + 1)
        ).control(self.store)
        self.receipt = self.control.reservations(self.source.account_id)[0]
        self.control.observe(self.source)
        self.controller_reopened = True

    def _send(self, order_id: str) -> None:
        if self.source is None:
            raise RuntimeError("ASTARTER_NATIVE_SOURCE_MISSING")
        try:
            command = self.control.claim_order(
                order_id, fence=self.control.controller_identity.fence
            )
        except AstarterBlocked as error:
            if str(error) not in {
                "ASTARTER_NATIVE_SNAPSHOT_STALE",
                "ASTARTER_NATIVE_RECONCILIATION_REQUIRED",
            }:
                raise
            self.trace.append(
                dict(
                    event="NativeDispatchDeferred",
                    order_id=order_id,
                    time_ns=self.clock.timestamp_ns(),
                    reason=str(error),
                )
            )
            return
        if command is None:
            return
        order = native_order(self, self.item, command)
        if command.role == "ENTRY":
            self.entry_submissions += 1
        self.submit_order(order)  # SQLite transaction has already committed.

    def _event(self, event: Any) -> None:
        try:
            if self.source is None or self.errors:
                return
            if (
                self.scenario == "integrity_after_cancel"
                and type(event).__name__ == "OrderCanceled"
                and "-P" in str(event.client_order_id)
            ):
                self.control.halt(self.source.account_id, "NATIVE_INTEGRITY")
            self.control.observe(self.source)
            self.trace.append(
                dict(
                    event=type(event).__name__,
                    order_id=str(event.client_order_id),
                    time_ns=event.ts_event,
                    reason=str(getattr(event, "reason", "")),
                )
            )
            self._drive()
        except Exception as error:
            self._error(error)

    def on_order_filled(self, event: Any) -> None:
        self._event(event)

    def on_order_accepted(self, event: Any) -> None:
        self._event(event)

    def on_order_canceled(self, event: Any) -> None:
        self._event(event)

    def on_order_rejected(self, event: Any) -> None:
        self._event(event)

    def on_order_denied(self, event: Any) -> None:
        self._event(event)

    def on_order_expired(self, event: Any) -> None:
        self._event(event)

    def on_order_cancel_rejected(self, event: Any) -> None:
        self._event(event)

    def _source_ready(self) -> bool:
        if self.source is None:
            return False
        state = self.control.account(self.source.account_id)
        if not self.errors and not set(state.locks) & {"NATIVE_INTEGRITY", "RECONCILE_REQUIRED"}:
            return True
        self.trace.append(
            dict(
                event="SourceTrustDeferred",
                order_id="",
                time_ns=self.clock.timestamp_ns(),
                reason=",".join(state.locks),
            )
        )
        return False

    def _drive(self) -> None:
        if self._driving or self.source is None or self.receipt is None or self.errors:
            return
        self._driving = True
        try:
            if self.scenario == "recover_before_protection" and self.sequence < 3:
                return
            account = self.control.account(self.source.account_id)
            planned = (
                self.scenario
                in {
                    "round_trip",
                    "recover",
                    "halt_exit",
                    "cancel_race",
                    "recover_after_settlement",
                    "exit_above_cap",
                    "revoke_holding",
                    "partial_exit",
                    "recover_before_exit",
                    "integrity_hold",
                    "reconcile_pause",
                    "integrity_after_cancel",
                    "short_ttl",
                }
                and self.sequence >= 2
            )
            planned = planned or (self.scenario == "accepted_at_deadline" and self.sequence >= 4)
            failure = "PROTECTION_FAILED" in account.locks
            if planned or failure:
                self.control.request_exit(self.receipt.intent_id)
            if not self._source_ready():
                # Never remove native protection when the known source state
                # already forbids the replacement reduction. Local, never-sent
                # commands can still be withdrawn without touching the venue.
                for row in self.control.orders(self.receipt.intent_id):
                    if row.role != "EXIT" and row.dispatch_state == "PENDING":
                        self.control.claim_cancel(
                            row.order_id, fence=self.control.controller_identity.fence
                        )
                return
            protection = self.control.prepare_protection(self.receipt.intent_id)
            if protection is not None:
                self._send(protection.order_id)
            if not self._source_ready():
                return  # submission can yield through native callbacks
            if "PROTECTION_FAILED" in self.control.account(self.source.account_id).locks:
                self.control.request_exit(self.receipt.intent_id)
            # Use the locally owned lease, never adopt the latest database fence.
            for row in self.control.orders(self.receipt.intent_id):
                if (
                    row.role != "EXIT"
                    and row.native_state not in TERMINAL
                    and row.dispatch_state != "CANCELED_LOCAL"
                ):
                    if self.control.claim_cancel(
                        row.order_id, fence=self.control.controller_identity.fence
                    ):
                        self.cancel_order(ClientOrderId(row.order_id))
                        if not self._source_ready():
                            return  # callback may have introduced a new integrity failure
            if not self._source_ready():
                return
            exit_order = self.control.prepare_exit(self.receipt.intent_id)
            if exit_order is not None:
                if self.scenario == "recover_before_exit" and self.sequence == 2:
                    return  # deliberate controller interruption after intent commit
                self._send(exit_order.order_id)
        finally:
            self._driving = False


def _quotes(item: CurrencyPair, scenario: str) -> list[QuoteTick]:
    rows = []
    for index in range(10):
        bid, ask, bid_size, size = "59999.00", "60000.00", "10.00000", "10.00000"
        if index == 0 and scenario == "zero":
            bid, ask = "60199.00", "60200.00"
        if index == 0 and scenario == "partial_stop":
            size = "0.00100"
        if index >= 1 and scenario in {
            "round_trip",
            "recover",
            "halt_exit",
            "zero",
            "recover_after_settlement",
            "revoke_holding",
            "partial_exit",
            "recover_before_exit",
            "integrity_hold",
            "reconcile_pause",
            "integrity_after_cancel",
            "short_ttl",
        }:
            bid, ask = "61000.00", "61001.00"
        if index == 1 and scenario == "partial_exit":
            bid_size = "0.00100"
        if index >= 1 and scenario == "open_dip":
            bid, ask = "59500.00", "59501.00"
        if index >= 1 and scenario == "exit_above_cap":
            bid, ask = "400000.00", "400001.00"
        if index >= 1 and scenario in {"stop", "partial_stop"}:
            bid, ask = "58900.00", "58901.00"
        if scenario == "cancel_race":
            if index == 1:
                bid, ask = "61000.00", "61001.00"
            if index >= 2:
                bid, ask = "58900.00", "58901.00"
        if scenario == "stop_rejected" and index >= 1:
            bid, ask = "58799.00", "58800.00"
        if scenario == "accepted_at_deadline" and index >= 3:
            bid, ask = "61000.00", "61001.00"
        at = START_NS + index * 1_000_000_000
        rows.append(
            QuoteTick(
                item.id,
                Price.from_str(bid),
                Price.from_str(ask),
                Quantity.from_str(bid_size),
                Quantity.from_str(size),
                at,
                at,
            )
        )
    return rows


def run_btc_simulation(*, database_path: Path, scenario: str = "round_trip") -> SimulationEvidence:
    if scenario not in SCENARIOS:
        raise ValueError("ASTARTER_SCENARIO_UNSUPPORTED")
    path = Path(database_path).resolve()
    if path.exists():
        raise ValueError("ASTARTER_NEW_SIMULATION_DATABASE_REQUIRED")
    item = _instrument()
    quotes = _quotes(item, scenario)
    component = sha256(
        encode(
            dict(
                identity="ASTARTER_BTC_NATIVE_SIM_V1",
                scenario=scenario,
                quotes=[
                    dict(
                        bid=str(v.bid_price),
                        ask=str(v.ask_price),
                        bid_size=str(v.bid_size),
                        size=str(v.ask_size),
                        time_ns=v.ts_init,
                    )
                    for v in quotes
                ],
            )
        )
    ).hexdigest()
    strategy = AstarterNativeStrategy(
        database_path=path, scenario=scenario, instrument=item, component_id=component
    )
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True, run_analysis=False, logging=LoggerConfig(bypass_logging=True)
        )
    )
    result: bytes | None = None
    disposed = False
    try:
        insert = (
            1_000_000_000
            if scenario in {"stop_rejected", "accepted_at_deadline"}
            else 2_000_000_000
            if scenario == "stop_late"
            else 0
        )
        cancel = 2_000_000_000 if scenario == "cancel_race" else 0
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
                insert_latency_nanos=insert, cancel_latency_nanos=cancel
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
        engine.add_data(quotes)
        engine.run()
        if strategy.source is None:
            raise RuntimeError("ASTARTER_NATIVE_SOURCE_NOT_ESTABLISHED:" + repr(strategy.errors))
        source = strategy.source
        strategy.control.observe(source)
        snap = source.capture()
        source.verify(snap)
        settlement = duplicate = alias = None
        if (
            amount(snap.position_quantity) == 0
            and all(v.state in TERMINAL for v in snap.orders)
            and scenario != "expired_dispatch"
        ):
            try:
                settlement = strategy.control.settle(
                    source.account_id, request_id="native-close-A", component_id=component
                )
                if scenario == "recover_after_settlement":
                    strategy._recover_controller()
                duplicate = strategy.control.settle(
                    source.account_id, request_id="native-close-B", component_id=component
                )
                alias_id = sha256((component + "copy").encode()).hexdigest()
                strategy.control.activate(source, strategy.policy, component_id=alias_id)
                alias = strategy.control.settle(
                    source.account_id, request_id="native-close-C", component_id=alias_id
                )
            except AstarterBlocked as error:
                strategy.errors.append(str(error))
        state = strategy.control.account(source.account_id)
        live = sum(v.state not in TERMINAL for v in snap.orders)
        failure = "PROTECTION_FAILED" in state.locks
        status = "RECONCILIATION_REQUIRED"
        if (
            not strategy.errors
            and settlement is not None
            and live == 0
            and amount(snap.position_quantity) == 0
        ):
            status = "HALTED_FLAT" if failure else "COMPLETE" if snap.fills else "NO_FILL"
        if scenario == "expired_dispatch" and not snap.fills and strategy.entry_submissions == 0:
            status = "EXPIRED_UNSENT"
        orders = (
            () if strategy.receipt is None else strategy.control.orders(strategy.receipt.intent_id)
        )
        accepted = [
            o
            for o in orders
            if o.role == "STOP"
            and o.accepted_at_ns is not None
            and o.deadline_ns is not None
            and o.accepted_at_ns <= o.deadline_ns
        ]
        evidence = dict(
            scope="FINITE_NATIVE_SIMULATION",
            identity="ASTARTER_BTC_NATIVE_SIM_V1",
            scenario=scenario,
            synthetic_data=True,
            real_trading_connected=False,
            status=status,
            component_id=component,
            reservation=None if strategy.receipt is None else asdict(strategy.receipt),
            native_snapshot=asdict(snap),
            account=asdict(state),
            open_cost_debit=text(strategy.control._open_cost_debit(source.account_id)),
            settlement=None if settlement is None else asdict(settlement),
            duplicate_settlement=None if duplicate is None else asdict(duplicate),
            alias_settlement=None if alias is None else asdict(alias),
            settlement_rows=strategy.store._connection.execute(
                "SELECT COUNT(*) FROM astarter_settlements"
            ).fetchone()[0],
            protected_acceptances=len(accepted),
            entry_submissions=strategy.entry_submissions,
            live_orders=live,
            open_positions=len(engine.cache.positions_open(instrument_id=item.id)),
            protection_failure_observed=failure,
            controller_reopened=strategy.controller_reopened,
            recovery_process=strategy.recovery_process,
            errors=strategy.errors,
            trace=strategy.trace,
            audit=strategy.control.audit(source.account_id),
            native_orders_csv=engine.generate_orders_report().to_csv(),
            native_fills_csv=engine.generate_fills_report().to_csv(),
            native_positions_csv=engine.generate_positions_report().to_csv(),
            native_account_csv=engine.generate_account_report(item.id.venue).to_csv(),
        )
        # No claim of uninterrupted protection during an approved cancel→market exit.
        evidence["pending_stop_without_acceptance_at_final_snapshot"] = any(
            o.role == "STOP" and o.accepted_at_ns is None and o.native_state not in TERMINAL
            for o in orders
        )
        evidence["protection_scope"] = "ACCEPTED_NATIVE_STOPS; EXIT_TRANSITIONS_SEPARATELY_AUDITED"
        result = encode(evidence)
    finally:
        if strategy.source is not None:
            strategy.source.close()
        strategy.store.close()
        engine.dispose()
        disposed = True
    if result is None:
        raise RuntimeError("ASTARTER_SIMULATION_EVIDENCE_MISSING")
    return SimulationEvidence(result, disposed)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Finite synthetic BTC native simulation, no live account"
    )
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="round_trip")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("ASTARTER_NEW_EVIDENCE_PATH_REQUIRED")
    result = run_btc_simulation(database_path=args.database, scenario=args.scenario)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result.evidence_bytes + b"\n")
    print(
        encode(
            dict(
                scope="FINITE_NATIVE_SIMULATION",
                engine_disposed=result.engine_disposed,
                evidence_path=str(args.output.resolve()),
            )
        ).decode()
    )


if __name__ == "__main__":
    main()
