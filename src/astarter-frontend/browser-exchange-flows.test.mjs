import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadAssetExchangeFlows} from './browser-exchange-flows.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-11-18T21:55:00Z');
const btcTime = Math.floor(NOW / 1000);
const id = value => value.toString(16).padStart(64, '0');
const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
const binance = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
const binanceOther = '3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb';
const okx = 'bc1qf8kep70t232jtajg2x4r8dhtuvtd7kuea8ve9w02qy5k4wncyl7spmnfme';
const btcBlocks = Array.from({length: 15}, (_, i) => ({id: id(200 - i), previousblockhash: id(199 - i), height: 200 - i, timestamp: btcTime - i * 600}));
const output = (value, address) => ({value, scriptpubkey_address: address, scriptpubkey: '00'});
const input = (value, address) => ({is_coinbase: false, prevout: output(value, address)});
const tx = (n, vin, vout, fee) => ({txid: id(n), status: {confirmed: true, block_height: 192, block_hash: id(192)}, vin, vout, fee});

test('BTC reconciles external flow, fees, own change, cross-venue dedup and mixed inputs', async () => {
  const details = [
    tx(301, [input(701, 'outside')], [output(700, binance)], 1),
    tx(302, [input(800, binance)], [output(300, binanceOther), output(490, okx)], 10),
    tx(303, [input(200, binance), input(300, 'outside')], [output(499, 'outside')], 1),
    tx(304, [input(600, binance)], [output(599, binanceOther)], 1),
    tx(305, [{is_coinbase: true}], [output(500, binance)], 0)
  ];
  const fetched = new Map();
  const read = async (url, opts) => {
    assert.equal(opts.credentials, 'omit');
    if (url.endsWith('/v1/blocks')) return json(btcBlocks);
    if (url.includes('/tx/')) {
      const txid = url.split('/').at(-1);
      fetched.set(txid, (fetched.get(txid) || 0) + 1);
      return json(details.find(row => row.txid === txid));
    }
    const location = new URL(url);
    assert.equal(location.searchParams.get('max_txs'), '100');
    if (!location.pathname.endsWith('/summary')) return json([]);
    const address = location.pathname.split('/')[3];
    const txs = address === binance ? details : (address === binanceOther ? [details[1], details[3]] : (address === okx ? [details[1]] : []));
    return json(txs.map(t => ({height: 192, txid: t.txid})));
  };
  const d = await loadAssetExchangeFlows('BTC', {fetchImpl: read, now: () => NOW});
  assert.equal(d.rows.length, 5);
  assert.equal(d.lastBlock, 195); assert.equal(d.firstBlock, 190);
  const b = d.rows.find(row => row.exchange === 'Binance');
  assert.deepEqual([b.inflow, b.outflow, b.net, b.transferCount, b.excludedMixedTxCount], ['0.000007', '0.0000049', '0.0000021', 2, 1]);
  assert.equal(d.rows.find(row => row.exchange === 'OKX').inflow, '0.0000049');
  assert.equal(fetched.get(id(302)), 1);
  assert.ok(d.rows.every(row => row.status === 'available' && row.addressCount === row.addresses.length));
});

test('BTC short pages advance by path cursor until all blocks in the window are covered', async () => {
  const pages = [];
  const read = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/v1/blocks')) return json(btcBlocks);
    if (path.includes('/tx/')) return json(tx(410, [input(4001, 'outside')], [output(4000, binance)], 1));
    if (!path.includes(binance + '/')) return json([]);
    assert.equal(new URL(url).search, '?max_txs=100');
    const cursor = path.split('/summary')[1];
    pages.push(cursor);
    if (cursor === '') return json([{height: 199, txid: id(409)}]);
    if (cursor === '/' + id(409)) return json([{height: 192, txid: id(410)}]);
    if (cursor === '/' + id(410)) return json([{height: 189, txid: id(411)}]);
    throw Error('Unexpected cursor');
  };
  const result = await loadAssetExchangeFlows('BTC', {fetchImpl: read, now: () => NOW});
  assert.deepEqual(pages, ['', '/' + id(409), '/' + id(410)]);
  assert.equal(result.rows[0].inflow, '0.00004');
  assert.equal(result.rows[0].transferCount, 1);
});

test('BTC marks coverage unknown if the page budget ends above the observation window', async () => {
  let reads = 0;
  const read = async url => {
    if (url.endsWith('/v1/blocks')) return json(btcBlocks);
    if (!url.includes(binance + '/')) return json([]);
    return json([{height: 198, txid: id(600 + (++reads))}]);
  };
  const result = await loadAssetExchangeFlows('BTC', {fetchImpl: read, now: () => NOW});
  assert.equal(reads, 8);
  assert.equal(result.rows[0].status, 'unavailable');
  assert.equal(result.rows[0].net, null);
  assert.equal(result.rows[1].status, 'available');
});

test('a BTC detail missing prevout or mismatching the pinned block leaves the affected row unavailable', async () => {
  const read = async url => {
    if (url.endsWith('/v1/blocks')) return json(btcBlocks);
    if (url.includes('/tx/')) return json({...tx(301, [{}], [], 0), status: {confirmed: true, block_height: 192, block_hash: id(1)}});
    return json(url.includes(binance) ? [{height: 192, txid: id(301)}] : []);
  };
  const d = await loadAssetExchangeFlows('BTC', {fetchImpl: read, now: () => NOW});
  assert.equal(d.rows[0].status, 'unavailable'); assert.equal(d.rows[0].inflow, null);
  assert.ok(d.rows.slice(1).every(row => row.net === '0'));
});

test('rate limiting preserves unknown amounts and abort propagates to the caller', async () => {
  const read = async url => url.endsWith('/v1/blocks') ? json(btcBlocks) : json({}, 429);
  const d = await loadAssetExchangeFlows('BTC', {fetchImpl: read, now: () => NOW});
  assert.ok(d.rows.every(row => row.reason === 'rate-limit' && row.net === null));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadAssetExchangeFlows('BTC', {fetchImpl: read, signal: controller.signal}), {name: 'AbortError'});
});

const end = Date.parse('2026-11-18T21:00:00Z');
const eth1 = '0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec';
const eth2 = '0x742d35cc6634c0532925a3b844bc454e4438f44e';
const external = '0x' + '12'.repeat(20);
const transfer = (n, from, to, value, success = true) => ({
  hash: '0x' + id(n), from, to, value, blockNumber: '500', timeStamp: String((end - 60000) / 1000),
  txreceipt_status: success ? '1' : '0', isError: success ? '0' : '1'
});

function ethReader(rows, indexedBlock = 520) {
  return async url => {
    const p = new URL(url).searchParams;
    if (p.get('action') === 'getblocknobytime') return json({status: '1', result: p.get('timestamp') === String(end / 1000 - 1) ? '510' : '300'});
    if (p.get('tag') === 'finalized') return json({result: {number: '0x220', timestamp: '0x' + ((NOW - 600000) / 1000).toString(16), hash: '0x' + id(1)}});
    if (!p.has('action')) return json({items: [{id: '0x' + id(2), chainId: '1', timestamp: new Date(end + 60000).toISOString(), blockNumber: indexedBlock}]});
    const address = p.get('address');
    const list = rows.filter(tx => tx.from === address || tx.to === address);
    return json({status:'1', message:'OK', result:list});
  };
}

test('ETH accrues exact wei only on successful cross-boundary top-level calls', async () => {
  const rows = [
    transfer(1, external, eth1, '1000000000000000001'),
    transfer(2, eth1, external, '123456789012345678'),
    transfer(3, eth1, eth2, '900000000000000000'),
    transfer(4, eth1, external, '100000000000000000000', false),
    transfer(5, eth1, external, '0')
  ];
  const d = await loadAssetExchangeFlows('ETH', {fetchImpl: ethReader(rows), now: () => NOW});
  const b = d.rows.find(row => row.exchange === 'Bitfinex');
  assert.equal(d.windowStart, end - HOUR); assert.equal(d.windowEnd, end);
  assert.deepEqual([b.inflow, b.outflow, b.net, b.transferCount], ['1.000000000000000001', '0.123456789012345678', '0.876543210987654323', 2]);
  assert.ok(d.rows.every(row => row.status === 'available'));
});

test('an ETH index behind the reporting interval cannot turn an empty address into zero', async () => {
  await assert.rejects(loadAssetExchangeFlows('ETH', {fetchImpl: ethReader([], 501), now: () => NOW}), /INCOMPLETE/);
});
