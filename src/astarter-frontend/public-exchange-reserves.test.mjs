import assert from 'node:assert/strict';
import test from 'node:test';
import {publicExchangeReservesRequest,validateExchangeReserves} from './public-exchange-reserves.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';

const at=Date.UTC(2026,10,18,14),now=at+600_000;
const snapshot=(rows,stamp='14:00 UTC on 18 Nov 2026',labels=['Exchange','Reserves','24 hours','7 days','Bitcoin','Ether','Stablecoins'])=>
 '<table aria-label="Reserves and net flows at '+stamp+'"><thead><tr>'+
 labels.map(label=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+
 rows.map(([slug,name,btc,eth])=>'<tr><td><a class="k-link" href="#'+slug+'">'+name+'</a></td>'+
 ['$5B','+$4M','−$1M',btc,eth,'$1B'].map(value=>'<td>'+value+'</td>').join('')+'</tr>').join('')+
 '</tbody></table>';
const sourceRows=[['binance','Binance','632,407','2.57M'],['okx','OKX','170,906','—'],['htx','HTX','7,494','0']];

test('exchange reserves retain native published balances, zero versus missing, and the hour of observation',()=>{
 const request=publicExchangeReservesRequest(new URLSearchParams());
 assert.equal(request.resource,'exchange-reserves');
 assert.equal(request.policy.url,'https://cryptokeyhole.com/proof-of-reserves/');
 assert.equal(request.policy.format,'text');
 const result=request.decode([snapshot(sourceRows)],now);
 assert.equal(result.asOf,at);
 assert.equal(result.source.license,'CC BY 4.0');
 assert.deepEqual(result.rows,[
  {slug:'binance',name:'Binance',btc:632407,eth:2570000,net24hUsd:4e6,net7dUsd:-1e6},
  {slug:'okx',name:'OKX',btc:170906,eth:null,net24hUsd:4e6,net7dUsd:-1e6},
  {slug:'htx',name:'HTX',btc:7494,eth:0,net24hUsd:4e6,net7dUsd:-1e6}
 ]);
 assert.ok(validateExchangeReserves(result,now));
 assert.equal(validateExchangeReserves({...result,source:{...result.source,url:'https://wrong.test'}},now),false);
 assert.equal(publicExchangeReservesRequest(new URLSearchParams('url=https://wrong.test')),null);
});

test('rolling exchange flows preserve the source sign, scale, missing amounts, and explicit zero',()=>{
 const req=publicExchangeReservesRequest(new URLSearchParams());
 const html=snapshot(sourceRows).replace('+$4M','−$663,212').replace('−$1M','+$37.3M')
  .replace('+$4M','—').replace('−$1M','$0');
 const {rows}=req.decode([html],now);
 assert.equal(rows[0].net24hUsd,-663212);assert.equal(rows[0].net7dUsd,37300000);
 assert.equal(rows[1].net24hUsd,null);assert.equal(rows[1].net7dUsd,0);
 assert.equal(req.decode([html.replace('+$37.3M','$37.3M')],now).rows[0].net7dUsd,null);
 assert.equal(req.decode([html.replace('+$37.3M','−$260.6M')],now).rows[0].net7dUsd,-260600000);
});

test('exchange reserves reject duplicated venues, malformed balances, changed units, and future observations',()=>{
 const request=publicExchangeReservesRequest(new URLSearchParams());
 for(const html of [snapshot([...sourceRows,sourceRows[0]]),snapshot([['okx','OKX','$25M','1.6M']]),
  snapshot([['okx','OKX','−9','1.6M']]),snapshot(sourceRows,'15:00 UTC on 18 Nov 2026'),
  snapshot(sourceRows,'14:00 UTC on 31 Nov 2026'),snapshot(sourceRows,'14:00 UTC on 18 Nov 2026',
   ['Exchange','Reserves','24 hours','7 days','Bitcoin (USD)','Ether','Stablecoins'])]){
  assert.throws(()=>request.decode([html],now),/INVALID_EXCHANGE_RESERVES/);
 }
});

test('the production relay and both reserve entry points agree on source freshness',async ()=>{
 const observed=[];
 const relay=createMarketHubRelay({now:()=>now,fetchImpl:async (url,options)=>{
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  observed.push(url);return new Response(snapshot(sourceRows));
 }});
 async function read(query){
  let result;
  await relay({url:'/api/market-hub?resource=exchange-reserves'+query,method:'GET'},
   {writeHead(status){result={status};},end(value){result.envelope=JSON.parse(value);}});
  return result;
 }
 const first=await read(''),second=await read('');
 assert.equal(first.status,200);assert.deepEqual(first,second);
 assert.deepEqual(observed,['https://cryptokeyhole.com/proof-of-reserves/']);
 for(const metric of ['exchange-balance','eth-exchange']){
  const route=liveDataRoute('tracking','metric='+metric);
  assert.equal(route.resource,'exchange-reserves');
  const receipt=validateLiveDataResponse(first.envelope,route,now);
  assert.equal(receipt.validUntil,at+3_600_000*3);
  assert.equal(receipt.body.rows[0].btc,632407);
 }
 assert.equal((await read('&view=anything')).status,400);
});
