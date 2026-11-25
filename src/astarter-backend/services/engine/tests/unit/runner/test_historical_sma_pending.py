"""Protocol doubles test ordering only; native settlement has separate integration tests."""

from fractions import Fraction as F
from types import SimpleNamespace as NS

from nautilus_trader.model import Bar, ClientOrderId

from stark_trading_os.runner.historical_sma import HistoricalSmaStrategy, _bar_value
from stark_trading_os.runner.historical_sma_policy import SmaGuardState
from tests.compat.rc3_bar_fixture import _bars
from tests.compat.rc3_cash_checkpoint_fixture import BarType, _instrument


def test_submitted_id_reservation_survives_missing_cache_until_native_terminal() -> None:
    observations = [None, NS(is_closed=False), NS(is_closed=True)]
    context = NS(
        _instrument_id=_instrument().id,
        _submitted={"one": "BUY"},
        _cancel_requested={"one"},
        _fail=lambda code: (_ for _ in ()).throw(AssertionError(code)),
        cache=NS(
            orders_open=lambda **_: [],
            orders_inflight=lambda **_: [],
            order=lambda _: observations.pop(0),
        ),
    )
    assert HistoricalSmaStrategy._pending(context) == {"one": None}
    assert set(HistoricalSmaStrategy._pending(context)) == {"one"}
    assert HistoricalSmaStrategy._pending(context) == {}
    assert context._submitted == {} and context._cancel_requested == set()


def test_deferred_exit_cancels_when_entry_becomes_visible_and_waits_for_terminal() -> None:
    bar_type = BarType.from_str(str(_instrument().id) + "-1-MINUTE-LAST-EXTERNAL")
    original = _bars(bar_type)[0]
    bars = [
        Bar(
            original.bar_type,
            original.open,
            original.high,
            original.low,
            original.close,
            original.volume,
            original.ts_event + i * 60_000_000_000,
            original.ts_init + i * 60_000_000_000,
        )
        for i in range(4)
    ]
    signals = iter(["SELL", None, None, None])
    # Cache visibility is delayed; then pending-cancel remains risk until a native terminal result.
    pending = [{"one": None}, {"one": NS(is_closed=False)}, {"one": NS(is_closed=False)}, {}]
    cancellations, intents, failures = [], [], []
    context = NS(
        _final_output=None,
        _expected_bars=tuple(_bar_value(bar) for bar in bars),
        _manifest=NS(dataset=NS(bar_type=str(bar_type))),
        _sequence=0,
        _last_bar=None,
        _failures=failures,
        _submitted={"one": "BUY"},
        _cancel_requested=set(),
        _exit_requested=False,
        _decisions=[],
        _signal=NS(update=lambda **_: next(signals)),
        _fail=failures.append,
        cancel_order=cancellations.append,
        _intent=lambda *args: intents.append(args),
    )
    for index, bar in enumerate(bars):
        context.clock = NS(timestamp_ns=lambda bar=bar: bar.ts_init)
        context._checkpoint = lambda _, index=index: (
            {},
            SmaGuardState(F("0.5"), F("0.5"), F(100), bool(pending[index])),
            pending[index],
        )
        HistoricalSmaStrategy.on_bar(context, bar)
        if index < 3:
            assert intents == []
    assert failures == []
    assert [str(value) for value in cancellations] == ["one"]
    assert type(cancellations[0]) is ClientOrderId
    assert len(intents) == 1 and intents[0][0] == "SELL"
    assert intents[0][1].position_quantity == F("0.5")
    assert context._exit_requested is False
