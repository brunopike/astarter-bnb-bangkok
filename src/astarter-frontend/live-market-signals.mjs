import {CROSS_MARKETS, validateCrossSnapshot} from './cross-market-data.mjs';
import {HUB_SYMBOLS, hubRetryDelay, parseHubRefreshSeconds} from './market-hub-data.mjs';
import {candleRequest, normalizeKlines} from './trading-chart-data.mjs';
import {exponentialAverage, wilderSeries} from './workbench-market-analysis.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DAILY_REFRESH = 15 * MINUTE;
const HANDOFF = 15_000;
const MANUAL_DEBOUNCE = 3_000;
const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'SPX', 'NDX', 'XAU', 'DXY', 'US10Y'];
const MAX_CONCURRENT = 3;

function sourceFor(symbol) {
  const daily = Object.hasOwn(CROSS_MARKETS, symbol);
  if (!daily && !HUB_SYMBOLS.includes(symbol)) throw Error('UNSUPPORTED_MARKET');
  const request = daily
    ? candleRequest({market: symbol, period: '1D', profileId: 'public-market', venueId: CROSS_MARKETS[symbol].venueId})
    : candleRequest({market: symbol + '/USDT', period: '1m'});
  const query = daily
    ? {resource: 'cross-candles', symbol}
    : {resource: 'candles', symbol: request.symbol, interval: request.interval};
  return {symbol, request, daily, resource: query.resource, url: '/api/market-hub?' + new URLSearchParams(query)};
}

function analyze(source, envelope, at, allowExpiredCloses = false) {
  const {symbol, request, daily, resource} = source;
  const {receivedAt, body} = envelope || {};
  if (envelope?.schema !== 'public-market-relay-v1' || envelope.resource !== resource ||
      !Number.isSafeInteger(receivedAt) || receivedAt <= 0 || receivedAt > at + 5_000) throw Error('INVALID_SOURCE_DATA');
  if (at - receivedAt > (daily ? 2 * MINUTE : 30_000)) throw Error('STALE_MARKET');
  // A candle which finished in transit was still open when the relay sampled it.
  const cutoff = Math.min(receivedAt, at);
  let bars, closedAt, validUntil, sessionDate, quoteAsOf, asOfKind;
  if (daily) {
    if (body?.receivedAt !== receivedAt) throw Error('INVALID_SOURCE_DATA');
    validateCrossSnapshot(body, request, cutoff);
    const gold = request.venueId === 'dukascopy';
    if (body.asOfKind !== (gold ? 'bar-close' : 'quote') ||
        (gold !== (body.closeTimeBasis === 'source-daily-bound')) ||
        (gold && (body.quoteAsOf !== body.closedAt || body.session !== 'last-close')) ||
        !Number.isSafeInteger(body.quoteAsOf) || body.quoteAsOf <= 0 || body.quoteAsOf * 1000 > cutoff ||
        body.bars.some(bar => bar.time * 1000 > receivedAt + MINUTE)) throw Error('INVALID_SOURCE_DATA');
    bars = body.bars.filter(bar => bar.closedAt * 1000 <= cutoff);
    closedAt = body.closedAt * 1000;
    validUntil = body.validUntil * 1000;
    sessionDate = body.sessionDate;
    quoteAsOf = body.quoteAsOf * 1000;
    asOfKind = body.asOfKind;
    const sessionStart = bars.at(-1).time * 1000;
    if (!Number.isSafeInteger(closedAt) || !Number.isSafeInteger(validUntil) ||
        validUntil > sessionStart + 7 * DAY || quoteAsOf < sessionStart) throw Error('INVALID_SOURCE_DATA');
    if (at - sessionStart > 7 * DAY) throw Error('STALE_MARKET');
  } else {
    const raw = normalizeKlines(body, request);
    if (raw.at(-1).time * 1000 > receivedAt) throw Error('INVALID_SOURCE_DATA');
    bars = raw.filter(bar => bar.time * 1000 + MINUTE <= cutoff);
    if (!bars.length) throw Error('INSUFFICIENT_BARS');
    closedAt = bars.at(-1).time * 1000 + MINUTE;
    validUntil = closedAt + MINUTE;
    asOfKind = 'bar-close';
  }
  if (validUntil <= at && (daily || !allowExpiredCloses || at - closedAt >= DAY)) throw Error('STALE_MARKET');
  if (bars.length < 21) throw Error('INSUFFICIENT_BARS');

  const averages = exponentialAverage(bars, 20);
  const rsis = wilderSeries(bars, 14).rsi;
  const count = daily ? 1 : Math.min(6, bars.length - 20);
  const observations = [];
  for (let offset = 0; offset < count; offset++) {
    const index = bars.length - 1 - offset;
    const last = bars[index];
    const price = last.close;
    const momentumPct = (price / bars[index - 5].close - 1) * 100;
    const ema20 = averages.at(-1 - offset).value;
    const rsi14 = rsis.at(-1 - offset).value;
    const baselineVolume = daily ? 0 : bars.slice(index - 20, index).reduce((sum, bar) => sum + bar.volume / 20, 0);
    const volumeRatio = baselineVolume > 0 ? last.volume / baselineVolume : null;
    if (![momentumPct, ema20, rsi14].every(Number.isFinite) || (volumeRatio !== null && !Number.isFinite(volumeRatio))) {
      if (offset === 0) throw Error('INVALID_SOURCE_DATA');
      continue;
    }
    let direction = 'neutral';
    if (momentumPct > 0 && price > ema20 && rsi14 > 50) direction = 'up';
    if (momentumPct < 0 && price < ema20 && rsi14 < 50) direction = 'down';
    const close = daily ? closedAt : last.time * 1000 + MINUTE;
    observations.push(Object.freeze({
      id: [symbol, request.period, daily ? sessionDate : close].join(':'),
      symbol, market: request.market, assetClass: daily ? 'tradfi' : 'crypto', period: request.period,
      direction, source: daily ? request.source : 'Binance Spot', unit: daily ? request.unit : 'USDT',
      price, momentumPct, ema20, rsi14, volumeRatio,
      priceSeries: Object.freeze(bars.slice(index - 19, index + 1).map(bar => bar.close)),
      closedAt: close, receivedAt, validUntil: daily ? validUntil : close + MINUTE,
      sessionDate: daily ? sessionDate : new Date(last.time * 1000).toISOString().slice(0, 10),
      quoteAsOf: daily ? quoteAsOf : close, asOfKind,
      timezone: daily ? request.timezone : 'UTC', session: daily ? body.session : 'continuous',
      closeTimeBasis: daily ? body.closeTimeBasis : 'bar-close'
    }));
  }
  return Object.freeze(observations);
}

// Preserve the validated close window for callers sharing a tab and market source.
const readings = new WeakMap();
function rememberWindow(fetchImpl, window) {
  let bySymbol = readings.get(fetchImpl);
  if (!bySymbol) { bySymbol = new Map(); readings.set(fetchImpl, bySymbol); }
  const latest = window[0];
  if ((bySymbol.get(latest.symbol)?.[0].receivedAt ?? 0) <= latest.receivedAt) bySymbol.set(latest.symbol, window);
}

export async function readLiveSignalWindow(symbol, {fetchImpl = globalThis.fetch, now = Date.now, signal, allowExpiredCloses = false} = {}) {
  const at = now(), cached = readings.get(fetchImpl)?.get(symbol), latest = cached?.[0];
  if (latest && latest.receivedAt <= at && at < Math.min(latest.validUntil, latest.receivedAt + DAILY_REFRESH)) return cached;
  const source = sourceFor(symbol);
  const response = await fetchImpl(source.url, {method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal});
  if (!response.ok) throw Error('PUBLIC_SOURCE_UNAVAILABLE');
  const window = analyze(source, await response.json(), now(), allowExpiredCloses);
  signal?.throwIfAborted();
  rememberWindow(fetchImpl, window);
  return window;
}

export async function readLiveSignalObservation(symbol, options) {
  const [latest] = await readLiveSignalWindow(symbol, options);
  return latest;
}

const dataErrors = new Set(['STALE_MARKET', 'INSUFFICIENT_BARS', 'INVALID_SOURCE_DATA']);

export function createLiveSignalFeed({
  fetchImpl = globalThis.fetch, now = Date.now, onChange = () => {}, refreshSeconds = 60,
  symbols = [], setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  let interval = parseHubRefreshSeconds(refreshSeconds) * 1000;
  let active = false, disposed = false, timer = null, batch = null;
  const slots = new Map();
  let prioritySymbol = null;

  function displayDeadline(slot) {
    return slot.daily ? slot.row.validUntil : slot.row.closedAt + Math.max(MINUTE, interval) + HANDOFF;
  }

  function snapshot() {
    const at = now(), rows = [], failed = [], pending = [];
    for (const slot of slots.values()) {
      const validUntil = slot.row ? displayDeadline(slot) : 0;
      const expired = slot.row && validUntil <= at;
      if (slot.error || expired) {
        failed.push({symbol: slot.symbol, period: slot.request.period, code: slot.error || 'STALE_MARKET'});
      }
      if (slot.row && !expired) {
        const currentUntil = slot.row.validUntil;
        const freshness = slot.daily ? 'last-session' : at < currentUntil ? 'current-minute' : 'prior-minute';
        rows.push({...slot.row, currentUntil, validUntil, freshness, refreshFailed: Boolean(slot.error)});
      }
      if (active && (slot.controller || slot.nextAt <= at)) pending.push(slot.symbol);
    }
    return {rows, loading: pending.length > 0, failed, pending, total: slots.size,
      partial: rows.length > 0 && (rows.length < slots.size || failed.length > 0)};
  }

  function nextRead(slot) {
    if (slot.daily) return Math.min(slot.row.validUntil, slot.attemptedAt + DAILY_REFRESH);
    // Re-reading the same closed minute adds no evidence at 15/30-second settings.
    return slot.row.closedAt + Math.max(MINUTE, interval);
  }

  function finishBatch() {
    if (!batch) return;
    const finished = batch;
    batch = null;
    finished.resolve(snapshot());
  }

  function cancelSlot(slot) {
    const controller = slot.controller;
    slot.controller = null;
    controller?.abort();
  }

  async function read(slot, controller) {
    const signal = controller.signal;
    let abortRead;
    const aborted = new Promise((_, reject) => {
      abortRead = () => reject(Error('REQUEST_TIMEOUT'));
      signal.addEventListener('abort', abortRead, {once: true});
    });
    const deadline = setTimer(() => controller.abort(), 10_000);
    deadline?.unref?.();
    try {
      async function load() {
        const response = await fetchImpl(slot.url, {method: 'GET', credentials: 'omit', cache: 'no-store', signal});
        signal.throwIfAborted();
        if (!response.ok) {
          const error = Error(response.status === 429 ? 'RATE_LIMITED' : 'PUBLIC_SOURCE_UNAVAILABLE');
          error.retryAfter = hubRetryDelay(response.headers?.get?.('Retry-After'), now());
          throw error;
        }
        let envelope;
        try { envelope = await response.json(); }
        catch { throw Error('INVALID_SOURCE_DATA'); }
        signal.throwIfAborted();
        try {
          return analyze(slot, envelope, now());
        } catch (error) {
          throw dataErrors.has(error.message) ? error : Error('INVALID_SOURCE_DATA');
        }
      }
      const window = await Promise.race([load(), aborted]);
      const row = window[0];
      if (slot.controller !== controller) return;
      if (slot.row && (row.sessionDate < slot.row.sessionDate ||
          (!slot.daily && row.closedAt < slot.row.closedAt))) throw Error('STALE_MARKET');
      slot.row = row;
      rememberWindow(fetchImpl, window);
      slot.error = null;
      slot.failures = 0;
      slot.rateLimitUntil = 0;
      slot.nextAt = nextRead(slot);
    } catch (error) {
      if (slot.controller !== controller) return;
      const at = now();
      slot.error = dataErrors.has(error.message) || ['RATE_LIMITED', 'REQUEST_TIMEOUT'].includes(error.message)
        ? error.message : 'PUBLIC_SOURCE_UNAVAILABLE';
      // The five-second relay cache can straddle a minute close.
      const settling = !slot.daily && slot.error === 'STALE_MARKET' && at % MINUTE < 5_000;
      const base = settling ? 5_000 : slot.daily ? MINUTE : Math.max(15_000, interval);
      const backoff = Math.min(5 * MINUTE, base * 2 ** Math.min(slot.failures++, 5));
      slot.nextAt = at + Math.max(backoff, error.retryAfter || 0);
      slot.rateLimitUntil = slot.error === 'RATE_LIMITED' ? at + Math.max(MANUAL_DEBOUNCE, error.retryAfter || 0) : 0;
    } finally {
      clearTimer(deadline);
      signal.removeEventListener('abort', abortRead);
      if (slot.controller === controller) {
        slot.controller = null;
        pump();
      }
    }
  }

  function pump() {
    if (!active) return;
    clearTimer(timer);
    const at = now(), all = [...slots.values()];
    const running = all.filter(slot => slot.controller).length;
    const due = all.filter(slot => !slot.controller && slot.nextAt <= at);
    const first = due.findIndex(slot => slot.symbol === prioritySymbol);
    if (first > 0) due.unshift(...due.splice(first, 1));
    if ((running || due.length) && !batch) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      batch = {promise, resolve};
    }
    for (const slot of due.slice(0, MAX_CONCURRENT - running)) {
      slot.attemptedAt = at;
      slot.controller = new AbortController();
      void read(slot, slot.controller);
    }
    if (!running && !due.length) finishBatch();

    // A slow refresh preference still removes an expired observation at its source deadline.
    let next = Infinity;
    for (const slot of all) {
      if (!slot.controller && slot.nextAt > at) next = Math.min(next, slot.nextAt);
      if (slot.row) {
        if (slot.row.validUntil > at) next = Math.min(next, slot.row.validUntil);
        const visibleUntil = displayDeadline(slot);
        if (visibleUntil > at) next = Math.min(next, visibleUntil);
      }
    }
    timer = Number.isFinite(next) ? setTimer(pump, Math.max(1, next - now())) : null;
    timer?.unref?.();
    onChange(snapshot());
  }

  function setSymbols(values, priority = null) {
    if (disposed) return;
    const wanted = new Set(DEFAULT_SYMBOLS);
    for (const value of Array.isArray(values) ? values : []) {
      const raw = typeof value === 'string' ? value : value?.symbol;
      const symbol = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\/?USDT$/, '') : '';
      if (HUB_SYMBOLS.includes(symbol)) wanted.add(symbol);
    }
    const preferred = wanted.has(priority) ? priority : null;
    let changed = prioritySymbol !== preferred;
    prioritySymbol = preferred;
    for (const [symbol, slot] of slots) {
      if (wanted.has(symbol)) continue;
      cancelSlot(slot);
      slots.delete(symbol);
      changed = true;
    }
    for (const symbol of wanted) {
      if (slots.has(symbol)) continue;
      slots.set(symbol, {...sourceFor(symbol), row: null, controller: null, error: null,
        failures: 0, attemptedAt: 0, nextAt: 0, rateLimitUntil: 0, lastManualAt: -Infinity});
      changed = true;
    }
    if (changed && active) pump();
  }

  function setActive(value) {
    if (disposed || active === Boolean(value)) return;
    active = Boolean(value);
    if (active) {
      const at = now();
      for (const slot of slots.values()) {
        if (!slot.error && (!slot.row || slot.row.validUntil <= at)) slot.nextAt = 0;
      }
      pump();
    } else {
      clearTimer(timer);
      timer = null;
      for (const slot of slots.values()) cancelSlot(slot);
      finishBatch();
      onChange(snapshot());
    }
  }

  function setRefreshSeconds(value) {
    if (disposed) return;
    const updated = parseHubRefreshSeconds(value) * 1000;
    if (updated === interval) return;
    const at = now();
    for (const slot of slots.values()) {
      if (slot.row && displayDeadline(slot) <= at) slot.row = null;
    }
    interval = updated;
    for (const slot of slots.values()) {
      if (slot.row && !slot.error) slot.nextAt = nextRead(slot);
    }
    if (active) pump();
  }

  function refresh() {
    if (!active || disposed) return Promise.resolve(snapshot());
    const at = now();
    for (const slot of slots.values()) {
      if (slot.controller) continue;
      if (slot.error) {
        if (at >= slot.rateLimitUntil && at - slot.lastManualAt >= MANUAL_DEBOUNCE) {
          slot.lastManualAt = at;
          slot.nextAt = at;
        }
        continue;
      }
      if (!slot.row) continue;
      const newSamplePossible = slot.daily ? at - slot.attemptedAt >= MINUTE : slot.row.validUntil <= at;
      if (newSamplePossible) slot.nextAt = Math.min(slot.nextAt, at);
    }
    pump();
    return batch?.promise || Promise.resolve(snapshot());
  }

  setSymbols(symbols);
  return {setActive, setRefreshSeconds, setSymbols, refresh, snapshot, dispose() {
    if (disposed) return;
    disposed = true;
    active = false;
    clearTimer(timer);
    for (const slot of slots.values()) cancelSlot(slot);
    finishBatch();
  }};
}
