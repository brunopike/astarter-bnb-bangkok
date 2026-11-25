"""S03 control must only accept observations the approved manifest can replay."""

from dataclasses import replace

import pytest

from stark_trading_os.domain.s03_bridge import S03BridgeRejected
from stark_trading_os.domain.s03_signal import S03IndicatorSnapshot
from tests.unit.control.test_s03_lifecycle import _market, _observation, _position


def test_forged_ema_does_not_become_a_forced_exit(tmp_path) -> None:
    with _position(tmp_path, "forged.sqlite", _market()) as pack:
        _book, _engine, _strategy, source, control, owner, plan, *_rest = pack
        first = pack[10] + 1_000_000_000
        forged = replace(
            _observation(plan, first, 10, fast=1, slow=2),
            snapshot=S03IndicatorSnapshot(
                ema_fast=1, ema_slow=2, close=100, atr=0.2, rsi=10, previous_rsi=None
            ),
        )
        with pytest.raises(S03BridgeRejected, match="S03_OBSERVATION_UNTRUSTED"):
            control.apply_bar(owner, source, forged)
        assert control.life(owner.run_id).exit_target is None
        assert (
            control._c.execute(
                "SELECT COUNT(*) FROM s03_events WHERE run_id=? AND kind='BAR'",
                (owner.run_id,),
            ).fetchone()[0]
            == 0
        )


def test_a_future_bar_and_a_later_reversal_are_rejected(tmp_path) -> None:
    with _position(tmp_path, "order.sqlite", _market()) as pack:
        _book, engine, strategy, source, control, owner, plan, *_rest = pack
        first = pack[10] + 1_000_000_000
        future = _observation(plan, first + 50 * 60 * 1_000_000_000, 10, fast=1, slow=2)
        with pytest.raises(S03BridgeRejected, match="S03_OBSERVATION_FUTURE"):
            control.apply_bar(owner, source, future)
        assert (
            control._c.execute(
                "SELECT COUNT(*) FROM s03_events WHERE run_id=? AND kind='BAR'",
                (owner.run_id,),
            ).fetchone()[0]
            == 0
        )


def test_native_fill_opens_protection_before_the_next_bar(tmp_path) -> None:
    with _position(tmp_path, "fill.sqlite", _market()) as pack:
        _book, _engine, _strategy, source, control, owner, *_rest = pack
        when = pack[10] + 1_000_000_000
        from tests.unit.control.test_s03_lifecycle import _quote

        event = _quote(when, manifest=pack[11])
        control.ingest(owner, source, event)
        life = control.life(owner.run_id)
        assert life.first_fill_ns == when
        assert life.protection_deadline_ns == when + 1_000_000_000
