import test from 'node:test';
import assert from 'node:assert/strict';
import {publicEthEtfHoldingsRequest,validateEthEtfHoldings} from './public-eth-etf-holdings.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {createLiveDataViews,liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';

const now = Date.parse('2026-11-18T05:00:00Z');
const seconds = date => Date.parse(date)/1000;
const request = publicEthEtfHoldingsRequest(new URLSearchParams());
const fixture = () => ({
  asset:'ETH',credit:'CryptoKeyhole',page:'https://cryptokeyhole.com/etf-flows/ethereum/',
  licence:'https://creativecommons.org/licenses/by/4.0/',funds:11,day:'2026-11-13',
  netFlow:6230.25,netFlowUsd:12_000_500.1,
  days:[[seconds('2026-11-12'),-100.55],[seconds('2026-11-13'),12_000_500.1]],
  open:[seconds('2026-11-17'),494.15,'1 of 8 funds reported'],
  movers:[{ticker:'ETHA',name:'iShares Ethereum Trust ETF',asOf:'2026-11-16',flow:0},
    {ticker:'TETH',name:'21Shares Ethereum Staking ETF',asOf:'2026-11-17',flow:0.27}]
});
const decode = value=>request.decode([value],now);

test('the ETH holdings source has a fixed destination, independently dated fund changes, licensed credit and a partial session',()=>{
  assert.equal(request.policy.url,'https://cryptokeyhole.com/widget/etf-flows.json?asset=ETH');
  assert.equal(publicEthEtfHoldingsRequest(new URLSearchParams('asset=ETH')),null);
  const body=decode(fixture());
  assert.equal(validateEthEtfHoldings(body,now),true);
  assert.deepEqual(body.complete,{date:'2026-11-13',netEth:6230.25,netUsd:12_000_500.1});
  assert.deepEqual(body.partial,{date:'2026-11-17',netUsd:494.15,reported:1,expected:8});
  assert.equal(body.fundsCovered,11);
  assert.deepEqual(body.fundObservations.map(({date,changeEth})=>[date,changeEth]),[['2026-11-16',0],['2026-11-17',0.27]]);
  assert.equal(body.source.license,'CC BY 4.0');
  assert.equal(decode({...fixture(),open:null}).partial,null);
});

test('the contract rejects invented observations, incorrect units, duplicate funds, and invalid partials or reporting dates',()=>{
  const data=fixture();
  for(const input of [
    {...data,asset:'BTC'},{...data,licence:'none'},{...data,page:'https://invalid.test/'},{...data,netFlowUsd:123},
    {...data,netFlow:null},{...data,days:[...data.days,...data.days]},{...data,days:[[seconds('2026-11-13')+1,data.netFlowUsd]]},
    {...data,open:[seconds('2026-11-17'),null,'1 of 8 funds reported']},
    {...data,open:[seconds('2026-11-17'),0,'0 of 8 funds reported']},
    {...data,open:[seconds('2026-11-17'),0,'8 of 8 funds reported']},
    {...data,open:[seconds('2026-11-13'),0,'1 of 8 funds reported']},
    {...data,movers:[data.movers[0],data.movers[0]]},
    {...data,movers:[{...data.movers[0],flow:null}]},
    {...data,movers:[{...data.movers[0],asOf:'2026-11-20'}]},
    {...data,movers:[{...data.movers[0],asOf:'2026-11-15'}]},
    {...data,movers:[{...data.movers[0],name:'<script>'}]}
  ]) assert.throws(()=>decode(input),/INVALID_ETH_ETF_HOLDINGS/);
});

test('ETH defaults to holdings and cash, fund, range and BTC routes retain their own sources',()=>{
  for(const search of ['asset=eth','asset=ETH&view=holdings']) {
    const route=liveDataRoute('etf',search);
    assert.equal(route.resource,'eth-etf-holdings');
    assert.deepEqual(route.query,{});
  }
  for(const search of ['asset=eth&view=flows','fund=ETHA','asset=eth&range=7','asset=eth&view=holdings&fund=ETHA','asset=btc','']) {
    assert.equal(liveDataRoute('etf',search).resource,'etf');
  }
});

test('relay and browser agree on reporting scope, latest observation date and expiry',async()=>{
  const sourceCalls=[];
  const relay=createMarketHubRelay({now:()=>now,fetchImpl:async(url,init)=>{
    sourceCalls.push([url,init.credentials]);
    return Response.json(fixture());
  }});
  async function read(query) {
    const result={};
    await relay({method:'GET',url:'/api/market-hub?'+query},{writeHead(status){result.status=status;},end(value){result.body=JSON.parse(value);}});
    return result;
  }
  assert.equal((await read('resource=eth-etf-holdings&symbol=ETH')).status,400);
  const result=await read('resource=eth-etf-holdings');
  assert.equal(result.status,200);
  assert.deepEqual(sourceCalls,[[request.policy.url,'omit']]);
  const route=liveDataRoute('etf','asset=eth');
  const receipt=validateLiveDataResponse(result.body,route,now);
  assert.equal(receipt.asOf,Date.parse('2026-11-17'));
  assert.equal(receipt.body.complete.date,'2026-11-13');
  assert.equal(receipt.validUntil,now+86_400_000);
  assert.throws(()=>validateLiveDataResponse(result.body,liveDataRoute('etf','asset=eth&view=flows'),now),/INVALID_DATA/);
  const old={...result.body,receivedAt:now+10*86_400_000};
  assert.ok(validateLiveDataResponse(old,route,old.receivedAt).validUntil<old.receivedAt);
});


test('cash flows can open without contacting a provider that blocks embedding',t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{value:{search:'?page=etf&asset=eth&view=flows'},configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;});
  const views=createLiveDataViews({root:{},link:label=>label,section:(title,body)=>title+body,empty:text=>text});
  const html=views.render('etf');
  assert.match(html,/现金净申赎|Cash net flows/i);
  assert.doesNotMatch(html,/cryptoetf\.today\/embed|<iframe/i);
});
