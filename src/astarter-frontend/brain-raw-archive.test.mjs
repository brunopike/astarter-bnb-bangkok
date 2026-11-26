import test from 'node:test';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseCatalog,archiveScopeSeries,archiveRecordTarget,pageForBlock,rowsThrough,readDay,parseArchiveSummary,explorerBlockUrl} from './brain-raw-archive.mjs';

const sha256='f'.repeat(64);
const shard=(asset,day,count)=>({file:asset.toLowerCase()+'-'+day+'.json',start:day,end:day,count,sha256});
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

const day='2024-04-20',start=Date.parse(day+'T00:00:00Z')/1000;
const testRows=[[839999,start+123,3],[840000,start+119,0],[840002,start+866,75]];
const compact=[839999,start+123,[0,0,3,1,-4,0,2,747,75]];

function packet(payload,{packed=true,bytes,metadata={}}={}){
  bytes??=packed?gzipSync(JSON.stringify(payload)):Buffer.from(JSON.stringify(payload));
  const part={...shard('btc',day,3),file:'btc-'+day+'.json'+(packed?'.gz':''),
    firstHeight:839999,lastHeight:840002,sha256:createHash('sha256').update(bytes).digest('hex'),...metadata};
  const response=async(url,options)=>{
    assert.equal(url.split('?')[0],'/brain-evidence/archive/'+part.file);
    assert.equal(options.cache,'no-cache');
    return new Response(bytes);
  };
  return {part,response};
}

test('legacy and compressed daily files yield the same records, including nonmonotonic BTC time and a height gap',async()=>{
  for(const fixture of [packet(testRows,{packed:false}),packet(compact)]){
    assert.deepEqual(await readDay(fixture.part,undefined,fixture.response),testRows);
  }
});

test('the checksum authenticates the compressed bytes before JSON parsing or decompression',async()=>{
  const bad=packet(null,{bytes:Buffer.from('unparseable, not gzip'),metadata:{sha256}});
  await assert.rejects(readDay(bad.part,undefined,bad.response),/ARCHIVE_DIGEST/);
  const packed=packet(compact);
  const uncompressedHash=createHash('sha256').update(JSON.stringify(compact)).digest('hex');
  await assert.rejects(readDay({...packed.part,sha256:uncompressedHash},undefined,packed.response),/ARCHIVE_DIGEST/);
});

test('date bounds, count, node heights, delta overflow and unsigned transaction counts survive decompression checks',async()=>{
  const cases=[
    [compact,{count:4},'ARCHIVE_LENGTH'],[compact,{firstHeight:839998},'ARCHIVE_HEIGHT'],
    [[839999,start+123,[1,0,3,1,-4,0,2,747,75]],{},'ARCHIVE_ORIGIN'],
    [[839999,start+123,[0,0,3,0,-4,0,2,747,75]],{},'ARCHIVE_ROW'],
    [[839999,start+123,[0,0,3,1,-124,0,2,747,75]],{},'ARCHIVE_ROW'],
    [[839999,start+123,[0,0,3,1,86300,0,2,747,75]],{},'ARCHIVE_ROW'],
    [[839999,start+123,[0,0,3,1,1,-2,2,747,75]],{},'ARCHIVE_DELTA'],
    [[Number.MAX_SAFE_INTEGER,start+123,compact[2]],{},'ARCHIVE_ROW']
  ];
  for(const [payload,metadata,code] of cases){
    const f=packet(payload,{metadata});await assert.rejects(readDay(f.part,undefined,f.response),new RegExp(code));
  }
});

test('a completed fetch from a superseded day is discarded before decompression',async()=>{
  const previous=packet(compact),controller=new AbortController();
  const late=async(url,options)=>{const response=await previous.response(url,options);controller.abort();return response;};
  await assert.rejects(readDay(previous.part,controller.signal,late),{name:'AbortError'});
});

test('summary totals respect disjoint periods and never expose future blocks in intraday replay',()=>{
  const datasets=sets.map(set=>({asset:set.asset,count:set.count,start:set.start,end:set.end,
    ranges:set.shards.map(p=>({start:p.start,end:p.end,count:p.count}))}));
  const light={schemaVersion:1,count:32,datasets};
  assert.deepEqual(parseArchiveSummary(light),datasets);
  assert.equal(archiveScopeSeries(datasets,'eth-merge','2022-09-15T06:44:00Z')[0].count,null);
  assert.equal(archiveScopeSeries(datasets,'eth-merge','2022-09-16T00:00:00Z')[0].count,22);
  assert.deepEqual(archiveScopeSeries(datasets,'eth-merge','2022-09-12T00:00:00Z'),[]);
  assert.throws(()=>parseArchiveSummary({...light,count:31}));
  assert.throws(()=>parseArchiveSummary({...light,datasets:[{...datasets[0],ranges:[datasets[0].ranges[1],datasets[0].ranges[0]]}]}));
  for(const file of ['btc-2022-09-14.json.gz','eth-2022-02-31.json.gz','../eth-2022-09-14.json.gz']){
    assert.throws(()=>parseCatalog({...catalog,datasets:[{...sets[0],shards:[{...sets[0].shards[0],file},...sets[0].shards.slice(1)]},sets[1]]}));
  }
  const gzipDays=sets.map(s=>({...s,shards:s.shards.map(p=>({...p,file:p.file+'.gz'}))}));
  assert.equal(parseCatalog({...catalog,datasets:gzipDays}),gzipDays);
});

test('the five networks preserve source counts and distinguish Solana slots and HyperCore samples',()=>{
  const bnb={...dataset('BNB',[[day,20]]),coverageMode:'full',heightKind:'height'};
  const sol={...dataset('SOL',[[day,1]]),coverageMode:'sampled',heightKind:'slot'};
  const hype={...dataset('HYPE',[[day,100]]),network:'HyperCore',coverageMode:'sampled'};
  const all={...catalog,count:153,datasets:[...sets,bnb,sol,hype]};
  assert.deepEqual(parseCatalog(all),all.datasets);
  assert.deepEqual(parseCatalog({...all,datasets:[...sets,bnb,{...sol,coverageMode:'daily-sample',
    fields:['slot','timestamp','transactions']},hype]}).map(s=>s.asset),['ETH','BTC','BNB','SOL','HYPE']);
  assert.deepEqual(archiveScopeSeries(all.datasets,'coin:binancecoin'),[bnb]);
  assert.deepEqual(archiveScopeSeries(all.datasets,'coin:solana'),[sol]);
  assert.deepEqual(archiveScopeSeries(all.datasets,'coin:hyperliquid'),[hype]);
  assert.throws(()=>parseCatalog({...all,datasets:[...sets,bnb,sol,{...hype,network:'HyperEVM'}]}));
  assert.throws(()=>parseCatalog({...all,datasets:[...sets,bnb,{...sol,heightKind:'height'},hype]}));
  const reference={eventAt:day+'T12:00:00Z',blockHeight:99,scopeKeys:['coin:solana']};
  assert.equal(archiveRecordTarget(reference),null);
  assert.deepEqual(archiveRecordTarget({...reference,slot:102}),{asset:'SOL',day,height:102});
  assert.equal(archiveRecordTarget({...reference,scopeKeys:['coin:hyperliquid'],network:'HyperEVM'}),null);
  assert.deepEqual(archiveRecordTarget({...reference,scopeKeys:['coin:hyperliquid'],network:'HyperCore'}),
    {asset:'HYPE',day,height:99});
});

test('native explorers accept exact numeric heights and do not mix networks or open invalid links',()=>{
  assert.equal(explorerBlockUrl('SOL','000501'),'https://explorer.solana.com/block/501');
  assert.equal(explorerBlockUrl('BNB',0),'https://bscscan.com/block/0');
  assert.equal(explorerBlockUrl('HYPE','1200000001'),'https://app.hyperliquid.xyz/explorer/block/1200000001');
  for(const bad of ['5e5','1/2','-1','9.1','1 000','',null,'9007199254740992']){
    assert.equal(explorerBlockUrl('ETH',bad),null);
  }
  assert.equal(explorerBlockUrl('Other',1),null);
});
