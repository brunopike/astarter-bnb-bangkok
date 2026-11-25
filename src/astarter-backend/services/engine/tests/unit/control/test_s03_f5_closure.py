"""Companion F5 counterexamples: owned native fixtures and new Control DBs only."""

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
from tests.unit.control.test_s03_lifecycle import (
    _consume_news,
    _market,
    _position,
    _push,
    _quote,
    _timer,
)


def _filled(pack):
    control, owner, reserved = pack[4], pack[5], pack[9]
    when = pack[10] + 1_000_000_000
    control.ingest(owner, pack[3], _quote(when, manifest=pack[11]))
    return control._astarter, reserved.intent_id, when


def _native_stop(pack, *, tiny=False):
    astarter, intent, when = _filled(pack)
    strategy, control, owner = pack[2], pack[4], pack[5]
    if tiny:
        # Registered partial STOP for an earlier smaller fill, in this new fixture DB only.
        planned_id = pack[9].entry_order_id[:-1] + "P1"
        deadline = control.life(owner.run_id).protection_deadline_ns
        control._c.execute(
            "INSERT INTO astarter_orders(order_id,account_id,intent_id,role,quantity,"
            "trigger_price,deadline_ns) VALUES(?,?,?,'STOP','0.00001',?,?)",
            (planned_id, "SIM-001", intent, pack[9].stop, deadline),
        )
    else:
        planned = astarter.prepare_protection(intent, owner=owner)
        assert planned is not None and planned.price is not None
        planned_id = planned.order_id
    command = astarter.claim_order(
        planned_id, fence=astarter.account("SIM-001").fence, owner=owner, source=pack[3]
    )
    assert command is not None and command.price is not None
    stop = strategy.order_factory.stop_market(
        instrument_id=strategy.item.id,
        order_side=OrderSide.SELL,
        quantity=Quantity.from_str(command.quantity),
        trigger_price=Price.from_str(f"{Decimal(command.price):.2f}"),
        trigger_type=TriggerType.BID_ASK,
        time_in_force=TimeInForce.GTC,
        reduce_only=False,
        client_order_id=ClientOrderId(command.order_id),
    )

    def submit_once(quote):
        if not getattr(strategy, "_companion_stop_sent", False):
            strategy._companion_stop_sent = True
            strategy.submit_order(stop)

    strategy.on_quote = submit_once
    _push(pack[1], strategy, when + 1_000_000, "1253.00", "1254.00", None)
    control.ingest(owner, pack[3], _quote(when + 1_000_000, manifest=pack[11]))
    observed = next(
        order for order in pack[3].capture().orders if order.order_id == command.order_id
    )
    assert observed.state == "ACCEPTED" and observed.accepted_at_ns is not None
    return astarter, intent, command, when


def _residual(pack):
    control, owner, source = pack[4], pack[5], pack[3]
    now = _arm(pack)
    for offset in range(3):
        target = now + offset * GAP
        _push(pack[1], pack[2], target, "1253.00", "1254.00", None)
        actual = source.capture().now_ns
        assert actual == target
        claimed = control.claim_exit(owner, source, actual)
        _rest_canceled(pack, claimed, actual + 1_000_000)
    return control.claim_residual(owner, source)


def _state_rows(control):
    tables = (
        "astarter_accounts",
        "astarter_orders",
        "astarter_intents",
        "astarter_audit",
        "s03_lifecycle",
        "s03_events",
        "s03_audit",
    )
    return {
        name: [tuple(row) for row in control._c.execute(f"SELECT * FROM {name}")] for name in tables
    }


@pytest.mark.parametrize("tiny", [False, True], ids=["full", "partial"])
def test_f5_timer_counts_actual_native_remaining_protection(tmp_path, tiny):
    with _position(tmp_path, "amount.sqlite", _market()) as pack:
        astarter, _intent, command, _when = _native_stop(pack, tiny=tiny)
        control, owner = pack[4], pack[5]
        before = control.life(owner.run_id)
        assert before.protection_deadline_ns is not None
        assert "PROTECTION_FAILED" not in before.reasons
        if tiny:
            assert Decimal(command.quantity) < Decimal(pack[3].capture().position_quantity)
        result = _timer(pack, before.protection_deadline_ns + 1)
        assert ("PROTECTION_FAILED" in result.reasons) == tiny
        assert result.first_fill_ns == before.first_fill_ns
        assert result.protection_deadline_ns == before.protection_deadline_ns
        if not tiny:
            later = _timer(pack, before.protection_deadline_ns + 10_000_000_000)
            assert "PROTECTION_FAILED" not in later.reasons
            assert "RECONCILIATION_REQUIRED" not in later.reasons
            assert "PROTECTION_FAILED" not in astarter.account("SIM-001").locks


def test_f5_cancel_pending_stop_is_not_qualified_coverage(tmp_path):
    with _position(tmp_path, "cancel.sqlite", _market()) as pack:
        astarter, intent, command, _when = _native_stop(pack)
        control, owner = pack[4], pack[5]
        control.note_lock(owner, "EMERGENCY")
        assert control.resolve_exit(owner, pack[3]).exit_target == "C"
        astarter.request_exit(intent, owner=owner)
        assert astarter.claim_cancel(
            command.order_id, fence=astarter.account("SIM-001").fence, owner=owner, source=pack[3]
        )
        before = control.life(owner.run_id)
        assert before.protection_deadline_ns is not None
        result = _timer(pack, before.protection_deadline_ns + 1)
        assert "PROTECTION_FAILED" in result.reasons
        assert result.protection_deadline_ns == before.protection_deadline_ns


def test_f5_residual_deadline_is_independent_and_survives_reopen(tmp_path):
    path = tmp_path / "residual.sqlite"
    with _position(tmp_path, path.name, _market(), "drop") as pack:
        control, owner = pack[4], pack[5]
        original = _residual(pack)
        assert original.residual_deadline_ns is not None
        deadline = original.residual_deadline_ns
        quotes = control.state(owner.run_id).accepted_quote_count
        for when in (deadline - 1, deadline):
            on_time = _timer(pack, when)
            assert "RECONCILIATION_REQUIRED" not in on_time.reasons
        late = _timer(pack, deadline + 1)
        assert {"RECONCILIATION_REQUIRED", "PROTECTION_FAILED", "EXIT_BLOCKED"} <= set(late.reasons)
        assert late.residual_order_id == original.residual_order_id
        assert late.residual_deadline_ns == deadline and late.residual_used
        assert late.protection_deadline_ns == original.protection_deadline_ns
        assert late.exit_claims == 3
        assert control.state(owner.run_id).accepted_quote_count == quotes
        rows = _state_rows(control)
        assert _timer(pack, deadline + 1) == late
        assert _state_rows(control) == rows
        store = ControlStore.open(path)
        try:
            reopened = s03_bridge(store, pack[3])
            assert reopened.life(owner.run_id) == late
            with pytest.raises(S03BridgeRejected, match="S03_RESIDUAL_USED"):
                reopened.claim_residual(owner, pack[3])
        finally:
            store._connection.close()


def test_f5_timer_failure_rolls_back_orders_life_and_events(tmp_path, monkeypatch):
    with _position(tmp_path, "rollback.sqlite", _market()) as pack:
        _filled(pack)
        control, owner = pack[4], pack[5]
        deadline = control.life(owner.run_id).protection_deadline_ns
        assert deadline is not None
        rows = _state_rows(control)

        def fail_save(*args):
            raise RuntimeError("SYNTHETIC_SAVE_FAILURE")

        with monkeypatch.context() as context:
            context.setattr(control, "_save_life", fail_save)
            with pytest.raises(RuntimeError, match="SYNTHETIC_SAVE_FAILURE"):
                _timer(pack, deadline + 1)
        assert _state_rows(control) == rows
        assert "PROTECTION_FAILED" in _timer(pack, deadline + 1).reasons


def test_f5_old_owner_cannot_advance_timer_after_takeover(tmp_path):
    with _position(tmp_path, "owner.sqlite", _market()) as pack:
        _filled(pack)
        control, old_owner = pack[4], pack[5]
        other = s03_bridge(ControlStore.open(tmp_path / "owner.sqlite"), pack[3])
        try:
            current = other.takeover(pack[3], old_owner.run_id)
            assert current != old_owner
            rows = _state_rows(control)
            with pytest.raises(S03BridgeRejected, match="S03_OWNER_STALE"):
                _timer(pack, pack[10] + 3_000_000_001)
            assert _state_rows(control) == rows
        finally:
            other._c.close()


@pytest.mark.parametrize("gate", ["recovery_before_reserve", "revoke_before_claim"])
def test_uniform_f3_final_write_rechecks_s03_authority(tmp_path, gate):
    from tests.unit.control.test_s03_lifecycle import _book
    from tests.unit.control.test_s03_sizing import _case

    plan, manifest, signal, observation = _case("0.005", "0.2")
    when = signal.bar_close_ns + 1_000_000_000
    path = tmp_path / "f3.sqlite"
    with _book(when) as (engine, strategy, source):
        _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
        control = s03_bridge(ControlStore.open(path), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        other = s03_bridge(ControlStore.open(path), source)
        try:
            account = control._astarter.account("SIM-001")
            if gate == "recovery_before_reserve":
                control._before_reserve_write = lambda: other.note_recovery(owner)
                with pytest.raises(S03BridgeRejected):
                    control.reserve_signal(
                        owner,
                        source,
                        signal,
                        observation,
                        expected_epoch=account.epoch,
                        expected_sequence=account.latest_sequence,
                    )
                count = control._c.execute("SELECT count(*) FROM astarter_intents").fetchone()[0]
                assert count == 0
            else:
                receipt = control.reserve_signal(
                    owner,
                    source,
                    signal,
                    observation,
                    expected_epoch=account.epoch,
                    expected_sequence=account.latest_sequence,
                )
                control._before_claim_write = lambda: other.note_lock(owner, "AUTH_REVOKED")
                with pytest.raises((S03BridgeRejected, ValueError)):
                    control.claim_entry(owner, source, receipt.entry_order_id)
                row = control._c.execute(
                    "SELECT dispatch_state FROM astarter_orders WHERE order_id=?",
                    (receipt.entry_order_id,),
                ).fetchone()
                assert row[0] == "PENDING"
        finally:
            other._c.close()


def test_uniform_f4_public_exit_cannot_bypass_s03_claim_accounting(tmp_path):
    from stark_trading_os.domain.astarter_simulation import AstarterBlocked

    with _position(tmp_path, "bypass.sqlite", _market()) as pack:
        astarter, intent, _when = _filled(pack)
        control, owner = pack[4], pack[5]
        control.note_lock(owner, "EMERGENCY")
        assert control.resolve_exit(owner, pack[3]).exit_target == "C"
        astarter.request_exit(intent, owner=owner)
        try:
            command = astarter.prepare_exit(intent, owner=owner)
            claimed = (
                astarter.claim_order(
                    command.order_id,
                    fence=astarter.account("SIM-001").fence,
                    owner=owner,
                    source=pack[3],
                )
                if command
                else None
            )
        except (S03BridgeRejected, AstarterBlocked):
            claimed = None
        life = control.life(owner.run_id)
        if claimed is not None:
            assert life.exit_claims == 1
            assert life.exit_order_id == claimed.order_id
            assert life.exit_deadline_ns is not None
            assert "EXIT_PENDING" in life.reasons
        else:
            assert life.exit_claims == 0


def test_uniform_f2_noncanonical_event_key_is_not_a_new_trusted_fact(tmp_path):
    with _position(tmp_path, "bad-key.sqlite", _market()) as pack:
        control, owner = pack[4], pack[5]
        snap_before = control._astarter.stored_snapshot("SIM-001")
        event = _quote(pack[10] + 1_000_000_000).model_copy(update={"event_key": "f" * 64})
        with pytest.raises(S03BridgeRejected):
            control.ingest(owner, pack[3], event)
        assert (
            control._c.execute(
                "SELECT count(*) FROM s03_events WHERE event_key=?", (event.event_key,)
            ).fetchone()[0]
            == 0
        )
        assert control._astarter.stored_snapshot("SIM-001") == snap_before


def test_uniform_f2_future_canonical_event_does_not_advance_health(tmp_path):
    with _position(tmp_path, "future-quote.sqlite", _market()) as pack:
        control, owner = pack[4], pack[5]
        snap_before = control._astarter.stored_snapshot("SIM-001")
        event = _quote(pack[10] + 600_000_000_000)
        with pytest.raises(S03BridgeRejected):
            control.ingest(owner, pack[3], event)
        assert (
            control._c.execute(
                "SELECT count(*) FROM s03_events WHERE event_key=?", (event.event_key,)
            ).fetchone()[0]
            == 0
        )
        assert control._astarter.stored_snapshot("SIM-001") == snap_before


def test_uniform_f2_replayed_event_cannot_commit_new_fill_without_its_deadline(tmp_path):
    from tests.unit.control.test_s03_lifecycle import _book
    from tests.unit.control.test_s03_sizing import _case

    plan, manifest, signal, observation = _case("0.005", "0.2")
    when = signal.bar_close_ns + 1_000_000_000
    with _book(when) as (engine, strategy, source):
        _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
        control = s03_bridge(ControlStore.open(tmp_path / "replay.sqlite"), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        event = _quote(when + 500_000, manifest=manifest)
        control.ingest(owner, source, event)
        assert control.life(owner.run_id).first_fill_ns is None
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
        _push(
            engine,
            strategy,
            when + 1_000_000,
            "1253.00",
            "1254.00",
            (command.order_id, "BUY", command.quantity, f"{Decimal(command.price):.2f}"),
        )
        assert Decimal(source.capture().position_quantity) > 0
        control.ingest(owner, source, event)
        native = astarter.stored_snapshot("SIM-001")
        life = control.life(owner.run_id)
        assert native is not None
        if Decimal(native.position_quantity) > 0:
            first_fill = min(fill.time_ns for fill in native.fills if fill.side == "BUY")
            assert life.first_fill_ns == first_fill
            assert life.protection_deadline_ns == first_fill + 1_000_000_000
        assert (
            control._c.execute(
                "SELECT count(*) FROM s03_events WHERE event_key=?", (event.event_key,)
            ).fetchone()[0]
            == 1
        )


def test_uniform_f2_renumbered_same_native_quote_cannot_advance_accepted_feed(tmp_path):
    from stark_trading_os.runner.s03_bridge_source import s03_event_key

    with _position(tmp_path, "renumber.sqlite", _market()) as pack:
        control, owner, source = pack[4], pack[5], pack[3]
        event = _quote(pack[10] + 1_000_000_000, manifest=pack[11])
        control.ingest(owner, source, event)
        before = control.state(owner.run_id).accepted_quote_count
        quote = event.quote.model_copy(update={"source_sequence": event.quote.source_sequence + 1})
        replay = event.model_copy(update={"quote": quote})
        replay = replay.model_copy(update={"event_key": s03_event_key(replay)})
        try:
            control.ingest(owner, source, replay)
        except S03BridgeRejected:
            pass
        assert control.state(owner.run_id).accepted_quote_count == before


def test_uniform_f2_rejected_bar_latches_a_real_new_risk_gate(tmp_path):
    from dataclasses import replace

    from stark_trading_os.domain.s03_bridge import s03_entry_locked
    from tests.unit.control.test_s03_lifecycle import _book
    from tests.unit.control.test_s03_sizing import _case

    plan, manifest, signal, observation = _case("0.005", "0.2")
    when = signal.bar_close_ns + 1_000_000_000
    with _book(when) as (engine, strategy, source):
        _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
        control = s03_bridge(ControlStore.open(tmp_path / "bad-bar.sqlite"), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        bad = replace(observation, prefix_sha256="f" * 64)
        with pytest.raises(S03BridgeRejected):
            control.apply_bar(owner, source, bad)
        assert s03_entry_locked(control.life(owner.run_id))
        account = control._astarter.account("SIM-001")
        with pytest.raises(S03BridgeRejected):
            control.reserve_signal(
                owner,
                source,
                signal,
                observation,
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
