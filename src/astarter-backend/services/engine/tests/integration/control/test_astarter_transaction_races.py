"""Independent SQLite connections; barriers stay outside write transactions."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from fractions import Fraction
from threading import Barrier, Event

import pytest

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    AstarterConflict,
    SimulationPolicy,
)
from stark_trading_os.runner.astarter_simulation import SyntheticControllerBackend
from tests.unit.control.test_astarter_control import opportunity, reserve, setup
from tests.unit.control.test_astarter_transactions import SyntheticPlanAdmission, plan_setup
from tests.unit.domain.test_strategy_contracts import changed, ready


@pytest.mark.parametrize("transition", ["revoke", "revision", "dependency"])
@pytest.mark.parametrize("ordering", ["simultaneous", "transition-first", "reserve-first"])
def test_plan_authority_changes_and_reserve_are_one_serial_transaction(
    tmp_path, transition, ordering,
):
    from stark_trading_os.control.astarter.strategy_repository import StrategyRepository

    path = tmp_path / "control.sqlite"
    with plan_setup(path) as data:
        control, binding, source, store, backend, _, plan, _, _ = data
        identity = control.controller_identity
        admission = backend.update.admission_id
        before = control.account(source.account_id)
        barrier, first_done = Barrier(2), Event()

        def worker(action):
            independent = ControlStore.open(path)
            independent._clock = lambda: 1_000_000_000
            local = SyntheticPlanAdmission(identity, independent._connection)
            local.update = replace(backend.update, admission_id="changed-authority",
                                   previous_generation=1, state="REVOKED"
                                   if transition == "revoke" else "DEPENDENCY_CHANGED")
            own = AstarterControl(independent, backend=SyntheticControllerBackend(identity),
                                  admission_backend=local)
            trace = []
            independent._connection.set_trace_callback(trace.append)
            try:
                barrier.wait(timeout=10)
                first = "transition" if ordering == "transition-first" else "reserve"
                if ordering != "simultaneous" and action != first:
                    assert first_done.wait(timeout=10)  # strictly OUTSIDE write transaction
                try:
                    if action == "transition":
                        if transition == "revision":
                            StrategyRepository(independent._connection, local).save_plan(
                                changed(ready(), plan=changed(plan, revision="v2"), approval=None),
                                request_key="race-v2", expected_revision=plan.revision, now_ms=1000,
                            )
                        else:
                            own.refresh_admission()
                        return "CHANGED", trace
                    try:
                        own.reserve(binding, opportunity(key="raced-plan"),
                                    expected_epoch=before.epoch,
                                    expected_sequence=before.latest_sequence, fence=identity.fence,
                                    admission_id=admission)
                        return "RESERVED", trace
                    except (AstarterBlocked, AstarterConflict):
                        return "REJECTED", trace
                finally:
                    if action == first:
                        first_done.set()
            finally:
                independent.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(worker, ("reserve", "transition")))
        assert outcomes[1][0] == "CHANGED"
        if ordering == "transition-first":
            assert outcomes[0][0] == "REJECTED"
        if ordering == "reserve-first":
            assert outcomes[0][0] == "RESERVED"
        trace = outcomes[0][1]
        begin = trace.index("BEGIN IMMEDIATE")
        for table in ("astarter_admission_heads", "astarter_admissions"):
            assert any(table in sql and sql.startswith("SELECT") for sql in trace[begin + 1:])
        if transition == "revision" or outcomes[0][0] == "RESERVED":
            for table in ("astarter_plan_versions", "astarter_approval_references"):
                assert any(table in sql for sql in trace[begin + 1:])
        receipts = control.reservations(source.account_id)
        assert len(receipts) == (1 if outcomes[0][0] == "RESERVED" else 0)
        state = control.account(source.account_id)
        assert state.pending_risk == ("5" if receipts else "0")
        assert state.cash_hold == ("221.46284528" if receipts else "0")
        with pytest.raises((AstarterBlocked, AstarterConflict)):
            control.reserve(binding, opportunity(key="after-change"), expected_epoch=state.epoch,
                            expected_sequence=state.latest_sequence, fence=identity.fence,
                            admission_id=admission)
        assert len(control.reservations(source.account_id)) == len(receipts)


@pytest.mark.parametrize("constraint", ["cash", "risk"])
def test_independent_connections_cannot_overspend_and_retry_rechecks(constraint, tmp_path):
    path = tmp_path / "control.sqlite"
    policy = SimulationPolicy(caps=("1000",) * 7)
    with setup(path, policy=policy) as (control, binding, source, store):
        if constraint == "cash":
            # Consume actual reservations against the native 10000 USDT, not fake cash.
            for i in range(9):
                reserve(control, binding, key=f"existing-{i}", risk="25")
        else:
            # Risk-period debit precondition is not a manufactured native fill or PnL.
            store._connection.execute(
                "UPDATE astarter_limits SET booked_debit='995' WHERE scope='CYCLE'"
            )
        before = control.account(source.account_id)
        identity = control.controller_identity
        barrier = Barrier(2)

        def worker(index):
            independent = ControlStore.open(path)
            try:
                own = SyntheticControllerBackend(identity).control(independent)
                barrier.wait(timeout=10)
                try:
                    receipt = own.reserve(
                        binding, opportunity(key=f"racing-{index}", risk="25"),
                        expected_epoch=before.epoch, expected_sequence=before.latest_sequence,
                        fence=identity.fence,
                    )
                    return "RESERVED", receipt
                except AstarterConflict:
                    # Fresh epoch is not a fresh budget; the committed hold participates.
                    with pytest.raises(AstarterBlocked, match="NO_FEASIBLE_ORDER"):
                        reserve(own, binding, key=f"retry-{index}", risk="25")
                    return "CONFLICT", None
            finally:
                independent.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(worker, range(2)))
        assert sorted(row[0] for row in results) == ["CONFLICT", "RESERVED"]
        state = control.account(source.account_id)
        assert Fraction(state.cash_hold) <= Fraction(source.initial_quote)
        if constraint == "risk":
            assert Fraction(state.pending_risk) <= 5
        reservations = control.reservations(source.account_id)
        assert len(reservations) == (10 if constraint == "cash" else 1)
        audits = [a for a in control.audit(source.account_id) if a["kind"] == "RISK_RESERVED"]
        assert len(audits) == len(reservations)


@pytest.mark.parametrize("transition", ["revoke", "takeover"])
def test_revoke_or_takeover_racing_reservation_serializes_without_losing_hold(tmp_path, transition):
    path = tmp_path / "control.sqlite"
    with setup(path) as (control, binding, source, store):
        identity = control.controller_identity
        before = control.account(source.account_id)
        barrier = Barrier(2)

        def worker(action):
            independent = ControlStore.open(path)
            try:
                own = SyntheticControllerBackend(identity).control(independent)
                barrier.wait(timeout=10)
                if action == "transition":
                    if transition == "revoke":
                        own.revoke(binding)
                    else:
                        own.begin_recovery(source.account_id)
                    return "TRANSITIONED"
                try:
                    own.reserve(binding, opportunity(), expected_epoch=before.epoch,
                                expected_sequence=before.latest_sequence, fence=identity.fence)
                    return "RESERVED"
                except (AstarterConflict, AstarterBlocked):
                    return "REJECTED"
            finally:
                independent.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(worker, ("reserve", "transition")))
        assert results[1] == "TRANSITIONED"
        state = control.account(source.account_id)
        receipts = control.reservations(source.account_id)
        assert len(receipts) == (1 if results[0] == "RESERVED" else 0)
        assert state.pending_risk == ("5" if receipts else "0")
        assert state.cash_hold == ("221.46284528" if receipts else "0")
        with pytest.raises((AstarterConflict, AstarterBlocked)):
            reserve(control, binding, key="late-old-writer")
        if transition == "takeover":
            assert state.fence == identity.fence + 1
            assert "RECONCILE_REQUIRED" in state.locks
        else:
            assert store._connection.execute(
                "SELECT status FROM astarter_bindings WHERE binding_id=?", (binding,)
            ).fetchone()[0] == "REVOKED"
