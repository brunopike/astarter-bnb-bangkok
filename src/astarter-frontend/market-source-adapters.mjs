import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {HUB_RESOURCES,HUB_SYMBOLS} from './market-hub-data.mjs';
import {atlasFeedById,atlasFeedFor} from './atlas-feed-master.mjs';

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
 bitcoin:'bitcoin',ethereum:'ethereum',solana:'solana',bnb:'binancecoin',xrp:'ripple',dogecoin:'dogecoin',cardano:'cardano',avalanche:'avalanche-2',chainlink:'chainlink','polkadot-new':'polkadot',sui:'sui','near-protocol':'near',uniswap:'uniswap',aptos:'aptos',aave:'aave',litecoin:'litecoin','bitcoin-cash':'bitcoin-cash',tron:'tron','shiba-inu':'shiba-inu'
};
const CMC_CATEGORIES=[
 ['6433de7df79a2653906cd680','layer-1','Layer 1'],
 ['5fb62883c9ddcc213ed13308','decentralized-finance-defi','DeFi'],
 ['6400b58c1701313dc2e853a9','real-world-assets-rwa','RWA'],
 ['6051a81a66fc1b42617d6db7','artificial-intelligence','AI'],
 ['6051a82566fc1b42617d6dc6','meme-token','Meme']
];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const unix=value=>{const at=Date.parse(value);return Number.isFinite(at)?Math.floor(at/1000):null;};

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
   market_cap_rank:coin.cmc_rank,last_updated:coin.last_updated||quote.last_updated,sparkline_in_7d:{price:[]}
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
 const rows=raw.data.map(row=>({timestamp:String(row.timestamp),value:String(row.value)})).filter(row=>/^\d+$/.test(row.timestamp)&&/^\d+$/.test(row.value)&&Number(row.value)<=100);
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
 return {maxBytes:route.maxBytes,async collectSnapshot(load){
  try{
   const raw=await load({url:CMC+route.path,headers:{'X-CMC_PRO_API_KEY':key},maxBytes:route.maxBytes});
   const body=route.map(raw);
   if(!body)throw Error('INVALID_DATA');
   return {body,source:'coinmarketcap'};
  }catch{return {body:await load(fallback.url),source:fallback.source};}
 }};
}

let atlasCache=null,atlasPending=null;
function atlasTargets(symbol){
 const symbols=symbol?[String(symbol).toUpperCase()]:HUB_SYMBOLS;
 return symbols.map(item=>atlasFeedFor(item)).filter(feed=>feed?.pull);
}
export async function pullAtlasPrices({fetchImpl=globalThis.fetch,symbol,now=Date.now}={}){
 const key=atlasApiKey();
 if(!key)return {configured:false,prices:{}};
 const feeds=atlasTargets(symbol);
 if(!feeds.length)return {configured:true,prices:{}};
 if(!symbol&&atlasCache&&now()-atlasCache.at<30000)return {configured:true,prices:atlasCache.prices};
 if(!symbol&&atlasPending)return atlasPending;
 const work=(async()=>{
  const response=await fetchImpl('https://api.atlasoracle.io/report/v1/price/latest',{
   method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-API-KEY':key},
   body:JSON.stringify({signed:true,feedIds:feeds.map(feed=>String(feed.id))})
  });
  const raw=await response.json();
  if(!response.ok||String(raw?.status?.error_code)!=='0'||!Array.isArray(raw?.data?.priceDetails))throw Error('atlas-price-failed');
  const prices={};
  for(const row of raw.data.priceDetails){
   const feed=atlasFeedById(row.feedId),price=Number(row.price),timestamp=Number(row.timestampSeconds);
   if(!feed||!Number.isFinite(price)||price<=0||!Number.isFinite(timestamp))continue;
   prices[feed.symbol]={feedId:feed.id,price,timestamp};
  }
  if(!symbol)atlasCache={at:now(),prices};
  return {configured:true,prices};
 })();
 if(!symbol)atlasPending=work.finally(()=>{atlasPending=null;});
 return work;
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
  res.end(JSON.stringify({error:'atlas-price-unavailable'}));
 }
 return true;
}
