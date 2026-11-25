"""Post-commit Control recovery inside the real finite native driver."""

import json
import sqlite3
from dataclasses import asdict
from decimal import Decimal

import pytest

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.s03_bridge import S03BridgeControl
from stark_trading_os.domain.astarter_simulation import AstarterBlocked, AstarterIntegrityError
from stark_trading_os.domain.s03_bridge import S03BridgeRejected, local_simulation_case
from stark_trading_os.runner.astarter_facts import NativeFactsSource
from stark_trading_os.runner.s03_simulation import (
    S03ControllerBackend,
    S03NativeStrategy,
    run_s03_simulation,
)


@pytest.mark.parametrize("phase", ["reserve", "claim", "send", "cancel", "fill", "flat", "settle"])
def test_native_driver_reopens_control_without_replaying_old_claims(tmp_path, monkeypatch, phase):
    path = tmp_path / f"native-recovery-{phase}.sqlite"
    seen = {"cut": False, "native_cancels_after_cut": 0}
    original_start = S03NativeStrategy.on_start
    original_close = NativeFactsSource.close

    def start(strategy):
        original_start(strategy)
        seen["strategy"] = strategy
        seen["source"] = strategy.source

    def close(source):
        if source is seen.get("source") and "final_native" not in seen:
            seen["final_native"] = source.capture()
        original_close(source)

    monkeypatch.setattr(S03NativeStrategy, "on_start", start)
    monkeypatch.setattr(NativeFactsSource, "close", close)

    def reopen():
        if seen["cut"]:
            return
        strategy = seen["strategy"]
        source, old_owner = strategy.source, strategy.owner
        assert source is seen["source"] and old_owner is not None
        connection = strategy.store._connection
        assert not connection.in_transaction
        seen["receipt"] = bytes(
            connection.execute("SELECT receipt_bytes FROM astarter_intents").fetchone()[0]
        )
        seen["before_life"] = asdict(strategy.bridge.life(old_owner.run_id))
        seen["claims"] = [
            tuple(a)
            for a in connection.execute(
                "SELECT kind,fact_sha256,fact_bytes FROM astarter_audit "
                "WHERE kind IN ('NATIVE_DISPATCH_CLAIMED','NATIVE_CANCEL_INTENT') ORDER BY seq"
            )
        ]
        seen["before_session"] = source.venue_session
        seen["cut_time_ns"] = source.capture().now_ns
        strategy.store.close()
        with pytest.raises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")
        strategy.store = ControlStore.open(path)
        strategy.control = S03ControllerBackend(
            strategy.control.controller_identity
        ).control(strategy.store)
        strategy.bridge = S03BridgeControl(strategy.store, control=strategy.control)
        new_owner = strategy.bridge.takeover(source, old_owner.run_id)
        assert new_owner.fence == old_owner.fence + 1
        strategy.owner = new_owner  # The trusted test host explicitly installs the takeover result.
        strategy.bridge.note_recovery(new_owner)
        seen["cut"] = True
        seen["run_id"] = new_owner.run_id
        order_id = strategy.store._connection.execute(
            "SELECT order_id FROM astarter_orders WHERE role='ENTRY'"
        ).fetchone()[0]
        latest = strategy.control.account(source.account_id).fence
        for stale in (
            lambda: strategy.control.observe(source, owner=old_owner),
            lambda: strategy.bridge.claim_entry(old_owner, source, order_id),
            lambda: strategy.control.claim_cancel(
                order_id, fence=latest, owner=old_owner, source=source
            ),
            lambda: strategy.bridge.note_timer(old_owner, source.capture().now_ns, source=source),
            lambda: strategy.control.settle(
                source.account_id, request_id="stale", owner=old_owner, source=source
            ),
        ):
            with pytest.raises(
                (S03BridgeRejected, AstarterBlocked), match=r"^(?:ASTARTER_)?S03_OWNER_STALE$"
            ):
                stale()
        if phase not in {"claim", "cancel"}:
            reasons = ("RECOVERY_REACTIVATION_REQUIRED",)
            new_plan = local_simulation_case().issue(
                parameters=strategy.plan.parameters,
                manifest=strategy.manifest,
                account_id=strategy.plan.account_id,
                group_id=strategy.plan.group_id,
                starts_at_ns=source.capture().now_ns,
                expires_at_ns=strategy.plan.expires_at_ns,
                reactivation_binding=strategy.bridge.reactivation_binding(new_owner, reasons),
            )
            strategy.bridge.reactivate(
                new_owner, source, new_plan, strategy.manifest, reasons=reasons
            )
            strategy.plan = new_plan
        if phase == "settle":
            before = strategy.control.account(source.account_id)
            debit = list(
                strategy.store._connection.execute(
                    "SELECT scope,booked_debit FROM astarter_limits ORDER BY scope"
                )
            )
            repeat = strategy.control.settle(
                source.account_id, request_id="recovery-alias", owner=new_owner, source=source
            )
            after = strategy.control.account(source.account_id)
            assert repeat.new_lock == "0" and before.reserve == after.reserve
            assert before.profit_hwm == after.profit_hwm
            assert [
                tuple(x)
                for x in strategy.store._connection.execute(
                    "SELECT scope,booked_debit FROM astarter_limits ORDER BY scope"
                )
            ] == [tuple(x) for x in debit]
            seen["alias"] = repeat
        seen["reopen_complete"] = True

    reserve = S03BridgeControl.reserve_signal
    claim = S03BridgeControl.claim_entry
    submit = S03NativeStrategy._submit
    cancel = AstarterControl.claim_cancel
    native_cancel = S03NativeStrategy.cancel_order
    resolve = S03BridgeControl.resolve_exit
    settle = AstarterControl.settle

    def after_reserve(control, *args, **kwargs):
        result = reserve(control, *args, **kwargs)
        if phase == "reserve":
            reopen()
        return result

    def after_claim(control, *args, **kwargs):
        result = claim(control, *args, **kwargs)
        if phase == "claim" and result is not None:
            reopen()
        return result

    def after_submit(strategy, command, *args, **kwargs):
        result = submit(strategy, command, *args, **kwargs)
        if phase == "send" and command.role == "ENTRY":
            reopen()
        return result

    def after_cancel(control, *args, **kwargs):
        result = cancel(control, *args, **kwargs)
        if phase == "cancel" and result:
            reopen()
        return result

    def observe_native_cancel(strategy, *args, **kwargs):
        result = native_cancel(strategy, *args, **kwargs)
        if seen["cut"]:
            seen["native_cancels_after_cut"] += 1
        return result

    def after_resolve(control, *args, **kwargs):
        result = resolve(control, *args, **kwargs)
        strategy = seen["strategy"]
        if not seen["cut"] and phase in {"fill", "flat"}:
            snap = strategy.source.capture()
            if phase == "fill" and any(f.side == "BUY" for f in snap.fills):
                reopen()
            elif phase == "flat" and result.flat_ns is not None:
                assert snap.position_quantity == "0" and snap.cash_reconciled
                assert all(
                    o.state in {"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"}
                    for o in snap.orders
                )
                reopen()
        return result

    def after_settle(control, *args, **kwargs):
        result = settle(control, *args, **kwargs)
        if phase == "settle":
            reopen()
        return result

    monkeypatch.setattr(S03BridgeControl, "reserve_signal", after_reserve)
    monkeypatch.setattr(S03BridgeControl, "claim_entry", after_claim)
    monkeypatch.setattr(S03NativeStrategy, "_submit", after_submit)
    monkeypatch.setattr(AstarterControl, "claim_cancel", after_cancel)
    monkeypatch.setattr(S03NativeStrategy, "cancel_order", observe_native_cancel)
    monkeypatch.setattr(S03BridgeControl, "resolve_exit", after_resolve)
    monkeypatch.setattr(AstarterControl, "settle", after_settle)
    try:
        evidence = run_s03_simulation(
            database_path=path, scenario="timer_no_quote" if phase == "claim" else "round_trip"
        )
    except S03BridgeRejected as error:
        assert phase == "settle" and error.code == "S03_OWNER_STALE"
        evidence = None
    except AstarterBlocked as error:
        assert (phase == "settle" and str(error) == "ASTARTER_S03_OWNER_STALE") or (
            phase == "claim"
            and str(error)
            in {
                "ASTARTER_SETTLEMENT_HAS_UNRESOLVED_ORDERS",
                "ASTARTER_SETTLEMENT_HAS_UNRESOLVED_RISK",
            }
        )
        evidence = None
    strategy, native = seen["strategy"], seen["final_native"]
    observed = {
        "phase": phase,
        "reopen_complete": seen.get("reopen_complete", False),
        "cut_time_ns": seen.get("cut_time_ns"),
        "entry_submissions": strategy.entry_submissions,
        "native_cancels_after_cut": seen["native_cancels_after_cut"],
        "native_orders": [
            {"id": o.order_id, "type": o.order_type, "state": o.state} for o in native.orders
        ],
        "errors": strategy.errors,
        "native_action_trace": [
            t
            for t in strategy.trace
            if t["event"] in {"SUBMIT", "CANCEL"} or t["event"].startswith("Order")
        ][-32:],
        "original_commands": [json.loads(bytes(a[2])) for a in seen.get("claims", ())],
    }
    (tmp_path / "recovery-observation.json").write_text(json.dumps(observed, indent=2))
    assert seen.get("reopen_complete"), strategy.errors
    assert native.venue_session == seen["before_session"]
    store = ControlStore.open(path)
    try:
        control = S03ControllerBackend(strategy.control.controller_identity).control(store)
        bridge = S03BridgeControl(store, control=control)
        life = bridge.life(seen["run_id"])
        receipts = store._connection.execute(
            "SELECT receipt_bytes FROM astarter_intents"
        ).fetchall()
        assert len(receipts) == 1 and bytes(receipts[0][0]) == seen["receipt"]
        claims = [
            tuple(a)
            for a in store._connection.execute(
                "SELECT kind,fact_sha256,fact_bytes FROM astarter_audit "
                "WHERE kind IN ('NATIVE_DISPATCH_CLAIMED','NATIVE_CANCEL_INTENT') ORDER BY seq"
            )
        ]
        assert all(old in claims for old in seen["claims"])
        if phase == "claim":
            assert strategy.entry_submissions == 0 and native.orders == ()
            assert "RECONCILIATION_REQUIRED" in life.reasons
            intent = store._connection.execute(
                "SELECT pending_risk,cash_hold FROM astarter_intents"
            ).fetchone()
            assert Decimal(intent[0]) > 0 and Decimal(intent[1]) > 0
        elif phase == "cancel":
            assert seen["native_cancels_after_cut"] == 0
            stops = [o for o in native.orders if o.order_type == "STOP_MARKET"]
            assert stops and any(o.state == "ACCEPTED" for o in stops)
            assert "RECONCILIATION_REQUIRED" in life.reasons
        else:
            assert strategy.entry_submissions == 1
            assert len([o for o in native.orders if o.side == "BUY"]) == 1
            first = min(f.time_ns for f in native.fills if f.side == "BUY")
            assert (
                life.first_fill_ns == first and life.protection_deadline_ns == first + 1_000_000_000
            )
            if phase in {"fill", "flat", "settle"}:
                assert life.first_fill_ns == seen["before_life"]["first_fill_ns"]
                assert life.protection_deadline_ns == seen["before_life"]["protection_deadline_ns"]
            if phase in {"flat", "settle"}:
                assert life.flat_ns == seen["before_life"]["flat_ns"]
            if phase == "settle":
                assert seen["alias"].new_lock == "0"
            if evidence is not None:
                assert json.loads(evidence.evidence_bytes)["fast_path_model_calls"] == 0
    finally:
        store.close()


def _projection(store):
    tables = (
        "astarter_accounts",
        "astarter_intents",
        "astarter_orders",
        "astarter_fills",
        "astarter_audit",
        "s03_runs",
        "s03_events",
        "s03_lifecycle",
        "s03_audit",
    )
    return {
        table: tuple(tuple(row) for row in store._connection.execute(f"SELECT * FROM {table}"))
        for table in tables
    }


def test_native_driver_rolls_back_fill_and_quote_watermarks_then_replays(tmp_path, monkeypatch):
    path = tmp_path / "native-atomic-replay.sqlite"
    seen = {"fill_fault": False, "quote_fault": False, "restores": 0}
    start, save = S03NativeStrategy.on_start, S03BridgeControl._save_life
    resolve, ingest = S03BridgeControl.resolve_exit, S03BridgeControl.ingest
    after_ingest = S03BridgeControl._after_ingest

    def on_start(strategy):
        start(strategy)
        seen["strategy"], seen["source"] = strategy, strategy.source

    def restore(replay):
        strategy, source = seen["strategy"], seen["source"]
        old = strategy.owner
        assert strategy.source is source and not strategy.store._connection.in_transaction
        strategy.store.close()
        strategy.store = ControlStore.open(path)
        strategy.control = S03ControllerBackend(
            strategy.control.controller_identity
        ).control(strategy.store)
        strategy.bridge = S03BridgeControl(strategy.store, control=strategy.control)
        strategy.owner = strategy.bridge.takeover(source, old.run_id)
        strategy.bridge.note_recovery(strategy.owner)
        result = replay(strategy.bridge, strategy.owner, source)
        reasons = ("RECOVERY_REACTIVATION_REQUIRED",)
        approved = local_simulation_case().issue(
            parameters=strategy.plan.parameters,
            manifest=strategy.manifest,
            account_id=strategy.plan.account_id,
            group_id=strategy.plan.group_id,
            starts_at_ns=source.capture().now_ns,
            expires_at_ns=strategy.plan.expires_at_ns,
            reactivation_binding=strategy.bridge.reactivation_binding(strategy.owner, reasons),
        )
        strategy.bridge.reactivate(
            strategy.owner, source, approved, strategy.manifest, reasons=reasons
        )
        strategy.plan = approved
        seen["restores"] += 1
        return result

    def fail_fill_write(control, run_id, life):
        result = save(control, run_id, life)
        if seen.get("inside_resolve") and not seen["fill_fault"] and life.first_fill_ns is not None:
            assert control._c.in_transaction
            native = seen["source"].capture()
            assert any(fill.side == "BUY" for fill in native.fills)
            seen["fill_fault"], seen["native_at_fault"] = True, native
            raise RuntimeError("SYNTHETIC_NATIVE_FILL_TRANSACTION_FAULT")
        return result

    def resolve_with_recovery(control, *args, **kwargs):
        before = _projection(control._store)
        seen["inside_resolve"] = True
        try:
            return resolve(control, *args, **kwargs)
        except RuntimeError as error:
            assert str(error) == "SYNTHETIC_NATIVE_FILL_TRANSACTION_FAULT"
            assert _projection(control._store) == before
            assert seen["source"].capture().fills == seen["native_at_fault"].fills
            result = restore(lambda bridge, owner, source: resolve(bridge, owner, source))
            seen["fill_replayed"] = True
            return result
        finally:
            seen["inside_resolve"] = False

    def fail_quote_write(control, run_id):
        result = after_ingest(control, run_id)
        if seen.get("inside_quote") and seen.get("fill_replayed") and not seen["quote_fault"]:
            assert control._c.in_transaction
            seen["quote_fault"] = True
            raise RuntimeError("SYNTHETIC_QUOTE_WATERMARK_TRANSACTION_FAULT")
        return result

    def ingest_with_recovery(control, owner, source, event):
        if event.kind != "QUOTE" or not seen.get("fill_replayed") or seen["quote_fault"]:
            return ingest(control, owner, source, event)
        before = _projection(control._store)
        native = source.capture()
        seen["inside_quote"] = True
        try:
            return ingest(control, owner, source, event)
        except RuntimeError as error:
            assert str(error) == "SYNTHETIC_QUOTE_WATERMARK_TRANSACTION_FAULT"
            assert _projection(control._store) == before
            actual = source.capture()
            assert actual.fills == native.fills and actual.quote_time_ns == native.quote_time_ns
            result = restore(lambda bridge, current, live: ingest(bridge, current, live, event))
            strategy = seen["strategy"]
            count = strategy.store._connection.execute(
                "SELECT COUNT(*) FROM s03_events WHERE run_id=? AND event_key=?",
                (strategy.owner.run_id, event.event_key),
            ).fetchone()[0]
            assert count == 1
            committed = _projection(strategy.store)
            ingest(strategy.bridge, strategy.owner, source, event)
            assert _projection(strategy.store) == committed
            seen["quote_replayed"] = True
            return result
        finally:
            seen["inside_quote"] = False

    monkeypatch.setattr(S03NativeStrategy, "on_start", on_start)
    monkeypatch.setattr(S03BridgeControl, "_save_life", fail_fill_write)
    monkeypatch.setattr(S03BridgeControl, "resolve_exit", resolve_with_recovery)
    monkeypatch.setattr(S03BridgeControl, "_after_ingest", fail_quote_write)
    monkeypatch.setattr(S03BridgeControl, "ingest", ingest_with_recovery)
    result = run_s03_simulation(database_path=path, scenario="round_trip")
    evidence = json.loads(result.evidence_bytes)
    assert seen.get("fill_replayed") and seen.get("quote_replayed") and seen["restores"] == 2
    assert evidence["status"] == "COMPLETE" and not evidence["errors"]
    assert evidence["entry_submissions"] == 1
    first = min(fill.time_ns for fill in seen["native_at_fault"].fills if fill.side == "BUY")
    assert evidence["life"]["first_fill_ns"] == first
    assert evidence["life"]["protection_deadline_ns"] == first + 1_000_000_000
    assert evidence["duplicate_settlement"]["new_lock"] == "0"


def test_native_driver_rejects_new_source_session_and_keeps_old_reservation(tmp_path, monkeypatch):
    path = tmp_path / "native-new-session-denied.sqlite"
    seen = {}
    start, reserve, close = (
        S03NativeStrategy.on_start,
        S03BridgeControl.reserve_signal,
        NativeFactsSource.close,
    )

    def on_start(strategy):
        start(strategy)
        seen["strategy"] = strategy

    def capture_close(source):
        if source is seen.get("fresh"):
            seen["fresh_snapshot"] = source.capture()
        close(source)

    def change_session(control, *args, **kwargs):
        result = reserve(control, *args, **kwargs)
        strategy = seen["strategy"]
        old_source, old_owner = strategy.source, strategy.owner
        seen["old_session"] = old_source.venue_session
        seen["receipt"] = result
        old_source.close()
        fresh = NativeFactsSource(strategy.item, strategy)
        seen["fresh"], strategy.source = fresh, fresh
        assert fresh.venue_session != seen["old_session"]
        strategy.store.close()
        strategy.store = ControlStore.open(path)
        strategy.control = S03ControllerBackend(
            strategy.control.controller_identity
        ).control(strategy.store)
        strategy.bridge = S03BridgeControl(strategy.store, control=strategy.control)
        with pytest.raises(S03BridgeRejected, match="S03_TAKEOVER_SESSION_MISMATCH"):
            strategy.bridge.takeover(fresh, old_owner.run_id)
        seen["rejected"] = True
        seen["run_id"] = old_owner.run_id
        return result

    monkeypatch.setattr(S03NativeStrategy, "on_start", on_start)
    monkeypatch.setattr(S03BridgeControl, "reserve_signal", change_session)
    monkeypatch.setattr(NativeFactsSource, "close", capture_close)
    try:
        result = run_s03_simulation(database_path=path, scenario="open_position")
        assert json.loads(result.evidence_bytes)["status"] == "FAILED"
    except (S03BridgeRejected, AstarterIntegrityError) as error:
        assert str(error) in {
            "S03_SOURCE_SESSION_MISMATCH",
            "ASTARTER_ACCOUNT_SOURCE_CONFLICT",
            "ASTARTER_NATIVE_SOURCE_CLOSED",
        }
    assert seen.get("rejected") and seen["fresh_snapshot"].orders == ()
    store = ControlStore.open(path)
    try:
        row = store._connection.execute(
            "SELECT venue_session FROM s03_runs WHERE run_id=?", (seen["run_id"],)
        ).fetchone()
        assert row[0] == seen["old_session"]
        receipt = store._connection.execute(
            "SELECT receipt_bytes,pending_risk,cash_hold FROM astarter_intents"
        ).fetchone()
        assert json.loads(bytes(receipt[0]))["intent_id"] == seen["receipt"].intent_id
        assert Decimal(receipt[1]) > 0 and Decimal(receipt[2]) > 0
        assert store._connection.execute("SELECT COUNT(*) FROM astarter_orders").fetchone()[0] == 1
        assert seen["strategy"].entry_submissions == 0
    finally:
        store.close()
