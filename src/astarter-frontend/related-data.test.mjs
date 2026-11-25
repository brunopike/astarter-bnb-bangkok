import test from 'node:test';
import assert from 'node:assert/strict';
import {relatedAssetTarget,readRelatedAsset,relatedAssetView} from './related-data.mjs';

const now=1793923200000,target=relatedAssetTarget('?page=markets&asset=ETH');
const asset={id:'ethereum',symbol:'ETH',name:'Ethereum',price:3000,change:2,volume:100000,asOf:now,series:[2900,3000]};
test('related market previews only resolve explicit local routes and canonical asset identities',()=>{
 assert.equal(target.id,'ethereum');
 for(const href of ['https://evil.test/?page=markets&asset=ETH','//evil.test/?page=markets&asset=ETH','?page=assistant&asset=ETH','?page=markets&asset=ETH&coin=bitcoin','?page=markets&asset=UNKNOWN','?page=markets&asset=XAU&data=live','?page=markets&asset=ETH&data=live'])assert.equal(relatedAssetTarget(href),null);
 assert.equal(relatedAssetTarget('?page=markets&asset=XAU').example,true);
 assert.equal(relatedAssetTarget('?page=markets&asset=ETH&data=demo').example,true);
});
test('preview reuses a fresh snapshot without a new request and keeps quote and history units separate',async()=>{
 const result=await readRelatedAsset(target,{rows:[asset],now,quote:a=>({...a,price:3002,quote:'USDT',provider:'Binance Spot'}),load(){assert.fail('fresh snapshot must not fetch');}});
 assert.equal(result.state,'ready');assert.equal(result.quote.price,3002);assert.deepEqual(result.asset.series,[2900,3000]);
 const html=relatedAssetView(target,result);assert.match(html,/Binance Spot/);assert.match(html,/USDT/);assert.match(html,/data-chart="related-asset"/);
});
test('failed or wrong-identity reads cannot replace public data with fixtures or create a zero quote',async()=>{
 const bad=async()=>({failed:0,rows:[{...asset,id:'bitcoin'}]});
 assert.equal((await readRelatedAsset(target,{now,load:bad})).state,'unavailable');
 const stale=await readRelatedAsset(target,{rows:[{...asset,asOf:now-3600000}],now,load:async()=>{throw Error('offline');}});
 assert.equal(stale.state,'stale');assert.equal(stale.quote.price,3000);
 assert.equal((await readRelatedAsset(target,{now,load:async()=>({failed:1,rows:[]})})).state,'unavailable');
 assert.doesNotMatch(relatedAssetView(target,{state:'unavailable'}),/3,000|NaN|undefined/);
});
test('new preview reads retain provider source time and cancellation is not rendered as success',async()=>{
 const result=await readRelatedAsset(target,{now,load:async()=>({failed:0,rows:[asset]})});
 assert.equal(result.quote.asOf,now);assert.equal(result.asset.id,target.id);
 const controller=new AbortController();controller.abort();
 await assert.rejects(readRelatedAsset(target,{now,signal:controller.signal,load:async()=>{throw new DOMException('Cancelled','AbortError');}}),{name:'AbortError'});
});
test('explicit sample previews keep their fixed time and escape provider content',async()=>{
 const example=await readRelatedAsset(relatedAssetTarget('?page=markets&asset=XAU'),{load(){assert.fail('sample preview must not fetch');}});
 assert.equal(example.state,'example');assert.equal(example.quote.asOf,Date.parse('2026-10-24T14:00:00+08:00'));
 const html=relatedAssetView(target,{asset:{...asset,name:'<img onerror=x>'},quote:{...asset,quote:'USD',provider:'<script>x</script>'},state:'ready'});
 assert.doesNotMatch(html,/<script>|<img onerror/);assert.match(html,/&lt;script&gt;/);
});

test('preview percentages are concise and absent sample volume is distinct from a reported zero',async()=>{
 const example=await readRelatedAsset(relatedAssetTarget('?page=markets&asset=XAU'));
 const before=JSON.stringify(example),gold=relatedAssetView({symbol:'XAU'},example);
 assert.match(gold,/<dd>—<\/dd>/);assert.doesNotMatch(gold,/>0 USD<\/dd>/);assert.equal(JSON.stringify(example),before);
 for(const [change,expected] of [[-.1230384,'-0.12%'],[.1230384,'+0.12%'],[0,'0%'],[null,'—']]){
  const html=relatedAssetView(target,{asset:{...asset,price:.0000123},quote:{...asset,price:.0000123,change,volume:0,quote:'USD',provider:'Test'},state:'ready'});
  assert.ok(html.includes('>'+expected+'</b>'));assert.ok(html.includes('>'+expected+'</dd>'));
  assert.match(html,/<dd>0 USD<\/dd>/);assert.match(html,/>0\.0000123<\/strong>/);
 }
 const missing=relatedAssetView(target,{asset,quote:{...asset,volume:undefined,quote:'USD',provider:'Test'},state:'ready'});
 assert.match(missing,/<dd>—<\/dd>/);assert.doesNotMatch(missing,/— USD/);
});
