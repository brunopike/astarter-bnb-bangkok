import {observeTestArchive} from './test-brain-observations.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readForwardProof,readForwardRefusal,recordForwardProofs,verifyForwardProof} from './brain-proof-forward.mjs';
import {buildProofCohort} from './brain-proof-cohort.mjs';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};

const DAY=86400000;
const btc=sample.assets.find(a=>a.key==='coin:bitcoin');
const lastBar=btc.bars.at(-1),close=lastBar[0]*1000+DAY;
function input(){
  return {retrievedAt:new Date(close+60000).toISOString(),assets:[{...btc,bars:btc.bars.slice(-190)}]};
}
test('a published future choice survives restarts and retries, and can be independently replayed from a receipt',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brain-proof-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const archive=input(),clock=()=>close+2*3600000;
  await observeTestArchive(archive,{dir,clock});
  const writes=await Promise.all([recordForwardProofs(archive,{dir,clock}),recordForwardProofs(archive,{dir,clock})]);
  assert.equal(writes.reduce((n,x)=>n+x.registered,0),1);
  assert.equal(writes.reduce((n,x)=>n+x.dispatched,0),1);
  const pending=await readForwardProof(btc.key,{dir,includeEvidence:true});
  assert.equal(verifyForwardProof(pending).status,'pending');
  assert.ok(Date.parse(pending.recordedAt)<Date.parse(pending.targetOpenAt));
  const revised=structuredClone(archive); revised.assets[0].bars.at(-1)[5]*=2;
  assert.equal((await recordForwardProofs(revised,{dir,clock})).unchanged,1);
  const target=pending.targetOpenAt.slice(0,10);
  const later=structuredClone(archive);
  // Two synthetic candles exercise settlement timing only.
  for(let i=1;i<=2;i++)later.assets[0].bars.push([lastBar[0]+i*86400,...lastBar.slice(1)]);
  const captured=close+DAY*2+60000;
  later.updatedAt=new Date(captured).toISOString();
  assert.equal((await recordForwardProofs(later,{dir,clock:()=>captured-1})).settled,0);
  const ambiguous=structuredClone(later);
  ambiguous.assets[0].bars.push([...later.assets[0].bars.at(-1)]);
  const denied=await recordForwardProofs(ambiguous,{dir,clock:()=>captured+999});
  assert.equal(denied.failed[0].reason,'INVALID_EVIDENCE');
  assert.equal(denied.settled,0);
  assert.equal((await readForwardProof(btc.key,{dir,date:target})).status,'pending');
  await observeTestArchive(later,{dir,clock:()=>captured+1000});
  const settlement=await recordForwardProofs(later,{dir,clock:()=>captured+1000});
  assert.deepEqual(settlement.failed,[]);
  assert.equal(settlement.settled,1);
  const record=await readForwardProof(btc.key,{dir,date:target,includeEvidence:true});
  assert.equal(record.dispatch.sha256,pending.dispatch.sha256);
  assert.equal(record.settlement.document.dispatchSha256,record.dispatch.sha256);
  assert.equal(record.id,pending.id);assert.equal(verifyForwardProof(record).status,'settled');
  assert.deepEqual(record.receipt.settlementBar,later.assets[0].bars.at(-1));
  const modified=structuredClone(record);modified.commit.document.recordedAt=later.updatedAt;
  assert.throws(()=>verifyForwardProof(modified));
  const changedArchive=structuredClone(record);changedArchive.archive.assets[0].bars[0][5]++;
  assert.throws(()=>verifyForwardProof(changedArchive));
  assert.equal((await recordForwardProofs(later,{dir,clock:()=>captured+2000})).settled,0);
});
test('cohort uses a common calendar, includes no-trade runs, and discloses stale markets',()=>{
  const archive=input(),old=sample.assets.find(a=>a.key==='coin:monero');
  archive.assets.push(old);
  const seen=[]; const report=buildProofCohort(archive,{days:90,onRun:r=>seen.push(r.runId)});
  assert.equal(report.totalAssets,2);assert.equal(report.coveredAssets,1);
  assert.equal(report.positiveAssets+report.flatAssets+report.negativeAssets,1);
  assert.equal(Date.parse(report.endAt)+1-Date.parse(report.startAt),90*DAY);
  assert.equal(report.rows.find(r=>r.assetKey===old.key).reason,'outside_common_window');
  assert.deepEqual(seen,[report.rows[0].runId]);
});

test('execution cannot settle a missing or enlarged handoff, even when target prices are known',async t=>{
  const archive=input();
  const later=structuredClone(archive);
  for(let i=1;i<=2;i++)later.assets[0].bars.push([lastBar[0]+i*86400,...lastBar.slice(1)]);
  const afterClose=close+2*DAY+60000;
  later.updatedAt=new Date(afterClose).toISOString();
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  for(const change of ['missing','enlarged']){
    const dir=await mkdtemp(path.join(tmpdir(),'brain-dispatch-test-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    await observeTestArchive(archive,{dir,clock:()=>close+3600000});
    const first=await recordForwardProofs(archive,{dir,clock:()=>close+3600000});
    assert.equal(first.dispatched,1);
    const frozen=await readForwardProof(btc.key,{dir});
    const date=frozen.targetOpenAt.slice(0,10);
    const file=path.join(dir,'markets',hash(btc.key),date,'dispatch.json');
    if(change==='missing')await unlink(file);
    else{
      const envelope=JSON.parse(await readFile(file,'utf8'));
      envelope.document.maxNotional+=1;
      envelope.sha256=hash(JSON.stringify(envelope.document));
      await writeFile(file,JSON.stringify(envelope));
    }
    await observeTestArchive(later,{dir,clock:()=>afterClose+1000});
    const result=await recordForwardProofs(later,{dir,clock:()=>afterClose+1000});
    assert.equal(result.settled,0);
    if(change==='missing')assert.ok(result.unavailable.some(item=>item.reason==='NO_PREOPEN_HANDOFF'));
    else assert.equal(result.failed.length,1);
    assert.equal((await readForwardProof(btc.key,{dir,date})).receipt,null);
  }
});

test('expired evidence produces a reproducible refusal and fresh evidence can qualify before the same open',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brain-refusal-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const archive=input(),stale=structuredClone(archive);stale.assets[0].bars.pop();
  const clock=()=>close+2*3600000,date=new Date(close+DAY).toISOString().slice(0,10);
  const denied=await recordForwardProofs(stale,{dir,clock});
  assert.equal(denied.dispatched,0);
  const refusal=await readForwardRefusal(btc.key,{dir,date});
  assert.equal(refusal.document.reason,'STALE_EVIDENCE');
  assert.equal(await readForwardProof(btc.key,{dir,date}),null);
  await observeTestArchive(archive,{dir,clock:()=>clock()+60000});
  const recovered=await recordForwardProofs(archive,{dir,clock:()=>clock()+60000});
  assert.equal(recovered.registered,1);
  assert.equal(recovered.dispatched,1);
  assert.equal((await readForwardRefusal(btc.key,{dir,date})).sha256,refusal.sha256);
  assert.ok((await readForwardProof(btc.key,{dir,date})).dispatch.sha256);
});

test('registration requires matched venue observations on disk for the exact archive, market and pre-commit time',async t=>{
  const parent=await mkdtemp(path.join(tmpdir(),'brain-admission-test-'));t.after(()=>rm(parent,{recursive:true,force:true}));
  const archive=input(),clock=()=>close+3600000,target=new Date(close+DAY).toISOString().slice(0,10);
  for(const scenario of ['missing','conflict','other_archive','after_decision']){
    const dir=path.join(parent,scenario);
    if(scenario==='conflict'){
      const remote=structuredClone(archive.assets);remote[0].bars.at(-1)[5]+=1;
      const observed=await observeTestArchive(archive,{dir,clock,venueAssets:remote});
      assert.equal(observed.observations[0].status,'conflict');
    }else if(scenario==='other_archive'){
      const other=structuredClone(archive);other.assets[0].bars.at(-1)[5]+=2;
      const observed=await observeTestArchive(other,{dir,clock});assert.equal(observed.counts.matched,1);
    }else if(scenario==='after_decision'){
      const observed=await observeTestArchive(archive,{dir,clock:()=>clock()+60000});assert.equal(observed.counts.matched,1);
    }
    const denied=await recordForwardProofs(archive,{dir,clock});
    assert.equal(denied.registered,0,scenario);assert.equal(denied.dispatched,0,scenario);
    const expected=scenario==='conflict'?'SOURCE_OBSERVATION_CONFLICT':'SOURCE_OBSERVATION_MISSING';
    assert.ok(denied.unavailable.some(row=>row.asset===btc.key && row.reason===expected),scenario);
    const refusal=await readForwardRefusal(btc.key,{dir,date:target});assert.equal(refusal.document.reason,expected);
    assert.equal(await readForwardProof(btc.key,{dir,date:target,includeEvidence:true}),null,scenario);
    const marketDir=path.join(dir,'markets',createHash('sha256').update(btc.key).digest('hex'),target);
    for(const file of ['commit.json','dispatch.json'])await assert.rejects(readFile(path.join(marketDir,file)),{code:'ENOENT'});
  }
  const dir=path.join(parent,'matched');
  const observed=await observeTestArchive(archive,{dir,clock});
  const result=await recordForwardProofs(archive,{dir,clock});assert.deepEqual(result.failed,[]);
  assert.equal(result.registered,1);assert.equal(result.dispatched,1);
  const proof=await readForwardProof(btc.key,{dir,date:target,includeEvidence:true});
  assert.equal(proof.commit.document.sourceObservationId,observed.observations[0].id);
  assert.equal(proof.dispatch.document.commitId,proof.commit.sha256);
});
