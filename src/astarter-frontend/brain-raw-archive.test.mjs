import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCatalog,archiveScopeSeries,archiveRecordTarget,pageForBlock,rowsThrough} from './brain-raw-archive.mjs';

const sha256='f'.repeat(64);
const shard=(asset,day,count)=>({file:asset+'-'+day+'.json',start:day,end:day,count,sha256});
const dataset=(asset,days)=>({asset,source:'Test source',sourceUrl:'https://example.org/',
  fields:['height','timestamp','transactions'],start:days[0][0],end:days.at(-1)[0],
  count:days.reduce((n,[,count])=>n+count,0),shards:days.map(([day,count])=>shard(asset,day,count))});
const sets=[dataset('ETH',[['2022-09-14',10],['2022-09-15',12],['2026-11-24',7]]),dataset('BTC',[['2024-04-20',3]])];
const catalog={schemaVersion:1,count:32,datasets:sets};

test('an index counts blocks once per chain and day',()=>{
  assert.equal(parseCatalog(catalog),sets);
  assert.throws(()=>parseCatalog({...catalog,count:33}));
  assert.throws(()=>parseCatalog({...catalog,datasets:[{...sets[0],count:30},sets[1]]}));
  assert.throws(()=>parseCatalog({...catalog,datasets:[sets[0],sets[0]]}));
  assert.throws(()=>parseCatalog({...catalog,datasets:[{...sets[0],shards:[sets[0].shards[0],sets[0].shards[0]]}]}));
  assert.equal(archiveScopeSeries(sets,'all').length,2);
  assert.deepEqual(archiveScopeSeries(sets,'coin:bitcoin'),[sets[1]]);
  assert.deepEqual(archiveScopeSeries(sets,'ca:ethereum:0x1'),[]);
});

test('a historical replay excludes later dates and does not count a partial day as complete',()=>{
  const cutoff='2022-09-15T06:44:00Z',at=Date.parse(cutoff)/1000;
  const [eth]=archiveScopeSeries(sets,'eth-merge',cutoff);
  assert.equal(eth.count,null);assert.equal(eth.shards.length,2);
  assert.equal(eth.end,'2022-09-15');
  assert.deepEqual(archiveScopeSeries(sets,'eth-merge',null),[]);
  assert.equal(archiveScopeSeries(sets,'eth-merge','2022-09-16T00:00:00Z')[0].count,22);
  assert.deepEqual(rowsThrough([[1,at-1,2],[2,at+3,2],[3,at,2]],cutoff),[[1,at-1,2],[3,at,2]]);
});

test('an evidence link resolves the exact native-chain block, UTC day and descending page',()=>{
  const record={scopeKeys:['coin:bitcoin'],eventAt:'2024-04-20T00:09:27Z',blockHeight:840000};
  assert.deepEqual(archiveRecordTarget(record),{asset:'BTC',day:'2024-04-20',height:840000});
  assert.equal(archiveRecordTarget({...record,blockHeight:undefined}),null);
  assert.equal(archiveRecordTarget({...record,scopeKeys:['ca:base:0x1']}),null);
  const rows=Array.from({length:26},(_,i)=>[839999+i,0,0]);
  assert.equal(pageForBlock(rows,840000),3);assert.equal(pageForBlock(rows,840024),1);
  assert.equal(pageForBlock(rows,839998),null);
});
