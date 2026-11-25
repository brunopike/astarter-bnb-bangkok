"""Task1 contracts for a closed S03 plan. No order authority."""

import hashlib
from dataclasses import replace
from decimal import Decimal

import pytest
from pydantic import ValidationError

from stark_trading_os.domain.astarter_simulation import (
    NativeSnapshot,
    SimulationPolicy,
    policy_bytes,
)
from stark_trading_os.domain.s03_bridge import (
    S03BridgePlan,
    S03BridgeRejected,
    S03ControlledCase,
    S03DataManifest,
    S03RawBar,
    S03RawNews,
    S03RawQuote,
    local_simulation_case,
    replay_s03_observations,
    s03_bound_source_event_time,
    s03_ema_exit_decision,
    s03_indicator_trust,
    s03_manifest_sha256,
    s03_review_input_sha256,
    validate_s03_plan,
    validate_s03_signal,
)
from stark_trading_os.domain.s03_signal import (
    S03IndicatorSnapshot,
    S03MarketSignal,
    S03Parameters,
    evaluate_s03_market,
    s03_signal_id,
)
from stark_trading_os.runner.s03_indicators import S03SignalObservation

START = 1_700_000_000_000_000_000
DAY = 86_400_000_000_000
SEED = 1_500_000_000_000_000_000
REVISION = "ab" * 32
PREFIX = "cd" * 32
POLICY_CANONICAL = (
    b'{"account_multiplier":"1","cap":"60120","caps":["25","500","200","100","50","60","50"],'
    b'"fee":"0.001","identity":"ASTARTER_BTC_NATIVE_SIM_V1","lock_fraction":"0.2",'
    b'"max_request_risk":"25","nominal_cap":"1000","protection_timeout_ns":1000000000,'
    b'"quote_unit":"0.00000001","snapshot_ttl_ns":5000000000,"stage":"1","step":"0.00001",'
    b'"stop":"59000","stress":"58882"}'
)
POLICY_SHA256 = hashlib.sha256(POLICY_CANONICAL).hexdigest()
PARAMETERS = S03Parameters(
    ema_fast=10,
    ema_slow=30,
    rsi_cross="48",
    rsi_ceiling="62",
    rsi_fail="42",
    stop_atr="1.5",
    risk_fraction="0.003",
    notional_fraction="0.1",
    hold_boundaries=24,
    cooldown_full_bars=4,
)


def make_quote(**updates: object) -> S03RawQuote:
    payload: dict[str, object] = dict(
        source_sequence=100,
        source_event_time_ns=START,
        received_time_ns=START,
        bid="59999",
        ask="60000",
        bid_size="10",
        ask_size="10",
    )
    payload.update(updates)
    return S03RawQuote(**payload)  # type: ignore[arg-type]


def make_manifest(
    quotes: tuple[S03RawQuote, ...] | None = None,
    **updates: object,
) -> S03DataManifest:
    payload: dict[str, object] = dict(
        case_id="S03_SYNTHETIC_BTC_V1",
        source_revision=REVISION,
        seed_close_ns=SEED,
        quotes=quotes if quotes is not None else (make_quote(),),
    )
    payload.update(updates)
    return S03DataManifest(**payload)  # type: ignore[arg-type]


def make_plan(
    quotes: tuple[S03RawQuote, ...] | None = None,
    *,
    parameters: S03Parameters = PARAMETERS,
    drop_role: str | None = None,
    block_role: str | None = None,
    account_id: str = "SIM-001",
    review_account: str | None = None,
    manifest: S03DataManifest | None = None,
) -> tuple[S03BridgePlan, S03DataManifest, S03ControlledCase]:
    bound = manifest if manifest is not None else make_manifest(quotes)
    case = local_simulation_case()
    # Bar fixtures execute in their original historical clock, not START's quote clock.
    starts_at = bound.seed_close_ns if bound.bars else START
    plan = case.issue(
        parameters=parameters,
        manifest=bound,
        account_id=account_id,
        group_id="private-sim",
        starts_at_ns=starts_at,
        expires_at_ns=starts_at + DAY,
        block_role=block_role,
    )
    if drop_role is not None:
        duties = tuple(duty for duty in plan.review.duties if duty.role != drop_role)
        plan = plan.model_copy(update={"review": plan.review.model_copy(update={"duties": duties})})
    if review_account is not None:
        plan = plan.model_copy(
            update={"review": plan.review.model_copy(update={"account_id": review_account})}
        )
    return plan, bound, case


def market_plan(parameters: S03Parameters, bars: tuple[S03RawBar, ...]):
    """Freeze the finite native quote/news schedule before creating any Control run."""
    preview, raw, _ = make_plan(parameters=parameters, manifest=make_manifest(quotes=(), bars=bars))
    observation = next(x for x in replay_s03_observations(preview, raw) if x.signal)
    when = observation.signal.bar_close_ns + 1_000_000_000
    points = {
        (when, "59999", "60000", "10", "10"),
        (when + 500_000, "1253", "1254", "10", "10"),
        (when + 1_000_000, "1253", "1254", "10", "10"),
        (when + 1_000_000_000, "1253", "1254", "10", "10"),
        (when + 1_001_000_000, "1253", "1254", "10", "10"),
        (when + 2_000_000_000, "1253", "1254", "10", "10"),
    }
    points.update(
        (bar.available_at_ns, "1253", "1254", "10", "10")
        for bar in bars
        if bar.available_at_ns > when
    )
    low = [
        x
        for x in replay_s03_observations(preview, raw)
        if x.ready
        and not x.gap_reset
        and x.snapshot.rsi < 30
        and x.bar_close_ns > when + 1_000_000_000
    ]
    if len(low) >= 2:
        arm = low[1].available_at_ns
        # Exact claim/retry and cancel-book points used by the finite native fixture.
        points.update(
            (arm + offset, "1253", "1254", "10", "10")
            for offset in (0, 249_000_000, 250_000_000, 500_000_000, 502_000_000, 750_000_000)
        )
        points.update(
            (arm + offset + 1_000_000, "1253", "1254", "0.00001", "0.00001")
            for offset in (0, 250_000_000, 500_000_000)
        )
    quotes = tuple(
        make_quote(
            source_sequence=100 + index,
            source_event_time_ns=at,
            received_time_ns=at,
            bid=bid,
            ask=ask,
            bid_size=bid_size,
            ask_size=ask_size,
        )
        for index, (at, bid, ask, bid_size, ask_size) in enumerate(sorted(points))
    )
    news = (
        S03RawNews(
            source_sequence=1,
            previous_sequence=0,
            source_event_time_ns=when,
            received_time_ns=when,
            available_at_ns=when,
            status="HEALTHY",
        ),
    )
    plan, manifest, case = make_plan(
        parameters=parameters, manifest=make_manifest(quotes=quotes, bars=bars, news=news)
    )
    observation = next(x for x in replay_s03_observations(plan, manifest) if x.signal)
    return plan, manifest, case, observation.signal, observation


def _reject(plan: S03BridgePlan, manifest: S03DataManifest) -> str:
    with pytest.raises(S03BridgeRejected) as caught:
        validate_s03_plan(plan, manifest)
    return caught.value.code


def test_existing_simulation_policy_canonical_bytes_stay_fixed() -> None:
    raw = policy_bytes(SimulationPolicy())
    assert raw == POLICY_CANONICAL
    assert b"source_event_time_ns" not in raw
    assert b"S03" not in raw


def test_valid_plan_is_simulated_and_not_execution_authority() -> None:
    plan, manifest, case = make_plan()
    validate_s03_plan(plan, manifest, case)
    assert plan.scope == "FINITE_S03_NATIVE_SIMULATION"
    assert plan.real_trading_connected is False
    assert plan.execution_authorized is False
    assert plan.review.label == "SIMULATED_REVIEW"
    assert plan.overlay.fee == "0.001" and plan.overlay.tick == "0.01"
    assert plan.overlay.internal_min_notional == "5"
    assert plan.bar_execution is False
    assert plan.s03_instrument_id == "BTCUSDT.SIM"
    assert plan.native_instrument_id == "BTC/USDT.SIM"


def test_missing_review_role_is_rejected() -> None:
    plan, manifest, _case = make_plan(drop_role="A13")
    assert _reject(plan, manifest) == "S03_REVIEW_ROLE_MISSING"


def test_counterevidence_block_is_rejected() -> None:
    plan, manifest, _case = make_plan(block_role="A10")
    assert _reject(plan, manifest) == "S03_REVIEW_BLOCKED"


def test_changed_account_is_rejected() -> None:
    plan, manifest, case = make_plan()
    swapped = plan.model_copy(
        update={
            "account_id": "SIM-002",
            "review": plan.review.model_copy(update={"account_id": "SIM-002"}),
        }
    )
    assert _reject(swapped, manifest) == "S03_ACCOUNT_MISMATCH"
    mismatched = plan.model_copy(
        update={"review": plan.review.model_copy(update={"account_id": "SIM-009"})}
    )
    assert _reject(mismatched, manifest) == "S03_ACCOUNT_MISMATCH"


def test_changed_parameters_are_rejected() -> None:
    plan, manifest, case = make_plan()
    changed = plan.model_copy(update={"parameters": S03Parameters()})
    assert changed.parameters_sha256 == PARAMETERS.parameters_sha256
    assert _reject(changed, manifest) == "S03_PARAMETERS_MISMATCH"


def test_changed_manifest_is_rejected_and_not_silently_rehashed() -> None:
    plan, manifest, case = make_plan()
    altered = manifest.model_copy(update={"quotes": (make_quote(bid="59000"),)})
    assert s03_manifest_sha256(altered) != plan.manifest_sha256
    assert _reject(plan, altered) == "S03_MANIFEST_MISMATCH"


def _stream_prices() -> list[float]:
    prices: list[float] = []
    level = 1000.0
    for _ in range(260):
        level += 1.0
        prices.append(round(level, 2))
    for _ in range(22):
        level -= 0.4
        prices.append(round(level, 2))
    for _ in range(8):
        level += 2.0
        prices.append(round(level, 2))
    return prices


def _stream_case() -> tuple[
    S03BridgePlan, S03DataManifest, S03ControlledCase, S03MarketSignal, S03SignalObservation
]:
    parameters = S03Parameters(
        ema_fast=10,
        ema_slow=30,
        rsi_cross="40",
        rsi_ceiling="75",
        rsi_fail="30",
        volatility_max="0.05",
    )
    bars = tuple(
        S03RawBar(
            open=f"{price:.2f}",
            high=f"{price + 5:.2f}",
            low=f"{price - 5:.2f}",
            close=f"{price:.2f}",
            volume="1",
            bar_close_ns=SEED + index * 300_000_000_000,
            ts_init_ns=SEED + index * 300_000_000_000,
            available_at_ns=SEED + index * 300_000_000_000 + 1,
        )
        for index, price in enumerate(_stream_prices())
    )
    plan, manifest, case, signal, observation = market_plan(parameters, bars)
    assert signal is not None
    validate_s03_signal(plan, signal, observation, manifest)
    return plan, manifest, case, signal, observation


def _signal_pair() -> tuple[S03BridgePlan, S03MarketSignal, S03SignalObservation]:
    plan, _manifest, _case, signal, observation = _stream_case()
    return plan, signal, observation


def test_forged_signal_id_or_market_match_is_rejected() -> None:
    plan, signal, observation = _signal_pair()
    with pytest.raises(S03BridgeRejected) as forged_id:
        validate_s03_signal(plan, replace(signal, signal_id="0" * 64), observation)
    assert forged_id.value.code == "S03_SIGNAL_FORGED"
    flipped = replace(signal.facts, market_match=not signal.facts.market_match)
    with pytest.raises(S03BridgeRejected) as forged_facts:
        validate_s03_signal(plan, replace(signal, facts=flipped), observation)
    assert forged_facts.value.code == "S03_SIGNAL_FORGED"


def _observation(
    snapshot: S03IndicatorSnapshot,
    *,
    ready: bool,
    gap_reset: bool,
    facts: object | None = None,
) -> S03SignalObservation:
    resolved = facts if facts is not None else evaluate_s03_market(snapshot, PARAMETERS)
    return S03SignalObservation(
        parameters_sha256=PARAMETERS.parameters_sha256,
        instrument_id="BTCUSDT.SIM",
        source_revision=REVISION,
        seed_close_ns=SEED,
        segment_seed_close_ns=SEED,
        prefix_sha256=PREFIX,
        bar_close_ns=SEED,
        available_at_ns=SEED + 1,
        expires_at_ns=SEED + 5_000_000_000,
        close="1",
        continuous_bars=1,
        ready=ready,
        gap_reset=gap_reset,
        expired=False,
        snapshot=snapshot,
        facts=resolved,  # type: ignore[arg-type]
        signal=None,
    )


def test_unready_or_gap_indicators_stay_unknown_and_ema_equality_does_not_force_exit() -> None:
    equal = S03IndicatorSnapshot(
        ema_fast=1.0, ema_slow=1.0, close=1.0, atr=0.01, rsi=50.0, previous_rsi=49.0
    )
    assert evaluate_s03_market(equal, PARAMETERS).trend_invalid is True
    for ready, gap in ((False, False), (False, True), (True, True)):
        trust = s03_indicator_trust(_observation(equal, ready=ready, gap_reset=gap), PARAMETERS)
        assert trust.data_status == "UNKNOWN"
        assert trust.trend_invalid == "UNKNOWN"
        assert trust.trend_up == "UNKNOWN"
        assert trust.market_match == "UNKNOWN"
        assert trust.momentum_below_fail == "UNKNOWN"
        assert s03_ema_exit_decision(trust) == "PAUSE_NEW_RISK"
    lying = replace(evaluate_s03_market(equal, PARAMETERS), trend_invalid=False)
    trusted = s03_indicator_trust(
        _observation(equal, ready=True, gap_reset=False, facts=lying), PARAMETERS
    )
    assert trusted.trend_invalid == "TRUE"
    assert s03_ema_exit_decision(trusted) == "FORCED_EXIT"
    separated = S03IndicatorSnapshot(
        ema_fast=3.0, ema_slow=2.0, close=4.0, atr=0.02, rsi=40.0, previous_rsi=40.0
    )
    clear = s03_indicator_trust(_observation(separated, ready=True, gap_reset=False), PARAMETERS)
    assert clear.trend_invalid == "FALSE"
    assert s03_ema_exit_decision(clear) == "NO_EMA_EXIT"


def test_missing_source_event_time_is_not_treated_as_fresh() -> None:
    snapshot = NativeSnapshot(
        "SIM-001",
        "session",
        1,
        10,
        10,
        "60000",
        "60001",
        "10000",
        "10000",
        "0",
        "0",
        "0",
        (),
        (),
        True,
    )
    with pytest.raises(S03BridgeRejected) as missing:
        s03_bound_source_event_time(snapshot)
    assert missing.value.code == "S03_SOURCE_EVENT_TIME_MISSING"
    bound = replace(snapshot, source_event_time_ns=7)
    assert s03_bound_source_event_time(bound) == 7
    assert bound.quote_time_ns == 10 and bound.sequence == 1


def test_plan_rejects_unknown_fields() -> None:
    plan, _manifest, _case = make_plan()
    with pytest.raises(ValidationError):
        S03BridgePlan(**(plan.model_dump() | {"execution_authorized": True}))


def test_r1_stream_replay_signal_is_accepted() -> None:
    _plan, _manifest, _case, signal, observation = _stream_case()
    assert signal.facts.market_match is True
    assert observation.ready is True
    assert observation.continuous_bars >= 250
    assert signal.expires_at_ns - signal.bar_close_ns == 5_000_000_000
    assert signal.seed_close_ns == _plan.seed_close_ns
    assert observation.gap_reset is False


def test_r1_self_consistent_forged_signal_is_rejected() -> None:
    """A mutually consistent signal is not evidence. Zero warmup, a foreign seed,
    an invented prefix and a 500s expiry must still be rejected."""
    plan, _manifest, _case = make_plan()
    snapshot = S03IndicatorSnapshot(
        ema_fast=3.0, ema_slow=2.0, close=4.0, atr=0.02, rsi=49.0, previous_rsi=47.0
    )
    facts = evaluate_s03_market(snapshot, plan.parameters)
    close = plan.seed_close_ns + 300_000_000_000
    signal = S03MarketSignal(
        signal_id=s03_signal_id(plan.parameters_sha256, "BTCUSDT.SIM", close),
        parameters_sha256=plan.parameters_sha256,
        instrument_id="BTCUSDT.SIM",
        source_revision=plan.source_revision,
        seed_close_ns=close,
        segment_seed_close_ns=close,
        prefix_sha256="ef" * 32,
        bar_close_ns=close,
        available_at_ns=close + 1,
        expires_at_ns=close + 500_000_000_000,
        close="4",
        snapshot=snapshot,
        facts=facts,
    )
    observation = S03SignalObservation(
        parameters_sha256=signal.parameters_sha256,
        instrument_id=signal.instrument_id,
        source_revision=signal.source_revision,
        seed_close_ns=signal.seed_close_ns,
        segment_seed_close_ns=signal.segment_seed_close_ns,
        prefix_sha256=signal.prefix_sha256,
        bar_close_ns=signal.bar_close_ns,
        available_at_ns=signal.available_at_ns,
        expires_at_ns=signal.expires_at_ns,
        close=signal.close,
        continuous_bars=0,
        ready=True,
        gap_reset=False,
        expired=False,
        snapshot=snapshot,
        facts=facts,
        signal=signal,
    )
    assert facts.market_match is True
    assert observation.seed_close_ns != plan.seed_close_ns
    with pytest.raises(S03BridgeRejected) as caught:
        validate_s03_signal(plan, signal, observation)
    assert caught.value.code == "S03_SIGNAL_UNTRUSTED"


def test_r2_replaced_review_input_hashes_are_rejected() -> None:
    plan, manifest, case = make_plan()
    duties = tuple(
        duty.model_copy(update={"input_sha256": "ff" * 32}) for duty in plan.review.duties
    )
    forged = plan.model_copy(update={"review": plan.review.model_copy(update={"duties": duties})})
    with pytest.raises(S03BridgeRejected) as caught:
        validate_s03_plan(forged, manifest)
    assert caught.value.code == "S03_REVIEW_INPUT_UNBOUND"


def test_r2_recomputed_hashes_without_issuer_are_rejected() -> None:
    plan, manifest, case = make_plan()
    duties = tuple(
        duty.model_copy(
            update={
                "input_sha256": s03_review_input_sha256(
                    duty.role,
                    parameters_sha256=plan.parameters_sha256,
                    manifest_sha256=plan.manifest_sha256,
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
                )
            }
        )
        for duty in plan.review.duties
    )
    review = plan.review.model_copy(update={"duties": duties, "seal": "ab" * 32})
    forged = plan.model_copy(update={"review": review})
    with pytest.raises(S03BridgeRejected) as caught:
        validate_s03_plan(forged, manifest, case)
    assert caught.value.code == "S03_REVIEW_UNISSUED"


def test_r2_caller_built_consistent_review_is_rejected() -> None:
    plan, manifest, _case = make_plan()
    digest_hex = hashlib.sha256(plan.manifest_sha256.encode()).hexdigest()
    duties = tuple(
        duty.model_copy(update={"input_sha256": digest_hex, "result": "PASS"})
        for duty in plan.review.duties
    )
    forged = plan.model_copy(update={"review": plan.review.model_copy(update={"duties": duties})})
    with pytest.raises(S03BridgeRejected) as caught:
        validate_s03_plan(forged, manifest)
    assert caught.value.code in {"S03_REVIEW_INPUT_UNBOUND", "S03_REVIEW_UNISSUED"}


def test_g1_replay_of_unapproved_manifest_is_rejected() -> None:
    plan, approved, _case, original, _obs = _stream_case()
    doubled = tuple(
        raw.model_copy(
            update={
                key: format(Decimal(getattr(raw, key)) * 2, "f")
                for key in ("open", "high", "low", "close")
            }
        )
        for raw in approved.bars
    )
    volume = tuple(raw.model_copy(update={"volume": "2"}) for raw in approved.bars)
    for bars in (doubled, volume):
        foreign = approved.model_copy(update={"bars": bars})
        assert s03_manifest_sha256(foreign) != plan.manifest_sha256
        replayed = replay_s03_observations(plan, foreign)
        observation = next(item for item in replayed if item.signal is not None)
        signal = observation.signal
        assert signal is not None
        assert signal.signal_id == original.signal_id
        assert signal.seed_close_ns == plan.seed_close_ns
        with pytest.raises(S03BridgeRejected) as caught:
            validate_s03_signal(plan, signal, observation, foreign)
        assert caught.value.code == "S03_MANIFEST_MISMATCH"


def test_g2_same_seal_cannot_retarget_the_run_window() -> None:
    _plan, manifest, case = make_plan()
    short = case.issue(
        parameters=_plan.parameters,
        manifest=manifest,
        account_id=_plan.account_id,
        group_id=_plan.group_id,
        starts_at_ns=START,
        expires_at_ns=START + 1_000_000_000,
    )
    validate_s03_plan(short, manifest, case)
    hour = 3_600_000_000_000
    moved = (
        {"expires_at_ns": START + DAY},
        {"starts_at_ns": START - hour, "expires_at_ns": START + 1_000_000_000},
        {"starts_at_ns": START + hour, "expires_at_ns": START + hour + 1_000_000_000},
        {"expires_at_ns": START + 2_000_000_000},
    )
    for changes in moved:
        shifted = short.model_copy(update=changes)
        assert shifted.review.seal == short.review.seal
        with pytest.raises(S03BridgeRejected) as caught:
            validate_s03_plan(shifted, manifest, case)
        assert caught.value.code == "S03_RUN_WINDOW_UNBOUND"
    reissued = case.issue(
        parameters=short.parameters,
        manifest=manifest,
        account_id=short.account_id,
        group_id=short.group_id,
        starts_at_ns=START + hour,
        expires_at_ns=START + hour + 1_000_000_000,
    )
    validate_s03_plan(reissued, manifest, case)
