"""Closed-bar S03 analysis using pinned native indicators, without order authority.

Recovery replays the same seed and original availability records. The prefix is
lineage evidence only: a trusted assembler must bind the actual source dataset.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from fractions import Fraction as F
from typing import Literal

from nautilus_trader.indicators import (
    AverageTrueRange,
    ExponentialMovingAverage,
    MovingAverageType,
    RelativeStrengthIndex,
)
from nautilus_trader.model import Bar, BarType
from pydantic import ValidationError

from stark_trading_os.domain.s03_signal import (
    NUMERIC_MODE,
    STRATEGY_VERSION,
    S03IndicatorSnapshot,
    S03MarketFacts,
    S03MarketSignal,
    S03Parameters,
    evaluate_s03_market,
    s03_signal_id,
)

_PERIOD = 300_000_000_000
_TTL = 5_000_000_000
_MAX_TIME = 2**64 - 1
_REVISION = re.compile(r"[0-9a-f]{64}")
_INSTRUMENT = re.compile(r"BTCUSDT\.[A-Z][A-Z0-9_]{0,31}")


class S03InputError(ValueError):
    def __init__(self) -> None:
        super().__init__("S03_INPUT_INVALID")


def _time(value: int) -> bool:
    return type(value) is int and 0 <= value <= _MAX_TIME


def _close_time(value: int) -> bool:
    return _time(value) and _PERIOD <= value <= _MAX_TIME - _TTL and value % _PERIOD == 0


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


@dataclass(frozen=True, slots=True)
class S03SignalObservation:
    parameters_sha256: str
    instrument_id: str
    source_revision: str
    seed_close_ns: int
    segment_seed_close_ns: int
    prefix_sha256: str
    bar_close_ns: int
    available_at_ns: int
    expires_at_ns: int
    close: str
    continuous_bars: int
    ready: bool
    gap_reset: bool
    expired: bool
    snapshot: S03IndicatorSnapshot
    facts: S03MarketFacts
    signal: S03MarketSignal | None
    strategy_version: str = field(default=STRATEGY_VERSION, init=False)
    numeric_mode: str = field(default=NUMERIC_MODE, init=False)
    scope: Literal["MARKET_SIGNAL_ONLY"] = field(default="MARKET_SIGNAL_ONLY", init=False)
    execution_authorized: Literal[False] = field(default=False, init=False)


class S03SignalStream:
    def __init__(
        self,
        parameters: S03Parameters,
        instrument_id: str,
        source_revision: str,
        *,
        seed_close_ns: int,
    ) -> None:
        if (
            type(instrument_id) is not str
            or _INSTRUMENT.fullmatch(instrument_id) is None
            or type(source_revision) is not str
            or _REVISION.fullmatch(source_revision) is None
            or not _close_time(seed_close_ns)
        ):
            raise S03InputError
        try:
            valid = S03Parameters.model_validate(parameters)
        except ValidationError:
            raise S03InputError from None
        self._parameters = valid
        self._parameters_sha256 = valid.parameters_sha256
        self._instrument_id = instrument_id
        self._source_revision = source_revision
        self._seed_close_ns = seed_close_ns
        self._segment_seed_close_ns = seed_close_ns
        self._bar_type = BarType.from_str(f"{instrument_id}-5-MINUTE-LAST-EXTERNAL")
        self._fast = ExponentialMovingAverage(valid.ema_fast)
        self._slow = ExponentialMovingAverage(valid.ema_slow)
        self._rsi = RelativeStrengthIndex(valid.rsi_period, MovingAverageType.Wilder)
        self._atr = AverageTrueRange(valid.atr_period, MovingAverageType.Wilder, True)
        self._last_close_ns: int | None = None
        self._last_available_ns = 0
        self._previous_rsi: float | None = None
        self._continuous_bars = 0
        self._prefix_sha256 = _digest(
            {
                "stream_schema": "S03SignalStream.v1",
                "strategy_version": STRATEGY_VERSION,
                "numeric_mode": NUMERIC_MODE,
                "parameters_sha256": self._parameters_sha256,
                "instrument_id": instrument_id,
                "source_revision": source_revision,
                "seed_close_ns": seed_close_ns,
            }
        )

    def _validate(self, bar: Bar, source_revision: str, available_at_ns: int) -> None:
        if (
            type(bar) is not Bar
            or type(source_revision) is not str
            or source_revision != self._source_revision
            or not _time(available_at_ns)
        ):
            raise S03InputError
        close_ns = bar.ts_event
        if (
            bar.bar_type != self._bar_type
            or not _close_time(close_ns)
            or not _time(bar.ts_init)
            or not close_ns <= bar.ts_init <= available_at_ns
            or available_at_ns < self._last_available_ns
            or (self._last_close_ns is None and close_ns != self._seed_close_ns)
            or (self._last_close_ns is not None and close_ns <= self._last_close_ns)
        ):
            raise S03InputError
        prices = (bar.open, bar.high, bar.low, bar.close)
        open_price, high, low, close = (F(str(value)) for value in prices)
        if (
            not all(math.isfinite(float(value)) and float(value) > 0 for value in prices)
            or not low <= open_price <= high
            or not low <= close <= high
            or not math.isfinite(float(bar.volume))
            or float(bar.volume) < 0
        ):
            raise S03InputError

    def update(
        self,
        bar: Bar,
        *,
        source_revision: str,
        available_at_ns: int,
    ) -> S03SignalObservation:
        self._validate(bar, source_revision, available_at_ns)
        close_ns = bar.ts_event
        gap = self._last_close_ns is not None and close_ns != self._last_close_ns + _PERIOD
        if gap:
            self._fast.reset()
            self._slow.reset()
            self._rsi.reset()
            self._atr.reset()
            self._previous_rsi = None
            self._continuous_bars = 0
            self._segment_seed_close_ns = close_ns

        close = float(bar.close)
        self._fast.update_raw(close)
        self._slow.update_raw(close)
        self._rsi.update_raw(close)
        self._atr.update_raw(float(bar.high), float(bar.low), close)
        snapshot = S03IndicatorSnapshot(
            ema_fast=self._fast.value,
            ema_slow=self._slow.value,
            rsi=self._rsi.value * 100,
            previous_rsi=self._previous_rsi,
            atr=self._atr.value,
            close=close,
        )
        facts = evaluate_s03_market(snapshot, self._parameters)
        self._continuous_bars += 1
        self._last_close_ns = close_ns
        self._last_available_ns = available_at_ns
        self._previous_rsi = snapshot.rsi
        self._prefix_sha256 = _digest(
            {
                "previous_sha256": self._prefix_sha256,
                "open": str(bar.open),
                "high": str(bar.high),
                "low": str(bar.low),
                "close": str(bar.close),
                "volume": str(bar.volume),
                "bar_close_ns": close_ns,
                "ts_init_ns": bar.ts_init,
                "available_at_ns": available_at_ns,
            }
        )
        ready = (
            self._continuous_bars >= self._parameters.warmup_bars
            and all(
                indicator.initialized
                for indicator in (
                    self._fast,
                    self._slow,
                    self._rsi,
                    self._atr,
                )
            )
            and snapshot.previous_rsi is not None
        )
        expiry = close_ns + _TTL
        expired = available_at_ns >= expiry
        signal = None
        if ready and facts.market_match and not expired:
            signal = S03MarketSignal(
                signal_id=s03_signal_id(self._parameters_sha256, self._instrument_id, close_ns),
                parameters_sha256=self._parameters_sha256,
                instrument_id=self._instrument_id,
                source_revision=self._source_revision,
                seed_close_ns=self._seed_close_ns,
                segment_seed_close_ns=self._segment_seed_close_ns,
                prefix_sha256=self._prefix_sha256,
                bar_close_ns=close_ns,
                available_at_ns=available_at_ns,
                expires_at_ns=expiry,
                close=str(bar.close),
                snapshot=snapshot,
                facts=facts,
            )
        return S03SignalObservation(
            parameters_sha256=self._parameters_sha256,
            instrument_id=self._instrument_id,
            source_revision=self._source_revision,
            seed_close_ns=self._seed_close_ns,
            segment_seed_close_ns=self._segment_seed_close_ns,
            prefix_sha256=self._prefix_sha256,
            bar_close_ns=close_ns,
            available_at_ns=available_at_ns,
            expires_at_ns=expiry,
            close=str(bar.close),
            continuous_bars=self._continuous_bars,
            ready=ready,
            gap_reset=gap,
            expired=expired,
            snapshot=snapshot,
            facts=facts,
            signal=signal,
        )
