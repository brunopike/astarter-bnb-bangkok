import assert from 'node:assert/strict';
import test from 'node:test';
import {marginPadLiquidationsRequest,validMarginPadLiquidations} from './public-marginpad-liquidations.mjs';

const now=Date.UTC(2026,10,18,20,12),assetAt=now-120000,venueAt=now-720000;
const request=marginPadLiquidationsRequest('BTC');
const assets={ok:true,ts:now,data:{ts:assetAt,src:'own',coins:[{s:'ETH',long:60.25,short:10.5,liq:70.75},
  {s:'BTC',long:100,short:0,liq:100},{s:'DOGE',long:1,short:2,liq:3}]}};
const venues={ok:true,ts:now,data:{ts:venueAt,window:'24h',source:'MarginPad liquidation collector (13 websocket feeds, 12 exchanges)',total:401,
  venues:[{venue:'binance',long:100,short:130,total:229},{venue:'binance-coin',long:100,short:72,total:172}]}};

test('fixed collectors share one cache across supported assets and retain independently dated scopes',()=>{
  assert.equal(request.key,marginPadLiquidationsRequest('SOL').key);
  assert.equal(marginPadLiquidationsRequest('ETH/USD'),null);
  assert.deepEqual(request.policy.urls.map(s=>s.url),['https://marginpad.io/api/v1/liquidations','https://marginpad.io/api/v1/venues']);
  const b=request.decode([assets,venues],now);
  assert.equal(b.unit,'USD');assert.equal(b.windowHours,24);
  assert.deepEqual(b.byAsset,{scope:'per-asset',asOf:assetAt,rows:[{symbol:'ETH',long:60.25,short:10.5,total:70.75},{symbol:'BTC',long:100,short:0,total:100}]});
  assert.equal(b.byVenue.scope,'all-assets');assert.equal(b.byVenue.asOf,venueAt);assert.equal(b.byVenue.total,401);
  assert.deepEqual(b.byVenue.rows.map(x=>x.id),['binance','binance-coin']);assert.ok(validMarginPadLiquidations(b,now));
});

test('returns one available projection, never fills missing observations, and rejects invalid units, timestamps and duplicate venues',()=>{
  const stale={...assets,data:{...assets.data,ts:now-3600001}};
  const empty={...assets,data:{...assets.data,coins:[]}};
  for(const broken of [null,stale,empty,{...assets,data:{...assets.data,coins:[...assets.data.coins,assets.data.coins[0]]}}]){
    const b=request.decode([broken,venues],now);assert.equal(b.byAsset,null);assert.ok(b.byVenue);
  }
  const duplicate={...venues,data:{...venues.data,venues:venues.data.venues.map(row=>({...row,venue:'binance'}))}};
  for(const broken of [null,duplicate,{...venues,data:{...venues.data,total:5}},{...venues,data:{...venues.data,window:'1h'}},
    {...venues,data:{...venues.data,ts:now+120000}}]){
    assert.equal(request.decode([assets,broken],now).byVenue,null);
  }
  assert.throws(()=>request.decode([null,null],now));
  const b=request.decode([assets,venues],now);
  assert.equal(validMarginPadLiquidations({...b,unit:'USDT'},now),false);
  assert.equal(validMarginPadLiquidations({...b,byVenue:{...b.byVenue,scope:'per-asset'}},now),false);
});
