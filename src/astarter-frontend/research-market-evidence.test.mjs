import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchMarketEvidence} from './research-market-evidence.mjs';
import {CROSS_MARKETS} from './cross-market-data.mjs';
import {validateResearchEvidence} from './research-analysis-service.mjs';

const DAY=86400000,NOW=Date.UTC(2026,10,16,12),day=Math.floor(NOW/DAY)*DAY;
const json=(body,options={})=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'},...options});
const bars=(price=100,count=300,end=day)=>Array.from({length:count},(_,i)=>[end-(count-i)*DAY,String(price),String(price+1),String(price-1),String(price),'100',end-(count-i-1)*DAY-1]);
function yahoo(symbol){
 const spec=CROSS_MARKETS[symbol],times=[];let date=Date.UTC(2026,10,13,14,30);
 while(times.length<300){if(![0,6].includes(new Date(date).getUTCDay()))times.unshift(date/1000);date-=DAY;}
 const start=times.at(-1),price=symbol==='US10Y'?4.5:100;
 return {chart:{error:null,result:[{meta:{symbol:spec.id,instrumentType:'INDEX',exchangeTimezoneName:spec.timezone,regularMarketTime:start+23400,currentTradingPeriod:{regular:{start,end:start+23400}}},timestamp:times,indicators:{quote:[{open:times.map(()=>price),high:times.map(()=>price+1),low:times.map(()=>price-1),close:times.map(()=>price),volume:times.map(()=>0)}]}}]}};
}
function goldChart(){
 const dates=[];
 for(let date=day-400*DAY;date<day;date+=DAY)if(new Date(date).getUTCDay()!==6)dates.push(date);
 const times=dates.slice(-300).map(date=>date/1000),price=100,column=()=>times.map(()=>price);
 return {chart:{error:null,result:[{meta:{symbol:'GC=F',instrumentType:'FUTURE',currency:'USD',exchangeName:'CMX',exchangeTimezoneName:'America/New_York'},timestamp:times,indicators:{quote:[{open:column(),high:times.map(()=>101),low:times.map(()=>99),close:column(),volume:times.map(()=>0)}]}}]}};
}
function gold(year){
 const start=Date.UTC(year,0,1),end=year===2026?day:Date.UTC(year+1,0,1),dates=[];
 for(let date=start;date<end;date+=DAY)if(new Date(date).getUTCDay()!==6)dates.push(date);
 const times=dates.map((date,i)=>(date-(i?dates[i-1]:start))/DAY),zeros=times.map(()=>0);
 return {timestamp:start,shift:DAY,multiplier:.001,open:100,high:101,low:99,close:100,times,opens:zeros,highs:zeros,lows:zeros,closes:zeros};
}
function transport(calls=[]){return async(url,options)=>{
 calls.push({url,options});const u=new URL(url);
 if(u.hostname==='data-api.binance.vision')return json(bars({BTCUSDT:100,ETHUSDT:200,SOLUSDT:50}[u.searchParams.get('symbol')]));
 if(u.hostname==='jetta.dukascopy.com')return json(gold(u.pathname.endsWith('/2025')?2025:2026));
 if(u.hostname==='query1.finance.yahoo.com'&&decodeURIComponent(u.pathname.split('/').at(-1))==='GC=F')return json(goldChart());
 const symbol=Object.keys(CROSS_MARKETS).find(key=>CROSS_MARKETS[key].id===decodeURIComponent(u.pathname.split('/').at(-1)));return json(yahoo(symbol));
};}

test('construction performs no I/O; malformed, duplicate and injected selections are rejected before transport',async()=>{
 let calls=0;const loader=createResearchMarketEvidence({fetchImpl:()=>{calls++;},now:()=>NOW});assert.equal(calls,0);
 const injected=['BTC'];injected.url='https://attacker.invalid';
 for(const input of [null,[],['BTC','BTC'],['BTC','UNKNOWN'],['__proto__'],['BTC/USDT'],['https://attacker.invalid'],[{symbol:'BTC',price:1}],{symbols:['BTC'],url:'https://attacker.invalid'},injected])await assert.rejects(()=>loader.loadEvidence(input),{message:'MARKET_SELECTION_INVALID'});
 assert.equal(calls,0);assert.throws(()=>createResearchMarketEvidence({timeoutMs:Infinity}));
});

test('fixed official GET routes ignore caller URLs and prices and calculate an independently known flat-bar result',async()=>{
 const calls=[],load=createResearchMarketEvidence({fetchImpl:transport(calls),now:()=>NOW}).loadEvidence;
 const [row]=await load(['BTC'],{url:'https://attacker.invalid',price:1});
 assert.equal(row.state,'ready');assert.equal(row.price,100);assert.equal(row.x,0);assert.equal(row.y,50);assert.equal(row.change,0);assert.equal(row.closedAt,day/1000);assert.equal(row.validUntil,(day+DAY)/1000);assert.equal(row.bars,300);
 assert.equal(row.source,'Binance Spot');assert.equal(row.timezone,'UTC');assert.equal(row.unit,'USDT');assert.equal(row.paused,false);
 assert.equal(calls[0].url,'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=300');
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.headers.Authorization,undefined);
 assert.equal(validateResearchEvidence([row],['BTC'],NOW)[0].metrics.close,100);
});

test('all eight assets use exact source identities and common scanner mathematics, without inventing TradFi volume',async()=>{
 const selected=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'],calls=[],rows=await createResearchMarketEvidence({fetchImpl:transport(calls),now:()=>NOW}).loadEvidence(selected);
 assert.equal(calls.length,8);assert.deepEqual(rows.map(row=>row.symbol),selected);assert.ok(rows.every(row=>row.state==='ready'&&row.period==='1D'&&row.methodVersion==='ema20-atr14-rsi14-v1'));
 assert.equal(rows[1].price,200);assert.equal(rows[2].price,50);assert.equal(rows[7].price,4.5);assert.equal(rows[7].unit,'%');assert.equal(rows[7].timezone,'America/Chicago');assert.equal(rows[5].source,'Yahoo Finance · COMEX Gold Futures (GC=F)');
 assert.equal(validateResearchEvidence(rows,selected,NOW).length,8);assert.ok(rows.slice(3).every(row=>row.bars>=250&&row.asOfKind));
});

test('transport concurrency stays at eight across simultaneous loads',async()=>{
 let active=0,peak=0;const real=transport();const fetchImpl=async(...args)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));try{return await real(...args);}finally{active--;}};
 const loader=createResearchMarketEvidence({fetchImpl,now:()=>NOW});const selection=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'];
 const results=await Promise.all([loader.loadEvidence(selection),loader.loadEvidence(selection)]);assert.equal(peak,8);assert.ok(results.flat().every(row=>row.state==='ready'));
});

test('old, short, gapped and zero-range markets stay explicitly unavailable rather than receiving fixture observations',async()=>{
 const cases=[[bars(100,300,day-DAY),'stale'],[bars(100,249),'warmup'],[bars().filter((_,i)=>i!==10),'error'],[bars().map(row=>[row[0],'100','100','100','100','0',row[6]]),'no-range']];
 for(const [payload,state]of cases){const rows=await createResearchMarketEvidence({fetchImpl:async()=>json(payload),now:()=>NOW}).loadEvidence(['BTC']);assert.equal(rows[0].state,state);assert.equal(rows[0].price,undefined);assert.throws(()=>validateResearchEvidence(rows,['BTC'],NOW));}
});

test('provider identity mismatches and scanner-shaped injected JSON fail validation',async()=>{
 const wrong=yahoo('SPX');wrong.chart.result[0].meta.symbol='^NDX';
 for(const payload of [wrong,{symbol:'SPX',state:'ready',source:'Yahoo Finance · S&P 500',price:100}]){
  const [row]=await createResearchMarketEvidence({fetchImpl:async()=>json(payload),now:()=>NOW}).loadEvidence(['SPX']);assert.equal(row.state,'error');assert.equal(row.price,undefined);assert.equal(row.reason,'SOURCE_INVALID');
 }
 const wrongZone=yahoo('US10Y');wrongZone.chart.result[0].meta.exchangeTimezoneName='UTC';
 assert.equal((await createResearchMarketEvidence({fetchImpl:async()=>json(wrongZone),now:()=>NOW}).loadEvidence(['US10Y']))[0].state,'error');
 const disguised=json(bars());Object.defineProperty(disguised,'url',{value:'https://attacker.invalid/btc'});
 assert.equal((await createResearchMarketEvidence({fetchImpl:async()=>disguised,now:()=>NOW}).loadEvidence(['BTC']))[0].reason,'SOURCE_IDENTITY_INVALID');
});

test('HTTP errors, redirects, non-JSON, declared and streamed oversized bodies never produce evidence',async()=>{
 const responses=[new Response('down',{status:503}),new Response('{}',{headers:{'Content-Type':'text/html'}}),json(bars(),{headers:{'Content-Type':'application/json','Content-Length':'200001'}}),new Response(' '.repeat(200001),{headers:{'Content-Type':'application/json'}})];
 const redirected=json(bars());Object.defineProperty(redirected,'redirected',{value:true});responses.push(redirected);
 for(const response of responses){const [row]=await createResearchMarketEvidence({fetchImpl:async()=>response,now:()=>NOW}).loadEvidence(['BTC']);assert.equal(row.state,'error');assert.equal(row.price,undefined);assert.ok(['SOURCE_UNAVAILABLE','SOURCE_INVALID','SOURCE_TOO_LARGE'].includes(row.reason));}
});

test('the total deadline bounds an uncooperative transport while preserving a successful independent asset',async()=>{
 const signals=[];const rows=await createResearchMarketEvidence({timeoutMs:20,now:()=>NOW,fetchImpl:async(url,{signal})=>{signals.push(signal);return url.includes('BTCUSDT')?json(bars()):new Promise(()=>{});}}).loadEvidence(['BTC','ETH']);
 assert.equal(rows[0].state,'ready');assert.equal(rows[1].state,'error');assert.equal(rows[1].reason,'SOURCE_TIMEOUT');assert.ok(signals.every(signal=>signal.aborted));assert.throws(()=>validateResearchEvidence(rows,['BTC','ETH'],NOW));
});

test('a complete network failure retains the selected identities without any numerical fallback or transport detail',async()=>{
 const selected=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'];
 const rows=await createResearchMarketEvidence({now:()=>NOW,fetchImpl:async()=>{throw Error('private transport diagnostic');}}).loadEvidence(selected);
 assert.deepEqual(rows.map(row=>row.symbol),selected);assert.ok(rows.every(row=>row.state==='error'&&row.reason==='SOURCE_UNAVAILABLE'&&row.price===undefined));
 assert.doesNotMatch(JSON.stringify(rows),/private transport diagnostic/);assert.throws(()=>validateResearchEvidence(rows,selected,NOW));
});

test('body reads and the XAU request share the same total deadline',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});
 const [hung]=await createResearchMarketEvidence({timeoutMs:20,now:()=>NOW,fetchImpl:async()=>response}).loadEvidence(['BTC']);assert.equal(hung.reason,'SOURCE_TIMEOUT');await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
 let calls=0;const [goldRow]=await createResearchMarketEvidence({timeoutMs:25,now:()=>NOW,fetchImpl:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,40));return json(goldChart());}}).loadEvidence(['XAU']);
 assert.equal(calls,1);assert.equal(goldRow.reason,'SOURCE_TIMEOUT');assert.equal(goldRow.price,undefined);
});

test('an unavailable XAU read and a changed daily boundary cannot publish a sample',async()=>{
 const [goldRow]=await createResearchMarketEvidence({now:()=>NOW,fetchImpl:async()=>new Response('offline',{status:503})}).loadEvidence(['XAU']);assert.equal(goldRow.state,'error');assert.equal(goldRow.price,undefined);
 let at=day+DAY-1;const [btc]=await createResearchMarketEvidence({now:()=>at,fetchImpl:async()=>{at=day+DAY;return json(bars());}}).loadEvidence(['BTC']);assert.equal(btc.state,'stale');assert.equal(btc.price,undefined);
});

test('a source outage from the real loader reads EVIDENCE_UNAVAILABLE in the paid request check, while a short history stays invalid evidence',async()=>{
 for(const fetchImpl of [async()=>{throw Error('offline transport');},async()=>new Response('down',{status:503})]){
  const rows=await createResearchMarketEvidence({now:()=>NOW,fetchImpl}).loadEvidence(['BTC']);
  assert.equal(rows[0].state,'error');assert.equal(rows[0].reason,'SOURCE_UNAVAILABLE');assert.throws(()=>validateResearchEvidence(rows,['BTC'],NOW),{message:'EVIDENCE_UNAVAILABLE',status:503});
 }
 const partial=await createResearchMarketEvidence({timeoutMs:20,now:()=>NOW,fetchImpl:async url=>url.includes('BTCUSDT')?json(bars()):new Promise(()=>{})}).loadEvidence(['BTC','ETH']);
 assert.equal(partial[0].state,'ready');assert.equal(partial[1].reason,'SOURCE_TIMEOUT');assert.throws(()=>validateResearchEvidence(partial,['BTC','ETH'],NOW),{message:'EVIDENCE_UNAVAILABLE',status:503});
 const short=await createResearchMarketEvidence({now:()=>NOW,fetchImpl:async()=>json(bars(100,249))}).loadEvidence(['BTC']);
 assert.equal(short[0].state,'warmup');assert.throws(()=>validateResearchEvidence(short,['BTC'],NOW),{message:'EVIDENCE_INVALID',status:502});
});

test('an empty, gapped or non-JSON source answer stays EVIDENCE_INVALID, apart from a source outage',async()=>{
 for(const fetchImpl of [async()=>json([]),async()=>json(bars().filter((_,i)=>i!==10)),async()=>new Response('[]',{headers:{'Content-Type':'text/plain'}})]){
  const rows=await createResearchMarketEvidence({now:()=>NOW,fetchImpl}).loadEvidence(['BTC']);
  assert.equal(rows[0].state,'error');assert.equal(rows[0].reason,'SOURCE_INVALID');assert.throws(()=>validateResearchEvidence(rows,['BTC'],NOW),{message:'EVIDENCE_INVALID',status:502});
 }
});
