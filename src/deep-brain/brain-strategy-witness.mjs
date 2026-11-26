// Independent specification for forward paper choices under daily-spot-proof-v1.
// A rule change requires versioning both implementations before it can be admitted.
import {createHash} from 'node:crypto';

const VERSION = 'daily-strategy-witness-v1';
const DAY = 86400;
const LOOKBACK = 30;
const SESSIONS = 60;
const WINDOW = 91;
const STRATEGIES = ['trend', 'breakout', 'pullback'];
const CAPITAL = 10000;
const FEE = 0.001;
const SLIP = 0.0005;
const RISK_VERSION = 'astarter-research-v0.1/sim-2';
const percent = value => value * 100;
const iso = seconds => new Date(seconds * 1000).toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sum = values => values.reduce((total, value) => total + value, 0);
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function assertThat(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), {reason});
}

function frozenBars(intent, archive) {
  const {id, ...body} = intent;
  assertThat(intent.version === 'daily-spot-proof-v1' && intent.mode === 'forward_paper', 'unsupported_intent');
  assertThat(digest(body) === id, 'intent_digest_mismatch');
  const assets = archive.assets.filter(item => item.key === intent.assetKey);
  assertThat(assets.length === 1, 'instrument_mismatch');
  const [asset] = assets;
  const fields = ['key', 'symbol', 'venue', 'market', 'quote', 'sourceUrl'];
  assertThat(fields.every(field => asset[field] === intent.asset[field]) &&
    intent.quote === asset.quote && intent.market === asset.market, 'instrument_mismatch');
  const bars = asset.bars.slice(-WINDOW);
  assertThat(bars.length === WINDOW && intent.barCount === WINDOW, 'window_mismatch');
  const end = bars.at(-1)[0] + DAY;
  const observed = Date.parse(intent.observedAt) / 1000;
  const retrieved = Date.parse(archive.updatedAt ?? archive.retrievedAt) / 1000;
  assertThat(end <= retrieved && retrieved <= observed && observed < end + DAY &&
    intent.scheduledOpenAt === iso(end + DAY) && intent.barOpenAt === intent.scheduledOpenAt &&
    intent.asOf === new Date(end * 1000 - 1).toISOString() &&
    intent.evidenceStartAt === iso(bars[0][0]), 'window_clock_mismatch');
  for (const [i, bar] of bars.entries()) {
    assertThat(Array.isArray(bar) && bar.length === 6 && bar.every(Number.isFinite), 'invalid_candle');
    const [openAt, open, high, low, close, volume] = bar;
    assertThat(openAt > 0 && openAt % DAY === 0 && openAt === end - (WINDOW - i) * DAY &&
      low > 0 && volume > 0 && low <= Math.min(open, close) && high >= Math.max(open, close), 'invalid_candle');
  }
  assertThat(digest([asset.key, asset.market, asset.venue, asset.quote, bars]) === intent.snapshotId, 'snapshot_mismatch');
  return bars;
}

// end is exclusive. For calibration at index t, t−1 is the registration day
// and the last price known when giving the instruction belongs to t−2.
function observe(bars, end) {
  const closes = bars.slice(end - LOOKBACK, end).map(bar => bar[4]);
  const close = closes.at(-1), previousClose = closes.at(-2);
  const average10 = sum(closes.slice(-10)) / 10, average30 = sum(closes) / LOOKBACK;
  const priorHigh = Math.max(...bars.slice(end - 11, end - 1).map(bar => bar[2]));
  const trueRanges = [];
  for (let i = end - 14; i < end; i++) {
    const [, , high, low] = bars[i], previous = bars[i - 1][4];
    trueRanges.push(Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous)));
  }
  const atrPct = sum(trueRanges) / 14 / close;
  const stopFraction = clamp(1.5 * atrPct, 0.01, 0.10);
  const downFromMean = (close - average10) / average10;
  const conditions = [
    ['trend', 'average10', average10, '>', 'average30', average30],
    ['trend', 'close', close, '>', 'average10', average10],
    ['breakout', 'close', close, '>', 'priorHigh', priorHigh],
    ['pullback', 'downFromMean', downFromMean, '<', 'negativeHalfATR', -atrPct / 2],
    ['pullback', 'close', close, '>', 'previousClose', previousClose],
  ].map(([candidate, metric, actual, operator, reference, threshold]) => ({
    candidate, metric, actual, operator, reference, threshold, met: operator === '>' ? actual > threshold : actual < threshold,
  }));
  const signal = Object.fromEntries(STRATEGIES.map(id => [id, conditions.filter(c => c.candidate === id).every(c => c.met)]));
  return {close, average10, average30, priorHigh, atrPct, downFromMean, stopFraction, signal, conditions};
}

function session(bars, index) {
  const observation = observe(bars, index - 1);
  const [at, open, , low, close] = bars[index];
  const gap = Math.abs(open / observation.close - 1) > clamp(2 * observation.atrPct, 0.02, 0.08);
  const stop = open * (1 - observation.stopFraction);
  const stopped = low <= stop;
  const units = 1 / (open * (1 + SLIP));
  const exitReference = stopped ? stop : close;
  const gross = exitReference / open - 1;
  const proceeds = units * (exitReference * (1 - SLIP));
  const net = proceeds - 1 - (1 + proceeds) * FEE;
  assertThat(Number.isFinite(net), 'nonfinite_sample');
  return {signal: observation.signal, gap, gross, net, exit: stopped ? 'stop_loss' : 'session_close', at,
    signalAsOf: new Date((at - DAY) * 1000 - 1).toISOString()};
}

function evaluateCandidates(now, history) {
  const candidates = STRATEGIES.map(id => {
    const active = history.filter(row => row.signal[id]);
    const fills = active.filter(row => !row.gap);
    const sumNegativeSquares = sum(fills.map(row => Math.min(0, row.net) ** 2));
    const mean = sum(fills.map(row => row.net)) / history.length;
    const meanGross = sum(fills.map(row => row.gross)) / history.length;
    const penalty = 0.5 * Math.sqrt(sumNegativeSquares / history.length) / Math.sqrt(history.length);
    const score = percent(mean - penalty);
    const reason = !now.signal[id] ? 'signal_absent' : fills.length < 3 ? 'small_sample'
      : score <= 0 ? 'nonpositive_score' : 'qualified';
    const worst = fills.reduce((worst, fill) => !worst || fill.net < worst.net ? fill : worst, null);
    return {id, signal: now.signal[id], eligible: reason === 'qualified', reason, score,
      sampleCount: fills.length, meanGrossReturnPct: percent(meanGross), executionCostDragPct: percent(meanGross - mean),
      meanNetReturnPct: percent(mean), downsidePenaltyPct: percent(penalty),
      gapVetoes: active.length - fills.length, lossSessions: fills.filter(row => row.net < 0).length,
      worstSample: worst && {openAt: iso(worst.at), signalAsOf: worst.signalAsOf, netReturnPct: percent(worst.net), exitReason: worst.exit}};
  });
  candidates.push({id: 'cash', signal: true, eligible: true, reason: 'cash_baseline', score: 0,
    sampleCount: history.length, meanGrossReturnPct: 0, executionCostDragPct: 0, meanNetReturnPct: 0, downsidePenaltyPct: 0, gapVetoes: 0, lossSessions: 0, worstSample: null});
  return candidates;
}

// These exact versioned ceilings are the rules being audited. Only a fresh,
// flat, independently funded forward paper sleeve is covered by this witness.
function riskWitness(intent, now, selected) {
  const r = intent.risk;
  assertThat(intent.equityBefore === CAPITAL && intent.previousReceiptId === null && intent.previousReceiptAt === null &&
    r.priorHigh === CAPITAL && r.reserve === 0 && r.locked === null && r.policyVersion === RISK_VERSION, 'risk_basis_mismatch');
  const selectedMode = now.atrPct >= 0.035 ? 'conservative' : 'normal';
  const stopped = now.atrPct > 0.10;
  const effectiveProfile = stopped ? 'halt' : selectedMode;
  const riskModeReason = selectedMode === 'conservative' ? 'elevated_volatility' : 'standard_volatility';
  const profiles = ['normal', 'conservative', 'halt'].map(mode => {
    const limits = {episode: mode === 'normal' ? 25 : 12.5, portfolio: 100, asset: 50, group: 60, event: 50, epoch: 500};
    const riskBudget = mode === 'halt' ? 0 : Math.min(...Object.values(limits));
    const lossFraction = now.stopFraction + 2 * (FEE + SLIP);
    const capacity = Math.floor(Math.min(CAPITAL * 0.10, CAPITAL / (1 + FEE), riskBudget / lossFraction) * 100) / 100;
    const maxNotional = capacity < 5 || selected === 'cash' ? 0 : capacity;
    const reason = mode === 'halt' ? 'volatility_limit' : mode === 'conservative' ? 'elevated_volatility' : 'standard_volatility';
    return {mode, applies: mode === effectiveProfile, maxNotional, riskBudget, reason, capacity, limits};
  });
  // The registered riskBudget is the sizing budget before a cash or volatility veto.
  const sized = profiles.find(profile => profile.mode === selectedMode);
  const maxNotional = stopped ? 0 : sized.maxNotional;
  const action = selected === 'cash' ? 'wait' : stopped || !maxNotional ? 'pause' : 'reduce';
  const reason = selected === 'cash' ? 'cash_selected' : stopped ? 'volatility_limit' : !maxNotional ? 'budget' : 'within_limits';
  assertThat(r.mode === selectedMode && r.modeReason === riskModeReason && r.action === action && r.reason === reason &&
    r.amount === maxNotional && r.riskBudget === sized.riskBudget && r.stopFraction === now.stopFraction &&
    r.openGapLimit === clamp(2 * now.atrPct, 0.02, 0.08) &&
    Object.keys(r.limits).length === Object.keys(sized.limits).length &&
    Object.entries(sized.limits).every(([key, value]) => r.limits[key] === value), 'risk_sizing_mismatch');
  return {selectedMode, effectiveProfile, action, reason, maxNotional, riskBudget: sized.riskBudget, profiles};
}

// Sort in registry order on score ties, exactly as the registration rule does.
function ranked(candidates) {
  return candidates.filter(row => row.eligible).sort((a, b) => b.score - a.score);
}

// Omit one scored outcome, preserving every other day's observed signal and costs.
// This measures the decision's dependence on the calibration sample, not a probability.
function calibrationSensitivity(now, history, selected) {
  let retained = 0;
  const switches = new Map();
  for (const [index, omitted] of history.entries()) {
    const candidates = evaluateCandidates(now, history.filter((_, i) => i !== index));
    const [winner] = ranked(candidates);
    if (winner.id === selected) {
      retained++;
      continue;
    }
    let change = switches.get(winner.id);
    if (!change) {
      const describe = ({score, reason, sampleCount}) => ({score, reason, sampleCount});
      change = {to:winner.id, count:0, example:{omittedDate:iso(omitted.at).slice(0,10),
        originalAfter:describe(candidates.find(row => row.id === selected)), alternativeAfter:describe(winner)}};
      switches.set(winner.id, change);
    }
    change.count++;
  }
  return {method:'leave_one_calibration_session_out', omissions:history.length, retained, switches:[...switches.values()]};
}

export function inspectStrategyWitness(intent, archive, {includeSensitivity = false} = {}) {
  try {
    const bars = frozenBars(intent, archive);
    const a = intent.assumptions;
    assertThat(a.initialCapital === CAPITAL && a.feeBps === 10 && a.slippageBps === 5 && a.featureBars === LOOKBACK &&
      a.calibrationBars === SESSIONS && a.minSignals === 3 && a.registrationDays === 1 && a.intervalSeconds === DAY &&
      a.positionType === 'long_only_spot' && a.exit === 'stop_or_same_session_close' && a.riskVersion === RISK_VERSION &&
      a.entry === 'scheduled_utc_open' && a.selection === 'highest_positive_downside_adjusted_mean_session_return', 'assumptions_mismatch');
    const now = observe(bars, WINDOW);
    const {conditions, signal, ...measures} = now;
    assertThat(Object.entries(measures).every(([key, value]) => Number.isFinite(value) && intent.features[key] === value) &&
      STRATEGIES.every(id => signal[id] === intent.features.signal[id]), 'signal_mismatch');
    const history = Array.from({length: SESSIONS}, (_, i) => session(bars, WINDOW - SESSIONS + i));
    const candidates = evaluateCandidates(now, history);
    const facts = ['id', 'signal', 'eligible', 'reason', 'score', 'sampleCount'];
    assertThat(intent.candidates.length === candidates.length && candidates.every((c, i) =>
      Number.isFinite(c.score) && facts.every(key => intent.candidates[i][key] === c[key])), 'score_mismatch');
    const eligible = ranked(candidates);
    const [winner, runnerUp] = eligible;
    const reason = winner.id === 'cash' ? 'no_candidate_beats_cash' : 'highest_eligible_score';
    assertThat(intent.selected === winner.id && intent.reason === reason, 'selection_mismatch');
    const risk = riskWitness(intent, now, winner.id);
    const selection = {selected: winner.id, runnerUp: runnerUp?.id ?? null,
      marginPct: runnerUp ? winner.score - runnerUp.score : null, reason, conditions};
    const calibration = {sessions: SESSIONS, firstOpenAt: iso(history[0].at), lastOpenAt: iso(history.at(-1).at),
      registrationDays: 1, minSignals: 3, feeBps: 10, slippageBps: 5};
    return {version: VERSION, status: 'verified', reason: 'independent_strategy_witness',
      decisionId: intent.id, snapshotId: intent.snapshotId, calibration, candidates, selection, risk,
      ...(includeSensitivity ? {sensitivity:calibrationSensitivity(now, history, winner.id)} : {})};
  } catch (error) {
    return {version: VERSION, status: 'blocked', reason: error.reason ?? 'malformed_witness_input',
      decisionId: null, snapshotId: null, calibration: null, candidates: [], selection: null, risk: null};
  }
}
