import assert from 'node:assert/strict';
import test from 'node:test';
import {marketCompanionBrief} from './page-companion-market.mjs';

const now = Date.UTC(2026, 10, 26, 4, 15, 44);
const ticker = {price: 63123.45, change: -2.31, asOf: now - 2000};
const bars = [
  {time: Math.floor(now / 60000 - 1) * 60, low: 63000, high: 63200, close: 63150},
  {time: Math.floor(now / 60000) * 60, low: 62950.17, high: 63300.64, close: 63123.45},
];
const brief = options => marketCompanionBrief({symbol: 'BTC', ticker, bars, now, failed: false, ...options});

test('spot price, rolling 24h percentage, market identity and observation time match the displayed Ask AI citation', () => {
  const result = brief({});
  assert.equal(result.kind, 'data');
  assert.equal(result.title, 'BTC/USDT');
  assert.equal(result.source, 'Binance Spot');
  assert.equal(result.timestamp, '2026-11-26 04:15:42 UTC');
  assert.match(result.visual, /63,123\.45/);
  assert.match(result.visual, /-2\.31%/);
  assert.match(result.visual, /<polyline/);
  assert.equal(result.askSource.href, result.href);
  assert.equal(result.askSource.title, result.title);
  for (const field of [result.title, '63,123.45 USDT', '24h -2.31%', result.source, result.timestamp, result.modeLabel])
    assert.ok(result.askSource.text.includes(field), field);
  assert.doesNotMatch(result.askSource.text, /样例|示例|模拟|fixture|sample|demo/i);
});

test('loading, failed and over-24h quotes display no price, sparkline or AI citation', () => {
  const loading = brief({ticker: null}), failed = brief({ticker: null, failed: true});
  const expired = brief({ticker: {...ticker, asOf: now - 86400001}});
  assert.notEqual(loading.body, failed.body);
  assert.equal(failed.body, expired.body);
  for (const result of [loading, failed, expired]) {
    assert.equal(result.kind, 'status');
    assert.equal(result.timestamp, null);
    assert.equal(result.visual, '');
    assert.equal(result.askSource, undefined);
    assert.doesNotMatch(result.body, /\d|样例|示例|模拟|fixture|sample|demo/i);
  }
});

test('retained quotes are marked delayed, including in the data sent to Ask AI', () => {
  const fresh = brief({});
  for (const result of [brief({failed: true}), brief({ticker: {...ticker, asOf: now - 31000}})]) {
    assert.notEqual(result.modeLabel, fresh.modeLabel);
    assert.match(result.modeLabel, /延迟|delayed/i);
    assert.ok(result.askSource.text.includes(result.modeLabel));
    assert.ok(result.askSource.text.includes(result.timestamp));
  }
});

test('newer stream price wins without borrowing misaligned 24h change or candle history', () => {
  const streamQuote = {price: 63999.88, asOf: now - 500};
  const result = brief({streamQuote, analysis: true});
  assert.equal(result.kind, 'analysis');
  assert.match(result.askSource.text, /63,999\.88 USDT/);
  assert.match(result.askSource.text, /24h -2\.31%/);
  assert.match(result.body, /62,950\.17 – 63,300\.64 USDT/);
  assert.ok(result.askSource.text.includes(result.body));
  assert.equal(result.timestamp, '2026-11-26 04:15:43 UTC');
  assert.match(result.visual, /<polyline/);
  const outOfSync = brief({streamQuote, ticker: {...ticker, asOf: now - 60000},
    bars: bars.map(row => ({...row, time: row.time - 300})), analysis: true});
  assert.doesNotMatch(outOfSync.askSource.text, /24h|62,950|63,300/);
  assert.doesNotMatch(outOfSync.visual, /<polyline|%/);
  assert.equal(outOfSync.body, '');
  assert.equal(brief({streamQuote: {...streamQuote, asOf: now - 5000}}).timestamp, '2026-11-26 04:15:42 UTC');
});
