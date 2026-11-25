"""S03 inventory, ABC, cooldown, and day baseline on a new test database."""

from contextlib import contextmanager
from dataclasses import replace
from decimal import ROUND_DOWN, Decimal
from typing import Any, cast

import pytest
from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.execution import MakerTakerFeeModel
from nautilus_trader.model import (
    AccountType,
    BookType,
    ClientOrderId,
    Money,
    OmsType,
    OrderSide,
    Price,
    Quantity,
    QuoteTick,
    TimeInForce,
)
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.s03_bridge import S03BridgeRejected, S03RawBar
from stark_trading_os.domain.s03_signal import (
    S03IndicatorSnapshot,
    S03Parameters,
    evaluate_s03_market,
)
from stark_trading_os.runner.astarter_facts import NativeFactsSource
from stark_trading_os.runner.s03_bridge_source import S03InputEvent, s03_event_key
from stark_trading_os.runner.s03_indicators import S03SignalObservation
from tests.compat.astarter_native_fixture import instrument
from tests.unit.control.s03_native_setup import s03_bridge
from tests.unit.domain.test_s03_bridge import (
    SEED,
    START,
    _stream_prices,
    make_manifest,
    make_plan,
    market_plan,
    replay_s03_observations,
)

BAR = 300_000_000_000
DAY = 86_400_000_000_000


class _Script(Strategy):
    def __new__(cls, **kwargs: object):
        return cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False))

    def __init__(self, *, engine: BacktestEngine, item: object) -> None:
        super().__init__(StrategyConfig(manage_stop=False))
        self.engine, self.item = engine, item
        self.source: NativeFactsSource | None = None
        self.ticket: tuple[str, str, str, str | None] | None = None
        self.done: set[str] = set()
        self.errors: list[str] = []
        self.cancel_next = False

    def on_order_rejected(self, event: object) -> None:
        self.errors.append(str(getattr(event, "reason", event)))

    def on_order_denied(self, event: object) -> None:
        self.errors.append(str(getattr(event, "reason", event)))

    def on_start(self) -> None:
        self.subscribe_quotes(self.item.id)

    def on_quote(self, quote: object) -> None:
        if self.source is None:
            self.source = NativeFactsSource(self.item, self)
        if self.ticket is None or self.ticket[0] in self.done:
            return
        order_id, side, quantity, price = self.ticket
        self.done.add(order_id)
        if price is None:
            self.submit_order(
                self.order_factory.market(
                    instrument_id=self.item.id,
                    order_side=OrderSide.SELL if side == "SELL" else OrderSide.BUY,
                    quantity=Quantity.from_str(quantity),
                    time_in_force=TimeInForce.IOC,
                    client_order_id=ClientOrderId(order_id),
                )
            )
            if self.cancel_next and side == "SELL":
                self.cancel_next = False
                self.cancel_order(ClientOrderId(order_id))
            return
        self.submit_order(
            self.order_factory.limit(
                instrument_id=self.item.id,
                order_side=OrderSide.BUY,
                quantity=Quantity.from_str(quantity),
                price=Price.from_str(price),
                time_in_force=TimeInForce.IOC,
                client_order_id=ClientOrderId(order_id),
            )
        )


@contextmanager
def _book(ts: int = START):
    item = instrument()
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True, run_analysis=False, logging=LoggerConfig(bypass_logging=True)
        )
    )
    strategy = _Script(engine=engine, item=item)
    try:
        engine.add_venue(
            venue=item.id.venue,
            oms_type=OmsType.NETTING,
            account_type=AccountType.CASH,
            base_currency=None,
            starting_balances=[
                Money.zero(item.base_currency),
                Money.from_decimal(Decimal("10000"), item.quote_currency),
            ],
            fee_model=MakerTakerFeeModel(),
            book_type=BookType.L1_MBP,
            routing=False,
            use_random_ids=False,
            use_reduce_only=False,
            bar_execution=False,
            trade_execution=False,
            allow_cash_borrowing=False,
        )
        engine.add_instrument(item)
        engine.add_strategy(strategy)
        _push(engine, strategy, ts, "59999.00", "60000.00", None)
        assert strategy.source is not None
        yield engine, strategy, strategy.source
    finally:
        if strategy.source is not None:
            strategy.source.close()
        strategy.engine = None
        engine.dispose()


def _push(
    engine: BacktestEngine,
    strategy: _Script,
    ts: int,
    bid: str,
    ask: str,
    ticket: tuple[str, str, str, str | None] | None,
) -> None:
    strategy.ticket = ticket
    engine.add_data(
        [
            QuoteTick(
                strategy.item.id,
                Price.from_str(bid),
                Price.from_str(ask),
                Quantity.from_str("10.00000"),
                Quantity.from_str("10.00000"),
                ts,
                ts,
            )
        ]
    )
    engine.run(streaming=True)


def _observation(
    plan,
    bar_close: int,
    rsi: float,
    *,
    fast: float = 3,
    slow: float = 2,
    gap: bool = False,
):
    snapshot = S03IndicatorSnapshot(
        ema_fast=fast, ema_slow=slow, close=100, atr=0.2, rsi=rsi, previous_rsi=None
    )
    return S03SignalObservation(
        parameters_sha256=plan.parameters.parameters_sha256,
        instrument_id="BTCUSDT.SIM",
        source_revision=plan.source_revision,
        seed_close_ns=plan.seed_close_ns,
        segment_seed_close_ns=plan.seed_close_ns,
        prefix_sha256="ab" * 32,
        bar_close_ns=bar_close,
        available_at_ns=bar_close,
        expires_at_ns=bar_close + 5_000_000_000,
        close="100",
        continuous_bars=300,
        ready=True,
        gap_reset=gap,
        expired=False,
        snapshot=snapshot,
        facts=evaluate_s03_market(snapshot, plan.parameters),
        signal=None,
    )


def _market(hold: int = 36, cooldown: int = 3) -> S03Parameters:
    return S03Parameters(
        ema_fast=10,
        ema_slow=30,
        rsi_cross="40",
        rsi_ceiling="75",
        rsi_fail="30",
        volatility_max="0.05",
        hold_boundaries=hold,
        cooldown_full_bars=cooldown,
    )


def _prices(tail: str) -> list[float]:
    prices = [float(price) for price in _stream_prices()]
    last = prices[-1]
    if tail == "drop":
        price = last
        for _ in range(20):
            price = max(1.0, price - 15.0)
            prices.append(price)
        for _ in range(30):
            price += 12.0
            prices.append(price)
        return prices
    for _ in range(50):
        prices.append(last)
    return prices


def _owned(tmp_path, name: str, parameters: S03Parameters, tail: str = "flat"):
    prices = _prices("flat" if tail == "gap" else tail)
    origin = len(_stream_prices())
    bars = tuple(
        S03RawBar(
            open=f"{price:.2f}",
            high=f"{price + 5:.2f}",
            low=f"{max(0.01, price - 5):.2f}",
            close=f"{price:.2f}",
            volume="1",
            bar_close_ns=SEED + (index + (1 if tail == "gap" and index >= origin else 0)) * BAR,
            ts_init_ns=SEED + (index + (1 if tail == "gap" and index >= origin else 0)) * BAR,
            available_at_ns=SEED
            + (index + (1 if tail == "gap" and index >= origin else 0)) * BAR
            + 1,
        )
        for index, price in enumerate(prices)
    )
    plan, manifest, _case, signal, observation = market_plan(parameters, bars)
    assert signal is not None
    when = signal.bar_close_ns + 1_000_000_000
    book = _book(when)
    engine, strategy, source = book.__enter__()
    control = s03_bridge(ControlStore.open(tmp_path / name), source)
    owner = control.activate(source, plan, manifest)
    _consume_news(control, owner, source, manifest)
    _push(engine, strategy, when + 500_000, "1253.00", "1254.00", None)
    account = control._astarter.account("SIM-001")
    reserved = control.reserve_signal(
        owner,
        source,
        signal,
        observation,
        expected_epoch=account.epoch,
        expected_sequence=account.latest_sequence,
    )
    command = control.claim_entry(owner, source, reserved.entry_order_id)
    assert command is not None and command.price is not None
    _push(
        engine,
        strategy,
        when + 1_000_000_000,
        "1253.00",
        "1254.00",
        (command.order_id, "BUY", command.quantity, f"{Decimal(command.price):.2f}"),
    )
    return (
        book,
        engine,
        strategy,
        source,
        control,
        owner,
        plan,
        signal,
        observation,
        reserved,
        when,
        manifest,
    )


@contextmanager
def _position(tmp_path, name: str, parameters: S03Parameters, tail: str = "flat"):
    pack = _owned(tmp_path, name, parameters, tail)
    try:
        yield pack
    finally:
        pack[0].__exit__(None, None, None)


def _flatten(engine, strategy, source, control, reserved, when: int, owner) -> int:
    control.note_lock(owner, "EMERGENCY")
    life = control.claim_exit(owner, source, source.capture().now_ns)
    order = control._c.execute(
        "SELECT quantity FROM astarter_orders WHERE order_id=?", (life.exit_order_id,)
    ).fetchone()
    assert order is not None and life.exit_claims == 1
    sold_at = when + 2_000_000_000
    _push(
        engine,
        strategy,
        sold_at,
        "1253.00",
        "1254.00",
        (life.exit_order_id, "SELL", str(order[0]), None),
    )
    control.resolve_exit(owner, source)
    assert source.capture().position_quantity == "0"
    return sold_at


def _at(plan, manifest, bar_close: int):
    return next(
        item for item in replay_s03_observations(plan, manifest) if item.bar_close_ns == bar_close
    )


def _consume_news(control, owner, source, manifest):
    """Explicitly consume the one approved initial health fact, never fabricate freshness."""
    news = manifest.news[0]
    assert news.available_at_ns <= source.capture().now_ns
    event = S03InputEvent(
        kind="NEWS",
        event_key="0" * 64,
        source_event_time_ns=news.source_event_time_ns,
        received_time_ns=news.received_time_ns,
        available_at_ns=news.available_at_ns,
        news=news,
    )
    event = event.model_copy(update={"event_key": s03_event_key(event)})
    control.ingest(owner, source, event)


def _timer(pack, now_ns):
    strategy, source, control, owner = pack[2], pack[3], pack[4], pack[5]
    previous = source.capture()
    if now_ns >= previous.now_ns:
        strategy.clock.set_time(now_ns)
    observed = source.capture()
    assert observed.quote_time_ns == previous.quote_time_ns
    assert observed.source_event_time_ns == previous.source_event_time_ns
    return control.note_timer(owner, now_ns, source=source)


def _quote(ts: int, bid: str = "1253", ask: str = "1254", *, manifest=None) -> S03InputEvent:
    approved = (
        next(
            q
            for q in manifest.quotes
            if q.source_event_time_ns == ts
            and Decimal(q.bid) == Decimal(bid)
            and Decimal(q.ask) == Decimal(ask)
        )
        if manifest is not None
        else None
    )
    event = S03InputEvent(
        kind="QUOTE",
        event_key="0" * 64,
        source_event_time_ns=ts,
        received_time_ns=ts,
        available_at_ns=ts,
        quote={
            "source_sequence": approved.source_sequence if approved is not None else 100,
            "bid": bid,
            "ask": ask,
            "bid_size": "10",
            "ask_size": "10",
            "instrument_id": "BTCUSDT.SIM",
        },
    )
    return event.model_copy(update={"event_key": s03_event_key(event)})


def _apply_at(
    engine, strategy, source, control, owner, plan, manifest, bar_close: int, bid: str, ask: str
):
    item = _at(plan, manifest, bar_close)
    _push(engine, strategy, item.available_at_ns, bid, ask, None)
    return control.apply_bar(owner, source, item)


def _boundaries(first_fill: int, bar_close: int) -> int:
    if bar_close <= first_fill:
        return 0
    first = (first_fill // BAR + 1) * BAR
    if bar_close < first:
        return 0
    return ((bar_close - first) // BAR) + 1


def test_one_sell_target_prefers_c_and_rsi_resets_after_two_failures(tmp_path) -> None:
    with _position(tmp_path, "life.sqlite", _market(), "drop") as pack:
        _book_cm, engine, strategy, source, control, owner, plan, *_rest = pack
        manifest = pack[11]
        first = pack[10] + 1_000_000_000
        rows = [
            item
            for item in replay_s03_observations(plan, manifest)
            if item.ready and not item.gap_reset and item.bar_close_ns > first
        ]
        low = [item for item in rows if item.snapshot.rsi < 30]
        once = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            low[0].bar_close_ns,
            "1253.00",
            "1254.00",
        )
        assert once.rsi_fail_streak == 1 and "RSI_FAIL" not in once.reasons
        twice = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            low[1].bar_close_ns,
            "1253.00",
            "1254.00",
        )
        assert twice.exit_target == "C"
        assert "RSI_FAIL" in twice.reasons and "TREND_EXIT" in twice.reasons
        recovered = next(
            item
            for item in rows
            if item.bar_close_ns > low[1].bar_close_ns and item.snapshot.rsi >= 30
        )
        cleared = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            recovered.bar_close_ns,
            "1253.00",
            "1254.00",
        )
        assert cleared.rsi_fail_streak == 0 and "RSI_FAIL" not in cleared.reasons


@pytest.mark.parametrize("hold", [36, 24])
def test_hold_boundary_comes_from_the_active_plan(tmp_path, hold: int) -> None:
    parameters = _market(hold=hold)
    assert parameters.hold_boundaries == hold
    with _position(tmp_path, "hold.sqlite", parameters) as pack:
        _book_cm, engine, strategy, source, control, owner, plan, *_rest = pack
        manifest = pack[11]
        first = pack[10] + 1_000_000_000
        opening = (first // BAR + 1) * BAR
        early = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            opening + (hold - 2) * BAR,
            "1253.00",
            "1254.00",
        )
        assert early.hold_seen == hold - 1 and "HOLD_LIMIT" not in early.reasons
        due = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            opening + (hold - 1) * BAR,
            "1253.00",
            "1254.00",
        )
        assert due.hold_seen == hold and due.exit_target == "B" and "HOLD_LIMIT" in due.reasons
        assert _boundaries(first, opening + (hold - 1) * BAR) == hold


def test_gap_equal_ema_pauses_without_a_forced_exit(tmp_path) -> None:
    with _position(tmp_path, "gap.sqlite", _market(), "gap") as pack:
        _book_cm, engine, strategy, source, control, owner, plan, *_rest = pack
        manifest = pack[11]
        first = pack[10] + 1_000_000_000
        gap = next(
            item
            for item in replay_s03_observations(plan, manifest)
            if item.gap_reset and item.bar_close_ns > first
        )
        paused = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            gap.bar_close_ns,
            "1253.00",
            "1254.00",
        )
        assert paused.rsi_fail_streak == 0
        assert "DATA_PAUSE" in paused.reasons
        assert "TREND_EXIT" not in paused.reasons and paused.exit_target is None
        assert paused.first_fill_ns == first


@pytest.mark.parametrize("bars", [3, 4])
def test_cooldown_counts_full_bars_and_blocks_the_old_signal(tmp_path, bars: int) -> None:
    parameters = _market(cooldown=bars)
    assert parameters.cooldown_full_bars == bars
    with _position(tmp_path, "cool.sqlite", parameters) as pack:
        (
            _book_cm,
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            signal,
            signal_observation,
            reserved,
            when,
            manifest,
        ) = pack
        control.ingest(owner, source, _quote(when + 1_000_000_000, manifest=manifest))
        sold_at = _flatten(engine, strategy, source, control, reserved, when, owner)
        control.ingest(owner, source, _quote(sold_at, manifest=manifest))
        flat_ns = control.life(owner.run_id).flat_ns
        assert flat_ns is not None
        chosen = [
            item
            for item in replay_s03_observations(plan, manifest)
            if item.ready and item.bar_close_ns - BAR >= flat_ns
        ]
        current = control.life(owner.run_id)
        counted = 0
        for item in chosen:
            current = _apply_at(
                engine,
                strategy,
                source,
                control,
                owner,
                plan,
                manifest,
                item.bar_close_ns,
                "1253.00",
                "1254.00",
            )
            counted = current.cooldown_bars
            if counted == 1:
                with pytest.raises(S03BridgeRejected, match="S03_NEW_RISK_LOCKED"):
                    control.reserve_signal(
                        owner,
                        source,
                        signal,
                        signal_observation,
                        expected_epoch=1,
                        expected_sequence=1,
                    )
            if counted == bars:
                break
        assert current.cooldown_bars == bars and "COOLDOWN" not in current.reasons
        assert current.cooldown_open_after_ns is not None
        with pytest.raises(S03BridgeRejected, match="S03_SIGNAL_BLOCKED"):
            control.reserve_signal(
                owner,
                source,
                signal,
                signal_observation,
                expected_epoch=1,
                expected_sequence=1,
            )
        moved = replace(signal, signal_id="cd" * 32, bar_close_ns=current.cooldown_open_after_ns)
        with pytest.raises(S03BridgeRejected, match="S03_COOLDOWN_SIGNAL"):
            control.reserve_signal(
                owner,
                source,
                moved,
                signal_observation,
                expected_epoch=1,
                expected_sequence=1,
            )


def test_day_loss_boundary_missing_baseline_and_independent_release(tmp_path) -> None:
    with _position(tmp_path, "day.sqlite", _market()) as pack:
        _book_cm, engine, strategy, source, control, owner, plan, *_rest = pack
        manifest, first = pack[11], pack[10] + 1_000_000_000
        opening = (first // BAR + 1) * BAR
        base = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            opening,
            "1253.00",
            "1254.00",
        )
        snap = source.capture()
        baseline = Decimal(base.day_baseline or "0")
        cash, qty = Decimal(snap.quote_total), Decimal(snap.position_quantity)
        locked_bid = ((baseline * Decimal("0.98") - cash) / qty).quantize(
            Decimal("0.01"), rounding=ROUND_DOWN
        )
        under_bid = locked_bid + Decimal("0.01")
        under = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            opening + BAR,
            f"{under_bid:.2f}",
            f"{(under_bid + 1):.2f}",
        )
        assert "DAY_LOSS" not in under.reasons
        locked = _apply_at(
            engine,
            strategy,
            source,
            control,
            owner,
            plan,
            manifest,
            opening + 2 * BAR,
            f"{locked_bid:.2f}",
            f"{(locked_bid + 1):.2f}",
        )
        assert locked.exit_target == "C" and "DAY_LOSS" in locked.reasons
        marked = control.note_lock(owner, "NEWS_LOCK")
        with pytest.raises(S03BridgeRejected, match="S03_RELEASE_UNEVIDENCED"):
            control.release_reason(owner, "DAY_LOSS")
        kept = control.life(owner.run_id)
        assert "DAY_LOSS" in kept.reasons and "NEWS_LOCK" in kept.reasons
        assert marked.protection_deadline_ns == kept.protection_deadline_ns
        nxt = (strategy.clock.timestamp_ns() // DAY + 1) * DAY + 1_000_000_000
        rolled = _timer(pack, nxt)
        assert rolled.day_baseline == base.day_baseline
        assert "DAY_BASELINE_MISSING" in rolled.reasons


def test_apply_bar_rolls_back_the_native_observation_with_the_lifecycle(tmp_path) -> None:
    bar = S03RawBar(
        open="100.00",
        high="105.00",
        low="95.00",
        close="100.00",
        volume="1",
        bar_close_ns=SEED,
        ts_init_ns=SEED,
        available_at_ns=SEED,
    )
    plan, manifest, _case = make_plan(manifest=make_manifest(quotes=(), bars=(bar,)))
    observed = replay_s03_observations(plan, manifest)[0]
    with _book() as (_engine, _strategy, source):
        control = s03_bridge(ControlStore.open(tmp_path / "roll.sqlite"), source)
        owner = control.activate(source, plan, manifest)
        before = control._c.execute(
            "SELECT last_sequence FROM astarter_accounts WHERE account_id='SIM-001'"
        ).fetchone()[0]

        def fail(_run_id: str) -> None:
            raise RuntimeError("injected")

        control._after_bar = fail  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="injected"):
            control.apply_bar(owner, source, observed)
        assert (
            control._c.execute(
                "SELECT last_sequence FROM astarter_accounts WHERE account_id='SIM-001'"
            ).fetchone()[0]
            == before
        )
        assert control.life(owner.run_id).day_baseline is None
