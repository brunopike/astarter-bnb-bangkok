import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalletBalance, readWalletUsdt} from './wallet-balance.mjs';

const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40);
const identity = (address, expiresAt = 1_000_000) => ({ownerRef: 'wallet:56:' + address, expiresAt});
const pendingRead = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return {promise, resolve, reject}; };
function setup(read) {
  let time = 1000, visible = true, timerId = 0;
  const timers = new Map();
  const balance = createWalletBalance({
    read, now: () => time, visible: () => visible,
    setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, {fn, at: time + delay}); return id; },
    clearTimer: id => timers.delete(id),
  });
  return {balance, timers, setTime(value) { time = value; }, setVisible(value) { visible = value; }};
}

test('the balance is obtained with one address-specific, read-only call to BSC USDT at latest', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://bsc-dataseed.binance.org/');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    const rpc = JSON.parse(options.body);
    assert.equal(rpc.method, 'eth_call');
    assert.deepEqual(rpc.params, [{to: '0x55d398326f99059ff775485246999027b3197955', data: '0x70a08231' + '0'.repeat(24) + a.slice(2)}, 'latest']);
    const units = 3_685_000_000_000_000_000n;
    return {ok: true, json: async () => ({jsonrpc: '2.0', id: 1, result: '0x' + units.toString(16).padStart(64, '0')})};
  };
  assert.equal(await readWalletUsdt(a, undefined, fetchImpl), '3.685');
  await assert.rejects(readWalletUsdt('invalid', undefined, fetchImpl), /invalid-address/);
});

test('invalid RPC payloads and HTTP errors cannot turn a failed read into a zero balance', async () => {
  const zero = '0x' + '0'.repeat(64);
  const rpc = async payload => readWalletUsdt(a, undefined, async () => ({
    ok: true, json: async () => ({jsonrpc: '2.0', id: 1, ...payload}),
  }));
  assert.equal(await rpc({result: zero}), '0');
  assert.equal(await rpc({result: '0x' + '1'.padStart(64, '0')}), '0.000000000000000001');
  assert.equal(await rpc({result: '0x' + (313590440421159705863770n).toString(16).padStart(64, '0')}), '313590.44042115970586377');
  for (const payload of [{result: '0x'}, {result: [zero]}, {result: zero, id: 2}, {result: zero, error: {code: -1}}]) {
    await assert.rejects(rpc(payload), /invalid-balance/);
  }
  await assert.rejects(readWalletUsdt(a, undefined, async () => ({ok: false})), /balance-unavailable/);
});

test('guests see zero without a read, including expired identities and other networks', async () => {
  let calls = 0;
  const {balance, timers} = setup(async () => { calls++; return '50'; });
  for (const value of [null, identity(a, 999), {ownerRef: 'wallet:1:' + a, expiresAt: 99999}, {ownerRef: 'team:123'}]) {
    await balance.setIdentity(value);
    assert.deepEqual(balance.snapshot(), {status:'guest', address:null, usdt:0, updatedAt:null});
  }
  assert.equal(calls, 0);
  assert.equal(timers.size, 0);
});

test('reads deduplicate, refresh on a visible 30-second cadence, and recover from an unavailable reading', async () => {
  let calls = 0;
  const {balance, timers, setTime, setVisible} = setup(async () => {
    calls++;
    if (calls === 2) throw Error('offline');
    return calls === 1 ? '3.69' : '0';
  });
  const first = balance.setIdentity(identity(a));
  assert.equal(balance.snapshot().status, 'loading');
  await balance.setIdentity(identity(a));
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(balance.snapshot(), {status:'ready', address:a, usdt:3.69, exactUsdt:'3.69', updatedAt:1000});
  const [tick] = timers.values();
  assert.equal(tick.at, 31000);
  setTime(tick.at);
  await tick.fn();
  assert.deepEqual(balance.snapshot(), {status:'error', address:a, usdt:null, updatedAt:null});
  setTime(61000);
  setVisible(false);
  await balance.refresh();
  assert.equal(calls, 2);
  setVisible(true);
  await balance.refresh();
  assert.deepEqual(balance.snapshot(), {status:'ready', address:a, usdt:0, exactUsdt:'0', updatedAt:61000});
  await balance.setIdentity(null);
  assert.equal(timers.size, 0);
  assert.equal(balance.snapshot().usdt, 0);
});

test('switching wallets, logging out and session expiry discard previous on-chain responses', async () => {
  const requests = [];
  const {balance, setTime} = setup((address, signal) => {
    const request = pendingRead();
    requests.push({...request, address, signal});
    return request.promise;
  });
  const first = balance.setIdentity(identity(a));
  const second = balance.setIdentity(identity(b));
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(balance.snapshot().address, b);
  requests[0].resolve('500');
  await first;
  assert.equal(balance.snapshot().usdt, null);
  requests[1].resolve('2');
  await second;
  assert.equal(balance.snapshot().usdt, 2);
  const third = balance.setIdentity(identity(a));
  await balance.setIdentity(null);
  assert.equal(balance.snapshot().usdt, 0);
  requests[2].resolve('99');
  await third;
  assert.equal(balance.snapshot().status, 'guest');
  const expired = balance.setIdentity(identity(a, 1010));
  setTime(1011);
  requests[3].resolve('420');
  await expired;
  assert.equal(balance.snapshot().status, 'guest');
});
