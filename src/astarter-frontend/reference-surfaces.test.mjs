import test from 'node:test';import assert from 'node:assert/strict';import {fundRows,assetReconciliation,trackingTable} from './reference-surfaces.mjs';
import {contributionModel,rankedModel} from './vendor/mmdock/report-visuals.mjs';
test('ValueScan window/venue filtering preserves fund arithmetic and source fixtures',()=>{
 const initial=fundRows();assert.equal(initial.length,12);
 for(const market of ['spot','perp'])for(const window of ['5m','15m','1h','4h','24h','7d'])for(const r of fundRows({market,window})){
 assert.ok(Math.abs(r.inflow-r.outflow-r.flow)<.0001);assert.ok(r.inflow>=0&&r.outflow>=0);// The copied display fixtures use IEEE-754 numbers, not ledger decimals.
 assert.ok(Math.abs(r.inflow+r.outflow-r.volume)<=Number.EPSILON*Math.max(1,r.volume)*2);}
 assert.equal(fundRows({query:'sol'}).length,1);assert.deepEqual(fundRows(),initial);
 assert.ok(fundRows({sort:'volume'}).every((r,i,a)=>!i||a[i-1].volume>=r.volume));
});
test('copied MMDock accounting visuals flag a mismatch instead of hiding it',()=>{
 assert.equal(contributionModel({value:10000},[{value:-2}],{value:9998}).status,'balanced');
 assert.equal(contributionModel({value:10000},[{value:-2}],{value:9999}).status,'mismatch');
 assert.equal(rankedModel([{value:100},{value:null}]).shares,false);
 assert.match(assetReconciliation({cash:8998,held:1000,equity:9998,fees:2}),/账本平衡/);
});
