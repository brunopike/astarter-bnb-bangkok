const RPC = 'https://bsc-dataseed.binance.org/';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const REFRESH_MS = 30_000;
const GUEST = Object.freeze({status: 'guest', address: null, usdt: 0, updatedAt: null});

export async function readWalletUsdt(address, signal, fetchImpl = globalThis.fetch) {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw Error('invalid-address');
  const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
  const response = await fetchImpl(RPC, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{to: USDT, data}, 'latest']}),
  });
  if (!response.ok) throw Error('balance-unavailable');
  const reply = await response.json();
  if (reply?.jsonrpc !== '2.0' || reply.id !== 1 || reply.error || typeof reply.result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(reply.result)) {
    throw Error('invalid-balance');
  }
  const units = BigInt(reply.result);
  const scale = 10n ** 18n;
  if (units / (10n ** 16n) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('invalid-balance');
  const whole = (units / scale).toString();
  const fraction = (units % scale).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

export function createWalletBalance({
  read = readWalletUsdt, now = Date.now, visible = () => true, notify = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let state = GUEST, expires = 0, nextRead = 0, pending = null, timer = null;
  function publish(next) {
    state = next;
    notify();
  }
  function schedule() {
    clearTimer(timer);
    if (!state.address || !visible()) return;
    const wakeAt = pending ? expires : Math.min(nextRead, expires);
    timer = setTimer(refresh, Math.max(0, wakeAt - now()));
  }
  function setIdentity(identity) {
    const match = /^wallet:56:(0x[0-9a-f]{40})$/i.exec(identity?.ownerRef || '');
    const address = match && Number.isFinite(identity.expiresAt) && identity.expiresAt > now()
      ? match[1].toLowerCase() : null;
    expires = address ? identity.expiresAt : 0;
    if (address !== state.address) {
      pending?.abort();
      pending = null;
      nextRead = 0;
      publish(address ? {status: 'loading', address, usdt: null, updatedAt: null} : GUEST);
    }
    return refresh();
  }
  async function refresh() {
    clearTimer(timer);
    const address = state.address;
    if (!address) return;
    if (expires <= now()) {
      setIdentity(null);
      return;
    }
    if (!visible()) return;
    if (pending || nextRead > now()) {
      schedule();
      return;
    }
    const controller = new AbortController();
    pending = controller;
    const deadline = setTimer(() => controller.abort(), 8_000);
    schedule();
    if (state.updatedAt !== null && now() - state.updatedAt >= REFRESH_MS * 2) {
      publish({status: 'loading', address, usdt: null, updatedAt: null});
    }
    try {
      const exactUsdt = await read(address, controller.signal);
      if (pending !== controller || expires <= now()) return;
      if (controller.signal.aborted || typeof exactUsdt !== 'string' || !/^(0|[1-9]\d{0,15})(\.\d{1,18})?$/.test(exactUsdt)) {
        throw Error('invalid-balance');
      }
      publish({status: 'ready', address, usdt: Number(exactUsdt), exactUsdt, updatedAt: now()});
    } catch {
      if (pending === controller && expires > now()) {
        publish({status: 'error', address, usdt: null, updatedAt: null});
      }
    } finally {
      clearTimer(deadline);
      if (pending === controller) {
        pending = null;
        nextRead = now() + REFRESH_MS;
        if (expires <= now()) setIdentity(null);
        else schedule();
      }
    }
  }
  return {setIdentity, refresh, snapshot: () => state.address && expires <= now() ? GUEST : state};
}

export const walletBalance = createWalletBalance({
  visible: () => !document.hidden && document.body.dataset.page === 'workbench',
  notify: () => document.dispatchEvent(new Event('hive:wallet-balance')),
});
