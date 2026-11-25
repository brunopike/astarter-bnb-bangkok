"""Protection and residual deadlines advance without a fresh quote."""

from decimal import Decimal

import pytest
from nautilus_trader.model import (
    ClientOrderId,
    OrderSide,
    Price,
    Quantity,
    TimeInForce,
    TriggerType,
)

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.s03_bridge import S03BridgeRejected
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_exit import GAP, _arm, _rest_canceled
from tests.unit.control.test_s03_lifecycle import _market, _position, _push, _quote, _timer


def test_timer_marks_an_uncovered_fill_at_protection_deadline_plus_one(tmp_path) -> None:
    with _position(tmp_path, "protect.sqlite", _market()) as pack:
        _book, _engine, _strategy, source, control, owner, *_rest = pack
        when = pack[10] + 1_000_000_000
        control.ingest(owner, source, _quote(when, manifest=pack[11]))
        life = control.life(owner.run_id)
        assert life.first_fill_ns == when
        assert life.protection_deadline_ns == when + 1_000_000_000
        quotes = control.state(owner.run_id).accepted_quote_count
        on_time = _timer(pack, life.protection_deadline_ns or 0)
        assert "PROTECTION_FAILED" not in on_time.reasons
        late = _timer(pack, (life.protection_deadline_ns or 0) + 1)
        assert "PROTECTION_FAILED" in late.reasons
        assert control.state(owner.run_id).accepted_quote_count == quotes


def test_an_accepted_gtc_stop_is_not_failed_for_living_past_one_second(tmp_path) -> None:
    with _position(tmp_path, "gtc.sqlite", _market()) as pack:
        engine, strategy, source, control, owner = pack[1], pack[2], pack[3], pack[4], pack[5]
        when = pack[10] + 1_000_000_000
        control.ingest(owner, source, _quote(when, manifest=pack[11]))
        intent = control._c.execute("SELECT intent_id FROM s03_signals").fetchone()[0]
        command = control._astarter.prepare_protection(str(intent), owner=owner)
        assert command is not None and command.price is not None
        account = control._astarter.account("SIM-001")
        control._astarter.claim_order(
            command.order_id, fence=account.fence, owner=owner, source=pack[3]
        )
        order = strategy.order_factory.stop_market(
            instrument_id=strategy.item.id,
            order_side=OrderSide.SELL,
            quantity=Quantity.from_str(command.quantity),
            trigger_price=Price.from_str(f"{Decimal(command.price):.2f}"),
            trigger_type=TriggerType.BID_ASK,
            time_in_force=TimeInForce.GTC,
            reduce_only=False,
            client_order_id=ClientOrderId(command.order_id),
        )

        def on_quote(quote: object) -> None:
            if getattr(strategy, "_sent_stop", False):
                return
            strategy._sent_stop = True
            strategy.submit_order(order)

        strategy.on_quote = on_quote
        from tests.unit.control.test_s03_lifecycle import _push

        _push(engine, strategy, when + 1_000_000, "1253.00", "1254.00", None)
        control._astarter.observe(source, owner=owner)
        life = control.life(owner.run_id)
        late = _timer(pack, (life.protection_deadline_ns or 0) + 10_000_000_000)
        assert "PROTECTION_FAILED" not in late.reasons


def test_residual_plan_is_one_stop_and_survives_reopen(tmp_path) -> None:
    path = tmp_path / "residual.sqlite"
    with _position(tmp_path, "residual.sqlite", _market(), "drop") as pack:
        _book, _engine, _strategy, source, control, owner, *_rest = pack
        now = _arm(pack)
        protected = control.life(owner.run_id).protection_deadline_ns
        claim = control.claim_exit(owner, source, now)
        _rest_canceled(pack, claim, now + 1_000_000)
        _push(pack[1], pack[2], now + GAP, "1253.00", "1254.00", None)
        second = control.claim_exit(owner, source, source.capture().now_ns)
        _rest_canceled(pack, second, now + GAP + 1_000_000)
        _push(pack[1], pack[2], now + 2 * GAP, "1253.00", "1254.00", None)
        third = control.claim_exit(owner, source, source.capture().now_ns)
        _rest_canceled(pack, third, now + 2 * GAP + 1_000_000)
        residual = control.claim_residual(owner, source)
        assert residual.residual_used and residual.residual_order_id
        assert residual.residual_deadline_ns is not None
        stored = control._c.execute(
            "SELECT deadline_ns FROM astarter_orders WHERE order_id=?",
            (residual.residual_order_id,),
        ).fetchone()
        assert stored is not None and stored[0] == residual.residual_deadline_ns
        assert residual.protection_deadline_ns == protected
        assert "EXIT_BLOCKED" in residual.reasons
        stops = control._c.execute(
            "SELECT order_id FROM astarter_orders WHERE role='STOP'"
        ).fetchall()
        assert len(stops) == 1
        with pytest.raises(S03BridgeRejected, match="S03_RESIDUAL_USED"):
            control.claim_residual(owner, source)
        kept = s03_bridge(ControlStore.open(path), source).life(owner.run_id)
        assert kept.residual_used
        assert kept.residual_deadline_ns == residual.residual_deadline_ns
        assert kept.exit_claims == 3
        assert kept.protection_deadline_ns == protected


def test_residual_command_is_claimable_once_and_native_acceptance_keeps_locks(tmp_path):
    from tests.unit.control.test_s03_lifecycle import _push

    with _position(tmp_path, "residual-send.sqlite", _market(), "drop") as pack:
        engine, strategy, source, control, owner = pack[1:6]
        now = _arm(pack)
        for offset in range(3):
            target = now + offset * GAP
            _push(engine, strategy, target, "1253.00", "1254.00", None)
            assert source.capture().now_ns == target
            life = control.claim_exit(owner, source, target)
            _rest_canceled(pack, life, now + offset * GAP + 1_000_000)
        control.note_lock(owner, "PROTECTION_FAILED")
        planned = control.claim_residual(owner, source)
        astarter = control._astarter
        command = astarter.claim_order(
            planned.residual_order_id,
            fence=astarter.account("SIM-001").fence,
            owner=owner,
            source=pack[3],
        )
        assert command is not None and command.role == "STOP"
        assert (
            astarter.claim_order(
                command.order_id,
                fence=astarter.account("SIM-001").fence,
                owner=owner,
                source=pack[3],
            )
            is None
        )
        order = strategy.order_factory.stop_market(
            instrument_id=strategy.item.id,
            order_side=OrderSide.SELL,
            quantity=Quantity.from_str(command.quantity),
            trigger_price=Price.from_str(f"{Decimal(command.price):.2f}"),
            trigger_type=TriggerType.BID_ASK,
            time_in_force=TimeInForce.GTC,
            reduce_only=False,
            client_order_id=ClientOrderId(command.order_id),
        )
        strategy.on_quote = lambda quote: strategy.submit_order(order)
        _push(engine, strategy, now + 2 * GAP + 2_000_000, "1253.00", "1254.00", None)
        control.ingest(owner, source, _quote(now + 2 * GAP + 2_000_000, manifest=pack[11]))
        result = _timer(pack, planned.residual_deadline_ns + 1)
        assert {"PROTECTION_FAILED", "EXIT_BLOCKED"} <= set(result.reasons)
        assert "RECONCILIATION_REQUIRED" not in result.reasons
        assert result.protection_deadline_ns == planned.protection_deadline_ns
        assert result.residual_used
        with pytest.raises(S03BridgeRejected, match="S03_RESIDUAL_USED"):
            control.claim_residual(owner, source)


def test_timer_watermark_survives_reopen_and_rejects_backward_time(tmp_path):
    path = tmp_path / "watermark.sqlite"
    with _position(tmp_path, path.name, _market()) as pack:
        control, owner = pack[4:6]
        now = pack[10] + 3_000_000_000
        _timer(pack, now)
        store = ControlStore.open(path)
        try:
            reopened = s03_bridge(store, pack[3])
            with pytest.raises(S03BridgeRejected, match="S03_CLOCK_REGRESSION"):
                reopened.note_timer(owner, now - 1, source=pack[3])
            assert reopened.note_timer(owner, now, source=pack[3]) == control.life(owner.run_id)
        finally:
            store._connection.close()


def test_no_quote_entry_submit_timeout_retains_reservation(tmp_path):
    from tests.unit.control.test_s03_lifecycle import _book, _consume_news, _push
    from tests.unit.control.test_s03_sizing import _case

    plan, manifest, signal, observation = _case("0.005", "0.2")
    now = signal.bar_close_ns + 1_000_000_000
    with _book(now) as (engine, strategy, source):
        _push(engine, strategy, now + 500_000, "1253.00", "1254.00", None)
        control = s03_bridge(ControlStore.open(tmp_path / "entry-submit.sqlite"), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        pack = (None, engine, strategy, source, control, owner)
        astarter = control._astarter
        account = astarter.account("SIM-001")
        receipt = control.reserve_signal(
            owner,
            source,
            signal,
            observation,
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
        )
        command = control.claim_entry(owner, source, receipt.entry_order_id)
        assert command is not None
        deadline = source.capture().now_ns + 1_000_000_000
        for timestamp in (deadline - 1, deadline):
            assert "RECONCILIATION_REQUIRED" not in _timer(pack, timestamp).reasons
        late = _timer(pack, deadline + 1)
        assert "RECONCILIATION_REQUIRED" in late.reasons
        assert Decimal(astarter.account("SIM-001").cash_hold) > 0
        assert astarter.orders(receipt.intent_id)[0].dispatch_state == "DISPATCHING"


def test_cancel_deadline_without_quote_and_late_residual_claim_are_blocked(tmp_path):
    import json

    from stark_trading_os.domain.astarter_simulation import AstarterBlocked
    from tests.unit.control.test_s03_f5_closure import _native_stop, _residual

    with _position(tmp_path, "cancel-deadline.sqlite", _market()) as pack:
        astarter, intent, command, _when = _native_stop(pack)
        control, owner = pack[4:6]
        control.note_lock(owner, "EMERGENCY")
        assert control.resolve_exit(owner, pack[3]).exit_target == "C"
        astarter.request_exit(intent, owner=owner)
        assert astarter.claim_cancel(
            command.order_id, fence=astarter.account("SIM-001").fence, owner=owner, source=pack[3]
        )
        fact = control._c.execute(
            "SELECT fact_bytes FROM astarter_audit WHERE kind='NATIVE_CANCEL_INTENT'"
        ).fetchone()[0]
        deadline = json.loads(fact)["deadline_ns"]
        for timestamp in (deadline - 1, deadline):
            assert "RECONCILIATION_REQUIRED" not in _timer(pack, timestamp).reasons
        assert "RECONCILIATION_REQUIRED" in _timer(pack, deadline + 1).reasons
    with _position(tmp_path, "residual-late.sqlite", _market(), "drop") as pack:
        control, owner = pack[4:6]
        life = _residual(pack)
        _timer(pack, life.residual_deadline_ns + 1)
        astarter = control._astarter
        with pytest.raises(AstarterBlocked):
            astarter.claim_order(
                life.residual_order_id,
                fence=astarter.account("SIM-001").fence,
                owner=owner,
                source=pack[3],
            )
        assert (
            next(
                o
                for o in astarter.orders(pack[9].intent_id)
                if o.order_id == life.residual_order_id
            ).dispatch_state
            == "PENDING"
        )
