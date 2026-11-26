import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiteDesk, mergeLiteSignalFeed } from './lite-desk-data.mjs';
import { readLiveSignalObservation } from './live-market-signals.mjs';

const start = Date.UTC(2026, 10, 25, 10, 6, 5);
function harness() {
  const accounts = new Map();
  const state = { time: start, price: 131, quoteTime: start, available: true, candles: 0 };
  const accountStore = async (mode, change) => {
    const account = accounts.get(mode) ?? { balance: 10000, receipts: [] };
    if (!change) return account;
    const next = change(account);
    accounts.set(mode, next);
    return next;
  };
  const fetchImpl = async (url) => {
    if (!state.available) throw Error('UNAVAILABLE');
    const resource = new URL(url, 'http://localhost').searchParams.get('resource');
    let body;
    if (resource === 'tickers') {
      body = [
        {
          symbol: state.tickerSymbol || 'ETHUSDT',
          lastPrice: state.price,
          openPrice: 125,
          quoteVolume: 60000,
          closeTime: state.quoteTime
        }
      ];
    } else {
      assert.equal(resource, 'candles');
      state.candles++;
      const current = Math.floor(state.time / 60000) * 60000;
      body = Array.from({ length: 33 }, (_, i) => {
        const at = current + (i - 32) * 60000,
          close = state.declining ? 160 - i : 100 + i;
        return [at, close, close + 1, close - 1, close, 10, at + 59999];
      });
    }
    return {
      ok: true,
      json: async () => ({ schema: 'public-market-relay-v1', resource, receivedAt: state.time, body })
    };
  };
  return { desk: createLiteDesk({ fetchImpl, now: () => state.time, accountStore }), state, accounts };
}

test('practice is explicit, begins with ETH and has its own persistent scope', async () => {
  const { desk, state } = harness();
  state.available = false;
  const live = await desk.readSignals({ mode: 'live', symbols: ['BTC', 'ETH'] });
  assert.equal(live.rows.length, 0);
  assert.equal(live.failed.length, 2);
  const { rows } = await desk.readSignals({ mode: 'practice', symbols: ['BTC', 'ETH', 'SOL'] });
  assert.deepEqual(
    rows.map((row) => row.symbol),
    ['ETH', 'BTC', 'SOL']
  );
  const results = await Promise.all([
    desk.buy({ row: rows[0], amount: 50 }),
    desk.buy({ row: rows[0], amount: 50 })
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].balance, 9950);
  const { receipt } = results[0];
  assert.equal(receipt.source, 'Practice');
  assert.ok(Math.abs(receipt.quantity * receipt.price + receipt.fee - receipt.amount) < 1e-8);
  state.time += 900000;
  assert.deepEqual(await desk.buy({ row: rows[0], amount: 50 }), results[0]);
  await assert.rejects(desk.buy({ row: rows[1], amount: 50 }), /EXPIRED/);
  assert.equal((await desk.getAccount('practice')).receipts.length, 1);
  assert.equal((await desk.getAccount('live')).balance, 10000);
});

test('live paper rechecks the signal, records a fresh spot reference and recovers the prior fill offline', async () => {
  const { desk, state } = harness();
  const {
    rows: [row]
  } = await desk.readSignals({ mode: 'live', symbols: ['ETH'] });
  state.price = 131.1;
  const filled = await desk.buy({ row, amount: '15.49' });
  assert.equal(state.candles, 2);
  assert.equal(filled.receipt.price, 131.1);
  assert.equal(filled.receipt.source, 'Binance Spot');
  assert.equal(filled.balance, 9984.51);
  state.available = false;
  assert.deepEqual(await desk.buy({ row, amount: '15.49' }), filled);
});

test('changed signals, mismatched quotes and expired inputs cannot spend', async () => {
  const { desk, state } = harness();
  const {
    rows: [row]
  } = await desk.readSignals({ symbols: ['ETH'] });
  await assert.rejects(desk.buy({ row: { ...row, id: 'wrong' }, amount: 10 }), /SIGNAL_CHANGED/);
  state.price = 140;
  await assert.rejects(desk.buy({ row, amount: 10 }), /QUOTE_CHANGED/);
  state.price = 131;
  state.quoteTime = state.time - 31000;
  await assert.rejects(desk.buy({ row, amount: 10 }), /UNAVAILABLE/);
  state.time = row.validUntil;
  await assert.rejects(desk.buy({ row, amount: 10 }), /EXPIRED/);
  assert.deepEqual(await desk.getAccount('live'), { balance: 10000, receipts: [], holdings: [] });
});

test('a practice exit closes the whole held asset once, includes fees and leaves other positions intact', async () => {
  const { desk, state, accounts } = harness();
  const {
    rows: [eth, btc]
  } = await desk.readSignals({ mode: 'practice', symbols: ['ETH', 'BTC'] });
  const exit = desk.practiceExit('ETH');
  assert.notEqual(exit.id, eth.id);
  assert.equal(exit.direction, 'down');
  await assert.rejects(desk.sell({ row: exit }), /NO_POSITION/);
  await assert.rejects(desk.sell({ row: eth }), /SIGNAL_CHANGED/);
  await desk.buy({ row: eth, amount: 50 });
  await desk.buy({ row: btc, amount: 25 });
  // Existing receipts from the first release did not carry an explicit side.
  delete accounts.get('practice').receipts[1].side;
  const before = await desk.getAccount('practice');
  const quantity = before.holdings.find((holding) => holding.symbol === 'ETH').quantity;
  await assert.rejects(desk.sell({ row: exit, expectedQuantity: quantity / 2 }), /POSITION_CHANGED/);
  const [first, second] = await Promise.all([
    desk.sell({ row: exit, expectedQuantity: quantity }),
    desk.sell({ row: exit })
  ]);
  assert.deepEqual(first, second);
  const grossCents = Math.round(quantity * exit.price * 100);
  assert.equal(first.receipt.side, 'sell');
  assert.equal(first.receipt.quantity, quantity);
  assert.equal(first.receipt.fee, Math.round(grossCents * 0.001) / 100);
  assert.equal(first.receipt.amount, (grossCents - Math.round(grossCents * 0.001)) / 100);
  assert.equal(first.balance, (992500 + Math.round(first.receipt.amount * 100)) / 100);
  const account = await desk.getAccount('practice');
  assert.deepEqual(
    account.holdings.map((holding) => holding.symbol),
    ['BTC']
  );
  assert.deepEqual(account.receipts[0], first.receipt);
  state.time += 900000;
  assert.deepEqual(await desk.sell({ row: exit }), first);
  await assert.rejects(desk.sell({ row: desk.practiceExit('ETH') }), /NO_POSITION/);
  const oldExit = { ...desk.practiceExit('BTC'), validUntil: state.time };
  await assert.rejects(desk.sell({ row: oldExit }), /EXPIRED/);
  assert.equal((await desk.getAccount('live')).receipts.length, 0);
});

test('a live exit requires a new declining signal and a fresh matching execution price', async () => {
  const { desk, state } = harness();
  const {
    rows: [entry]
  } = await desk.readSignals({ symbols: ['ETH'] });
  await desk.buy({ row: entry, amount: 100 });
  state.time += 60000;
  state.declining = true;
  const {
    rows: [exit]
  } = await desk.readSignals({ symbols: ['ETH'] });
  assert.equal(exit.direction, 'down');
  state.price = 129;
  await assert.rejects(desk.sell({ row: exit }), /UNAVAILABLE/);
  state.quoteTime = state.time;
  state.price = 140;
  await assert.rejects(desk.sell({ row: exit }), /QUOTE_CHANGED/);
  state.price = 129;
  await assert.rejects(desk.sell({ row: { ...desk.practiceExit('ETH'), mode: 'live' } }), /SIGNAL_CHANGED/);
  const sale = await desk.sell({ row: exit });
  assert.equal(sale.receipt.price, 129);
  assert.equal(sale.receipt.source, 'Binance Spot');
  assert.deepEqual((await desk.getAccount()).holdings, []);
  state.available = false;
  assert.deepEqual(await desk.sell({ row: exit }), sale);
});

test('simulated cash, ticket precision and action direction are enforced', async () => {
  const { desk, state } = harness();
  const { rows } = await desk.readSignals({ mode: 'practice', symbols: ['ETH', 'SOL'] });
  for (const amount of [0, 0.05, 10.044, 1000.01, Infinity, '', '1e2', '-20'])
    await assert.rejects(desk.buy({ row: rows[0], amount }), /INVALID_AMOUNT/);
  await assert.rejects(desk.buy({ row: rows[1], amount: 10 }), /SIGNAL_CHANGED/);
  for (let i = 0; i < 10; i++) {
    const {
      rows: [row]
    } = await desk.readSignals({ mode: 'practice', symbols: ['ETH'] });
    await desk.buy({ row, amount: 1000 });
    state.time += 900000;
  }
  const {
    rows: [last]
  } = await desk.readSignals({ mode: 'practice', symbols: ['ETH'] });
  await assert.rejects(desk.buy({ row: last, amount: 10 }), /INSUFFICIENT_FUNDS/);
  const account = await desk.getAccount('practice');
  assert.equal(account.balance, 0);
  assert.equal(account.receipts.length, 10);
  assert.ok(account.receipts[0].filledAt > account.receipts[1].filledAt);
});

test('a selected Signals strategy must match the fill and is recorded on the receipt', async () => {
  const { desk } = harness();
  const {
    rows: [row]
  } = await desk.readSignals({ mode: 'practice', symbols: ['ETH'] });
  await assert.rejects(desk.buy({ row, amount: '75', strategyId: 'grid' }), /SIGNAL_CHANGED/);
  assert.equal((await desk.getAccount('practice')).balance, 10000);
  const { receipt } = await desk.buy({ row, amount: '75', strategyId: 'signals-spot-momentum-entry' });
  assert.equal(receipt.strategyId, 'signals-spot-momentum-entry');
  assert.equal(receipt.signalId, row.id);
  const { receipt: sale } = await desk.sell({
    row: desk.practiceExit('ETH'),
    strategyId: 'signals-spot-momentum-exit'
  });
  assert.equal(sale.strategyId, 'signals-spot-momentum-exit');
});


test('each closed candle stays one independent recommendation, newest first, keeping a selected older one', async () => {
  const { desk, state } = harness();
  const { rows:[row] } = await desk.readSignals({mode:'practice',symbols:['ETH']});
  const samples = Array.from({length:15}, (_,i) => ({
    ...row, closedAt:row.closedAt-i*60000, validUntil:row.closedAt+(1-i)*60000, id:'ETH:1m:'+i
  }));
  const options={mode:'practice',symbols:['ETH'],now:state.time,selectedId:samples.at(-1).id};
  const first=mergeLiteSignalFeed([],samples.slice(3),options);
  const merged=mergeLiteSignalFeed(first,[...samples.slice(0,4),samples[0]],options);
  assert.equal(merged.length,12);
  assert.equal(new Set(merged.map(r=>r.id)).size,12);
  assert.deepEqual(merged.slice(0,3),samples.slice(0,3));
  assert.equal(merged.at(-1).id,options.selectedId);
  assert.deepEqual(mergeLiteSignalFeed(merged,samples.slice(0,3),options),merged);
  assert.deepEqual(mergeLiteSignalFeed(merged,[],{...options,mode:'live'}),[]);
  assert.deepEqual(mergeLiteSignalFeed(merged,[],{...options,symbols:['BTC']}),[]);
  assert.deepEqual(mergeLiteSignalFeed(merged,[],{...options,now:state.time+86400001}),[]);
});

test('opens six current markets by default and rechecks the additional trading pairs', async () => {
  const { desk, state } = harness();
  const markets = ['ETH', 'BTC', 'SOL', 'BNB', 'XRP', 'DOGE'];
  for (const mode of ['live', 'practice']) {
    const { rows, history, failed } = await desk.readSignals({ mode });
    assert.deepEqual(rows.map(row => row.symbol), markets);
    assert.deepEqual(history, []);
    assert.deepEqual(failed, []);
    assert.equal(new Set(rows.map(row => row.id)).size, 6);
    assert.ok(rows.every(row => row.mode === mode && row.validUntil > state.time && Number.isFinite(row.price)));
  }
  assert.equal(state.candles, 6);
  const { rows } = await desk.readSignals();
  assert.equal(state.candles, 6);
  for (const row of rows.slice(3)) {
    state.tickerSymbol = row.symbol + 'USDT';
    const result = await desk.buy({ row, amount: '10.00' });
    assert.equal(result.receipt.symbol, row.symbol);
    assert.equal(result.receipt.signalId, row.id);
  }
  for (const count of [1, 2, 3]) {
    const { rows, history } = await desk.readSignals({ mode: 'practice', symbols: markets.slice(0, count) });
    assert.equal(rows.length, count);
    assert.equal(rows.length + history.length, 6);
    assert.ok(history.every(row => row.source === 'Practice' && row.validUntil <= state.time &&
      row.validUntil - row.closedAt === 15 * 60000));
    await assert.rejects(desk.buy({ row: history[0], amount: 25 }), /EXPIRED/);
  }
});

test('backfills filtered assets from actual earlier closes with no extra market request or future bars', async () => {
  const minute = 60_000;
  const close = Date.UTC(2026, 10, 26, 0, 2);
  const now = close + 4_000;
  const prices = Array.from({ length: 42 }, (_, index) => 60 + Math.sin(index / 2) * 4 + index / 2);
  const body = [...prices, 1500].map((price, index) => {
    const open = close + (index - prices.length) * minute;
    return [open, price, price + 1, price - 1, price, 23 + index, open + minute - 1];
  });
  const relay = (receivedAt, records) => ({ ok: true, json: async () =>
    ({ schema: 'public-market-relay-v1', resource: 'candles', receivedAt, body: records }) });
  let calls = 0;
  const desk = createLiteDesk({ now: () => now, fetchImpl: async () => { calls++; return relay(now, body); } });
  const { rows, history } = await desk.readSignals({ symbols: ['BTC'] });
  assert.equal(calls, 1);
  assert.equal(rows.length, 1);
  assert.equal(history.length, 5);
  assert.equal(rows[0].price, prices.at(-1));
  for (const [offset, row] of history.entries()) {
    const earlier = close - (offset + 1) * minute;
    assert.equal(row.closedAt, earlier);
    assert.equal(row.receivedAt, now);
    assert.equal(row.validUntil, earlier + minute);
    assert.equal(row.priceSeries.at(-1), prices.at(-2 - offset));
    const expected = await readLiveSignalObservation('BTC', { now: () => earlier + 4000,
      fetchImpl: async () => relay(earlier + 4000, body.filter(([open]) => open <= earlier)) });
    assert.deepEqual(row, { ...expected, receivedAt: now, mode: 'live' });
  }
  const narrowed = await desk.readSignals({ symbols: ['BTC','ETH'] });
  assert.equal(calls, 2);
  assert.deepEqual(narrowed.history.map(row => [row.symbol,row.closedAt]), [
    ['ETH',close-minute], ['BTC',close-minute], ['ETH',close-2*minute], ['BTC',close-2*minute]
  ]);
});

test('marks a relay snapshot spanning the minute boundary as history and never trades it', async () => {
  const minute = 60_000;
  const close = Math.floor(start / minute) * minute;
  const receivedAt = close - 1000;
  const body = Array.from({ length: 29 }, (_, index) => {
    const open = close - (29 - index) * minute;
    return [open, 100 + index, 101 + index, 99 + index, 100 + index, 4, open + minute - 1];
  });
  const fetchImpl = async url => {
    if (!url.includes('symbol=BTCUSDT')) throw Error('UNAVAILABLE');
    return { ok: true, json: async () => ({schema:'public-market-relay-v1',resource:'candles',body,receivedAt}) };
  };
  const desk = createLiteDesk({fetchImpl, now:()=>start, accountStore:async () => ({balance:10000,receipts:[]})});
  const {rows, history, failed} = await desk.readSignals();
  assert.equal(rows.length, 0);
  assert.equal(failed.length, 6);
  assert.equal(history.length, 6);
  assert.ok(history.every(row => row.symbol === 'BTC' && row.validUntil <= start));
  assert.equal(history[0].price, 127);
  assert.equal(history[0].validUntil, close);
  await assert.rejects(desk.buy({row:history[0],amount:25}), /EXPIRED/);
  await assert.rejects(readLiveSignalObservation('BTC',{fetchImpl,now:()=>start}),/STALE_MARKET/);
});
