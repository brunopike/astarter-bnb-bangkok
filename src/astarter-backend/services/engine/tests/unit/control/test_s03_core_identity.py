"""S03 finite authority is bound before a run, never a generic ENTRY permit."""

from contextlib import closing

import pytest

from stark_trading_os.control.astarter.transaction_service import AdmissionContext
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import (
    AstarterBlocked,
    Opportunity,
    SimulationPolicy,
)
from stark_trading_os.runner.astarter_simulation import SyntheticControllerBackend
from tests.unit.control.astarter_native_setup import native_source


class S03Backend(SyntheticControllerBackend):
    def resolve_context(self):
        return AdmissionContext(
            self.identity.assignment.binding.account_id,
            self.identity.assignment.venue_session,
            "SYNTHETIC-S03-FINITE-NOT-Q01",
            "LEGACY_FINITE",
        )


def test_s03_authority_cannot_reserve_before_a_run_exists(tmp_path):
    with native_source() as source, closing(ControlStore.open(tmp_path / "scope.sqlite")) as store:
        control = S03Backend.for_source(source).control(store)
        binding = control.activate(source, SimulationPolicy(), component_id="c" * 64)
        view = control.account(source.account_id)
        now = source.capture().now_ns
        with pytest.raises(AstarterBlocked, match="ASTARTER_S03_BRIDGE_REQUIRED"):
            control.reserve(
                binding,
                Opportunity("no-approved-s03-run", now, now + 1_000_000_000, "5"),
                expected_epoch=view.epoch,
                expected_sequence=view.latest_sequence,
                fence=view.fence,
            )
        assert store._connection.execute("SELECT COUNT(*) FROM astarter_intents").fetchone()[0] == 0


@pytest.mark.parametrize(
    "purpose,authority,error",
    [
        ("LEGACY_FINITE", "SYNTHETIC-LEGACY-FINITE-NOT-Q01", "S03_FINITE_AUTHORITY_REQUIRED"),
        ("PLAN_FINITE_ATOMICITY", "SYNTHETIC-S03-FINITE-NOT-Q01", "S03_FINITE_AUTHORITY_REQUIRED"),
        ("Q01_PRODUCT", "SYNTHETIC-S03-FINITE-NOT-Q01", "Q01_PRODUCT_ADMISSION_UNIMPLEMENTED"),
    ],
)
def test_other_admission_modes_cannot_construct_s03(tmp_path, purpose, authority, error):
    from dataclasses import replace

    from stark_trading_os.control.s03_bridge import S03BridgeControl
    from stark_trading_os.domain.s03_bridge import S03BridgeRejected

    class OtherPurpose(S03Backend):
        def resolve_context(self):
            return replace(super().resolve_context(), purpose=purpose, authority_id=authority)

    with (
        native_source() as source,
        closing(ControlStore.open(tmp_path / "purpose.sqlite")) as store,
    ):
        with pytest.raises((AstarterBlocked, S03BridgeRejected), match=error):
            S03BridgeControl(store, control=OtherPurpose.for_source(source).control(store))
        assert (
            store._connection.execute("SELECT COUNT(*) FROM astarter_accounts").fetchone()[0] == 0
        )


def test_bridge_requires_explicit_same_control(tmp_path):
    from stark_trading_os.control.astarter.service import AstarterControl
    from stark_trading_os.control.s03_bridge import S03BridgeControl

    with native_source() as source, closing(ControlStore.open(tmp_path / "scope.sqlite")) as store:
        with pytest.raises(AstarterBlocked, match="BACKEND_IDENTITY_REQUIRED"):
            S03BridgeControl(store, control=AstarterControl(store))
        with closing(ControlStore.open(tmp_path / "other.sqlite")) as other:
            with pytest.raises(TypeError, match="same controlled Astarter"):
                S03BridgeControl(store, control=S03Backend.for_source(source).control(other))


@pytest.mark.parametrize("first_s03", [True, False])
def test_existing_account_authority_cannot_be_switched(tmp_path, first_s03):
    with (
        native_source() as source,
        closing(ControlStore.open(tmp_path / "authority.sqlite")) as store,
    ):
        backend = S03Backend.for_source(source)
        first_type, second_type = (
            (S03Backend, SyntheticControllerBackend)
            if first_s03
            else (SyntheticControllerBackend, S03Backend)
        )
        first_type(backend.identity).control(store).activate(
            source, SimulationPolicy(), component_id="a" * 64
        )
        before = store._connection.serialize()
        with pytest.raises(AstarterBlocked, match="ADMISSION_PURPOSE_OR_AUTHORITY_CONFLICT"):
            second_type(backend.identity).control(store).activate(
                source, SimulationPolicy(), component_id="b" * 64
            )
        assert store._connection.serialize() == before


def test_failed_s03_activation_still_blocks_generic_entry(tmp_path, monkeypatch):
    from stark_trading_os.control.s03_bridge import S03BridgeControl
    from tests.unit.domain.test_s03_bridge import make_plan

    with native_source() as source, closing(ControlStore.open(tmp_path / "failed.sqlite")) as store:
        control = S03Backend.for_source(source).control(store)
        bridge = S03BridgeControl(store, control=control)
        plan, manifest, _ = make_plan()

        def fail(*args):
            raise RuntimeError("SYNTHETIC_RUN_INSERT_FAILURE")

        monkeypatch.setattr(bridge, "_audit", fail)
        with pytest.raises(RuntimeError, match="SYNTHETIC_RUN_INSERT_FAILURE"):
            bridge.activate(source, plan, manifest)
        assert store._connection.execute("SELECT COUNT(*) FROM s03_runs").fetchone()[0] == 0
        binding = store._connection.execute("SELECT binding_id FROM astarter_bindings").fetchone()[
            0
        ]
        view, now = control.account(source.account_id), source.capture().now_ns
        with pytest.raises(AstarterBlocked, match="S03_BRIDGE_REQUIRED"):
            control.reserve(
                binding,
                Opportunity("failed-run", now, now + 1_000_000_000, "5"),
                expected_epoch=view.epoch,
                expected_sequence=view.latest_sequence,
                fence=view.fence,
            )
        assert store._connection.execute("SELECT COUNT(*) FROM astarter_intents").fetchone()[0] == 0


def test_same_account_foreign_tenant_cannot_read_or_take_over_s03(tmp_path):
    from dataclasses import replace

    from stark_trading_os.control.s03_bridge import S03BridgeControl
    from tests.unit.domain.test_s03_bridge import make_plan

    with native_source() as source, closing(ControlStore.open(tmp_path / "tenant.sqlite")) as store:
        backend = S03Backend.for_source(source)
        bridge = S03BridgeControl(store, control=backend.control(store))
        plan, manifest, _ = make_plan()
        owner = bridge.activate(source, plan, manifest)
        identity = backend.identity
        foreign_identity = replace(
            identity,
            assignment=identity.assignment.model_copy(
                update={
                    "binding": identity.assignment.binding.model_copy(
                        update={"tenant_id": "other-tenant"}
                    )
                }
            ),
        )
        foreign = S03BridgeControl(store, control=S03Backend(foreign_identity).control(store))
        before = store._connection.serialize()
        for call in (
            lambda: foreign.state(owner.run_id),
            lambda: foreign.life(owner.run_id),
            lambda: foreign.takeover(source, owner.run_id),
            lambda: foreign.note_recovery(owner),
        ):
            with pytest.raises(AstarterBlocked, match="SCOPE_DENIED"):
                call()
        assert store._connection.serialize() == before


def test_core_recovery_commit_is_atomic_and_both_owners_are_required(tmp_path):
    import sqlite3

    from stark_trading_os.control.s03_bridge import S03BridgeControl
    from stark_trading_os.domain.astarter_simulation import AstarterConflict
    from stark_trading_os.domain.s03_bridge import S03BridgeRejected
    from tests.unit.domain.test_s03_bridge import make_plan

    with native_source() as source, closing(ControlStore.open(tmp_path / "owners.sqlite")) as store:
        backend = S03Backend.for_source(source)
        current = backend.control(store)
        bridge = S03BridgeControl(store, control=current)
        plan, manifest, _ = make_plan()
        owner = bridge.activate(source, plan, manifest)
        old = S03BridgeControl(store, control=backend.control(store))
        identity, before = current.controller_identity, store._connection.serialize()
        commits = []

        def deny_commit(action, arg1, arg2, database, trigger):
            if action == sqlite3.SQLITE_TRANSACTION and arg1 == "COMMIT":
                commits.append(arg1)
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        store._connection.set_authorizer(deny_commit)
        try:
            with pytest.raises(sqlite3.DatabaseError, match="not authorized"):
                current.begin_recovery(source.account_id, owner=owner)
        finally:
            store._connection.set_authorizer(None)
        assert commits == ["COMMIT"] and current.controller_identity == identity
        assert store._connection.serialize() == before
        current.begin_recovery(source.account_id, owner=owner)
        assert current.controller_identity.fence == identity.fence + 1
        assert "RECOVERY_REACTIVATION_REQUIRED" in bridge.state(owner.run_id).input_reasons
        for call in (
            lambda: old.note_recovery(owner),
            lambda: old.takeover(source, owner.run_id),
            lambda: old._astarter.observe(source, owner=owner),
        ):
            with pytest.raises(AstarterConflict, match="CONTROLLER_FENCED"):
                call()
        newer = bridge.takeover(source, owner.run_id)
        assert newer.fence == owner.fence + 1
        with pytest.raises(S03BridgeRejected, match="S03_OWNER_STALE"):
            bridge.note_recovery(owner)
        assert bridge.note_recovery(newer).fence == newer.fence


@pytest.mark.parametrize(
    "status,error", [("ACTIVE", "S03_LEASE_HELD"), ("CLOSED", "S03_BRIDGE_REQUIRED")]
)
def test_generic_entry_claim_cannot_bypass_bridge_even_after_run_closed(tmp_path, status, error):
    from tests.unit.control.s03_native_setup import s03_bridge
    from tests.unit.control.test_s03_lifecycle import _book, _consume_news, _push
    from tests.unit.control.test_s03_sizing import _case

    plan, manifest, signal, observation = _case("0.005", "0.2")
    when = signal.bar_close_ns + 1_000_000_000
    with _book(when) as (engine, strategy, source):
        with closing(ControlStore.open(tmp_path / "claim.sqlite")) as store:
            _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
            bridge = s03_bridge(store, source)
            owner = bridge.activate(source, plan, manifest)
            _consume_news(bridge, owner, source, manifest)
            control = bridge._astarter
            view = control.account(source.account_id)
            receipt = bridge.reserve_signal(
                owner,
                source,
                signal,
                observation,
                expected_epoch=view.epoch,
                expected_sequence=view.latest_sequence,
            )
            store._connection.execute("UPDATE s03_runs SET status=?", (status,))
            before = store._connection.serialize()
            with pytest.raises(AstarterBlocked, match=error):
                control.claim_order(
                    receipt.entry_order_id, fence=view.fence, owner=owner, source=source
                )
            assert store._connection.serialize() == before
            assert (
                store._connection.execute(
                    "SELECT dispatch_state FROM astarter_orders WHERE order_id=?",
                    (receipt.entry_order_id,),
                ).fetchone()[0]
                == "PENDING"
            )


@pytest.mark.parametrize("mode", ["legacy", "q01", "missing_admission"])
@pytest.mark.parametrize("action", ["halt", "revoke"])
@pytest.mark.parametrize("status", ["ACTIVE", "CLOSED"])
def test_public_mutation_requires_persisted_s03_admission(tmp_path, mode, action, status):
    from dataclasses import replace

    from stark_trading_os.control.astarter.service import AstarterControl
    from stark_trading_os.control.s03_bridge import S03BridgeControl
    from tests.unit.domain.test_s03_bridge import make_plan

    class Q01Backend(S03Backend):
        def resolve_context(self):
            return replace(super().resolve_context(), purpose="Q01_PRODUCT")

    with native_source() as source, closing(ControlStore.open(tmp_path / "mode.sqlite")) as store:
        backend = S03Backend.for_source(source)
        original = backend.control(store)
        bridge = S03BridgeControl(store, control=original)
        plan, manifest, _ = make_plan()
        owner = bridge.activate(source, plan, manifest)
        alternate = (
            AstarterControl(store, backend=backend)
            if mode == "missing_admission"
            else (SyntheticControllerBackend if mode == "legacy" else Q01Backend)(
                backend.identity
            ).control(store)
        )
        binding = store._connection.execute("SELECT binding_id FROM astarter_bindings").fetchone()[
            0
        ]
        store._connection.execute("UPDATE s03_runs SET status=?", (status,))
        before = store._connection.serialize()
        with pytest.raises(AstarterBlocked, match="ADMISSION"):
            if action == "halt":
                alternate.halt(source.account_id, "NATIVE_INTEGRITY", owner=owner)
            else:
                alternate.revoke(binding, owner=owner)
        assert store._connection.serialize() == before


def test_public_mutation_rejects_owner_from_another_native_session(tmp_path):
    from dataclasses import replace

    from stark_trading_os.control.s03_bridge import S03BridgeControl
    from tests.unit.domain.test_s03_bridge import make_plan

    with (
        native_source() as source,
        closing(ControlStore.open(tmp_path / "session.sqlite")) as store,
    ):
        control = S03Backend.for_source(source).control(store)
        bridge = S03BridgeControl(store, control=control)
        plan, manifest, _ = make_plan()
        owner = bridge.activate(source, plan, manifest)
        forged = replace(owner, venue_session="00000000-0000-0000-0000-000000000000")
        before = store._connection.serialize()
        with pytest.raises(AstarterBlocked, match="S03_OWNER_STALE"):
            control.halt(source.account_id, "NATIVE_INTEGRITY", owner=forged)
        assert store._connection.serialize() == before
