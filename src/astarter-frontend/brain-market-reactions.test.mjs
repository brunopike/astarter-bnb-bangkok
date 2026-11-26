import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

function read(file) {
  return JSON.parse(readFileSync(new URL('./brain-evidence/' + file, import.meta.url), 'utf8'));
}
const archive = read('daily-markets.json');
const {records, method} = read('market-reactions.json');
const markets = new Map(archive.assets.map(asset => [asset.key, asset]));
const byId = new Map(records.map(record => [record.id, record]));
const day = 86400;
const change = (first, last) => (last / first - 1) * 100;
const closeEnough = (computed, saved) => assert.ok(Math.abs(computed - saved) < .000051, computed + ' != ' + saved);
const ts = iso => Date.parse(iso) / 1000;

test('every observation and follow-up can be recovered from its venue candles', () => {
  assert.ok(records.length > 0);
  assert.equal(byId.size, records.length);
  assert.deepEqual(new Set(records.map(r => r.kind)), new Set(Object.keys(method.patterns)));
  for (const r of records) {
    const asset = markets.get(r.scopeKeys[0]);
    assert.equal(r.venue, asset.venue);
    assert.equal(r.market, asset.market);
    assert.equal(r.priceUnit, asset.quote);
    const open = ts(r.eventAt) - day;
    const i = asset.bars.findIndex(b => b[0] === open);
    const bars = asset.bars.slice(i - 61, i + 31);
    assert.equal(bars.length, 92);
    assert.ok(bars.every((b, j) => b[0] === open + (j - 61) * day));
    assert.equal(r.close, bars[61][4]);
    assert.equal(r.priorClose, bars[60][4]);
    closeEnough(change(r.priorClose, r.close), r.dayReturnPct);
    const returns = bars.slice(1, 61).map((b, j) => Math.abs(change(bars[j][4], b[4]))).sort((a, b) => a-b);
    closeEnough(Math.max(3, returns[56]), r.thresholdPct);
    const volumes = bars.slice(1, 61).map(b => b[5]).sort((a, b) => a-b);
    closeEnough(bars[61][5] / ((volumes[29] + volumes[30]) / 2), r.volumeMultiple);
    assert.deepEqual(r.horizons.map(h => h.days), [1, 7, 30]);
    for (const h of r.horizons) {
      const closes = bars.slice(61, 62 + h.days).map(b => b[4]);
      assert.equal(h.close, closes.at(-1));
      assert.equal(ts(h.at), open + (h.days + 1) * day);
      closeEnough(change(r.close, h.close), h.returnPct);
      const dips = closes.map((value, j) => change(Math.max(...closes.slice(0, j + 1)), value));
      closeEnough(Math.min(...dips), h.maxDrawdownPct);
    }
    assert.equal(r.reviewedAt, r.horizons[2].at);
    assert.ok(ts(r.knownAt) >= ts(r.reviewedAt));
    const range = new URL(r.sourceUrl);
    if (r.venue === 'Binance Spot') {
      assert.equal(range.searchParams.get('symbol'), r.market);
      assert.equal(+range.searchParams.get('startTime'), bars[0][0] * 1000);
      assert.equal(+range.searchParams.get('endTime'), ts(r.reviewedAt) * 1000 - 1);
    } else {
      assert.equal(range.pathname, '/products/' + r.market + '/candles');
      assert.equal(ts(range.searchParams.get('start')), bars[0][0]);
      assert.equal(ts(range.searchParams.get('end')), ts(r.reviewedAt) - 1);
    }
  }
});

test('comparisons point to distinct, earlier completed observations of the same pattern', () => {
  for (const r of records) {
    assert.deepEqual(r.relatedIds, r.relations.map(link => link.id));
    const outcomes = new Set();
    for (const link of r.relations) {
      const older = byId.get(link.id);
      assert.ok(older.reviewedAt <= r.eventAt);
      assert.deepEqual([older.kind, older.market, older.venue], [r.kind, r.market, r.venue]);
      if (r.kind === 'price-shock') assert.equal(Math.sign(r.dayReturnPct), Math.sign(older.dayReturnPct));
      assert.equal(link.kind, r.outcome === older.outcome ? 'parallel' : 'contrast');
      assert.ok(!outcomes.has(older.outcome));
      outcomes.add(older.outcome);
    }
  }
});

test('daily update refreshes a custom archive in place and recovers after a derived-file failure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'astarter-reaction-update-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const source = join(dir, 'market.json');
  const derived = join(dir, 'market.market-reactions.json');
  const asset = markets.get('coin:bitcoin');
  const example = records.find(r => r.market === asset.market && r.kind === 'price-shock');
  const finalTime = ts(example.reviewedAt) - day;
  const bar = asset.bars.find(row => row[0] === finalTime);
  const payload = {...asset, bars: asset.bars.filter(row => row[0] < finalTime), captures: [], incrementalFrom: finalTime};
  const data = JSON.stringify({retrievedAt: archive.retrievedAt, assets: [payload]});
  writeFileSync(source, data);
  writeFileSync(join(dir, 'market-reactions.json'), 'keep');
  const venueResponse = join(dir, 'response');
  writeFileSync(venueResponse, JSON.stringify([[bar[0] * 1000, ...bar.slice(1).map(String), (bar[0] + day) * 1000 - 1]]));
  const curl = join(dir, 'curl');
  writeFileSync(curl, '#!/bin/sh\ncat "$ASTARTER_CANDLE_FIXTURE"\n');
  chmodSync(curl, 0o755);
  const update = (...flags) => spawnSync('python3', [
    fileURLToPath(new URL('./scripts/brain-daily-update.py', import.meta.url)), '--archive', source,
    '--until', new Date(finalTime * 1000).toISOString().slice(0, 10), ...flags,
  ], {encoding: 'utf8', env: {...process.env, PATH: dir + ':' + process.env.PATH, ASTARTER_CANDLE_FIXTURE: venueResponse}});
  assert.equal(update('--dry-run').status, 0);
  assert.equal(readFileSync(source, 'utf8'), data);
  assert.equal(statSync(derived, {throwIfNoEntry:false}), undefined);

  // Fail only the derived write, after the ordinary update has persisted its new candle.
  mkdirSync(derived);
  const failed = update();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /could not be rebuilt/);
  assert.equal(JSON.parse(readFileSync(source)).assets[0].bars.at(-1)[0], finalTime);
  rmSync(derived, {recursive:true});
  const retried = update();
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /0 new candles/);
  const rebuilt = JSON.parse(readFileSync(derived));
  assert.equal(rebuilt.sourceArchive, 'market.json');
  const recovered = rebuilt.records.find(r => r.id === example.id);
  assert.deepEqual(recovered.horizons, example.horizons);
  assert.ok(ts(recovered.knownAt) >= ts(recovered.reviewedAt));
  const modified = statSync(derived).mtimeMs;
  assert.equal(update().status, 0);
  assert.equal(statSync(derived).mtimeMs, modified);
  assert.equal(readFileSync(join(dir, 'market-reactions.json'), 'utf8'), 'keep');
});
