import assert from 'node:assert/strict';
import test from 'node:test';
import {createLiveDataViews,liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';
import {publicChainInsightRequest,publicDerivativesRequest} from './public-market-extended.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';

const NOW=Date.UTC(2026,10,18,4,30);
const envelope=(resource,body)=>({schema:'public-market-relay-v1',resource,receivedAt:NOW,body});

test('XAU spot refreshes independently while daily candles are unavailable and a stale source keeps its original timestamp',async t=>{
 const keys=['document','location','navigator'],previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
 for(const [k,v] of Object.entries({document:{hidden:false,addEventListener(){},querySelector(){return null;},activeElement:null},location:{search:'?asset=XAU'},navigator:{onLine:true}}))Object.defineProperty(globalThis,k,{configurable:true,value:v});
 t.after(()=>keys.forEach((k,i)=>previous[i]?Object.defineProperty(globalThis,k,previous[i]):Reflect.deleteProperty(globalThis,k)));
 const calls=[],root={scrollTop:0,contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}};
 let now=NOW,html='',price=3770.125,asOf=NOW-6000;
 const view=createLiveDataViews({root,now:()=>now,rerender(){html=view.render('markets');},link:v=>v,section:(h,b)=>h+b,table:()=>'',stat:(l,v,s)=>l+v+s,chartPanel:()=>'',empty:v=>v,
  fetchImpl:async url=>{
   const resource=new URL(url,'https://example.test').searchParams.get('resource');calls.push(resource);
   if(resource==='cross-candles')return new Response('',{status:503});
   assert.equal(resource,'gold-spot');return Response.json({schema:'public-market-relay-v1',resource,receivedAt:now,body:{source:'Gold API',symbol:'XAU',currency:'USD',unit:'USD/troy oz',price,asOf}});
  }});
 html=view.render('markets');await new Promise(resolve=>setImmediate(resolve));
 assert.match(html,/3,770\.125/);assert.match(html,/data-quality="fresh"/);assert.deepEqual(calls,['gold-spot','cross-candles']);
 now+=15_001;price+=2;asOf+=15_000;view.tick('markets');await new Promise(resolve=>setImmediate(resolve));
 assert.match(html,/3,772\.125/);assert.equal(calls.filter(x=>x==='gold-spot').length,2);
 now+=125_000;view.tick('markets');await new Promise(resolve=>setImmediate(resolve));assert.match(html,/data-quality="stale"/);
});

test('Bitview uses aligned daily observations, preserves zero and omits gaps and open dates',()=>{
 const dates=['2026-11-15','2026-11-16','2026-11-17','2026-11-18'];
 const base={index:'day1',start:100,end:104};
 for(const [metric,type] of [['mvrv','Multiple'],['sopr','Multiple'],['realized-price','Dollars']]){
  const query=new URLSearchParams({metric}),route=liveDataRoute('tracking',query);
  const request=publicChainInsightRequest(query,NOW),datesPart={...base,type:'Date',data:dates},values={...base,type,data:[null,0,2,10]};
  const body=request.decode([[datesPart,values]],NOW);
  assert.equal(body.source,'Bitview');
  assert.equal(body.url,request.policy.url);
  assert.deepEqual(body.rows,[{at:Date.parse(dates[1]),value:0},{at:Date.parse(dates[2]),value:2}]);
  assert.equal(validateLiveDataResponse(envelope('chain-insight',body),route,NOW).asOf,Date.parse(dates[2]));
  for(const invalid of [{start:99},{index:'height'},{type:'wrong'},{data:[]},{data:[null,-1,2,10]}])
   assert.throws(()=>request.decode([[datesPart,{...values,...invalid}]],NOW));
  assert.throws(()=>request.decode([[{...datesPart,data:[dates[0],dates[0],dates[2],dates[3]]},values]],NOW));
  assert.throws(()=>validateLiveDataResponse(envelope('chain-insight',{...body,rows:[{at:Date.parse(dates[3]),value:2}],asOf:Date.parse(dates[3])}),route,NOW));
 }
 assert.equal(liveDataRoute('tracking','metric=active').query.metric,'active-addresses');
});

test('all requested default surfaces use public data, while explicit presets retain their routes',()=>{
 const cases=[
  ['markets','asset=US10Y','cross-candles'],['derivatives','view=多空比&asset=ETH','derivatives'],
  ['tracking','','tvl'],['tracking','metric=whales','chain-insight'],['tracking','metric=exchange-netflow','exchange-netflow'],['tracking','metric=exchange-flow-24h','exchange-reserves'],
  ['tracking','metric=exchange-inflow','exchange-asset-flows'],['tracking','metric=exchange-outflow','exchange-asset-flows'],['tracking','metric=btc-disclosed-flows','btc-disclosed-flows'],
  ['tracking','metric=active','chain-insight'],['tracking','metric=stable-supply','stablecoins'],['tracking','metric=stablecoin-netflow','chain-insight'],['tracking','metric=fees','chain-insight'],
  ['intelligence','view=calendar','macro'],['etf','fund=ETHA','etf'],
  ['social','','social'],['social','view=rank','traders'],['social','view=posts','social'],['social','view=mastodon','social'],['social','trader=orbit',null]
 ];
 for(const [page,search,resource] of cases){
  assert.equal(liveDataRoute(page,search)?.resource,resource,page+' '+search);
  assert.equal(liveDataRoute(page,search+'&data=demo'),null,page);
 }
 assert.equal(liveDataRoute('etf','fund=ETHA').query.asset,'eth');
 assert.equal(liveDataRoute('derivatives','exchange=Binance').resource,null);
 assert.equal(liveDataRoute('derivatives','view=多空比&asset=ETH').query.view,'ratio');
 for(const asset of ['BTC','ETH']){
  const route=liveDataRoute('tracking','metric=exchange-inflow&asset='+asset.toLowerCase());
  assert.equal(route.resource,'exchange-asset-flows');assert.equal(route.query.symbol,asset);
 }
 assert.equal(liveDataRoute('tracking','metric=exchange-asset-flows&asset=SOL').resource,null);
 assert.equal(liveDataRoute('tracking','metric=constructor').resource,null);
});

test('stablecoin exchange net flow preserves signed final UTC days and validates their source',()=>{
 const params=new URLSearchParams({metric:'stablecoin-netflow'}),route=liveDataRoute('tracking',params);
 const request=publicChainInsightRequest(params,NOW),query=new URL(request.policy.url);
 const series='eth.StablecoinExchangeNetflow';
 const day=Date.UTC(2026,10,18)/1000,previous=day-86400;
 assert.equal(query.origin,'https://cryptokeyhole.com');
 assert.equal(query.searchParams.get('metric'),series);
 assert.equal(query.searchParams.get('end'),String(day-1));
 const raw={metric:{id:series,unit:'USD'},interval:'24h',state:'current',historyComplete:true,points:[
  {t:previous-86400,v:'0',finality:'final'},{t:previous,v:'-123456.25',finality:'final'},{t:day,v:'40',finality:'partial'}
 ]};
 const body=request.decode([raw],NOW);
 assert.deepEqual(body.rows,[{at:(previous-86400)*1000,value:0},{at:previous*1000,value:-123456.25}]);
 assert.equal(validateLiveDataResponse(envelope('chain-insight',body),route,NOW).asOf,previous*1000);
 for(const invalid of [{locked:{requiredPlan:'pro'}},{historyComplete:false},{metric:{id:'unrelated',unit:'USD'}},
  {points:[{t:day-180*86400,v:'120',finality:'final'}]}]){
  assert.throws(()=>request.decode([{...raw,...invalid}],NOW),/INVALID_PUBLIC_MARKET_DATA/);
 }
 assert.throws(()=>validateLiveDataResponse(envelope('chain-insight',{...body,url:'https://invalid.test/' }),route,NOW),/INVALID_DATA/);
 assert.equal(publicChainInsightRequest(new URLSearchParams(params+'&url=https://invalid.test'),NOW),null);
});

test('normalized derivatives preserve source units and never mislabel a liquidation as traded notional',()=>{
 const instrument='ETH-USDT-SWAP',time=String(NOW-1000),read=(view,...parts)=>publicDerivativesRequest(new URLSearchParams({view,symbol:'ETH'})).decode(parts,NOW);
 const funding=read('funding',{code:'0',data:[{instId:instrument,instType:'SWAP',fundingTime:time,realizedRate:'-0.0002',fundingRate:'0.03'}]});
 assert.equal(funding.rows[0].value,-0.02);
 assert.equal(read('oi',{code:'0',data:[[time,'15','3','1234.567']]},null).rows[0].value,1234.567);
 const liquidation=read('liquidation',{code:'0',data:[{instId:instrument,instType:'SWAP',details:[{ts:time,posSide:'short',sz:'2',bkPx:'3200'}]}]});
 assert.deepEqual(liquidation.rows,[{at:NOW-1000,position:'short',size:2,bankruptcyPrice:3200}]);
 assert.deepEqual(read('liquidation',{code:'0',data:[]}).rows,[]);
 assert.throws(()=>read('liquidation',{code:'50014',data:[]}),/INVALID_PUBLIC_MARKET_DATA/);
 assert.throws(()=>read('funding',{code:'0',data:[{instId:'BTC-USDT-SWAP',instType:'SWAP',fundingTime:time,realizedRate:'-0.0002'}]}));
 assert.throws(()=>validateLiveDataResponse(envelope('derivatives',funding),liveDataRoute('derivatives','asset=BTC'),NOW));
});

test('the Ethereum filter retains confirmed native amounts exactly and never accepts an unqualified transfer',()=>{
 const request=publicChainInsightRequest(new URLSearchParams({metric:'eth-transfers'}),NOW),value='100000000000000000001';
 assert.equal(new URL(request.policy.url).searchParams.get('age_from'),new Date(Math.floor((NOW-86_400_000)/60_000)*60_000).toISOString());
 const observation={type:'coin_transfer',status:'success',timestamp:new Date(NOW-1000).toISOString(),value,
  hash:'0x'+'a'.repeat(64),from:{hash:'0x'+'b'.repeat(40)},to:{hash:'0x'+'c'.repeat(40)}};
 assert.equal(request.decode([{items:[observation]}],NOW).rows[0].wei,value);
 const excluded=[
  {...observation,value:'99999999999999999999'},
  {...observation,timestamp:new Date(NOW-86_401_000).toISOString()},
  {...observation,type:'contract_interaction'},
  {...observation,status:'reverted'}
 ];
 assert.deepEqual(request.decode([{items:excluded}],NOW).rows,[]);
 assert.throws(()=>request.decode([{items:[{...observation,value:'invalid'}]}],NOW));
 assert.equal(publicChainInsightRequest(new URLSearchParams('metric=eth-transfers&url=https://invalid.test')),null);
});

test('BTC network totals preserve the 144-block range and distinguish satoshis, counts and virtual bytes',()=>{
 const window={startBlock:400,endBlock:543,totalReward:'45307773024',totalFee:'307773024',totalTx:'609589'};
 const decode=(metric,body)=>publicChainInsightRequest(new URLSearchParams({metric}),NOW).decode([body],NOW);
 assert.deepEqual(decode('fees',window).blocks,{from:400,to:543});
 assert.equal(decode('fees',window).rows[0].value,3.07773024);
 assert.equal(decode('transactions',window).rows[0].value,609589);
 assert.equal(decode('miner-revenue',window).rows[0].value,453.07773024);
 assert.throws(()=>decode('fees',{...window,endBlock:544}));
 const backlog={count:59287,vsize:30543854};
 assert.equal(decode('mempool',backlog).rows[0].value,59287);
 assert.equal(decode('mempool-size',backlog).unit,'vB');
 assert.throws(()=>decode('mempool',{count:2.5}));
});

test('Bitview daily holdings, valuation and activity routes validate the source units and preserve negative NUPL',()=>{
 const sourceDays=['2026-11-16','2026-11-17','2026-11-18'];
 const vector=(type,data)=>({type,index:'day1',start:42,end:45,data});
 const decode=(metric,type,data,adjust={})=>{
  const request=publicChainInsightRequest(new URLSearchParams({metric}),NOW);
  return request.decode([[vector('Date',sourceDays),{...vector(type,data),...adjust}]],NOW);
 };
 const route=liveDataRoute('tracking','metric=nupl');
 const signed=decode('nupl','Ratio',[-0.75,0.4,0.5]);
 assert.equal(signed.unit,'ratio');
 assert.deepEqual(signed.rows.map(row=>row.value),[-0.75,0.4]);
 assert.deepEqual(validateLiveDataResponse(envelope('chain-insight',signed),route,NOW).body.rows,signed.rows);
 assert.throws(()=>decode('nupl','Ratio',[1.01,0.4,0.5]));
 assert.throws(()=>decode('nupl','Percent',[5,5,5]));
 assert.throws(()=>decode('new-address','Count',[1.5,2,3]));
 assert.throws(()=>decode('realized-loss','Dollars',[-10,20,0]));
 assert.throws(()=>decode('cdd','CoinDays',[100,30,12],{start:41}));
 assert.equal(decode('profit-supply','Percent',[0,52.28,100]).rows.at(-1).value,52.28);
 assert.throws(()=>decode('profit-supply','Percent',[0,100.01,1]));
 const mapping={'realized-cap':'realized_cap','lth-cost':'lth_realized_price','sth-cost':'sth_realized_price','lth-supply':'lth_supply',
  'sth-supply':'sth_supply','spent-volume':'transfer_volume_sum_24h','new-address':'new_address_count_sum_24h',
  'realized-profit':'realized_profit_sum_24h','realized-loss':'realized_loss_sum_24h',cdd:'coindays_destroyed_sum_24h'};
 for(const [metric,series] of Object.entries(mapping)){
  assert.equal(liveDataRoute('tracking','metric='+metric).resource,'chain-insight');
  const url=new URL(publicChainInsightRequest(new URLSearchParams({metric})).policy.url);
  assert.equal(url.searchParams.get('series'),'date,'+series);
  assert.equal(url.searchParams.get('start'),'-91');
 }
});

test('address bands and fee per transaction require aligned observations from all component series',()=>{
 const dates=['2026-11-15','2026-11-16','2026-11-17'];
 const vector=(type,data)=>({type,index:'day1',start:0,end:dates.length,data});
 function read(metric,columns){
  const request=publicChainInsightRequest(new URLSearchParams({metric}));
  return request.decode([[vector('Date',dates),...columns]],NOW);
 }
 const balances=[vector('Bitcoin',[0.00000001,null,0]),vector('Bitcoin',[0.00000002,1,3]),vector('Bitcoin',[0,1,5])];
 assert.deepEqual(read('whale-balance',balances).rows.map(r=>r.value),[0.00000003,8]);
 assert.throws(()=>read('whale-balance',balances.slice(0,2)));
 assert.throws(()=>read('whale-balance',[...balances.slice(0,2),{...balances[2],end:4}]));
 assert.deepEqual(read('shrimp',Array(8).fill(vector('Bitcoin',[1,2,3]))).rows.map(r=>r.value),[8,16,24]);
 assert.equal(read('nonzero',Array(14).fill(vector('Count',[1,2,3]))).rows.at(-1).value,42);
 const fees=[vector('Dollars',[10,0,200]),vector('Count',[12,2,100]),vector('Count',[2,2,0])];
 assert.deepEqual(read('block-fees',fees).rows.map(r=>r.value),[1,2]);
 assert.throws(()=>read('block-fees',[fees[0],vector('Count',[0,2,100]),fees[2]]));
});

test('optional upstream failure preserves a real OI series; unsafe query and oversized stream fail closed',async()=>{
 const calls=[];
 const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async(url,init)=>{
  calls.push({url,init});
  if(url.includes('open-interest-history'))return Response.json({code:'0',data:[[String(NOW-1000),'10','1','3210.34']]});
  if(url.includes('open-interest'))return new Response('',{status:429,headers:{'Retry-After':'60'}});
  return new Response(new Uint8Array(100_001).fill(65));
 }});
 const request=async(query)=>{
  const result={};await handle({method:'GET',url:'/api/market-hub?'+query},{writeHead(status){result.status=status;},end(text){result.body=JSON.parse(text);}});return result;
 };
 const ok=await request('resource=derivatives&view=oi&symbol=BTC');
 assert.equal(ok.status,200);assert.equal(ok.body.body.rows[0].value,3210.34);assert.equal(ok.body.body.current,null);
 assert.ok(calls.every(({init})=>init.credentials==='omit'&&init.redirect==='error'));
 assert.equal((await request('resource=derivatives&view=oi&symbol=BTC&url=https://invalid.test')).status,400);
 assert.equal((await request('resource=derivatives&view=funding&symbol=BTC')).status,502);
});

test('a late response cannot cross a live route change, and failed refresh retains only its own stale observations',async t=>{
 const keys=['document','location','navigator'];
 const previous=Object.fromEntries(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const [k,value]of Object.entries({document:{hidden:false,addEventListener(){},querySelector(){return null;},activeElement:null},location:{search:'?page=derivatives&asset=BTC'},navigator:{onLine:true}}))Object.defineProperty(globalThis,k,{configurable:true,value});
 t.after(()=>{for(const [k,d]of Object.entries(previous)){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 let now=NOW,html='',page='derivatives';
 const deferred=[],root={scrollTop:0,contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}};
 const view=createLiveDataViews({root,now:()=>now,rerender(){html=view.render(page);},link:label=>label,section:(title,body)=>title+body,table:(_heads,rows)=>rows.join(''),stat:(_label,value)=>value+' ',chartPanel:()=>'',empty:text=>text,
  fetchImpl:(url,options)=>new Promise(resolve=>deferred.push({url,options,resolve}))});
 html=view.render(page);assert.match(html,/Loading|读取/);
 globalThis.location.search='?page=derivatives&asset=ETH';html=view.render(page);
 assert.equal(deferred[0].options.signal.aborted,true);
 const read=(symbol,value)=>Response.json(envelope('derivatives',{source:'OKX',view:'funding',symbol,instrument:symbol+'-USDT-SWAP',current:null,rows:[{at:NOW-1000,value}]}));
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 deferred[1].resolve(read('ETH',0.123456));await settle();
 deferred[0].resolve(read('BTC',0.987654));await settle();
 assert.match(html,/ETH-USDT-SWAP/);assert.match(html,/0\.123456/);assert.doesNotMatch(html,/0\.987654/);
 assert.equal(view.companionBrief(page).href,'?page=derivatives&asset=ETH');
 assert.match(view.companionBrief(page).body,/已更新|Updated/);
 view.render('signals');
 html=view.render(page);
 assert.match(html,/ETH-USDT-SWAP/);assert.match(html,/0\.123456/);
 assert.equal(deferred.length,2,'returning before expiry reuses the validated ETH response');
 now+=61_000;view.tick(page);deferred[2].resolve(new Response('{}',{status:502}));await settle();
 assert.match(html,/暂不可用|Source unavailable/);assert.match(html,/0\.123456/);assert.match(html,/data-quality="stale"/);
 assert.match(view.companionBrief(page).body,/暂不可用|Source unavailable/);
 view.render('signals');
 html=view.render(page);view.tick(page);
 assert.match(html,/0\.123456/);assert.match(html,/data-quality="stale"/);
 assert.equal(deferred.length,3,'switching channels cannot reset the retry deadline');
 globalThis.location.search='?page=derivatives&asset=BTC';
 html=view.render(page);
 assert.doesNotMatch(html,/ETH-USDT-SWAP|0\.123456|0\.987654/);
 assert.equal(deferred.length,4,'BTC needs its own successful read');
 deferred[3].resolve(read('BTC',0.34567));await settle();
});

test('a focused data view announces an outage without replacing the visible receipt',async t=>{
 const keys=['document','location','navigator'],prior=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
 const nav={onLine:true},focused={matches:()=>true};
 const doc={hidden:false,activeElement:focused,addEventListener(){},querySelector:()=>null};
 for(const [key,value] of Object.entries({document:doc,location:{search:'?page=derivatives&asset=ETH'},navigator:nav}))Object.defineProperty(globalThis,key,{configurable:true,value});
 t.after(()=>keys.forEach((key,i)=>prior[i]?Object.defineProperty(globalThis,key,prior[i]):Reflect.deleteProperty(globalThis,key)));
 let reading=false,now=NOW,html='';
 const updates=[],reads=[],badge={set outerHTML(value){updates.push(value);}};
 const root={scrollTop:0,contains:el=>reading&&el===focused,querySelector:sel=>sel==='.dc-live > .pd-status .pd-quality'?badge:null,querySelectorAll:()=>[]};
 const view=createLiveDataViews({root,now:()=>now,rerender(){html=view.render('derivatives');},link:v=>v,section:(h,b)=>h+b,table:(_h,rows)=>rows.join(''),stat:(_l,v)=>v,chartPanel:()=>'',empty:v=>v,
  fetchImpl:()=>new Promise(resolve=>reads.push(resolve))});
 const response=value=>Response.json({...envelope('derivatives',{source:'OKX',view:'funding',symbol:'ETH',instrument:'ETH-USDT-SWAP',current:null,rows:[{at:now-1000,value}]}),receivedAt:now});
 html=view.render('derivatives');reads[0](response(.123456));await new Promise(setImmediate);
 const first=html;reading=true;nav.onLine=false;view.tick('derivatives');view.tick('derivatives');
 assert.equal(html,first);assert.equal(reads.length,1);assert.equal(updates.length,1);assert.match(updates[0],/data-quality="stale".*(断开|offline)/i);
 now+=3_600_000;nav.onLine=true;view.tick('derivatives');reads[1](response(.333333));await new Promise(setImmediate);
 assert.equal(html,first);assert.match(updates.at(-1),/data-quality="stale"/);assert.doesNotMatch(updates.at(-1),/<time>/);
 reading=false;view.tick('derivatives');assert.match(html,/0\.333333/);assert.doesNotMatch(html,/0\.123456/);assert.equal(reads.length,2);
});

import {BTC_DISCLOSED_ADDRESSES} from './public-btc-disclosed.mjs';
test('BTC disclosed balances use a separate bounded resource, exact values and six verified address links',async t=>{
 const metric='btc-disclosed-balance',route=liveDataRoute('tracking','metric='+metric),calls=[];
 let clock=NOW;
 const relay=createMarketHubRelay({now:()=>++clock,fetchImpl:async(url,opts)=>{
  calls.push(url);assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');
  const index=BTC_DISCLOSED_ADDRESSES.findIndex(address=>url==='https://mempool.space/api/address/'+address);assert.ok(index>=0);
  return Response.json({address:BTC_DISCLOSED_ADDRESSES[index],chain_stats:{funded_txo_count:2,funded_txo_sum:100000001,spent_txo_count:1,spent_txo_sum:index===0?100000001:0,tx_count:2}});
 }});
 async function read(query,method='GET'){
  let result;await relay({url:'/api/market-hub?resource='+metric+query,method},{writeHead(status){result={status}},end(text){result.data=JSON.parse(text);}});return result;
 }
 const result=await read(''),b=result.data.body;assert.equal(result.status,200);assert.equal(result.data.receivedAt,b.receivedAt);assert.deepEqual(calls,BTC_DISCLOSED_ADDRESSES.map(address=>'https://mempool.space/api/address/'+address));
 assert.equal(route.resource,metric);assert.deepEqual(route.query,{});assert.equal(b.totalConfirmedBtc,'5.00000005');
 const checked=validateLiveDataResponse(result.data,route,clock);
 assert.equal(checked.asOf,null);assert.equal(checked.validUntil,b.receivedAt+1800000);
 for(const patch of [v=>v.receivedAt++,v=>v.body.rows[0].explorerUrl='https://wrong.test',v=>v.body.totalConfirmedSats='42']){
  const altered=structuredClone(result.data);patch(altered);assert.throws(()=>validateLiveDataResponse(altered,route,clock),/INVALID_DATA/);
 }
 assert.equal((await read('&metric=exchange-netflow')).status,400);assert.equal((await read('','POST')).status,405);
 assert.equal((await read('')).data.receivedAt,b.receivedAt);assert.equal(calls.length,6);
 const keys=['document','location','navigator'],old=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
 for(const [k,v] of Object.entries({document:{hidden:false,addEventListener(){},querySelector(){return null;},activeElement:null},location:{search:'?page=tracking&metric='+metric},navigator:{onLine:true}}))Object.defineProperty(globalThis,k,{configurable:true,value:v});
 t.after(()=>keys.forEach((k,i)=>old[i]?Object.defineProperty(globalThis,k,old[i]):delete globalThis[k]));
 const requested=[];let html='';
 const view=createLiveDataViews({now:()=>clock,root:{contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]},link:(label,page,params)=>`<a href="?${new URLSearchParams({page,...params})}">${label}</a>`,section:(title,content,source)=>[title,content,source].join(' '),table:(heads,rows)=>heads.join(' ')+rows.join(''),stat:(...values)=>values.join(' '),chartPanel:()=>assert.fail(),empty:text=>text,rerender:()=>{html=view.render('tracking');},fetchImpl:async url=>{requested.push(url);return Response.json(result.data);}});
 view.render('tracking');await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(requested,['/api/market-hub?resource='+metric]);
 assert.match(html,/5\.00000005 BTC/);assert.match(html,/500000005 sat/);assert.match(html,/6 \/ 6/);assert.match(html,/2022-11-11|November 11, 2022/);assert.match(html,/当前控制权未经复核|Current control is unverified/);
 assert.ok(html.includes(b.disclosure.url));assert.ok(html.includes(new Date(b.requestStartedAt).toISOString()));assert.ok(html.includes(new Date(b.receivedAt).toISOString()));
 assert.deepEqual([...html.matchAll(/href="https:\/\/mempool\.space\/address\/([^"]+)"/g)].map(m=>m[1]),BTC_DISCLOSED_ADDRESSES);
 assert.match(html,/<td class="">0<\/td>/);
});

test('cross-venue liquidation route uses the oldest reported aggregate timestamp for freshness',async()=>{
 const {publicDerivativesRequest}=await import('./public-market-extended.mjs');
 const route=liveDataRoute('derivatives','view=venue-liquidations&asset=BTC');
 const req=publicDerivativesRequest(new URLSearchParams(route.query));
 assert.ok(req);assert.equal(req.resource,'derivatives');
 const coins={ok:true,data:{src:'own',ts:NOW-1000,coins:[{s:'BTC',long:90,short:10,liq:100}]}};
 const venues={ok:true,data:{ts:NOW-2000,source:'MarginPad liquidation collector',window:'24h',total:200,venues:[{venue:'binance',long:140,short:60,total:200}]}};
 const body=req.decode([coins,venues],NOW);
 const stamp=validateLiveDataResponse({schema:'public-market-relay-v1',resource:'derivatives',receivedAt:NOW,body},route,NOW);
 assert.equal(stamp.asOf,NOW-2000);assert.equal(stamp.validUntil,NOW-2000+route.stale);
 assert.equal(body.byVenue.scope,'all-assets');assert.equal(body.byVenue.total,200);assert.equal(body.byAsset.rows[0].total,100);
 assert.equal(liveDataRoute('derivatives','view=venue-liquidations&asset=XRP').resource,'asset-liquidations');
 assert.equal(liveDataRoute('derivatives','view=venue-liquidations&asset=unknown').resource,null);
 const sample={schema:'public-market-relay-v1',resource:'derivatives',receivedAt:NOW,body:{unit:'USDT',byVenue:null,byAsset:null}};
 assert.throws(()=>validateLiveDataResponse(sample,route,NOW),/INVALID_DATA/);
});

test('official liquidation feeds keep source direction, price basis, symbol and source timestamps',async()=>{
 const {liquidationUpdates}=await import('./venue-liquidation-stream.mjs');
 const base={T:NOW,s:'ETHUSDT'},bin={...base,S:'SELL',z:'2.5',ap:'2037',q:'90',p:'2000',X:'FILLED'},by={...base,S:'Buy',v:'2.5',p:'1998'};
 const binRead=e=>liquidationUpdates('binance','ETH',{stream:'ethusdt@forceOrder',data:{e:'forceOrder',o:e}},NOW-100,NOW);
 const byRead=(...rows)=>liquidationUpdates('bybit','ETH',{topic:'allLiquidation.ETHUSDT',type:'snapshot',data:rows},NOW-100,NOW);
 assert.equal(binRead(bin)[0].amount,5092.5);assert.equal(binRead(bin)[0].position,'long');assert.equal(binRead({...bin,S:'BUY'})[0].position,'short');
 assert.equal(byRead(by)[0].amount,4995);assert.equal(byRead(by)[0].position,'long');assert.equal(byRead({...by,S:'Sell'})[0].position,'short');
 const twins=byRead(by,by);assert.equal(twins.length,2);assert.notEqual(twins[0].key,twins[1].key);assert.deepEqual(twins,byRead(by,by));
 for(const bad of [{s:'BTCUSDT'},{S:'sell'},{T:NOW-101},{T:NOW+6000}]){assert.equal(byRead({...by,...bad}).length,0);assert.equal(binRead({...bin,...bad}).length,0);}
 for(const bad of [{z:'0'},{z:'Infinity'},{ap:null},{X:'NEW'}])assert.equal(binRead({...bin,...bad}).length,0);
 assert.equal(byRead({...by,v:'-4'}).length,0);
});

test('official liquidation tape acknowledges both subscriptions, bounds and deduplicates replay, reconnects and closes',async()=>{
 const {createLiquidationTape}=await import('./venue-liquidation-stream.mjs');
 const sockets=[];let now=NOW;
 class Socket{
  sent=[];constructor(url){this.url=url;sockets.push(this);}
  send(msg){this.sent.push(JSON.parse(msg));}close(){this.closed=true;}
  get(data){this.onmessage?.({data:JSON.stringify(data)});}
 }
 const feed=createLiquidationTape('SOL',()=>{},{now:()=>now,WebSocketImpl:Socket});feed.tick();
 const [bin,by]=sockets;bin.onopen();by.onopen();
 assert.deepEqual(bin.sent[0].params,['solusdt@forceOrder']);assert.deepEqual(by.sent[0].args,['allLiquidation.SOLUSDT']);
 assert.deepEqual(feed.slots.map(v=>v.status),['connecting','connecting']);
 bin.get({result:null,id:'subscribe'});assert.deepEqual(feed.slots.map(v=>v.status),['live','connecting']);assert.equal(feed.events.length,0);
 const msgs=Array.from({length:32},(_,i)=>({T:NOW+i,s:'SOLUSDT',S:'Sell',v:'7',p:'89'}));
 const message={topic:'allLiquidation.SOLUSDT',type:'snapshot',data:msgs};now+=500;by.get(message);assert.equal(feed.slots[1].status,'live');by.get({op:'subscribe',req_id:'subscribe',success:true});by.get(message);
 assert.equal(feed.events.length,25);assert.equal(feed.events[0].at,NOW+31);assert.equal(feed.events.at(-1).at,NOW+7);
 now+=20000;feed.tick();assert.equal(bin.sent.at(-1).method,'LIST_SUBSCRIPTIONS');assert.equal(by.sent.at(-1).op,'ping');
 by.get({op:'ping',ret_msg:'pong',success:true});
 now+=12000;feed.tick();assert.equal(bin.closed,true);assert.deepEqual(feed.slots.map(v=>v.status),['disconnected','live']);
 now+=2999;feed.tick();assert.equal(sockets.length,2);now++;feed.tick();assert.equal(sockets.length,3);
 const late=by.onmessage;feed.dispose();assert.ok(sockets.every(ws=>ws.closed));late({data:JSON.stringify(message)});assert.equal(feed.events.length,25);
});

test('the visible cross-venue page streams through a failed 24h request and releases sockets on navigation and hiding',async t=>{
 const keys=['document','location','navigator','WebSocket'],previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
 const sockets=[],listeners={},doc={hidden:false,addEventListener(k,fn){listeners[k]=fn;},querySelector(){return null;},activeElement:null};
 class Socket{constructor(url){sockets.push(this);}send(){}close(){this.closed=true;}}
 const location={search:'?view=venue-liquidations&asset=BTC'};
 for(const [k,v] of Object.entries({document:doc,location,navigator:{onLine:true},WebSocket:Socket}))Object.defineProperty(globalThis,k,{configurable:true,value:v});
 t.after(()=>keys.forEach((k,i)=>previous[i]?Object.defineProperty(globalThis,k,previous[i]):Reflect.deleteProperty(globalThis,k)));
 const root={scrollTop:0,contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}};
 let html='',page='derivatives';
 const views=createLiveDataViews({root,now:()=>NOW,rerender(){html=views.render(page);},link:v=>v,section:(h,b)=>h+b,table:(labels,rows)=>rows.join(''),stat:()=>'',chartPanel:()=>'',empty:v=>v,fetchImpl:async()=>new Response('',{status:502})});
 html=views.render(page);await new Promise(resolve=>setImmediate(resolve));assert.equal(sockets.length,2);
 for(const [s,m] of [[sockets[0],{id:'subscribe',result:null}],[sockets[1],{op:'subscribe',req_id:'subscribe',success:true}]])s.onmessage({data:JSON.stringify(m)});
 sockets[1].onmessage({data:JSON.stringify({topic:'allLiquidation.BTCUSDT',type:'snapshot',data:[{T:NOW,s:'BTCUSDT',S:'Buy',v:'2',p:'10.75'}]})});views.tick(page);
 assert.match(html,/21\.5/);assert.match(html,/Binance/);
 location.search='?view=venue-liquidations&asset=SOL';html=views.render(page);assert.ok(sockets.slice(0,2).every(s=>s.closed));assert.equal(sockets.length,4);assert.doesNotMatch(html,/21\.5/);
 doc.hidden=true;listeners.visibilitychange();views.tick(page);assert.ok(sockets.every(s=>s.closed));assert.equal(sockets.length,4);
 doc.hidden=false;views.tick(page);assert.equal(sockets.length,6);
 page='tracking';views.tick(page);assert.ok(sockets.every(s=>s.closed));
});
