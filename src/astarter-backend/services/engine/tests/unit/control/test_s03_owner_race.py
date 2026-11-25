"""Final S03 authorization has to be in the same transaction as the write."""

import pytest

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.s03_bridge import S03BridgeRejected
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_lifecycle import _book, _consume_news, _push
from tests.unit.control.test_s03_sizing import _case


def test_auth_revoked_between_the_gate_and_the_reserve_cannot_leave_a_reservation(tmp_path) -> None:
    plan, manifest, signal, observation = _case("0.005", "0.2")
    when = signal.bar_close_ns + 1_000_000_000
    path = tmp_path / "race.sqlite"
    with _book(when) as (engine, strategy, source):
        _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
        control = s03_bridge(ControlStore.open(path), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        account = control._astarter.account("SIM-001")

        def revoke() -> None:
            s03_bridge(ControlStore.open(path), source).note_lock(owner, "AUTH_REVOKED")

        control._before_reserve_write = revoke  # type: ignore[method-assign]
        with pytest.raises(S03BridgeRejected, match="S03_NEW_RISK_LOCKED"):
            control.reserve_signal(
                owner,
                source,
                signal,
                observation,
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
        assert (
            control._c.execute("SELECT COUNT(*) FROM astarter_intents").fetchone()[0] == 0
        )


def test_takeover_between_the_check_and_the_claim_rejects_the_old_owner(tmp_path) -> None:
    plan, manifest, signal, observation = _case("0.005", "0.2")
    when = signal.bar_close_ns + 1_000_000_000
    path = tmp_path / "claim.sqlite"
    with _book(when) as (engine, strategy, source):
        _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
        control = s03_bridge(ControlStore.open(path), source)
        owner = control.activate(source, plan, manifest)
        _consume_news(control, owner, source, manifest)
        account = control._astarter.account("SIM-001")
        reserved = control.reserve_signal(
            owner,
            source,
            signal,
            observation,
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
        )
        other = s03_bridge(ControlStore.open(path), source)

        def takeover() -> None:
            other.takeover(source, owner.run_id)

        control._before_claim_write = takeover  # type: ignore[method-assign]
        with pytest.raises(S03BridgeRejected, match="S03_OWNER_STALE"):
            control.claim_entry(owner, source, reserved.entry_order_id)
        state = control._c.execute(
            "SELECT dispatch_state FROM astarter_orders WHERE order_id=?",
            (reserved.entry_order_id,),
        ).fetchone()[0]
        assert state == "PENDING"
