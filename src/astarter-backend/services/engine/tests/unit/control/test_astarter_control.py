"""Real Control SQLite operations and native initial facts; no shadow cash ledger."""

import multiprocessing
import os
import sqlite3
from contextlib import contextmanager
from dataclasses import replace

import pytest

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    AstarterConflict,
    AstarterIntegrityError,
    Opportunity,
    SimulationPolicy,
)
from stark_trading_os.runner.astarter_simulation import SyntheticControllerBackend
from tests.unit.control.astarter_native_setup import native_source


@contextmanager
def setup(path, *, policy=None):
    with native_source() as source:
        store = ControlStore.open(path)
        control = SyntheticControllerBackend.for_source(source).control(store)
        binding = control.activate(source, policy or SimulationPolicy(), component_id="a" * 64)
        try:
            yield control, binding, source, store
        finally:
            store.close()


def opportunity(*, key="btc-opportunity-1", risk="5"):
    return Opportunity(key, 1_700_000_000_000_000_000, 1_700_000_005_000_000_000, risk)


def reserve(control, binding, **changes):
    state = control.account("SIM-001")
    return control.reserve(
        binding,
        opportunity(**changes),
        expected_epoch=state.epoch,
        expected_sequence=state.latest_sequence,
        fence=control.controller_identity.fence,
    )


def test_sizing_receipt_is_persisted_once_and_changed_payload_conflicts(tmp_path):
    with setup(tmp_path / "control.sqlite") as (c, binding, source, store):
        first = reserve(c, binding)
        assert (first.quantity, first.cash_hold, first.stress_loss) == (
            "0.00368",
            "221.46284528",
            "4.99377472",
        )
        again = reserve(c, binding)
        assert first == again
        assert c.account("SIM-001").pending_risk == "5"
        assert store._connection.execute("SELECT COUNT(*) FROM astarter_intents").fetchone()[0] == 1
        with pytest.raises(AstarterConflict):
            reserve(c, binding, risk="6")


def test_binding_and_component_alias_do_not_reset_account_limits_or_occupancy(tmp_path):
    with setup(tmp_path / "control.sqlite") as (c, binding, source, store):
        first = reserve(c, binding)
        alias = c.activate(source, SimulationPolicy(), component_id="b" * 64)
        assert alias != binding
        with pytest.raises(AstarterConflict, match="OPPORTUNITY_CONFLICT"):
            reserve(c, alias)
        assert reserve(c, binding) == first
        assert c.account("SIM-001").pending_risk == "5"
        assert (
            store._connection.execute("SELECT COUNT(*) FROM astarter_accounts").fetchone()[0] == 1
        )
        with native_source() as counterfeit:
            with pytest.raises(AstarterIntegrityError):
                c.activate(counterfeit, SimulationPolicy(), component_id="c" * 64)


def test_source_ordering_and_seal_are_checked_before_publishing(tmp_path):
    with setup(tmp_path / "control.sqlite") as (c, binding, source, store):
        old, latest = source.capture(), source.capture()
        c.observe(source, latest)
        with pytest.raises(AstarterConflict):
            c.observe(source, old)
        with pytest.raises(AstarterIntegrityError):
            c.observe(source, replace(latest, quote_total="999999"))


def test_claim_before_send_is_once_only_and_restart_retains_unknown_risk(tmp_path):
    path = tmp_path / "control.sqlite"
    with setup(path) as (c, binding, source, store):
        receipt = reserve(c, binding)
        old_fence = c.account("SIM-001").fence
        command = c.claim_order(receipt.entry_order_id, fence=old_fence)
        assert command.quantity == "0.00368"
        assert c.claim_order(receipt.entry_order_id, fence=old_fence) is None
        recovered = c.begin_recovery("SIM-001")
        assert recovered.fence == old_fence + 1 and "RECONCILE_REQUIRED" in recovered.locks
        assert recovered.cash_hold == "221.46284528" and recovered.pending_risk == "5"
        with pytest.raises(AstarterConflict):
            c.claim_order(receipt.entry_order_id, fence=old_fence)
        c.observe(source)
        assert (
            "RECONCILE_REQUIRED" in c.account("SIM-001").locks
        )  # missing native order is not zero-fill proof
        with pytest.raises(AstarterBlocked):
            reserve(c, binding, key="different-opportunity")


def test_hard_locks_do_not_disappear_when_the_native_source_reconciles(tmp_path):
    with setup(tmp_path / "control.sqlite") as (c, binding, source, store):
        c.halt("SIM-001", "DAY_LOSS")
        original = c.account("SIM-001").risk_period
        c.begin_recovery("SIM-001")
        c.observe(source)
        state = c.account("SIM-001")
        assert "DAY_LOSS" in state.locks and state.risk_period == original
        with pytest.raises(AstarterBlocked):
            reserve(c, binding)


def test_revoked_private_binding_is_rechecked_before_entry_dispatch(tmp_path):
    with setup(tmp_path / "control.sqlite") as (c, binding, source, store):
        receipt = reserve(c, binding)
        store._connection.execute(
            "UPDATE astarter_bindings SET status='REVOKED' WHERE binding_id=?", (binding,)
        )
        with pytest.raises(AstarterBlocked, match="BINDING"):
            c.claim_order(receipt.entry_order_id, fence=c.account("SIM-001").fence)
        assert c.orders(receipt.intent_id)[0].dispatch_state == "PENDING"


def test_failed_order_intent_write_rolls_back_reservation_hold_epoch_and_audit(tmp_path):
    with setup(tmp_path / "control.sqlite") as (c, binding, source, store):
        before = c.account("SIM-001"), c.audit("SIM-001")
        store._connection.execute(
            "CREATE TEMP TRIGGER reject_astarter_order BEFORE INSERT ON astarter_orders "
            "BEGIN SELECT RAISE(ABORT,'injected order intent failure'); END"
        )
        with pytest.raises(sqlite3.IntegrityError, match="injected order intent"):
            reserve(c, binding)
        assert (c.account("SIM-001"), c.audit("SIM-001")) == before
        assert c.reservations("SIM-001") == ()


def reservation_worker(path, binding, epoch, sequence, fence, barrier, output, key, identity):
    store = ControlStore.open(path)
    try:
        c = SyntheticControllerBackend(identity).control(store)
        barrier.wait(timeout=15)
        try:
            result = c.reserve(
                binding,
                opportunity(key=key, risk="10"),
                expected_epoch=epoch,
                expected_sequence=sequence,
                fence=fence,
            )
            output.put(("RESERVED", result.risk_reserved))
        except AstarterConflict:
            output.put(("CONFLICT", "0"))
    finally:
        store.close()


def test_two_request_processes_share_one_native_account_and_atomic_budget(tmp_path):
    path = tmp_path / "control.sqlite"
    policy = SimulationPolicy(caps=("1000", "500", "1000", "1000", "1000", "1000", "1000"))
    with setup(path, policy=policy) as (c, binding, source, store):
        # Synthetic persisted risk-period precondition, not a fabricated native PnL/cash fact.
        store._connection.execute(
            "UPDATE astarter_limits SET booked_debit='490' "
            "WHERE account_id='SIM-001' AND scope='CYCLE'"
        )
        state = c.account("SIM-001")
        ctx = multiprocessing.get_context("spawn")
        barrier, output = ctx.Barrier(2), ctx.Queue()
        workers = [
            ctx.Process(
                target=reservation_worker,
                args=(
                    str(path),
                    binding,
                    state.epoch,
                    state.latest_sequence,
                    state.fence,
                    barrier,
                    output,
                    f"race-{i}",
                    c.controller_identity,
                ),
            )
            for i in range(2)
        ]
        for p in workers:
            p.start()
        try:
            results = sorted(output.get(timeout=25) for _ in workers)
        finally:
            for p in workers:
                p.join(timeout=5)
                if p.is_alive():
                    p.terminate()
                    p.join(timeout=5)
            output.close()
        assert results == [("CONFLICT", "0"), ("RESERVED", "10")]
        assert all(p.exitcode == 0 for p in workers)
        assert c.account("SIM-001").pending_risk == "10"
        with pytest.raises(AstarterBlocked):
            reserve(c, binding, key="retry", risk="10")


def crash_after_claim(path, binding, epoch, sequence, fence, identity):
    store = ControlStore.open(path)
    c = SyntheticControllerBackend(identity).control(store)
    result = c.reserve(
        binding, opportunity(), expected_epoch=epoch, expected_sequence=sequence, fence=fence
    )
    c.claim_order(result.entry_order_id, fence=fence)
    os._exit(71)  # deliberate abrupt process exit after a real WAL-FULL commit


def test_actual_child_exit_and_fresh_process_reopen_keeps_dispatch_unknown(tmp_path):
    path = tmp_path / "control.sqlite"
    with setup(path) as (c, binding, source, store):
        state = c.account("SIM-001")
        ctx = multiprocessing.get_context("spawn")
        p = ctx.Process(
            target=crash_after_claim,
            args=(str(path), binding, state.epoch, state.latest_sequence, state.fence,
                  c.controller_identity),
        )
        p.start()
        p.join(timeout=20)
        if p.is_alive():
            p.terminate()
            p.join(timeout=5)
        assert p.exitcode == 71
        with ControlReopen(path, c.controller_identity) as fresh:
            state = fresh.begin_recovery("SIM-001")
            assert state.pending_risk == "5" and state.cash_hold == "221.46284528"
            assert "RECONCILE_REQUIRED" in state.locks


class ControlReopen:
    def __init__(self, path, identity):
        self.path = path
        self.identity = identity

    def __enter__(self):
        self.store = ControlStore.open(self.path)
        return SyntheticControllerBackend(self.identity).control(self.store)

    def __exit__(self, *_):
        self.store.close()
