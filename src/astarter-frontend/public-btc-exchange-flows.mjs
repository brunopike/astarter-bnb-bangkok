import {BTC_DISCLOSED_ADDRESSES} from './public-btc-disclosed.mjs';

const DAY = 86_400_000;
const BASE = 'https://mempool.space/api';
const HASH = /^[a-f0-9]{64}$/;
const MAX_SATS = 21_000_000 * 100_000_000;
const PAGE_SIZE = 5000;
const DISCLOSURE = 'https://crypto.com/en/company-news/transparency-first';
const SOURCE = 'https://mempool.space/docs/api/rest';
const summaryUrl = address => BASE + '/address/' + address + '/txs/summary';
const hour = 3_600_000;
const check = condition => { if (!condition) throw Error('INVALID_BTC_DISCLOSED_FLOWS'); };
const integer = Number.isSafeInteger;

export function validateBtcExchangeFlows(body, now = Date.now()) {
  return Boolean(body && body.metric === 'btc-disclosed-flows' && body.source === 'mempool.space'
    && body.sourceUrl === SOURCE && body.disclosureUrl === DISCLOSURE && body.addressCount === BTC_DISCLOSED_ADDRESSES.length
    && integer(body.windowStart) && body.windowStart > 0 && body.windowStart % DAY === 0
    && body.windowEnd === body.windowStart + DAY && body.windowEnd <= now && now - body.windowEnd < DAY * 2
    && [body.inflowSats, body.outflowSats, body.netSats, body.txCount].every(integer)
    && body.inflowSats >= 0 && body.outflowSats >= 0 && body.netSats === body.inflowSats - body.outflowSats
    && Math.abs(body.netSats) <= MAX_SATS && body.txCount >= 0
    && (body.txCount > 0 || (body.inflowSats === 0 && body.outflowSats === 0)));
}

export function publicBtcExchangeFlowsRequest(params, now = Date.now()) {
  if (!(params instanceof URLSearchParams) || params.size || !integer(now) || now < 2 * DAY) return null;
  const windowEnd = Math.floor(now / DAY) * DAY, windowStart = windowEnd - DAY;
  const key = 'btc-disclosed-flows:' + windowStart;
  return {
    resource: 'btc-disclosed-flows', key, policy: {interval: hour, stale: DAY, cacheKey: key, maxBytes: 1_200_000, timeoutMs: 12000},
    async collect(load) {
      // Heights establish traversal coverage even when adjacent block timestamps run backwards.
      const guardTime = windowStart - DAY, addresses = BTC_DISCLOSED_ADDRESSES;
      const [anchor, blocks, ...firstPages] = await Promise.all([
        load({url: BASE + '/v1/mining/blocks/timestamp/' + guardTime / 1000, maxBytes: 1000}),
        load({url: BASE + '/blocks', maxBytes: 10000}), ...addresses.map(address => load(summaryUrl(address)))
      ]);
      check(integer(anchor?.height) && anchor.height > 0 && HASH.test(anchor.hash)
        && Math.abs(Date.parse(anchor.timestamp) - guardTime) < hour * 3);
      // Once a six-deep block's median time reaches midnight, future blocks must be after the window.
      check(Array.isArray(blocks) && blocks.length >= 6 && blocks.slice(0, 6).every((block, i) =>
        HASH.test(block.id) && integer(block.height) && block.height > anchor.height && (!i ||
          blocks[i-1].previousblockhash === block.id && blocks[i-1].height === block.height + 1))
        && integer(blocks[5].mediantime) && blocks[5].mediantime * 1000 >= windowEnd);
      const transfers = new Map();
      await Promise.all(addresses.map(async (address, index) => {
        let page = firstPages[index], lastHeight = Infinity;
        const seen = new Set();
        for (let n = 0; n < 3; n++) {
          check(Array.isArray(page) && page.length > 0 && page.length <= PAGE_SIZE);
          for (const tx of page) {
            check(HASH.test(tx?.txid) && !seen.has(tx.txid) && integer(tx.height) && tx.height > 0
              && tx.height <= lastHeight && integer(tx.time) && tx.time > 0 && integer(tx.value) && Math.abs(tx.value) <= MAX_SATS);
            seen.add(tx.txid);
            lastHeight = tx.height;
            if (tx.time * 1000 < windowStart || tx.time * 1000 >= windowEnd) continue;
            check(tx.height > anchor.height && tx.height <= blocks[5].height);
            const entry = transfers.get(tx.txid);
            if (entry) {
              check(entry.height === tx.height && entry.time === tx.time);
              entry.value += tx.value;
            } else transfers.set(tx.txid, {height: tx.height, time: tx.time, value: tx.value});
          }
          if (lastHeight <= anchor.height) return;
          check(page.length === PAGE_SIZE && n < 2);
          page = await load(summaryUrl(address) + '?after_txid=' + page.at(-1).txid);
        }
      }));
      // One signed change per transaction across all six addresses cancels change and transfers within the set.
      let inflowSats = 0, outflowSats = 0;
      for (const {value} of transfers.values()) {
        check(integer(value) && Math.abs(value) <= MAX_SATS);
        if (value > 0) inflowSats += value;
        else outflowSats -= value;
      }
      const body = {metric: 'btc-disclosed-flows', source: 'mempool.space', sourceUrl: SOURCE, disclosureUrl: DISCLOSURE,
        windowStart, windowEnd, addressCount: addresses.length, txCount: transfers.size,
        inflowSats, outflowSats, netSats: inflowSats - outflowSats};
      check(validateBtcExchangeFlows(body, now));
      return body;
    }
  };
}
