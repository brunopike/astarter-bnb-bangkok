import test from 'node:test';
import assert from 'node:assert/strict';
import {EXCHANGE_FLOW_POLICY,publicExchangeFlowsRequest,validateExchangeFlows} from './public-exchange-flows.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {liveDataRoute,validateLiveDataResponse,createLiveDataViews} from './data-live-views.mjs';

const end=Date.UTC(2026,10,18),now=end+8*3600_000;
const raw={view:'daily',plan:'free',generatedAt:now/1000,period:{start:end/1000-86400,end:end/1000},
 assets:[{id:'ETH',included:true,flows:false},{id:'BTC',included:true},{id:'USD',included:true},{id:'DOGE',included:false}],
 rows:[{exchange:'KuCoin',slug:'kucoin',net:-250,net7d:null,coins:['BTC','ETH','USD','DOGE']},
 {exchange:'Binance',slug:'binance',net:200,net7d:0,coins:['BTC','ETH']}]};
const request=publicExchangeFlowsRequest(new URLSearchParams());

test('a completed UTC day ranks covered venues, keeps zero distinct from a missing seven-day observation',()=>{
 const body=request.decode([raw],now);
 assert.ok(validateExchangeFlows(body,now));
 assert.deepEqual(body.rows.map(({name,netUsd,net7dUsd})=>[name,netUsd,net7dUsd]),[['Binance',200,0],['KuCoin',-250,null]]);
 assert.deepEqual(body.rows[1].assets,['BTC','ETH','USD']);
 for(const mutate of [x=>x.period.start++,x=>x.period.end+=86400,x=>x.generatedAt+=300,x=>x.plan='pro',x=>x.rows[0].net=null,
  x=>x.rows[1].slug=x.rows[0].slug,x=>x.rows[1].exchange='<img>',x=>x.rows[1].coins=['UNKNOWN']]){
  const bad=structuredClone(raw);mutate(bad);assert.throws(()=>request.decode([bad],now),/INVALID_DATA/);
 }
 assert.equal(publicExchangeFlowsRequest(new URLSearchParams('source=other')),null);
});

test('tracking uses a fixed public source, shows covered venues and discloses the native ETH estimate',async t=>{
 let count=0;
 const relay=createMarketHubRelay({now:()=>now,fetchImpl:async(url,opts)=>{
  count++;assert.equal(url,EXCHANGE_FLOW_POLICY.url);assert.equal(opts.credentials,'omit');return Response.json(raw);
 }});
 const get=async path=>{let status,data;await relay({url:path,method:'GET'},{writeHead:s=>{status=s},end:b=>{data=JSON.parse(b)}});return Response.json(data,{status});};
 const path='/api/market-hub?resource=exchange-netflow',response=await get(path);
 const route=liveDataRoute('tracking','metric=exchange-netflow'),receipt=validateLiveDataResponse(await response.json(),route,now);
 assert.equal(receipt.asOf,end);assert.equal(receipt.validUntil,end+EXCHANGE_FLOW_POLICY.stale);
 assert.equal((await get(path+'&exchange=unknown')).status,400);
 const keys=['document','navigator','location'],old=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
 for(const [key,v] of Object.entries({document:{hidden:false,addEventListener(){},querySelector:()=>null,activeElement:null},navigator:{onLine:true},location:{search:'?page=tracking&metric=exchange-netflow'}}))Object.defineProperty(globalThis,key,{configurable:true,value:v});
 t.after(()=>keys.forEach((k,i)=>old[i]?Object.defineProperty(globalThis,k,old[i]):delete globalThis[k]));
 let html='';
 const view=createLiveDataViews({now:()=>now,root:{contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]},link:(s)=>s,section:(...p)=>p.join('\n'),table:(headers,rows)=>headers.join(' ')+rows.join(''),empty:x=>x,rerender:()=>{html=view.render('tracking')},fetchImpl:get});
 view.render('tracking');await new Promise(resolve=>setImmediate(resolve));
 assert.match(html,/2026-11-17 UTC/);assert.match(html,/Binance/);assert.match(html,/KuCoin/);
 assert.match(html,/\+\$200/);assert.match(html,/−\$250/);assert.match(html,/ETH.*(余额变化估算|balance changes)/);assert.match(html,/CC BY 4\.0/);
 assert.equal(count,1);
});
