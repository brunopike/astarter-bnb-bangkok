"""A native flat/cooldown/new-cross cycle starts a distinct second lifecycle."""

from decimal import Decimal

import pytest
from nautilus_trader.model import ClientOrderId

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import AstarterBlocked
from stark_trading_os.domain.s03_bridge import (
    S03BridgeRejected,
    S03RawBar,
    S03RawNews,
    replay_s03_observations,
)
from stark_trading_os.runner.s03_bridge_source import S03InputEvent, s03_event_key
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_f5_closure import _native_stop
from tests.unit.control.test_s03_lifecycle import BAR, _book, _consume_news, _market, _push, _quote
from tests.unit.domain.test_s03_bridge import DAY, SEED, _stream_prices, make_quote, market_plan


def _case(*, risk_fraction="0.003"):
    prices = _stream_prices()
    level = prices[-1]
    for count, change in ((40, 1), (22, -0.4), (8, 2)):
        for _ in range(count):
            level += change
            prices.append(round(level, 2))
    bars = tuple(
        S03RawBar(
            open=f"{p:.2f}",
            high=f"{p + 5:.2f}",
            low=f"{p - 5:.2f}",
            close=f"{p:.2f}",
            volume="1",
            bar_close_ns=SEED + i * BAR,
            ts_init_ns=SEED + i * BAR,
            available_at_ns=SEED + i * BAR + 1,
        )
        for i, p in enumerate(prices)
    )
    parameters = _market(hold=24).model_copy(update={"risk_fraction": risk_fraction})
    plan, manifest, case, _, _ = market_plan(parameters, bars)
    signals = [x for x in replay_s03_observations(plan, manifest) if x.signal]
    assert len(signals) == 2
    first, second = [x.bar_close_ns + 1_000_000_000 for x in signals]
    hold = ((first + 1_000_000_000) // BAR + 1) * BAR + 23 * BAR + 1
    points = [(hold + n * 1_000_000, "1253", "1254") for n in (1, 2, 3)]
    points += [
        (second + n, "1300", "1301")
        for n in (-6_000_000_000, -1_500_000_000, -1_000_000_000, 500_000, 1_000_000_000)
    ]
    quotes = list(manifest.quotes) + [
        make_quote(source_event_time_ns=at, received_time_ns=at, bid=bid, ask=ask)
        for at, bid, ask in points
    ]
    quotes = tuple(
        q.model_copy(update={"source_sequence": 100 + i})
        for i, q in enumerate(sorted(quotes, key=lambda q: q.source_event_time_ns))
    )
    news = manifest.news + tuple(
        S03RawNews(
            source_sequence=i,
            previous_sequence=i - 1,
            source_event_time_ns=at,
            received_time_ns=at,
            available_at_ns=at,
            status="HEALTHY",
        )
        for i, at in enumerate((second - 6_000_000_000, second - 1_000_000_000), 2)
    )
    manifest = manifest.model_copy(update={"quotes": quotes, "news": news})
    plan = case.issue(
        parameters=plan.parameters,
        manifest=manifest,
        account_id=plan.account_id,
        group_id=plan.group_id,
        starts_at_ns=first - 1_000_000_000,
        expires_at_ns=first - 1_000_000_000 + DAY,
    )
    signals = [x for x in replay_s03_observations(plan, manifest) if x.signal]
    return plan, manifest, signals, first, second, hold


def _news(control, owner, source, news):
    event = S03InputEvent(
        kind="NEWS",
        event_key="0" * 64,
        source_event_time_ns=news.source_event_time_ns,
        received_time_ns=news.received_time_ns,
        available_at_ns=news.available_at_ns,
        news=news,
    )
    control.ingest(owner, source, event.model_copy(update={"event_key": s03_event_key(event)}))


@pytest.mark.parametrize("dispatched", [False, True], ids=["reserved", "dispatching"])
def test_unresolved_prior_intent_cannot_be_replaced_by_later_cross(tmp_path, dispatched):
    plan, manifest, signals, first, second, _hold = _case(risk_fraction="0.0005")
    with _book(first) as (engine, strategy, source):
        store = ControlStore.open(tmp_path / "unresolved-prior-intent.sqlite")
        control = s03_bridge(store, source)
        astarter = control._astarter
        try:
            owner = control.activate(source, plan, manifest)
            _consume_news(control, owner, source, manifest)
            _push(engine, strategy, first + 500_000, "1253.00", "1254.00", None)
            account = astarter.account("SIM-001")
            receipt = control.reserve_signal(
                owner,
                source,
                signals[0].signal,
                signals[0],
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
            if dispatched:
                assert control.claim_entry(owner, source, receipt.entry_order_id) is not None
            for at in (second - 6_000_000_000, second - 1_500_000_000, second - 1_000_000_000):
                _push(engine, strategy, at, "1300.00", "1301.00", None)
                control.ingest(owner, source, _quote(at, "1300", "1301", manifest=manifest))
                for news in manifest.news[1:]:
                    if news.available_at_ns == at:
                        _news(control, owner, source, news)
            _push(engine, strategy, second + 500_000, "1300.00", "1301.00", None)
            account = astarter.account("SIM-001")
            rows = [
                tuple(r)
                for r in control._c.execute(
                    "SELECT intent_id,state,pending_risk,cash_hold,receipt_bytes "
                    "FROM astarter_intents"
                )
            ]
            assert len(rows) == 1 and Decimal(rows[0][2]) == Decimal("5")
            old_life = control.life(owner.run_id)
            assert old_life.active_intent_id == receipt.intent_id
            old_order = astarter.orders(receipt.intent_id)[0]
            assert old_order.dispatch_state == ("DISPATCHING" if dispatched else "PENDING")
            with pytest.raises(
                (AstarterBlocked, S03BridgeRejected), match="ASTARTER_S03_PRIOR_INTENT_UNRESOLVED"
            ):
                control.reserve_signal(
                    owner,
                    source,
                    signals[1].signal,
                    signals[1],
                    expected_epoch=account.epoch,
                    expected_sequence=account.latest_sequence,
                )
            assert [
                tuple(r)
                for r in control._c.execute(
                    "SELECT intent_id,state,pending_risk,cash_hold,receipt_bytes "
                    "FROM astarter_intents"
                )
            ] == rows
            assert control.life(owner.run_id).active_intent_id == receipt.intent_id
            assert astarter.orders(receipt.intent_id)[0] == old_order
            assert source.capture().fills == ()
        finally:
            store._connection.close()


def test_second_native_position_resets_only_its_own_lifecycle(tmp_path):
    plan, manifest, signals, first, second, hold = _case()
    with _book(first) as (engine, strategy, source):
        store = ControlStore.open(tmp_path / "two-native-positions.sqlite")
        control = s03_bridge(store, source)
        astarter = control._astarter
        try:
            owner = control.activate(source, plan, manifest)
            _consume_news(control, owner, source, manifest)
            _push(engine, strategy, first + 500_000, "1253.00", "1254.00", None)
            account = astarter.account("SIM-001")
            receipt = control.reserve_signal(
                owner,
                source,
                signals[0].signal,
                signals[0],
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
            command = control.claim_entry(owner, source, receipt.entry_order_id)
            _push(
                engine,
                strategy,
                first + 1_000_000_000,
                "1253.00",
                "1254.00",
                (command.order_id, "BUY", command.quantity, f"{Decimal(command.price):.2f}"),
            )
            pack = (
                None,
                engine,
                strategy,
                source,
                control,
                owner,
                plan,
                signals[0].signal,
                signals[0],
                receipt,
                first,
                manifest,
            )
            original_on_quote = strategy.on_quote
            _, _, stop, _ = _native_stop(pack)
            strategy.on_quote = original_on_quote
            original_life = control.life(owner.run_id)
            assert original_life.first_fill_ns == first + 1_000_000_000
            observation = next(
                x for x in replay_s03_observations(plan, manifest) if x.available_at_ns == hold
            )
            _push(engine, strategy, hold, "1253.00", "1254.00", None)
            due = control.apply_bar(owner, source, observation)
            assert due.exit_target == "B" and "HOLD_LIMIT" in due.reasons
            astarter.request_exit(receipt.intent_id, owner=owner)
            assert astarter.claim_cancel(
                stop.order_id, fence=account.fence, owner=owner, source=source
            )
            strategy.on_quote = lambda _: strategy.cancel_order(ClientOrderId(stop.order_id))
            _push(engine, strategy, hold + 1_000_000, "1253.00", "1254.00", None)
            strategy.on_quote = original_on_quote
            control.resolve_exit(owner, source)
            exiting = control.claim_exit(owner, source, source.capture().now_ns)
            sell = next(
                o for o in astarter.orders(receipt.intent_id) if o.order_id == exiting.exit_order_id
            )
            _push(
                engine,
                strategy,
                hold + 3_000_000,
                "1253.00",
                "1254.00",
                (sell.order_id, "SELL", sell.quantity, None),
            )
            flat = control.resolve_exit(owner, source)
            snapshot = source.capture()
            assert snapshot.position_quantity == snapshot.base_total == "0"
            assert snapshot.cash_reconciled and all(
                o.state in {"FILLED", "CANCELED"} for o in snapshot.orders
            )
            assert flat.flat_ns == snapshot.now_ns and flat.exit_claims == 1
            settlement = astarter.settle(
                "SIM-001", request_id="first-native-position", owner=owner, source=source
            )
            assert settlement is not None
            debits = [
                tuple(r)
                for r in control._c.execute(
                    "SELECT scope,booked_debit FROM astarter_limits ORDER BY scope"
                )
            ]
            assert any(Decimal(r[1]) > 0 for r in debits)
            old_orders = [
                tuple(r)
                for r in control._c.execute(
                    "SELECT order_id,intent_id,role,quantity,trigger_price,deadline_ns "
                    "FROM astarter_orders ORDER BY order_id"
                )
            ]
            old_fills = [tuple(r) for r in control._c.execute("SELECT * FROM astarter_fills")]
            old_audit = [tuple(r) for r in control._c.execute("SELECT * FROM s03_audit")]
            for item in replay_s03_observations(plan, manifest):
                if item.bar_close_ns - BAR < flat.flat_ns:
                    continue
                _push(engine, strategy, item.available_at_ns, "1253.00", "1254.00", None)
                cooled = control.apply_bar(owner, source, item)
                if cooled.cooldown_bars == plan.parameters.cooldown_full_bars:
                    break
            assert cooled.cooldown_bars == 3 and "COOLDOWN" not in cooled.reasons
            assert cooled.first_fill_ns == original_life.first_fill_ns
            for at in (second - 6_000_000_000, second - 1_500_000_000, second - 1_000_000_000):
                _push(engine, strategy, at, "1300.00", "1301.00", None)
                control.ingest(owner, source, _quote(at, "1300", "1301", manifest=manifest))
                for news in manifest.news[1:]:
                    if news.available_at_ns == at:
                        _news(control, owner, source, news)
            assert not {"NEWS_UNHEALTHY", "QUOTE_UNHEALTHY"} & set(
                control.life(owner.run_id).reasons
            )
            _push(engine, strategy, second + 500_000, "1300.00", "1301.00", None)
            account = astarter.account("SIM-001")
            receipt2 = control.reserve_signal(
                owner,
                source,
                signals[1].signal,
                signals[1],
                expected_epoch=account.epoch,
                expected_sequence=account.latest_sequence,
            )
            assert receipt2.intent_id != receipt.intent_id
            reset = control.life(owner.run_id)
            assert reset.active_intent_id == receipt2.intent_id
            assert reset.first_fill_ns is None and reset.protection_deadline_ns is None
            assert reset.exit_claims == 0 and not reset.residual_used
            assert reset.exit_order_id is None and reset.residual_order_id is None
            assert reset.flat_ns is None
            command2 = control.claim_entry(owner, source, receipt2.entry_order_id)
            _push(
                engine,
                strategy,
                second + 1_000_000_000,
                "1300.00",
                "1301.00",
                (command2.order_id, "BUY", command2.quantity, f"{Decimal(command2.price):.2f}"),
            )
            astarter.observe(source, owner=owner)
            life2 = control.life(owner.run_id)
            assert life2.first_fill_ns == second + 1_000_000_000
            assert life2.protection_deadline_ns == life2.first_fill_ns + 1_000_000_000
            assert life2.first_fill_ns != original_life.first_fill_ns
            assert life2.exit_claims == 0 and not life2.residual_used
            assert [
                tuple(r)
                for r in control._c.execute(
                    "SELECT scope,booked_debit FROM astarter_limits ORDER BY scope"
                )
            ] == debits
            assert [
                tuple(r)
                for r in control._c.execute(
                    "SELECT order_id,intent_id,role,quantity,trigger_price,deadline_ns "
                    "FROM astarter_orders WHERE intent_id=? ORDER BY order_id",
                    (receipt.intent_id,),
                )
            ] == old_orders
            assert [tuple(r) for r in control._c.execute("SELECT * FROM astarter_fills")][
                : len(old_fills)
            ] == old_fills
            assert [tuple(r) for r in control._c.execute("SELECT * FROM s03_audit")][
                : len(old_audit)
            ] == old_audit
            assert control._c.execute("SELECT count(*) FROM astarter_intents").fetchone()[0] == 2
        finally:
            store._connection.close()
