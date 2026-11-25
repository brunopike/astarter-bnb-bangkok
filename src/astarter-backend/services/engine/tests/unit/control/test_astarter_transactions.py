"""D2 semantic regressions against real SQLite and short native fixtures."""

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import asdict, replace
from fractions import Fraction
from hashlib import sha256

import pytest

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.astarter.transaction_service import (
    AdmissionContext,
    AdmissionUpdate,
    admission_dependencies,
)
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    AstarterConflict,
    AstarterIntegrityError,
    SimulationPolicy,
    encode,
    policy_bytes,
)
from stark_trading_os.runner.astarter_simulation import SyntheticControllerBackend
from tests.unit.control.test_astarter_control import opportunity, reserve, setup
from tests.unit.domain.test_strategy_contracts import approval, changed, ready


class SyntheticPlanAdmission:
    """Explicit backend fixture, not a DTO accepted by reserve or an auth issuer.

    Only refresh_admission reads updates; the write transaction uses persisted
    generations and real D1 FK rows. Tests independently change those rows/state.
    """

    def __init__(self, identity, connection):
        self.identity, self.connection = identity, connection
        self.context = AdmissionContext(identity.assignment.binding.account_id,
                                        identity.assignment.venue_session,
                                        "SYNTHETIC-ATOMICITY-NOT-PERMIT", "PLAN_FINITE_ATOMICITY")
        self.update = None
        self.calls = []

    def resolve_context(self):
        assert not self.connection.in_transaction
        self.calls.append("context")
        return self.context

    def resolve_update(self):
        assert not self.connection.in_transaction
        self.calls.append("update")
        assert self.update is not None
        return self.update

    def resolve_scope(self):
        assert not self.connection.in_transaction
        return self.identity.assignment


def save_plan_admission(control, binding, store, backend, *, revision="plan-v1",
                        plan_id="fixture-plan", previous=None, generation=0,
                        plan_changes=None, update_changes=None, publish=True):
    from stark_trading_os.control.astarter import strategy_repository as r
    from stark_trading_os.domain import strategy_contracts as c

    original = ready()
    original = changed(original, plan=changed(
        original.plan, instrument=changed(original.plan.instrument, min_quantity="0.00001")))
    p = changed(original.plan, binding=control.controller_identity.assignment.binding,
                revision=revision, plan_id=plan_id, **(plan_changes or {}))
    # Rebuild subject manifest when testing a different instrument, not a stale DTO.
    observations = tuple(changed(e, subject_sha256=c.contract_hash(p.instrument))
                         for e in original.evidence)
    p = changed(p, evidence_sha256s=tuple(c.contract_hash(e) for e in observations))
    a = changed(approval(p), reference_id="review-" + plan_id + "-" + revision)
    repo = r.StrategyRepository(store._connection, backend)
    repo.save_plan(c.PreflightInput(plan=p, evidence=observations),
                   request_key="plan-" + plan_id + "-" + revision,
                   expected_revision=previous, now_ms=1000)
    repo.save_approval(p.plan_id, a, request_key=a.reference_id, now_ms=1000)
    ep = r.EpisodeReference(binding=p.binding, episode_id="episode-" + plan_id + "-" + revision,
                            plan_id=p.plan_id, revision=p.revision,
                            plan_sha256=c.contract_hash(p), binding_id=binding)
    repo.save_episode(ep)
    backend.update = AdmissionUpdate(
        "admit-" + plan_id + "-" + revision, generation, ep.episode_id, a.reference_id,
        admission_dependencies(c.PreflightInput(plan=p, evidence=observations, approval=a)),
        sha256(policy_bytes(SimulationPolicy())).hexdigest(), 900, 2500, "READY",
    )
    if update_changes:
        backend.update = replace(backend.update, **update_changes)
    if publish:
        control.refresh_admission()
    return p, a, repo


@contextmanager
def plan_setup(path, **options):
    from tests.unit.control.astarter_native_setup import native_source

    with native_source() as source:
        store = ControlStore.open(path)
        clock = [1_000_000_000]
        store._clock = lambda: clock[0]
        owner = SyntheticControllerBackend.for_source(source)
        backend = SyntheticPlanAdmission(owner.identity, store._connection)
        control = AstarterControl(store, backend=owner, admission_backend=backend)
        try:
            binding = control.activate(source, SimulationPolicy(), component_id="a" * 64)
            p, a, repo = save_plan_admission(control, binding, store, backend, **options)
            yield control, binding, source, store, backend, clock, p, a, repo
        finally:
            store.close()


def plan_reserve(control, binding, admission_id, key="plan-opportunity"):
    state = control.account(control.controller_identity.assignment.binding.account_id)
    return control.reserve(binding, opportunity(key=key), expected_epoch=state.epoch,
                           expected_sequence=state.latest_sequence,
                           fence=control.controller_identity.fence, admission_id=admission_id)


def admission_rows(conn):
    return economic_rows(conn) | {
        t: tuple(tuple(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY 1"))
        for t in ("astarter_admission_heads", "astarter_admissions", "astarter_intent_admissions")
    }


@pytest.mark.parametrize("field,value", [("account_id", "foreign-account"),
                                        ("venue_session", "foreign-session"),
                                        ("authority_id", "forged-authority")])
def test_admission_context_cannot_override_scope_or_authority(tmp_path, field, value):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, _, store, backend, *_ = data
        backend.context = replace(backend.context, **{field: value})
        foreign = AstarterControl(store, backend=SyntheticControllerBackend(c.controller_identity),
                                  admission_backend=backend)
        before = admission_rows(store._connection)
        for action in (lambda: foreign.refresh_admission(),
                       lambda: plan_reserve(foreign, b, backend.update.admission_id)):
            with pytest.raises(AstarterBlocked, match="ADMISSION"):
                action()
        assert admission_rows(store._connection) == before


def test_offline_rows_or_dto_do_not_replace_missing_controlled_publication(tmp_path):
    with plan_setup(tmp_path / "control.sqlite", publish=False) as data:
        c, b, _, store, backend, *_ = data
        before = admission_rows(store._connection)
        with pytest.raises(AstarterBlocked):
            plan_reserve(c, b, backend.update.admission_id)
        with pytest.raises(AttributeError):
            AstarterControl(store, backend=SyntheticControllerBackend(c.controller_identity),
                            admission_backend=backend.update)
        for claims in ({"approved": True}, {"balance": "100000"}, {"approval_hash": "a" * 64}):
            with pytest.raises(TypeError):
                c.reserve(b, opportunity(), expected_epoch=1, expected_sequence=1, fence=1,
                          **claims)
        assert admission_rows(store._connection) == before


@pytest.mark.parametrize("field,value", [("revision", "missing-revision"),
                                        ("approval_id", "missing-approval"),
                                        ("account_id", "foreign-account"),
                                        ("binding_id", "f" * 36),
                                        ("scope_id", "f" * 64),
                                        ("episode_id", "missing-episode")])
def test_actual_admission_composite_foreign_keys_reject_cross_identity(tmp_path, field, value):
    with plan_setup(tmp_path / "control.sqlite") as data:
        _, _, _, store, _, *_ = data
        conn = store._connection
        record = dict(conn.execute("SELECT * FROM astarter_admissions").fetchone())
        record.update(admission_id="bad-new-admission", generation=2, **{field: value})
        before = admission_rows(conn)
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            conn.execute(f"INSERT INTO astarter_admissions({','.join(record)}) "
                         f"VALUES({','.join('?' for _ in record)})", tuple(record.values()))
        assert admission_rows(conn) == before


@pytest.mark.parametrize("table", ["astarter_admissions", "astarter_admission_heads",
                                   "astarter_intent_admissions"])
def test_admission_identities_cannot_replace_update_or_delete(tmp_path, table):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, _, store, backend, *_ = data
        plan_reserve(c, b, backend.update.admission_id)
        conn = store._connection
        record = dict(conn.execute(f"SELECT * FROM {table}").fetchone())
        before = admission_rows(conn)
        for sql, values in (
            (f"INSERT OR REPLACE INTO {table}({','.join(record)}) "
             f"VALUES({','.join('?' for _ in record)})", tuple(record.values())),
            (f"UPDATE {table} SET account_id=account_id", ()),
            (f"DELETE FROM {table}", ()),
        ):
            with pytest.raises(sqlite3.IntegrityError, match="immutable"):
                conn.execute(sql, values)
        assert admission_rows(conn) == before


@pytest.mark.parametrize("change", ["fee", "precision", "instrument", "composition", "research",
                                    "minimum"])
def test_unproven_native_mapping_is_not_enabled_by_backend_dto(tmp_path, change):
    from stark_trading_os.domain import strategy_contracts as contracts
    from tests.unit.domain.test_strategy_contracts import strategy

    p = ready().plan
    changes = {}
    if change in {"fee", "precision", "instrument", "minimum"}:
        field, value = {"fee": ("maker_fee", "0.002"), "precision": ("tick", "0.1"),
                        "instrument": ("native_id", "BTC/USDT.OTHER"),
                        "minimum": ("min_quantity", "0.0001")}[change]
        changes["instrument"] = changed(p.instrument, **{field: value})
    elif change == "research":
        changes["spec"] = strategy("S07")
    else:
        ident = changed(p.spec.identity, kind="ASTARTER_COMPOSITION",
                        version=contracts.COMPOSITION_VERSION)
        changes["spec"] = changed(p.spec, identity=ident,
                                  abc=contracts.ABCReference(identity=ident))
    with plan_setup(tmp_path / "control.sqlite", plan_changes=changes) as data:
        c, b, _, store, backend, *_ = data
        before = admission_rows(store._connection)
        with pytest.raises(AstarterBlocked):
            plan_reserve(c, b, backend.update.admission_id)
        assert admission_rows(store._connection) == before


def test_new_publication_is_fenced_and_stale_generation_cannot_resurrect(tmp_path):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, _, source, store, backend, *_ = data
        old = AstarterControl(store, backend=SyntheticControllerBackend(c.controller_identity),
                              admission_backend=backend)
        c.begin_recovery(source.account_id)
        backend.update = replace(backend.update, admission_id="revoke", previous_generation=1,
                                 state="REVOKED")
        before = admission_rows(store._connection)
        with pytest.raises(AstarterConflict, match="CONTROLLER_FENCED"):
            old.refresh_admission()
        assert admission_rows(store._connection) == before
        c.refresh_admission()
        backend.update = replace(backend.update, admission_id="stale-reissue", state="READY")
        before = admission_rows(store._connection)
        with pytest.raises(AstarterConflict, match="GENERATION"):
            c.refresh_admission()
        assert admission_rows(store._connection) == before


def test_two_provisioned_accounts_cannot_cross_read_write_or_link(tmp_path):
    from stark_trading_os.control.astarter import strategy_repository as refs
    from stark_trading_os.control.astarter.transaction_service import ControllerIdentity
    from tests.unit.control.test_astarter_strategy_repository import SyntheticBackend, account

    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, source, store, backend, _, p, _, _ = data
        receipt = plan_reserve(c, b, backend.update.admission_id)
        # Explicit schema fixture, NOT a second NativeFactsSource (fixed SIM-001).
        foreign_scope = SyntheticBackend(changed(p.binding, account_id="other-account"),
                                         "22222222-2222-2222-2222-222222222222")
        conn = store._connection
        account(conn, foreign_scope)
        refs.provision_account_scope(conn, foreign_scope)
        foreign_identity = ControllerIdentity(foreign_scope.assignment, "fixture-other-owner", 1)
        other = SyntheticControllerBackend(foreign_identity).control(store)
        raw = policy_bytes(SimulationPolicy())
        other_binding = "b" * 36
        conn.execute("INSERT INTO astarter_bindings VALUES(?,?,?,?,?,'ACTIVE')",
                     (other_binding, "other-account", "b" * 64, raw, sha256(raw).hexdigest()))
        assert other.account("other-account").cash_hold == "0"
        before = admission_rows(conn)
        for action in (
            lambda: other.account(source.account_id), lambda: c.account("other-account"),
            lambda: other.orders(receipt.intent_id), lambda: other.revoke(b),
            lambda: c.revoke(other_binding),
            lambda: plan_reserve(other, b, backend.update.admission_id),
            lambda: plan_reserve(c, other_binding, backend.update.admission_id),
        ):
            with pytest.raises(AstarterBlocked, match="SCOPE_DENIED"):
                action()
        record = dict(conn.execute("SELECT * FROM astarter_admissions").fetchone())
        record.update(admission_id="cross-account", generation=2, account_id="other-account",
                      binding_id=other_binding)
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            conn.execute(f"INSERT INTO astarter_admissions({','.join(record)}) "
                         f"VALUES({','.join('?' for _ in record)})", tuple(record.values()))
        assert admission_rows(conn) == before


@pytest.mark.parametrize("reason", ["revoke", "expire"])
def test_plan_invalidation_after_actual_native_fill_keeps_protection_exit_settlement(
    tmp_path, monkeypatch, reason,
):
    from stark_trading_os.runner.astarter_simulation import (
        AstarterNativeStrategy,
        run_btc_simulation,
    )

    contexts = {}
    clocks = {}
    checked, failures = [], []
    original_reserve, original_event = AstarterControl.reserve, AstarterNativeStrategy._event

    def plan_control(owner, store):
        clock = [1_000_000_000]
        store._clock = lambda: clock[0]
        backend = SyntheticPlanAdmission(owner.identity, store._connection)
        control = AstarterControl(store, backend=owner, admission_backend=backend)
        contexts[control], clocks[control] = backend, clock
        return control

    def admitted_reserve(control, binding, opportunity, **kwargs):
        backend = contexts[control]
        save_plan_admission(control, binding, control._store, backend)
        # Publication is a separate committed operation, so use its resulting epoch.
        state = control.account(control.controller_identity.assignment.binding.account_id)
        kwargs.update(expected_epoch=state.epoch, admission_id=backend.update.admission_id)
        return original_reserve(control, binding, opportunity, **kwargs)

    def event(strategy, native_event):
        try:
            if type(native_event).__name__ == "OrderFilled" and not checked:
                control = strategy.control
                backend = contexts[control]
                if reason == "revoke":
                    backend.update = replace(backend.update, admission_id="revoked-after-fill",
                                             previous_generation=1, state="REVOKED")
                    control.refresh_admission()
                else:
                    clocks[control][0] = 2_500_000_000
                checked.append(True)
            original_event(strategy, native_event)
        except BaseException as error:
            failures.append((type(error).__name__, str(error)))

    monkeypatch.setattr(SyntheticControllerBackend, "control", plan_control)
    monkeypatch.setattr(AstarterControl, "reserve", admitted_reserve)
    monkeypatch.setattr(AstarterNativeStrategy, "_event", event)
    result = run_btc_simulation(database_path=tmp_path / "native.sqlite", scenario="round_trip")
    report = json.loads(result.evidence_bytes)
    assert failures == [] and checked == [True]
    assert report["errors"] == [] and report["status"] == "COMPLETE"
    assert report["protected_acceptances"] == 1
    assert [f["side"] for f in report["native_snapshot"]["fills"]] == ["BUY", "SELL"]
    assert report["settlement_rows"] == 1 and report["account"]["cash_hold"] == "0"
    assert result.engine_disposed


def test_all_old_revision_risk_and_cash_participate_in_new_plan(tmp_path):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, source, store, backend, _, p, _, _ = data
        receipts = [plan_reserve(c, b, backend.update.admission_id, key=f"old-{i}")
                    for i in range(5)]
        before = c.account(source.account_id)
        assert Fraction(before.pending_risk) == sum(Fraction(r.risk_reserved) for r in receipts)
        assert Fraction(before.cash_hold) == sum(Fraction(r.cash_hold) for r in receipts)
        save_plan_admission(c, b, store, backend, revision="plan-v2", previous=p.revision,
                            generation=1)
        with pytest.raises(AstarterBlocked, match="NO_FEASIBLE_ORDER"):
            plan_reserve(c, b, backend.update.admission_id, key="new-revision-risk")
        after = c.account(source.account_id)
        assert (after.pending_risk, after.cash_hold, after.reserve) == (
            before.pending_risk, before.cash_hold, before.reserve)
        assert c.reservations(source.account_id) == tuple(receipts)


def test_plan_admission_uses_real_rows_and_once_only_link(tmp_path):
    with plan_setup(tmp_path / "control.sqlite") as (c, b, source, store, backend, _, p, a, repo):
        admission = backend.update.admission_id
        receipt = plan_reserve(c, b, admission)
        before = admission_rows(store._connection)
        assert plan_reserve(c, b, admission) == receipt
        assert c.refresh_admission() == admission
        assert admission_rows(store._connection) == before
        link = before["astarter_intent_admissions"]
        assert link == ((receipt.intent_id, source.account_id, b, admission),)
        assert repo.read_plan(p.plan_id, approval_id=a.reference_id,
                              now_ms=1000).decision.execution_authorized is False
        assert receipt.execution_authorized is False
        assert c.claim_order(receipt.entry_order_id, fence=c.controller_identity.fence)
        assert backend.calls == ["context", "update", "update"]


@pytest.mark.parametrize("case", ["missing", "forged", "reference", "future", "expired",
                                  "dependency", "revoked", "policy", "bool", "bool-clock"])
def test_plan_admission_negative_inputs_have_no_economic_effect(tmp_path, case):
    updates = {
        "future": {"starts_at_ms": 1001}, "expired": {"expires_at_ms": 1000},
        "dependency": {"dependency_sha256": "a" * 64}, "revoked": {"state": "REVOKED"},
        "policy": {"policy_sha256": "a" * 64},
    }
    with plan_setup(tmp_path / "control.sqlite", update_changes=updates.get(case)) as data:
        c, b, _, store, backend, clock, _, a, _ = data
        admission = {"missing": None, "forged": "forged", "reference": a.reference_id,
                     "bool": True}.get(case, backend.update.admission_id)
        if case == "bool-clock":
            clock[0] = True
        before = admission_rows(store._connection)
        with pytest.raises((AstarterBlocked, ValueError)):
            plan_reserve(c, b, admission)
        assert admission_rows(store._connection) == before


@pytest.mark.parametrize("field,value", [("previous_generation", True), ("starts_at_ms", True),
                                        ("expires_at_ms", 1.0), ("state", "approved"),
                                        ("dependency_sha256", "not-a-hash")])
def test_backend_publication_strict_types_and_missing_relations(tmp_path, field, value):
    with plan_setup(tmp_path / "control.sqlite", publish=False) as data:
        c, _, _, store, backend, *_ = data
        backend.update = replace(backend.update, **{field: value})
        before = admission_rows(store._connection)
        with pytest.raises(AstarterBlocked, match="UPDATE_INVALID"):
            c.refresh_admission()
        assert admission_rows(store._connection) == before


@pytest.mark.parametrize("replacement", ["plan", "revision", "admission"])
def test_same_key_other_plan_revision_or_admission_conflicts(tmp_path, replacement):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, source, store, backend, _, p, _, _ = data
        old = backend.update.admission_id
        receipt = plan_reserve(c, b, old)
        if replacement == "admission":
            backend.update = replace(backend.update, admission_id="second-admission",
                                     previous_generation=1)
            c.refresh_admission()
        else:
            save_plan_admission(c, b, store, backend, generation=1,
                                plan_id="second-plan" if replacement == "plan" else p.plan_id,
                                revision="plan-v2", previous=p.revision
                                if replacement == "revision" else None)
        before = admission_rows(store._connection)
        with pytest.raises(AstarterConflict, match="OPPORTUNITY_CONFLICT"):
            plan_reserve(c, b, backend.update.admission_id)
        with pytest.raises(AstarterBlocked):
            plan_reserve(c, b, old)
        assert admission_rows(store._connection) == before
        assert c.account(source.account_id).cash_hold == receipt.cash_hold
        fresh = plan_reserve(c, b, backend.update.admission_id, key="new-key")
        assert Fraction(c.account(source.account_id).cash_hold) == (
            Fraction(receipt.cash_hold) + Fraction(fresh.cash_hold))


@pytest.mark.parametrize("purpose", ["LEGACY_FINITE", "Q01_PRODUCT"])
def test_plan_account_cannot_be_downgraded_to_legacy(tmp_path, purpose):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, source, store, backend, *_ = data
        backend.context = replace(backend.context, purpose=purpose)
        other = AstarterControl(store, backend=SyntheticControllerBackend(c.controller_identity),
                                admission_backend=backend)
        before = admission_rows(store._connection)
        with pytest.raises(AstarterBlocked, match="ADMISSION"):
            plan_reserve(other, b, None)
        with pytest.raises(AstarterBlocked, match="ADMISSION"):
            other.activate(source, SimulationPolicy(), component_id="b" * 64)
        assert admission_rows(store._connection) == before


@pytest.mark.parametrize("change", ["revoked", "dependency", "superseded", "expired"])
def test_invalidation_blocks_replay_and_unsent_entry_but_not_risk_reduction(tmp_path, change):
    with plan_setup(tmp_path / "control.sqlite") as data:
        c, b, source, store, backend, clock, p, _, repo = data
        admission = backend.update.admission_id
        receipt = plan_reserve(c, b, admission)
        if change == "expired":
            clock[0] = 2_500_000_000
        elif change == "superseded":
            repo.save_plan(changed(ready(), plan=changed(p, revision="v2"), approval=None),
                           request_key="v2", expected_revision=p.revision, now_ms=1000)
        else:
            backend.update = replace(backend.update, admission_id="invalidated",
                                     previous_generation=1,
                                     state="REVOKED" if change == "revoked"
                                     else "DEPENDENCY_CHANGED")
            c.refresh_admission()
        before = admission_rows(store._connection)
        with pytest.raises(AstarterBlocked):
            plan_reserve(c, b, admission)
        with pytest.raises(AstarterBlocked):
            c.claim_order(receipt.entry_order_id, fence=c.controller_identity.fence)
        assert admission_rows(store._connection) == before
        c.observe(source)
        assert c.prepare_protection(receipt.intent_id) is None  # no invented inventory
        c.request_exit(receipt.intent_id)
        assert c.claim_cancel(receipt.entry_order_id, fence=c.controller_identity.fence) is False
        c.observe(source)
        c.settle(source.account_id, request_id="invalid-admission-settle")


@pytest.mark.parametrize("failure", ["commit", "cancel"])
@pytest.mark.parametrize("operation", ["publish", "reserve"])
def test_admission_real_commit_or_cancel_rolls_back_every_relation(tmp_path, failure, operation):
    path = tmp_path / "control.sqlite"
    with plan_setup(path, publish=operation != "publish") as data:
        c, b, _, store, backend, *_ = data
        before = admission_rows(store._connection)
        commits = []

        def deny(action, arg, _arg2, _database, _trigger):
            if action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT":
                commits.append(arg)
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        original = c._audit

        def interrupt(*args):
            original(*args)
            raise KeyboardInterrupt("after actual admission/economic writes")

        if failure == "commit":
            store._connection.set_authorizer(deny)
        else:
            c._audit = interrupt
        try:
            with pytest.raises(sqlite3.DatabaseError if failure == "commit" else KeyboardInterrupt):
                if operation == "publish":
                    c.refresh_admission()
                else:
                    plan_reserve(c, b, backend.update.admission_id)
        finally:
            store._connection.set_authorizer(None)
            c._audit = original
        assert commits == (["COMMIT"] if failure == "commit" else [])
        assert not store._connection.in_transaction
        assert admission_rows(store._connection) == before
        reopened = ControlStore.open(path)
        try:
            assert admission_rows(reopened._connection) == before
        finally:
            reopened.close()


def test_old_unknown_and_hard_lock_survive_new_revision_and_d1_healthy_projection(tmp_path):
    from stark_trading_os.domain import strategy_contracts as contracts
    from tests.unit.control.test_astarter_strategy_repository import checkpoint

    path = tmp_path / "control.sqlite"
    with plan_setup(path) as data:
        c, b, source, store, backend, _, p, _, repo = data
        receipt = plan_reserve(c, b, backend.update.admission_id)
        c.claim_order(receipt.entry_order_id, fence=c.controller_identity.fence)
        c.halt(source.account_id, "DAY_LOSS")
        new, _, _ = save_plan_admission(c, b, store, backend, revision="plan-v2",
                                        previous=p.revision, generation=1)
        healthy = contracts.StateSnapshot(lifecycle="ACTIVE_REFERENCE", order="NONE",
                                          protection="NOT_REQUIRED",
                                          reconciliation="MATCHED_REFERENCE")
        cp = checkpoint(new, state=healthy, reason_locks=(), request_key="healthy-new-plan")
        repo.save_recovery(cp, now_ms=1000)
        projection = repo.read_recovery(new.plan_id, new.revision, now_ms=1000)
        assert projection.reference_only and not projection.state_policy.new_risk_blocked
        reopened = ControlStore.open(path)
        reopened._clock = store._clock
        try:
            new_backend = SyntheticPlanAdmission(c.controller_identity, reopened._connection)
            recovered = AstarterControl(reopened,
                                        backend=SyntheticControllerBackend(c.controller_identity),
                                        admission_backend=new_backend)
            state = recovered.begin_recovery(source.account_id)
            recovered.observe(source)  # native has no history of claimed order: UNKNOWN remains
            state = recovered.account(source.account_id)
            assert {"DAY_LOSS", "RECONCILE_REQUIRED"} <= set(state.locks)
            assert (state.pending_risk, state.cash_hold) == (
                receipt.risk_reserved, receipt.cash_hold)
            with pytest.raises(AstarterBlocked, match="HALTED"):
                plan_reserve(recovered, b, backend.update.admission_id, key="new-revision")
            assert recovered.reservations(source.account_id) == (receipt,)
            assert recovered.orders(receipt.intent_id)[0].native_state == "UNKNOWN"
        finally:
            reopened.close()


@pytest.mark.parametrize("saved_reference", [False, True])
def test_identity_and_offline_reference_are_not_entry_admission(tmp_path, saved_reference):
    from stark_trading_os.control.astarter import strategy_repository as r
    from stark_trading_os.domain import strategy_contracts as c
    from tests.unit.domain.test_strategy_contracts import approval, changed, ready

    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        class IdentityOnly:
            def resolve_controller(self):
                return control.controller_identity

            def resolve_scope(self):
                return control.controller_identity.assignment

        if saved_reference:
            bundle = ready()
            p = changed(bundle.plan, binding=control.controller_identity.assignment.binding)
            repo = r.StrategyRepository(store._connection, IdentityOnly())
            repo.save_plan(c.PreflightInput(plan=p, evidence=bundle.evidence),
                           request_key="reference", expected_revision=None, now_ms=1000)
            repo.save_approval(p.plan_id, approval(p), request_key="approval", now_ms=1000)
            assert repo.read_plan(p.plan_id, approval_id="fixture-review", now_ms=1000
                                  ).decision.execution_authorized is False
        unapproved = AstarterControl(store, backend=IdentityOnly())
        before = economic_rows(store._connection)
        with pytest.raises(AstarterBlocked, match="ADMISSION"):
            reserve(unapproved, binding)
        assert economic_rows(store._connection) == before


def test_takeover_fences_reservation_early_replay(tmp_path):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        first = reserve(control, binding)
        state = control.account(source.account_id)
        control.begin_recovery(source.account_id)
        before = control.account(source.account_id), control.audit(source.account_id)
        with pytest.raises(AstarterConflict):
            control.reserve(
                binding, opportunity(), expected_epoch=state.epoch,
                expected_sequence=state.latest_sequence, fence=state.fence,
            )
        assert (control.account(source.account_id), control.audit(source.account_id)) == before
        assert control.reservations(source.account_id) == (first,)


def test_same_opportunity_different_binding_is_not_successful_replay(tmp_path):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        first = reserve(control, binding)
        alias = control.activate(source, SimulationPolicy(), component_id="b" * 64)
        before = control.account(source.account_id), control.audit(source.account_id)
        with pytest.raises(AstarterConflict, match="OPPORTUNITY_CONFLICT"):
            reserve(control, alias)
        assert (control.account(source.account_id), control.audit(source.account_id)) == before
        assert control.reservations(source.account_id) == (first,)


@pytest.mark.parametrize("field", ["fence", "expected_epoch", "expected_sequence"])
def test_replay_does_not_accept_bool_integer_tokens(tmp_path, field):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        reserve(control, binding)
        state = control.account(source.account_id)
        values = dict(expected_epoch=state.epoch, expected_sequence=state.latest_sequence,
                      fence=state.fence)
        values[field] = True
        before = control.account(source.account_id), control.audit(source.account_id)
        with pytest.raises(AstarterConflict):
            control.reserve(binding, opportunity(), **values)
        assert (control.account(source.account_id), control.audit(source.account_id)) == before


@pytest.mark.parametrize("method", [
    "activate", "observe", "halt", "revoke", "begin_recovery", "prepare_protection",
    "request_exit", "prepare_exit", "settle", "claim_order", "claim_cancel", "reserve",
])
def test_previous_controller_cannot_mutate_after_takeover(tmp_path, method):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        receipt = reserve(control, binding)
        old = AstarterControl(
            store, backend=SyntheticControllerBackend(control.controller_identity)
        )
        control.begin_recovery(source.account_id)
        before = control.account(source.account_id), control.audit(source.account_id)
        current_fence = control.account(source.account_id).fence
        calls = {
            "activate": lambda: old.activate(source, SimulationPolicy(), component_id="c" * 64),
            "observe": lambda: old.observe(source),
            "halt": lambda: old.halt(source.account_id, "DAY_LOSS"),
            "revoke": lambda: old.revoke(binding),
            "begin_recovery": lambda: old.begin_recovery(source.account_id),
            "prepare_protection": lambda: old.prepare_protection(receipt.intent_id),
            "request_exit": lambda: old.request_exit(receipt.intent_id),
            "prepare_exit": lambda: old.prepare_exit(receipt.intent_id),
            "settle": lambda: old.settle(source.account_id, request_id="stale-owner"),
            "claim_order": lambda: old.claim_order(receipt.entry_order_id, fence=current_fence),
            "claim_cancel": lambda: old.claim_cancel(receipt.entry_order_id, fence=current_fence),
            "reserve": lambda: old.reserve(
                binding, opportunity(), expected_epoch=before[0].epoch,
                expected_sequence=before[0].latest_sequence, fence=current_fence,
            ),
        }
        with pytest.raises(AstarterConflict, match="CONTROLLER_FENCED"):
            calls[method]()
        assert (control.account(source.account_id), control.audit(source.account_id)) == before


def economic_rows(connection):
    return {
        table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in ("astarter_accounts", "astarter_bindings", "astarter_limits",
                      "astarter_intents", "astarter_orders", "astarter_fills",
                      "astarter_settlements", "astarter_audit")
    }


@pytest.mark.parametrize("operation", ["reserve", "recovery", "revoke", "halt", "exit"])
def test_real_sqlite_commit_denial_rolls_back_all_rows_and_owner(tmp_path, operation):
    path = tmp_path / "control.sqlite"
    with setup(path) as (control, binding, source, store):
        receipt = reserve(control, binding)
        before = economic_rows(store._connection)
        identity = control.controller_identity
        commits = []

        def authorizer(action, arg1, arg2, database, trigger):
            if action == sqlite3.SQLITE_TRANSACTION and arg1 == "COMMIT":
                commits.append(arg1)
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        calls = {
            "reserve": lambda: reserve(control, binding, key="commit-refused"),
            "recovery": lambda: control.begin_recovery(source.account_id),
            "revoke": lambda: control.revoke(binding),
            "halt": lambda: control.halt(source.account_id, "DAY_LOSS"),
            "exit": lambda: control.request_exit(receipt.intent_id),
        }
        store._connection.set_authorizer(authorizer)
        try:
            with pytest.raises(sqlite3.DatabaseError, match="not authorized"):
                calls[operation]()
        finally:
            store._connection.set_authorizer(None)
        assert commits == ["COMMIT"]
        assert not store._connection.in_transaction
        assert control.controller_identity == identity
        assert economic_rows(store._connection) == before
        reopened = ControlStore.open(path)
        try:
            assert economic_rows(reopened._connection) == before
        finally:
            reopened.close()


@pytest.mark.parametrize("failure", [KeyboardInterrupt, RuntimeError])
def test_exception_after_audit_insert_rolls_back_all_rows(tmp_path, monkeypatch, failure):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        before = economic_rows(store._connection)
        original = control._audit

        def cancel_after_write(account_id, kind, fact):
            original(account_id, kind, fact)
            if kind == "RISK_RESERVED":
                raise failure("D2 synthetic interruption after actual writes")

        monkeypatch.setattr(control, "_audit", cancel_after_write)
        with pytest.raises(failure):
            reserve(control, binding)
        assert not store._connection.in_transaction
        assert economic_rows(store._connection) == before
        monkeypatch.setattr(control, "_audit", original)
        assert reserve(control, binding).cash_hold == "221.46284528"


def test_missing_backend_never_adopts_existing_account_or_owner(tmp_path):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        untrusted = AstarterControl(store)
        before = economic_rows(store._connection)
        for call in (
            lambda: untrusted.activate(source, SimulationPolicy(), component_id="b" * 64),
            lambda: untrusted.account(source.account_id),
            lambda: untrusted.begin_recovery(source.account_id),
            lambda: untrusted.observe(source),
        ):
            with pytest.raises(AstarterBlocked, match="BACKEND_IDENTITY_REQUIRED"):
                call()
        assert economic_rows(store._connection) == before


@pytest.mark.parametrize("field,value", [
    ("tenant_id", "other-tenant"), ("account_id", "other-account"),
    ("environment", "PAPER"), ("environment", "LIVE"),
])
def test_foreign_backend_scope_cannot_read_or_mutate(tmp_path, field, value):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        receipt = reserve(control, binding)
        identity = control.controller_identity
        assignment = identity.assignment
        private = assignment.binding.model_dump() | {field: value}
        foreign = type(assignment).model_validate(assignment.model_dump() | {"binding": private})
        before = economic_rows(store._connection)
        backend = SyntheticControllerBackend(replace(identity, assignment=foreign))
        if field == "environment":
            with pytest.raises(AstarterBlocked, match="FINITE_OFFLINE_ONLY"):
                AstarterControl(store, backend=backend)
        else:
            other = AstarterControl(store, backend=backend)
            for call in (
                lambda: other.account(source.account_id),
                lambda: other.reservations(source.account_id),
                lambda: other.orders(receipt.intent_id),
                lambda: other.audit(source.account_id),
                lambda: other.revoke(binding),
                lambda: other.request_exit(receipt.intent_id),
                lambda: other.begin_recovery(source.account_id),
            ):
                with pytest.raises(AstarterBlocked, match="SCOPE_DENIED"):
                    call()
        assert economic_rows(store._connection) == before


@pytest.mark.parametrize("field,value", [("owner_id", "foreign-owner"), ("fence", True),
                                       ("fence", 0), ("fence", -1)])
def test_forged_owner_and_bool_fence_rejected(tmp_path, field, value):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        identity = replace(control.controller_identity, **{field: value})
        before = economic_rows(store._connection)
        if field == "fence":
            with pytest.raises(AstarterBlocked, match="BACKEND_IDENTITY_INVALID"):
                AstarterControl(store, backend=SyntheticControllerBackend(identity))
        else:
            other = AstarterControl(store, backend=SyntheticControllerBackend(identity))
            with pytest.raises(AstarterConflict, match="CONTROLLER_FENCED"):
                other.begin_recovery(source.account_id)
        assert economic_rows(store._connection) == before


def test_identical_replay_has_no_new_hold_or_audit_even_after_epoch_change(tmp_path):
    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        state = control.account(source.account_id)
        receipt = reserve(control, binding)
        control.halt(source.account_id, "DAY_LOSS")
        before = economic_rows(store._connection)
        assert control.reserve(binding, opportunity(), expected_epoch=state.epoch,
                               expected_sequence=state.latest_sequence,
                               fence=state.fence) == receipt
        assert economic_rows(store._connection) == before


def test_backend_resolution_and_native_capture_outside_transaction(tmp_path, monkeypatch):
    from stark_trading_os.runner.astarter_facts import NativeFactsSource

    with setup(tmp_path / "control.sqlite") as (control, binding, source, store):
        original = NativeFactsSource.capture
        captured = []

        def capture(native):
            assert not store._connection.in_transaction
            captured.append(True)
            return original(native)

        class Backend:
            def resolve_controller(self):
                assert not store._connection.in_transaction
                return control.controller_identity

        monkeypatch.setattr(NativeFactsSource, "capture", capture)
        other = AstarterControl(store, backend=Backend(),
                                admission_backend=SyntheticControllerBackend(
                                    control.controller_identity))
        other.observe(source)
        reserve(other, binding)
        assert captured == [True]


def test_native_repeated_fills_are_once_only_and_conflicting_trade_rejected(tmp_path, monkeypatch):
    from stark_trading_os.runner.astarter_simulation import (
        AstarterNativeStrategy,
        run_btc_simulation,
    )

    original = AstarterNativeStrategy._event
    checked = []
    failures = []

    def check_event(strategy, native_event):
        original(strategy, native_event)
        if type(native_event).__name__ != "OrderFilled" or checked:
            return
        control, source = strategy.control, strategy.source
        conn = strategy.store._connection
        fills = [tuple(row) for row in conn.execute("SELECT * FROM astarter_fills")]
        audits = [a for a in control.audit(source.account_id) if a["kind"] == "NATIVE_FILL"]
        control.observe(source)
        control.observe(source)
        assert [tuple(row) for row in conn.execute("SELECT * FROM astarter_fills")] == fills
        assert [a for a in control.audit(source.account_id) if a["kind"] == "NATIVE_FILL"] == audits
        snap = source.capture()
        changed = replace(snap.fills[0], fee="99")
        before = economic_rows(conn)
        with pytest.raises(AstarterIntegrityError, match="ATTESTATION"):
            control.observe(source, replace(snap, fills=(changed, *snap.fills[1:])))
        assert economic_rows(conn) == before
        # Valid native input against a deliberately corrupted synthetic stored
        # trade tests the ledger conflict path too, not merely seal rejection.
        raw = encode(asdict(changed))
        update = (
            "UPDATE astarter_fills SET fact_bytes=?,fact_sha256=? "
            "WHERE account_id=? AND order_id=? AND trade_id=?"
        )
        parameters = (raw, sha256(raw).hexdigest(), source.account_id,
                      changed.order_id, changed.trade_id)
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(update, parameters)

        def corrupt_fixture(values):
            # Fault injection only in this newly created synthetic DB. Restore
            # the exact trigger before exercising the production public method.
            ddl = conn.execute(
                "SELECT sql FROM sqlite_schema WHERE name='trg_astarter_fills_immutable_update'"
            ).fetchone()[0]
            conn.execute("DROP TRIGGER trg_astarter_fills_immutable_update")
            try:
                conn.execute(update, values)
            finally:
                conn.execute(ddl)

        corrupt_fixture(parameters)
        corrupted = economic_rows(conn)
        with pytest.raises(AstarterIntegrityError, match="FILL_CONFLICT"):
            control.observe(source)
        assert economic_rows(conn) == corrupted
        for account, order, trade, raw, hashed in fills:
            corrupt_fixture((raw, hashed, account, order, trade))
        checked.append(True)

    def event(strategy, native_event):
        try:
            check_event(strategy, native_event)
        except BaseException as error:
            failures.append((type(error).__name__, str(error)))

    monkeypatch.setattr(AstarterNativeStrategy, "_event", event)
    result = run_btc_simulation(database_path=tmp_path / "native.sqlite", scenario="round_trip")
    assert failures == []
    assert json.loads(result.evidence_bytes)["errors"] == []
    assert result.engine_disposed and checked == [True]


def test_native_partial_fill_keeps_pending_inventory_and_unfilled_cash(tmp_path, monkeypatch):
    from stark_trading_os.runner.astarter_simulation import run_btc_simulation

    original = AstarterControl._refresh_intent
    checked = []

    def refresh(control, intent, snap, native):
        original(control, intent, snap, native)
        entry = native.get(intent["entry_order_id"])
        if checked or entry is None or entry.state != "PARTIALLY_FILLED":
            return
        row = control._intent(intent["intent_id"])
        assert Fraction(row["pending_risk"]) > 0
        assert Fraction(row["inventory_risk"]) > 0
        assert 0 < Fraction(row["cash_hold"]) < Fraction(intent["cash_hold"])
        checked.append((row["pending_risk"], row["inventory_risk"], row["cash_hold"]))

    monkeypatch.setattr(AstarterControl, "_refresh_intent", refresh)
    result = run_btc_simulation(database_path=tmp_path / "native.sqlite", scenario="partial_stop")
    assert json.loads(result.evidence_bytes)["errors"] == []
    assert result.engine_disposed and checked
