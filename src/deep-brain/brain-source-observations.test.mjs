import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {collectSourceObservations,readSourceObservation,readSourceObservationArtifact,readSourceObservationEvidence,verifySourceObservation,SOURCE_WINDOW_DAYS}
  from './brain-source-observations.mjs';

const day=86400000,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const archive=JSON.parse(await readFile(new URL('./brain-evidence/daily-markets.json',import.meta.url)));
const now=Date.parse(archive.retrievedAt)+30000,clock=()=>now;
const btc=archive.assets.find(a=>a.key==='coin:bitcoin');
const tether=archive.assets.find(a=>a.key==='coin:tether');
function bytesFor(...assets){return Buffer.from(JSON.stringify({retrievedAt:archive.retrievedAt,assets}));}
function forVenue(asset,edit=()=>{}){
  const rows=asset.bars.slice(-SOURCE_WINDOW_DAYS).map(([at,o,h,l,c,v])=>asset.venue==='Binance Spot'?
    [at*1000,String(o),String(h),String(l),String(c),String(v),at*1000+day-1,'0',0,'0','0','0']:
    [at,l,h,o,c,v]);
  edit(rows);
  return JSON.stringify(asset.venue==='Binance Spot'?rows:rows.reverse());
}
async function directory(t){
  const dir=await mkdtemp(path.join(tmpdir(),'brain-venue-check-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
test('venue-specific UTC requests cover the exact decision window and all frozen artifacts can be reverified offline',async t=>{
  const dir=await directory(t),bytes=bytesFor(btc,tether),date=new Date(now).toISOString().slice(0,10);
  const payloads=new Map([[btc.market,forVenue(btc)],[tether.market,forVenue(tether)]]);
  const fetchImpl=async(url,options)=>{
    assert.equal(options.redirect,'error');
    const route=new URL(url);
    if(route.hostname==='data-api.binance.vision'){
      assert.equal(route.searchParams.get('interval'),'1d');assert.equal(Number(route.searchParams.get('limit')),91);
      assert.equal(Number(route.searchParams.get('endTime'))+1-Number(route.searchParams.get('startTime')),91*day);
      return new Response(payloads.get(route.searchParams.get('symbol')));
    }
    assert.equal(route.hostname,'api.exchange.coinbase.com');assert.equal(route.searchParams.get('granularity'),'86400');
    assert.equal(Date.parse(route.searchParams.get('end'))+1-Date.parse(route.searchParams.get('start')),91*day);
    return new Response(payloads.get(route.pathname.split('/')[2]));
  };
  const {observations,counts}=await collectSourceObservations(bytes,{dir,clock,fetchImpl});
  assert.equal(counts.matched,2);
  for(const o of observations){
    assert.equal(o.matchedBars,91);assert.equal(o.totalBars,91);assert.equal(o.attempts.length,1);
    const scope={id:o.id,date,before:o.observedAt,archiveSha256:o.archiveSha256};
    assert.deepEqual(await readSourceObservation(o.assetKey,{dir,...scope}),o);
    assert.equal(await readSourceObservation(o.assetKey,{dir,date,before:now-1}),null);
    const request={dir,id:o.id};
    const [original,response,source]=await Promise.all(['observation','response','archive'].map(kind=>
      readSourceObservationArtifact(o.assetKey,{...request,kind})));
    assert.equal(sha(original),o.id);assert.equal(sha(response),o.rawSha256);assert.equal(sha(source),o.archiveBytesSha256);
    const download=await readSourceObservationEvidence(o.assetKey,request);
    assert.deepEqual(download.observation,o);assert.equal(sha(download.rawResponse),o.rawSha256);
    assert.equal(sha(download.archiveText),o.archiveBytesSha256);
    assert.deepEqual(verifySourceObservation({id:o.id,...JSON.parse(original)},response,source,{...scope,assetKey:o.assetKey}),o);
    assert.throws(()=>verifySourceObservation(o,Buffer.from('[]'),source),/response mismatch/);
    assert.throws(()=>verifySourceObservation(o,response,source,{assetKey:'coin:other'}),/identity mismatch/);
    assert.throws(()=>verifySourceObservation(o,response,source,{before:now-1}),/window mismatch/);
    const tampered={...JSON.parse(original),matchedBars:3};
    assert.throws(()=>verifySourceObservation({id:sha(JSON.stringify(tampered)),...tampered},response,source),/did not reproduce/);
  }
});
test('sub-float decimal differences are preserved for both JSON-number and JSON-string venue fields',async t=>{
  const dir=await directory(t);
  for(const original of [btc,tether]){
    const asset=structuredClone(original);
    asset.bars.at(-1)[5]=987654.321012;
    const bytes=Buffer.from(bytesFor(asset).toString().replace('987654.321012','987654.321012000000001'));
    const feed=forVenue(asset).replace('987654.321012','987654.321012000000002');
    const {observations:[o]}=await collectSourceObservations(bytes,{dir,clock,fetchImpl:async()=>new Response(feed)});
    assert.equal(o.status,'conflict');assert.equal(o.matchedBars,90);
    assert.deepEqual(o.checks.at(-1).fields,['volume']);
    const raw=await readSourceObservationArtifact(o.assetKey,{dir,id:o.id,kind:'response'});
    assert.equal(raw.toString(),feed);
  }
});
test('stale archives, missing sessions, duplicate days, bad mappings and incomplete close times never verify',async t=>{
  const dir=await directory(t);
  const stale={...btc,bars:btc.bars.slice(0,-1)};
  const invalid={...btc,sourceUrl:'https://example.com/?private=redacted'};
  for(const [asset,feed,expected] of [
    [stale,forVenue(btc),'stale'],
    [btc,forVenue(btc,rows=>rows.splice(5,1)),'unavailable'],
    [btc,forVenue(btc,rows=>rows.push(rows[0])),'unavailable'],
    [btc,forVenue(btc,rows=>{rows[0][6]-=1;}),'unavailable'],
    [btc,'not-json','unavailable'],
    [invalid,null,'unavailable']
  ]){
    let calls=0;
    const {observations:[o]}=await collectSourceObservations(bytesFor(asset),{dir,clock,fetchImpl:async()=>{calls++;return new Response(feed);}});
    assert.equal(o.status,expected);
    assert.equal(calls,feed===null?0:1);if(feed===null)assert.equal(o.sourceUrl,null);
  }
});
test('retries are bounded, records coexist across observations, and a broken raw source fails verification',async t=>{
  const dir=await directory(t),bytes=bytesFor(btc),date=new Date(now).toISOString().slice(0,10);
  let calls=0;
  const base={dir,clock,retryDelayMs:0};
  const good=(await collectSourceObservations(bytes,{...base,fetchImpl:async()=>++calls===1?
    new Response('slow',{status:503}):new Response(forVenue(btc))})).observations[0];
  assert.equal(calls,2);assert.equal(good.status,'matched');assert.equal(good.attempts[0].httpStatus,503);
  const unavailable=(await collectSourceObservations(bytes,{...base,clock:()=>now+10,fetchImpl:async()=>{throw Error('network');}})).observations[0];
  assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.attempts.length,2);
  assert.equal(unavailable.rawSha256,null);assert.equal(unavailable.reason,'venue_connection_error');
  const [old,latest]=await Promise.all([readSourceObservation(btc.key,{dir,date,before:now}),readSourceObservation(btc.key,{dir,date})]);
  assert.equal(old.id,good.id);assert.equal(latest.id,unavailable.id);
  const quota=(await collectSourceObservations(bytes,{...base,fetchImpl:async()=>new Response('slow',{status:429,headers:{'retry-after':'30'}})})).observations[0];
  assert.equal(quota.status,'unavailable');assert.equal(quota.attempts.length,1);
  await writeFile(path.join(dir,'source-observations','responses',good.rawSha256+'.gz'),'damaged');
  await assert.rejects(readSourceObservation(btc.key,{dir,id:good.id}));
  await assert.rejects(collectSourceObservations(bytes,{...base,fetchImpl:async()=>new Response(forVenue(btc))}));
});

test('a timed-out request is bounded and one failed market cannot stall a multi-market check',async t=>{
  const dir=await directory(t),assets=archive.assets.slice(0,5);
  let inflight=0,peak=0,aborted=0;
  const fetchImpl=async(url,{signal})=>{
    const route=new URL(url),symbol=route.searchParams.get('symbol')??route.pathname.split('/')[2];
    const asset=assets.find(a=>a.market===symbol);
    inflight++;peak=Math.max(peak,inflight);
    try{
      if(asset.key===btc.key)await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,500);
        signal.addEventListener('abort',()=>{clearTimeout(timer);aborted++;reject(signal.reason);},{once:true});
      });
      else await new Promise(resolve=>setTimeout(resolve,3));
      return new Response(forVenue(asset));
    }finally{inflight--;}
  };
  const result=await collectSourceObservations(bytesFor(...assets),{dir,clock,fetchImpl,timeoutMs:25,retryDelayMs:0});
  assert.equal(aborted,2);assert.equal(peak,3);assert.equal(result.counts.matched,4);assert.equal(result.counts.unavailable,1);
  assert.equal(result.observations[0].reason,'venue_timeout');
});
