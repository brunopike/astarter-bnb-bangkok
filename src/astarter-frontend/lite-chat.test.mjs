import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyLiteThreads, liteAssistantSource, liteSignalFacts, mountLiteChat } from './lite-chat.mjs';
import { normalizeChatStore } from './assistant-analysis.mjs';
import { assistantConversationMessages } from './assistant-chat-client.mjs';

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
test('signal explanations use observed values, units and the actual observation time', () => {
  const result = liteSignalFacts(live, 'why', 'en');
  for (const word of ['upward', '101.5 USDT', '62', '1.5%']) assert.ok(result.text.includes(word));
  assert.match(result.citation, /Binance Spot.*UTC/);
  assert.match(liteSignalFacts(live, 'expiry', 'en', live.validUntil).text, /expired/);
  const practice = liteSignalFacts({ ...live, mode: 'practice' }, 'why', 'zh');
  assert.match(practice.citation, /本机演练数据/);
  assert.doesNotMatch(practice.citation, /Binance/);
});

test('the Full assistant receives only the public fields from the selected live card', () => {
  const source = liteAssistantSource({ ...live, wallet: 'hidden-wallet', balance: 987654 }, null, 'en');
  const current = {id: 'now', mode: 'ask', question: 'What is the signal?', evidence: [source]};
  const messages = assistantConversationMessages([], current);
  assert.match(messages.at(-1).content, /Binance Spot/);
  assert.match(messages.at(-1).content, /101.5 USDT/);
  assert.doesNotMatch(JSON.stringify(messages), /hidden-wallet|987654/);
  assert.equal(source.status, 'observed');
  assert.equal(liteAssistantSource(live, null, 'en', live.validUntil).status, 'unavailable');
});

test('practice cards and receipts never cite public markets or expose order details', () => {
  const practice = liteAssistantSource({ ...live, mode: 'practice' }, null, 'en');
  assert.equal(practice.href, '');
  assert.equal(practice.status, 'unavailable');
  const latest = {id: 'now', mode: 'ask', question: 'What is this?', sources: [practice]};
  const messages = assistantConversationMessages([], latest);
  assert.match(messages[0].content, /local sample data/);
  assert.doesNotMatch(JSON.stringify(messages), /page=signals|Binance Spot/);
  const receipt = liteAssistantSource(null, {symbol: 'ETH', wallet: 'private', price: 123456}, 'en');
  assert.equal(receipt.title, 'ETH');
  assert.doesNotMatch(JSON.stringify(receipt), /private|123456|BTC/);
  assert.equal(liteAssistantSource(null, null), null);
});

test('refreshes change the selected card without remounting the Full assistant or altering a sent turn', () => {
  const host = {}, calls = [], en = {lang: 'en'};
  let source, mounts = 0;
  const view = mountLiteChat(host, {...en, mountAssistant(actual, read) {
    assert.equal(actual, host);
    source = read;
    mounts++;
    return {updateContext: () => calls.push(source()), destroy() { calls.push('disposed'); }};
  }});
  view.setSignal(live);
  const submitted = source();
  view.setSignal({...live, price: 99.25, closedAt: close + 60000});
  assert.match(source().text, /99.25 USDT/);
  assert.match(submitted.text, /101.5 USDT/);
  view.setSignal({...live, symbol: 'ETH'});
  assert.equal(source().symbol, 'ETH');
  view.setSignal(null);
  assert.equal(source(), null);
  assert.equal(mounts, 1);
  view.destroy();
  assert.equal(calls.at(-1), 'disposed');
});

test('migrated threads retain old drafts and replies alongside a full existing account history', () => {
  const prior = Array.from({length:12},(_,i)=>({id:'full-'+i,title:'Full '+i,draft:'Keep '+i,turns:[]}));
  const archived = legacyLiteThreads([
    {key:'practice/practice:exit:ETH:1234',draft:'My draft',turns:[{question:'Why?',kind:'facts',text:'A practiced move.',reading:{...live,symbol:'ETH',mode:'practice'}}]},
    {key:'live/BTC',turns:[{question:'Continue?',kind:'pending'}]},
    {key:'general',draft:'General draft',turns:[]}
  ], 'en');
  const restored = normalizeChatStore({schema:1,threads:[...prior,...archived,...archived],active:'full-3'});
  assert.equal(restored.active,'full-3');
  assert.deepEqual(restored.threads.slice(0,12).map(t=>t.draft), prior.map(t=>t.draft));
  assert.equal(restored.threads.length,15);
  assert.equal(restored.threads[12].draft,'My draft');
  assert.equal(restored.threads[12].asset,'ETH');
  assert.match(restored.threads[12].turns[0].sources[0].text,/local sample data/);
  assert.equal(restored.threads[12].turns[0].modelReply.text,'A practiced move.');
  assert.equal(restored.threads[13].turns[0].modelReply.state,'error');
  assert.equal(restored.threads[14].draft,'General draft');
});
