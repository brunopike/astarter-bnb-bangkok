import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recordForwardProofs,readForwardProof} from './brain-proof-forward.mjs';
import {observeTestArchive} from './test-brain-observations.mjs';
import {inspectExecutionWitness} from './brain-execution-invariants.mjs';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};

const DAY=86400000,btc=sample.assets.find(row=>row.key==='coin:bitcoin');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let dir;
const examples=new Map();
// These dates cover four distinct executions on venue OHLCV, with a test clock
// for when the collector sees the bars. They are not historical live trades.
before(async()=>{
  dir=await mkdtemp(path.join(tmpdir(),'paper-execution-witness-'));
  for(const [day,outcome] of [['2024-06-01','cash_selected'],['2024-06-06','session_close'],['2024-12-04','stop_loss'],['2025-05-08','opening_gap']]){
    const first=Date.parse(day),target=new Date(first+DAY).toISOString().slice(0,10);
    for(const cutoff of [first,first+2*DAY]){
      const clock=()=>cutoff+3600000;
      const asset={...btc,bars:btc.bars.filter(bar=>bar[0]*1000<cutoff).slice(-95)};
      const archive={retrievedAt:new Date(clock()).toISOString(),assets:[asset]};
      const observed=await observeTestArchive(archive,{dir,clock});assert.equal(observed.counts.matched,1);
      const summary=await recordForwardProofs(archive,{dir,clock});
      assert.deepEqual(summary.failed,[]);
      const proof=await readForwardProof(btc.key,{dir,date:target,includeEvidence:true});
      assert.ok(proof);examples.set(outcome+(cutoff===first?':pending':''),proof);
    }
    assert.equal(examples.get(outcome).receipt.reason,outcome);
  }
});
after(()=>rm(dir,{recursive:true,force:true}));

function expectBlocked(proof,reason){
  const result=inspectExecutionWitness(proof);
  assert.equal(result.status,'blocked');
  assert.equal(result.reason,reason);
  assert.equal(result.authority,null);
  assert.equal(result.reconciliation,null);
  assert.equal(result.liveAuthorized,false);
}
function alterReceipt(kind,change){
  const r=structuredClone(examples.get(kind)),x=r.settlement.document.execution;
  change(x);
  const {id,...terms}=x;
  x.id=hash(terms);r.receipt=structuredClone(x);
  r.receiptHash=r.settlement.sha256=hash(r.settlement.document);
  return r;
}
function alterDispatch(kind,change){
  const r=structuredClone(examples.get(kind));
  change(r.dispatch.document);
  r.dispatch.sha256=hash(r.dispatch.document);
  if(r.settlement){
    r.settlement.document.dispatchSha256=r.dispatch.sha256;
    r.receiptHash=r.settlement.sha256=hash(r.settlement.document);
  }
  return r;
}
test('pending output proves only completed stages, including independently bounded cash and paper dispatches',()=>{
  const absent=inspectExecutionWitness(null);
  assert.equal(absent.reason,'awaiting_registration');assert.equal(absent.checks.every(c=>c.status==='waiting'),true);
  const proof=examples.get('session_close:pending');
  const pre=inspectExecutionWitness({...proof,dispatch:null},{checkedAt:proof.recordedAt});
  assert.equal(pre.status,'waiting');assert.equal(pre.checks[0].status,'verified');assert.equal(pre.reason,'awaiting_dispatch');
  assert.equal(inspectExecutionWitness({...proof,dispatch:null},{checkedAt:proof.targetOpenAt}).status,'blocked');
  for(const kind of ['cash_selected','session_close']){
    const p=examples.get(kind+':pending'),r=inspectExecutionWitness(p,{checkedAt:p.dispatch.document.issuedAt});
    assert.equal(r.reason,'awaiting_receipt');assert.equal(r.reconciliation,null);
    assert.deepEqual(r.checks.filter(c=>c.status==='verified').map(c=>c.id),['registration','dispatch']);
    assert.equal(r.authority.maxNotional,p.intent.risk.amount);assert.equal(r.liveAuthorized,false);
  }
});
test('venue data independently reconstructs no-trade, opening-gap, stop and session-close outcomes',()=>{
  for(const kind of ['cash_selected','session_close','stop_loss','opening_gap']){
    const p=examples.get(kind),r=inspectExecutionWitness(p);
    assert.equal(r.status,'verified',kind+' '+r.reason);assert.ok(r.checks.every(c=>c.status==='verified'));
    const ledger=r.reconciliation;
    assert.equal(ledger.reason,kind);assert.equal(ledger.netPnl===0,p.receipt.netPnl===0);
    if(p.receipt.status==='filled'){
      assert.ok(ledger.amount>0 && ledger.quantity>0 && ledger.entryFee>0 && ledger.exitFee>0);
      assert.ok(Math.abs(ledger.equityAfter-p.receipt.equityAfter)<1e-9);
    }else{
      assert.equal(ledger.amount,0);assert.equal(ledger.fees+ledger.slippage,0);
    }
  }
});
test('rejects over-allocation, wrong asset, short-side overlays, live routing and a cash-to-buy dispatch even with recomputed hashes',()=>{
  for(const [edit,reason] of [
    [d=>d.maxNotional+=1,'dispatch_exceeds_plan'],[d=>d.assetKey='coin:ethereum','dispatch_scope_mismatch'],
    [d=>d.side='sell_short','unauthorized_dispatch'],[d=>d.route='live','unauthorized_dispatch']
  ])expectBlocked(alterDispatch('session_close',edit),reason);
  expectBlocked(alterDispatch('cash_selected',d=>{d.disposition='admit_paper';d.maxNotional=5;}),'dispatch_exceeds_plan');
  expectBlocked(alterReceipt('session_close',x=>x.side='short'),'unbound_execution');
  expectBlocked(alterReceipt('session_close',x=>x.quantity*=-1),'invalid_long_fill');
  expectBlocked(alterReceipt('session_close',x=>x.amount+=1),'invalid_long_fill');
});
test('a self-consistent rehash cannot change skip priority, stop priority, prices, quantities or costs',()=>{
  expectBlocked(alterReceipt('cash_selected',x=>x.quantity=1),'invalid_skipped_fill');
  expectBlocked(alterReceipt('cash_selected',x=>x.slippage=.01),'nonzero_abstention_costs');
  expectBlocked(alterReceipt('cash_selected',x=>x.netPnl=.01),'cash_equity_mismatch');
  expectBlocked(alterReceipt('opening_gap',x=>{x.status='filled';x.amount=1;}),'invalid_skipped_fill');
  expectBlocked(alterReceipt('stop_loss',x=>x.reason='session_close'),'invalid_long_fill');
  for(const field of ['entryPrice','stopPrice','exitPrice','quantity'])
    expectBlocked(alterReceipt('session_close',x=>x[field]*=1.01),'invalid_long_fill');
  for(const field of ['fees','slippage'])
    expectBlocked(alterReceipt('stop_loss',x=>x[field]*=1.1),'costs_mismatch');
  expectBlocked(alterReceipt('session_close',x=>x.openRisk.amount+=1),'opening_risk_mismatch');
});
test('rejects balanced but fictitious gain, double-counted slippage and an overnight capital injection',()=>{
  expectBlocked(alterReceipt('session_close',x=>{x.netPnl+=1;x.equityAfter+=1;}),'cash_equity_mismatch');
  expectBlocked(alterReceipt('stop_loss',x=>{x.netPnl-=x.slippage;x.equityAfter-=x.slippage;}),'cash_equity_mismatch');
  expectBlocked(alterReceipt('session_close',x=>{x.equityBefore+=5;x.equityAfter+=5;}),'cash_equity_mismatch');
});
test('source linkage, session time, and settlement aliases are mandatory independently of the numeric result',()=>{
  const proof=structuredClone(examples.get('stop_loss'));
  const ahead=inspectExecutionWitness(proof,{checkedAt:proof.targetOpenAt});
  assert.equal(ahead.reason,'invalid_settlement_clock');
  const hidden=structuredClone(proof);hidden.status='pending';hidden.settlement=null;
  expectBlocked(hidden,'unbound_receipt');
  const missing=structuredClone(proof);missing.dispatch=null;expectBlocked(missing,'receipt_without_dispatch');
  const late=alterDispatch('session_close',d=>d.issuedAt=d.targetOpenAt);expectBlocked(late,'invalid_dispatch_clock');
  const changed=structuredClone(proof);
  changed.settlement.document.bar[4]*=.999;changed.executionBar=structuredClone(changed.settlement.document.bar);
  changed.receiptHash=changed.settlement.sha256=hash(changed.settlement.document);expectBlocked(changed,'wrong_settlement_candle');
  const original=JSON.stringify(proof);inspectExecutionWitness(proof);assert.equal(JSON.stringify(proof),original);
});

test('protective stop and gap limits can be challenged from the underlying 14 true ranges',()=>{
  const p=structuredClone(examples.get('session_close:pending'));
  const intent=p.commit.document.intent;
  intent.features.atrPct*=.8;
  intent.risk.stopFraction=Math.min(.10,Math.max(.01,1.5*intent.features.atrPct));
  intent.risk.openGapLimit=Math.min(.08,Math.max(.02,2*intent.features.atrPct));
  const {id,...terms}=intent;intent.id=hash(terms);
  p.intent=structuredClone(intent);p.id=p.commit.sha256=hash(p.commit.document);
  p.dispatch.document.commitId=p.id;p.dispatch.document.decisionId=intent.id;p.dispatch.sha256=hash(p.dispatch.document);
  expectBlocked(p,'invalid_protective_limits');
});

test('optional comparison-plan linkage preserves older receipts and rejects a mismatched named plan',()=>{
  const base=examples.get('session_close');
  for(const mode of ['legacy','null','bound','conflict']){
    const p=structuredClone(base),row=p.settlement.document;
    if(mode==='legacy')delete row.comparisonPlanSha256;
    else if(mode==='null')row.comparisonPlanSha256=null;
    else{
      const document={comparison:'test-only'};p.comparisonPlan={sha256:hash(document),document};
      row.comparisonPlanSha256=mode==='bound'?p.comparisonPlan.sha256:'0'.repeat(64);
    }
    p.receiptHash=p.settlement.sha256=hash(row);
    if(mode==='conflict')expectBlocked(p,'comparison_plan_mismatch');
    else assert.equal(inspectExecutionWitness(p).status,'verified',mode);
  }
});

test('settlement observation protocol accepts complete v2 and historical rows and fails closed on partial or malformed links',()=>{
  for(const [fields,valid] of [[{},true],[{protocol:'venue-settlement-v2',settlementObservationId:'b'.repeat(64)},true],
    [{protocol:'venue-settlement-v2'},false],[{settlementObservationId:'b'.repeat(64)},false],
    [{protocol:'venue-settlement-v2',settlementObservationId:null},false],[{protocol:'unversioned',settlementObservationId:'b'.repeat(64)},false]]){
    const p=structuredClone(examples.get('stop_loss')),row=p.settlement.document;
    delete row.protocol;delete row.settlementObservationId;Object.assign(row,fields);
    p.receiptHash=p.settlement.sha256=hash(row);
    if(valid)assert.equal(inspectExecutionWitness(p).status,'verified');
    else expectBlocked(p,'invalid_settlement_observation');
  }
});
