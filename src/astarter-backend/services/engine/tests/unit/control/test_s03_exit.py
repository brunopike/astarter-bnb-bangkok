"""S03 exit claims, deadlines, residual protection, and locks on a new test database."""

import pytest
from nautilus_trader.model import Price, Quantity, QuoteTick

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import Opportunity, SimulationPolicy
from stark_trading_os.domain.s03_bridge import S03BridgeRejected, replay_s03_observations
from stark_trading_os.runner.astarter_simulation import SyntheticControllerBackend
from tests.unit.control.astarter_native_setup import native_source
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_lifecycle import _market, _position, _push
from tests.unit.domain.test_s03_bridge import START

GAP = 250_000_000
DEADLINE = 1_000_000_000


def _arm(pack) -> int:
    engine, strategy, source, control, owner, plan = pack[1:7]
    manifest = pack[11]
    first = pack[10] + 1_000_000_000
    low = [
        item
        for item in replay_s03_observations(plan, manifest)
        if (
            item.ready
            and not item.gap_reset
            and item.snapshot.rsi < 30
            and item.bar_close_ns > first
        )
    ]
    for item in low[:2]:
        _push(engine, strategy, item.available_at_ns, "1253.00", "1254.00", None)
        control.apply_bar(owner, source, item)
    assert control.life(owner.run_id).exit_target == "C"
    return strategy.clock.timestamp_ns()


def _rest_canceled(pack, life, ts: int):
    engine, strategy, source, control, owner = pack[1], pack[2], pack[3], pack[4], pack[5]
    quantity = control._c.execute(
        "SELECT quantity FROM astarter_orders WHERE order_id=?",
        (life.exit_order_id,),
    ).fetchone()[0]
    strategy.ticket = (life.exit_order_id, "SELL", str(quantity), None)
    engine.add_data(
        [
            QuoteTick(
                strategy.item.id,
                Price.from_str("1253.00"),
                Price.from_str("1254.00"),
                Quantity.from_str("0.00001"),
                Quantity.from_str("0.00001"),
                ts,
                ts,
            )
        ]
    )
    engine.run(streaming=True)
    return control.resolve_exit(owner, source)


def test_exit_interval_is_250ms_and_the_fourth_claim_is_refused(tmp_path) -> None:
    with _position(tmp_path, "interval.sqlite", _market(), "drop") as pack:
        _book_cm, engine, strategy, source, control, owner, _plan, *_rest = pack
        now = _arm(pack)
        assert source.capture().now_ns == now
        first = control.claim_exit(owner, source, now)
        assert first.exit_claims == 1 and first.exit_deadline_ns == now + DEADLINE
        assert first.exit_order_id
        _rest_canceled(pack, first, now + 1_000_000)
        _push(engine, strategy, now + GAP - 1_000_000, "1253.00", "1254.00", None)
        assert source.capture().now_ns == now + GAP - 1_000_000
        with pytest.raises(S03BridgeRejected, match="S03_EXIT_TOO_SOON"):
            control.claim_exit(owner, source, now + GAP - 1_000_000)
        _push(engine, strategy, now + GAP, "1253.00", "1254.00", None)
        assert source.capture().now_ns == now + GAP
        second = control.claim_exit(owner, source, now + GAP)
        assert second.exit_claims == 2
        _rest_canceled(pack, second, now + GAP + 1_000_000)
        _push(engine, strategy, now + 2 * GAP, "1253.00", "1254.00", None)
        assert source.capture().now_ns == now + 2 * GAP
        third = control.claim_exit(owner, source, now + 2 * GAP)
        assert third.exit_claims == 3 and "EXIT_BLOCKED" in third.reasons
        _rest_canceled(pack, third, now + 2 * GAP + 1_000_000)
        _push(engine, strategy, now + 3 * GAP, "1253.00", "1254.00", None)
        assert source.capture().now_ns == now + 3 * GAP
        with pytest.raises(S03BridgeRejected, match="S03_EXIT_EXHAUSTED"):
            control.claim_exit(owner, source, now + 3 * GAP)


def test_deadline_timer_residual_and_reopen_keep_claims(tmp_path) -> None:
    path = tmp_path / "timer.sqlite"
    with _position(tmp_path, "timer.sqlite", _market(), "drop") as pack:
        _book_cm, _engine, strategy, source, control, owner, _plan, *_rest = pack
        now = _arm(pack)
        before = source.capture()
        assert before.now_ns == now
        claimed = control.claim_exit(owner, source, now)
        quotes = control.state(owner.run_id).accepted_quote_count
        deadline = now + DEADLINE
        assert claimed.exit_deadline_ns == deadline
        strategy.clock.set_time(deadline)
        at_deadline = source.capture()
        assert at_deadline.now_ns == deadline
        assert at_deadline.quote_time_ns == before.quote_time_ns
        assert at_deadline.source_event_time_ns == before.source_event_time_ns
        timed = control.note_timer(owner, deadline, source=source)
        assert "RECONCILIATION_REQUIRED" not in timed.reasons
        strategy.clock.set_time(deadline + 1)
        after_deadline = source.capture()
        assert after_deadline.now_ns == deadline + 1
        assert after_deadline.quote_time_ns == before.quote_time_ns
        assert after_deadline.source_event_time_ns == before.source_event_time_ns
        unknown = control.note_timer(owner, deadline + 1, source=source)
        assert "RECONCILIATION_REQUIRED" in unknown.reasons
        assert control.state(owner.run_id).accepted_quote_count == quotes
        with pytest.raises(S03BridgeRejected, match="S03_EXIT_UNRESOLVED"):
            control.claim_exit(owner, source, deadline + 1)
        with pytest.raises(S03BridgeRejected, match="S03_RELEASE_UNEVIDENCED"):
            control.release_reason(owner, "RECONCILIATION_REQUIRED")
        reopened = s03_bridge(ControlStore.open(path), source)
        kept = reopened.life(owner.run_id)
        assert kept.exit_claims == 1
        assert kept.exit_deadline_ns == claimed.exit_deadline_ns
        assert "RECONCILIATION_REQUIRED" in kept.reasons


def test_revoked_auth_and_news_do_not_stop_an_existing_exit(tmp_path) -> None:
    with _position(tmp_path, "auth.sqlite", _market(), "drop") as pack:
        (
            _book_cm,
            engine,
            strategy,
            source,
            control,
            owner,
            _plan,
            signal,
            observation,
            *_rest,
        ) = pack
        now = _arm(pack)
        control.note_lock(owner, "AUTH_REVOKED")
        with pytest.raises(S03BridgeRejected, match="S03_NEW_RISK_LOCKED"):
            control.reserve_signal(
                owner,
                source,
                signal,
                observation,
                expected_epoch=1,
                expected_sequence=1,
            )
        assert source.capture().now_ns == now
        claimed = control.claim_exit(owner, source, now)
        assert claimed.exit_claims == 1 and "AUTH_REVOKED" in claimed.reasons
        _rest_canceled(pack, claimed, now + 1_000_000)
        control.note_lock(owner, "NEWS_LOCK")
        _push(engine, strategy, now + GAP, "1253.00", "1254.00", None)
        assert source.capture().now_ns == now + GAP
        followed = control.claim_exit(owner, source, now + GAP)
        assert followed.exit_claims == 2 and "NEWS_LOCK" in followed.reasons


def test_account_without_an_s03_lease_keeps_the_old_reserve_path(tmp_path) -> None:
    with native_source() as source:
        control = SyntheticControllerBackend.for_source(source).control(
            ControlStore.open(tmp_path / "plain.sqlite"))
        binding = control.activate(source, SimulationPolicy(), component_id="a" * 64)
        account = control.account("SIM-001")
        reserved = control.reserve(
            binding,
            Opportunity("plain-opportunity", START, START + 5_000_000_000, "5"),
            expected_epoch=account.epoch,
            expected_sequence=account.latest_sequence,
            fence=account.fence,
        )
        assert reserved.intent_id
