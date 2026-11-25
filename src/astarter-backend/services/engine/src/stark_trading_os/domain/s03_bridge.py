"""Closed S03 simulation identity. A plan hash is not execution authority."""

from __future__ import annotations

import hmac
import re
from dataclasses import dataclass, field, replace
from decimal import ROUND_DOWN, Decimal
from hashlib import sha256
from secrets import token_bytes
from typing import Annotated, Literal, NoReturn

from nautilus_trader.model import Bar, BarType, Price, Quantity
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from stark_trading_os.domain.astarter_simulation import (
    NativeSnapshot,
    SimulationPolicy,
    digest,
    text,
)
from stark_trading_os.domain.s03_signal import (
    STRATEGY_VERSION,
    S03MarketFacts,
    S03MarketSignal,
    S03Parameters,
    evaluate_s03_market,
    s03_signal_id,
)
from stark_trading_os.runner.s03_indicators import (
    S03InputError,
    S03SignalObservation,
    S03SignalStream,
)

CASE_ID = "S03_SYNTHETIC_BTC_V1"
S03_FINITE_AUTHORITY = "SYNTHETIC-S03-FINITE-NOT-Q01"
PROFILE_VERSION: Literal["S03_SIM_BTC_QUOTE_V1"] = "S03_SIM_BTC_QUOTE_V1"
_BAR_NS = 300_000_000_000
_OPPORTUNITY_NS = 5_000_000_000
_RUN_NS = 86_400_000_000_000
_MAX_NS = 2**64 - 1
_HEX = r"^[0-9a-f]{64}$"
_GROUP = re.compile(r"[A-Za-z0-9_-]{1,64}")
_ROLES: tuple[
    Literal["A01"],
    Literal["A02"],
    Literal["A07"],
    Literal["A10"],
    Literal["A12"],
    Literal["A14"],
    Literal["A15"],
    Literal["A16"],
    Literal["A13"],
] = ("A01", "A02", "A07", "A10", "A12", "A14", "A15", "A16", "A13")
type TrustBit = Literal["TRUE", "FALSE", "UNKNOWN"]
type ExitDecision = Literal["FORCED_EXIT", "PAUSE_NEW_RISK", "NO_EMA_EXIT"]
type AnnotatedHash = Annotated[StrictStr, Field(pattern=_HEX)]
_CAPABILITIES: tuple[
    Literal["LIMIT_IOC"],
    Literal["SELL_STOP_MARKET_GTC_BID_ASK"],
    Literal["SELL_MARKET_IOC"],
] = (
    "LIMIT_IOC",
    "SELL_STOP_MARKET_GTC_BID_ASK",
    "SELL_MARKET_IOC",
)


class S03BridgeRejected(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _ClosedModel(BaseModel):
    model_config = ConfigDict(
        frozen=True,
        strict=True,
        extra="forbid",
        revalidate_instances="always",
        validate_default=True,
    )


class S03CostRiskOverlay(_ClosedModel):
    fee: Literal["0.001"] = "0.001"
    tick: Literal["0.01"] = "0.01"
    step: Literal["0.00001"] = "0.00001"
    quote_unit: Literal["0.00000001"] = "0.00000001"
    internal_min_notional: Literal["5"] = "5"
    astarter_risk_fraction: Literal["0.0025"] = "0.0025"
    astarter_max_risk: Literal["25"] = "25"
    astarter_nominal_cap: Literal["1000"] = "1000"
    maker_fee: Literal["0.001"] = "0.001"
    taker_fee: Literal["0.001"] = "0.001"


class S03ReviewDuty(_ClosedModel):
    role: Literal["A01", "A02", "A07", "A10", "A12", "A14", "A15", "A16", "A13"]
    input_sha256: AnnotatedHash
    scope: Literal["FINITE_S03_NATIVE_SIMULATION"]
    result: Literal["PASS", "BLOCK"]
    valid_from_ns: StrictInt
    valid_until_ns: StrictInt


class S03SimulatedReview(_ClosedModel):
    label: Literal["SIMULATED_REVIEW"]
    evidence_version: Literal["S03_SIMULATED_REVIEW_V1"]
    account_id: StrictStr
    group_id: StrictStr
    parameters_sha256: AnnotatedHash
    source_revision: AnnotatedHash
    manifest_sha256: AnnotatedHash
    profile_version: Literal["S03_SIM_BTC_QUOTE_V1"]
    abc_rules_version: Literal["S03_ABC_V1"]
    duties: tuple[S03ReviewDuty, ...]
    starts_at_ns: StrictInt
    expires_at_ns: StrictInt
    seal: AnnotatedHash
    reactivation_binding: AnnotatedHash | None = None


class S03RawQuote(_ClosedModel):
    kind: Literal["QUOTE"] = "QUOTE"
    source_sequence: Annotated[StrictInt, Field(gt=0)]
    source_event_time_ns: StrictInt
    received_time_ns: StrictInt
    bid: StrictStr
    ask: StrictStr
    bid_size: StrictStr
    ask_size: StrictStr
    instrument_id: Literal["BTCUSDT.SIM"] = "BTCUSDT.SIM"


class S03RawBar(_ClosedModel):
    open: StrictStr
    high: StrictStr
    low: StrictStr
    close: StrictStr
    volume: StrictStr
    bar_close_ns: StrictInt
    ts_init_ns: StrictInt
    available_at_ns: StrictInt


class S03RawNews(_ClosedModel):
    source_sequence: Annotated[StrictInt, Field(gt=0)]
    previous_sequence: Annotated[StrictInt, Field(ge=0)]
    source_event_time_ns: StrictInt
    received_time_ns: StrictInt
    available_at_ns: StrictInt
    status: Literal["HEALTHY", "SEVERE", "CLEARED"]
    incident_id: Annotated[StrictStr, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")] | None = None

    @model_validator(mode="after")
    def _incident(self) -> S03RawNews:
        if (self.status == "HEALTHY") != (self.incident_id is None):
            raise ValueError("S03_NEWS_INCIDENT_INVALID")
        if self.source_sequence != self.previous_sequence + 1:
            raise ValueError("S03_NEWS_CONTINUITY_INVALID")
        return self


class S03DataManifest(_ClosedModel):
    schema_version: Literal["S03_SYNTHETIC_MANIFEST_V1"] = "S03_SYNTHETIC_MANIFEST_V1"
    case_id: Literal["S03_SYNTHETIC_BTC_V1"]
    source_revision: AnnotatedHash
    seed_close_ns: StrictInt
    instrument_id: Literal["BTCUSDT.SIM"] = "BTCUSDT.SIM"
    native_instrument_id: Literal["BTC/USDT.SIM"] = "BTC/USDT.SIM"
    profile_version: Literal["S03_SIM_BTC_QUOTE_V1"] = "S03_SIM_BTC_QUOTE_V1"
    quotes: tuple[S03RawQuote, ...] = ()
    bars: tuple[S03RawBar, ...] = ()
    news: tuple[S03RawNews, ...] = ()


class S03BridgePlan(_ClosedModel):
    scope: Literal["FINITE_S03_NATIVE_SIMULATION"] = "FINITE_S03_NATIVE_SIMULATION"
    real_trading_connected: Literal[False] = False
    execution_authorized: Literal[False] = False
    strategy_version: Literal["s03-ema-rsi-long-flat@v1"] = "s03-ema-rsi-long-flat@v1"
    parameters: S03Parameters
    parameters_sha256: AnnotatedHash
    source_revision: AnnotatedHash
    seed_close_ns: StrictInt
    manifest_sha256: AnnotatedHash
    profile_version: Literal["S03_SIM_BTC_QUOTE_V1"] = PROFILE_VERSION
    s03_instrument_id: Literal["BTCUSDT.SIM"] = "BTCUSDT.SIM"
    native_instrument_id: Literal["BTC/USDT.SIM"] = "BTC/USDT.SIM"
    venue: Literal["SIM"] = "SIM"
    account_id: StrictStr
    group_id: StrictStr
    review: S03SimulatedReview
    abc_rules_version: Literal["S03_ABC_V1"] = "S03_ABC_V1"
    starts_at_ns: StrictInt
    expires_at_ns: StrictInt
    overlay: S03CostRiskOverlay = S03CostRiskOverlay()
    bar_execution: Literal[False] = False
    capabilities: tuple[
        Literal["LIMIT_IOC"],
        Literal["SELL_STOP_MARKET_GTC_BID_ASK"],
        Literal["SELL_MARKET_IOC"],
    ] = _CAPABILITIES

    @model_validator(mode="after")
    def _strategy_identity(self) -> S03BridgePlan:
        if self.strategy_version != STRATEGY_VERSION:
            raise ValueError("S03_PARAMETERS_MISMATCH")
        return self


class S03IndicatorTrust(_ClosedModel):
    trend_up: TrustBit
    rsi_cross_up: TrustBit
    volatility_allowed: TrustBit
    market_match: TrustBit
    momentum_below_fail: TrustBit
    trend_invalid: TrustBit
    data_status: Literal["TRUSTED", "UNKNOWN"]


@dataclass(frozen=True, slots=True)
class S03Owner:
    owner_id: str
    run_id: str
    venue_session: str
    fence: int
    credential: str = field(repr=False)
    execution_authorized: Literal[False] = False
    scope: Literal["FINITE_S03_NATIVE_SIMULATION"] = "FINITE_S03_NATIVE_SIMULATION"


@dataclass(frozen=True, slots=True)
class S03RunState:
    run_id: str
    owner_id: str
    fence: int
    venue_session: str
    input_reasons: tuple[str, ...]
    accepted_quote_count: int
    rejected_count: int
    quote_source_watermark: int | None
    quote_source_event_watermark_ns: int | None
    instrument_sha256: str
    profile_version: Literal["S03_SIM_BTC_QUOTE_V1"]
    scope: Literal["FINITE_S03_NATIVE_SIMULATION"] = "FINITE_S03_NATIVE_SIMULATION"
    real_trading_connected: Literal[False] = False
    execution_authorized: Literal[False] = False


def s03_manifest_sha256(manifest: S03DataManifest) -> str:
    checked = S03DataManifest.model_validate(manifest)
    payload = checked.model_dump(mode="json")
    if not checked.news:
        payload.pop("news")
    return digest(payload)


def s03_review_input_sha256(
    role: str,
    *,
    parameters_sha256: str,
    manifest_sha256: str,
    source_revision: str,
    account_id: str,
    group_id: str,
    overlay: S03CostRiskOverlay,
    abc_rules_version: str,
    profile_version: str,
    seed_close_ns: int,
    instrument_id: str,
    starts_at_ns: int,
    expires_at_ns: int,
    reactivation_binding: str | None = None,
) -> str:
    """Digest of one simulated duty's actual inputs. A matching digest is not issuance."""
    return digest(
        {
            "input_name": "S03_SIMULATED_REVIEW_INPUT_V1",
            "role": role,
            "parameters_sha256": parameters_sha256,
            "manifest_sha256": manifest_sha256,
            "source_revision": source_revision,
            "account_id": account_id,
            "group_id": group_id,
            "overlay": overlay.model_dump(mode="json"),
            "abc_rules_version": abc_rules_version,
            "profile_version": profile_version,
            "seed_close_ns": seed_close_ns,
            "instrument_id": instrument_id,
            "starts_at_ns": starts_at_ns,
            "expires_at_ns": expires_at_ns,
            **({"reactivation_binding": reactivation_binding} if reactivation_binding else {}),
        }
    )


class S03ControlledCase:
    """Process-local issuer for SIMULATED_REVIEW. The key never leaves this object."""

    def __init__(self) -> None:
        self._key = token_bytes(32)

    def _seal(self, review: S03SimulatedReview) -> str:
        body = review.model_dump(mode="json", exclude={"seal"})
        if review.reactivation_binding is None:
            body.pop("reactivation_binding")
        return hmac.new(self._key, digest(body).encode(), sha256).hexdigest()

    def issued(self, plan: S03BridgePlan) -> bool:
        if type(plan) is not S03BridgePlan or len(plan.review.seal) != 64:
            return False
        return hmac.compare_digest(plan.review.seal, self._seal(plan.review))

    def issue(
        self,
        *,
        parameters: S03Parameters,
        manifest: S03DataManifest,
        account_id: str,
        group_id: str,
        starts_at_ns: int,
        expires_at_ns: int,
        block_role: str | None = None,
        reactivation_binding: str | None = None,
    ) -> S03BridgePlan:
        parameters = S03Parameters.model_validate(parameters)
        manifest = S03DataManifest.model_validate(manifest)
        manifest_sha = s03_manifest_sha256(manifest)
        overlay = S03CostRiskOverlay()
        duties_list: list[S03ReviewDuty] = []
        for role in _ROLES:
            result: Literal["PASS", "BLOCK"] = "BLOCK" if role == block_role else "PASS"
            duties_list.append(
                S03ReviewDuty(
                    role=role,
                    input_sha256=s03_review_input_sha256(
                        role,
                        parameters_sha256=parameters.parameters_sha256,
                        manifest_sha256=manifest_sha,
                        source_revision=manifest.source_revision,
                        account_id=account_id,
                        group_id=group_id,
                        overlay=overlay,
                        abc_rules_version="S03_ABC_V1",
                        profile_version=PROFILE_VERSION,
                        seed_close_ns=manifest.seed_close_ns,
                        instrument_id=manifest.instrument_id,
                        starts_at_ns=starts_at_ns,
                        expires_at_ns=expires_at_ns,
                        reactivation_binding=reactivation_binding,
                    ),
                    scope="FINITE_S03_NATIVE_SIMULATION",
                    result=result,
                    valid_from_ns=starts_at_ns,
                    valid_until_ns=expires_at_ns,
                )
            )
        duties = tuple(duties_list)
        unsigned = S03SimulatedReview(
            label="SIMULATED_REVIEW",
            evidence_version="S03_SIMULATED_REVIEW_V1",
            account_id=account_id,
            group_id=group_id,
            parameters_sha256=parameters.parameters_sha256,
            source_revision=manifest.source_revision,
            manifest_sha256=manifest_sha,
            profile_version=PROFILE_VERSION,
            abc_rules_version="S03_ABC_V1",
            duties=duties,
            starts_at_ns=starts_at_ns,
            expires_at_ns=expires_at_ns,
            seal="0" * 64,
            reactivation_binding=reactivation_binding,
        )
        review = unsigned.model_copy(update={"seal": self._seal(unsigned)})
        return S03BridgePlan(
            parameters=parameters,
            parameters_sha256=parameters.parameters_sha256,
            source_revision=manifest.source_revision,
            seed_close_ns=manifest.seed_close_ns,
            manifest_sha256=manifest_sha,
            account_id=account_id,
            group_id=group_id,
            review=review,
            starts_at_ns=starts_at_ns,
            expires_at_ns=expires_at_ns,
        )


_LOCAL_SIMULATION_CASE = S03ControlledCase()


def local_simulation_case() -> S03ControlledCase:
    """The only issuer source admission will trust. Callers cannot substitute another."""
    return _LOCAL_SIMULATION_CASE


def _close_time(value: int) -> bool:
    return (
        type(value) is int
        and _BAR_NS <= value <= _MAX_NS - _OPPORTUNITY_NS
        and value % _BAR_NS == 0
    )


def _reject(code: str) -> NoReturn:
    raise S03BridgeRejected(code)


def _review_inputs_match(plan: S03BridgePlan, manifest_sha256: str) -> bool:
    for duty in plan.review.duties:
        expected = s03_review_input_sha256(
            duty.role,
            parameters_sha256=plan.parameters.parameters_sha256,
            manifest_sha256=manifest_sha256,
            source_revision=plan.source_revision,
            account_id=plan.account_id,
            group_id=plan.group_id,
            overlay=plan.overlay,
            abc_rules_version=plan.abc_rules_version,
            profile_version=plan.profile_version,
            seed_close_ns=plan.seed_close_ns,
            instrument_id=plan.s03_instrument_id,
            starts_at_ns=plan.starts_at_ns,
            expires_at_ns=plan.expires_at_ns,
            reactivation_binding=plan.review.reactivation_binding,
        )
        if duty.input_sha256 != expected:
            return False
    return True


def validate_s03_plan(
    plan: S03BridgePlan,
    manifest: S03DataManifest,
    case: S03ControlledCase | None = None,
) -> None:
    plan = S03BridgePlan.model_validate(plan)
    manifest = S03DataManifest.model_validate(manifest)
    roles = tuple(duty.role for duty in plan.review.duties)
    if len(roles) != len(_ROLES) or set(roles) != set(_ROLES):
        _reject("S03_REVIEW_ROLE_MISSING")
    if any(duty.result == "BLOCK" for duty in plan.review.duties):
        _reject("S03_REVIEW_BLOCKED")
    if plan.account_id != "SIM-001" or plan.review.account_id != plan.account_id:
        _reject("S03_ACCOUNT_MISMATCH")
    if _GROUP.fullmatch(plan.group_id) is None or plan.group_id != plan.review.group_id:
        _reject("S03_REVIEW_BINDING_MISMATCH")
    actual_parameters = plan.parameters.parameters_sha256
    review_parameters = plan.review.parameters_sha256
    if plan.parameters_sha256 != actual_parameters or review_parameters != actual_parameters:
        _reject("S03_PARAMETERS_MISMATCH")
    if plan.strategy_version != STRATEGY_VERSION:
        _reject("S03_PARAMETERS_MISMATCH")
    actual_manifest = s03_manifest_sha256(manifest)
    if (
        plan.manifest_sha256 != actual_manifest
        or plan.review.manifest_sha256 != actual_manifest
        or plan.source_revision != manifest.source_revision
        or plan.review.source_revision != plan.source_revision
        or plan.seed_close_ns != manifest.seed_close_ns
        or not _close_time(plan.seed_close_ns)
    ):
        _reject("S03_MANIFEST_MISMATCH")
    if (
        plan.profile_version != PROFILE_VERSION
        or manifest.profile_version != plan.profile_version
        or plan.review.profile_version != plan.profile_version
        or plan.abc_rules_version != "S03_ABC_V1"
        or plan.review.abc_rules_version != plan.abc_rules_version
        or plan.s03_instrument_id != manifest.instrument_id
        or plan.native_instrument_id != manifest.native_instrument_id
        or plan.capabilities != _CAPABILITIES
        or plan.bar_execution is not False
        or plan.real_trading_connected is not False
        or plan.execution_authorized is not False
        or plan.scope != "FINITE_S03_NATIVE_SIMULATION"
        or plan.review.label != "SIMULATED_REVIEW"
        or manifest.case_id != CASE_ID
    ):
        _reject("S03_PROFILE_MISMATCH")
    if not 0 <= plan.starts_at_ns < plan.expires_at_ns <= _MAX_NS:
        _reject("S03_RUN_WINDOW_INVALID")
    if plan.expires_at_ns - plan.starts_at_ns > _RUN_NS:
        _reject("S03_RUN_WINDOW_INVALID")
    if (
        plan.starts_at_ns != plan.review.starts_at_ns
        or plan.expires_at_ns != plan.review.expires_at_ns
    ):
        _reject("S03_RUN_WINDOW_UNBOUND")
    for duty in plan.review.duties:
        if duty.valid_from_ns != plan.starts_at_ns or duty.valid_until_ns != plan.expires_at_ns:
            _reject("S03_RUN_WINDOW_UNBOUND")
    if not _review_inputs_match(plan, actual_manifest):
        _reject("S03_REVIEW_INPUT_UNBOUND")
    trusted = local_simulation_case()
    if case is not trusted or not trusted.issued(plan):
        _reject("S03_REVIEW_UNISSUED")


def _native_bar(raw: S03RawBar, instrument_id: str) -> Bar:
    return Bar(
        bar_type=BarType.from_str(f"{instrument_id}-5-MINUTE-LAST-EXTERNAL"),
        open=Price.from_str(raw.open),
        high=Price.from_str(raw.high),
        low=Price.from_str(raw.low),
        close=Price.from_str(raw.close),
        volume=Quantity.from_str(raw.volume),
        ts_event=raw.bar_close_ns,
        ts_init=raw.ts_init_ns,
    )


def replay_s03_observations(
    plan: S03BridgePlan, manifest: S03DataManifest
) -> tuple[S03SignalObservation, ...]:
    plan = S03BridgePlan.model_validate(plan)
    manifest = S03DataManifest.model_validate(manifest)
    stream = S03SignalStream(
        plan.parameters,
        plan.s03_instrument_id,
        plan.source_revision,
        seed_close_ns=plan.seed_close_ns,
    )
    observed: list[S03SignalObservation] = []
    for raw in manifest.bars:
        observed.append(
            stream.update(
                _native_bar(raw, plan.s03_instrument_id),
                source_revision=plan.source_revision,
                available_at_ns=raw.available_at_ns,
            )
        )
    return tuple(observed)


def validate_s03_signal(
    plan: S03BridgePlan,
    signal: S03MarketSignal,
    observation: S03SignalObservation,
    manifest: S03DataManifest | None = None,
) -> None:
    plan = S03BridgePlan.model_validate(plan)
    if (
        type(signal) is not S03MarketSignal
        or type(observation) is not S03SignalObservation
        or signal.execution_authorized is not False
        or observation.execution_authorized is not False
        or signal.scope != "MARKET_SIGNAL_ONLY"
        or observation.scope != "MARKET_SIGNAL_ONLY"
    ):
        _reject("S03_SIGNAL_FORGED")
    if (
        signal.parameters_sha256 != plan.parameters.parameters_sha256
        or observation.parameters_sha256 != signal.parameters_sha256
        or signal.instrument_id != plan.s03_instrument_id
        or observation.instrument_id != signal.instrument_id
        or signal.source_revision != plan.source_revision
        or observation.source_revision != signal.source_revision
    ):
        _reject("S03_SIGNAL_FORGED")
    if signal.signal_id != s03_signal_id(
        signal.parameters_sha256, signal.instrument_id, signal.bar_close_ns
    ):
        _reject("S03_SIGNAL_FORGED")
    recomputed = evaluate_s03_market(signal.snapshot, plan.parameters)
    if signal.facts != recomputed or observation.facts != recomputed:
        _reject("S03_SIGNAL_FORGED")
    if (
        manifest is None
        or signal.seed_close_ns != plan.seed_close_ns
        or signal.expires_at_ns != signal.bar_close_ns + _OPPORTUNITY_NS
        or manifest.seed_close_ns != plan.seed_close_ns
        or manifest.source_revision != plan.source_revision
    ):
        _reject("S03_SIGNAL_UNTRUSTED")
    if (
        s03_manifest_sha256(manifest) != plan.manifest_sha256
        or plan.review.manifest_sha256 != plan.manifest_sha256
    ):
        _reject("S03_MANIFEST_MISMATCH")
    try:
        replayed = replay_s03_observations(plan, manifest)
    except S03InputError:
        _reject("S03_SIGNAL_UNTRUSTED")
    matched = next((item for item in replayed if item.bar_close_ns == signal.bar_close_ns), None)
    if (
        matched is None
        or matched.signal is None
        or matched != observation
        or matched.signal != signal
        or not matched.ready
        or matched.gap_reset
        or matched.expired
        or matched.continuous_bars < plan.parameters.warmup_bars
    ):
        _reject("S03_SIGNAL_UNTRUSTED")


def _bit(value: bool) -> Literal["TRUE", "FALSE"]:
    if value:
        return "TRUE"
    return "FALSE"


def _unknown() -> S03IndicatorTrust:
    return S03IndicatorTrust(
        trend_up="UNKNOWN",
        rsi_cross_up="UNKNOWN",
        volatility_allowed="UNKNOWN",
        market_match="UNKNOWN",
        momentum_below_fail="UNKNOWN",
        trend_invalid="UNKNOWN",
        data_status="UNKNOWN",
    )


def s03_indicator_trust(
    observation: S03SignalObservation,
    parameters: S03Parameters,
) -> S03IndicatorTrust:
    parameters = S03Parameters.model_validate(parameters)
    if type(observation) is not S03SignalObservation:
        _reject("S03_OBSERVATION_INVALID")
    if observation.parameters_sha256 != parameters.parameters_sha256:
        _reject("S03_PARAMETERS_MISMATCH")
    if (not observation.ready) or observation.gap_reset:
        return _unknown()
    facts: S03MarketFacts = evaluate_s03_market(observation.snapshot, parameters)
    return S03IndicatorTrust(
        trend_up=_bit(facts.trend_up),
        rsi_cross_up=_bit(facts.rsi_cross_up),
        volatility_allowed=_bit(facts.volatility_allowed),
        market_match=_bit(facts.market_match),
        momentum_below_fail=_bit(facts.momentum_below_fail),
        trend_invalid=_bit(facts.trend_invalid),
        data_status="TRUSTED",
    )


def s03_ema_exit_decision(trust: S03IndicatorTrust) -> ExitDecision:
    checked = S03IndicatorTrust.model_validate(trust)
    if checked.trend_invalid == "UNKNOWN":
        return "PAUSE_NEW_RISK"
    if checked.trend_invalid == "TRUE":
        return "FORCED_EXIT"
    return "NO_EMA_EXIT"


def s03_bound_source_event_time(snapshot: NativeSnapshot) -> int:
    if type(snapshot) is not NativeSnapshot or type(snapshot.source_event_time_ns) is not int:
        _reject("S03_SOURCE_EVENT_TIME_MISSING")
    if not 0 <= snapshot.source_event_time_ns <= _MAX_NS:
        _reject("S03_SOURCE_EVENT_TIME_MISSING")
    return snapshot.source_event_time_ns


def s03_quote_clock(snapshot: NativeSnapshot, now_ns: int) -> bool:
    return all(
        type(stamp) is int
        and 0 <= stamp <= _MAX_NS
        and -500_000_000 <= now_ns - stamp <= 2_000_000_000
        for stamp in (snapshot.source_event_time_ns, snapshot.quote_time_ns)
    )


def advance_s03_time(
    life: S03Life,
    parameters: S03Parameters,
    snapshot: NativeSnapshot,
    now_ns: int,
    expires_at_ns: int,
) -> S03Life:
    reasons = life.reasons
    hold = life.hold_seen
    if Decimal(snapshot.position_quantity) > 0 and life.first_fill_ns is not None:
        hold = max(hold, _boundaries(life.first_fill_ns, now_ns))
        if hold >= parameters.hold_boundaries:
            reasons = _with(reasons, "HOLD_LIMIT")
    if not s03_quote_clock(snapshot, now_ns):
        reasons = _with(reasons, "QUOTE_UNHEALTHY")
    if now_ns >= expires_at_ns:
        reasons = _with(reasons, "PLAN_EXPIRED")
    target = _target(reasons, Decimal(snapshot.position_quantity) > 0)
    if life.exit_target == "C" and Decimal(snapshot.position_quantity) > 0:
        target = "C"
    return replace(life, hold_seen=hold, reasons=reasons, exit_target=target or life.exit_target)


_EXIT_GAP_NS = 250_000_000
_DEADLINE_NS = 1_000_000_000
_LOSS_LIMIT = Decimal("0.02")
_RECOMPUTED = frozenset(
    {
        "ORDER_UNKNOWN",
        "COOLDOWN",
        "TREND_EXIT",
        "RSI_FAIL",
        "HOLD_LIMIT",
        "POSITION_OPEN",
    }
)
_C_REASONS = frozenset({"TREND_EXIT", "DAY_LOSS", "EMERGENCY", "PROTECTION_FAILED"})
_B_REASONS = frozenset({"RSI_FAIL", "HOLD_LIMIT"})
_TERMINAL_ORDERS = frozenset({"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"})
_KNOWN_ORDERS = _TERMINAL_ORDERS | {"ACCEPTED"}
_ENTRY_LOCKS = frozenset(
    {
        "DATA_PAUSE",
        "SOURCE_UNTRUSTED",
        "NEWS_UNHEALTHY",
        "PLAN_EXPIRED",
        "ORDER_UNKNOWN",
        "QUOTE_UNHEALTHY",
        "NEWS_LOCK",
        "AUTH_REVOKED",
        "COOLDOWN",
        "DAY_BASELINE_MISSING",
        "RECONCILIATION_REQUIRED",
        "EXIT_BLOCKED",
        "EXIT_PENDING",
        "DAY_LOSS",
        "EMERGENCY",
        "PROTECTION_FAILED",
        "TREND_EXIT",
        "RSI_FAIL",
        "HOLD_LIMIT",
        "RESIDUAL_ARMED",
        "POSITION_OPEN",
    }
)
_NOTE_LOCKS = frozenset({"NEWS_LOCK", "AUTH_REVOKED", "EMERGENCY", "PROTECTION_FAILED"})
_PERSISTENT_LOCKS = frozenset(
    {
        "PROTECTION_FAILED",
        "EXIT_BLOCKED",
        "DAY_LOSS",
        "EMERGENCY",
        "RECONCILIATION_REQUIRED",
        "AUTH_REVOKED",
        "NEWS_LOCK",
    }
)
_NATIVE_TERMINAL = frozenset({"FILLED", "CANCELED", "REJECTED", "DENIED", "EXPIRED"})


@dataclass(frozen=True, slots=True)
class S03Life:
    first_fill_ns: int | None = None
    rsi_fail_streak: int = 0
    hold_seen: int = 0
    cooldown_bars: int = 0
    flat_ns: int | None = None
    exit_claims: int = 0
    last_exit_ns: int | None = None
    exit_deadline_ns: int | None = None
    protection_deadline_ns: int | None = None
    residual_used: bool = False
    day_baseline: str | None = None
    day_key: str | None = None
    exit_target: str | None = None
    blocked_signal_id: str | None = None
    reasons: tuple[str, ...] = ()
    cooldown_open_after_ns: int | None = None
    exit_order_id: str | None = None
    residual_order_id: str | None = None
    residual_deadline_ns: int | None = None
    active_intent_id: str | None = None


def s03_entry_locked(life: S03Life) -> bool:
    if type(life) is not S03Life:
        _reject("S03_LIFE_INVALID")
    return life.exit_target is not None or any(reason in _ENTRY_LOCKS for reason in life.reasons)


def step_s03_life(
    parameters: S03Parameters,
    snapshot: NativeSnapshot,
    observation: S03SignalObservation | None,
    life: S03Life,
) -> S03Life:
    """One deterministic ABC step. Inventory comes only from the verified snapshot."""
    parameters = S03Parameters.model_validate(parameters)
    if type(life) is not S03Life:
        _reject("S03_LIFE_INVALID")
    if observation is not None and type(observation) is not S03SignalObservation:
        _reject("S03_OBSERVATION_INVALID")
    quantity = _inventory(snapshot)
    reasons = [reason for reason in life.reasons if reason not in _RECOMPUTED]
    buy_times = [fill.time_ns for fill in snapshot.fills if fill.side == "BUY"]
    first = life.first_fill_ns
    if buy_times:
        earliest = min(buy_times)
        first = earliest if first is None else min(first, earliest)
    protection = life.protection_deadline_ns
    if first is not None and protection is None:
        protection = first + _DEADLINE_NS
    if any(order.state not in _KNOWN_ORDERS for order in snapshot.orders):
        _add(reasons, "ORDER_UNKNOWN")
    if not snapshot.cash_reconciled:
        _add(reasons, "QUOTE_UNHEALTHY")
    day = str(snapshot.now_ns // _RUN_NS)
    baseline, day_key = life.day_baseline, life.day_key
    if s03_quote_clock(snapshot, snapshot.now_ns):
        equity = Decimal(snapshot.quote_total) + quantity * Decimal(snapshot.bid)
        if day_key is None:
            baseline, day_key = format(equity, "f"), day
            if snapshot.now_ns % _RUN_NS != 0:
                _add(reasons, "PARTIAL_DAY")
        elif day != day_key and snapshot.now_ns % _RUN_NS == 0:
            baseline, day_key = format(equity, "f"), day
        elif day != day_key:
            _add(reasons, "DAY_BASELINE_MISSING")
        if baseline is not None:
            base = Decimal(baseline)
            if base > 0 and (base - equity) / base >= _LOSS_LIMIT:
                _add(reasons, "DAY_LOSS")
    else:
        _add(reasons, "QUOTE_UNHEALTHY")
        if day_key != day:
            _add(reasons, "DAY_BASELINE_MISSING")
    streak, hold = life.rsi_fail_streak, life.hold_seen
    cooldown, flat = life.cooldown_bars, life.flat_ns
    open_after = life.cooldown_open_after_ns
    if quantity > 0:
        _add(reasons, "POSITION_OPEN")
    if quantity > 0 and first is not None:
        hold = max(hold, _boundaries(first, snapshot.now_ns))
    if observation is not None and quantity > 0 and first is not None:
        if observation.bar_close_ns > first:
            trust = s03_indicator_trust(observation, parameters)
            if trust.data_status != "TRUSTED":
                streak = 0
                _add(reasons, "DATA_PAUSE")
            else:
                streak = streak + 1 if trust.momentum_below_fail == "TRUE" else 0
                if trust.trend_invalid == "TRUE":
                    _add(reasons, "TREND_EXIT")
    if quantity > 0 and hold >= parameters.hold_boundaries:
        _add(reasons, "HOLD_LIMIT")
    if quantity > 0 and streak >= 2:
        _add(reasons, "RSI_FAIL")
    terminal = all(order.state in _TERMINAL_ORDERS for order in snapshot.orders)
    if quantity == 0 and first is not None and terminal and snapshot.cash_reconciled:
        if flat is None:
            flat = snapshot.now_ns
        if cooldown < parameters.cooldown_full_bars and _full_bar(observation, flat):
            cooldown += 1
            if cooldown >= parameters.cooldown_full_bars and observation is not None:
                open_after = observation.bar_close_ns
        if cooldown < parameters.cooldown_full_bars:
            _add(reasons, "COOLDOWN")
    return replace(
        life,
        first_fill_ns=first,
        rsi_fail_streak=streak,
        hold_seen=hold,
        cooldown_bars=cooldown,
        flat_ns=flat,
        protection_deadline_ns=protection,
        day_baseline=baseline,
        day_key=day_key,
        exit_target=(
            "C"
            if quantity > 0 and life.exit_target == "C"
            else (_target(reasons, quantity > 0) or (life.exit_target if quantity > 0 else None))
        ),
        reasons=tuple(reasons),
        cooldown_open_after_ns=open_after,
    )


def claim_s03_exit(life: S03Life, now_ns: int, snapshot: NativeSnapshot, order_id: str) -> S03Life:
    if type(life) is not S03Life or type(now_ns) is not int or now_ns < 0:
        _reject("S03_EXIT_INVALID")
    if now_ns != snapshot.now_ns:
        _reject("S03_CLOCK_REGRESSION")
    if life.exit_target not in {"C", "B"}:
        _reject("S03_EXIT_NONE")
    if "RECONCILIATION_REQUIRED" in life.reasons or "EXIT_PENDING" in life.reasons:
        _reject("S03_EXIT_UNRESOLVED")
    if "ORDER_UNKNOWN" in life.reasons:
        _reject("S03_EXIT_UNRESOLVED")
    if life.exit_claims >= 3:
        _reject("S03_EXIT_EXHAUSTED")
    if life.last_exit_ns is not None and now_ns - life.last_exit_ns < _EXIT_GAP_NS:
        _reject("S03_EXIT_TOO_SOON")
    if _inventory(snapshot) <= 0:
        _reject("S03_EXIT_FLAT")
    if type(order_id) is not str or not order_id:
        _reject("S03_EXIT_UNAVAILABLE")
    claims = life.exit_claims + 1
    reasons = _with(life.reasons, "EXIT_PENDING")
    if claims >= 3:
        reasons = _with(reasons, "EXIT_BLOCKED")
    return replace(
        life,
        exit_claims=claims,
        last_exit_ns=now_ns,
        exit_deadline_ns=now_ns + _DEADLINE_NS,
        exit_order_id=order_id,
        reasons=reasons,
    )


def apply_s03_exit_fact(
    life: S03Life, *, state: str | None, at_ns: int, reconciled: bool
) -> S03Life:
    """Native order state is the only proof. ACCEPTED is not a finished exit."""
    if type(life) is not S03Life or type(at_ns) is not int:
        _reject("S03_EXIT_INVALID")
    if "EXIT_PENDING" not in life.reasons or life.exit_deadline_ns is None:
        _reject("S03_EXIT_NONE")
    if state == "ACCEPTED" and at_ns <= life.exit_deadline_ns:
        return life
    if state in _NATIVE_TERMINAL and reconciled and at_ns <= life.exit_deadline_ns:
        reasons = _with(_drop(life.reasons, "EXIT_PENDING"), f"EXIT_RESULT:{state}")
        return replace(life, reasons=reasons, exit_order_id=None)
    if at_ns > life.exit_deadline_ns:
        reasons = _with(life.reasons, "RECONCILIATION_REQUIRED")
        return replace(life, reasons=reasons)
    return life


def note_s03_timer(
    life: S03Life,
    now_ns: int,
    snapshot: NativeSnapshot | None = None,
    *,
    protected_quantity: str = "0",
    uncovered_deadline_ns: int | None = None,
) -> S03Life:
    if type(life) is not S03Life or type(now_ns) is not int or now_ns < 0:
        _reject("S03_EXIT_INVALID")
    if snapshot is not None and now_ns < snapshot.now_ns:
        _reject("S03_CLOCK_REGRESSION")
    reasons = life.reasons
    if (
        "EXIT_PENDING" in reasons
        and life.exit_deadline_ns is not None
        and now_ns > life.exit_deadline_ns
    ):
        reasons = _with(reasons, "RECONCILIATION_REQUIRED")
    if life.residual_deadline_ns is not None and now_ns > life.residual_deadline_ns:
        native = (
            next((o for o in snapshot.orders if o.order_id == life.residual_order_id), None)
            if snapshot
            else None
        )
        if native is None or native.accepted_at_ns is None:
            reasons = _with(reasons, "PROTECTION_FAILED")
            if native is None or native.state not in _NATIVE_TERMINAL:
                reasons = _with(reasons, "RECONCILIATION_REQUIRED")
        elif native.accepted_at_ns > life.residual_deadline_ns:
            reasons = _with(reasons, "PROTECTION_FAILED")
    deadline = (
        uncovered_deadline_ns if uncovered_deadline_ns is not None else life.protection_deadline_ns
    )
    quantity = _inventory(snapshot) if snapshot is not None else Decimal(0)
    if deadline is not None and now_ns > deadline and quantity > Decimal(protected_quantity):
        reasons = _with(reasons, "PROTECTION_FAILED")
    return replace(
        life,
        reasons=reasons,
        exit_target=(
            life.exit_target
            if snapshot is None
            else (
                "C"
                if quantity > 0 and life.exit_target == "C"
                else (
                    _target(reasons, quantity > 0) or (life.exit_target if quantity > 0 else None)
                )
            )
        ),
    )


def claim_s03_residual(life: S03Life, snapshot: NativeSnapshot) -> S03Life:
    if type(life) is not S03Life:
        _reject("S03_LIFE_INVALID")
    if life.residual_used:
        _reject("S03_RESIDUAL_USED")
    if "EXIT_BLOCKED" not in life.reasons or "EXIT_PENDING" in life.reasons:
        _reject("S03_RESIDUAL_UNAVAILABLE")
    if "RECONCILIATION_REQUIRED" in life.reasons or _inventory(snapshot) <= 0:
        _reject("S03_RESIDUAL_UNAVAILABLE")
    live_sell = any(
        order.side == "SELL" and order.state not in _TERMINAL_ORDERS for order in snapshot.orders
    )
    if live_sell:
        _reject("S03_RESIDUAL_UNAVAILABLE")
    return replace(life, residual_used=True, reasons=_with(life.reasons, "RESIDUAL_ARMED"))


def lock_s03_reason(life: S03Life, code: str) -> S03Life:
    if type(life) is not S03Life or code not in _NOTE_LOCKS:
        _reject("S03_REASON_INVALID")
    reasons = _with(life.reasons, code)
    return replace(
        life,
        reasons=reasons,
        exit_target=_target(reasons, life.exit_target is not None),
    )


def release_s03_reason(life: S03Life, code: str) -> S03Life:
    if type(life) is not S03Life or code not in life.reasons:
        _reject("S03_REASON_ABSENT")
    _reject("S03_RELEASE_UNEVIDENCED")


def _inventory(snapshot: NativeSnapshot) -> Decimal:
    if type(snapshot) is not NativeSnapshot:
        _reject("S03_NATIVE_SOURCE_INVALID")
    if snapshot.position_quantity != snapshot.base_total:
        _reject("S03_INVENTORY_MISMATCH")
    return Decimal(snapshot.position_quantity)


def _boundaries(first_fill: int, bar_close: int) -> int:
    if bar_close <= first_fill:
        return 0
    first = (first_fill // _BAR_NS + 1) * _BAR_NS
    if bar_close < first:
        return 0
    return ((bar_close - first) // _BAR_NS) + 1


def _full_bar(observation: S03SignalObservation | None, flat_ns: int) -> bool:
    return observation is not None and observation.bar_close_ns - _BAR_NS >= flat_ns


def _target(reasons: list[str] | tuple[str, ...], in_position: bool) -> str | None:
    if not in_position:
        return None
    found = set(reasons)
    if found & _C_REASONS:
        return "C"
    if found & _B_REASONS:
        return "B"
    return None


def _add(reasons: list[str], code: str) -> None:
    if code not in reasons:
        reasons.append(code)


def _with(reasons: tuple[str, ...], code: str) -> tuple[str, ...]:
    return reasons if code in reasons else reasons + (code,)


def _drop(reasons: tuple[str, ...], code: str) -> tuple[str, ...]:
    return tuple(reason for reason in reasons if reason != code)


def s03_trade_terms(
    plan: S03BridgePlan,
    signal: S03MarketSignal,
    snapshot: NativeSnapshot,
    *,
    locked_reserve: str = "0",
) -> tuple[SimulationPolicy, str]:
    """Cap, stop and approved risk for one opportunity. Inventory stays in Q03."""
    plan = S03BridgePlan.model_validate(plan)
    if type(signal) is not S03MarketSignal or type(snapshot) is not NativeSnapshot:
        _reject("S03_SIGNAL_UNTRUSTED")
    if signal.parameters_sha256 != plan.parameters.parameters_sha256:
        _reject("S03_PARAMETERS_MISMATCH")
    tick = Decimal("0.01")
    close = Decimal(signal.close)
    atr = Decimal(str(signal.snapshot.atr))
    cap = _floor_tick(close * Decimal("1.002"), tick)
    stop = _floor_tick(close - Decimal(plan.parameters.stop_atr) * atr, tick)
    if stop <= 0 or cap <= stop:
        _reject("S03_STOP_INVALID")
    ask = Decimal(snapshot.ask)
    if ask > cap:
        _reject("S03_CAP_BELOW_ASK")
    if ask <= stop:
        _reject("S03_STOP_INVALID")
    gross = Decimal(snapshot.quote_total) + Decimal(snapshot.base_total) * Decimal(snapshot.bid)
    tradable = gross - Decimal(locked_reserve)
    if gross <= 0 or tradable <= 0:
        _reject("S03_RISK_BUDGET_EMPTY")
    requested = min(
        gross * Decimal(plan.parameters.risk_fraction),
        tradable * Decimal("0.0025"),
        Decimal("25"),
    )
    nominal = min(gross * Decimal(plan.parameters.notional_fraction), Decimal("1000"))
    if requested <= 0 or nominal <= 0:
        _reject("S03_RISK_BUDGET_EMPTY")
    stress = stop * Decimal("0.998")
    policy = SimulationPolicy(
        cap=text(cap),
        stop=text(stop),
        stress=text(stress),
        nominal_cap=text(nominal),
        max_request_risk=text(requested),
    )
    return policy, text(requested)


def _floor_tick(value: Decimal, tick: Decimal) -> Decimal:
    return (value / tick).to_integral_value(rounding=ROUND_DOWN) * tick


def s03_match_observation(
    plan: S03BridgePlan,
    manifest: S03DataManifest,
    observation: S03SignalObservation,
    *,
    now_ns: int,
    prior_bar_ns: int | None,
) -> S03SignalObservation:
    """Accept only the observation the approved manifest replays for that bar."""
    plan = S03BridgePlan.model_validate(plan)
    manifest = S03DataManifest.model_validate(manifest)
    if type(observation) is not S03SignalObservation or type(now_ns) is not int:
        _reject("S03_OBSERVATION_INVALID")
    if observation.bar_close_ns > now_ns or observation.available_at_ns > now_ns:
        _reject("S03_OBSERVATION_FUTURE")
    latest = max(
        (bar.bar_close_ns for bar in manifest.bars if bar.available_at_ns <= now_ns), default=None
    )
    if (prior_bar_ns is not None and observation.bar_close_ns < prior_bar_ns) or (
        latest is not None and observation.bar_close_ns < latest
    ):
        _reject("S03_BAR_OUT_OF_ORDER")
    matched = next(
        (
            item
            for item in replay_s03_observations(plan, manifest)
            if item.bar_close_ns == observation.bar_close_ns
        ),
        None,
    )
    if matched is None or not _same_observation(matched, observation):
        _reject("S03_OBSERVATION_UNTRUSTED")
    return matched


def _same_observation(left: S03SignalObservation, right: S03SignalObservation) -> bool:
    return (
        left.instrument_id == right.instrument_id
        and left.source_revision == right.source_revision
        and left.seed_close_ns == right.seed_close_ns
        and left.prefix_sha256 == right.prefix_sha256
        and left.bar_close_ns == right.bar_close_ns
        and left.available_at_ns == right.available_at_ns
        and left.close == right.close
        and left.ready == right.ready
        and left.gap_reset == right.gap_reset
        and left.parameters_sha256 == right.parameters_sha256
        and left.snapshot == right.snapshot
    )
