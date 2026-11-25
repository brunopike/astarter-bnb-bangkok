import {crossMarketPolicy,normalizeCrossMarket,publicGoldSpotRequest} from './cross-market-data.mjs';
import {HUB_RESOURCES,normalizeHubResource,hubRetryDelay} from './market-hub-data.mjs';
import {coinMarketCapRequest} from './market-source-adapters.mjs';
import {candleRequest,normalizeKlines,CANDLE_PERIODS} from './trading-chart-data.mjs';
import {normalizeSpotDepth} from './spot-depth-data.mjs';
import {publicQuery} from './public-data-client.mjs';
import {PUBLIC_NEWS_SOURCE,parsePublicNews,projectPublicNews} from './public-news.mjs';
import {PUBLIC_SOCIAL_SOURCE,normalizePublicSocial,projectPublicSocial} from './public-social.mjs';
import {publicDerivativesRequest,publicChainInsightRequest,ETH_TRANSFER_RPC} from './public-market-extended.mjs';
import {publicLightningRequest} from './public-lightning.mjs';
import {publicEthDisclosedRequest,isEthDisclosedRpcSpec} from './public-eth-disclosed.mjs';
import {publicEthExitsRequest} from './public-eth-exits.mjs';
import {publicEthActiveBalanceRequest} from './public-eth-consensus.mjs';
import {publicExchangeReservesRequest} from './public-exchange-reserves.mjs';
import {publicExchangeFlowsRequest} from './public-exchange-flows.mjs';
import {publicBtcDisclosedRequest} from './public-btc-disclosed.mjs';
import {publicBtcExchangeFlowsRequest} from './public-btc-exchange-flows.mjs';
import {publicMacroRequest,publicMacroSeriesRequest} from './public-macro.mjs';
import {publicEthEtfHoldingsRequest} from './public-eth-etf-holdings.mjs';
import {publicEtfRequest} from './public-etf.mjs';
import {publicTraderRequest} from './public-traders.mjs';

const ALLOWED=new Set(['global','assets','tickers','categories','exchanges','sentiment','chains','stablecoins','tvl']);
const extended={
 'gold-spot':publicGoldSpotRequest,
 'exchange-reserves':publicExchangeReservesRequest,
 'exchange-netflow':publicExchangeFlowsRequest,
 'btc-disclosed-flows':publicBtcExchangeFlowsRequest,
 derivatives:publicDerivativesRequest,'chain-insight':(params,at)=>publicLightningRequest(params)??publicChainInsightRequest(params,at),'btc-disclosed-balance':publicBtcDisclosedRequest,'eth-active-balance':publicEthActiveBalanceRequest,'eth-validator-exits':publicEthExitsRequest,'eth-disclosed-balance':publicEthDisclosedRequest,
 macro:publicMacroRequest,'macro-series':publicMacroSeriesRequest,'eth-etf-holdings':publicEthEtfHoldingsRequest,etf:publicEtfRequest,traders:publicTraderRequest
};
function resolveRequest(url,now){
 const key=url.searchParams.get('resource');
 if(url.searchParams.getAll('resource').length!==1)return null;
 if(Object.hasOwn(extended,key)){
  const params=new URLSearchParams(url.searchParams);params.delete('resource');
  return extended[key](params,now);
 }
 if(['news','social','social-sample'].includes(key)){
  const params=new URLSearchParams(url.searchParams);params.delete('resource');let query;
  try{query=publicQuery(key==='social-sample'?'social':key,params);}catch{return null;}
  const news=key==='news';
  return {key,resource:key,policy:news?PUBLIC_NEWS_SOURCE:PUBLIC_SOCIAL_SOURCE,decode:(raw,at)=>news?parsePublicNews(raw[0],at):normalizePublicSocial(raw,at),validate:()=>{},project:(snapshot,at)=>news?projectPublicNews(snapshot.body,query,at):projectPublicSocial(snapshot.body,query,at)};
 }
 if(key==='spot-depth'&&url.searchParams.size===2){
  const symbol=url.searchParams.get('symbol');if(!['BTC','ETH','SOL'].includes(symbol))return null;
  return {key:`spot-depth:${symbol}`,resource:key,policy:{url:`https://data-api.binance.vision/api/v3/depth?symbol=${symbol}USDT&limit=100`,interval:10000,maxBytes:20000},decode:(raw,at,started)=>normalizeSpotDepth(raw[0],symbol,{requestStartedAt:started,receivedAt:at}),validate:()=>{}};
 }
 if(key==='cross-candles'&&url.searchParams.size===2){
  const symbol=url.searchParams.get('symbol'),policy=crossMarketPolicy(symbol,now);
  return policy?{key:`cross-candles:${symbol}`,resource:key,policy,decode:(raw,at)=>normalizeCrossMarket(policy.urls.length===1?raw[0]:raw,symbol,at),validate:()=>{}}:null;
 }
 if(key==='candles'&&url.searchParams.size===3){
  const symbol=url.searchParams.get('symbol'),interval=url.searchParams.get('interval'),period=Object.keys(CANDLE_PERIODS).find(p=>p.toLowerCase()===interval);
  const request=/^[A-Z0-9]{2,18}USDT$/.test(symbol||'')&&period?candleRequest({market:symbol.slice(0,-4)+'/USDT',period}):null;
  if(!request)return null;
  return {key:`candles:${symbol}:${interval}`,resource:key,policy:{url:`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=300`,interval:5000,maxBytes:200000},validate:body=>normalizeKlines(body,request)};
 }
 if(ALLOWED.has(key)&&url.searchParams.size===1){
  const cmc=coinMarketCapRequest(key);
  const base={key,resource:key,policy:cmc?{...HUB_RESOURCES[key],maxBytes:cmc.maxBytes}:HUB_RESOURCES[key],validate:(body,at)=>normalizeHubResource(key,body,at)};
  return cmc?{...base,source:cmc.source,collect:cmc.collect}:base;
 }
 if(url.searchParams.size!==2)return null;
 if(key==='search'){
  const query=url.searchParams.get('query')?.trim();if(!query||query.length>100||/[\u0000-\u001f]/.test(query))return null;
  return {key:key+':'+query.toLowerCase(),resource:key,policy:{url:'https://api.coingecko.com/api/v3/search?query='+encodeURIComponent(query),interval:60000,maxBytes:400000},validate:body=>{if(!Array.isArray(body?.coins)||body.coins.length>2500)throw Error('INVALID_DATA');}};
 }
 if(key==='watch-assets'){
  const ids=url.searchParams.get('ids')?.split(',');if(!ids?.length||ids.length>100||ids.some(id=>!/^[a-z0-9][a-z0-9._-]{0,149}$/.test(id)))return null;
  const unique=[...new Set(ids)].sort().join(',');return {key:key+':'+unique,resource:key,policy:{url:'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids='+encodeURIComponent(unique)+'&per_page=100&sparkline=true&price_change_percentage=24h,7d',interval:60000,maxBytes:2000000},validate:(body,at)=>normalizeHubResource('assets',body,at)};
 }
 return null;
}

async function readSourceText(response,maxBytes){
 const reader=response.body?.getReader();
 if(!reader){
  const text=await response.text();
  if(Buffer.byteLength(text)>maxBytes)throw Error('INVALID_DATA');
  return text;
 }
 const decoder=new TextDecoder('utf-8',{fatal:true});
 const chunks=[];
 let bytes=0,complete=false;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done){complete=true;break;}
   bytes+=value.byteLength;
   if(bytes>maxBytes)throw Error('INVALID_DATA');
   chunks.push(decoder.decode(value,{stream:true}));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
 }finally{
  if(!complete)void reader.cancel().catch(()=>{});
  else reader.releaseLock();
 }
}

// Fixed public resources come from closed lists, so they stay outside the 100 caller-chosen slots: never evicted by caller keys, never refused BUSY.
// Search, watch-assets, candles and a trader address are chosen by the caller and stay in those slots.
const FIXED=new Set([...ALLOWED,'news','social','social-sample','spot-depth','cross-candles','derivatives','chain-insight','btc-disclosed-balance',
 'eth-active-balance','eth-validator-exits','eth-disclosed-balance','macro','macro-series','eth-etf-holdings','etf','gold-spot','exchange-reserves','exchange-netflow','btc-disclosed-flows']);
function fixedKey({key,resource}){return FIXED.has(resource)||key==='traders';}
// Disclosed BTC flows read one closed UTC day, so their fixed key moves each day; when the next day's slot is created, idle slots of that resource's other days are dropped.
const DAILY=new Set(['btc-disclosed-flows']);
// A required source's Retry-After holds its provider (host) until it ends, also after the slot that received it is evicted.
// A hold set by a fixed resource holds every relay key of that host. A hold set by a caller-chosen key holds only the caller-chosen keys
// of that host, so one caller request cannot pause the fixed resources for every user; a fixed read that is limited sets its own hold.
// An optional source's answer sets no hold, as it sets no slot back-off; a hold in a read's scope still answers its optional reads of that provider without calling it.
// The release archives that macro reads after its calendar are optional reads too: they set no hold, and a held host is not called.
function sourceHost(source){try{return new URL(typeof source==='string'?source:source.url).host;}catch{return '';}}
function holdProvider(holds,url,status,until,at){
 const host=sourceHost(url);
 if(host&&until>at&&!(holds.get(host)?.until>=until))holds.set(host,{until,status});
}
// A read sees the holds of its scope; when two of them hold one host, the longer one answers.
function hostHold(scope,host,at){let held=null;for(const holds of scope){const hold=holds.get(host);if(hold?.until>at&&!(held?.until>=hold.until))held=hold;}return held;}
// The first held required source answers; while another of its sources stays held, the next read is answered again.
function providerHold(scope,policy,at){
 for(const source of policy.urls||[policy.url]){const held=source?.optional?null:hostHold(scope,sourceHost(source),at);if(held)return held;}
 return null;
}
function holdingFetch(fetchImpl,scope,now){
 return (url,options)=>{
  const at=now(),held=hostHold(scope,sourceHost(url),at);
  return held?{ok:false,status:held.status,headers:{get:name=>name==='Retry-After'?String(Math.ceil((held.until-at)/1000)):null}}:fetchImpl(url,options);
 };
}

export function createMarketHubRelay({fetchImpl=globalThis.fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,cache=null}={}){
 const fixedSlots=new Map(),callerSlots=new Map(),holds=new Map(),callerHolds=new Map();
 return async function handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1');if(url.pathname!=='/api/market-hub')return false;
  const send=(status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body));return true;};
  if(req.method!=='GET')return send(405,{error:'METHOD_NOT_ALLOWED'},{Allow:'GET'});
  const request=resolveRequest(url,now());if(!request)return send(400,{error:'UNKNOWN_RESOURCE'});
  const {key,resource,policy}=request,caller=!fixedKey(request),slots=caller?callerSlots:fixedSlots,scope=caller?[holds,callerHolds]:[holds],sourceFetch=holdingFetch(fetchImpl,scope,now);
  if(slots===callerSlots&&slots.size>=100&&!slots.has(key)){const idle=[...slots].find(([,slot])=>!slot.pending);if(idle)slots.delete(idle[0]);else return send(429,{error:'BUSY'},{'Retry-After':'5'});}
  if(!slots.has(key)&&DAILY.has(resource))for(const [old,slot] of slots)if(old!==key&&old.startsWith(resource+':')&&!slot.pending)slots.delete(old);
  if(!slots.has(key))slots.set(key,{snapshot:null,pending:null,retryAt:0,status:502,failures:0});
  const s=slots.get(key);
  const cacheKey=cache&&policy.cacheKey;
  const record=snapshot=>{s.snapshot=snapshot;s.retryAt=0;s.status=200;s.failures=0;};
  const snapshot=()=>send(200,request.project?request.project(s.snapshot,now()):s.snapshot);
  if(s.snapshot&&now()-s.snapshot.receivedAt<policy.interval)return snapshot();
  if(s.retryAt>now())return send(s.status,{error:'PUBLIC_SOURCE_UNAVAILABLE'},{'Retry-After':String(Math.ceil((s.retryAt-now())/1000))});
  if(!s.pending)s.pending=(async()=>{
   s.status=502;
   if(cacheKey){
    const saved=await cache.get(cacheKey).catch(()=>null);
    const age=now()-saved?.receivedAt;
    if(saved?.schema==='public-market-relay-v1'&&saved.resource===resource&&saved.body&&age>=0&&age<policy.interval){record(saved);return;}
   }
   const hold=request.collect?null:providerHold(scope,policy,now());
   if(hold){s.status=hold.status;s.retryAt=hold.until;return;}
   const controller=new AbortController(),signal=controller.signal;
   let timer;const timeout=new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('SOURCE_TIMEOUT')),{once:true});timer=setTimer(()=>controller.abort(),policy.timeoutMs??8000);});
   try{
    const parts=[],headers=[],requestStartedAt=now(),sources=policy.urls||[policy.url];
    async function load(source,i){
     const spec=typeof source==='string'?{url:source}:source;
     try{
      const options={credentials:'omit',redirect:'error',headers:{Accept:'application/json',...policy.headers,...spec.headers},
       signal:spec.timeoutMs?AbortSignal.any([signal,AbortSignal.timeout(spec.timeoutMs)]):signal};
      if(process.env.COINGECKO_API_KEY){try{const target=new URL(spec.url);if(target.hostname==='api.coingecko.com'){target.hostname='pro-api.coingecko.com';spec.url=target.toString();options.headers['x-cg-pro-api-key']=process.env.COINGECKO_API_KEY;}}catch{}}
      if(spec.method==='POST'){
       const allowed=resource==='traders'&&spec.url==='https://api.hyperliquid.xyz/info'||
        key==='chain-insight:eth-transfers'&&spec.url===ETH_TRANSFER_RPC||
        key==='eth-disclosed-balance:cryptocom-20221111'&&isEthDisclosedRpcSpec(spec);
       if(!allowed)throw Error('INVALID_SOURCE_METHOD');
       Object.assign(options,{method:spec.method,body:spec.body});
      }
      const response=await Promise.race([Promise.resolve().then(()=>sourceFetch(spec.url,options)),timeout]);
      if(!response.ok){
       void response.body?.cancel().catch(()=>{});
       if(!spec.optional){
        s.status=response.status===429?429:502;
        s.retryAt=now()+hubRetryDelay(response.headers?.get?.('Retry-After'),now());
        holdProvider(caller?callerHolds:holds,spec.url,s.status,s.retryAt,now());
       }
       throw Error('SOURCE_UNAVAILABLE');
      }
      const text=await Promise.race([readSourceText(response,spec.maxBytes??policy.maxBytes),timeout]);
      const value=resource==='news'||(spec.format??policy.format)==='text'?text:JSON.parse(text);
      if(i!==undefined){parts[i]=value;headers[i]=response.headers;}
      return value;
     }catch(error){
      if(!spec.optional)throw error;
      if(i!==undefined)parts[i]=null;
      return null;
     }
    }
    let body;
    if(request.collect)body=await request.collect(load,now);
    else if(policy.parallel)await Promise.all(sources.map(load));
    else for(const [index,source] of sources.entries())await load(source,index);
    let receivedAt=now();
    if(!request.collect)body=request.decode?request.decode(parts,receivedAt,requestStartedAt,headers):parts[0];
    if(resource==='macro'){
     await request.readArchives(body,load,receivedAt);
     receivedAt=now();
    }
    request.validate?.(body,receivedAt);
    record({schema:'public-market-relay-v1',resource,receivedAt,body,...(request.source?{source:request.source}:{})});
    if(cacheKey)await cache.set(cacheKey,s.snapshot,{ttl:policy.interval/1000}).catch(()=>{});
   }catch{
    s.status=s.status===429?429:502;s.failures++;s.retryAt=Math.max(s.retryAt,now()+Math.min(300000,15000*2**Math.min(4,s.failures-1)));
   }finally{clearTimer(timer);controller.abort();}
  })().finally(()=>{s.pending=null;});
  await s.pending;
  return s.status===200?snapshot():send(s.status,{error:'PUBLIC_SOURCE_UNAVAILABLE'},{'Retry-After':String(Math.max(1,Math.ceil((s.retryAt-now())/1000)))});
 };
}
export const handleMarketHub=createMarketHubRelay();
