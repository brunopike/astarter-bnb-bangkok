"""Fixed-review counterexamples: authenticated facts, clocks and explicit repair."""

import json
from contextlib import contextmanager

import pytest

from stark_trading_os.control.astarter.service import AstarterControl
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import AstarterBlocked
from stark_trading_os.domain.s03_bridge import (
    S03BridgeRejected,
    S03RawNews,
    S03RawQuote,
    s03_entry_locked,
)
from stark_trading_os.runner.s03_bridge_source import S03InputEvent, S03QuoteBody, s03_event_key
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.control.test_s03_f5_closure import _native_stop
from tests.unit.control.test_s03_lifecycle import _book, _market, _position, _push
from tests.unit.domain.test_s03_bridge import _stream_case

SECOND = 1_000_000_000


def _event(news):
    event = S03InputEvent(
        kind="NEWS",
        event_key="0" * 64,
        source_event_time_ns=news.source_event_time_ns,
        received_time_ns=news.received_time_ns,
        available_at_ns=news.available_at_ns,
        news=news,
    )
    return event.model_copy(update={"event_key": s03_event_key(event)})


def _quote_event(q):
    event = S03InputEvent(
        kind="QUOTE",
        event_key="0" * 64,
        source_event_time_ns=q.source_event_time_ns,
        received_time_ns=q.received_time_ns,
        available_at_ns=q.received_time_ns,
        quote=S03QuoteBody(
            source_sequence=q.source_sequence,
            bid=q.bid,
            ask=q.ask,
            bid_size=q.bid_size,
            ask_size=q.ask_size,
            instrument_id=q.instrument_id,
        ),
    )
    return event.model_copy(update={"event_key": s03_event_key(event)})


@contextmanager
def _controlled(tmp_path, *, initial_news=True, incident=False, source_delta_ns=0):
    original, manifest, case, signal, observation = _stream_case()
    now = signal.bar_close_ns + SECOND
    times = (
        now,
        now + SECOND,
        now + 2 * SECOND,
        signal.expires_at_ns,
        now + 5 * SECOND,
        now + 10 * SECOND,
        now + 120 * SECOND,
        now + 120 * SECOND + 1,
        now + 125 * SECOND + 1,
        now + 130 * SECOND + 1,
    )
    quotes = tuple(
        S03RawQuote(
            source_sequence=i + 1,
            source_event_time_ns=t - source_delta_ns if i == 0 else t,
            received_time_ns=t,
            bid="1253",
            ask="1254",
            bid_size="10",
            ask_size="10",
        )
        for i, t in enumerate(times)
    )
    news_times = (
        now,
        now + 5 * SECOND,
        now + 10 * SECOND,
        now + 125 * SECOND + 1,
        now + 130 * SECOND + 1,
    )
    news = tuple(
        S03RawNews(
            source_sequence=i + 1,
            previous_sequence=i,
            source_event_time_ns=t,
            received_time_ns=t,
            available_at_ns=t,
            status=("SEVERE" if i == 0 else "CLEARED" if i == 2 else "HEALTHY")
            if incident
            else "HEALTHY",
            incident_id="case" if incident and i in {0, 2} else None,
        )
        for i, t in enumerate(news_times)
    )
    manifest = manifest.model_copy(update={"quotes": quotes, "news": news})
    plan = case.issue(
        parameters=original.parameters,
        manifest=manifest,
        account_id="SIM-001",
        group_id=original.group_id,
        starts_at_ns=original.starts_at_ns,
        expires_at_ns=original.expires_at_ns,
    )
    with _book(now - 1) as (engine, strategy, source):
        if source_delta_ns:
            from nautilus_trader.model import Price, Quantity, QuoteTick

            engine.add_data(
                [
                    QuoteTick(
                        strategy.item.id,
                        Price.from_str("1253.00"),
                        Price.from_str("1254.00"),
                        Quantity.from_str("10.00000"),
                        Quantity.from_str("10.00000"),
                        now - source_delta_ns,
                        now,
                    )
                ]
            )
            engine.run(streaming=True)
            assert source.capture().now_ns == now
        else:
            _push(engine, strategy, now, "1253.00", "1254.00", None)
        store = ControlStore.open(tmp_path / "review.sqlite")
        control = s03_bridge(store, source)
        owner = control.activate(source, plan, manifest)
        if initial_news:
            control.ingest(owner, source, _event(news[0]))
        try:
            yield (
                control,
                owner,
                source,
                engine,
                strategy,
                plan,
                manifest,
                signal,
                observation,
                case,
            )
        finally:
            store.close()


def _reserve(pack):
    c, o, source, _, _, _, _, signal, observation, _ = pack
    account = c._astarter.account("SIM-001")
    return c.reserve_signal(
        o,
        source,
        signal,
        observation,
        expected_epoch=account.epoch,
        expected_sequence=account.latest_sequence,
    )


def test_no_news_is_not_healthy_and_does_not_reserve(tmp_path):
    with _controlled(tmp_path, initial_news=False) as pack:
        c, o, *_ = pack
        with pytest.raises(S03BridgeRejected, match="S03_NEWS_UNHEALTHY"):
            _reserve(pack)
        assert c._c.execute("SELECT COUNT(*) FROM astarter_intents").fetchone()[0] == 0
        assert "NEWS_UNHEALTHY" in c.life(o.run_id).reasons


def test_final_entry_consumes_latest_native_expiry(tmp_path):
    with _controlled(tmp_path) as pack:
        c, o, source, engine, strategy, _, _, signal, *_ = pack
        receipt = _reserve(pack)
        q = pack[6].quotes[2]
        _push(engine, strategy, q.received_time_ns, "1253.00", "1254.00", None)
        c.ingest(o, source, _quote_event(q))
        _push(engine, strategy, signal.expires_at_ns, "1253.00", "1254.00", None)
        assert c.claim_entry(o, source, receipt.entry_order_id) is None
        row = c._c.execute(
            "SELECT dispatch_state FROM astarter_orders WHERE order_id=?", (receipt.entry_order_id,)
        ).fetchone()
        assert row[0] == "CANCELED_LOCAL"


def test_generic_recovery_requires_bound_explicit_new_review(tmp_path):
    with _controlled(tmp_path) as pack:
        c, o, source, _, _, plan, manifest, _, _, case = pack
        c._astarter.begin_recovery("SIM-001", owner=o)
        c._astarter.observe(source, owner=o)
        with pytest.raises(S03BridgeRejected, match="RECOVERY_REACTIVATION_REQUIRED"):
            _reserve(pack)
        c.note_lock(o, "EMERGENCY")
        reasons = ("RECOVERY_REACTIVATION_REQUIRED",)
        new = case.issue(
            parameters=plan.parameters,
            manifest=manifest,
            account_id=plan.account_id,
            group_id=plan.group_id,
            starts_at_ns=source.capture().now_ns,
            expires_at_ns=plan.expires_at_ns,
            reactivation_binding=c.reactivation_binding(o, reasons),
        )
        with pytest.raises(S03BridgeRejected, match="REACTIVATION_UNBOUND"):
            c.reactivate(o, source, new, manifest, reasons=("EMERGENCY",))
        c.reactivate(o, source, new, manifest, reasons=reasons)
        assert "RECOVERY_REACTIVATION_REQUIRED" not in c.state(o.run_id).input_reasons
        assert "EMERGENCY" in c.life(o.run_id).reasons
        with pytest.raises(S03BridgeRejected, match="NEW_RISK_LOCKED"):
            _reserve(pack)
        with pytest.raises(S03BridgeRejected, match="REACTIVATION_UNBOUND"):
            c.reactivate(o, source, new, manifest, reasons=reasons)


def test_full_quote_rejection_gates_and_two_new_quotes_recover(tmp_path):
    with _controlled(tmp_path) as pack:
        c, o, source, engine, strategy, _, manifest, *_ = pack
        good = _quote_event(manifest.quotes[0])
        c.ingest(o, source, good)
        bad = good.model_copy(update={"quote": good.quote.model_copy(update={"bid_size": "-1"})})
        bad = bad.model_copy(update={"event_key": s03_event_key(bad)})
        with pytest.raises(S03BridgeRejected, match="QUOTE_NOT_IN_MANIFEST"):
            c.ingest(o, source, bad)
        assert s03_entry_locked(c.life(o.run_id))
        for i in (1, 2):
            q = manifest.quotes[i]
            _push(engine, strategy, q.received_time_ns, "1253.00", "1254.00", None)
            c.ingest(o, source, _quote_event(q))
            assert ("SOURCE_UNTRUSTED" in c.life(o.run_id).reasons) == (i == 1)
        assert _reserve(pack).quantity != "0"


def test_news_severe_lock_needs_clear_and_new_bound_review(tmp_path):
    with _controlled(tmp_path, incident=True) as pack:
        c, o, source, engine, strategy, plan, manifest, _, _, case = pack
        assert "NEWS_LOCK" in c.life(o.run_id).reasons
        for n in manifest.news[1:3]:
            _push(engine, strategy, n.received_time_ns, "1253.00", "1254.00", None)
            c.ingest(o, source, _event(n))
            assert "NEWS_LOCK" in c.life(o.run_id).reasons
            if n.status == "HEALTHY":
                reasons = ("NEWS_LOCK",)
                new = case.issue(
                    parameters=plan.parameters,
                    manifest=manifest,
                    account_id=plan.account_id,
                    group_id=plan.group_id,
                    starts_at_ns=n.received_time_ns,
                    expires_at_ns=plan.expires_at_ns,
                    reactivation_binding=c.reactivation_binding(o, reasons),
                )
                with pytest.raises(S03BridgeRejected, match="REPAIR_UNPROVEN"):
                    c.reactivate(o, source, new, manifest, reasons=reasons)
        reasons = ("NEWS_LOCK",)
        new = case.issue(
            parameters=plan.parameters,
            manifest=manifest,
            account_id=plan.account_id,
            group_id=plan.group_id,
            starts_at_ns=source.capture().now_ns,
            expires_at_ns=plan.expires_at_ns,
            reactivation_binding=c.reactivation_binding(o, reasons),
        )
        c.reactivate(o, source, new, manifest, reasons=reasons)
        assert "NEWS_LOCK" not in c.life(o.run_id).reasons


def test_news_expiry_and_two_spaced_continuous_observations(tmp_path):
    with _controlled(tmp_path) as pack:
        c, o, source, engine, strategy, _, manifest, *_ = pack
        for n in manifest.news[1:3]:
            _push(engine, strategy, n.received_time_ns, "1253.00", "1254.00", None)
            c.ingest(o, source, _event(n))
        last = manifest.news[2]
        assert c._news_clock(last, last.received_time_ns + 120 * SECOND)
        assert not c._news_clock(last, last.received_time_ns + 120 * SECOND + 1)
        c._record_source_failure(o, "S03_NEWS_CONTINUITY")
        for i, n in enumerate(manifest.news[3:]):
            _push(engine, strategy, n.received_time_ns, "1253.00", "1254.00", None)
            c.ingest(o, source, _event(n))
            assert ("NEWS_UNHEALTHY" in c.life(o.run_id).reasons) == (i == 0)


def test_old_owner_cannot_revoke_binding(tmp_path):
    with _controlled(tmp_path) as pack:
        c, o, source, *_ = pack
        binding = c._c.execute("SELECT binding_id FROM astarter_bindings").fetchone()[0]
        newer = c.takeover(source, o.run_id)
        from stark_trading_os.domain.astarter_simulation import AstarterBlocked

        with pytest.raises(AstarterBlocked, match="OWNER_STALE"):
            c._astarter.revoke(binding, owner=o)
        c._astarter.revoke(binding, owner=newer)


def test_native_exit_terminal_is_consumed_atomically_by_late_observe(tmp_path):
    from nautilus_trader.model import Price, Quantity, QuoteTick

    from tests.unit.control.test_s03_exit import _arm
    from tests.unit.control.test_s03_lifecycle import _market, _position

    with _position(tmp_path, "native-late.sqlite", _market(), "drop") as pack:
        _, engine, strategy, source, c, o, *_ = pack
        now = _arm(pack)
        life = c.claim_exit(o, source, now)
        order = c._c.execute(
            "SELECT quantity FROM astarter_orders WHERE order_id=?", (life.exit_order_id,)
        ).fetchone()
        strategy.ticket = (life.exit_order_id, "SELL", str(order[0]), None)
        engine.add_data(
            [
                QuoteTick(
                    strategy.item.id,
                    Price.from_str("1253.00"),
                    Price.from_str("1254.00"),
                    Quantity.from_str("0.00001"),
                    Quantity.from_str("0.00001"),
                    now + 1_000_000,
                    now + 1_000_000,
                )
            ]
        )
        engine.run(streaming=True)
        native = next(x for x in source.capture().orders if x.order_id == life.exit_order_id)
        assert native.state in {"FILLED", "CANCELED"}
        assert native.state_time_ns <= life.exit_deadline_ns
        strategy.clock.set_time(life.exit_deadline_ns + 1)
        c._astarter.observe(source, owner=o)
        fixed = c.life(o.run_id)
        assert "EXIT_PENDING" not in fixed.reasons
        assert "RECONCILIATION_REQUIRED" not in fixed.reasons
        c.note_timer(o, life.exit_deadline_ns + 1, source=source)
        assert "RECONCILIATION_REQUIRED" not in c.life(o.run_id).reasons
        assert (
            c._c.execute(
                "SELECT native_state FROM astarter_orders WHERE order_id=?", (life.exit_order_id,)
            ).fetchone()[0]
            == native.state
        )


def test_future_exit_clock_is_not_authority(tmp_path):
    from tests.unit.control.test_s03_exit import _arm
    from tests.unit.control.test_s03_lifecycle import _market, _position

    with _position(tmp_path, "future-clock.sqlite", _market(), "drop") as pack:
        c, o, source = pack[4], pack[5], pack[3]
        now = _arm(pack)
        before = c.life(o.run_id)
        with pytest.raises(S03BridgeRejected, match="CLOCK_REGRESSION"):
            c.claim_exit(o, source, now + 60 * SECOND)
        assert c.life(o.run_id) == before
        with pytest.raises(S03BridgeRejected, match="CLOCK_REGRESSION"):
            c.note_timer(o, now + 60 * SECOND, source=source)
        assert c.life(o.run_id) == before


def test_no_quote_timer_advances_hold_without_canceling_accepted_stop(tmp_path):
    from tests.unit.control.test_s03_f5_closure import _native_stop
    from tests.unit.control.test_s03_lifecycle import BAR, _market, _position

    with _position(tmp_path, "hold-timer.sqlite", _market(hold=24)) as pack:
        c, o, source, strategy = pack[4], pack[5], pack[3], pack[2]
        _, _, stop_command, _ = _native_stop(pack)
        stop_id = stop_command.order_id
        life = c.life(o.run_id)
        target = (life.first_fill_ns // BAR + 24) * BAR
        original_quote = source.capture().source_event_time_ns
        strategy.clock.set_time(target)
        life = c.note_timer(o, target, source=source)
        assert source.capture().source_event_time_ns == original_quote
        assert life.hold_seen == 24 and life.exit_target == "B"
        assert {"HOLD_LIMIT", "QUOTE_UNHEALTHY", "NEWS_UNHEALTHY"} <= set(life.reasons)
        stop = next(x for x in source.capture().orders if x.order_id == stop_id)
        assert stop.state == "ACCEPTED"
        assert "PROTECTION_FAILED" not in life.reasons


@pytest.mark.parametrize(
    "delta,accepted",
    [(2 * SECOND, True), (2 * SECOND + 1, False), (-500_000_000, True), (-500_000_001, False)],
)
def test_quote_source_clock_exact_boundaries(tmp_path, delta, accepted):
    with _controlled(tmp_path, source_delta_ns=delta) as pack:
        if accepted:
            assert _reserve(pack).quantity != "0"
        else:
            with pytest.raises(S03BridgeRejected, match="QUOTE_CLOCK|NEW_RISK_LOCKED"):
                _reserve(pack)
            assert pack[0]._c.execute("SELECT COUNT(*) FROM astarter_intents").fetchone()[0] == 0


def test_news_pause_keeps_accepted_stop_and_rejects_public_exit(tmp_path):
    with _position(tmp_path, "pause-public-exit.sqlite", _market()) as pack:
        a, intent, stop, _ = _native_stop(pack)
        c, o, source = pack[4], pack[5], pack[3]
        c.note_lock(o, "NEWS_LOCK")
        assert c.life(o.run_id).exit_target is None
        with pytest.raises(AstarterBlocked, match="S03_EXIT_TARGET_REQUIRED"):
            a.request_exit(intent, owner=o)
        assert not a.claim_cancel(
            stop.order_id, fence=a.account("SIM-001").fence, owner=o, source=source
        )
        assert (
            c._c.execute(
                "SELECT cancel_requested FROM astarter_orders WHERE order_id=?", (stop.order_id,)
            ).fetchone()[0]
            == 0
        )
        assert a._accepted_protection(intent, source.capture()) > 0


def test_news_pause_can_cancel_unsent_entry_without_creating_exit_target(tmp_path):
    with _controlled(tmp_path) as pack:
        c, o, source = pack[:3]
        r = _reserve(pack)
        a = c._astarter
        c.note_lock(o, "NEWS_LOCK")
        assert not a.claim_cancel(
            r.entry_order_id, fence=a.account("SIM-001").fence, owner=o, source=source
        )
        row = c._c.execute(
            "SELECT dispatch_state FROM astarter_orders WHERE order_id=?", (r.entry_order_id,)
        ).fetchone()
        assert row[0] == "CANCELED_LOCAL"
        assert c.life(o.run_id).exit_target is None
        intent = a._intent(r.intent_id)
        assert intent["state"] == "NO_FILL"
        assert intent["pending_risk"] == intent["cash_hold"] == "0"


@pytest.mark.parametrize("role", ["ENTRY", "STOP"])
def test_legacy_submit_repair_is_persistent_and_audit_bound(tmp_path, monkeypatch, role):
    original = AstarterControl._audit

    def legacy_writer(self, account_id, kind, fact):
        if kind == "NATIVE_DISPATCH_CLAIMED" and fact.get("role") == role:
            fact = {
                k: v
                for k, v in fact.items()
                if k not in {"started_at_ns", "deadline_ns", "operation"}
            }
        return original(self, account_id, kind, fact)

    monkeypatch.setattr(AstarterControl, "_audit", legacy_writer)
    with _position(tmp_path, "legacy-submit.sqlite", _market()) as pack:
        a, _, stop, _ = _native_stop(pack)
        c, o, source, strategy = pack[4], pack[5], pack[3], pack[2]
        oid = pack[9].entry_order_id if role == "ENTRY" else stop.order_id
        claims = [
            (json.loads(bytes(r[0])), r[1])
            for r in c._c.execute(
                "SELECT fact_bytes,fact_sha256 FROM astarter_audit "
                "WHERE kind='NATIVE_DISPATCH_CLAIMED'"
            )
        ]
        selected = [(fact, digest) for fact, digest in claims if fact["order_id"] == oid]
        assert len(selected) == 1 and "deadline_ns" not in selected[0][0]
        now = source.capture().now_ns + 1
        strategy.clock.set_time(now)
        assert "RECONCILIATION_REQUIRED" in c.note_timer(o, now, source=source).reasons
        a.observe(source, owner=o)
        assert "RECONCILIATION_REQUIRED" in c.life(o.run_id).reasons
        reasons = ("RECONCILIATION_REQUIRED",)
        plan, manifest = pack[6], pack[11]
        from stark_trading_os.domain.s03_bridge import local_simulation_case

        binding = c.reactivation_binding(o, reasons)
        new = local_simulation_case().issue(
            parameters=plan.parameters,
            manifest=manifest,
            account_id=plan.account_id,
            group_id=plan.group_id,
            starts_at_ns=now,
            expires_at_ns=plan.expires_at_ns,
            reactivation_binding=binding,
        )
        assert (
            "RECONCILIATION_REQUIRED"
            not in c.reactivate(o, source, new, manifest, reasons=reasons).reasons
        )
        strategy.clock.set_time(now + 1)
        assert "RECONCILIATION_REQUIRED" not in c.note_timer(o, now + 1, source=source).reasons
        repairs = [
            json.loads(bytes(r[0]))
            for r in c._c.execute(
                "SELECT fact_bytes FROM astarter_audit WHERE kind='S03_COMMAND_RECONCILED'"
            )
        ]
        assert any(
            r["claim_sha256"] == selected[0][1] and r["review_binding"] == binding for r in repairs
        )
        assert (
            len(
                [
                    r
                    for r in c._c.execute(
                        "SELECT fact_bytes FROM astarter_audit WHERE kind='NATIVE_DISPATCH_CLAIMED'"
                    )
                    if json.loads(bytes(r[0]))["order_id"] == oid
                ]
            )
            == 1
        )


def test_live_stop_does_not_prove_an_unacknowledged_cancel(tmp_path, monkeypatch):
    original = AstarterControl._audit

    def legacy_cancel(self, account_id, kind, fact):
        if kind == "NATIVE_CANCEL_INTENT":
            fact = {
                k: v
                for k, v in fact.items()
                if k not in {"started_at_ns", "deadline_ns", "operation"}
            }
        return original(self, account_id, kind, fact)

    monkeypatch.setattr(AstarterControl, "_audit", legacy_cancel)
    with _position(tmp_path, "legacy-cancel.sqlite", _market()) as pack:
        a, intent, stop, _ = _native_stop(pack)
        c, o, source, strategy = pack[4], pack[5], pack[3], pack[2]
        c.note_lock(o, "EMERGENCY")
        a.observe(source, owner=o)
        assert c.life(o.run_id).exit_target == "C"
        a.request_exit(intent, owner=o)
        assert a.claim_cancel(
            stop.order_id, fence=a.account("SIM-001").fence, owner=o, source=source
        )
        now = source.capture().now_ns + 1
        strategy.clock.set_time(now)
        assert "RECONCILIATION_REQUIRED" in c.note_timer(o, now, source=source).reasons
        reasons = ("RECONCILIATION_REQUIRED",)
        plan, manifest = pack[6], pack[11]
        from stark_trading_os.domain.s03_bridge import local_simulation_case

        new = local_simulation_case().issue(
            parameters=plan.parameters,
            manifest=manifest,
            account_id=plan.account_id,
            group_id=plan.group_id,
            starts_at_ns=now,
            expires_at_ns=plan.expires_at_ns,
            reactivation_binding=c.reactivation_binding(o, reasons),
        )
        before = c.life(o.run_id)
        with pytest.raises(S03BridgeRejected, match="S03_REPAIR_UNPROVEN"):
            c.reactivate(o, source, new, manifest, reasons=reasons)
        assert c.life(o.run_id) == before
        assert (
            c._c.execute(
                "SELECT COUNT(*) FROM astarter_audit WHERE kind='S03_COMMAND_RECONCILED'"
            ).fetchone()[0]
            == 0
        )
