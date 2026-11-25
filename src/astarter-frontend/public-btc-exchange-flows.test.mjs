import assert from 'node:assert/strict';
import test from 'node:test';
import {BTC_DISCLOSED_ADDRESSES as addresses} from './public-btc-disclosed.mjs';
import {publicBtcExchangeFlowsRequest, validateBtcExchangeFlows} from './public-btc-exchange-flows.mjs';

const day = 86400000, start = Date.UTC(2026, 10, 17), end = start + day, now = end + 7200000;
const id = n => n.toString(16).padStart(64, '0');
const tx = (n, value, height, time = start) => ({txid: id(n), value, height, time: time / 1000});
const old = tx(1, 19, 200, start - day - 8640000);
function fixture() {
  const tip = Array.from({length: 6}, (_, i) => ({id: id(801 - i), previousblockhash: id(800 - i), height: 650 - i, mediantime: end / 1000}));
  const anchor = {height: 360, hash: id(100), timestamp: new Date(start-day).toISOString()};
  const pages = addresses.map(() => [old]);
  return {tip, anchor, pages, load(urlOrSpec) {
    const url = typeof urlOrSpec === 'string' ? urlOrSpec : urlOrSpec.url;
    if (url.includes('/blocks/timestamp/')) return anchor;
    if (url.endsWith('/api/blocks')) return tip;
    const i = addresses.findIndex(address => url.endsWith('/' + address + '/txs/summary'));
    assert.notEqual(i, -1);
    return pages[i];
  }};
}
const request = () => publicBtcExchangeFlowsRequest(new URLSearchParams(), now);
test('the last full UTC day nets all six disclosed addresses by txid, preserving units, fees and non-monotonic header times', async () => {
  const f = fixture();
  f.pages[0] = [tx(5, 7, 572, end), tx(4, 9, 490, start-1000), tx(3, -301, 480), tx(2, 200, 471, start+1000), old];
  f.pages[1] = [tx(3, 300, 480), tx(2, -20, 471, start+1000), old];
  const result = await request().collect(f.load);
  assert.equal(result.inflowSats, 180); assert.equal(result.outflowSats, 1); assert.equal(result.txCount, 2);
  assert.equal(result.netSats, 179); assert.equal(result.windowStart, start);assert.equal(result.windowEnd, end);
  assert.equal(validateBtcExchangeFlows(result, now), true);
  assert.equal(validateBtcExchangeFlows({...result, netSats: 180}, now), false);
  assert.equal(validateBtcExchangeFlows(result, end + 2*day), false);
});
test('a genuine quiet day requires confirmation and history across the lower boundary for all six addresses', async () => {
  const f = fixture();
  assert.equal((await request().collect(f.load)).txCount, 0);
  for (const rows of [[], [tx(2, 1, 450)], [old, old], [tx(2, 1.2, 451), old], [tx(2, 3, 199), old]]) {
    f.pages[1] = rows;
    await assert.rejects(request().collect(f.load), /INVALID_BTC_DISCLOSED_FLOWS/);
  }
  f.pages[1] = [old]; f.tip[5].mediantime = end/1000-1;
  await assert.rejects(request().collect(f.load), /INVALID_BTC_DISCLOSED_FLOWS/);
  assert.equal(publicBtcExchangeFlowsRequest(new URLSearchParams('address=unknown'), now), null);
});
test('pagination uses only the last confirmed txid on the same allowlisted address', async () => {
  const f = fixture();
  f.pages[0] = Array.from({length:5000}, (_,i) => tx(i+2, 1, 470));
  let cursorUsed = false;
  const result = await request().collect(spec => {
    if (typeof spec === 'string' && spec.includes('?')) {
      assert.equal(spec, 'https://mempool.space/api/address/'+addresses[0]+'/txs/summary?after_txid='+id(5001));
      cursorUsed = true; return [old];
    }
    return f.load(spec);
  });
  assert.ok(cursorUsed); assert.equal(result.txCount, 5000);
});
