import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readForwardProof, recordForwardProofs} from './brain-proof-forward.mjs';
import {createComparisonPlan, inspectForwardComparison} from './brain-forward-comparison.mjs';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};
import {observeTestArchive} from './test-brain-observations.mjs';

const DAY = 86400000;
const bitcoin = sample.assets.find(asset => asset.key === 'coin:bitcoin');
const wrap = document => ({document, sha256:createHash('sha256').update(JSON.stringify(document)).digest('hex')});

async function register(t, openDay = '2024-06-06') {
  const dir = await mkdtemp(path.join(tmpdir(), 'astarter-comparison-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const cutoff = Date.parse(openDay);
  const bars = bitcoin.bars.filter(row => row[0] * 1000 + DAY <= cutoff).slice(-91);
  const issuance = cutoff + 120000;
  const archive = {retrievedAt:new Date(cutoff + 60000).toISOString(), assets:[{...bitcoin, bars}]};
  await observeTestArchive(archive, {dir, clock:() => issuance});
  const writes = await recordForwardProofs(archive, {dir, clock:() => issuance});
  assert.equal(writes.dispatched, 1, JSON.stringify(writes));
  const proof = await readForwardProof(bitcoin.key, {dir, includeEvidence:true});
  assert.deepEqual(proof.comparisonPlan, wrap(createComparisonPlan(proof, issuance)));
  return {dir, archive, proof, plan:proof.comparisonPlan, issuance};
}
async function closeSession({dir, archive, proof}, move) {
  // Two synthetic subsequent candles control only the outcome in this fixture.
  const {assets} = structuredClone(archive), bars = assets[0].bars;
  const at = Date.parse(proof.targetOpenAt), open = bars.at(-1)[4], close = open * move;
  bars.push([(at - DAY) / 1000, open, open, open, open, 10000]);
  bars.push([at / 1000, open, Math.max(open, close), Math.min(open, close), close, 10000]);
  const checkedAt = at + DAY + 61000, closing = {assets, updatedAt:new Date(checkedAt - 1000).toISOString()};
  await observeTestArchive(closing, {dir, clock:() => checkedAt});
  const saved = await recordForwardProofs(closing, {dir, clock:() => checkedAt});
  assert.equal(saved.settled, 1, JSON.stringify(saved));
  const settled = await readForwardProof(bitcoin.key, {dir, date:proof.targetOpenAt.slice(0,10), includeEvidence:true});
  return {settled, checkedAt, open, close};
}

test('only an already handed-off instruction can register the fixed controls before open', async t => {
  const {proof, plan, issuance} = await register(t);
  assert.equal(plan.document.commitId, proof.id);
  assert.equal(plan.document.dispatchId, proof.dispatch.sha256);
  assert.equal(plan.document.cappedHold.allocationPct, 10);
  assert.equal(inspectForwardComparison(proof, plan, {checkedAt:issuance}).status, 'pending');
  assert.equal(inspectForwardComparison(proof, plan, {checkedAt:issuance}).results, null);
  assert.equal(inspectForwardComparison(proof, null, {checkedAt:issuance}).status, 'unavailable');
  for (const time of [issuance - 1, Date.parse(proof.targetOpenAt), Date.parse(proof.targetOpenAt) + DAY]) {
    assert.throws(() => createComparisonPlan(proof, time));
  }
  assert.throws(() => createComparisonPlan({...proof, dispatch:null}, issuance), {code:'unverified_paper_handoff'});
  assert.equal(inspectForwardComparison(proof, plan, {checkedAt:issuance - 1}).status, 'blocked');
  assert.equal(inspectForwardComparison(proof, plan, {checkedAt:Date.parse(proof.targetOpenAt) + 2 * DAY}).results, null);
});

test('both controls settle only from a verified same-session receipt, charging both legs even on a flat market', async t => {
  const reg = await register(t);
  const {settled, checkedAt, open, close} = await closeSession(reg, 1);
  const report = inspectForwardComparison(settled, reg.plan, {checkedAt});
  assert.equal(report.status, 'verified', report.reason);
  assert.equal(report.receiptHash, settled.receiptHash);
  const {strategyNetPnl, cash, cappedHold, excessVsCash, excessVsCappedHold} = report.results;
  assert.equal(cash.netPnl, 0);
  assert.equal(cappedHold.allocation, 1000);
  assert.ok(Math.abs(cappedHold.notional + cappedHold.buyFee - 1000) < 1e-9);
  assert.ok(cappedHold.buyFee > 0 && cappedHold.sellFee > 0 && cappedHold.buySlippage > 0 && cappedHold.sellSlippage > 0);
  const expected = 1000 * (close / open * (1 - .0005) / (1 + .0005) * (1 - .001) / (1 + .001) - 1);
  assert.ok(Math.abs(cappedHold.netPnl - expected) < 1e-9);
  assert.ok(cappedHold.netPnl < 0 && cappedHold.netReturnPct < 0);
  assert.ok(Math.abs(cappedHold.netPnl + cappedHold.fees + cappedHold.slippage) < 1e-9);
  assert.equal(strategyNetPnl, settled.receipt.netPnl);
  assert.equal(excessVsCash, strategyNetPnl);
  assert.equal(excessVsCappedHold, strategyNetPnl - cappedHold.netPnl);
  assert.throws(() => createComparisonPlan(settled, reg.issuance), {code:'registration_closed'});
});

test('scheduled abstention and an upward session record the opportunity cost against capped hold', async t => {
  const reg = await register(t, '2024-05-31');
  assert.equal(reg.proof.selected, 'cash');
  const {settled, checkedAt} = await closeSession(reg, 1.10);
  const r = inspectForwardComparison(settled, reg.plan, {checkedAt});
  assert.equal(r.status, 'verified');
  assert.equal(r.results.strategyNetPnl, 0);
  assert.equal(r.results.excessVsCash, 0);
  assert.ok(r.results.cappedHold.netPnl > 90);
  assert.ok(r.results.excessVsCappedHold < 0);
  assert.ok(Math.abs(r.results.cappedHold.netReturnPct - r.results.cappedHold.netPnl / 100) < 1e-9);
});

test('altered dates, risk, authority, receipts and plans rehashed after the fact all exclude the comparison', async t => {
  const reg = await register(t);
  const {settled, checkedAt} = await closeSession(reg, .90);
  const original = inspectForwardComparison(settled, reg.plan, {checkedAt});
  assert.equal(original.status, 'verified');
  assert.ok(original.results.cappedHold.netPnl < -100);
  for (const edit of [
    d => {d.commitId = 'f'.repeat(64);}, d => {d.dispatchId = 'a'.repeat(64);},
    d => {d.issuedAt = d.targetOpenAt;}, d => {d.market = 'OTHER';}, d => {d.date = '2000-01-01';},
    d => {d.initialEquity *= 2;}, d => {d.quote = 'ETH';}, d => {d.cappedHold.allocationPct = 100;},
    d => {d.cappedHold.feeBps = 0;}, d => {d.cappedHold.stop = .01;},
  ]) {
    const document = structuredClone(reg.plan.document); edit(document);
    const bad = inspectForwardComparison(settled, wrap(document), {checkedAt});
    assert.equal(bad.status, 'blocked');
    assert.equal(bad.results, null);
  }
  // A perfectly valid plan for the same session, with a different legitimate pre-open
  // time, cannot be substituted after the settlement has pinned the original plan.
  const otherPlan = wrap(createComparisonPlan(reg.proof, reg.issuance + 100));
  const substitution = inspectForwardComparison(settled, otherPlan, {checkedAt});
  assert.deepEqual([substitution.status, substitution.reason, substitution.results], ['blocked', 'comparison_receipt_binding_mismatch', null]);
  const badReceipt = {...settled, receipt:{...settled.receipt, netPnl:1000}};
  assert.equal(inspectForwardComparison(badReceipt, reg.plan, {checkedAt}).results, null);
  const missing = inspectForwardComparison(settled, null, {checkedAt});
  assert.deepEqual([missing.status, missing.results], ['unavailable', null]);
  assert.equal(inspectForwardComparison(settled, reg.plan, {checkedAt:checkedAt - 1000}).status, 'blocked');
});
