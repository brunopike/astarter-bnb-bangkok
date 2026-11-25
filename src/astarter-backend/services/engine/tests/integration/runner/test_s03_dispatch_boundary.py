"""Native dispatch is fenced until its call returns; callbacks consume real cache after commit."""

import json
import sqlite3

import pytest

from stark_trading_os.control.s03_bridge import S03BridgeControl
from stark_trading_os.runner import s03_simulation as sim


@pytest.mark.parametrize("action", ["submit", "cancel"])
def test_takeover_cannot_cross_native_dispatch_and_callbacks_wait_for_commit(
    tmp_path, monkeypatch, action
):
    path = tmp_path / "dispatch.sqlite"
    seen = {"checks": 0, "deferred": 0}
    start = sim.S03NativeStrategy.on_start
    original_submit = sim.S03NativeStrategy.submit_order
    original_cancel = sim.S03NativeStrategy.cancel_order
    resolve = S03BridgeControl.resolve_exit

    def on_start(strategy):
        start(strategy)
        seen["strategy"] = strategy
        # Probe with a raw writer; leave every Control connection setting unchanged.
        seen["other"] = sqlite3.connect(path, timeout=0, isolation_level=None)

    def check(strategy):
        owner = strategy.owner
        assert strategy._dispatching and strategy.store._connection.in_transaction
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            seen["other"].execute("BEGIN IMMEDIATE")
        assert (
            seen["other"]
            .execute("SELECT fence FROM s03_runs WHERE run_id=?", (owner.run_id,))
            .fetchone()[0]
            == owner.fence
        )
        assert not seen["other"].in_transaction
        seen["checks"] += 1

    def submit(strategy, order):
        if action == "submit":
            check(strategy)
        result = original_submit(strategy, order)
        if action == "submit":
            # Replay an actual native notification while the dispatch call is still active.
            actual = strategy.cache.order(order.client_order_id).events()[-1]
            strategy._native_event(actual)
            assert strategy._deferred_events[-1] is actual
            seen["deferred"] += 1
        return result

    def cancel(strategy, order_id):
        if action == "cancel":
            check(strategy)
        return original_cancel(strategy, order_id)

    def after_commit(control, *args, **kwargs):
        assert not control._c.in_transaction
        return resolve(control, *args, **kwargs)

    monkeypatch.setattr(sim.S03NativeStrategy, "on_start", on_start)
    monkeypatch.setattr(sim.S03NativeStrategy, "submit_order", submit)
    monkeypatch.setattr(sim.S03NativeStrategy, "cancel_order", cancel)
    monkeypatch.setattr(S03BridgeControl, "resolve_exit", after_commit)
    try:
        result = json.loads(
            sim.run_s03_simulation(
                database_path=path,
                scenario="open_position" if action == "submit" else "cancel_race",
            ).evidence_bytes
        )
        seen["other"].execute("BEGIN IMMEDIATE")
        seen["other"].rollback()
    finally:
        if "other" in seen:
            seen["other"].close()
    assert seen["checks"] > 0, result["errors"]
    assert not result["errors"]
    assert result["native_snapshot"]["cash_reconciled"]
    if action == "submit":
        assert seen["deferred"] == seen["checks"]
        assert result["status"] == "OPEN_POSITION"
        assert not seen["strategy"]._deferred_events
    else:
        assert result["status"] == "COMPLETE"


def test_actual_matching_configuration_is_in_the_evidence(tmp_path, monkeypatch):
    observed = {}
    latency = sim.StaticLatencyModel

    def latency_model(**kwargs):
        observed["latency"] = kwargs
        return latency(**kwargs)

    # Native engine methods are immutable; instrument the existing module factory instead.
    monkeypatch.setattr(sim, "StaticLatencyModel", latency_model)
    result = json.loads(
        sim.run_s03_simulation(
            database_path=tmp_path / "profile.sqlite", scenario="zero_fill"
        ).evidence_bytes
    )
    profile = result["matching_assumptions"]
    assert profile["engine_version"] == "2.0.0rc3"
    assert profile["insert_latency_ns"] == observed["latency"]["insert_latency_nanos"] == 1_000_000
    assert profile["cancel_latency_ns"] == observed["latency"]["cancel_latency_nanos"] == 1_000_000
    assert not profile["bar_execution"] and not profile["trade_execution"]
    assert profile["liquidity_consumption"] and not profile["allow_cash_borrowing"]


def test_fenced_old_driver_returns_failure_without_borrowing_new_owner(tmp_path, monkeypatch):
    from stark_trading_os.control.registry import ControlStore

    path = tmp_path / "fenced.sqlite"
    seen = {}
    original_claim = S03BridgeControl.claim_entry

    def takeover_after_claim(control, owner, source, order_id):
        command = original_claim(control, owner, source, order_id)
        if command is not None and not seen:
            other = ControlStore.open(path)
            try:
                context = sim.S03ControllerBackend(
                    control._astarter.controller_identity
                ).control(other)
                current = S03BridgeControl(other, control=context).takeover(source, owner.run_id)
                assert current.fence == owner.fence + 1
                seen["audit_count"] = other._connection.execute(
                    "SELECT COUNT(*) FROM astarter_audit"
                ).fetchone()[0]
            finally:
                other.close()
        return command

    monkeypatch.setattr(S03BridgeControl, "claim_entry", takeover_after_claim)
    result = json.loads(
        sim.run_s03_simulation(database_path=path, scenario="open_position").evidence_bytes
    )
    assert result["status"] == "FAILED" and result["entry_submissions"] == 0
    assert result["native_snapshot"]["orders"] == []
    assert result["reconciliation_rejection"] == "S03_OWNER_STALE"
    assert result["settlement"] is None and result["duplicate_settlement"] is None
    assert result["account"]["pending_risk"] == "5"
    assert len(result["audit"]) == seen["audit_count"]
    assert result["cleanup"] == dict(source_closed=True, store_closed=True, engine_disposed=True)
