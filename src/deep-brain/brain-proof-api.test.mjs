import {observeTestArchive} from './test-brain-observations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {createBrainProofHandler} from './api/brain-proof.mjs';
import {createBrainProofService} from './api/brain-proof-service.mjs';
import {recordForwardProofs,readForwardProof,readForwardRefusal} from './brain-proof-forward.mjs';
import {readSourceObservation} from './brain-source-observations.mjs';

const dataset=JSON.parse(await readFile(new URL('./brain-evidence/daily-markets.json',import.meta.url)));
const endpoint='/api/brain/proof';
const sha=body=>createHash('sha256').update(body).digest('hex');
const bitcoin=dataset.assets.find(asset=>asset.key==='coin:bitcoin');

async function fixture(t,assets=[bitcoin]){
  const dir=await mkdtemp(path.join(tmpdir(),'brain-proof-api-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const fixture={retrievedAt:dataset.retrievedAt,assets};
  const file=path.join(dir,'daily.json'),proofDir=path.join(dir,'proofs');
  await writeFile(file,JSON.stringify(fixture));
  const start=async(options={})=>{
    const handle=createBrainProofHandler({archiveFile:file,proofDir,forward:async()=>null,refusal:async()=>null,...options});
    const server=createServer(handle);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base='http://127.0.0.1:'+server.address().port;
    return async (query='',options)=>{
      const response=await fetch(base+(query.startsWith(endpoint)?query:endpoint+query),options);
      const raw=await response.text();
      return {status:response.status,body:raw?JSON.parse(raw):null,raw,headers:response.headers};
    };
  };
  return {dir,file,proofDir,fixture,start};
}

test('a real archived market yields a reproducible report with frozen input windows and retrievable receipts',async t=>{
  const f=await fixture(t),get=await f.start();
  const peer=await f.start();
  const list=await get();
  assert.equal(list.status,200);assert.equal(list.body.assets[0].key,'coin:bitcoin');
  assert.deepEqual(list.body.windows,[30,90,180,365,'all']);
  const [a,b]=await Promise.all([get('?asset=coin:bitcoin'),peer('?days=90&asset=coin:bitcoin')]);
  assert.equal(a.status,200);assert.equal(b.body.runId,a.body.runId);
  assert.equal(a.body.decisions.length,90);assert.equal(a.body.forward,null);
  assert.equal((await readdir(path.join(f.proofDir,'runs'))).length,1);
  assert.equal((await readdir(path.join(f.proofDir,'sources'))).length,1);
  const marketProof=await get(a.body.reportUrl);
  assert.equal(sha(marketProof.raw),a.body.resultSha256);
  const filled=a.body.decisions.find(row=>row.status==='filled');
  const skip=a.body.decisions.find(row=>row.status==='skipped');
  assert.ok(filled && skip);
  const detail=await get('?run='+a.body.runId+'&decision='+filled.id);
  assert.equal(detail.body.decision.execution.status,'filled');
  assert.equal(detail.body.decision.execution.decisionId,filled.id);
  const evidence=await get(detail.body.evidenceUrl);
  assert.equal(evidence.status,200);
  const lastEvidenceOpen=evidence.body.bars.at(-1)[0]*1000;
  assert.ok(lastEvidenceOpen<Date.parse(detail.body.decision.barOpenAt));
  assert.equal(evidence.body.bars.length,detail.body.decision.barCount);
  assert.equal(evidence.body.snapshotId,sha(JSON.stringify([bitcoin.key,bitcoin.market,bitcoin.venue,bitcoin.quote,evidence.body.bars])));
  const raw=await get(a.body.sourceArchive.url);
  assert.equal(sha(raw.raw),a.body.sourceArchive.sha256);
  assert.deepEqual(raw.body,f.fixture);
  const changed={...f.fixture,retrievedAt:new Date(Date.parse(f.fixture.retrievedAt)+3600000).toISOString()};
  await writeFile(f.file+'.new',JSON.stringify(changed));await rename(f.file+'.new',f.file);
  const revised=await get('?asset=coin:bitcoin');
  assert.notEqual(revised.body.runId,a.body.runId);
  await rm(f.file);
  const restarted=await f.start();
  assert.deepEqual((await restarted(detail.body.evidenceUrl)).body,evidence.body);
  assert.equal((await restarted(a.body.reportUrl)).raw,marketProof.raw);
  assert.equal((await restarted(a.body.sourceArchive.url)).raw,raw.raw);
  assert.equal((await restarted('?asset=coin:bitcoin')).status,503);
});

test('common-window results can be opened by run id before any per-market requests',async t=>{
  const f=await fixture(t,[bitcoin,dataset.assets.find(asset=>asset.key==='coin:ethereum')]),get=await f.start();
  const report=await get('?cohort=1&days=30');
  assert.equal(report.status,200);assert.equal(report.body.coveredAssets,2);
  for(const row of report.body.rows){
    const item=await get('?run='+row.runId);
    assert.equal(item.body.asset.key,row.assetKey);
    assert.equal(item.body.summary.startAt,report.body.startAt);
    assert.equal(item.body.summary.endAt,report.body.endAt);
  }
  await rm(f.file);
  const archived=await (await f.start())(report.body.reportUrl);
  assert.equal(archived.body.totalAssets,2);
  assert.equal(sha(archived.raw),report.body.cohortId);
  assert.deepEqual(archived.body.rows,report.body.rows);
});

test('read-only API preserves no-data, method, input and integrity boundaries',async t=>{
  const f=await fixture(t),queries=[];
  const get=await f.start({forward:async(key,options)=>{queries.push({key,options});return null;}});
  for(const invalid of ['?days=30','?run=../../etc/passwd','?asset=coin:bitcoin&days=42','?asset=coin:bitcoin&days=30&days=90',
    '?asset=coin:bitcoin&forward=1&date=2026-02-31','?asset=coin:bitcoin&forward=1&evidence=0','?cohort=1&days=all',
    '?asset=coin:bitcoin&clock=2000-01-01']){
    assert.equal((await get(invalid)).status,400,invalid);
  }
  assert.equal((await get('?asset=coin:unknown')).status,404);
  assert.equal((await get('?run='+'0'.repeat(64))).status,404);
  const write=await get('?asset=coin:bitcoin',{method:'POST'});
  assert.equal(write.status,405);assert.equal(write.headers.get('allow'),'GET, HEAD');
  const dated=await get('?asset=coin:bitcoin&forward=1&date=2026-11-24&evidence=1');
  assert.equal(dated.status,200);assert.deepEqual(queries,[{key:'coin:bitcoin',options:{date:'2026-11-24',includeEvidence:true}}]);
  const head=await get('',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.raw,'');
  const run=(await get('?asset=coin:bitcoin&days=30')).body;
  await writeFile(path.join(f.proofDir,'sources',run.sourceArchive.sha256+'.json.gz'),'{}');
  assert.equal((await get(run.sourceArchive.url)).status,503);
  const rawRun=path.join(f.proofDir,'runs',run.runId+'.json');
  const altered=JSON.parse(gunzipSync(await readFile(rawRun+'.gz')));altered.proof.summary.netPnl=1e6;
  await rm(rawRun+'.gz');
  await writeFile(rawRun,JSON.stringify(altered));
  assert.equal((await (await f.start())(run.reportUrl)).status,503);
});

test('bundled data is used only until a collected archive arrives, and broken collected input is surfaced',async t=>{
  const f=await fixture(t),liveArchive=path.join(f.dir,'live.json');
  const get=await f.start({archiveFile:null,liveArchive,fallbackArchive:f.file});
  assert.equal((await get()).body.assets.length,1);
  const updated={...f.fixture,assets:[bitcoin,dataset.assets[1]],updatedAt:'2026-11-26T07:00:00Z'};
  await writeFile(liveArchive,JSON.stringify(updated));
  const refreshed=await get();
  assert.equal(refreshed.body.assets.length,2);assert.equal(refreshed.body.retrievedAt,updated.updatedAt);
  await writeFile(liveArchive,'{}');assert.equal((await get()).status,422);
  const absent=await f.start({archiveFile:path.join(f.dir,'explicitly-missing'),liveArchive,fallbackArchive:f.file});
  assert.equal((await absent()).status,503);
});

test('a recorded forward decision can outlive its catalog entry; an unavailable forward ledger never invents an outcome',async t=>{
  const f=await fixture(t);
  const unavailable=await f.start({forward:async()=>{throw new Error('unavailable');}});
  const historical=await unavailable('?asset=coin:bitcoin');
  assert.equal(historical.status,200);
  assert.equal(historical.body.forward,null);assert.equal(historical.body.forwardError,'FORWARD_UNAVAILABLE');
  assert.equal((await unavailable('?asset=coin:bitcoin&forward=1')).status,503);
  await rm(f.file);
  const get=await f.start({forward:async()=>({status:'pending',receipt:null})});
  const dated=await get('?asset=coin:bitcoin&forward=1&date=2026-11-27');
  assert.deepEqual(dated.body,{forward:{status:'pending',receipt:null}});
});

test('the proof worker coalesces readers, serves byte-exact compressed archives and recovers after termination',async t=>{
  const f=await fixture(t);
  const service=createBrainProofService({archiveFile:f.file,proofDir:f.proofDir});
  t.after(()=>service.close());
  function request(query){
    return new Promise(resolve=>{
      let status;
      service({method:'GET',url:endpoint+query},{
        writeHead(code){status=code;},
        end(body){resolve({status,body:JSON.parse(Buffer.from(body).toString('utf8'))});}
      });
    });
  }
  const inFlight=request('?cohort=1&days=365');
  await service.close();
  assert.equal((await inFlight).status,503);
  const [first,second]=await Promise.all([request('?cohort=1&days=90'),request('?cohort=1&days=90')]);
  assert.equal(first.status,200);assert.deepEqual(first.body,second.body);
  const run=(await request('?run='+first.body.rows[0].runId)).body;
  assert.deepEqual((await request('?source='+run.sourceArchive.sha256)).body,f.fixture);
  assert.equal((await readdir(path.join(f.proofDir,'runs'))).length,1);
  // A pre-compression release wrote plain JSON. It remains addressable.
  const file=path.join(f.proofDir,'runs',run.runId+'.json');
  await writeFile(file,gunzipSync(await readFile(file+'.gz')));
  await rm(file+'.gz');
  await service.close();
  assert.equal((await request('?run='+run.runId)).body.resultSha256,run.resultSha256);
});

test('current endpoint reads only the next registered UTC session, binds its paper handoff, and keeps dated sources verifiable',async t=>{
  const f=await fixture(t),dir=path.join(f.dir,'forward');
  let now=Date.parse(f.fixture.retrievedAt)+60000;
  const clock=()=>now;
  const get=await f.start({clock,forward:(key,options)=>readForwardProof(key,{...options,dir})});
  const query='?current=1&asset=coin:bitcoin';
  const empty=await get(query);
  assert.equal(empty.status,200);assert.equal(empty.body.decisionProof.reason,'awaiting_registration');
  assert.equal(empty.body.dispatch,null);
  assert.equal((await get(query+'&date=2025-02-29')).status,400);
  assert.equal((await get(query+'&delivery=live')).status,400);
  assert.equal((await get(query+'&checkedAt=2000-01-01')).status,400);
  assert.equal((await get('?current=1&asset=coin:unknown')).status,404);
  const observed=await observeTestArchive(f.fixture,{dir,clock});assert.equal(observed.counts.matched,1);
  const wrote=await recordForwardProofs(f.fixture,{dir,clock});
  assert.deepEqual(wrote.failed,[]);assert.equal(wrote.dispatched,1);
  const active=(await get(query)).body;
  assert.equal(active.mode,'current');assert.equal(active.decisionProof.liveAuthorized,false);
  assert.equal(active.decisionProof.stages.brain,'verified');assert.equal(active.decisionProof.stages.thinking,'verified');
  assert.equal(active.decisionProof.execution.dispatchId,active.dispatch.sha256);
  assert.equal(active.dispatch.document.route,'paper');assert.equal(active.receipt,null);
  const pin=await get(active.recordUrl),series=await get(active.evidenceUrl),handoff=await get(active.handoffUrl);
  assert.equal(pin.body.sourceObservationId,observed.observations[0].id);
  assert.equal(sha(pin.raw),active.commitId);assert.equal(sha(series.raw),pin.body.archiveSha256);
  assert.equal(sha(handoff.raw),active.dispatch.sha256);
  assert.equal((await get(active.recordUrl.replace(active.commitId,'0'.repeat(64)))).status,404);
  now=Date.parse(active.targetDate)+2*3600000;
  const newSession=(await get(query)).body;
  assert.notEqual(newSession.targetDate,active.targetDate);assert.equal(newSession.commitId,null);
  assert.equal(newSession.decisionProof.reason,'awaiting_registration');
  const inSession=(await get(active.reviewUrl)).body;
  assert.equal(inSession.mode,'dated');assert.equal(inSession.commitId,active.commitId);
  assert.equal(inSession.decisionProof.reason,'awaiting_session_close');assert.equal(inSession.receipt,null);
  // Simulate a later collector for this test only. It must settle the original frozen instruction.
  const update=structuredClone(f.fixture);
  const last=update.assets[0].bars.at(-1);
  for(let i=1;i<=2;i++)update.assets[0].bars.push([last[0]+i*86400,...last.slice(1)]);
  now=Date.parse(active.targetDate)+86400000+3600000;
  update.updatedAt=new Date(now-60000).toISOString();
  await observeTestArchive(update,{dir,clock});
  const settled=await recordForwardProofs(update,{dir,clock});assert.equal(settled.settled,1);
  const review=(await get(active.reviewUrl)).body;
  assert.equal(review.decisionProof.status,'verified');
  assert.equal(review.receipt.id,review.decisionProof.execution.receiptId);
  assert.equal((await get(query)).body.receipt,null);
  assert.equal((await get(active.recordUrl)).raw,pin.raw);
  assert.equal((await get(active.handoffUrl)).raw,handoff.raw);
  assert.equal((await get(active.evidenceUrl)).raw,series.raw);
});

test('current lookup blocks stale or corrupted handoffs and never promotes another asset or date',async t=>{
  const f=await fixture(t),dir=path.join(f.dir,'forward');
  const now=Date.parse(f.fixture.retrievedAt)+60000,clock=()=>now;
  await observeTestArchive(f.fixture,{dir,clock});
  assert.equal((await recordForwardProofs(f.fixture,{dir,clock})).dispatched,1);
  const saved=await readForwardProof(bitcoin.key,{dir,includeEvidence:true});
  const get=await f.start({clock,forward:async()=>saved});
  const wrong=await get('?current=1&asset=coin:ethereum');
  assert.equal(wrong.body.decisionProof.status,'blocked');assert.equal(wrong.body.dispatch,null);
  const target=saved.targetOpenAt.slice(0,10);
  const wrongDate=await get('?current=1&asset=coin:bitcoin&date=2000-01-01');
  assert.equal(wrongDate.body.decisionProof.status,'blocked');assert.equal(wrongDate.body.recordUrl,null);
  const broken=structuredClone(saved);broken.dispatch.document.maxNotional+=1;
  const altered=await f.start({clock,forward:async()=>broken});
  const withheld=await altered('?current=1&asset=coin:bitcoin&date='+target);
  assert.equal(withheld.body.decisionProof.status,'blocked');assert.equal(withheld.body.dispatch,null);
  assert.equal(withheld.body.handoffUrl,null);
  const errored=await f.start({clock,forward:async()=>{throw Error('corrupted frozen evidence');}});
  assert.equal((await errored('?current=1&asset=coin:bitcoin')).status,503);
});

test('a collector refusal explains the blocked gate until a later valid registration supersedes it',async t=>{
  const f=await fixture(t),dir=path.join(f.dir,'forward');
  const now=Date.parse(f.fixture.retrievedAt)+86400000+60000,clock=()=>now;
  const get=await f.start({clock,
    forward:(key,options)=>readForwardProof(key,{...options,dir}),
    refusal:(key,options)=>readForwardRefusal(key,{...options,dir})});
  const query='?current=1&asset=coin:bitcoin';
  assert.equal((await get(query)).body.refusal,null);
  await recordForwardProofs(f.fixture,{dir,clock});
  const response=await get(query);
  assert.equal(response.status,200);
  const {decisionProof,refusal,reviewUrl}=response.body;
  assert.equal(decisionProof.status,'blocked');assert.equal(decisionProof.reason,'stale_evidence');
  assert.equal(decisionProof.stages.brain,'blocked');
  assert.equal(decisionProof.checks.find(check=>check.id==='cutoff').reason,'stale_evidence');
  assert.equal(decisionProof.liveAuthorized,false);assert.equal(decisionProof.canIssuePaperHandoff,false);
  assert.equal(response.body.dispatch,null);assert.equal(response.body.commitId,null);assert.equal(response.body.receipt,null);
  assert.equal(refusal.document.reason,'STALE_EVIDENCE');assert.equal(sha(JSON.stringify(refusal.document)),refusal.sha256);
  assert.deepEqual((await get(reviewUrl)).body.refusal,refusal);
  const refreshed=structuredClone(f.fixture);
  const last=refreshed.assets[0].bars.at(-1);
  refreshed.assets[0].bars.push([last[0]+86400,...last.slice(1)]);
  refreshed.updatedAt=new Date(now-60000).toISOString();
  await observeTestArchive(refreshed,{dir,clock});
  assert.equal((await recordForwardProofs(refreshed,{dir,clock})).registered,1);
  const active=(await get(query)).body;
  assert.equal(active.refusal,null);assert.equal(active.decisionProof.stages.brain,'verified');
  assert.ok(active.dispatch);
});

test('invalid refusal identity, times and content cannot explain another asset or session',async t=>{
  const f=await fixture(t),now=Date.parse(f.fixture.retrievedAt),date=new Date(now+86400000).toISOString().slice(0,10);
  const doc={version:'source-refusal-v1',assetKey:bitcoin.key,targetDate:date,observedAt:new Date(now).toISOString(),
    reason:'INVALID_EVIDENCE',asOf:null,archiveSha256:'0'.repeat(64)};
  let refusal;
  const get=await f.start({clock:()=>now,refusal:async()=>refusal});
  for(const update of [{assetKey:'coin:other'},{targetDate:'2000-01-01'},{observedAt:new Date(now+1).toISOString()},
    {reason:'NETWORK_ERROR'},{archiveSha256:null},{version:'other'}]){
    const document={...doc,...update};refusal={document,sha256:sha(JSON.stringify(document))};
    assert.equal((await get('?current=1&asset=coin:bitcoin')).status,503);
  }
  refusal={document:doc,sha256:'0'.repeat(64)};
  assert.equal((await get('?current=1&asset=coin:bitcoin')).status,503);
});

test('old unbound registrations retain their original identity and cannot acquire verified-at-registration status retroactively',async t=>{
  const f=await fixture(t);
  for(const [date,hasLegacySupport] of [['2026-11-27',true],['2026-11-28',false]]){
    const dir=path.join(f.dir,'era-'+date);
    const open=Date.parse(date),today=open-86400000,clock=()=>today+3600000;
    const archive=structuredClone(f.fixture);
    const series=archive.assets[0].bars;
    if((series.at(-1)[0]+86400)*1000<today)series.push([series.at(-1)[0]+86400,...series.at(-1).slice(1)]);
    archive.retrievedAt=new Date(today+60000).toISOString();
    const observation=await observeTestArchive(archive,{dir,clock});assert.equal(observation.counts.matched,1);
    assert.equal((await recordForwardProofs(archive,{dir,clock})).registered,1);
    const saved=await readForwardProof(bitcoin.key,{dir,date,includeEvidence:true});
    assert.equal(saved.commit.document.protocol,'venue-observed-v2');
    assert.equal(saved.commit.document.sourceObservationId,observation.observations[0].id);
    const laterClock=()=>clock()+1000;
    const revision=structuredClone(archive);
    revision.assets[0].bars.at(-1)[5]+=10;
    const newer=await observeTestArchive(revision,{dir,clock:laterClock});
    assert.notEqual(newer.observations[0].archiveSha256,saved.archiveSha256);
    const get=await f.start({clock:laterClock,forward:(key,opts)=>readForwardProof(key,{...opts,dir}),
      observation:(key,opts)=>readSourceObservation(key,{...opts,dir})});
    const query='?current=1&asset=coin:bitcoin&date='+date;
    const bound=await get(query);
    assert.equal(bound.body.decisionProof.assurance.source.status,'verified');
    // Rebuild the exact v1 envelope shape. The available observation remains
    // in the same store, but was never bound to these legacy document bytes.
    const {recordedAt,archiveSha256,intent}=saved.commit.document,document={recordedAt,archiveSha256,intent};
    const old={document,sha256:sha(JSON.stringify(document))};
    const targetDir=path.join(dir,'markets',sha(bitcoin.key),date);
    await writeFile(path.join(targetDir,'commit.json'),JSON.stringify(old));
    saved.dispatch.document.commitId=old.sha256;saved.dispatch.sha256=sha(JSON.stringify(saved.dispatch.document));
    await writeFile(path.join(targetDir,'dispatch.json'),JSON.stringify(saved.dispatch));
    const unbound=await get(query);
    assert.equal(unbound.status,200);
    assert.equal(unbound.body.venueReview.id,observation.observations[0].id);
    assert.equal(unbound.body.venueReview.archiveSha256,saved.archiveSha256);
    if(hasLegacySupport){
      assert.equal(unbound.body.commitId,old.sha256);
      assert.equal(unbound.body.decisionProof.assurance.source.status,'not_recorded_at_registration');
      assert.equal(unbound.body.dispatch.document.commitId,old.sha256);
      assert.equal(sha((await get(unbound.body.recordUrl)).raw),old.sha256);
    }else{
      assert.equal(unbound.body.decisionProof.status,'blocked');
      assert.equal(unbound.body.dispatch,null);
    }
  }
});

test('a legacy refusal cannot pick up another archive’s later venue review on the same day',async t=>{
  const f=await fixture(t), dir=path.join(f.dir,'refusal-observations');
  const now=Date.parse(f.fixture.retrievedAt)+60000,clock=()=>now;
  const date=new Date(now+86400000).toISOString().slice(0,10);
  const changed=structuredClone(f.fixture);
  changed.assets[0].bars.at(-1)[5]++;
  const collected=await observeTestArchive(changed,{dir,clock});
  const document={version:'source-refusal-v1',assetKey:bitcoin.key,targetDate:date,observedAt:new Date(now).toISOString(),
    reason:'INVALID_EVIDENCE',asOf:null,archiveSha256:sha(JSON.stringify(f.fixture))};
  assert.notEqual(document.archiveSha256,collected.observations[0].archiveSha256);
  const refused={document,sha256:sha(JSON.stringify(document))};
  const get=await f.start({clock,refusal:async()=>refused,observation:(key,opts)=>readSourceObservation(key,{...opts,dir})});
  const response=await get('?current=1&asset=coin:bitcoin&date='+date);
  assert.equal(response.status,200);
  assert.equal(response.body.refusal.sha256,refused.sha256);
  assert.equal(response.body.venueReview,null);
});

test('outcome calendars survive delisting, including windows after the last retained registration',async t=>{
  const f=await fixture(t),dir=path.join(f.dir,'forward');
  let now=Date.parse(f.fixture.retrievedAt)+60000;
  const clock=()=>now;
  await observeTestArchive(f.fixture,{dir,clock});
  assert.equal((await recordForwardProofs(f.fixture,{dir,clock})).registered,1);
  const saved=await readForwardProof(bitcoin.key,{dir});
  const other=dataset.assets.find(asset=>asset.key!==bitcoin.key);
  await writeFile(f.file,JSON.stringify({...f.fixture,assets:[other]}));
  const get=await f.start({clock,forward:(key,opts)=>readForwardProof(key,{...opts,dir}),
    refusal:(key,opts)=>readForwardRefusal(key,{...opts,dir})});
  now=Date.parse(saved.targetOpenAt)+86400000+60000;
  const query='?outcomes=1&asset=coin:bitcoin&days=7';
  const visible=await get(query);
  assert.equal(visible.status,200);
  assert.equal(visible.body.rows.find(row=>row.commitId===saved.id).date,saved.targetOpenAt.slice(0,10));
  now+=40*86400000;
  const outside=await get(query);
  assert.equal(outside.status,200);
  assert.equal(outside.body.counts.registered,0);
  assert.equal(outside.body.performance,null);
  const unknown=await get('?outcomes=1&asset=coin:unknown&days=7');
  assert.equal(unknown.status,404);
  assert.equal(unknown.body.error.code,'UNSUPPORTED_ASSET');
});

test('a featured fill on an empty store leads to its frozen signal, position, settlement and following learning receipt',async t=>{
  const f=await fixture(t,[]),get=await f.start();
  const example=await get('?example=btc-pullback');
  assert.equal(example.status,200);
  const {runId,decision:d,attribution:a}=example.body,receipt=d.execution;
  const archived=await get('?run='+runId);
  assert.equal(archived.status,200);
  assert.ok(d.candidates.some(row=>row.id===d.selected && row.eligible && row.signal));
  const evidence=await get('?run='+runId+'&decision='+d.id+'&evidence=1');
  assert.equal(evidence.body.snapshotId,d.snapshotId);
  assert.equal(evidence.body.bars.at(-1)[4],d.features.close);
  assert.equal(receipt.status,'filled');
  assert.equal(receipt.amount,receipt.openRisk.amount);
  assert.ok(receipt.amount<=d.risk.amount);
  assert.ok(Math.abs(a.referenceMove-a.slippage-a.entryFee-a.exitFee-receipt.netPnl)<1e-8);
  const following=archived.body.decisions.find(row=>row.barOpenAt>d.barOpenAt && row.asOf>=receipt.barCloseAt);
  const after=await get('?run='+runId+'&decision='+following.id);
  assert.equal(after.body.decision.previousReceiptId,receipt.id);
  assert.equal(after.body.decision.previousReceiptAt,receipt.barCloseAt);
});
