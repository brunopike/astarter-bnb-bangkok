import assert from 'node:assert/strict';
import test from 'node:test';
import {loadAssetVenueLiquidations,normalizeAssetVenueLiquidations} from './browser-asset-liquidations.mjs';

const HOUR=3_600_000,now=Date.UTC(2026,10,18,20,12);
function snapshot(at=now){
  const since=at-24*HOUR,first=Math.floor(since/HOUR)*HOUR,last=Math.floor((at-1)/HOUR)*HOUR;
  const t=Array.from({length:(last-first)/HOUR+1},(_,i)=>first+i*HOUR);
  return {coin:'BTC',window:'24h',source:'db',partial:false,since,until:at,as_of:at,long:9.32,short:0.02,total:9.34,count:6,
    venues:[{venue:'bybit',long:4.66,short:0.01,count:3},{venue:'binance',long:4.65,short:0.01,count:3}],
    coins:[{base:'BTC',long:9.32,short:0.02,count:6}],
    buckets:{step:HOUR,t,long:t.map((_,i)=>i===2?9.32:0),short:t.map((_,i)=>i===3?0.02:0)}};
}

test('date-bounded venue and coin totals reconcile down to published precision',()=>{
  const d=normalizeAssetVenueLiquidations(snapshot(),'BTC',now);
  assert.equal(d.scope,'asset-by-venue');assert.equal(d.unit,'USD');assert.equal(d.asOf-d.start,24*HOUR);
  assert.deepEqual(d.total,{long:9.32,short:0.02,count:6});assert.deepEqual(d.rows.map(r=>r.coverage),['complete','sampled']);
  assert.equal(d.source.url,'https://swolecharts.com/liquidations/BTC/24h');
  const boundary=Math.floor(now/HOUR)*HOUR;assert.equal(normalizeAssetVenueLiquidations(snapshot(boundary),'BTC',boundary).asOf,boundary);
});

test('declines a partial window, a mismatched coin, a gap, an absent observation or duplicate venue counts',()=>{
  const changes=[d=>{d.partial=true},d=>{d.source='memory'},d=>{d.since+=1},d=>{d.as_of-=4000},d=>{d.window='1h'},
    d=>{d.coin='ETH'},d=>{d.coins[0].base='SOL'},d=>{d.venues[1].venue='bybit'},d=>{d.venues[1].count=1},
    d=>{d.buckets.long[0]=null},d=>{d.buckets.t[12]+=HOUR},d=>{d.venues[0].long+=4},d=>{d.buckets.short[11]=1},d=>{d.coins=[]}];
  for(const change of changes){const raw=snapshot();change(raw);assert.throws(()=>normalizeAssetVenueLiquidations(raw,'BTC',now));}
  assert.throws(()=>normalizeAssetVenueLiquidations(snapshot(),'BTC',now+11*60_000));
  const empty=snapshot();Object.assign(empty,{count:0,total:0,long:0,short:0,coins:[],venues:[]});empty.buckets.long.fill(0);empty.buckets.short.fill(0);
  assert.deepEqual(normalizeAssetVenueLiquidations(empty,'BTC',now).rows,[]);
});

test('a single public CORS request uses no credentials or Astarter relay and honours cancellation',async()=>{
  let calls=0;const abort=new AbortController();
  const fetchImpl=async(url,options)=>{calls++;assert.equal(url,'https://swolecharts.com/api/liquidations/window?window=24h&coin=BTC');
    assert.equal(options.mode,'cors');assert.equal(options.credentials,'omit');assert.equal(options.signal,abort.signal);
    return {ok:true,json:()=>snapshot(Date.now())};};
  await loadAssetVenueLiquidations('BTC',{signal:abort.signal,fetchImpl});assert.equal(calls,1);
  await assert.rejects(()=>loadAssetVenueLiquidations('BAD',{fetchImpl}));assert.equal(calls,1);
  await assert.rejects(()=>loadAssetVenueLiquidations('ETH',{fetchImpl:async()=>({ok:false})}));
});
