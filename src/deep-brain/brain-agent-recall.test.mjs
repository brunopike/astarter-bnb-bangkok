import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recallAgentMemory} from './brain-agent-recall.mjs';
import {recordForwardProofs, readForwardProof, readForwardRefusal} from './brain-proof-forward.mjs';
import {observeTestArchive} from './test-brain-observations.mjs';
import data from './brain-evidence/daily-markets.json' with {type:'json'};

const key = 'coin:bitcoin', day = 86400000;
const bitcoin = data.assets.find(asset => asset.key === key);
const iso = ms => new Date(ms).toISOString();
const dateOf = ms => iso(ms).slice(0, 10);
const base = Date.parse('2026-12-02');
const noRefusal = async () => null;

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'brain-memory-recall-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  let price = 100, now = base + 60000;
  const bars = Array.from({length:91}, (_, i) => {
    const open = price;
    price *= 1.009;
    return [(base - (91 - i) * day) / 1000, open, price * 1.002, open * .999, price, 10000];
  });
  function archive() { return {retrievedAt:iso(now - 100), assets:[{...bitcoin, bars:structuredClone(bars)}]}; }
  async function write(venueAssets) {
    const snapshot = archive(), opts = {dir, clock:() => now};
    await observeTestArchive(snapshot, {...opts, venueAssets});
    const write = await recordForwardProofs(snapshot, opts);
    assert.deepEqual(write.failed, []);
    return write;
  }
  async function advance(change = 1) {
    const open = price;
    price *= change;
    bars.push([Math.floor(now / day) * day / 1000, open, Math.max(price, open), Math.min(price, open), price, 10000]);
    now += day;
    await write();
  }
  const read = (asset, opts) => readForwardProof(asset, {...opts, dir});
  const readRefusal = (asset, opts) => readForwardRefusal(asset, {...opts, dir});
  return {dir, write, advance, archive, get now() { return now; }, set now(ms) { now = ms; }, read, readRefusal};
}

test('prior decisions and net paper outcomes use receipt availability, not candle close or inspection time', async t => {
  const f = await setup(t), targetDate = dateOf(base + 3 * day);
  await f.write();
  await f.advance(1.01);
  await f.advance(.95);
  const query = {assetKey:key, targetDate, selected:'trend', market:bitcoin.market, quote:bitcoin.quote,
    read:f.read, readRefusal:f.readRefusal};
  const before = await recallAgentMemory({...query, cutoff:iso(f.now)});
  const session = dateOf(base + day);
  const old = before.records.find(row => row.date === session);
  assert.equal(old.status, 'pending');
  assert.equal(old.outcome, null);
  assert.equal(old.selected, 'trend');
  assert.equal(old.match.strategy, true);
  assert.equal(old.provenance.recordedAt, iso(base + 60000));
  assert.equal(old.sourceStatus, 'verified');
  assert.equal(before.records.some(row => row.date === targetDate), false);

  const after = await recallAgentMemory({...query, cutoff:f.now + 1});
  const settled = after.records.find(row => row.date === session);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.outcome.knownAt, iso(f.now));
  assert.equal(settled.outcome.mode, 'forward_paper');
  assert.equal(settled.outcome.reason, 'stop_loss');
  assert.ok(settled.outcome.netPnl < 0);
  assert.equal(settled.provenance.commitId, old.provenance.commitId);
  assert.match(settled.provenance.reviewUrl, /date=2026-12-03/);
  assert.ok(!JSON.stringify(after).includes('"bars"'));
  assert.ok(!JSON.stringify(after).includes('"rawResponse"'));
  const future = await recallAgentMemory({...query, cutoff:base + 10 * day});
  assert.equal(future.asOf, iso(Date.parse(targetDate)));
  assert.equal(future.targetDate, targetDate);
});

test('a real veto becomes visible only after it is recorded and a rehashed, over-budget handoff is discarded', async t => {
  const f = await setup(t);
  await f.write();
  const initial = f.now, published = f.now += 300000;
  const changed = f.archive().assets;
  changed[0].bars.at(-1)[5] += 100;
  await f.write(changed);
  const date = dateOf(base + day), targetDate = dateOf(base + 2 * day);
  const options = {assetKey:key, targetDate, read:f.read, readRefusal:f.readRefusal};
  const visibleAt = cutoff => recallAgentMemory({...options, cutoff});
  assert.equal((await visibleAt(initial)).records.length, 0);
  assert.equal((await visibleAt(published)).records[0].status, 'pending');
  const veto = (await visibleAt(published + 1)).records[0];
  assert.equal(veto.status, 'vetoed');
  assert.equal(veto.reason, 'venue_conflict_veto');
  assert.equal(veto.outcome, null);
  assert.equal(veto.provenance.vetoAt, iso(published));

  const raw = await f.read(key, {date, includeEvidence:true});
  raw.venueVeto = null;
  raw.vetoEvidence = null;
  raw.dispatch.document.maxNotional += 1;
  raw.dispatch.sha256 = createHash('sha256').update(JSON.stringify(raw.dispatch.document)).digest('hex');
  const read = async (_, opts) => opts.date === date ? raw : null;
  const tampered = await recallAgentMemory({...options, read, cutoff:published + 1});
  assert.equal(tampered.status, 'unavailable');
  assert.equal(tampered.coverage.rejected, 1);
  assert.deepEqual(tampered.records, []);
});

test('reproducible refusals are visible without P&L; missing, wrong-scope and unreadable dates have separate coverage', async t => {
  const f = await setup(t);
  f.now += 2 * day;
  await f.write();
  const date = dateOf(base + 3 * day);
  const refusal = await f.readRefusal(key, {date});
  assert.equal(refusal.document.reason, 'STALE_EVIDENCE');
  const reads = [];
  const read = async (asset, opts) => {
    assert.equal(asset, key);
    assert.equal(opts.includeEvidence, true);
    reads.push(opts.date);
    if (opts.date === dateOf(base)) throw Error('do not expose private errors');
    if (opts.date === dateOf(base + day)) return {targetOpenAt:iso(base + day), intent:{assetKey:'coin:ethereum'}};
    return null;
  };
  const query = {assetKey:key, targetDate:dateOf(base + 4 * day), cutoff:f.now + 1, read, readRefusal:f.readRefusal};
  const result = await recallAgentMemory(query);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.coverage, {days:7, from:dateOf(base - 3 * day), to:date, matched:1,
    missing:4, rejected:1, unavailable:1, returned:1});
  assert.equal(new Set(reads).size, 7);
  assert.equal(result.records[0].outcome, null);
  assert.equal(result.records[0].status, 'refused');
  assert.equal(result.records[0].reason, 'STALE_EVIDENCE');
  assert.equal(result.records[0].provenance.refusalId, refusal.sha256);
  assert.ok(!JSON.stringify(result).includes('private errors'));
  assert.equal((await recallAgentMemory({...query, cutoff:f.now})).records.length, 0);
  const clean = {read:async () => null, readRefusal:noRefusal};
  const empty = await recallAgentMemory({...query, ...clean});
  assert.equal(empty.status, 'empty');
  assert.equal(empty.coverage.missing, 7);
  for (const bad of [{cutoff:null}, {cutoff:'nonsense'}, {targetDate:'2026-02-30'}, {assetKey:''}]) {
    await assert.rejects(recallAgentMemory({...query, ...clean, ...bad}), {code:'BAD_QUERY'});
  }
});

test('the output is bounded to three records, with retained coverage across the seven searched dates', async t => {
  const f = await setup(t);
  await f.write();
  for (let i = 0; i < 5; i++) await f.advance(1.009);
  const targetDate = dateOf(base + 7 * day);
  const report = await recallAgentMemory({assetKey:key, targetDate, cutoff:f.now + 1,
    market:bitcoin.market, quote:bitcoin.quote, read:f.read, readRefusal:f.readRefusal});
  assert.equal(report.status, 'available');
  assert.deepEqual(report.records.map(r => r.date), [6, 5, 4].map(n => dateOf(base + n * day)));
  assert.deepEqual([report.coverage.matched, report.coverage.returned], [6, 3]);
  assert.ok(JSON.stringify(report).length < 5500);
  const refusalDate = dateOf(base);
  const doc = {version:'source-refusal-v1', assetKey:key, targetDate:refusalDate, reason:'STALE_EVIDENCE',
    archiveSha256:'1'.repeat(64), observedAt:iso(base - 400000)};
  const saved = {document:doc, sha256:createHash('sha256').update(JSON.stringify(doc)).digest('hex')};
  const mixed = await recallAgentMemory({assetKey:key, targetDate, cutoff:f.now + 1, selected:'trend',
    market:bitcoin.market, quote:bitcoin.quote, read:f.read, readRefusal:async (_, opts) => opts.date === refusalDate ? saved : null});
  assert.ok(mixed.records.some(row => row.status === 'settled' && row.outcome));
  assert.ok(mixed.records.some(row => row.status === 'refused'));
  assert.equal(mixed.coverage.matched, 7);
  assert.equal(mixed.records.length, 3);
});
