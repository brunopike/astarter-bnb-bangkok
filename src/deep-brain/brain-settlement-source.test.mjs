import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};
import {observeTestArchive} from './test-brain-observations.mjs';
import {recordForwardProofs, readForwardProof} from './brain-proof-forward.mjs';
import {createBrainProofHandler} from './api/brain-proof.mjs';
import {evaluateDecisionProof} from './brain-decision-proof.mjs';

const DAY = 86400000;
const registrationDay = Date.parse('2024-06-06T00:00:00Z');
const targetOpen = registrationDay + DAY;
const targetClose = targetOpen + DAY;
const targetDate = '2024-06-07';
const targetAsset = sample.assets.find(asset => asset.key === 'coin:bitcoin');
const expectedBar = targetAsset.bars.find(row => row[0] * 1000 === targetOpen);
const sha = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');

function archiveAt(cutoff) {
  return {retrievedAt:new Date(cutoff + 1000).toISOString(), assets:[{...targetAsset,
    bars:targetAsset.bars.filter(row => row[0] * 1000 + DAY <= cutoff).slice(-100).map(row => [...row])}]};
}

async function session(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astarter-venue-settlement-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  let now = registrationDay + 2000;
  const clock = () => now;
  const input = archiveAt(registrationDay);
  const ref = await observeTestArchive(input, {dir, clock});
  assert.equal(ref.counts.matched, 1);
  const writes = await recordForwardProofs(input, {dir, clock});
  assert.equal(writes.dispatched, 1);
  const read = () => readForwardProof(targetAsset.key, {dir, date:targetDate, includeEvidence:true});
  const frozen = await read();
  assert.equal(frozen.selected, 'breakout');
  assert.equal(frozen.targetOpenAt, new Date(targetOpen).toISOString());
  const service = createBrainProofHandler({clock, forward:(assetKey, options) => readForwardProof(assetKey, {...options, dir})});
  const server = createServer(service);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/brain/proof?current=1&asset=coin:bitcoin&date=' + targetDate;
  async function publicReview() {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return response.json();
  }
  now = targetClose + 2000;
  return {dir, clock, tick:() => {now += 1000;}, read, publicReview, frozen};
}

test('an altered local closing price stays pending and only the corrected venue-backed candle can settle the frozen instruction', async t => {
  const {dir, clock, tick, read, publicReview, frozen} = await session(t);
  const genuine = archiveAt(targetClose), corrupt = structuredClone(genuine);
  const bar = corrupt.assets[0].bars.at(-1);
  bar[4] = (bar[2] + bar[3]) / 2;
  assert.notEqual(bar[4], expectedBar[4]);
  const disagreement = await observeTestArchive(corrupt, {dir, clock, venueAssets:genuine.assets});
  assert.equal(disagreement.counts.conflict, 1);
  const refused = await recordForwardProofs(corrupt, {dir, clock});
  assert.equal(refused.settled, 0);
  assert.ok(refused.unavailable.some(row => row.reason === 'SETTLEMENT_CANDLE_UNVERIFIED'));
  const pending = await read();
  assert.equal(pending.id, frozen.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.receipt, null);
  const review = await publicReview();
  assert.equal(review.receipt, null);
  assert.equal(review.decisionProof.status, 'waiting');
  assert.equal(review.decisionProof.reason, 'awaiting_verified_settlement_candle');
  assert.equal(review.decisionProof.execution.receiptId, null);

  tick();
  const match = await observeTestArchive(genuine, {dir, clock});
  assert.equal(match.counts.matched, 1);
  const writes = await recordForwardProofs(genuine, {dir, clock});
  assert.equal(writes.settled, 1);
  const valid = await read();
  const settledObservationId = match.observations[0].id;
  assert.equal(valid.id, frozen.id);
  assert.equal(valid.settlement.document.protocol, 'venue-settlement-v2');
  assert.equal(valid.settlement.document.settlementObservationId, settledObservationId);
  assert.equal(valid.settlementVenueEvidence.observation.id, settledObservationId);
  assert.equal(valid.settlementVenueEvidence.observation.status, 'matched');
  assert.equal(valid.settlementVenueEvidence.observation.market, targetAsset.market);
  assert.deepEqual(valid.receipt.settlementBar, expectedBar);
  assert.equal((await publicReview()).receipt.id, valid.receipt.id);
  const verified = evaluateDecisionProof(valid, {assetKey:targetAsset.key, date:targetDate, checkedAt:clock()});
  assert.equal(verified.status, 'verified', verified.reason);
  const assurance = verified.assurance.settlementSource;
  assert.equal(assurance.status, 'verified');
  assert.equal(assurance.id, settledObservationId);
  assert.equal(assurance.targetOpenAt, frozen.targetOpenAt);
  assert.equal(assurance.rawSha256, valid.settlementVenueEvidence.observation.rawSha256);

  // Change the verified volume in the downloaded venue bytes without changing any modeled price or P&L.
  const rawChanged = structuredClone(valid), rows = JSON.parse(rawChanged.settlementVenueEvidence.rawResponse);
  const targetRow = rows.find(row => row[0] === targetOpen);
  assert.ok(targetRow);
  targetRow[5] = String(Number(targetRow[5]) + 1);
  rawChanged.settlementVenueEvidence.rawResponse = JSON.stringify(rows);
  // A genuine, previously matched window from the same asset also cannot attest to a later date.
  const wrongWindow = structuredClone(valid);
  wrongWindow.settlementVenueEvidence = frozen.venueEvidence;
  wrongWindow.settlement.document.settlementObservationId = frozen.venueEvidence.observation.id;
  wrongWindow.settlement.sha256 = sha(wrongWindow.settlement.document);
  wrongWindow.receiptHash = wrongWindow.settlement.sha256;
  for (const altered of [rawChanged, wrongWindow]) {
    const gate = evaluateDecisionProof(altered, {assetKey:targetAsset.key, date:targetDate, checkedAt:clock()});
    assert.equal(gate.status, 'blocked');
    assert.equal(gate.execution?.receiptId ?? null, null);
  }
});

test('the published decision remains pending if the official response omits the target day despite a complete local bar and a prior matched venue window', async t => {
  const {dir, clock, read, publicReview, frozen} = await session(t);
  const local = archiveAt(targetClose), venueAssets = structuredClone(local.assets);
  const removed = venueAssets[0].bars.pop();
  assert.deepEqual(removed, expectedBar);
  const observed = await observeTestArchive(local, {dir, clock, venueAssets});
  assert.equal(observed.counts.matched, 0);
  const saved = await recordForwardProofs(local, {dir, clock});
  assert.equal(saved.settled, 0);
  assert.ok(saved.unavailable.some(row => row.reason === 'SETTLEMENT_CANDLE_UNVERIFIED'));
  const record = await read();
  assert.equal(record.id, frozen.id);
  assert.equal(record.dispatch.sha256, frozen.dispatch.sha256);
  assert.equal(record.status, 'pending');
  assert.equal(record.receiptHash, null);
  assert.equal(record.executionBar, null);
  const review = await publicReview();
  assert.equal(review.targetDate, targetDate);
  assert.equal(review.receipt, null);
  assert.equal(review.decisionProof.status, 'waiting');
  assert.equal(review.decisionProof.reason, 'awaiting_verified_settlement_candle');
  assert.equal(review.decisionProof.stages.execution, 'waiting');
});

test('a stale local archive cannot substitute the prior session even when the venue already returned the target', async t => {
  const {dir, clock, read, publicReview, frozen} = await session(t);
  const local = archiveAt(targetOpen), genuine = archiveAt(targetClose);
  local.retrievedAt = new Date(clock() - 500).toISOString();
  assert.deepEqual(local.assets[0].bars.at(-1)[0] * 1000, targetOpen - DAY);
  const observation = await observeTestArchive(local, {dir, clock, venueAssets:genuine.assets});
  assert.equal(observation.counts.matched, 0);
  const saved = await recordForwardProofs(local, {dir, clock});
  assert.equal(saved.settled, 0);
  const pending = await read();
  assert.equal(pending.dispatch.sha256, frozen.dispatch.sha256);
  assert.equal(pending.receipt, null);
  const review = await publicReview();
  assert.equal(review.decisionProof.reason, 'awaiting_verified_settlement_candle');
  assert.equal(review.receipt, null);
});
