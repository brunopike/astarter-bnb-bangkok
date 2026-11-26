import { strategyForSignal } from './lite-strategy-cards.mjs';
import { readLiveSignalObservation } from './live-market-signals.mjs';
import { HUB_RESOURCES, normalizeHubResource } from './market-hub-data.mjs';
import { ORDER_MARKETS } from './order-markets.mjs';
import { exponentialAverage, wilderSeries } from './workbench-market-analysis.mjs';

const symbols = ['ETH', 'BTC', 'SOL'];
const paperFee = ORDER_MARKETS['cex-spot'].feeRate;
const startingBalance = 10_000;
const practiceWindow = 15 * 60_000;
const maxQuoteMove = 0.005;

export function mergeLiteSignalFeed(previous, incoming, { mode, symbols: tracked, selectedId, now = Date.now() }) {
  const byId = new Map();
  for (const row of [...previous, ...incoming]) {
    if (row?.mode !== mode || !tracked.includes(row.symbol) || typeof row.source !== 'string' || row.unit !== 'USDT' || row.closedAt > now ||
        row.closedAt < now - 86400000 || !strategyForSignal(row, 0, 'en', row.closedAt)) continue;
    byId.set(row.id, row);
  }
  const latest = [...byId.values()].sort((a, b) => b.closedAt - a.closedAt);
  const visible = latest.slice(0, 12);
  const selected = byId.get(selectedId);
  if (selected && !visible.some(row => row.id === selectedId)) visible[visible.length - 1] = selected;
  return visible;
}

function requireMode(mode) {
  if (mode !== 'live' && mode !== 'practice') throw Error('INVALID_MODE');
}

function practiceRow(symbol, at, exit = false) {
  const start = Math.floor(at / practiceWindow) * practiceWindow;
  const entryPrice = { ETH: 3180, BTC: 81230, SOL: 184 }[symbol];
  const price = exit ? Number((entryPrice * 0.995).toFixed(2)) : entryPrice;
  const change = exit ? -0.8 : { ETH: 0.85, BTC: 0.39, SOL: -0.52 }[symbol];
  const bars = Array.from({ length: 32 }, (_, index) => {
    const progress = index / 31;
    const deviation = (progress - 1) * change + Math.sin(progress * Math.PI * 6) * Math.abs(change) * 0.11;
    const close = Number((price * (1 + deviation / 100)).toFixed(2));
    return { close, high: close, low: close, time: start / 1000 - (32 - index) * 60 };
  });
  const priceSeries = bars.slice(-20).map((bar) => bar.close);
  const momentumPct = (price / bars.at(-6).close - 1) * 100;
  return {
    id: `practice:${exit ? 'exit:' : ''}${symbol}:${start}`,
    mode: 'practice',
    symbol,
    market: symbol + '/USDT',
    source: 'Practice',
    period: '1m',
    unit: 'USDT',
    assetClass: 'crypto',
    direction: change > 0 ? 'up' : 'down',
    price,
    priceSeries,
    momentumPct,
    ema20: exponentialAverage(bars, 20).at(-1).value,
    rsi14: wilderSeries(bars, 14).rsi.at(-1).value,
    volumeRatio: 1.38,
    closedAt: start,
    receivedAt: at,
    validUntil: start + practiceWindow,
    quoteAsOf: start,
    asOfKind: 'bar-close',
    timezone: 'UTC',
    session: 'practice'
  };
}

function paperStore(factory) {
  let connection;
  function open() {
    if (!connection)
      connection = new Promise((resolve, reject) => {
        if (!factory) {
          reject(Error('STORAGE_UNAVAILABLE'));
          return;
        }
        const request = factory.open('astarter-lite-paper', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('accounts');
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            connection = undefined;
          };
          resolve(db);
        };
        request.onerror = () => reject(Error('STORAGE_UNAVAILABLE'));
      }).catch((error) => {
        connection = undefined;
        throw error;
      });
    return connection;
  }

  return async (mode, change) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('accounts');
      const request = store.get(mode);
      let result, error;
      request.onsuccess = () => {
        try {
          const account = request.result ?? { balance: startingBalance, receipts: [] };
          result = change ? change(account) : account;
          if (change && result !== account) store.put(result, mode);
        } catch (cause) {
          error = cause;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(error ?? Error('STORAGE_UNAVAILABLE'));
    });
  };
}

async function readQuote(fetchImpl, now, symbol, signal) {
  const response = await fetchImpl('/api/market-hub?resource=tickers', {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw Error('UNAVAILABLE');
  const data = await response.json();
  const at = now();
  if (
    data?.schema !== 'public-market-relay-v1' ||
    data.resource !== 'tickers' ||
    !Number.isSafeInteger(data.receivedAt) ||
    data.receivedAt > at + 5000 ||
    at - data.receivedAt > HUB_RESOURCES.tickers.stale
  )
    throw Error('UNAVAILABLE');
  const normalized = normalizeHubResource('tickers', data.body, data.receivedAt);
  const quote = normalized.data.find((row) => row.pair === symbol + 'USDT');
  if (!quote || quote.asOf > at + 5000 || at - quote.asOf > HUB_RESOURCES.tickers.stale)
    throw Error('UNAVAILABLE');
  return { price: quote.price, asOf: quote.asOf };
}

function spendCents(amount) {
  if (!['string', 'number'].includes(typeof amount) || !/^\d{1,4}(?:\.\d{1,2})?$/.test(String(amount)))
    throw Error('INVALID_AMOUNT');
  const cents = Math.round(Number(amount) * 100);
  if (cents < 1000 || cents > 100000) throw Error('INVALID_AMOUNT');
  return cents;
}

function knownReceipt(account, id) {
  return account.receipts.find((receipt) => receipt.signalId === id);
}

function holdings(account) {
  const quantities = new Map();
  for (let i = account.receipts.length - 1; i >= 0; i--) {
    const { symbol, side = 'buy', quantity } = account.receipts[i];
    if (side === 'sell') quantities.delete(symbol);
    else quantities.set(symbol, (quantities.get(symbol) ?? 0) + quantity);
  }
  return Array.from(quantities, ([symbol, quantity]) => ({ symbol, quantity }));
}

export function createLiteDesk({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  indexedDB = globalThis.indexedDB,
  accountStore = paperStore(indexedDB)
} = {}) {
  async function readSignals({ mode = 'live', symbols: requested = ['BTC', 'ETH'], signal } = {}) {
    requireMode(mode);
    const selected = symbols.filter((symbol) => requested.includes(symbol));
    if (mode === 'practice')
      return { rows: selected.map((symbol) => practiceRow(symbol, now())), failed: [] };
    const results = await Promise.allSettled(
      selected.map((symbol) =>
        readLiveSignalObservation(symbol, { fetchImpl, now, signal: signal ?? AbortSignal.timeout(12000) })
      )
    );
    signal?.throwIfAborted();
    const rows = [],
      failed = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected')
        failed.push({ symbol: selected[i], code: result.reason?.message || 'UNAVAILABLE' });
      else if (result.value.validUntil <= now()) failed.push({ symbol: selected[i], code: 'STALE_MARKET' });
      else rows.push({ ...result.value, mode: 'live' });
    });
    return { rows, failed };
  }

  async function getAccount(mode = 'live') {
    requireMode(mode);
    const account = await accountStore(mode);
    return { ...account, holdings: holdings(account) };
  }

  function practiceExit(symbol) {
    if (!symbols.includes(symbol)) throw Error('UNSUPPORTED_MARKET');
    return practiceRow(symbol, now(), true);
  }

  async function trade({ row, amount, expectedQuantity, strategyId }, side) {
    const mode = row?.mode;
    requireMode(mode);
    if (!symbols.includes(row.symbol) || !row.id) throw Error('SIGNAL_CHANGED');
    const buying = side === 'buy';
    const direction = buying ? 'up' : 'down';
    const cents = buying ? spendCents(amount) : 0;
    const initial = await accountStore(mode);
    const existing = knownReceipt(initial, row.id);
    if (existing) {
      if (
        (existing.side ?? 'buy') !== side ||
        (strategyId && existing.strategyId && existing.strategyId !== strategyId)
      )
        throw Error('SIGNAL_CHANGED');
      return { receipt: existing, balance: initial.balance };
    }
    if (row.validUntil <= now()) throw Error('EXPIRED');
    if (row.direction !== direction) throw Error('SIGNAL_CHANGED');

    let latest, quote;
    if (mode === 'practice') {
      latest = practiceRow(row.symbol, now(), row.id.startsWith('practice:exit:'));
      quote = { price: latest.price, asOf: latest.quoteAsOf };
    } else {
      const signal = AbortSignal.timeout(12000);
      try {
        // A new read bypasses the per-tab observation handoff cache at confirmation.
        [latest, quote] = await Promise.all([
          readLiveSignalObservation(row.symbol, { fetchImpl: (...args) => fetchImpl(...args), now, signal }),
          readQuote(fetchImpl, now, row.symbol, signal)
        ]);
      } catch {
        throw Error('UNAVAILABLE');
      }
    }
    if (
      latest.id !== row.id ||
      latest.direction !== direction ||
      row.market !== latest.market ||
      row.price !== latest.price ||
      row.validUntil !== latest.validUntil
    )
      throw Error('SIGNAL_CHANGED');
    if (Math.abs(quote.price / latest.price - 1) > maxQuoteMove) throw Error('QUOTE_CHANGED');

    const settled = await accountStore(mode, (account) => {
      const duplicate = knownReceipt(account, row.id);
      if (duplicate) {
        if (
          (duplicate.side ?? 'buy') !== side ||
          (strategyId && duplicate.strategyId && duplicate.strategyId !== strategyId)
        )
          throw Error('SIGNAL_CHANGED');
        return account;
      }
      const filledAt = now();
      if (filledAt >= latest.validUntil) throw Error('EXPIRED');
      if (mode === 'live' && filledAt - quote.asOf > HUB_RESOURCES.tickers.stale) throw Error('UNAVAILABLE');
      const balanceCents = Math.round(account.balance * 100);
      let amountCents, feeCents, quantity;
      if (buying) {
        if (balanceCents < cents) throw Error('INSUFFICIENT_FUNDS');
        amountCents = cents;
        feeCents = Math.round((cents * paperFee) / (1 + paperFee));
        quantity = (cents - feeCents) / 100 / quote.price;
      } else {
        quantity = holdings(account).find((position) => position.symbol === latest.symbol)?.quantity;
        if (!(quantity > 0)) throw Error('NO_POSITION');
        if (expectedQuantity !== undefined && expectedQuantity !== quantity) throw Error('POSITION_CHANGED');
        const grossCents = Math.round(quantity * quote.price * 100);
        feeCents = Math.round(grossCents * paperFee);
        amountCents = grossCents - feeCents;
        if (amountCents <= 0) throw Error('DUST_POSITION');
      }
      const matchingPlan = strategyForSignal({ ...latest, mode }, buying ? 0 : quantity, 'en', filledAt);
      if (strategyId && (matchingPlan?.id !== strategyId || matchingPlan.side !== side))
        throw Error('SIGNAL_CHANGED');
      const receipt = {
        id: 'lite-paper:' + mode + ':' + row.id,
        signalId: row.id,
        ...(matchingPlan?.side === side ? { strategyId: matchingPlan.id } : {}),
        mode,
        status: 'filled',
        side,
        symbol: latest.symbol,
        market: latest.market,
        source: latest.source,
        amount: amountCents / 100,
        price: quote.price,
        quantity,
        fee: feeCents / 100,
        filledAt,
        closedAt: latest.closedAt,
        quoteAsOf: quote.asOf
      };
      const updatedCents = balanceCents + (buying ? -amountCents : amountCents);
      return { balance: updatedCents / 100, receipts: [receipt, ...account.receipts] };
    });
    return { receipt: knownReceipt(settled, row.id), balance: settled.balance };
  }

  return {
    readSignals,
    getAccount,
    practiceExit,
    buy: (order) => trade(order, 'buy'),
    sell: (order) => trade(order, 'sell')
  };
}
