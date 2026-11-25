const BASE = 'https://ethereum-beacon-api.publicnode.com';
const HEADER = BASE + '/eth/v1/beacon/headers/finalized';
const METHOD = 'https://ethereum.github.io/beacon-APIs/#/Beacon/getStateValidators';
const GENESIS = 1606824023000, SLOT = 12000, EPOCH = SLOT * 32, STALE = 1800000;
const MAX_BODY = 6 * 1024 * 1024, TIMEOUT = 12500;
const GWEI = 1000000000n, MAX_EFFECTIVE = 2048n * GWEI, FAR_FUTURE = 18446744073709551615n;
export const PUBLIC_ETH_EXITS_SOURCE = Object.freeze({
  url: HEADER, provider: 'PublicNode', format: 'text', interval: EPOCH,
  stale: STALE, maxBytes: MAX_BODY, timeoutMs: TIMEOUT, cacheKey: 'eth-validator-exits:mainnet:v1',
  headers: Object.freeze({Accept: 'application/json'})
});
const COVERAGE = Object.freeze({
  network: 'Ethereum mainnet', scope: 'ACTIVE_EXITING', balanceBasis: 'effective_balance_gwei',
  finality: 'provider_reported_finalized', includesSlashed: false, includesWithdrawalSweep: false
});
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= FAR_FUTURE;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const check = valid => { if (!valid) throw Error('INVALID_ETH_VALIDATOR_EXITS'); };

function parse(text, max) {
  check(typeof text === 'string' && text.length > 0 && text.length <= max && new TextEncoder().encode(text).length <= max);
  return JSON.parse(text);
}
function finalized(body) {
  return body?.finalized === true && body.execution_optimistic === false;
}
function readHeader(text, now) {
  const h = parse(text, 10000), data = h?.data, signed = data?.header, msg = signed?.message;
  check(finalized(h) && data?.canonical === true && hash(data.root) && hash(msg?.state_root)
    && hash(msg.parent_root) && hash(msg.body_root) && /^0x[a-f0-9]{192}$/.test(signed.signature)
    && uint(msg.slot) && uint(msg.proposer_index));
  const finalizedSlot = Number(msg.slot), sourceAsOf = GENESIS + finalizedSlot * SLOT;
  check(Number.isSafeInteger(finalizedSlot) && finalizedSlot > 0 && Number.isSafeInteger(sourceAsOf + STALE)
    && sourceAsOf <= now + 1000 && now < sourceAsOf + STALE);
  return {finalizedSlot, epoch: Math.floor(finalizedSlot / 32), stateRoot: msg.state_root, blockRoot: data.root, sourceAsOf};
}
function ethString(value) {
  const remainder = String(value % GWEI).padStart(9, '0').replace(/0+$/, '');
  return String(value / GWEI) + (remainder ? '.' + remainder : '');
}
function aggregate(text, epoch) {
  const body = parse(text, MAX_BODY);
  check(exactKeys(body, ['finalized', 'execution_optimistic', 'data']) && finalized(body) && Array.isArray(body.data));
  const indices = new Set(), pubkeys = new Set(), epochBig = BigInt(epoch);
  let effective = 0n;
  for (const row of body.data) {
    const v = row?.validator;
    check(row?.status === 'active_exiting' && uint(row.index) && !indices.has(row.index)
      && /^0x[a-f0-9]{96}$/.test(v?.pubkey) && !pubkeys.has(v.pubkey) && v.slashed === false
      && uint(v.activation_epoch) && BigInt(v.activation_epoch) <= epochBig
      && uint(v.exit_epoch) && BigInt(v.exit_epoch) > epochBig && BigInt(v.exit_epoch) < FAR_FUTURE
      && uint(v.withdrawable_epoch) && BigInt(v.withdrawable_epoch) >= BigInt(v.exit_epoch)
      && uint(v.effective_balance) && BigInt(v.effective_balance) <= MAX_EFFECTIVE);
    indices.add(row.index);
    pubkeys.add(v.pubkey);
    effective += BigInt(v.effective_balance);
  }
  return {validatorCount: indices.size, effectiveGwei: String(effective), effectiveEth: ethString(effective)};
}
export function validateEthExits(body, now = Date.now()) {
  try {
    if (!exactKeys(body, ['schema','metric','symbol','unit','source','sourceUrl','methodUrl','coverage','finalizedSlot','epoch','stateRoot','blockRoot','sourceAsOf','validatorCount','effectiveGwei','effectiveEth','requestStartedAt','receivedAt','validUntil'])) return false;
    const {coverage, finalizedSlot, sourceAsOf, receivedAt, requestStartedAt, validatorCount} = body;
    return body.schema === 'eth-validator-exits-v1' && body.metric === 'eth-validator-exits' && body.symbol === 'ETH'
      && body.unit === 'ETH' && body.source === 'PublicNode' && body.sourceUrl === BASE && body.methodUrl === METHOD
      && exactKeys(coverage, Object.keys(COVERAGE)) && Object.entries(COVERAGE).every(([key, value]) => coverage[key] === value)
      && Number.isSafeInteger(finalizedSlot) && finalizedSlot > 0 && body.epoch === Math.floor(finalizedSlot / 32)
      && hash(body.stateRoot) && hash(body.blockRoot) && Number.isSafeInteger(sourceAsOf + STALE)
      && sourceAsOf === GENESIS + finalizedSlot * SLOT && body.validUntil === sourceAsOf + STALE
      && Number.isSafeInteger(requestStartedAt) && requestStartedAt > 0 && Number.isSafeInteger(receivedAt)
      && Number.isSafeInteger(now) && now > 0 && receivedAt <= now + 1000 && receivedAt >= requestStartedAt
      && receivedAt - requestStartedAt <= TIMEOUT && sourceAsOf <= receivedAt + 1000 && receivedAt < body.validUntil
      && Number.isSafeInteger(validatorCount) && validatorCount >= 0 && validatorCount <= MAX_BODY / 100
      && uint(body.effectiveGwei) && BigInt(body.effectiveGwei) <= BigInt(validatorCount) * MAX_EFFECTIVE
      && body.effectiveEth === ethString(BigInt(body.effectiveGwei));
  } catch { return false; }
}
export function publicEthExitsRequest(params) {
  if (!(params instanceof URLSearchParams) || params.size !== 0) return null;
  return {key: 'eth-validator-exits:mainnet', resource: 'eth-validator-exits', policy: PUBLIC_ETH_EXITS_SOURCE, async collect(load, now) {
    const requestStartedAt = now();
    const header = await load({url: HEADER, format: 'text', maxBytes: 10000});
    const binding = readHeader(header, now());
    const url = BASE + '/eth/v1/beacon/states/' + binding.stateRoot + '/validators?status=active_exiting';
    const rows = await load({url, format: 'text', maxBytes: MAX_BODY});
    const totals = aggregate(rows, binding.epoch), receivedAt = now();
    const result = {schema: 'eth-validator-exits-v1', metric: 'eth-validator-exits', symbol: 'ETH', unit: 'ETH',
      source: 'PublicNode', sourceUrl: BASE, methodUrl: METHOD, coverage: {...COVERAGE}, ...binding, ...totals,
      requestStartedAt, receivedAt, validUntil: binding.sourceAsOf + STALE};
    check(validateEthExits(result, receivedAt));
    return result;
  }};
}
