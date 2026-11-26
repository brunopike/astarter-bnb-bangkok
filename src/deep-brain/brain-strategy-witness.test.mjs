import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import archive from './brain-evidence/daily-markets.json' with {type:'json'};
import {buildForwardIntent} from './brain-proof-engine.mjs';
import {inspectStrategyWitness} from './brain-strategy-witness.mjs';

const DAY = 86400;
const bitcoin = archive.assets.find(asset => asset.key === 'coin:bitcoin');
const hash = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');

function frame(bars) {
  const observedAt = new Date((bars.at(-1)[0] + DAY + 60) * 1000).toISOString();
  const market = {retrievedAt:observedAt, assets:[{...bitcoin, bars}]};
  const intent = buildForwardIntent(market, {observedAt, assetKey:bitcoin.key});
  return {market, intent};
}

function historical(date) {
  const cutoff = Date.parse(date) / 1000;
  return frame(bitcoin.bars.filter(row => row[0] + DAY <= cutoff).slice(-91));
}

function rising(wick) {
  const start = Date.parse('2025-01-01T00:00Z') / 1000;
  let price = 100;
  const bars = Array.from({length:91}, (_, i) => {
    const open = price;
    price *= 1.009;
    return [start + i * DAY, open, price * (1 + wick), open * .999, price, 10000];
  });
  return frame(bars);
}

function change(original, edit) {
  const forged = structuredClone(original);
  edit(forged);
  const {id, ...body} = forged;
  forged.id = hash(body);
  return forged;
}

function near(actual, expected, eps = 1e-10) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} near ${expected}`);
}

test('public BTC candles independently witness cash, breakout, pullback and conservative trend selections', () => {
  for (const [date, expected] of [
    ['2024-05-31', 'cash'], ['2024-06-06', 'breakout'], ['2024-06-13', 'pullback'], ['2024-11-14', 'trend'],
  ]) {
    const {intent, market} = historical(date);
    const witness = inspectStrategyWitness(intent, market);
    assert.equal(witness.status, 'verified');
    assert.equal(witness.selection.selected, expected);
    assert.equal(witness.calibration.sessions, 60);
    assert.equal(Date.parse(witness.calibration.lastOpenAt) - Date.parse(witness.calibration.firstOpenAt), 59 * DAY * 1000);
    assert.equal(witness.decisionId, intent.id);
    for (const candidate of witness.candidates) {
      near(candidate.meanGrossReturnPct - candidate.executionCostDragPct, candidate.meanNetReturnPct);
      near(candidate.meanNetReturnPct - candidate.downsidePenaltyPct, candidate.score);
      assert.ok(candidate.sampleCount + candidate.gapVetoes <= 60);
    }
  }
});

test('the historic breakout decision exposes losses and a downside penalty despite ranking first', () => {
  const {intent, market} = historical('2024-06-06');
  const witness = inspectStrategyWitness(intent, market);
  const picked = witness.candidates.find(row => row.id === 'breakout');
  assert.equal(picked.sampleCount, 4);
  assert.equal(picked.lossSessions, 2);
  assert.equal(picked.worstSample.openAt, '2024-05-22T00:00:00.000Z');
  assert.equal(picked.worstSample.signalAsOf, '2024-05-20T23:59:59.999Z');
  near(picked.worstSample.netReturnPct, -1.6965446109);
  near(picked.meanNetReturnPct, .0221273764);
  near(picked.downsidePenaltyPct, .0175913708);
  assert.ok(picked.executionCostDragPct > 0);
  assert.equal(witness.risk.maxNotional, 544.03);
  assert.equal(witness.selection.conditions.find(c => c.candidate === 'breakout').met, true);
});

test('unconditional 60-day scores account for a skipped gap and a calibrated stop loss', () => {
  const {intent, market} = historical('2024-11-14');
  const witness = inspectStrategyWitness(intent, market);
  const trend = witness.candidates.find(c => c.id === 'trend');
  assert.equal(trend.sampleCount, 31);
  assert.equal(trend.gapVetoes, 1);
  assert.equal(trend.lossSessions, 18);
  assert.equal(trend.worstSample.exitReason, 'stop_loss');
  near(trend.score, .0244871528);
  assert.equal(witness.risk.selectedMode, 'conservative');
  assert.equal(witness.risk.maxNotional, 189.48);
  assert.equal(witness.risk.profiles.find(p => p.mode === 'normal').applies, false);
  assert.equal(witness.risk.profiles.find(p => p.mode === 'conservative').riskBudget, 12.5);
});

test('normal sizing, conservative reduction and high-volatility shutdown follow independent ceilings', () => {
  for (const [wick, expectedMode, expectedAction] of [
    [.002, 'normal', 'reduce'], [.05, 'conservative', 'reduce'], [.15, 'halt', 'pause'],
  ]) {
    const {intent, market} = rising(wick);
    const w = inspectStrategyWitness(intent, market);
    assert.equal(w.status, 'verified');
    assert.equal(w.selection.selected, 'trend');
    assert.deepEqual(w.risk.profiles.filter(p => p.applies).map(p => p.mode), [expectedMode]);
    assert.equal(w.risk.action, expectedAction);
    const approved = w.risk.profiles.find(p => p.applies);
    const expected = Math.floor(Math.min(1000, approved.riskBudget / (intent.features.stopFraction + .003)) * 100) / 100;
    assert.equal(w.risk.maxNotional, expected);
    assert.ok(w.risk.profiles[0].capacity >= w.risk.profiles[1].capacity);
  }
});

test('changing policy, ranking, sizing, indicators or claimed basis and rehashing the commitment fails closed', () => {
  const {intent, market} = historical('2024-06-06');
  for (const [edit, reason] of [
    [i => {i.assumptions.feeBps = 0;}, 'assumptions_mismatch'],
    [i => {i.features.average10 += 1;}, 'signal_mismatch'],
    [i => {i.features.signal.breakout = false;}, 'signal_mismatch'],
    [i => {i.candidates[1].score = 2;}, 'score_mismatch'],
    [i => {i.candidates[1].sampleCount += 1;}, 'score_mismatch'],
    [i => {i.selected = 'cash'; i.reason = 'no_candidate_beats_cash'; i.risk.amount = 0;}, 'selection_mismatch'],
    [i => {i.risk.mode = 'conservative'; i.risk.amount *= .5;}, 'risk_sizing_mismatch'],
    [i => {i.risk.amount += .01;}, 'risk_sizing_mismatch'],
    [i => {i.risk.limits.asset += 1;}, 'risk_sizing_mismatch'],
    [i => {i.equityBefore += 1000;}, 'risk_basis_mismatch'],
    [i => {i.asOf = i.scheduledOpenAt;}, 'window_clock_mismatch'],
  ]) {
    const result = inspectStrategyWitness(change(intent, edit), market);
    assert.deepEqual([result.status, result.reason, result.risk, result.candidates.length], ['blocked', reason, null, 0]);
  }
});

test('calibration requires exactly the bound daily window and omits any subsequent outcome', () => {
  const {market, intent} = historical('2024-06-06');
  const modified = structuredClone(market);
  modified.assets[0].bars.at(-1)[5]++;
  assert.equal(inspectStrategyWitness(intent, modified).reason, 'snapshot_mismatch');
  const future = structuredClone(market);
  const last = future.assets[0].bars.at(-1);
  future.assets[0].bars.push([last[0] + DAY, ...last.slice(1)]);
  assert.equal(inspectStrategyWitness(intent, future).reason, 'window_clock_mismatch');
  assert.equal(inspectStrategyWitness({...intent, id:'0'.repeat(64)}, market).reason, 'intent_digest_mismatch');
});
