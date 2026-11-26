import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {allowed} from './public-assets.mjs';
import assert from 'node:assert/strict';
import {getNodeHistory,defaultHistoryRecord} from './brain-history.mjs';
import {brainAssetKey,brainCatalog} from './brain-asset-data.mjs';
import archive from './brain-merge-case.json' with {type:'json'};
import marketHistory from './brain-evidence/market-history.json' with {type:'json'};
import chainHistory from './brain-evidence/chain-history.json' with {type:'json'};
import researchHistory from './brain-evidence/research-history.json' with {type:'json'};

const asOf='9999-12-31T23:59:59Z'; // Include the whole archive regardless of the test runner's clock.
const all=node=>getNodeHistory('all',node,asOf);
test('all 14 note types lead to distinct dated sources and the record IDs are globally unambiguous',()=>{
  const unique=new Map();
  for(let i=0;i<14;i++){
    const list=all(i);assert(list.length>0,'node '+i);
    assert(list.includes(defaultHistoryRecord(list,i)));
    assert.equal(new Set(list.map(x=>x.id)).size,list.length);
    for(const r of list){
      assert(r.nodes.includes(i));assert(r.scopeKeys.length);assert.ok(r.id&&r.source&&r.sourceUrl);
      assert.ok(Array.isArray(r.title)&&r.title.length===2&&r.title.every(Boolean),r.id);
      assert.ok(Array.isArray(r.body)&&r.body.length===2&&r.body.every(Boolean),r.id);
      assert(Date.parse(r.knownAt)>=Date.parse(r.eventAt),r.id);
      assert.match(r.sourceUrl,/^(https:\/\/|\/brain-evidence\/|\/brain-merge-case\.json$)/);
      if(unique.has(r.id))assert.equal(unique.get(r.id),r);
      unique.set(r.id,r);
    }
  }
  for(const row of [...chainHistory.records,...researchHistory.records])assert(unique.has(row.id),row.id);
});
test('each catalog asset has material in every node, with exact contract matching and explicit network context',()=>{
  for(const asset of brainCatalog){
    const key=brainAssetKey(asset);
    for(let i=0;i<14;i++){
      const list=getNodeHistory(key,i,asOf,asset.chain);
      assert(list.length,'missing '+key+' / '+i);
      assert(list.every(r=>r.scopeKeys.includes(key)||(i===8&&r.kind==='network'&&r.scopeKeys.includes('chain/'+asset.chain))));
    }
  }
  const fake='ca:base:unlisted-token';
  assert.deepEqual(getNodeHistory(fake,6,asOf,'base'),[]);
  assert(getNodeHistory(fake,8,asOf,'base').every(r=>r.kind==='network'&&r.scopeKeys.includes('chain/base')));
});
test('observation windows, exchange units and next-day outcomes remain separate at a historical cutoff',()=>{
  for(const [key,asset] of Object.entries(marketHistory.assets))for(const w of asset.windows){
    const closing=Date.parse(w.cutoffAt),review=Date.parse(w.reviewAt);
    assert.equal(w.candles.length,7);
    assert(w.candles.every((bar,i)=>bar.every(Number.isFinite)&&bar[0]*1000+86400000<=closing&&bar[2]>=Math.max(bar[1],bar[4])&&bar[3]<=Math.min(bar[1],bar[4])&&bar[5]>=0&&(!i||bar[0]-w.candles[i-1][0]===86400)));
    assert.equal(w.reviewCandle[0]*1000,closing);assert.equal(review,closing+86400000);
    const record=getNodeHistory(key,2,w.cutoffAt).find(r=>r.id==='bars/'+key+'/'+w.id);
    assert(record);assert.equal(record.sourceUrl,w.snapshotSourceUrl);assert.notEqual(w.snapshotSourceUrl,w.sourceUrl);
    assert.deepEqual(record.closes,w.candles.map(bar=>bar[4]));
    const id='review/'+key+'/'+w.id;
    assert(!getNodeHistory(key,13,w.cutoffAt).some(r=>r.id===id));
    assert(getNodeHistory(key,13,w.reviewAt).some(r=>r.id===id&&r.sourceUrl===w.sourceUrl));
    if((w.priceUnit||asset.priceUnit)==='USDT')assert(!record.nodes.includes(6));
  }
  for(let i=0;i<14;i++){
    const rows=getNodeHistory('eth-merge',i,archive.decisionCutoff);
    assert(rows.every(r=>Date.parse(r.knownAt)<=Date.parse(archive.decisionCutoff)));
  }
  assert(getNodeHistory('eth-merge',13,archive.reviewAsOf).length>0);
});


test('Merge decision sources expose only the cut-off evidence and the review has its own sources',()=>{
  const key='eth-merge';
  for(let i=0;i<14;i++){
    const reviewNode=[4,11,12,13].includes(i);
    const rows=getNodeHistory(key,i,reviewNode?archive.reviewAsOf:archive.decisionCutoff);
    assert(rows.length,'empty replay note '+i);
    for(const row of rows){
      assert(row.archiveNodes.includes(i),row.id);
      assert(allowed.has(row.sourceUrl.slice(1)),row.sourceUrl);
      if(!reviewNode){
        assert.notEqual(row.sourceUrl,'/brain-merge-case.json',row.id);
        const text=readFileSync(new URL('.'+row.sourceUrl,import.meta.url),'utf8');
        assert(!text.includes('1628.61') && !text.includes('COINBASE-ETH-USD-0649'),row.id);
      }
    }
  }
  const strategy=getNodeHistory(key,9,archive.decisionCutoff).find(r=>r.id==='eth-merge-strategy');
  const snapshot=JSON.parse(readFileSync(new URL('.'+strategy.sourceUrl,import.meta.url)));
  assert.equal(snapshot.asOf,archive.decisionCutoff);
  assert.equal(snapshot.excerptSha256,createHash('sha256').update(snapshot.excerpt).digest('hex'));
  assert.equal(snapshot.originalBodySha256,archive.nodes.find(n=>n.ref===snapshot.ref).bodySha256);
  assert.equal(defaultHistoryRecord(getNodeHistory(key,6,archive.decisionCutoff),6).id,'eth-merge-spot');
  assert(getNodeHistory(key,13,archive.decisionCutoff).length===0);
  assert.equal(getNodeHistory(key,13,archive.reviewAsOf)[0].id,'eth-merge-price-path');
});
