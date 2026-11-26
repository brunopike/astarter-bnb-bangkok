import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sample from './brain-evidence/daily-markets.json' with {type:'json'};
import {buildForwardIntent} from './brain-proof-engine.mjs';
import {evaluateDecisionProof} from './brain-decision-proof.mjs';
import {buildAgentBrief} from './brain-agent-brief.mjs';

const key = 'coin:bitcoin';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wrap = document => ({sha256:hash(document),document});
const iso = ms => new Date(ms).toISOString();

function current(issued = true, includeSensitivity = false) {
  const asset = sample.assets.find(row => row.key === key);
  const archive = {retrievedAt:sample.retrievedAt,assets:[asset]}, archiveSha256 = hash(archive);
  const recordedAt = iso(Date.parse(archive.retrievedAt)+60000);
  const intent = buildForwardIntent(archive,{assetKey:key,observedAt:recordedAt});
  const commit = wrap({archiveSha256,recordedAt,intent});
  const checkedAt = iso(Date.parse(recordedAt)+2000), targetDate = intent.scheduledOpenAt.slice(0,10);
  const dispatch = issued ? wrap({version:'paper-dispatch-v1',route:'paper',commitId:commit.sha256,decisionId:intent.id,
    snapshotId:intent.snapshotId,assetKey:key,targetOpenAt:intent.scheduledOpenAt,issuedAt:recordedAt,
    disposition:intent.risk.amount ? 'admit_paper' : 'hold_cash',maxNotional:intent.risk.amount,quote:intent.quote}) : null;
  const frozen = {id:commit.sha256,intent,commit,recordedAt,archive,archiveSha256,selected:intent.selected,
    riskMode:intent.risk.mode,targetOpenAt:intent.scheduledOpenAt,quote:intent.quote,dispatch,status:'pending',
    receipt:null,receiptHash:null,executionBar:null,reconciledAt:null,settlement:null};
  const proof = evaluateDecisionProof(frozen,{assetKey:key,checkedAt,date:targetDate,includeSensitivity});
  assert.equal(proof.stages.thinking,'verified');
  return {assetKey:key,targetDate,checkedAt,decisionProof:proof,dispatch,handoffUrl:issued ? '/dispatch' : null,
    reviewUrl:'/review',recordUrl:'/commit',evidenceUrl:'/evidence',
    venueReview:{id:'recheck',assetKey:key,status:'matched',matchedBars:91,totalBars:91,observedAt:checkedAt,
      documentUrl:'/observation',responseUrl:'/response'},comparison:{status:'pending'}};
}

test('projects the independently reproduced selection, counterconditions and registered risk without raw candles',()=>{
  const origin = current(), brief = buildAgentBrief(origin);
  assert.equal(brief.brain.venueAtRegistration.status,'not_recorded_at_registration');
  assert.equal(brief.brain.venueReview.status,'matched');
  assert.equal(brief.brain.cutoff,origin.decisionProof.evidence.asOf);
  assert.equal(brief.thinking.selected,origin.decisionProof.selected);
  assert.equal(brief.thinking.rule.minSignals,3);
  assert.equal(brief.thinking.sensitivity,null);
  const condition = brief.thinking.conditions.find(row => row.candidate === 'breakout');
  assert.equal(condition.met,condition.actual > condition.threshold);
  assert.equal(brief.thinking.risk.maxNotional,origin.decisionProof.decision.risk.amount);
  assert.equal(brief.execution.state,'dispatched');
  assert.equal(brief.execution.disposition,origin.dispatch.document.disposition);
  assert.equal(brief.execution.maxNotional,origin.dispatch.document.maxNotional);
  assert.equal(brief.execution.canIssuePaperHandoff,false);
  assert.equal(brief.execution.receipt,null);
  assert.equal(brief.execution.comparison.results,null);
  assert.equal(brief.liveAuthorized,false);
  assert.equal(brief.access,'read_only');
  assert.equal(brief.links.venueResponse,'/response');
  assert.ok(Buffer.byteLength(JSON.stringify(brief))<6000);
});

test('a future venue veto revokes the admitted paper amount and suppresses stale dispatches and results',()=>{
  const origin = current();
  Object.assign(origin.decisionProof,{action:'blocked',status:'blocked',reason:'venue_conflict_veto'});
  origin.comparison = {status:'verified',results:{strategyNetPnl:100}};
  const brief = buildAgentBrief(origin);
  assert.equal(brief.thinking.selected,origin.decisionProof.selected);
  assert.equal(brief.execution.state,'blocked');
  assert.equal(brief.execution.disposition,null);
  assert.equal(brief.execution.maxNotional,0);
  assert.equal(brief.execution.dispatchId,null);
  assert.equal(brief.execution.canIssuePaperHandoff,false);
  assert.equal(brief.links.handoff,null);
  assert.equal(brief.execution.receipt,null);
  assert.equal(brief.execution.comparison.results,null);
});

test('distinguishes missing registration from permission to issue a paper handoff',()=>{
  const origin = current(false);
  const permitted = buildAgentBrief(origin);
  assert.equal(permitted.execution.state,'awaiting_dispatch');
  assert.equal(permitted.execution.canIssuePaperHandoff,true);
  assert.equal(permitted.execution.dispatchId,null);
  origin.decisionProof = evaluateDecisionProof(null,{assetKey:key,checkedAt:origin.checkedAt});
  const missing = buildAgentBrief(origin);
  assert.equal(missing.thinking.selected,null);
  assert.equal(missing.thinking.risk,null);
  assert.equal(missing.execution.state,'awaiting_registration');
  assert.equal(missing.execution.maxNotional,null);
  assert.equal(missing.execution.canIssuePaperHandoff,false);
  assert.throws(()=>buildAgentBrief({...origin,assetKey:'coin:other'}),/Invalid audited/);
});

test('a verified paper receipt is distinct from a plan; comparisons must bind the same receipt',()=>{
  const origin = current(), proof = origin.decisionProof;
  proof.status='verified';proof.execution.receiptId='receipt';proof.execution.receiptHash='settlement';
  proof.execution.reconciledAt=iso(Date.parse(proof.targetOpenAt)+86400000+60000);
  origin.checkedAt=iso(Date.parse(proof.execution.reconciledAt)+3600000);
  Object.assign(proof.assurance.execution,{status:'verified',reconciliation:{status:'skipped',reason:'cash_selected',
    amount:0,quantity:0,fees:0,slippage:0,netPnl:0,equityAfter:10000}});
  origin.comparison={status:'verified',receiptId:'receipt',receiptHash:'settlement',
    results:{strategyNetPnl:0,excessVsCash:0,excessVsCappedHold:-1}};
  const settled=buildAgentBrief(origin);
  assert.equal(settled.execution.state,'settled');
  assert.equal(settled.execution.receipt.netPnl,0);
  assert.equal(settled.execution.receipt.phase,'post_session');
  assert.equal(settled.execution.receipt.knownAt,proof.execution.reconciledAt);
  assert.equal(settled.execution.comparison.results.knownAt,proof.execution.reconciledAt);
  assert.equal(settled.execution.comparison.results.excessVsCappedHold,-1);
  origin.comparison.receiptHash='other';
  assert.equal(buildAgentBrief(origin).execution.comparison.results,null);
  proof.execution.reconciledAt=iso(Date.parse(origin.checkedAt)+1);
  assert.equal(buildAgentBrief(origin).execution.receipt,null);
  proof.execution.reconciledAt=null;
  assert.equal(buildAgentBrief(origin).execution.receipt,null);
});

test('prior memory is asset and session scoped, and cannot carry post-registration hindsight into the brief',()=>{
  const origin = current();
  const memory={version:'brain-agent-recall-v1',status:'empty',assetKey:key,targetDate:origin.targetDate,
    asOf:origin.decisionProof.recordedAt,records:[]};
  assert.deepEqual(buildAgentBrief(origin,memory).memory,memory);
  for(const alternate of [{assetKey:'coin:other'},{targetDate:'2026-11-18'},{asOf:origin.checkedAt},{asOf:'unknown'}]){
    assert.equal(buildAgentBrief(origin,{...memory,...alternate}).memory,null);
  }
});


test('only the requested brief receives sensitivity, with identical frozen IDs, choice and authority',()=>{
  const standard = buildAgentBrief(current()), enhanced = buildAgentBrief(current(true,true));
  assert.equal(enhanced.thinking.sensitivity.omissions,60);
  const {sensitivity, ...thinking} = enhanced.thinking;
  assert.deepEqual({...enhanced,thinking:{...thinking,sensitivity:null}},standard);
});

test('a refusal sets an independent upper bound on available memory',()=>{
  const origin = current(false);
  origin.decisionProof = evaluateDecisionProof(null,{assetKey:key,checkedAt:origin.checkedAt});
  origin.refusal = {document:{observedAt:iso(Date.parse(origin.checkedAt)-1000)}};
  const memory = {version:'brain-agent-recall-v1',assetKey:key,targetDate:origin.targetDate,status:'empty',asOf:origin.checkedAt,records:[]};
  assert.equal(buildAgentBrief(origin,memory).memory,null);
  memory.asOf=origin.refusal.document.observedAt;
  assert.deepEqual(buildAgentBrief(origin,memory).memory,memory);
});
