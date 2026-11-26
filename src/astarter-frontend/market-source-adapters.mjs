import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {HUB_RESOURCES,normalizeHubResource} from './market-hub-data.mjs';
import {ATLAS_OVERVIEW_SYMBOLS,atlasFeedFor,currentAtlasPrice} from './atlas-feed-master.mjs';

const CMC='https://pro-api.coinmarketcap.com';
let keysLoaded=false;
export function loadMarketKeys(){
 if(keysLoaded)return;
 keysLoaded=true;
 const file=process.env.ASTARTER_MARKET_KEYS||path.join(homedir(),'.config/astarter/market-keys.env');
 let text='';
 try{text=readFileSync(file,'utf8');}catch{return;}
 for(const line of text.split('\n')){
  const trimmed=line.trim();
  if(!trimmed||trimmed.startsWith('#')||!trimmed.includes('='))continue;
  const i=trimmed.indexOf('=');
  const key=trimmed.slice(0,i),value=trimmed.slice(i+1);
  if(process.env[key]===undefined)process.env[key]=value;
 }
}
export function coinMarketCapKey(){loadMarketKeys();return process.env.COINMARKETCAP_API_KEY||'';}
export function atlasApiKey(){loadMarketKeys();return process.env.ATLAS_API_KEY||'';}

const HUB_SLUGS={
 bitcoin:'bitcoin',ethereum:'ethereum',solana:'solana',bnb:'binancecoin',xrp:'ripple',dogecoin:'dogecoin',cardano:'cardano',avalanche:'avalanche-2',chainlink:'chainlink','polkadot-new':'polkadot',sui:'sui','near-protocol':'near',uniswap:'uniswap',aptos:'aptos',aave:'aave',litecoin:'litecoin','bitcoin-cash':'bitcoin-cash',tron:'tron','shiba-inu':'shiba-inu',toncoin:'the-open-network'
};
const CMC_CATEGORIES=[
 ['6433de7df79a2653906cd680','layer-1','Layer 1'],
 ['5fb62883c9ddcc213ed13308','decentralized-finance-defi','DeFi'],
 ['6400b58c1701313dc2e853a9','real-world-assets-rwa','RWA'],
 ['6051a81a66fc1b42617d6db7','artificial-intelligence','AI'],
 ['6051a82566fc1b42617d6dc6','meme-token','Meme']
];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const unix=value=>{
 if(typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value)){
  const epoch=Number(value);return Number.isSafeInteger(epoch)&&epoch>0?(epoch>1e12?Math.floor(epoch/1000):epoch):null;
 }
 const at=Date.parse(value);return Number.isFinite(at)?Math.floor(at/1000):null;
};

export function coinMarketCapGlobalBody(raw){
 const data=raw?.data,quote=data?.quote?.USD,updated=unix(data?.last_updated);
 if(!quote||!updated||!finite(quote.total_market_cap)||!finite(quote.total_volume_24h)||!finite(data.btc_dominance)||!finite(quote.total_market_cap_yesterday_percentage_change))return null;
 return {data:{
  total_market_cap:{usd:quote.total_market_cap},
  total_volume:{usd:quote.total_volume_24h},
  market_cap_percentage:{btc:data.btc_dominance,eth:finite(data.eth_dominance)?data.eth_dominance:null},
  market_cap_change_percentage_24h_usd:quote.total_market_cap_yesterday_percentage_change,
  volume_change_percentage_24h_usd:finite(quote.total_volume_24h_yesterday_percentage_change)?quote.total_volume_24h_yesterday_percentage_change:null,
  active_cryptocurrencies:data.active_cryptocurrencies,
  markets:data.active_exchanges,
  updated_at:updated
 }};
}
export function coinMarketCapAssetsBody(raw){
 if(!Array.isArray(raw?.data))return null;
 const seen=new Set();
 const rows=[];
 for(const coin of raw.data){
  const quote=coin?.quote?.USD,slug=String(coin?.slug||''),id=HUB_SLUGS[slug]||slug;
  if(!quote||!id||seen.has(id)||!finite(quote.price)||quote.price<=0||!finite(quote.market_cap)||quote.market_cap<0)continue;
  seen.add(id);
  rows.push({
   id,symbol:String(coin.symbol||''),name:String(coin.name||''),current_price:quote.price,market_cap:quote.market_cap,
   total_volume:finite(quote.volume_24h)?quote.volume_24h:null,
   price_change_percentage_24h:finite(quote.percent_change_24h)?quote.percent_change_24h:null,
   price_change_percentage_7d_in_currency:finite(quote.percent_change_7d)?quote.percent_change_7d:null,
   market_cap_rank:coin.cmc_rank,last_updated:quote.last_updated||coin.last_updated,sparkline_in_7d:{price:[]}
  });
 }
 return rows.length?rows:null;
}
export function coinMarketCapCategoriesBody(raw){
 const updated=unix(raw?.status?.timestamp);
 if(!updated||!Array.isArray(raw?.data))return null;
 const byId=new Map(raw.data.map(row=>[row.id,row]));
 const rows=CMC_CATEGORIES.map(([cmcId,id,name])=>{
  const row=byId.get(cmcId);
  if(!row||!finite(row.market_cap)||row.market_cap<=0||!finite(row.market_cap_change))return null;
  return {id,name,market_cap:row.market_cap,market_cap_change_24h:row.market_cap_change,volume_24h:finite(row.volume)?row.volume:null,updated_at:new Date(updated*1000).toISOString()};
 }).filter(Boolean);
 return rows.length?rows:null;
}
export function coinMarketCapSentimentBody(raw){
 if(!Array.isArray(raw?.data))return null;
 const rows=raw.data.map(row=>({timestamp:String(unix(row?.timestamp)),value:String(row?.value)})).filter(row=>/^\d+$/.test(row.timestamp)&&/^\d+$/.test(row.value)&&Number(row.value)<=100);
 return rows.length?{data:rows}:null;
}

const CMC_ROUTES={
 global:{path:'/v1/global-metrics/quotes/latest',maxBytes:100000,map:coinMarketCapGlobalBody},
 assets:{path:'/v1/cryptocurrency/listings/latest?limit=50&convert=USD',maxBytes:800000,map:coinMarketCapAssetsBody},
 categories:{path:'/v1/cryptocurrency/categories',maxBytes:500000,map:coinMarketCapCategoriesBody},
 sentiment:{path:'/v3/fear-and-greed/historical?limit=90',maxBytes:100000,map:coinMarketCapSentimentBody}
};
export function coinMarketCapRequest(resource){
 const route=CMC_ROUTES[resource],key=coinMarketCapKey();
 if(!route||!key)return null;
 const fallback=HUB_RESOURCES[resource];
 return {maxBytes:Math.max(route.maxBytes,fallback.maxBytes),async collectSnapshot(load,now=Date.now){
  let older;
  try{
   const raw=await load({url:CMC+route.path,headers:{'X-CMC_PRO_API_KEY':key},maxBytes:route.maxBytes,timeoutMs:4000});
   const status=raw?.status?.error_code;
   if(status!==0&&status!=='0')throw Error('CMC_UNAVAILABLE');
   const body=route.map(raw);
   const at=now(),sample=normalizeHubResource(resource,body,at,'coinmarketcap');
   const snapshot={body,source:'coinmarketcap'};
   if(sample.asOf===null||at-sample.asOf<=fallback.stale)return snapshot;
   older={snapshot,asOf:sample.asOf};
  }catch{}
  try{
   const body=await load(fallback.url);
   const sample=normalizeHubResource(resource,body,now(),fallback.source);
   return older&&(sample.asOf??0)<=older.asOf?older.snapshot:{body,source:fallback.source};
  }catch(error){
   if(older)return older.snapshot;
   throw error;
  }
 }};
}

const atlasSlots=new Map();
const ATLAS_BATCH_SIZE=18;
async function readAtlasBatch(feeds,key,fetchImpl,now){
 const response=await fetchImpl('https://api.atlasoracle.io/report/v1/price/latest',{
  method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-API-KEY':key},
  body:JSON.stringify({signed:true,feedIds:feeds.map(feed=>String(feed.id))}),redirect:'error',signal:AbortSignal.timeout(5000)
 });
 if(!response.ok){await response.body?.cancel();throw Error('atlas-price-failed');}
 const raw=await response.json();
 if(String(raw?.status?.error_code)!=='0'||!Array.isArray(raw?.data?.priceDetails))throw Error('atlas-price-failed');
 const requested=new Map(feeds.map(feed=>[String(feed.id),feed])),prices={};
 for(const row of raw.data.priceDetails){
  const feed=requested.get(String(row?.feedId));
  if(!feed)continue;
  const price=typeof row.price==='number'?row.price:
   typeof row.price==='string'&&/^\d+(?:\.\d+)?$/.test(row.price)?Number(row.price):NaN;
  const timestamp=typeof row.timestampSeconds==='number'?row.timestampSeconds:
   typeof row.timestampSeconds==='string'&&/^\d{1,10}$/.test(row.timestampSeconds)?Number(row.timestampSeconds):NaN;
  const sample=currentAtlasPrice({feedId:feed.id,price,timestamp,quote:feed.quote},feed,now());
  if(sample&&(!prices[feed.symbol]||sample.timestamp>prices[feed.symbol].timestamp))prices[feed.symbol]=sample;
 }
 return prices;
}
export async function pullAtlasPrices({fetchImpl=globalThis.fetch,symbol,now=Date.now}={}){
 const key=atlasApiKey();
 if(!key)return {configured:false,prices:{}};
 const feeds=(symbol?[String(symbol).toUpperCase()]:ATLAS_OVERVIEW_SYMBOLS).map(atlasFeedFor).filter(feed=>feed?.pull);
 if(!feeds.length)return {configured:true,prices:{}};
 const id=symbol?feeds[0].id:'overview';
 let slot=atlasSlots.get(id);
 if(!slot){slot={until:0,result:null,pending:null};atlasSlots.set(id,slot);}
 const read=()=>{
  const prices={},missing=[];
  for(const feed of feeds){
   const row=currentAtlasPrice(slot.result[feed.symbol],feed,now());
   if(row)prices[feed.symbol]=row;else missing.push(feed.symbol);
  }
  return {configured:true,source:'Atlas Oracle',prices,missing};
 };
 if(slot.until>now()){
  if(!slot.result)throw Error('atlas-price-unavailable');
  return read();
 }
 if(!slot.pending){
  const batches=[];
  for(let i=0;i<feeds.length;i+=ATLAS_BATCH_SIZE)batches.push(readAtlasBatch(feeds.slice(i,i+ATLAS_BATCH_SIZE),key,fetchImpl,now));
  slot.pending=Promise.allSettled(batches).then(results=>{
   const rows=results.filter(part=>part.status==='fulfilled').map(part=>part.value);
   slot.until=now()+(rows.length===results.length?30_000:10_000);
   if(!rows.length){slot.result=null;throw Error('atlas-price-unavailable');}
   slot.result=Object.assign({},...rows);
  }).finally(()=>{slot.pending=null;});
 }
 await slot.pending;
 return read();
}
export async function handleAtlasPrices(req,res){
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname!=='/api/atlas/prices')return false;
 if(req.method!=='GET'&&req.method!=='HEAD'){
  res.writeHead(405,{'Content-Type':'application/json; charset=utf-8','Allow':'GET'});
  res.end(JSON.stringify({error:'method-not-allowed'}));
  return true;
 }
 try{
  const body=await pullAtlasPrices({symbol:url.searchParams.get('symbol')||''});
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(req.method==='HEAD'?undefined:JSON.stringify(body));
 }catch{
  res.writeHead(502,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(req.method==='HEAD'?undefined:JSON.stringify({error:'atlas-price-unavailable'}));
 }
 return true;
}
