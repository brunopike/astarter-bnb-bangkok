import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiteDesk} from './lite-desk-data.mjs';
import {liveSignalCard,liveSignalDetail,liveSignalRow,signalClosePrice} from './live-signal-view.mjs';
import {liteStrategyCard,strategyForSignal} from './lite-strategy-cards.mjs';

const at = 1795700000000;
const desk = createLiteDesk({now: () => at});
const {rows} = await desk.readSignals({mode: 'practice', symbols: ['BTC','ETH','SOL']});
const eth = rows.find(row => row.symbol === 'ETH');
const sol = rows.find(row => row.symbol === 'SOL');

test('an executable card retains the exact market observation and stays distinct from a catalog bot', () => {
  const live = {...eth, mode: 'live', source: 'Binance Spot', id: 'ETH:1m:' + eth.closedAt};
  const full = liveSignalRow(live);
  const card = strategyForSignal(live, null, 'en', at);
  assert.equal(card.signalId, full.live.id);
  assert.equal(card.sourceSignalId, live.id);
  assert.equal(card.side, 'buy');
  assert.equal(card.id, 'signals-spot-momentum-entry');
  assert.equal(card.symbol, 'ETH');
  assert.equal(card.label, 'Spot momentum entry');
});

test('closing a position requires the matching held asset on a downward observation', () => {
  for (const holding of [null, 0, {symbol:'BTC',quantity:1}, {symbol:'SOL',quantity:0}]) {
    assert.equal(strategyForSignal(sol,holding,'zh',at).actionable,false);
  }
  const exit = strategyForSignal(sol,{symbol:'SOL',quantity:0.4},'zh',at);
  assert.equal(exit.side, 'sell');
  assert.equal(exit.id, 'signals-spot-momentum-exit');
  assert.equal(exit.label, '现货持仓退出');
  assert.equal(strategyForSignal({...sol,direction:'neutral'},4,'en',at).side,'watch');
});

test('stale, malformed and unsupported observations cannot populate the ticket', () => {
  for (const bad of [null,{...eth,closedAt:at + 1},{...eth,validUntil:at},{...eth,symbol:'NDX'},
    {...eth,market:'ETH/BTC'},{...eth,price:Infinity},{...eth,rsi14:null},{...eth,direction:'alert'}]) {
    assert.equal(strategyForSignal(bad,1,'en',at), null);
  }
});

test('Lite and Full share the observation, quote, metrics and price history with different actions', () => {
  const row = liveSignalRow(eth);
  const strategy = strategyForSignal(eth,null,'zh',at);
  const lite = liteStrategyCard(row,{selected:true,strategy,busy:true});
  const full = liveSignalCard(row,{selected:true});
  const price = `<strong class="dot-number">${signalClosePrice(eth.price)} <small>USDT</small></strong>`;
  for (const view of [lite, full, liveSignalDetail(row)]) assert.ok(view.includes(price));
  const line = /<path class="chart-light-line" d="[^"]+"/;
  assert.ok(full.match(line));
  assert.equal(lite.match(line)?.[0], full.match(line)[0]);
  for (const value of full.matchAll(/<dd>([^<]+)<\/dd>/g)) {
    assert.ok(lite.includes(value[0]));
  }
  assert.match(lite,/class="sig-current-marker"/);
  assert.match(lite,/data-ls="select"[^>]*disabled/);
  assert.match(lite,/data-ls="evidence"/);
  assert.match(lite,/本机演练|Local practice/);
  assert.match(lite,/datetime="[^"]+">[^<]+ UTC/);
  assert.doesNotMatch(lite,/data-track-(?:watch|open)|data-ls="source"/);
  assert.match(full,/data-track-watch="ETH"/);
  assert.doesNotMatch(full,/data-ls=/);
  const live = liveSignalRow({...eth,mode:'live',source:'Binance Spot'});
  assert.match(liteStrategyCard(live,{strategy}),/href="https:\/\/www.binance.com\/en\/trade\/ETH_USDT"/);
});

test('the Lite deck describes the actual entry and manual exit, with separate watch actions', () => {
  for (const [observation, holding, status, action, exit] of [
    [eth, null, 'Entry conditions met', 'Use strategy', 'confirm to sell the full position.'],
    [sol, null, 'Watching for entry', 'View signal', 'No position to close'],
    [sol, 2, 'Exit conditions met', 'Use strategy', 'Confirm to sell your full position.']
  ]) {
    const strategy = strategyForSignal(observation, holding, 'en', at);
    const html = liteStrategyCard(liveSignalRow(observation), { strategy, lang: 'en' });
    assert.ok(html.includes(status) && html.includes(action));
    assert.ok(html.includes(strategy.label));
    assert.ok(html.includes('data-lite-id="' + observation.id + '"'));
    assert.ok(html.includes('data-side="' + strategy.side + '"'));
    assert.ok(html.includes('datetime="' + new Date(observation.closedAt).toISOString() + '"'));
    assert.match(html, /close above EMA20, positive 5-bar change and RSI14 above 50\./i);
    assert.ok(html.includes(exit));
    assert.doesNotMatch(html, /ATR|take.profit|auto.sell/i);
  }
});
