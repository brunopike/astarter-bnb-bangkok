import {createHash} from 'node:crypto';
import {schnorr} from '@noble/curves/secp256k1';
import {
 BLUESKY_DID, BLUESKY_HANDLE, BLUESKY_RKEY, NOSTR_HEX, SOCIAL_POST_WINDOW_MS,
 SOCIAL_SEARCHES, DIRECT_SOCIAL_REFRESH_MS, blueskyProfile, detectSocialSymbols,
 nostrPermalink, shortSocialKey
} from './public-social-scope.mjs';

const appView = 'https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';
const relay = 'wss://relay.primal.net';
const relayTagGroups = [
 {tags:['bitcoin', 'btc', 'lightningnetwork'], limit:90},
 {tags:['ethereum', 'eth', 'solana', 'xrp', 'bnbchain', 'dogecoin', 'cardano', 'chainlink'], limit:40},
 {tags:['avax', 'sui', 'hyperliquid', 'arbitrum', 'monero', 'xmr', 'zcash', 'aave', 'uniswap'], limit:30}
];
const maxRelayNotes = relayTagGroups.reduce((sum, {limit}) => sum + limit, 0);
const topicEvidence = /\b(?:liquidity|(?:in|out)flows?|reserves?|issuance|staking|staked|validators?|upgrades?|protocol|etfs?|filings?|regulat\w+|treasur\w+|bank|holdings?|settlement|throughput|transactions?|fees?|rollups?|open interest|funding rate|liquidat\w+|spot volume|volatility|partnership|mainnet|on[- ]chain|mining|hashrate|supply|bridg\w+|governance|audit|custody|incentives?|integrat\w+|order book|adoption|privacy|developer|wallets?|nodes?|network|market(?: cap)?|issued|exchange)\b|(?:[$€£]\s?[\d,.]+|\d[\d,.]*\s?(?:%|bps\b|usd\b|usdt\b))|流动性|资金流|成交[量额]|升级|质押|主网|区块|链上|清算|监管|价格|交易|流動性|資金流|鏈上|監管|ETF|ροές|συναλλαγών|réserves|liquidité|liquidez|объем/iu;
const promotional = /\b(?:giveaway|airdrop|promo\s?code|referral|affiliate|sign up|register now|join (?:my|our)|claim (?:your|now|free)|verify your wallet|exclusive offer|presale|dm (?:me|us)|guaranteed returns?|deposit bonus|top pick|token scanner|new pair|join\s+telegram|paid round)\b|\b(?:more info|check it out|read the details)\s*[→➜]|[领領]取空投|扫码|邀[请請]码|回报保证|转发抽奖|返佣/iu;
const walletCampaign = /[?&](?:ref|referrer|referral|aff)=|\brewards? (?:program|campaign)\b|\bclaims? per wallet\b|\bjoin the event here\b/iu;
const blockedLabels = new Set(['!hide', '!warn', '!no-unauthenticated', 'porn', 'sexual', 'nudity', 'graphic-media', 'spam', 'scam', 'impersonation', 'misleading']);
const blocked = labels => Array.isArray(labels) && labels.some(label => label?.neg !== true && blockedLabels.has(label?.val));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const shortText = value => typeof value === 'string' && value.length <= 300 && value.trim() ? value.trim() : null;

function isRecent(at, observed) {
 return Number.isSafeInteger(at) && at <= observed && at > observed - SOCIAL_POST_WINDOW_MS;
}

function relevantExcerpt(text) {
 if (typeof text !== 'string' || text.length > 16_000 || promotional.test(text) || walletCampaign.test(text)) return null;
 const excerpt = text.replace(/\r\n/g, '\n')
  .replace(/https?:\/\/\S+/giu, '')
  .replace(/^[ \t]*[~*=—_.:-]{6,}[ \t]*\n?/gmu, '')
  .replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
 const prose = excerpt.replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(/\s+/gu, ' ').trim();
 if (prose.length < 32 || !topicEvidence.test(prose)) return null;
 const symbols = detectSocialSymbols(prose);
 if (!symbols.length) return null;
 const characters = Array.from(excerpt);
 return {symbols, title: characters.slice(0, 320).join('') + (characters.length > 320 ? '…' : '')};
}

async function readPosts(response) {
 const maxBytes = 768 * 1024;
 if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '') ||
     Number(response.headers.get('content-length')) > maxBytes || !response.body) {
  await response.body?.cancel();
  throw Error(response.status === 429 ? 'RATE_LIMIT' : 'UNAVAILABLE');
 }
 const reader = response.body.getReader();
 const decoder = new TextDecoder('utf-8', {fatal:true});
 let raw = '', size = 0;
 try {
  for (;;) {
   const {value, done} = await reader.read();
   if (done) break;
   size += value.byteLength;
   if (size > maxBytes) throw Error('INVALID_DATA');
   raw += decoder.decode(value, {stream:true});
  }
  const {posts} = JSON.parse(raw + decoder.decode());
  if (!Array.isArray(posts) || posts.length > 16) throw Error('INVALID_DATA');
  return posts;
 } finally {
  await reader.cancel().catch(() => {});
  reader.releaseLock();
 }
}

function blueskyPost(row, observedAt) {
 const {author, record} = row || {};
 if (record?.$type !== 'app.bsky.feed.post' || record.reply || blocked(row.labels) || blocked(author?.labels)) return null;
 const {did, handle} = author || {};
 if (typeof did !== 'string' || !BLUESKY_DID.test(did) || typeof handle !== 'string' ||
     handle.length > 253 || !BLUESKY_HANDLE.test(handle) || handle === 'handle.invalid') return null;
 const prefix = 'at://' + did + '/app.bsky.feed.post/';
 if (typeof row.uri !== 'string' || !row.uri.startsWith(prefix)) return null;
 const id = row.uri.slice(prefix.length);
 if (!BLUESKY_RKEY.test(id)) return null;
 const publishedAt = Date.parse(record.createdAt), indexedAt = Date.parse(row.indexedAt);
 if (!isRecent(publishedAt, observedAt) || !Number.isFinite(indexedAt) ||
     indexedAt < publishedAt - 60_000 || indexedAt > observedAt + 60_000) return null;
 const excerpt = relevantExcerpt(record.text);
 if (!excerpt) return null;
 const profile = blueskyProfile(did);
 return {
  ...excerpt, id, network:'Bluesky', creatorId:did, publishedAt, url:profile + '/post/' + id,
  author:{acct:handle, display_name:shortText(author.displayName) || handle, url:profile, bot:null},
  likes:count(row.likeCount), reposts:count(row.repostCount), replies:count(row.replyCount)
 };
}

export async function fetchBlueskyLatest(fetchImpl, signal, now = Date.now) {
 const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(4_500)]);
 const since = new Date(Math.floor(now() / DIRECT_SOCIAL_REFRESH_MS) * DIRECT_SOCIAL_REFRESH_MS - SOCIAL_POST_WINDOW_MS).toISOString();
 const reads = await Promise.allSettled(SOCIAL_SEARCHES.map(async ({query}) => {
  const url = appView + '?' + new URLSearchParams({q:query, sort:'latest', limit:'16', since});
  return readPosts(await fetchImpl(url, {headers:{Accept:'application/json'}, credentials:'omit', redirect:'error', signal:requestSignal}));
 }));
 const failedSymbols = SOCIAL_SEARCHES.filter((_, index) => reads[index].status === 'rejected').map(({symbol}) => symbol);
 if (failedSymbols.length === reads.length) throw Error('UNAVAILABLE');
 const observedAt = now();
 const posts = new Map();
 for (const [index, read] of reads.entries()) {
  if (read.status !== 'fulfilled') continue;
  const {symbol} = SOCIAL_SEARCHES[index];
  for (const row of read.value) {
   const post = blueskyPost(row, observedAt);
   if (post?.symbols.includes(symbol)) posts.set(post.url, post);
  }
 }
 return {observedAt, failedSymbols, posts:[...posts.values()]};
}

function nostrPost(row, observedAt) {
 const {id, pubkey, sig, created_at:seconds, kind, tags, content} = row || {};
 if (kind !== 1 || typeof id !== 'string' || !NOSTR_HEX.test(id) || typeof pubkey !== 'string' ||
     !NOSTR_HEX.test(pubkey) || typeof sig !== 'string' || !/^[a-f0-9]{128}$/.test(sig) ||
     !Number.isSafeInteger(seconds) || !isRecent(seconds * 1000, observedAt) || !Array.isArray(tags) ||
     tags.length > 36 || tags.some(tag => !Array.isArray(tag) || tag.length > 8 ||
        tag.some(value => typeof value !== 'string' || value.length > 2_048) ||
        ['e', 'q', 'content-warning'].includes(tag[0]) ||
        tag[0] === 't' && /^(?:nsfw|porn|adult)$/i.test(tag[1]))) return null;
 const excerpt = relevantExcerpt(content);
 if (!excerpt) return null;
 const hash = createHash('sha256').update(JSON.stringify([0, pubkey, seconds, kind, tags, content])).digest('hex');
 if (hash !== id || !schnorr.verify(sig, hash, pubkey)) return null;
 return {
  ...excerpt, id, network:'Nostr', creatorId:pubkey, publishedAt:seconds * 1000, url:nostrPermalink(id),
  author:{acct:shortSocialKey(pubkey), display_name:null, url:null, bot:null}, likes:null, reposts:null, replies:null
 };
}

// One bounded read subscription. EOSE marks the end of the relay's stored events.
export function fetchNostrLatest(signal, now = Date.now, Socket = WebSocket) {
 const timeout = AbortSignal.any([signal, AbortSignal.timeout(4_500)]);
 return new Promise((resolve, reject) => {
  if (timeout.aborted) { reject(Error('UNAVAILABLE')); return; }
  const socket = new Socket(relay), subscription = 'astarter-public-notes';
  const events = [];
  let finished = false;
  const fail = () => finish(false);
  function finish(complete) {
   if (finished) return;
   finished = true;
   timeout.removeEventListener('abort', fail);
   socket.close();
   if (!complete) { reject(Error('UNAVAILABLE')); return; }
   const observedAt = now();
   resolve({observedAt, posts:events.map(event => nostrPost(event, observedAt)).filter(Boolean)});
  }
  timeout.addEventListener('abort', fail, {once:true});
  socket.addEventListener('open', () => {
   if (finished) return;
   const since = Math.floor((now() - SOCIAL_POST_WINDOW_MS) / 1000);
   const filters = relayTagGroups.map(({tags, limit}) => ({kinds:[1], since, '#t':tags, limit}));
   try { socket.send(JSON.stringify(['REQ', subscription, ...filters])); } catch { fail(); }
  });
  socket.addEventListener('message', ({data}) => {
   if (finished || typeof data !== 'string' || data.length > 32_768) return;
   let message;
   try { message = JSON.parse(data); } catch { return; }
   if (!Array.isArray(message) || message[1] !== subscription) return;
   if (message[0] === 'EOSE') finish(true);
   else if (message[0] === 'CLOSED') fail();
   else if (message[0] === 'EVENT' && events.length < maxRelayNotes) events.push(message[2]);
  });
  socket.addEventListener('error', fail, {once:true});
  socket.addEventListener('close', fail, {once:true});
 });
}
