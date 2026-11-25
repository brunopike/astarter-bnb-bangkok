import {BTC_DISCLOSED_ADDRESSES} from './public-btc-disclosed.mjs';
import {ETH_DISCLOSED_ADDRESSES} from './public-eth-disclosed.mjs';

const HOUR = 3600000;
const MEMPOOL = 'https://mempool.space/api';
const BTC_SUMMARY_SIZE = 100;
const MAX_BTC_PAGES = 8;
const ROUTESCAN = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
const SOURCES = {
  BTC: {source: 'mempool.space', sourceUrl: 'https://mempool.space/docs/api/rest'},
  ETH: {source: 'Routescan', sourceUrl: 'https://routescan.io'}
};
// Membership comes only from the exchange's own dated publication. Ownership today is unverified.
const VENUES = [
  {
    exchange: 'Binance', disclosedOn: '2022-11-10',
    disclosureUrl: 'https://www.binance.com/en/blog/community/2895840147147652626',
    BTC: ['34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', '3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb', '3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6'],
    ETH: ['0x5a52e96bacdabb82fd05763e25335261b270efcb', '0x28c6c06298d514db089934071355e5743bf21d60', '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', '0x21a31ee1afc51d94c2efccaa2092ad1028285549']
  },
  {
    exchange: 'OKX', disclosedOn: '2026-10-31', disclosedAt: '2026-10-31T16:00:00Z',
    disclosureUrl: 'https://static.okx.com/cdn/okx/por/chain/por_csv_2026110100_V1.zip',
    BTC: ['bc1qf8kep70t232jtajg2x4r8dhtuvtd7kuea8ve9w02qy5k4wncyl7spmnfme'],
    ETH: ['0x92ea7496eba5f001d620005f88f3e8e686e3d4ea']
  },
  {
    exchange: 'Bybit', disclosedOn: '2022-12-10',
    disclosureUrl: 'https://static.bycustody.com/download/app/bybit_por_202212.csv',
    BTC: ['1GrwDkr33gT6LuumniYjKEGjTLhsL5kmqC'],
    ETH: ['0xee5b5b923ffce93a870b3104b7ca09c3db80047a', '0xf89d7b9c864f589bbf53a82105107622b35eaa40']
  },
  {
    exchange: 'Bitfinex', disclosedOn: '2022-12-12',
    disclosureUrl: 'https://github.com/bitfinexcom/pub/blob/83d06bdb5f5a2ce05d5ba2db5a426dd44c9f5128/wallets.txt',
    BTC: ['1Kr6QSydW9bFQG1mXiPNNu6WpJGmUa9i1g', '3JZq4atUahhuA9rLhXLMhhTo133J9rF97j', 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97'],
    ETH: ['0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec', '0x742d35cc6634c0532925a3b844bc454e4438f44e', '0xc61b9bb3a7a0767e3179713f3a5c7a9aedce193c', '0x876eabf441b2ee5b5b0554fd502a8e0600950cfa']
  },
  {
    exchange: 'Crypto.com', disclosedOn: '2022-11-11',
    disclosureUrl: 'https://crypto.com/en/company-news/transparency-first',
    BTC: BTC_DISCLOSED_ADDRESSES, ETH: ETH_DISCLOSED_ADDRESSES
  }
];

const hash = /^[a-f0-9]{64}$/;
const ethHash = /^0x[a-f0-9]{64}$/i;
const ethAddress = /^0x[0-9a-f]{40}$/i;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const digits = x => typeof x === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(x);
function requireData(yes) { if (!yes) throw Error('INCOMPLETE_SOURCE_DATA'); }
function units(value, decimals) {
  const n = value < 0n ? -value : value, scale = 10n ** BigInt(decimals);
  const tail = String(n % scale).padStart(decimals, '0').replace(/0+$/, '');
  return (value < 0n ? '-' : '') + String(n / scale) + (tail ? '.' + tail : '');
}

async function fetchJson(url, fetchImpl, signal, limit) {
  const response = await fetchImpl(url, {method: 'GET', credentials: 'omit', redirect: 'error', signal});
  if (response.status === 429) throw Error('PROVIDER_RATE_LIMIT');
  if (!response.ok) throw Error('SOURCE_UNAVAILABLE');
  requireData(!(Number(response.headers.get('content-length')) > limit));
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Error('INCOMPLETE_SOURCE_DATA'); }
      text += decoder.decode(value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

// The keyless Routescan plan permits two starts per second. Avoid hammering either
// host after a limit response, including queued reads from other exchanges.
function readerFor(asset, fetchImpl, signal) {
  let nextStart = 0, queue = Promise.resolve(), limited = false;
  return async (url, limit = 6_000_000) => {
    if (asset === 'ETH') {
      queue = queue.then(async () => {
        const delay = nextStart - Date.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        nextStart = Date.now() + 550;
      });
      await queue;
    }
    signal.throwIfAborted();
    if (limited) throw Error('PROVIDER_RATE_LIMIT');
    try { return await fetchJson(url, fetchImpl, signal, limit); }
    catch (error) { if (error.message === 'PROVIDER_RATE_LIMIT') limited = true; throw error; }
  };
}

async function bitcoinWindow(read, now) {
  const blocks = await read(MEMPOOL + '/v1/blocks', 200000);
  requireData(Array.isArray(blocks) && blocks.length >= 11);
  for (const [i, block] of blocks.slice(0, 11).entries()) {
    requireData(hash.test(block?.id) && integer(block.height) && integer(block.timestamp)
      && (!i || (blocks[i - 1].previousblockhash === block.id && blocks[i - 1].height === block.height + 1)));
  }
  requireData(Math.abs(now - blocks[0].timestamp * 1000) < 3 * HOUR);
  const confirmed = blocks.slice(5, 11), times = confirmed.map(block => block.timestamp * 1000);
  return {firstBlock: confirmed.at(-1).height, lastBlock: confirmed[0].height,
    windowStart: Math.min(...times), windowEnd: Math.max(...times),
    blocks: new Map(confirmed.map(block => [block.height, block.id]))};
}

async function bitcoinFlows(addresses, read, bounds, transactionCache) {
  const own = new Set(addresses), counted = new Set();
  let inflow = 0n, outflow = 0n, transferCount = 0, excludedMixedTxCount = 0;
  for (const address of addresses) {
    let cursor = '', previousHeight = Infinity;
    const seen = new Set();
    for (let page = 0; ; page++) {
      // Address summaries avoid downloading entire historic transactions for idle wallets.
      const url = MEMPOOL + '/address/' + address + '/txs/summary' + cursor + '?max_txs=' + BTC_SUMMARY_SIZE;
      const records = await read(url, 40000);
      requireData(Array.isArray(records) && records.length <= BTC_SUMMARY_SIZE);
      for (const record of records) {
        const height = record?.height, id = record?.txid;
        requireData(hash.test(id) && !seen.has(id) && integer(height) && height > 0 && height <= previousHeight);
        previousHeight = height; seen.add(id);
        if (height < bounds.firstBlock || height > bounds.lastBlock || counted.has(id)) continue;
        if (!transactionCache.has(id)) transactionCache.set(id, read(MEMPOOL + '/tx/' + id));
        const tx = await transactionCache.get(id);
        requireData(tx?.txid === id && tx.status?.confirmed === true && tx.status.block_height === height
          && tx.status.block_hash === bounds.blocks.get(height) && Array.isArray(tx.vin) && tx.vin.length && Array.isArray(tx.vout) && tx.vout.length);
        let ownInputs = 0, inputSum = 0n, outputSum = 0n, ownOutputs = 0n;
        for (const vin of tx.vin) {
          if (vin.is_coinbase === true) continue;
          requireData(vin.is_coinbase === false && integer(vin.prevout?.value) && typeof vin.prevout.scriptpubkey === 'string');
          inputSum += BigInt(vin.prevout.value);
          if (own.has(vin.prevout.scriptpubkey_address)) ownInputs++;
        }
        for (const output of tx.vout) {
          requireData(integer(output.value) && typeof output.scriptpubkey === 'string');
          outputSum += BigInt(output.value);
          if (own.has(output.scriptpubkey_address)) ownOutputs += BigInt(output.value);
        }
        requireData(ownInputs > 0 || ownOutputs > 0n || tx.vout.some(output => own.has(output.scriptpubkey_address)));
        counted.add(tx.txid);
        if (tx.vin.some(vin => vin.is_coinbase === true)) continue;
        requireData(integer(tx.fee) && inputSum === outputSum + BigInt(tx.fee));
        if (ownInputs > 0 && ownInputs < tx.vin.length) { excludedMixedTxCount++; continue; }
        if (ownInputs === 0 && ownOutputs > 0n) { inflow += ownOutputs; transferCount++; }
        if (ownInputs === tx.vin.length && outputSum > ownOutputs) { outflow += outputSum - ownOutputs; transferCount++; }
      }
      // The service can cap max_txs below the request. A short page alone proves nothing.
      if (previousHeight < bounds.firstBlock || records.length === 0) break;
      requireData(page + 1 < MAX_BTC_PAGES);
      cursor = '/' + records.at(-1).txid;
    }
  }
  return {inflow, outflow, transferCount, excludedMixedTxCount};
}

const route = params => ROUTESCAN + '?' + new URLSearchParams(params);
async function ethereumWindow(read, now) {
  const windowEnd = Math.floor((now - HOUR / 2) / HOUR) * HOUR, windowStart = windowEnd - HOUR;
  const atTime = async timestamp => {
    const r = await read(route({module: 'block', action: 'getblocknobytime', timestamp: timestamp / 1000 - 1, closest: 'before'}), 5000);
    requireData(r?.status === '1' && digits(r.result) && integer(Number(r.result)));
    return Number(r.result);
  };
  const [previous, lastBlock, finalized, indexed] = await Promise.all([atTime(windowStart), atTime(windowEnd),
    read(route({module: 'proxy', action: 'eth_getBlockByNumber', tag: 'finalized', boolean: false}), 300000),
    read('https://api.routescan.io/v2/network/mainnet/evm/1/transactions?limit=1', 300000)]);
  const indexedTx = indexed?.items?.[0];
  requireData(indexedTx?.chainId === '1' && ethHash.test(indexedTx.id) && integer(indexedTx.blockNumber)
    && indexedTx.blockNumber >= lastBlock && Date.parse(indexedTx.timestamp) >= windowEnd && Date.parse(indexedTx.timestamp) <= now + 60000);
  const h = finalized?.result;
  requireData(/^0x[0-9a-f]+$/i.test(h?.number) && /^0x[0-9a-f]+$/i.test(h.timestamp) && ethHash.test(h.hash)
    && Number(h.number) >= lastBlock && Number(h.timestamp) * 1000 >= windowEnd && Number(h.timestamp) * 1000 <= now + 60000
    && previous > 0 && lastBlock > previous && lastBlock - previous <= 300);
  return {firstBlock: previous + 1, lastBlock, windowStart, windowEnd};
}

async function ethereumFlows(addresses, read, bounds) {
  const own = new Set(addresses.map(a => a.toLowerCase())), counted = new Set();
  let inflow = 0n, outflow = 0n, transferCount = 0;
  for (const address of own) {
    const seen = new Set();
    for (let page = 1; ; page++) {
      const r = await read(route({module: 'account', action: 'txlist', address, startblock: bounds.firstBlock, endblock: bounds.lastBlock, page, offset: 100, sort: 'asc'}));
      if (r?.status === '0' && r.message === 'No transactions found' && Array.isArray(r.result) && !r.result.length) break;
      requireData(r?.status === '1' && r.message === 'OK' && Array.isArray(r.result) && r.result.length <= 100);
      for (const tx of r.result) {
        requireData(ethHash.test(tx?.hash) && !seen.has(tx.hash) && digits(tx.blockNumber) && Number(tx.blockNumber) >= bounds.firstBlock
          && Number(tx.blockNumber) <= bounds.lastBlock && digits(tx.timeStamp) && Number(tx.timeStamp) * 1000 >= bounds.windowStart
          && Number(tx.timeStamp) * 1000 < bounds.windowEnd && ['0','1'].includes(tx.isError) && digits(tx.value) && ethAddress.test(tx.from));
        seen.add(tx.hash);
        const from = tx.from.toLowerCase(), to = (tx.to || tx.contractAddress || '').toLowerCase();
        requireData(address === from || address === to);
        if (counted.has(tx.hash) || tx.isError === '1') continue;
        requireData(tx.txreceipt_status === '1' && ethAddress.test(to));
        counted.add(tx.hash);
        const value = BigInt(tx.value);
        if (!value || own.has(from) === own.has(to)) continue;
        if (own.has(from)) outflow += value; else inflow += value;
        transferCount++;
      }
      if (r.result.length < 100) break;
      requireData(page < 6);
    }
  }
  return {inflow, outflow, transferCount, excludedMixedTxCount: 0};
}

export async function loadAssetExchangeFlows(asset, {signal, fetchImpl = fetch, now = Date.now} = {}) {
  if (!Object.hasOwn(SOURCES, asset)) throw Error('UNSUPPORTED_ASSET');
  const deadline = AbortSignal.timeout(58000);
  const lifecycle = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const read = readerFor(asset, fetchImpl, lifecycle);
  const btc = asset === 'BTC';
  const bounds = await (btc ? bitcoinWindow : ethereumWindow)(read, now());
  const transactionCache = new Map();
  const rows = await Promise.all(VENUES.map(async venue => {
    const addresses = [...venue[asset]];
    const row = {exchange: venue.exchange, asset, addressCount: addresses.length, addresses, disclosedOn: venue.disclosedOn, disclosedAt: venue.disclosedAt || null, disclosureUrl: venue.disclosureUrl};
    try {
      const {inflow, outflow, transferCount, excludedMixedTxCount} = await (btc ? bitcoinFlows : ethereumFlows)(addresses, read, bounds, transactionCache);
      const decimals = btc ? 8 : 18;
      return {...row, status: 'available', inflow: units(inflow, decimals), outflow: units(outflow, decimals), net: units(inflow - outflow, decimals), transferCount, excludedMixedTxCount};
    } catch (error) {
      return {...row, status: 'unavailable', reason: error.message === 'PROVIDER_RATE_LIMIT' ? 'rate-limit' : 'incomplete', inflow: null, outflow: null, net: null, transferCount: null, excludedMixedTxCount: null};
    }
  }));
  signal?.throwIfAborted();
  return {asset, ...SOURCES[asset], firstBlock: bounds.firstBlock, lastBlock: bounds.lastBlock,
    windowStart: bounds.windowStart, windowEnd: bounds.windowEnd, receivedAt: now(), rows};
}
