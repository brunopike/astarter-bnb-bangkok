import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recordForwardProofs, readForwardProof, seriesDirectory} from './brain-proof-forward.mjs';
import {summarizeForwardTrack} from './brain-forward-track.mjs';
import {observeTestArchive} from './test-brain-observations.mjs';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};

const DAY = 86400000;
const key = 'coin:bitcoin';
const bitcoin = sample.assets.find(a => a.key === key);
const now = Date.parse('2025-02-09T12:00:00Z');

async function trial(t, date, {flat = false, move = 1.02, settle = true, removePlan = false, usd = false} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astarter-track-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const target = Date.parse(date), dayBefore = target - DAY, before = dayBefore + 60000;
  let price = 100;
  const bars = Array.from({length:91}, (_, i) => {
    const open = price;
    price *= flat ? 1 : 1.009;
    return [(dayBefore - (91 - i) * DAY) / 1000, open, Math.max(open, price) * 1.002,
      Math.min(open, price) * .999, price, 10000];
  });
  const marketplace = usd ? {...bitcoin, market:'BTC-USD', venue:'Coinbase Exchange', quote:'USD',
    sourceUrl:'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400'} : bitcoin;
  const captured = {retrievedAt:new Date(before).toISOString(), assets:[{...marketplace, bars}]};
  const clock = () => before + 100;
  await observeTestArchive(captured, {dir, clock});
  const write = await recordForwardProofs(captured, {dir, clock});
  assert.equal(write.dispatched, 1, JSON.stringify(write));
  const read = () => readForwardProof(key, {date, dir, includeEvidence:true});
  if (!settle) return read();
  if (removePlan) await unlink(path.join(seriesDirectory(dir, key), date, 'comparison.json'));
  const later = structuredClone(captured);
  later.assets[0].bars.push([dayBefore / 1000, price, price, price, price, 10000]);
  const close = price * move, after = target + DAY + 60000;
  later.assets[0].bars.push([target / 1000, price, Math.max(price, close), Math.min(price, close), close, 10000]);
  later.updatedAt = new Date(after).toISOString();
  const afterClose = () => after + 100;
  await observeTestArchive(later, {dir, clock:afterClose});
  assert.equal((await recordForwardProofs(later, {dir, clock:afterClose})).settled, 1);
  return read();
}

test('every closed UTC date is represented; a settled abstention, loss and unavailable evidence retain distinct meanings', async t => {
  const noPlan = await trial(t, '2025-02-04', {removePlan:true});
  const loss = await trial(t, '2025-02-05', {move:.96});
  const abstention = await trial(t, '2025-02-06', {flat:true, move:1.10});
  const corrupt = await trial(t, '2025-02-07', {settle:false});
  corrupt.dispatch.sha256 = '0'.repeat(64);
  const pending = await trial(t, '2025-02-08', {settle:false});
  const active = await trial(t, '2025-02-09', {settle:false});
  const proofMap = new Map([noPlan, loss, abstention, corrupt, pending, active].map(p => [p.targetOpenAt.slice(0,10), p]));
  const read = async (assetKey, {date, includeEvidence}) => {
    assert.equal(assetKey, key);
    assert.equal(includeEvidence, true);
    return proofMap.get(date) ?? null;
  };
  const refusalDate = '2025-02-03';
  const doc = {assetKey:key, targetDate:refusalDate, observedAt:'2025-02-02T12:00:00Z', reason:'SOURCE_OBSERVATION_CONFLICT'};
  const refused = {document:doc, sha256:createHash('sha256').update(JSON.stringify(doc)).digest('hex')};
  const readRefusal = async (_, {date}) => date === refusalDate ? refused : null;
  const report = await summarizeForwardTrack(key, {days:7, checkedAt:now, read, readRefusal});
  assert.deepEqual(report.rows.map(row => row.status), ['missing', 'refused', 'no_plan', 'settled', 'settled', 'blocked', 'pending']);
  assert.deepEqual([report.startDate, report.endDate, report.active.date, report.active.status],
    ['2025-02-02', '2025-02-08', '2025-02-09', 'pending']);
  assert.equal(report.rows[2].netPnl, null);
  assert.equal(report.rows[3].outcome, 'loss');
  assert.equal(report.rows[4].netPnl, 0);
  assert.equal(report.rows[4].outcome, 'flat');
  assert.equal(report.rows[4].fillStatus, 'skipped');
  assert.ok(report.rows[4].excessVsCappedHold < 0);
  assert.equal(report.rows[5].netPnl, null);
  assert.equal(report.rows[6].netPnl, null);
  assert.equal(report.active.netPnl, null);
  assert.deepEqual(report.counts, {calendarDays:7, registered:5, missing:1, refused:1, blocked:1, unavailable:0,
    pending:1, withoutPlan:1, excluded:0, settled:3, noTrade:1, comparable:2, wins:0, losses:1, flat:1});
  assert.equal(report.performance.quote, 'USDT');
  assert.equal(report.performance.netPnl, loss.receipt.netPnl);
  assert.equal(report.performance.againstCash.losses, 1);
  assert.equal(report.performance.againstCash.ties, 1);
  assert.equal(report.performance.againstCappedHold.wins + report.performance.againstCappedHold.losses +
    report.performance.againstCappedHold.ties, 2);
  const encoded = JSON.stringify(report);
  for (const raw of ['"bars":', '"rawResponse":', '"archiveText":', '"document":']) assert.ok(!encoded.includes(raw));
  assert.ok(encoded.length < 9000);
});

test('USD and USDT maintain separate reconciled totals even for the same asset, and a referenced missing plan is excluded', async t => {
  const usd = await trial(t, '2025-02-07', {usd:true, move:1.03});
  const usdt = await trial(t, '2025-02-08', {move:.98});
  const lookup = { '2025-02-07':usd, '2025-02-08':usdt };
  const read = async (_, {date}) => lookup[date] ?? null;
  const both = await summarizeForwardTrack(key, {days:2, checkedAt:now, read});
  assert.deepEqual(both.byQuote.map(g => g.quote), ['USD', 'USDT']);
  assert.equal(both.performance, null);
  assert.equal(both.byQuote[0].againstCash.wins, 1);
  assert.equal(both.byQuote[1].againstCash.losses, 1);
  assert.equal(both.byQuote[0].netPnl, usd.receipt.netPnl);
  usdt.comparisonPlan = null;
  const changed = await summarizeForwardTrack(key, {days:2, checkedAt:now, read});
  assert.equal(changed.rows[1].status, 'blocked');
  assert.equal(changed.rows[1].reason, 'comparison_plan_mismatch');
  assert.equal(changed.rows[1].netPnl, null);
  assert.equal(changed.performance.samples, 1);
  assert.equal(changed.performance.quote, 'USD');
});

test('empty or unreadable days cannot become zero-return outcomes and reads are scoped to 30 closed dates plus the active date', async () => {
  const reads = [];
  const read = async (_, {date}) => {
    reads.push(date);
    if (date === '2025-02-03') throw new Error('private path should not reach a compact view');
    return null;
  };
  const report = await summarizeForwardTrack(key, {days:30, checkedAt:now, read});
  assert.equal(reads.length, 31);
  assert.equal(new Set(reads).size, 31);
  assert.equal(report.rows.length, 30);
  assert.equal(report.counts.unavailable, 1);
  assert.equal(report.counts.missing, 29);
  assert.equal(report.active, null);
  assert.ok(report.rows.every(row => row.netPnl === null && row.excessVsCash === null));
  assert.equal(report.performance, null);
  assert.deepEqual(report.byQuote, []);
  assert.ok(!JSON.stringify(report).includes('private path'));
  for (const bad of [0, 31, '7', NaN]) await assert.rejects(summarizeForwardTrack(key, {days:bad, checkedAt:now, read}), {code:'BAD_QUERY'});
  await assert.rejects(summarizeForwardTrack(key, {days:1, checkedAt:'invalid clock', read}), {code:'BAD_QUERY'});
});
