import test from 'node:test';
import assert from 'node:assert/strict';
import {allowed} from './public-assets.mjs';
import {getNodeHistory,dailyMarketRecords} from './brain-history.mjs';
import {traderRecords,gainNode,lossNode} from './brain-trader-history.mjs';
import {graphEvidence,evidenceChildren} from './brain-evidence-nodes.mjs';
import {savedBrainRanking,fetchBrainRanking,brainAssetKey} from './brain-asset-data.mjs';
import ranking from './brain-evidence/market-cap-top20.json' with {type:'json'};
import daily from './brain-evidence/daily-markets.json' with {type:'json'};

const end='9999-01-01T00:00:00Z';
test('each visible evidence point resolves to its own record and exact underlying observation',()=>{
  const points=graphEvidence('all',end,null,false);
  assert.equal(new Set(points.map(p=>p.id)).size,points.length);
  const lists=new Map(Array.from({length:16},(_,n)=>[n,new Map(getNodeHistory('all',n,end).map(r=>[r.id,r]))]));
  for(const p of points){
    const record=lists.get(p.parent).get(p.record);assert(record,p.id);
    if(p.child>=0)assert.equal(p.label,evidenceChildren(record)[p.child].label[0]);
  }
  assert(points.some(p=>p.parent===gainNode)&&points.some(p=>p.parent===lossNode));
});
test('positive and negative cases and exact asset identity respect their publication cutoff',()=>{
  for(const r of traderRecords){
    const t=r.trader,n=t.outcome==='gain'?gainNode:lossNode;
    assert(Date.parse(r.knownAt)>=Date.parse(r.eventAt),r.id);
    assert(!getNodeHistory('all',n,new Date(Date.parse(r.knownAt)-1).toISOString()).includes(r));
    assert(r.sourceUrl.startsWith('https://'));
    for(const part of t.steps)assert(t.sources[part.source] && part.detail.every(Boolean),r.id);
    for(const key of r.scopeKeys)assert(getNodeHistory(key,n,end).includes(r),r.id);
    assert(!getNodeHistory('ca:base:unrelated',n,end,'base').includes(r));
    if(t.batch){
      assert(Math.abs(t.batch.fills.reduce((sum,x)=>sum+Number(x[4]),0))>=10000);
      assert.equal(evidenceChildren(r).length,t.steps.length+t.batch.fills.length);
    }
  }
});
test('case highlights keep pre-fee P&L, proceeds and residual marks distinct',()=>{
  const byId=new Map(traderRecords.map(({trader})=>[trader.id,trader]));
  const cover=byId.get('hl-btc-cover-1000-20261122').outcomeTags;
  assert.deepEqual(cover.size,['1,000 BTC','1,000 BTC']);
  assert.deepEqual(cover.pnl,['费前 −291,642.77 USDC','Pre-fee −291,642.77 USDC']);
  for(const id of ['sol-lebron-trump','bsc-f380-partial','eth-cow-ausdt-aaave-20260312','eth-3crv-exit-20230311']){
    const tags=byId.get(id).outcomeTags;
    assert(tags.proceeds);
    assert.equal(tags.pnl,undefined);
  }
  for(const {trader,collection} of traderRecords){
    if(collection==='prediction')continue;
    const tags=trader.outcomeTags;
    assert(tags.action && (tags.pnl||tags.proceeds),trader.id);
    for(const label of Object.values(tags))assert(label.length===2 && label.every(Boolean),trader.id);
    if(trader.batch)assert(tags.pnl.every((text,i)=>text.includes(trader.amount[i])),trader.id);
  }
});
test('daily observations have valid units, closed candles and matching date-bounded source links',()=>{
  for(const a of daily.assets){
    const list=getNodeHistory(a.key,2,end).filter(r=>r.kind==='bars');
    assert.equal(list.reduce((n,r)=>n+r.candles.length,0),a.bars.length);
    for(const r of list){
      const url=new URL(r.sourceUrl),first=r.candles[0][0],last=r.candles.at(-1)[0];
      const start=url.searchParams.get('start'),endTime=url.searchParams.get('end');
      assert.equal(start?Date.parse(start):Number(url.searchParams.get('startTime')),first*1000);
      assert.equal(endTime?Date.parse(endTime):Number(url.searchParams.get('endTime'))+1,(last+86400)*1000);
      assert(Date.parse(r.knownAt)>=(last+86400)*1000);
      assert.equal(r.priceUnit,a.quote);assert.equal(r.volumeUnit,a.symbol);
      assert(r.candles.every(([,o,h,l,c,v])=>h>=Math.max(o,c)&&l<=Math.min(o,c)&&v>0));
    }
  }
});
test('a later collection in the same month retains the original graph IDs and cutoff',()=>{
  const first=Date.UTC(2026,10,22)/1000, second=first+86400, third=second+86400;
  const seed=daily.assets[0], initial='2026-11-24T10:00:00Z', update='2026-11-25T12:00:00Z';
  const bars=[first,second,third].map(day=>[day,1,2,1,1.5,30]);
  const previous=dailyMarketRecords({...seed,bars:bars.slice(0,2)},initial);
  const revised=dailyMarketRecords({...seed,bars,captures:[{start:third,end:third,retrievedAt:update}]},initial);
  assert.deepEqual(revised.filter(r=>r.knownAt<=initial),previous);
  assert.equal(revised.at(-1).knownAt,update);
  assert.deepEqual(revised.flatMap(r=>r.candles),bars);
  assert.notEqual(revised[0].id,revised[1].id);
  const delayed='2026-11-26T12:00:00Z';
  const backfilled=dailyMarketRecords({...seed,bars,captures:[
    {start:third,end:third,retrievedAt:update},{start:second,end:second,retrievedAt:delayed}
  ]},initial);
  assert.deepEqual(backfilled.filter(r=>r.knownAt<=update).flatMap(r=>r.candles),[bars[0],bars[2]]);
});
test('ranked assets use provider market cap order and incomplete responses cannot displace the cached top twenty',async()=>{
  const make=body=>async()=>({ok:true,json:async()=>({schema:'public-market-relay-v1',resource:'assets',body,receivedAt:ranking.receivedAt})});
  const live=await fetchBrainRanking({fetchImpl:make([...ranking.body].reverse())});
  assert.deepEqual(live.rows.map(brainAssetKey),savedBrainRanking.rows.map(brainAssetKey));
  assert.deepEqual(live.rows.map(i=>i.rank),Array.from({length:20},(_,i)=>i+1));
  await assert.rejects(fetchBrainRanking({fetchImpl:make(ranking.body.slice(1))}),/INCOMPLETE_RANKING/);
  for(const path of ['brain-history-reader.mjs','brain-evidence-nodes.mjs','brain-evidence-stars.mjs','brain-trader-history.mjs','brain-evidence/daily-markets.json','brain-evidence/perp-exits.json','brain-evidence/ranked-price-history.json','brain-evidence/market-cap-top20.json','brain-evidence/trader-gains.json','brain-evidence/trader-losses.json','brain-evidence/trader-positions.json'])assert(allowed.has(path),path);
});
