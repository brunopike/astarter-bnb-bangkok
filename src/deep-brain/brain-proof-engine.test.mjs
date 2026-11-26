import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBrainProof,buildLearningRecord,buildForwardIntent,settleForwardIntent} from './brain-proof-engine.mjs';
import archive from './brain-evidence/daily-markets.json' with {type:'json'};

const DAY=86400;
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=t=>new Date(t*1000).toISOString();
// Smooth synthetic uptrend used only to exercise accounting and veto paths.
function fixture(length=150,{growth=.009,upperWick=.002}={}){
  let price=100;
  const start=Date.parse('2023-01-01T00:00:00Z')/1000;
  const bars=Array.from({length},(_,i)=>{
    const open=price,close=price=open*(1+growth);
    return [start+i*DAY,open,Math.max(open,close)*(1+upperWick),Math.min(open,close)*.999,close,10000];
  });
  return {retrievedAt:iso(start+length*DAY+60),assets:[{...archive.assets[0],bars}]};
}
const full=a=>buildBrainProof(a,{days:'all'});
function closeTo(a,b,epsilon=1e-8){assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`);}

test('each historical choice uses only the closed prefix, while the subsequent receipt sees the new bar',()=>{
  const input=fixture();
  const original=full(input);
  const next=structuredClone(input),i=100;
  next.assets[0].bars[i][3]*=.80;
  const changed=full(next);
  const index=i-92;
  assert.deepEqual(original.decisions.slice(0,index),changed.decisions.slice(0,index));
  const before=original.decisions[index],after=changed.decisions[index];
  assert.equal(after.id,before.id);
  assert.equal(after.snapshotId,before.snapshotId);
  assert.equal(before.execution.status,'filled');
  assert.equal(after.execution.reason,'stop_loss');
  assert.notEqual(after.execution.id,before.execution.id);
  assert.equal(after.previousReceiptId,original.decisions[index-2].execution.id);
  assert.equal(after.execution.openRisk.previousReceiptId,original.decisions[index-1].execution.id);
  assert.ok(Date.parse(after.asOf)<Date.parse(after.barOpenAt));
  assert.equal(Number(new URL(after.sourceUrl).searchParams.get('endTime')), Date.parse(after.asOf));
  // Adding observations later must not change earlier decisions or settlement.
  assert.deepEqual(full(fixture(130)).decisions,original.decisions.slice(0,38));
});

test('fees, adverse fills and protective stop model reconcile exactly to net equity and budget',()=>{
  const data=fixture();
  data.assets[0].bars[95][3]*=.60;
  const report=full(data);
  const closed=report.decisions.filter(row=>row.execution.status==='filled');
  assert.ok(report.summary.wins>0 && report.summary.losses>0);
  let capital=report.assumptions.initialCapital;
  for(const {risk,execution,selected,candidates} of closed){
    assert.ok(candidates.find(c=>c.id===selected).eligible);
    assert.ok(execution.amount<=capital*.1+1e-8);
    assert.ok(execution.amount<=risk.amount);
    const {quantity,entryPrice,exitPrice,fees,netPnl,slippage,settlementBar}=execution;
    closeTo(fees,quantity*(entryPrice+exitPrice)*.001);
    closeTo(netPnl,(exitPrice-entryPrice)*quantity-fees);
    const referenceExit=execution.reason==='stop_loss'?execution.stopPrice:settlementBar[4];
    closeTo(netPnl,quantity*(referenceExit-settlementBar[1])-fees-slippage);
    assert.ok(-netPnl<=risk.riskBudget+1e-8);
    capital+=netPnl;
    closeTo(execution.equityAfter,capital);
  }
  closeTo(report.summary.netPnl,capital-report.assumptions.initialCapital);
  const firstOpen=data.assets[0].bars[92][1],lastClose=data.assets[0].bars.at(-1)[4];
  const baseline=lastClose*(1-.0005)*(1-.001)/(firstOpen*(1+.0005)*(1+.001));
  closeTo((baseline-1)*100,report.summary.buyHoldReturnPct);
  assert.equal(report.summary.cashReturnPct,0);
  closeTo((baseline-1)*report.assumptions.cappedHoldAllocationPct,report.summary.cappedHoldReturnPct);
  closeTo(closed.reduce((s,r)=>s+r.execution.amount/r.execution.equityBefore,0)/report.summary.observations*100,report.summary.meanExposurePct);
});

test('opening gap veto uses only the opening price and produces no fabricated order or fees',()=>{
  const source=fixture();
  const data=structuredClone(source),bar=data.assets[0].bars[100];
  for(let i=1;i<=4;i++)bar[i]*=1.2;
  const approved=full(source).decisions[8],vetoed=full(data).decisions[8];
  assert.equal(approved.id,vetoed.id);
  assert.equal(vetoed.execution.reason,'opening_gap');
  assert.equal(vetoed.execution.status,'skipped');
  assert.equal(vetoed.execution.fees,0);
  assert.equal(vetoed.execution.entryPrice,null);
  assert.equal(vetoed.execution.equityAfter,vetoed.execution.equityBefore);
});

test('cash competes with all strategies and the volatility gate can veto an otherwise eligible entry',()=>{
  const flat=full(fixture(150,{growth:0}));
  assert.equal(flat.summary.trades,0);
  assert.equal(flat.summary.skips,flat.summary.observations);
  assert.equal(flat.summary.netReturnPct,0);
  assert.ok(flat.decisions.every(row=>row.selected==='cash' && row.execution.reason==='cash_selected'));
  const stress=full(fixture(150,{upperWick:.15}));
  assert.ok(stress.decisions.every(row=>row.selected==='trend' && row.risk.mode==='conservative' &&
    row.risk.reason==='volatility_limit' && row.execution.status==='skipped'));
});

test('wrong market identity, missing dates, unclosed bars, short windows and unsupported assets fail explicitly',()=>{
  const cases=[
    a=>{a.assets[0].market='UNKNOWN';},
    a=>{a.assets[0].bars.splice(100,1);},
    a=>{a.assets[0].bars[22][4]=NaN;},
    a=>{a.retrievedAt=iso(a.assets[0].bars.at(-1)[0]);},
  ];
  for(const change of cases){
    const input=fixture();change(input);
    assert.throws(()=>full(input),{code:'INVALID_EVIDENCE'});
  }
  assert.throws(()=>buildBrainProof(fixture(95),{days:90}),{code:'INSUFFICIENT_EVIDENCE'});
  assert.throws(()=>buildBrainProof(fixture(),{assetKey:'coin:unknown'}),{code:'UNSUPPORTED_ASSET'});
  assert.throws(()=>buildBrainProof(fixture(),{days:-10}),{code:'INVALID_WINDOW'});
});

test('settlement follows the frozen forward entry and requires its matching completed future UTC session',()=>{
  const input=fixture();
  const bar=input.assets[0].bars.at(-1);
  const observedAt=iso(bar[0]+DAY+3600);
  const intent=buildForwardIntent(input,{assetKey:'coin:bitcoin',observedAt});
  assert.equal(intent.scheduledOpenAt,iso(bar[0]+2*DAY));
  assert.equal(intent.selected,'trend');
  const tuple=[bar[0]+2*DAY,bar[4],bar[4]*1.03,bar[4]*.99,bar[4]*1.02,50];
  const closedAt=iso(tuple[0]+DAY);
  assert.throws(()=>settleForwardIntent(intent,tuple,{observedAt}),{code:'SESSION_OPEN'});
  assert.throws(()=>settleForwardIntent(intent,bar,{observedAt:closedAt}),{code:'INVALID_EVIDENCE'});
  assert.throws(()=>settleForwardIntent({...intent,risk:{...intent.risk,amount:9999}},tuple,{observedAt:closedAt}),{code:'INVALID_INTENT'});
  assert.throws(()=>settleForwardIntent({...intent,assumptions:{...intent.assumptions,feeBps:0}},tuple,{observedAt:closedAt}),{code:'INVALID_INTENT'});
  const receipt=settleForwardIntent(intent,tuple,{observedAt:closedAt});
  assert.equal(receipt.status,'filled');
  assert.equal(receipt.decisionId,intent.id);
  assert.deepEqual(receipt,settleForwardIntent(JSON.parse(JSON.stringify(intent)),tuple,{observedAt:iso(tuple[0]+2*DAY)}));
  assert.throws(()=>buildForwardIntent(input,{assetKey:'coin:bitcoin',observedAt:iso(bar[0]+2*DAY+3600)}),{code:'STALE_EVIDENCE'});
  assert.throws(()=>buildForwardIntent(input,{assetKey:'coin:bitcoin',observedAt:iso(bar[0]+DAY)}),{code:'STALE_EVIDENCE'});
});

test('archived venue candles produce content-addressed reports including observed losses, skips and prior receipts',()=>{
  const report=buildBrainProof(archive);
  const {runId,...body}=report;
  assert.equal(runId,sha(body));
  assert.equal(report.summary.observations,90);
  assert.equal(report.summary.trades+report.summary.skips,90);
  for(let i=0;i<report.decisions.length;i++){
    const {id,execution,...intent}=report.decisions[i];
    assert.equal(id,sha(intent));
    assert.equal(execution.decisionId,id);
    assert.equal(intent.previousReceiptId,report.decisions[i-2]?.execution.id??null);
    assert.equal(execution.openRisk.previousReceiptId,report.decisions[i-1]?.execution.id??null);
    if(intent.previousReceiptAt)assert.ok(Date.parse(intent.previousReceiptAt)<Date.parse(intent.observedAt));
    const {id:receipt,...fields}=execution;
    assert.equal(receipt,sha(fields));
  }
  const amended={...archive,updatedAt:iso(Date.parse(archive.updatedAt??archive.retrievedAt)/1000+60)};
  assert.notEqual(buildBrainProof(amended).runId,runId);
});

test('a fresh forward account and a replay use identical evidence, ranking, risk and actual fills for the same future open',()=>{
  const data=fixture();
  const replay=buildBrainProof(data,{days:30}).decisions[0];
  const partial=structuredClone(data);
  const observed=Date.parse(replay.observedAt);
  partial.assets[0].bars=partial.assets[0].bars.filter(row=>(row[0]+DAY)*1000<=observed);
  partial.retrievedAt=new Date(observed-1000).toISOString();
  const frozen=buildForwardIntent(partial,{assetKey:'coin:bitcoin',observedAt:replay.observedAt});
  for(const field of ['asOf','barOpenAt','snapshotId','candidates','risk','selected','features'])
    assert.deepEqual(frozen[field],replay[field],field);
  const target=data.assets[0].bars.find(row=>iso(row[0])===replay.barOpenAt);
  const receipt=settleForwardIntent(frozen,target,{observedAt:iso(target[0]+DAY)});
  for(const field of ['status','reason','fees','slippage','netPnl','entryPrice','exitPrice','quantity'])
    assert.equal(receipt[field],replay.execution[field],field);
  assert.ok(Date.parse(frozen.asOf)+DAY*1000<Date.parse(frozen.scheduledOpenAt));
});

test('settling the registration day later at a loss cannot alter the frozen decision or its ledger',()=>{
  const clean=fixture(), revised=structuredClone(clean);
  const target=105;
  // Only the post-registration intraday low changes. It triggers a stop on
  // the overlapping session, which was still unsettled when the intent froze.
  revised.assets[0].bars[target-1][3]*=.70;
  const left=full(clean).decisions,right=full(revised).decisions;
  const index=target-92;
  const {execution:before,...original}=left[index];
  const {execution:after,...frozen}=right[index];
  assert.deepEqual(original,frozen);
  assert.equal(left[index-1].execution.status,'filled');
  assert.equal(right[index-1].execution.reason,'stop_loss');
  assert.ok(after.equityBefore<before.equityBefore);
  assert.equal(frozen.previousReceiptId,left[index-2].execution.id);
  assert.equal(after.openRisk.previousReceiptId,right[index-1].execution.id);
  assert.ok(after.openRisk.amount<=frozen.risk.amount);
  assert.ok(after.amount<before.amount);
  assert.equal(after.openRisk.reason,'open_risk_reduced');
  closeTo(after.equityAfter,after.equityBefore+after.netPnl);
});

test('omitting a settled session can change the next winner, and broken evidence cannot explain it',()=>{
  const run=buildBrainProof(archive,{assetKey:'coin:ethereum',days:90});
  const record=run.decisions.find(row=>row.barOpenAt==='2026-08-28T00:00:00.000Z');
  const proof=buildLearningRecord(run,record,archive);
  assert.equal(proof.nextDecision.selected,'cash');assert.equal(proof.nextDecision.withoutSession,'trend');
  assert.equal(proof.nextDecision.selectionChanged,true);
  const changed=structuredClone(run);
  const later=changed.decisions.find(d=>d.id===proof.nextDecision.id);
  later.previousReceiptId=null;
  assert.throws(()=>buildLearningRecord(changed,record,archive),{code:'INVALID_EVIDENCE'});
  const altered=structuredClone(record);
  altered.execution.netPnl+=1;
  assert.throws(()=>buildLearningRecord(run,altered,archive),{code:'INVALID_EVIDENCE'});
  const missing=structuredClone(archive),market=missing.assets.find(a=>a.key===run.asset.key);
  market.bars.find(b=>iso(b[0])===record.barOpenAt)[5]+=1;
  assert.throws(()=>buildLearningRecord(run,record,missing),{code:'INVALID_EVIDENCE'});
});
