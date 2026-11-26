import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};
import {buildForwardIntent,settleForwardIntent} from './brain-proof-engine.mjs';
import {evaluateDecisionProof} from './brain-decision-proof.mjs';

const DAY=86400000;
const key='coin:bitcoin';
const iso=ms=>new Date(ms).toISOString();
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wrap=document=>({sha256:sha(document),document});
const gate=(p,k)=>p.checks.find(row=>row.id===k);
function pending(movement=1){
  const asset=structuredClone(sample.assets[0]),first=Date.parse('2025-01-01T00:00Z');
  let open=100;
  asset.bars=Array.from({length:120},(_,i)=>{
    const close=open*movement,bar=[(first+i*DAY)/1000,open,Math.max(open,close)*1.002,Math.min(open,close)*.999,close,10000];
    open=close;return bar;
  });
  const day=first+asset.bars.length*DAY,observedAt=iso(day+3600000),recordedAt=iso(day+3600100);
  const archive={retrievedAt:iso(day+60000),assets:[asset]},archiveSha256=sha(archive);
  const intent=buildForwardIntent(archive,{assetKey:key,observedAt});
  const commit=wrap({recordedAt,archiveSha256,intent});
  return {id:commit.sha256,status:'pending',recordedAt,targetOpenAt:intent.scheduledOpenAt,selected:intent.selected,riskMode:intent.risk.mode,
    quote:intent.quote,archiveSha256,intent,receipt:null,receiptHash:null,executionBar:null,reconciledAt:null,archive,commit,settlement:null};
}
function rehashIntent(p){
  const {id,...body}=p.intent;
  p.intent.id=sha(body);
  p.commit=wrap({...p.commit.document,intent:p.intent});
  p.id=p.commit.sha256;
}
function issue(p){
  const i=p.intent;
  p.dispatch=wrap({version:'paper-dispatch-v1',route:'paper',commitId:p.id,decisionId:i.id,snapshotId:i.snapshotId,assetKey:key,
    targetOpenAt:p.targetOpenAt,issuedAt:iso(Date.parse(p.recordedAt)+100),disposition:i.risk.amount?'admit_paper':'hold_cash',
    maxNotional:i.risk.amount,quote:i.quote});
  return p;
}
function settle(p){
  const archive=structuredClone(p.archive),bars=archive.assets[0].bars;
  const t=Date.parse(p.targetOpenAt),close=bars.at(-1)[4],observedAt=iso(t+DAY+60000);
  const bar=[t/1000,close,close*1.05,close*.999,close*1.03,10000];
  bars.push([(t-DAY)/1000,close,close,close,close,10000],bar);
  archive.updatedAt=observedAt;
  const execution=settleForwardIntent(p.intent,bar,{observedAt});
  const row=wrap({commitSha256:p.id,dispatchSha256:p.dispatch.sha256,archiveSha256:sha(archive),capturedAt:observedAt,
    venue:p.intent.asset.venue,market:p.intent.market,bar,observedAt,execution});
  return Object.assign(p,{settlementArchive:archive,receipt:execution,receiptHash:row.sha256,settlement:row,executionBar:bar,
    reconciledAt:observedAt,status:'settled'});
}
function check(p,checkedAt=p.recordedAt,extra={}){
  return evaluateDecisionProof(p,{assetKey:key,checkedAt,...extra});
}

test('a real immutable registration establishes source, ranking and binding abstention without any outcome',()=>{
  // Actual archived venue records exercise the same source and intent path as the worker.
  const archive={...sample,assets:[sample.assets[0]]},observedAt=iso(Date.parse(sample.retrievedAt)+60000);
  const intent=buildForwardIntent(archive,{assetKey:key,observedAt}),archiveSha256=sha(archive);
  const commit=wrap({intent,recordedAt:observedAt,archiveSha256});
  const p={id:commit.sha256,commit,archive,intent,archiveSha256,recordedAt:observedAt,targetOpenAt:intent.scheduledOpenAt,
    quote:intent.quote,selected:intent.selected,riskMode:intent.risk.mode,status:'pending',
    settlement:null,receipt:null,receiptHash:null,reconciledAt:null,executionBar:null};
  const result=check(p);
  assert.deepEqual(result.stages,{brain:'verified',thinking:'verified',execution:'waiting'});
  assert.equal(result.canIssuePaperHandoff,true);
  assert.equal(result.liveAuthorized,false);
  assert.equal(result.action,intent.risk.amount>0?'paper_only':'abstain');
  assert.equal(result.evidence.barCount,intent.barCount);
  assert.equal(result.decision.previousClose,archive.assets[0].bars.at(-2)[4]);
  assert.equal(result.reason,'awaiting_handoff');
});

test('absent records, a mismatched clock, unknown delivery and wrong commitment identity fail closed',()=>{
  assert.equal(evaluateDecisionProof(null,{assetKey:key,checkedAt:1735732800000}).status,'waiting');
  const p=pending();
  for(const override of [{assetKey:'coin:other'},{date:'2020-01-01'},{checkedAt:'invalid'},{delivery:'live'},{expectedCommitId:'a'.repeat(64)}]){
    const r=check(p,p.recordedAt,override);
    assert.equal(r.action,'blocked');
    assert.equal(r.canIssuePaperHandoff,false);
    assert.equal(r.liveAuthorized,false);
  }
  assert.equal(check(p,Date.parse(p.targetOpenAt)).reason,'missing_preopen_handoff');
});

test('source, freshness, decision ranking and risk checks distinguish tampering even after hashes are rebuilt',()=>{
  const p=pending(1.009);
  const r=check(p);
  assert.ok(r.decision.risk.amount>0);
  const raw=structuredClone(p);raw.archive.assets[0].bars.at(-1)[5]++;
  assert.equal(check(raw).reason,'source_digest_mismatch');
  const cutoff=structuredClone(p);cutoff.intent.asOf=cutoff.targetOpenAt;rehashIntent(cutoff);
  assert.equal(check(cutoff).reason,'stale_or_future_evidence');
  const candidate=structuredClone(p);candidate.intent.candidates[0].score=100;rehashIntent(candidate);
  assert.equal(check(candidate).reason,'candidate_replay_mismatch');
  const risk=structuredClone(p);risk.intent.risk.amount++;rehashIntent(risk);
  assert.equal(check(risk).reason,'risk_replay_mismatch');
  assert.equal(gate(check(risk),'authority').status,'waiting');
});

test('paper handoff binds the exact frozen disposition, quote, time, amount, intent and route',()=>{
  const p=issue(pending()),time=Date.parse(p.targetOpenAt);
  assert.equal(check(p,p.dispatch.document.issuedAt).reason,'awaiting_session_open');
  assert.equal(check(p,time+1).reason,'awaiting_session_close');
  assert.equal(check(p,time+DAY).reason,'awaiting_receipt');
  for(const change of [{route:'live'},{maxNotional:10},{disposition:'admit_paper'},{assetKey:'coin:other'},{decisionId:'f'.repeat(64)},
    {issuedAt:p.targetOpenAt},{quote:'EUR'},{execute:true}]){
    const bad=structuredClone(p);
    bad.dispatch=wrap({...bad.dispatch.document,...change});
    const r=check(bad,time+DAY);
    assert.equal(r.action,'blocked');
    assert.equal(gate(r,'authority').status,'blocked');
    assert.equal(r.execution.dispatchId,null);
  }
});

test('a settled receipt binds the frozen handoff, verified archived candle, opening recheck and actual costs',()=>{
  const p=settle(issue(pending(1.009))),ok=check(p,p.reconciledAt);
  assert.equal(ok.status,'verified');
  assert.equal(ok.action,'paper_only');
  assert.equal(ok.execution.receiptId,p.receipt.id);
  assert.deepEqual(ok.stages,{brain:'verified',thinking:'verified',execution:'verified'});
  const badDispatch=structuredClone(p);
  badDispatch.settlement=wrap({...badDispatch.settlement.document,dispatchSha256:'0'.repeat(64)});
  badDispatch.receiptHash=badDispatch.settlement.sha256;
  assert.equal(check(badDispatch,p.reconciledAt).reason,'receipt_lineage_mismatch');
  // Envelopes are parsed from separate files. Mutate only the independently stored settlement archive.
  const wrongCandle={...p,settlementArchive:structuredClone(p.settlementArchive)};
  wrongCandle.settlementArchive.assets[0].bars.at(-1)[5]++;
  assert.equal(check(wrongCandle,p.reconciledAt).reason,'receipt_replay_mismatch');
  assert.equal(check(p,new Date(Date.parse(p.reconciledAt)-1).toISOString()).reason,'invalid_receipt_clock');
});

test('a settled no-trade cannot be changed into an order by editing the settlement or its displayed projection',()=>{
  const p=settle(issue(pending()));
  assert.equal(check(p,p.reconciledAt).action,'abstain');
  assert.equal(p.receipt.amount,0);
  const forged={...p.receipt,status:'filled',amount:100,quantity:1,netPnl:12};
  p.settlement=wrap({...p.settlement.document,execution:forged});p.receiptHash=p.settlement.sha256;
  p.receipt=forged;
  assert.equal(check(p,p.reconciledAt).status,'blocked');
  const pendingProof=issue(pending());
  pendingProof.receipt=forged;
  assert.equal(check(pendingProof,pendingProof.dispatch.document.issuedAt).reason,'unbound_receipt');
});
