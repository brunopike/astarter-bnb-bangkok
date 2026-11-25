"""S03 deterministic public market facts. No account or execution authority."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from fractions import Fraction as F
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

STRATEGY_VERSION = "s03-ema-rsi-long-flat@v1"
NUMERIC_MODE = "NATIVE_BINARY64_DECIMAL_BRIDGE_V1"
type Number = Annotated[
    StrictStr, Field(max_length=64, pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
]
type PositiveNative = Annotated[float, Field(gt=0, allow_inf_nan=False)]
type RsiNative = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()


class _ClosedModel(BaseModel):
    model_config = ConfigDict(
        frozen=True,
        strict=True,
        extra="forbid",
        revalidate_instances="always",
        validate_default=True,
    )


class S03Parameters(_ClosedModel):
    ema_fast: Annotated[StrictInt, Field(ge=5, le=100)] = 20
    ema_slow: Annotated[StrictInt, Field(ge=10, le=250)] = 50
    rsi_period: Annotated[StrictInt, Field(ge=5, le=50)] = 14
    atr_period: Annotated[StrictInt, Field(ge=5, le=50)] = 14
    rsi_cross: Number = "50"
    rsi_ceiling: Number = "65"
    rsi_fail: Number = "45"
    volatility_min: Number = "0.001"
    volatility_max: Number = "0.02"
    stop_atr: Number = "2"
    risk_fraction: Number = "0.005"
    notional_fraction: Number = "0.2"
    hold_boundaries: Annotated[StrictInt, Field(ge=6, le=288)] = 36
    cooldown_full_bars: Annotated[StrictInt, Field(ge=1, le=12)] = 3

    @model_validator(mode="after")
    def check_relationships(self) -> S03Parameters:
        cross, ceiling, fail = F(self.rsi_cross), F(self.rsi_ceiling), F(self.rsi_fail)
        if not (
            self.ema_fast < self.ema_slow
            and 40 <= cross <= 60
            and cross < ceiling <= 75
            and 25 <= fail <= 50
            and fail < cross
            and 0 < F(self.volatility_min) < F(self.volatility_max) <= F("0.05")
            and 1 <= F(self.stop_atr) <= 4
            and 0 < F(self.risk_fraction) <= F("0.005")
            and 0 < F(self.notional_fraction) <= F("0.2")
        ):
            raise ValueError("S03_PARAMETERS_INVALID")
        return self

    @property
    def warmup_bars(self) -> int:
        return max(250, 5 * max(self.ema_fast, self.ema_slow, self.rsi_period, self.atr_period))

    @property
    def parameters_sha256(self) -> str:
        valid = S03Parameters.model_validate(self)
        return _digest(
            {
                "strategy_version": STRATEGY_VERSION,
                "parameter_schema": "S03Parameters.v1",
                "parameters": valid.model_dump(),
            }
        )


class S03IndicatorSnapshot(_ClosedModel):
    ema_fast: PositiveNative
    ema_slow: PositiveNative
    close: PositiveNative
    atr: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    rsi: RsiNative
    previous_rsi: RsiNative | None


@dataclass(frozen=True, slots=True)
class S03MarketFacts:
    trend_up: bool
    rsi_cross_up: bool
    volatility_allowed: bool
    market_match: bool
    momentum_below_fail: bool
    trend_invalid: bool


def evaluate_s03_market(
    snapshot: S03IndicatorSnapshot,
    parameters: S03Parameters,
) -> S03MarketFacts:
    s = S03IndicatorSnapshot.model_validate(snapshot)
    p = S03Parameters.model_validate(parameters)
    fast, slow, close, atr, rsi = (
        F(str(v))
        for v in (
            s.ema_fast,
            s.ema_slow,
            s.close,
            s.atr,
            s.rsi,
        )
    )
    trend = fast > slow and close > fast
    cross = s.previous_rsi is not None and F(str(s.previous_rsi)) <= F(p.rsi_cross) < rsi <= F(
        p.rsi_ceiling
    )
    volatility = atr > 0 and F(p.volatility_min) <= atr / close <= F(p.volatility_max)
    return S03MarketFacts(
        trend,
        cross,
        volatility,
        trend and cross and volatility,
        rsi < F(p.rsi_fail),
        fast <= slow,
    )


@dataclass(frozen=True, slots=True)
class S03MarketSignal:
    signal_id: str
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
    snapshot: S03IndicatorSnapshot
    facts: S03MarketFacts
    strategy_version: str = field(default=STRATEGY_VERSION, init=False)
    numeric_mode: str = field(default=NUMERIC_MODE, init=False)
    scope: Literal["MARKET_SIGNAL_ONLY"] = field(default="MARKET_SIGNAL_ONLY", init=False)
    execution_authorized: Literal[False] = field(default=False, init=False)


def s03_signal_id(parameters_sha256: str, instrument_id: str, bar_close_ns: int) -> str:
    """Identity only; callers must validate inputs and independently authorize use."""
    return _digest(
        {
            "strategy_version": STRATEGY_VERSION,
            "parameters_sha256": parameters_sha256,
            "instrument_id": instrument_id,
            "bar_close_ns": bar_close_ns,
            "event": "UPWARD_RSI_CROSS",
        }
    )
