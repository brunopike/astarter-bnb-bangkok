import snapshot from './brain-evidence/asset-catalog.json' with {type:'json'};
import rankSnapshot from './brain-evidence/market-cap-top20.json' with {type:'json'};
import {approvedTokenImageURL} from './brand-icons.mjs';
import {hourlySeries,normalizeHubResource} from './market-hub-data.mjs';
import {fetchWatchAssets, searchWatchAssets, watchAssetKey} from './market-watchlist.mjs';

const DEX = 'https://api.dexscreener.com';
const nativeChains = new Map(Object.entries({
  bitcoin:'bitcoin', ethereum:'ethereum', binancecoin:'bsc', solana:'solana',
  dogecoin:'dogecoin', cardano:'cardano', 'avalanche-2':'avalanche', sui:'sui', 'the-open-network':'ton',
  ripple:'xrpl',tron:'tron',zcash:'zcash',monero:'monero',stellar:'stellar',hyperliquid:'hyperliquid',
}));
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,149}$/.test(value);
const validChain = chain => typeof chain === 'string' && /^[a-z0-9][a-z0-9._-]{0,69}$/.test(chain);
const validAddress = value => typeof value === 'string' && value.length <= 420 && /^[a-zA-Z0-9_:+./=,@<>-]+$/.test(value) && !['.','..'].includes(value);
const label = (value,max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const quoteNumber = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const positiveOrZero = value => { const n=quoteNumber(value); return n!==null && n>=0 ? n : null; };
function addressIdentity(value,chain) {
  if (/^0x(?:[\da-f]{40}|[\da-f]{64})$/i.test(value)) return value.toLowerCase();
  if (chain==='sui' || chain==='aptos') {
    // Normalize only the hexadecimal package. Move module and struct names are case-sensitive.
    return value.replace(/^0x([\da-f]{1,64})(?=::)/i,(_,hex)=>'0x'+(hex.toLowerCase().replace(/^0+/,'')||'0'));
  }
  if (chain==='ton' && /^-?\d+:[\da-f]{64}$/i.test(value)) return value.toLowerCase();
  return value;
}

export function brainAssetKey(asset) {
  if (!asset || typeof asset !== 'object') return '';
  if (asset.address != null) {
    if (!validChain(asset.chain) || !validAddress(asset.address)) return '';
    // A Move type name and a base58/base64 identifier carry case-sensitive identity.
    return 'ca:'+asset.chain+':'+addressIdentity(asset.address,asset.chain);
  }
  return validId(asset.id) ? watchAssetKey(asset) : '';
}

function coinAsset(row, receivedAt=null) {
  if (!validId(row?.id) || !label(row.symbol,30) || !label(row.name,120)) return null;
  const chain=nativeChains.get(row.id)??null;
  const time=row.asOf!=null ? new Date(row.asOf) : null;
  return {
    id:row.id, symbol:row.symbol.toUpperCase(), name:row.name, chain, address:null, kind:chain?'native':'market',
    provider:'CoinGecko', sourceUrl:'https://www.coingecko.com/en/coins/'+encodeURIComponent(row.id),
    rank:Number.isSafeInteger(row.rank)&&row.rank>0?row.rank:null,cap:positiveOrZero(row.cap),image:approvedTokenImageURL(row.image),
    price:positiveOrZero(row.price), change:quoteNumber(row.change), volume:positiveOrZero(row.volume),
    liquidity:null, venue:null, series:hourlySeries(row.series),
    asOf:time && Number.isFinite(time.getTime())?time.toISOString():null, receivedAt,
  };
}

function marketCapRanking(body,at) {
  if(!Number.isFinite(at))throw new Error('INVALID_RANKING_TIME');
  const receivedAt=new Date(at).toISOString();
  const rows=normalizeHubResource('assets',body,at).data.filter(row=>Number.isInteger(row.rank)&&row.rank>=1&&row.rank<=20)
    .sort((a,b)=>a.rank-b.rank).map(row=>coinAsset(row,receivedAt));
  if(rows.length!==20||!rows.every((row,i)=>row?.rank===i+1 && row.cap>0))throw new Error('INCOMPLETE_RANKING');
  return {rows,at};
}
export const savedBrainRanking=marketCapRanking(rankSnapshot.body,rankSnapshot.receivedAt);
export async function fetchBrainRanking({signal,fetchImpl=globalThis.fetch}={}) {
  const timeout=AbortSignal.timeout(8000);
  const response=await fetchImpl('/api/market-hub?resource=assets',{signal:signal?AbortSignal.any([signal,timeout]):timeout,credentials:'omit'});
  if(!response.ok)throw new Error('MARKET_CAP_UNAVAILABLE');
  const data=await response.json();
  if(data.schema!=='public-market-relay-v1'||data.resource!=='assets')throw new Error('INVALID_RANKING_SOURCE');
  return marketCapRanking(data.body,data.receivedAt);
}

// An earlier visit may be all that is available on an offline reload. Restore
// only the public quote fields we persist, with the provider's original time.
export function readSavedBrainAsset(row) {
  if (!brainAssetKey(row) || !label(row.symbol,40) || !label(row.name,150)) return null;
  const iso=value=>typeof value==='string' && Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  const receivedAt=iso(row.receivedAt);
  if (!row.address) {
    if (row.provider!=='CoinGecko') return null;
    return coinAsset({...row,asOf:iso(row.asOf)},receivedAt);
  }
  if (row.provider!=='DEX Screener') return null;
  let source;
  try {source=new URL(row.sourceUrl);} catch {return null;}
  const pairPage=source.host==='dexscreener.com' && source.pathname.startsWith('/'+row.chain+'/');
  const apiPage=source.host==='api.dexscreener.com' && source.pathname==='/token-pairs/v1/'+row.chain+'/'+encodeURIComponent(row.address);
  if (source.protocol!=='https:' || source.username || source.password || (!pairPage && !apiPage)) return null;
  return {
    id:brainAssetKey(row),symbol:row.symbol,name:row.name,chain:row.chain,address:row.address,
    kind:'contract',provider:'DEX Screener',sourceUrl:source.href,price:positiveOrZero(row.price),
    change:quoteNumber(row.change),volume:positiveOrZero(row.volume),liquidity:positiveOrZero(row.liquidity),
    venue:label(row.venue,80)?row.venue:null,asOf:null,receivedAt,
  };
}

const searchAliases=new Map(Object.entries({比特币:'btc',以太坊:'eth',狗狗币:'doge',索拉纳:'sol',币安币:'bnb',瑞波币:'xrp',波场:'trx',门罗币:'xmr',莱特币:'ltc',泰达币:'usdt',艾达币:'ada'}));
function searchRank(asset,term) {
  const symbol=asset.symbol.toLowerCase(), name=asset.name.toLowerCase();
  if (symbol===term) return 1;
  if (name.startsWith(term)) return 2;
  if (symbol.startsWith(term)) return 3;
  if (name.includes(term) || symbol.includes(term) || (!asset.address && asset.id?.includes(term))) return 4;
  if (asset.chain?.includes(term)) return 5;
  return Infinity;
}

function dexAssets(body, receivedAt, {requested=null, term=null, includeQuotes=false}={}) {
  const pairs=Array.isArray(body)?body:body?.pairs;
  if (!Array.isArray(pairs) || pairs.length>3000) throw new Error('INVALID_DEX_RESPONSE');
  const found=new Map();
  for (const pair of pairs) {
    const chain=pair?.chainId;
    if (!validChain(chain)) continue;
    for (const side of includeQuotes?['baseToken','quoteToken']:['baseToken']) {
      const token=pair[side];
      if (!validAddress(token?.address) || !label(token.symbol,40) || !label(token.name,150)) continue;
      if (requested && (addressIdentity(token.address,chain)!==addressIdentity(requested.address,chain) || (requested.chain && requested.chain!==chain))) continue;
      const key=brainAssetKey({chain,address:token.address});
      const base=side==='baseToken';
      const price=base?quoteNumber(pair.priceUsd):null;
      if (base && !(price>0)) continue;
      const sourceUrl=validAddress(pair.pairAddress) ? 'https://dexscreener.com/'+chain+'/'+encodeURIComponent(pair.pairAddress)
        : DEX+'/token-pairs/v1/'+chain+'/'+encodeURIComponent(token.address);
      const asset={
        id:key, symbol:token.symbol.toUpperCase(), name:token.name, chain, address:token.address, kind:'contract',
        provider:'DEX Screener', sourceUrl, price, change:base?quoteNumber(pair.priceChange?.h24):null,
        volume:base?positiveOrZero(pair.volume?.h24):null, liquidity:base?positiveOrZero(pair.liquidity?.usd):null,
        venue:label(pair.dexId,80)?pair.dexId:null, asOf:null, receivedAt,
      };
      if(term!==null && !Number.isFinite(searchRank(asset,term))) continue;
      const prev=found.get(key);
      // A quote-side match establishes an identity, but the pair only prices its base token.
      if (!prev || (base && (prev.price===null || (asset.liquidity??-1)>(prev.liquidity??-1)))) found.set(key,asset);
    }
  }
  return [...found.values()].sort((a,b)=>(b.liquidity??-1)-(a.liquidity??-1));
}

export const brainCatalog = Object.freeze(snapshot.sources.flatMap(source=>{
  if(source.provider==='CoinGecko')return normalizeHubResource('assets',source.rows,Date.parse(source.receivedAt)).data.map(a=>coinAsset(a,source.receivedAt));
  return dexAssets(source.rows,source.receivedAt);
}).filter(Boolean).map(Object.freeze));

export async function loadBrainCatalog({signal}={}) {
  signal?.throwIfAborted();
  return [...brainCatalog];
}

async function dexRequest(path,{signal,fetchImpl=globalThis.fetch}={}) {
  const timeout=AbortSignal.timeout(6000);
  const response=await fetchImpl(DEX+path,{
    signal:signal?AbortSignal.any([signal,timeout]):timeout, credentials:'omit', cache:'no-store', headers:{Accept:'application/json'},
  });
  if (!response.ok) throw new Error('DEX_REQUEST_FAILED');
  const text=await response.text();
  if(text.length>2001000)throw new Error('DEX_RESPONSE_TOO_LARGE');
  return JSON.parse(text);
}

function searchAddress(query) {
  const scoped=/^ca:([^:]+):(.+)$/.exec(query);
  if(scoped && validChain(scoped[1]) && validAddress(scoped[2]))return {chain:scoped[1],address:scoped[2]};
  if (!validAddress(query)) return null;
  if (/^0x/i.test(query)) return /^0x(?:[\da-f]{40}|[\da-f]{64})$|^0x[\da-f]{1,64}::/i.test(query) ? {chain:null,address:query} : null;
  if (/^(?:[\w-]{32,64}$|-?\d+:[\da-f]{64}$|ibc\/)/i.test(query)) return {chain:null,address:query};
  return null;
}

export function canonicalBrainScope(value) {
  const address=typeof value==='string' && value.startsWith('ca:') && searchAddress(value);
  return address ? brainAssetKey(address) : value;
}

export function filterBrainCatalog(rows,query,chainName=chain=>chain) {
  const wanted=searchAddress(query);
  if(wanted)return rows.filter(row=>row.address && (!wanted.chain || row.chain===wanted.chain)
    && addressIdentity(row.address,row.chain)===addressIdentity(wanted.address,row.chain));
  if(query.startsWith('ca:'))return [];
  if(query.startsWith('coin:'))return rows.filter(row=>!row.address && brainAssetKey(row)===query);
  const term=searchAliases.get(query)??query.toLowerCase();
  return rows.filter(row=>Number.isFinite(searchRank(row,term)) || chainName(row.chain)?.toLowerCase().includes(term)
    || (row.address && (/^0x[\da-f]{40,64}$/i.test(row.address) ? row.address.toLowerCase().includes(term) : row.address.includes(query))));
}

export async function searchBrainAssets(value,options={}) {
  options.signal?.throwIfAborted();
  if(typeof value!=='string')return [];
  const query=value.trim();
  if(!query)return [...brainCatalog];
  if(!label(query,500))return [];
  const wanted=searchAddress(query), exactCoin=query.startsWith('coin:')?query.slice(5):null;
  if(/^0x.{10}/i.test(query) && !wanted)return [];
  if((query.startsWith('ca:')&&!wanted)||(exactCoin!==null&&!validId(exactCoin)))return [];
  const term=(exactCoin??searchAliases.get(query)??query).toLowerCase();
  const local=filterBrainCatalog(brainCatalog,query);
  const queryCoins=!wanted && term.length<=100, queryContracts=exactCoin===null;
  const cg=queryCoins ? searchWatchAssets(term,options).then(({rows})=>rows.map(a=>coinAsset(a)).filter(Boolean)) : Promise.resolve([]);
  const dexPath=wanted?.chain?'/token-pairs/v1/'+wanted.chain+'/'+encodeURIComponent(wanted.address):'/latest/dex/search?q='+encodeURIComponent(wanted?.address??searchAliases.get(query)??query);
  const dex=queryContracts ? dexRequest(dexPath,options).then(data=>dexAssets(data,new Date().toISOString(),{
    requested:wanted,term:wanted?null:term,includeQuotes:true,
  })) : Promise.resolve([]);
  const [coins,contracts]=await Promise.allSettled([cg,dex]);
  options.signal?.throwIfAborted();
  const combined=new Map(local.map(a=>[brainAssetKey(a),a]));
  if(coins.status==='fulfilled')for(const a of coins.value){
    const key=brainAssetKey(a);
    if(!combined.has(key) && (exactCoin!==null ? a.id===exactCoin : Number.isFinite(searchRank(a,term)))) combined.set(key,a);
  }
  if(contracts.status==='fulfilled')for(const a of contracts.value){
    const k=brainAssetKey(a);
    if(!combined.has(k) || a.price!==null)combined.set(k,a);
  }
  if(!combined.size && (!queryCoins || coins.status==='rejected') && (!queryContracts || contracts.status==='rejected')){
    throw new Error('BRAIN_ASSET_SEARCH_UNAVAILABLE');
  }
  const rows=[...combined.values()];
  if(!wanted && exactCoin===null)rows.sort((a,b)=>searchRank(a,term)-searchRank(b,term));
  return rows;
}

const evidenceFields=['price','change','volume','liquidity','venue','asOf','provider','sourceUrl','name','symbol'];

export function preferBrainEvidence(previous,next) {
  if (!previous) return next??null;
  if (!next || next.price===null || brainAssetKey(previous)!==brainAssetKey(next)) return previous;
  // An upstream cache can answer out of order. A repeated tick keeps its original receipt.
  if (previous.asOf && (!next.asOf || Date.parse(next.asOf)<Date.parse(previous.asOf))) return previous;
  if (previous.receivedAt && (!next.receivedAt || next.receivedAt<previous.receivedAt)) return previous;
  if (evidenceFields.some(field=>previous[field]!==next[field])) return next;
  const sample=next.series;
  if (sample?.length && (sample.length!==previous.series?.length || sample.some((price,i)=>price!==previous.series[i]))) return next;
  return previous;
}

async function refreshCoinRows(rows, options) {
  if (!rows.length) return [];
  const prices=await fetchWatchAssets(rows,options);
  const receivedAt=new Date().toISOString();
  return prices.rows.map((row,index)=>row===rows[index]?row:preferBrainEvidence(rows[index],coinAsset(row,receivedAt)));
}

async function refreshContractGroup(group, options) {
  const chain=group[0].chain;
  const addresses=group.map(row=>encodeURIComponent(row.address));
  // Single-token routes return the full pool list. The tokens endpoint accepts 30 identities per chain.
  const endpoint=group.length===1?'/token-pairs/v1/':'/tokens/v1/';
  const body=await dexRequest(endpoint+chain+'/'+addresses.join(','),options);
  const updates=new Map(dexAssets(body,new Date().toISOString()).map(row=>[brainAssetKey(row),row]));
  return group.map(row=>preferBrainEvidence(row,updates.get(brainAssetKey(row))));
}

export async function refreshBrainCatalog(rows=brainCatalog,options={}) {
  options.signal?.throwIfAborted();
  const current=new Map(), coins=[], chains=new Map();
  for(const row of rows){
    const key=brainAssetKey(row);
    if(!key)throw new TypeError('INVALID_BRAIN_ASSET');
    if(current.has(key))continue;
    current.set(key,row);
    if(!row.address){coins.push(row);continue;}
    if(!chains.has(row.chain))chains.set(row.chain,[]);
    chains.get(row.chain).push(row);
  }
  const batches=[];
  for(const assets of chains.values()){
    for(let i=0;i<assets.length;i+=30)batches.push(assets.slice(i,i+30));
  }
  function save(updated){for(const row of updated)current.set(brainAssetKey(row),row);}
  let next=0;
  async function runDexWorker(){
    while(next<batches.length){
      options.signal?.throwIfAborted();
      const group=batches[next++];
      try{save(await refreshContractGroup(group,options));}
      catch{options.signal?.throwIfAborted();}
    }
  }
  const workers=Array.from({length:Math.min(3,batches.length)},runDexWorker);
  const native=refreshCoinRows(coins,options).then(save);
  await Promise.allSettled([native,...workers]);
  options.signal?.throwIfAborted();
  return [...current.values()];
}

export async function refreshBrainAsset(asset,options={}) {
  const [updated]=await refreshBrainCatalog([asset],options);
  return updated;
}
