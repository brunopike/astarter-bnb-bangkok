"""Exit claims must own an Astarter order. A caller result string is not a fill."""

import pytest

from stark_trading_os.domain.s03_bridge import S03BridgeRejected
from tests.unit.control.test_s03_exit import _arm
from tests.unit.control.test_s03_lifecycle import _market, _position, _push


def test_exit_claim_persists_an_astarter_exit_and_accepted_is_not_terminal(tmp_path) -> None:
    with _position(tmp_path, "cmd.sqlite", _market(), "drop") as pack:
        _book, _engine, _strategy, source, control, owner, *_rest = pack
        now = _arm(pack)
        claimed = control.claim_exit(owner, source, now)
        exits = control._c.execute(
            "SELECT dispatch_state FROM astarter_orders WHERE role='EXIT'"
        ).fetchall()
        assert len(exits) == 1 and exits[0][0] == "DISPATCHING"
        assert claimed.exit_claims == 1
        control.resolve_exit(owner, source)
        _push(pack[1], pack[2], now + 250_000_000, "1253.00", "1254.00", None)
        assert source.capture().now_ns == now + 250_000_000
        with pytest.raises(S03BridgeRejected, match="S03_EXIT_UNRESOLVED"):
            control.claim_exit(owner, source, source.capture().now_ns)
        assert control.life(owner.run_id).exit_claims == 1


def test_protection_failed_cannot_be_deleted_by_name(tmp_path) -> None:
    with _position(tmp_path, "lock.sqlite", _market(), "drop") as pack:
        _book, _engine, _strategy, _source, control, owner, *_rest = pack
        control.note_lock(owner, "PROTECTION_FAILED")
        with pytest.raises(S03BridgeRejected, match="S03_RELEASE_UNEVIDENCED"):
            control.release_reason(owner, "PROTECTION_FAILED")
        assert "PROTECTION_FAILED" in control.life(owner.run_id).reasons
