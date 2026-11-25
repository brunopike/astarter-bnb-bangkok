import assert from 'node:assert/strict';
import test from 'node:test';
import {CROSS_MARKETS, normalizeCrossMarket} from './cross-market-data.mjs';
import {createLiveSignalFeed} from './live-market-signals.mjs';

const MINUTE = 60_000, DAY = 86_400_000;
const START = Date.parse('2026-11-25T15:27:10Z');
const MINUTE_CLOSE = Math.floor(START / MINUTE) * MINUTE;
const turn = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ok: true, json: async () => body});
const unavailable = (status = 502, retry = null) => ({ok: false, status, headers: {get: () => retry}});
const ascending = Array.from({length: 32}, (_, i) => 100 + i);

function crypto(at, closes = ascending, lastVolume = 40) {
  const current = Math.floor(at / MINUTE) * MINUTE;
  const body = [...closes, 10_000].map((close, i) => {
    const time = current + (i - closes.length) * MINUTE;
    return [time, close, close + 1, close - 1, close, i === closes.length - 1 ? lastVolume : 20, time + MINUTE - 1];
  });
  return {schema: 'public-market-relay-v1', resource: 'candles', receivedAt: at, body};
}

function daily(symbol, at) {
  const spec = CROSS_MARKETS[symbol], today = Math.floor(at / DAY) * DAY;
  const times = [];
  for (let i = 50; i >= 0; i--) {
    const day = today - i * DAY;
    if (![0, 6].includes(new Date(day).getUTCDay())) times.push(day / 1000);
  }
  let body;
  if (symbol === 'XAU') {
    const bars = times.slice(0, -1).map((time, i) => ({time, open: 100 + i, high: 101 + i, low: 99 + i,
      close: 100 + i, volume: null, closedAt: time + 86_400, validUntil: time + 2 * 86_400 + 1800,
      closeTimeBasis: 'source-daily-bound'}));
    const last = bars.at(-1);
    body = {schema: 'cross-market-daily-v1', symbol, period: '1D', source: spec.source, unit: spec.unit,
      timezone: spec.timezone, receivedAt: at, volumeKind: 'unavailable', session: 'last-close',
      quoteAsOf: last.closedAt, asOfKind: 'bar-close', closedAt: last.closedAt, validUntil: last.validUntil,
      closeTimeBasis: last.closeTimeBasis, sessionDate: new Date(last.time * 1000).toISOString().slice(0, 10), bars};
  } else {
    const timestamp = times.map(time => time + 14.5 * 3600), start = timestamp.at(-1);
    const closes = timestamp.map((_, i) => i === timestamp.length - 1 ? 9_000 : 100 + i);
    const quote = {open: closes, high: closes.map(c => c + 1), low: closes.map(c => c - 1), close: closes};
    const result = {timestamp, indicators: {quote: [quote]}, meta: {symbol: spec.id, instrumentType: 'INDEX',
      exchangeTimezoneName: spec.timezone, regularMarketTime: Math.floor(at / 1000) - 120,
      currentTradingPeriod: {regular: {start, end: start + 6.5 * 3600}}}};
    body = normalizeCrossMarket({chart: {result: [result]}}, symbol, at);
  }
  return {schema: 'public-market-relay-v1', resource: 'cross-candles', receivedAt: at, body};
}

function standard(symbol, at) {
  return response(Object.hasOwn(CROSS_MARKETS, symbol) ? daily(symbol, at) : crypto(at));
}

function harness(get = standard, options = {}) {
  const calls = [], updates = [], timers = new Map();
  let at = START, sequence = 0;
  const feed = createLiveSignalFeed({...options, now: () => at,
    setTimer(fn, ms) { const id = ++sequence; timers.set(id, {fn, at: at + ms}); return id; },
    clearTimer: id => timers.delete(id),
    onChange: state => updates.push(state),
    fetchImpl(url, init) {
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      const path = new URL(url, 'https://fixture.example');
      assert.equal(path.origin + path.pathname, 'https://fixture.example/api/market-hub');
      const query = path.searchParams, symbol = query.get('symbol').replace(/USDT$/, '');
      assert.equal(query.get('resource'), Object.hasOwn(CROSS_MARKETS, symbol) ? 'cross-candles' : 'candles');
      if (query.get('resource') === 'candles') assert.equal(query.get('interval'), '1m');
      calls.push({symbol, signal: init.signal, at});
      return get(symbol, at, init.signal);
    }
  });
  async function advance(ms) {
    const end = at + ms;
    while (true) {
      const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      at = next[1].at;
      next[1].fn();
      await turn();
    }
    at = end;
    await turn();
  }
  return {feed, calls, updates, timers, advance, count: symbol => calls.filter(c => c.symbol === symbol).length,
    async start() { feed.setActive(true); return feed.refresh(); }};
}

test('derives three directions, Wilder RSI, EMA20, five-close momentum and relative volume from completed candles', async () => {
  const mixed = [...ascending.slice(0, -5), 126.8, 126.6, 126.4, 126.2, 125.9];
  const h = harness((symbol, at) => {
    if (symbol === 'ETH') return response(crypto(at, ascending.toReversed(), 0));
    if (symbol === 'SOL') return response(crypto(at, ascending.map(() => 100)));
    if (symbol === 'BNB') return response(crypto(at, mixed));
    return standard(symbol, at);
  }, {symbols: ['BNB/USDT', 'bnbusdt', 'UNLISTED']});
  const s = await h.start(), get = symbol => s.rows.find(r => r.symbol === symbol);
  assert.deepEqual([s.total, s.failed, s.pending, s.partial], [9, [], [], false]);
  const btc = get('BTC');
  assert.equal(btc.direction, 'up');
  assert.equal(btc.price, 131);
  assert.equal(btc.volumeRatio, 2);
  assert.equal(btc.rsi14, 100);
  const ema = ascending.slice(1).reduce((prior, close) => prior + 2 / 21 * (close - prior), ascending[0]);
  assert.ok(Math.abs(btc.ema20 - ema) < 1e-10);
  assert.ok(Math.abs(btc.momentumPct - 5 / 126 * 100) < 1e-10);
  assert.deepEqual(btc.priceSeries, ascending.slice(-20));
  assert.equal(btc.closedAt, MINUTE_CLOSE);
  assert.equal(btc.quoteAsOf, btc.closedAt);
  assert.equal(btc.market, 'BTC/USDT');
  assert.equal(btc.session, 'continuous');
  assert.deepEqual([get('ETH').direction, get('ETH').rsi14, get('ETH').volumeRatio], ['down', 0, 0]);
  assert.deepEqual([get('SOL').direction, get('SOL').rsi14], ['neutral', 50]);
  assert.ok(get('BNB').rsi14 > 50 && get('BNB').momentumPct < 0);
  assert.equal(get('BNB').direction, 'neutral');
  assert.equal(h.count('BNB'), 1);
  h.feed.dispose();
});

test('uses the source trading date and completion basis independently of newer intraday quotes', async () => {
  const h = harness();
  const {rows} = await h.start();
  for (const row of rows.filter(r => r.assetClass === 'tradfi')) {
    assert.equal(row.source, CROSS_MARKETS[row.symbol].source);
    assert.equal(row.volumeRatio, null);
    assert.equal(row.sessionDate, '2026-11-24');
    assert.equal(row.price, row.priceSeries.at(-1));
    assert.ok(row.price < 9_000);
    assert.equal(row.freshness, 'last-session');
    assert.equal(row.unit, CROSS_MARKETS[row.symbol].unit);
    if (row.symbol === 'XAU') {
      assert.equal(row.closeTimeBasis, 'source-daily-bound');
      assert.equal(row.quoteAsOf, row.closedAt);
    } else {
      assert.equal(row.closeTimeBasis, 'next-session-open-bound');
      assert.equal(row.closedAt, Date.parse('2026-11-25T14:30Z'));
      assert.ok(row.quoteAsOf > row.closedAt);
      assert.equal(row.session, 'delayed');
    }
  }
  h.feed.dispose();
});

test('isolates stale, malformed, mismatched, incomplete and spot-only sources from the available rows', async () => {
  const h = harness((symbol, at) => {
    if (symbol === 'BTC') return response(crypto(MINUTE_CLOSE - 1));
    if (symbol === 'ETH') return response(crypto(at, ascending.slice(0, 5)));
    if (symbol === 'SOL') { const e = crypto(at); e.body.splice(4, 1); return response(e); }
    if (symbol === 'SPX') return response(daily('NDX', at));
    if (symbol === 'NDX') return response(daily('NDX', at - 121_000));
    if (symbol === 'XAU') return response({resource: 'gold-spot', body: {price: 3000}});
    if (symbol === 'DXY') {
      const e = daily(symbol, at), last = e.body.bars.at(-2);
      last.validUntil = e.body.validUntil = at / 1000 - 1;
      return response(e);
    }
    return standard(symbol, at);
  });
  const s = await h.start();
  assert.deepEqual(s.rows.map(r => r.symbol), ['US10Y']);
  assert.deepEqual(Object.fromEntries(s.failed.map(r => [r.symbol, r.code])), {BTC: 'STALE_MARKET',
    ETH: 'INSUFFICIENT_BARS', SOL: 'INVALID_SOURCE_DATA', SPX: 'INVALID_SOURCE_DATA',
    NDX: 'STALE_MARKET', XAU: 'INVALID_SOURCE_DATA', DXY: 'STALE_MARKET'});
  assert.equal(s.partial, true);
  h.feed.dispose();
});

test('rejects future-dated source times and invented session validity without publishing an observation', async () => {
  const h = harness((symbol, at) => {
    if (symbol === 'SPX') {
      const e = daily(symbol, at);
      e.body.validUntil = e.body.bars.at(-2).validUntil += 360 * DAY / 1000;
      return response(e);
    }
    if (symbol === 'NDX') {
      const e = daily(symbol, at);
      e.body.quoteAsOf = at / 1000 + 30;
      return response(e);
    }
    if (symbol === 'DXY') {
      const e = daily(symbol, at);
      e.body.quoteAsOf = e.body.bars.at(-2).time - 1;
      return response(e);
    }
    if (symbol === 'BTC') return response(crypto(at + MINUTE));
    return unavailable();
  });
  const s = await h.start();
  assert.deepEqual(s.rows, []);
  assert.equal(s.failed.length, s.total);
  assert.equal(s.partial, false);
  assert.deepEqual(s.failed.filter(f => f.code === 'INVALID_SOURCE_DATA').map(f => f.symbol), ['BTC', 'SPX', 'NDX', 'DXY']);
  h.feed.dispose();
});

test('loads three minute markets first, publishes each response immediately, and deduplicates renders and refreshes', async () => {
  const waiting = new Map();
  let peak = 0;
  const h = harness((symbol, at) => new Promise(resolve => {
    waiting.set(symbol, () => { waiting.delete(symbol); resolve(standard(symbol, at)); });
    peak = Math.max(peak, waiting.size);
  }));
  h.feed.setActive(true);
  const first = h.feed.refresh();
  assert.equal(h.feed.refresh(), first);
  const deadlines = [...h.timers.keys()];
  h.feed.setActive(true);
  h.feed.setRefreshSeconds(60);
  h.feed.setSymbols(['BTC', 'ignored']);
  assert.deepEqual([...h.timers.keys()], deadlines);
  assert.deepEqual([...waiting.keys()], ['BTC', 'ETH', 'SOL']);
  waiting.get('ETH')();
  await turn();
  assert.deepEqual(h.feed.snapshot().rows.map(r => r.symbol), ['ETH']);
  assert.equal(h.feed.snapshot().pending.length, 7);
  while (waiting.size) { [...waiting.values()][0](); await turn(); }
  assert.equal((await first).rows.length, 8);
  const base = h.calls.length;
  await h.feed.refresh();
  assert.equal(h.calls.length, base);
  assert.equal(peak, 3);
  h.feed.setSymbols(['bnb', {symbol: 'BNB/USDT'}, 'unsupported']);
  assert.deepEqual([...waiting.keys()], ['BNB']);
  h.feed.setSymbols([]);
  assert.equal(h.calls.at(-1).signal.aborted, true);
  waiting.get('BNB')();
  await turn();
  assert.equal(h.feed.snapshot().total, 8);
  h.feed.dispose();
});

test('manual retry can recover a failed source while debouncing repeated clicks and honoring rate limits', async () => {
  let goldUp = false, indexUp = false;
  const h = harness((symbol, at) => {
    if (symbol === 'XAU' && !goldUp) return unavailable(502, '120');
    if (symbol === 'DXY' && !indexUp) return unavailable(429, '120');
    return standard(symbol, at);
  });
  assert.equal((await h.start()).failed.length, 2);
  await h.feed.refresh();
  await h.feed.refresh();
  assert.equal(h.count('XAU'), 2);
  assert.equal(h.count('DXY'), 1);
  goldUp = indexUp = true;
  await h.advance(3_000);
  const s = await h.feed.refresh();
  assert.ok(s.rows.some(r => r.symbol === 'XAU'));
  assert.deepEqual(s.failed, [{symbol: 'DXY', period: '1D', code: 'RATE_LIMITED'}]);
  await h.advance(116_999);
  await h.feed.refresh();
  assert.equal(h.count('DXY'), 1);
  await h.advance(1);
  assert.equal(h.count('DXY'), 2);
  assert.equal(h.feed.snapshot().failed.length, 0);
  h.feed.dispose();
});

test('keeps a trusted minute while the cached relay crosses the close, then swaps its price series without a gap', async () => {
  const boundary = MINUTE_CLOSE + MINUTE;
  const h = harness((symbol, at) => symbol === 'BTC' && at === boundary ? response(crypto(boundary - 1)) : standard(symbol, at));
  await h.start();
  const original = h.feed.snapshot().rows[0];
  const startUpdates = h.updates.length;
  await h.advance(boundary - START);
  const prior = h.feed.snapshot().rows.find(r => r.symbol === 'BTC');
  assert.equal(prior.id, original.id);
  assert.equal(prior.freshness, 'prior-minute');
  assert.equal(prior.refreshFailed, true);
  await h.advance(5_000);
  const latest = h.feed.snapshot().rows.find(r => r.symbol === 'BTC');
  assert.equal(latest.closedAt, boundary);
  assert.equal(latest.freshness, 'current-minute');
  assert.equal(latest.refreshFailed, false);
  assert.ok(h.updates.slice(startUpdates).every(s => s.rows.some(r => r.symbol === 'BTC')));
  h.feed.dispose();
});

for (const seconds of [60, 120, 300]) {
  test('expires retained observations after the selected ' + seconds + 's period and a bounded 15s handoff', async () => {
    const h = harness((symbol, at) => symbol === 'BTC' && at !== START
      ? response(crypto(at - 2 * MINUTE)) : standard(symbol, at), {refreshSeconds: seconds});
    const first = (await h.start()).rows[0];
    assert.equal(first.currentUntil, MINUTE_CLOSE + MINUTE);
    assert.equal(first.validUntil, MINUTE_CLOSE + seconds * 1000 + 15_000);
    await h.advance(MINUTE_CLOSE + MINUTE - START);
    assert.ok(h.updates.some(s => s.rows.find(r => r.symbol === 'BTC')?.freshness === 'prior-minute'));
    if (seconds > 60) assert.equal(h.count('BTC'), 1);
    await h.advance((seconds - 60) * 1000 + 14_999);
    const prior = h.feed.snapshot().rows.find(r => r.symbol === 'BTC');
    assert.equal(prior.closedAt, first.closedAt);
    assert.equal(prior.refreshFailed, true);
    await h.advance(1);
    assert.ok(!h.feed.snapshot().rows.some(r => r.symbol === 'BTC'));
    assert.ok(h.feed.snapshot().failed.some(r => r.symbol === 'BTC' && r.code === 'STALE_MARKET'));
    h.feed.setRefreshSeconds(300);
    assert.ok(!h.feed.snapshot().rows.some(r => r.symbol === 'BTC'));
    h.feed.dispose();
  });
}

test('pausing or disposing aborts reads, rejects late results, and resumes with one fresh read per symbol', async () => {
  const old = [];
  let pausedFirst = true;
  const h = harness((symbol, at) => pausedFirst
    ? new Promise(resolve => old.push(() => resolve(response(crypto(at, ascending.map(() => 700))))))
    : standard(symbol, at));
  h.feed.setActive(true);
  const abandoned = h.feed.refresh();
  h.feed.setActive(false);
  assert.ok(h.calls.every(c => c.signal.aborted));
  assert.equal((await abandoned).loading, false);
  const count = h.updates.length;
  await h.advance(2 * MINUTE);
  await h.feed.refresh();
  assert.equal(h.calls.length, 3);
  assert.equal(h.updates.length, count);
  pausedFirst = false;
  h.feed.setActive(true);
  await h.feed.refresh();
  old.forEach(finish => finish());
  await turn();
  assert.ok(h.feed.snapshot().rows.every(r => r.price !== 700));
  const resumed = h.calls.length;
  h.feed.setActive(false);
  h.feed.setActive(true);
  assert.equal(h.calls.length, resumed);
  h.feed.dispose();
  h.feed.setActive(true);
  await h.feed.refresh();
  await h.advance(5 * MINUTE);
  assert.equal(h.calls.length, resumed);
  assert.equal(h.timers.size, 0);
});

test('a single hanging source times out independently and late body completion cannot overwrite a successful retry', async () => {
  let finishOld, stalled = true;
  const h = harness((symbol, at) => symbol === 'BTC' && stalled
    ? {ok: true, json: () => new Promise(resolve => { finishOld = () => resolve(crypto(at, ascending.map(() => 900))); })}
    : standard(symbol, at));
  h.feed.setActive(true);
  const waiting = h.feed.refresh();
  await turn();
  assert.equal(h.feed.snapshot().rows.length, 7);
  assert.deepEqual(h.feed.snapshot().pending, ['BTC']);
  await h.advance(10_000);
  assert.deepEqual((await waiting).failed, [{symbol: 'BTC', period: '1m', code: 'REQUEST_TIMEOUT'}]);
  stalled = false;
  assert.equal((await h.feed.refresh()).rows[0].price, 131);
  finishOld();
  await turn();
  assert.equal(h.feed.snapshot().rows[0].price, 131);
  h.feed.dispose();
});
