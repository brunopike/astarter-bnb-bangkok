import test from 'node:test';
import assert from 'node:assert/strict';
import { liteChatMessages, liteSignalFacts } from './lite-chat.mjs';

const close = Date.now() - 5000;
const live = {
  id: 'BTC:1m:' + close,
  symbol: 'BTC',
  market: 'BTC/USDT',
  period: '1m',
  source: 'Binance Spot',
  mode: 'live',
  direction: 'up',
  unit: 'USDT',
  price: 101.5,
  ema20: 100,
  momentumPct: 1.5,
  rsi14: 62,
  closedAt: close,
  validUntil: close + 60_000
};
const history = [
  { id: 'a', kind: 'facts', question: 'Why did this signal appear?', text: 'The close was above its EMA.' },
  { id: 'b', kind: 'model', question: 'What is the EMA?', text: 'An exponentially weighted average.' },
  { id: 'c', kind: 'pending', question: 'What changed for this asset?' }
];
test('signal explanations use observed values, units and the actual observation time', () => {
  const result = liteSignalFacts(live, 'why', 'en');
  for (const word of ['upward', '101.5 USDT', '62', '1.5%']) assert.ok(result.text.includes(word));
  assert.match(result.citation, /Binance Spot.*UTC/);
  assert.match(liteSignalFacts(live, 'expiry', 'en', live.validUntil).text, /expired/);
  const practice = liteSignalFacts({ ...live, mode: 'practice' }, 'why', 'zh');
  assert.match(practice.citation, /本机演练数据/);
  assert.doesNotMatch(practice.citation, /Binance/);
});

test('follow-up includes actual prior answers and only this signal’s public evidence', async () => {
  const messages = await liteChatMessages(
    history,
    { ...live, wallet: 'hidden-account', balance: 987654 },
    'en'
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user']
  );
  assert.equal(messages[1].content, history[0].text);
  assert.equal(messages[3].content, history[1].text);
  assert.match(messages.at(-1).content, /Binance Spot/);
  assert.match(messages.at(-1).content, /101.5 USDT/);
  assert.doesNotMatch(JSON.stringify(messages), /hidden-account|987654/);
});

test('practice stays separate from live sources and expired readings are marked', async () => {
  const messages = await liteChatMessages(history, { ...live, mode: 'practice', source: 'Practice' }, 'en');
  assert.match(messages.at(-1).content, /practice scenario/);
  assert.doesNotMatch(JSON.stringify(messages), /page=signals|Binance Spot/);
  const stale = await liteChatMessages(history, { ...live, validUntil: close }, 'en');
  assert.match(stale.at(-1).content, /expired/);
  assert.match(stale.at(-1).content, /"status":"unavailable"/);
});

test('general conversation works without a signal and keeps the prior reply', async () => {
  const messages = await liteChatMessages(history.slice(1), null, 'en');
  assert.equal(messages[1].content, history[1].text);
  assert.equal(messages.at(-1).content, history[2].question);
  assert.doesNotMatch(JSON.stringify(messages), /Binance|page=signals/);
});

test('a follow-up preserves the candle that supported each earlier answer', async () => {
  const earlier = { ...live, price: 99.25, closedAt: close - 60000, validUntil: close };
  const messages = await liteChatMessages([{ ...history[1], reading: earlier }, history[2]], live, 'en');
  assert.match(messages[0].content, /99\.25 USDT/);
  assert.doesNotMatch(messages[0].content, /101\.5 USDT/);
  assert.match(messages.at(-1).content, /101\.5 USDT/);
});
