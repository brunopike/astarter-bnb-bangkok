import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiteDesk} from './lite-desk-data.mjs';
import {liveSignalCard,liveSignalDetail,liveSignalRow,signalClosePrice} from './live-signal-view.mjs';
import {strategyForSignal} from './lite-strategy-cards.mjs';

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
  const lite = liveSignalCard(row,{selected:true,strategy,busy:true});
  const full = liveSignalCard(row,{selected:true});
  const price = `<strong class="dot-number">${signalClosePrice(eth.price)} <small>USDT</small></strong>`;
  for (const view of [lite, full, liveSignalDetail(row)]) assert.ok(view.includes(price));
  for(const fragment of [/<div class="sig-live-market">[\s\S]*?<dl class="sig-live-card-metrics">/,/<dl class="sig-live-card-metrics">.*?<\/dl>/]) {
    assert.equal(lite.match(fragment)?.[0], full.match(fragment)?.[0]);
    assert.ok(full.match(fragment));
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
  assert.match(liveSignalCard(live,{strategy}),/href="https:\/\/www.binance.com\/en\/trade\/ETH_USDT"/);
});
