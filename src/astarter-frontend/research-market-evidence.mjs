import {Buffer} from 'node:buffer';
import {ASSETS} from './product-data.mjs';
import {candleRequest,normalizeKlines} from './trading-chart-data.mjs';
import {crossMarketPolicy,normalizeCrossMarket,validateCrossSnapshot} from './cross-market-data.mjs';
import {marketScatterSample} from './workbench-market-analysis.mjs';
import {marketResearchObservation} from './live-research.mjs';

const assets=new Map(ASSETS.map(([symbol,,domain])=>[symbol,domain]));
const METHOD='ema20-atr14-rsi14-v1',MAX_CONCURRENT=8,MAX_TOTAL_BYTES=4200000;
const fault=code=>Object.assign(Error(code),{code});
const knownErrors=new Set(['SOURCE_TIMEOUT','SOURCE_UNAVAILABLE','SOURCE_TOO_LARGE','SOURCE_INVALID','SOURCE_IDENTITY_INVALID']);
const aborts=new WeakMap();

function abortable(promise,signal){
 if(signal.aborted)return Promise.reject(fault('SOURCE_TIMEOUT'));
 if(!aborts.has(signal))aborts.set(signal,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(fault('SOURCE_TIMEOUT')),{once:true})));
 return Promise.race([promise,aborts.get(signal)]);
}

async function limitedJson(response,url,limit,budget,signal){
 if(!response?.ok||response.redirected)throw fault('SOURCE_UNAVAILABLE');
 if(response.url&&new URL(response.url).href!==new URL(url).href)throw fault('SOURCE_IDENTITY_INVALID');
 const length=response.headers?.get?.('content-length');
 if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>limit))throw fault('SOURCE_TOO_LARGE');
 if(!response.headers?.get?.('content-type')?.toLowerCase().includes('json')||typeof response.body?.getReader!=='function')throw fault('SOURCE_INVALID');
 const reader=response.body.getReader(),parts=[];let size=0,complete=false;
 try{
  for(let chunks=0;;chunks++){
   if(chunks>2048)throw fault('SOURCE_TOO_LARGE');
   const {done,value}=await abortable(reader.read(),signal);if(done){complete=true;break;}
   if(!(value instanceof Uint8Array))throw fault('SOURCE_INVALID');
   size+=value.byteLength;budget.bytes+=value.byteLength;
   if(size>limit||budget.bytes>MAX_TOTAL_BYTES)throw fault('SOURCE_TOO_LARGE');
   parts.push(Buffer.from(value));
  }
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fault('SOURCE_INVALID');}
 }finally{if(!complete)Promise.resolve(reader.cancel()).catch(()=>{});reader.releaseLock?.();}
}

// Server-owned public sources only. Construction neither opens a connection nor reads an account.
export function createResearchMarketEvidence({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>12000)throw fault('MARKET_SOURCE_CONFIGURATION_INVALID');
 let active=0;const queue=[];
 const drain=()=>{
  while(active<MAX_CONCURRENT&&queue.length){
   const job=queue.shift();if(job.signal.aborted){job.reject(fault('SOURCE_TIMEOUT'));continue;}
   active++;
   Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{active--;drain();});
  }
 };
 const read=(url,headers,limit,budget,signal)=>{
  const work=new Promise((resolve,reject)=>{queue.push({signal,resolve,reject,run:async()=>{
   if(signal.aborted)throw fault('SOURCE_TIMEOUT');
   let response;
   try{response=await abortable(fetchImpl(url,{method:'GET',headers:{Accept:'application/json',...headers},redirect:'error',credentials:'omit',cache:'no-store',signal}),signal);}
   catch(error){throw signal.aborted?fault('SOURCE_TIMEOUT'):knownErrors.has(error?.code)?error:fault('SOURCE_UNAVAILABLE');}
   return limitedJson(response,url,limit,budget,signal);
  }});drain();});
  return abortable(work,signal);
 };
 return {async loadEvidence(selected){
  if(!Array.isArray(selected)||Object.getPrototypeOf(selected)!==Array.prototype||!selected.length||selected.length>8||Object.keys(selected).length!==selected.length||new Set(selected).size!==selected.length||selected.some(symbol=>typeof symbol!=='string'||!assets.has(symbol)))throw fault('MARKET_SELECTION_INVALID');
  const symbols=[...selected],startedAt=now();
  if(!Number.isSafeInteger(startedAt)||startedAt<0)throw fault('MARKET_CLOCK_INVALID');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),budget={bytes:0};
  try{return await Promise.all(symbols.map(async symbol=>{
   const crypto=assets.get(symbol)==='Crypto',request=candleRequest(crypto?{market:symbol+'/USDT',period:'1D'}:{market:symbol,period:'1D',profileId:'public-market',venueId:'yahoo'});
   const identity={symbol,source:request.source||'Binance Spot',timezone:request.timezone||'UTC',unit:request.unit||'USDT',period:'1D',methodVersion:METHOD,paused:false};
   try{
    let bars,meta={};
    if(crypto){
     const url='https://data-api.binance.vision/api/v3/klines?'+new URLSearchParams({symbol:request.symbol,interval:request.interval,limit:'300'});
     bars=normalizeKlines(await read(url,{},200000,budget,controller.signal),request);
    }else{
     const policy=crossMarketPolicy(symbol,startedAt),payloads=[];
     // Each cross-market asset is one GET, so eight assets stay within eight requests.
     for(const url of policy.urls)payloads.push(await read(url,policy.headers,policy.maxBytes,budget,controller.signal));
     const at=now(),body=normalizeCrossMarket(policy.urls.length===1?payloads[0]:payloads,symbol,at);
     validateCrossSnapshot(body,request,at);
     if(body.source!==identity.source||body.timezone!==identity.timezone||body.unit!==identity.unit||body.symbol!==symbol)throw fault('SOURCE_IDENTITY_INVALID');
     bars=body.bars;meta={session:body.session,quoteAsOf:body.quoteAsOf,asOfKind:body.asOfKind,sessionDate:body.sessionDate,closeTimeBasis:body.closeTimeBasis};
    }
    const at=now();if(!Number.isSafeInteger(at)||at<startedAt)throw fault('SOURCE_INVALID');
    const sample=marketScatterSample(bars,at/1000,request),row={...identity,...meta,...sample,feedState:'snapshot',asOf:at};
    if(row.state==='ready'&&row.validUntil*1000<=at)row.state='stale';
    if(row.state==='ready'&&marketResearchObservation(row,at/1000)?.state!=='ready')throw fault('SOURCE_INVALID');
    return row;
   }catch(error){return {...identity,state:'error',feedState:'error',reason:knownErrors.has(error?.code)?error.code:'SOURCE_INVALID'};}
  }));}finally{clearTimeout(timer);controller.abort();}
 }};
}
