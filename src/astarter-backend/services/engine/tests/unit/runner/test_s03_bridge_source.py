"""Pre-match S03 quote gate. Rejected quotes stay recorded and out of the native cache."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from typing import Any, cast

import pytest
from nautilus_trader.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.common import LoggerConfig
from nautilus_trader.execution import MakerTakerFeeModel
from nautilus_trader.model import AccountType, BookType, Money, OmsType, Price, Quantity, QuoteTick
from nautilus_trader.trading import Strategy, StrategyConfig

from stark_trading_os.domain.s03_bridge import S03BridgeRejected, s03_bound_source_event_time
from stark_trading_os.runner.astarter_facts import NativeFactsSource
from stark_trading_os.runner.s03_bridge_source import (
    S03InputEvent,
    S03SimulationInputSource,
    s03_event_key,
)
from tests.compat.astarter_native_fixture import instrument
from tests.unit.domain.test_s03_bridge import make_plan, make_quote

CASE = "S03_SYNTHETIC_BTC_V1"
NATIVE_TS = 1_700_000_000_000_000_000


class _Idle(Strategy):
    def __new__(cls, **kwargs: object) -> _Idle:
        return cast(Any, Strategy).__new__(cls, StrategyConfig(manage_stop=False))

    def __init__(self, *, item: object) -> None:
        super().__init__(StrategyConfig(manage_stop=False))
        self.item = item
        self.engine: object | None = None
        self.source: NativeFactsSource | None = None
        self.source_error: Exception | None = None

    def on_start(self) -> None:
        self.subscribe_quotes(self.item.id)

    def on_quote(self, quote: object) -> None:
        if self.source is None:
            try:
                self.source = NativeFactsSource(self.item, self)
            except Exception as error:
                self.source_error = error


@contextmanager
def _session(ts_event: int, ts_init: int) -> Iterator[tuple[object, _Idle, NativeFactsSource]]:
    item = instrument()
    engine = BacktestEngine(
        config=BacktestEngineConfig(
            bypass_logging=True, run_analysis=False, logging=LoggerConfig(bypass_logging=True)
        )
    )
    strategy = _Idle(item=item)
    strategy.engine = engine
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
        engine.add_data(
            [
                QuoteTick(
                    item.id,
                    Price.from_str("59999.00"),
                    Price.from_str("60000.00"),
                    Quantity.from_str("10.00000"),
                    Quantity.from_str("10.00000"),
                    ts_event,
                    ts_init,
                )
            ]
        )
        engine.run()
        if strategy.source_error is not None:
            raise strategy.source_error
        assert strategy.source is not None
        yield engine, strategy, strategy.source
    finally:
        if strategy.source is not None:
            strategy.source.close()
        engine.dispose()


def _event(quote: object, available_at_ns: int) -> S03InputEvent:
    event = S03InputEvent(
        kind="QUOTE",
        event_key="0" * 64,
        source_event_time_ns=quote.source_event_time_ns,
        received_time_ns=quote.received_time_ns,
        available_at_ns=available_at_ns,
        quote={
            "source_sequence": quote.source_sequence,
            "bid": quote.bid,
            "ask": quote.ask,
            "bid_size": quote.bid_size,
            "ask_size": quote.ask_size,
            "instrument_id": "BTCUSDT.SIM",
        },
    )
    return event.model_copy(update={"event_key": s03_event_key(event)})


def _open(
    native: NativeFactsSource, quotes: tuple[object, ...], *, case_id: str = CASE
) -> S03SimulationInputSource:
    plan, manifest, case = make_plan(quotes)  # type: ignore[arg-type]
    return S03SimulationInputSource.open(
        case_id=case_id, case=case, plan=plan, manifest=manifest, native=native
    )


def test_duplicate_and_late_quotes_stay_out_of_the_accepted_feed() -> None:
    base = 20_000_000_000
    first = make_quote(source_sequence=10, source_event_time_ns=base, received_time_ns=base)
    late = make_quote(
        source_sequence=11,
        source_event_time_ns=base - 1_000_000_000,
        received_time_ns=base,
        bid="59000",
        ask="59001",
    )
    with _session(NATIVE_TS, NATIVE_TS) as (engine, strategy, native):
        before = strategy.cache.quote(strategy.item.id).ts_event
        source = _open(native, (first, late))
        accepted = source.admit(_event(first, base))
        duplicate = source.admit(_event(first, base))
        rejected = source.admit(_event(late, base))
        assert accepted.disposition == "ACCEPTED"
        assert [item.event_key for item in source.accepted_quotes] == [accepted.event_key]
        assert [item.reason for item in source.rejected] == ["DUPLICATE_QUOTE", "QUOTE_LATE"]
        assert duplicate.event_key == accepted.event_key
        assert rejected.event_key not in {item.event_key for item in source.accepted_quotes}
        assert source.raw_manifest.quotes[1].bid == "59000"
        assert strategy.cache.quote(strategy.item.id).ts_event == before
        assert engine is not None


def test_source_and_received_clocks_fail_independently() -> None:
    now = 10_000_000_000
    age = 2_000_000_000
    future = 500_000_000
    cases = (
        (now - age, now, None),
        (now - age - 1, now, "QUOTE_SOURCE_AGE"),
        (now, now - age - 1, "QUOTE_RECEIVED_AGE"),
        (now + future, now, None),
        (now + future + 1, now, "QUOTE_SOURCE_FUTURE"),
        (now, now + future + 1, "QUOTE_RECEIVED_FUTURE"),
    )
    with _session(NATIVE_TS, NATIVE_TS) as (_e, _s, native):
        for index, (source_time, received_time, reason) in enumerate(cases, start=100):
            quote = make_quote(
                source_sequence=index,
                source_event_time_ns=source_time,
                received_time_ns=received_time,
                bid=str(60000 + index),
                ask=str(60001 + index),
            )
            gate = _open(native, (quote,))
            record = gate.admit(_event(quote, now))
            if reason is None:
                assert record.disposition == "ACCEPTED"
                assert gate.accepted_quotes == (record,)
            else:
                assert record.disposition == "REJECTED"
                assert record.reason == reason
                assert gate.accepted_quotes == ()
                assert gate.rejected == (record,)


def test_capture_sequence_cannot_impersonate_quote_source_sequence() -> None:
    quote = make_quote(source_sequence=100)
    with _session(NATIVE_TS, NATIVE_TS) as (_e, _s, native):
        first = native.capture()
        assert first.sequence == 1
        source = _open(native, (quote,))
        forged = _event(
            make_quote(source_sequence=first.sequence, bid="61000", ask="61001"),
            quote.received_time_ns,
        )
        forged_record = source.admit(forged)
        assert forged_record.reason == "QUOTE_NOT_IN_MANIFEST"
        assert source.quote_source_watermark is None
        accepted = source.admit(_event(quote, quote.received_time_ns))
        assert accepted.disposition == "ACCEPTED"
        assert source.quote_source_watermark == 100
        assert source.quote_source_watermark != first.sequence
        native_event = S03InputEvent(
            kind="NATIVE",
            event_key="0" * 64,
            source_event_time_ns=quote.source_event_time_ns,
            received_time_ns=quote.received_time_ns,
            available_at_ns=quote.received_time_ns,
            native={"capture_sequence": first.sequence, "venue_session": native.venue_session},
        )
        native_event = native_event.model_copy(update={"event_key": s03_event_key(native_event)})
        native_record = source.admit(native_event)
        assert native_record.disposition == "REJECTED"
        assert native_record.reason == "CAPTURE_SEQUENCE_NOT_QUOTE_SOURCE_SEQUENCE"
        assert source.quote_source_watermark == 100
        second = native.capture()
        assert second.sequence == 2
        assert source.quote_source_watermark == 100
        assert all(item.source_sequence != second.sequence for item in source.accepted_quotes)


def test_bad_event_key_is_retained_and_not_accepted() -> None:
    quote = make_quote()
    with _session(NATIVE_TS, NATIVE_TS) as (_e, _s, native):
        source = _open(native, (quote,))
        event = _event(quote, quote.received_time_ns).model_copy(update={"event_key": "11" * 32})
        record = source.admit(event)
        assert record.disposition == "REJECTED"
        assert record.reason == "EVENT_KEY_MISMATCH"
        assert record.event_key == "11" * 32
        assert source.accepted_quotes == ()
        assert source.rejected == (record,)


def test_off_grid_manifest_quote_is_rejected_and_kept() -> None:
    quote = make_quote(bid="60000.001", ask="60000.02")
    with _session(NATIVE_TS, NATIVE_TS) as (_e, _s, native):
        source = _open(native, (quote,))
        record = source.admit(_event(quote, quote.received_time_ns))
        assert record.reason == "QUOTE_PRICE_INVALID"
        assert source.accepted_quotes == ()
        assert source.raw_manifest.quotes[0].bid == "60000.001"


def test_snapshot_seals_source_event_time_without_changing_policy_bytes() -> None:
    event_time = NATIVE_TS
    with _session(event_time, event_time + 1_000) as (_e, _s, native):
        snapshot = native.capture()
        native.verify(snapshot)
        assert snapshot.source_event_time_ns == event_time
        assert snapshot.quote_time_ns == event_time + 1_000
        assert s03_bound_source_event_time(snapshot) == event_time
        assert snapshot.sequence == 1


def test_owner_is_not_reusable_execution_authority() -> None:
    with _session(NATIVE_TS, NATIVE_TS) as (_e, _s, native):
        source = _open(native, (make_quote(),))
        owner = source.owner
        state = source.state()
        assert owner.execution_authorized is False
        assert owner.fence == 1
        assert owner.venue_session == native.venue_session
        assert owner.credential not in repr(owner)
        assert "credential" not in repr(owner)
        assert state.execution_authorized is False
        assert state.real_trading_connected is False
        assert state.profile_version == "S03_SIM_BTC_QUOTE_V1"
        assert len(state.instrument_sha256) == 64
        assert owner.credential not in repr(state)
        assert not hasattr(state, "credential")


def test_r3_closed_native_source_cannot_accept_quotes() -> None:
    quote = make_quote()
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, native):
        source = _open(native, (quote,))
        native.close()
        record = source.admit(_event(quote, quote.received_time_ns))
        assert record.disposition == "REJECTED"
        assert record.reason == "S03_NATIVE_SOURCE_CLOSED"
        assert source.accepted_quotes == ()
        assert source.rejected == (record,)
        assert source.quote_source_watermark is None


def test_r3_new_session_does_not_resume_a_closed_source() -> None:
    quote = make_quote()
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, first):
        source = _open(first, (quote,))
        closed_session = source.owner.venue_session
        first.close()
        closed = source.admit(_event(quote, quote.received_time_ns))
        assert closed.reason == "S03_NATIVE_SOURCE_CLOSED"
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, second):
        restarted = _open(second, (quote,))
        assert restarted.owner.venue_session == second.venue_session
        assert restarted.owner.venue_session != closed_session
        assert restarted.quote_source_watermark is None


def test_r3_instrument_drift_rejects_the_quote() -> None:
    from nautilus_trader.model import CurrencyPair

    quote = make_quote()
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, native):
        source = _open(native, (quote,))
        fields = native._cache.instrument(native._instrument.id).to_dict()
        fields["taker_fee"] = "0.002"
        native._strategy.engine.add_instrument(CurrencyPair.from_dict(fields))
        record = source.admit(_event(quote, quote.received_time_ns))
        assert record.disposition == "REJECTED"
        assert record.reason == "S03_NATIVE_SOURCE_DRIFT"
        assert source.accepted_quotes == ()
        assert source.quote_source_watermark is None


@pytest.mark.parametrize("bid", ["not-a-number", "-1", "0"])
def test_r4_malformed_price_is_recorded_and_does_not_raise(bid: str) -> None:
    quote = make_quote(bid=bid, ask="60000")
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, native):
        source = _open(native, (quote,))
        record = source.admit(_event(quote, quote.received_time_ns))
        assert record.disposition == "REJECTED"
        assert record.reason == "QUOTE_PRICE_INVALID"
        assert source.rejected == (record,)
        assert source.accepted_quotes == ()
        assert source.quote_source_watermark is None


def test_g3_new_case_cannot_override_a_blocked_host() -> None:
    from stark_trading_os.domain.s03_bridge import S03ControlledCase

    blocked, manifest, host = make_plan(block_role="A10")
    attacker = S03ControlledCase()
    forged = attacker.issue(
        parameters=blocked.parameters,
        manifest=manifest,
        account_id=blocked.account_id,
        group_id=blocked.group_id,
        starts_at_ns=blocked.starts_at_ns,
        expires_at_ns=blocked.expires_at_ns,
    )
    assert all(duty.result == "PASS" for duty in forged.review.duties)
    with _session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, native):
        with pytest.raises(S03BridgeRejected) as blocked_open:
            S03SimulationInputSource.open(
                case_id=CASE, case=host, plan=blocked, manifest=manifest, native=native
            )
        assert blocked_open.value.code == "S03_REVIEW_BLOCKED"
        with pytest.raises(S03BridgeRejected) as stolen:
            S03SimulationInputSource.open(
                case_id=CASE, case=attacker, plan=forged, manifest=manifest, native=native
            )
        assert stolen.value.code == "S03_REVIEW_UNISSUED"
        good, good_manifest, good_case = make_plan()
        source = S03SimulationInputSource.open(
            case_id=CASE, case=good_case, plan=good, manifest=good_manifest, native=native
        )
        assert source.owner.execution_authorized is False


@pytest.mark.parametrize(
    "change",
    [{"price_increment": "0.05"}, {"min_quantity": "0.1"}],
)
def test_g4_tick_or_min_quantity_mismatch_rejects_open(change: dict[str, str]) -> None:
    from nautilus_trader.model import CurrencyPair

    from tests.unit.runner import test_s03_bridge_source as harness

    original = harness.instrument

    def altered() -> CurrencyPair:
        fields = original().to_dict()
        fields.update(change)
        return CurrencyPair.from_dict(fields)

    harness.instrument = altered
    try:
        with harness._session(NATIVE_TS, NATIVE_TS) as (_engine, _strategy, native):
            with pytest.raises(S03BridgeRejected) as caught:
                harness._open(native, (make_quote(),))
            assert caught.value.code == "S03_PROFILE_MISMATCH"
    finally:
        harness.instrument = original


def test_uncontrolled_case_or_lookalike_source_is_rejected() -> None:
    plan, manifest, case = make_plan()
    with _session(NATIVE_TS, NATIVE_TS) as (_e, _s, native):
        with pytest.raises(S03BridgeRejected) as uncontrolled:
            S03SimulationInputSource.open(
                case_id="LIVE", case=case, plan=plan, manifest=manifest, native=native
            )
        assert uncontrolled.value.code == "S03_CASE_UNCONTROLLED"
        with pytest.raises(S03BridgeRejected) as lookalike:
            S03SimulationInputSource.open(
                case_id=CASE,
                case=case,
                plan=plan,
                manifest=manifest,
                native=object(),  # type: ignore[arg-type]
            )
        assert lookalike.value.code == "S03_NATIVE_SOURCE_INVALID"
