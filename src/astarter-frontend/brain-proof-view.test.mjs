import test from 'node:test';
import assert from 'node:assert/strict';
import {frozenChartBars} from './brain-proof-view.mjs';

const day=86400,start=Date.UTC(2026,10,1)/1000;
const bars=[0,1,2,3,4].map(i=>[start+i*day,10,13,9,12,0]);
const market={key:'coin:bitcoin',venue:'Binance Spot',market:'BTCUSDT',quote:'USDT'};
const evidence={...market,barCount:3,asOf:new Date((start+4*day)*1000-1).toISOString()};
const windowFor=(input,overrides={})=>frozenChartBars({assets:[{...market,bars:input}]},market.key,{...evidence,...overrides});

test('candles use exactly the closed sessions belonging to the registered market and cutoff',()=>{
  const result=windowFor(bars);
  assert.deepEqual(result.map(row=>row.time),bars.slice(1,4).map(row=>row[0]*1000));
  assert.equal(result.at(-1).volume,0);
  for(const overrides of [{market:'ETHUSDT'},{quote:'USD'},{venue:'Other'},{asOf:'invalid'}]){
    assert.deepEqual(windowFor(bars,overrides),[]);
  }
});

test('an incomplete or inconsistent frozen price window cannot draw a chart',()=>{
  for(const replacement of [bars[1],[bars[2][0],10,9,8,12,5],[bars[2][0],10,13,9,12,null]]){
    assert.deepEqual(windowFor(bars.with(2,replacement)),[]);
  }
  assert.deepEqual(windowFor(bars.filter((_,i)=>i!==2)),[]);
});
