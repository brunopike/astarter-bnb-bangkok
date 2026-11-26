// Server-only, read-only audit of a registered paper decision. The caller supplies
// the audit clock and the full frozen envelopes, never prices or intended trades.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {buildForwardIntent,validateProofMarket,PROOF_VERSION} from './brain-proof-engine.mjs';
import {verifyForwardProof} from './brain-proof-forward.mjs';
import {PROTECTION_RULES} from './strategy-protection.mjs';

import {checkVenueInputs,checkVenueVeto,checkSettlementInputs} from './brain-venue-gate.mjs';
import {inspectStrategyWitness} from './brain-strategy-witness.mjs';
import {inspectExecutionWitness} from './brain-execution-invariants.mjs';

const DAY=86400000;
const gates=[
  ['registration','brain'],['source','brain'],['cutoff','brain'],
  ['candidates','thinking'],['risk','thinking'],['authority','execution'],['receipt','execution'],
];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const utc=value=>typeof value==='string'?Date.parse(value):NaN;
const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const hashMatches=envelope=>Boolean(envelope?.document && hex(envelope.sha256) && digest(envelope.document)===envelope.sha256);
const iso=value=>new Date(value).toISOString();

function requireFact(ok,reason){
  if(!ok)throw Object.assign(new Error(reason),{proofReason:reason});
}
function stageStatus(checks){
  if(checks.some(check=>check.status==='blocked'))return 'blocked';
  return checks.every(check=>check.status==='verified')?'verified':'waiting';
}

export function evaluateDecisionProof(proof,{assetKey,checkedAt,delivery='paper',date,expectedCommitId,includeSensitivity=false}={}){
  const now=typeof checkedAt==='number'?checkedAt:utc(checkedAt);
  const checks=gates.map(([id,layer])=>({id,layer,status:'waiting',reason:'awaiting_registration'}));
  const result={version:'decision-proof-v1',status:'waiting',reason:'awaiting_registration',action:'unavailable',
    liveAuthorized:false,canIssuePaperHandoff:false,commitId:null,decisionId:null,snapshotId:null,
    assetKey:typeof assetKey==='string'?assetKey:null,selected:null,recordedAt:null,targetOpenAt:null,
    stages:{brain:'waiting',thinking:'waiting',execution:'waiting'},checks,evidence:null,decision:null,execution:null,assurance:{source:null,strategy:null,execution:null}};
  let current=0;
  function checked(reason,status='verified'){
    checks[current].status=status;checks[current].reason=reason;current++;
  }
  try{
    requireFact(Number.isSafeInteger(now) && now>0 && typeof assetKey==='string' && assetKey.length>0,'invalid_request');
    if(proof===null){
      requireFact(delivery==='paper','route_not_authorized');
      return result;
    }
    for(const item of checks)item.reason='prerequisite_unverified';
    const {commit,archive,dispatch,settlement}=proof;
    requireFact(hashMatches(commit) && proof.id===commit.sha256 && (expectedCommitId===undefined || expectedCommitId===proof.id),'commit_digest_mismatch');
    const {intent,recordedAt,archiveSha256}=commit.document;
    const {id,...intentBody}=intent;
    requireFact(hex(id) && id===digest(intentBody) && same(intent,proof.intent),'intent_digest_mismatch');
    requireFact(intent.mode==='forward_paper' && intent.version===PROOF_VERSION,'unsupported_intent');
    const observed=utc(intent.observedAt),recorded=utc(recordedAt),target=utc(intent.scheduledOpenAt);
    requireFact(Number.isSafeInteger(target) && intent.scheduledOpenAt===iso(target) &&
      intent.barOpenAt===intent.scheduledOpenAt && proof.targetOpenAt===intent.scheduledOpenAt &&
      (!date || date===intent.scheduledOpenAt.slice(0,10)) && assetKey===intent.assetKey,'wrong_registration');
    requireFact(proof.recordedAt===recordedAt && Number.isFinite(observed) && observed<=recorded && recorded<=now &&
      recorded+60000<target && target===(Math.floor(observed/DAY)+1)*DAY,'invalid_registration_clock');
    Object.assign(result,{commitId:commit.sha256,decisionId:id,recordedAt,targetOpenAt:intent.scheduledOpenAt});
    checked('record_frozen');

    requireFact(hex(archiveSha256) && archiveSha256===proof.archiveSha256 && archive && digest(archive)===archiveSha256,'source_digest_mismatch');
    const {asset,bars,fetched}=validateProofMarket(archive,assetKey);
    requireFact(same(asset,intent.asset) && intent.market===asset.market && intent.quote===asset.quote && proof.quote===asset.quote,'instrument_mismatch');
    const window=bars.slice(-intent.barCount);
    requireFact(Number.isSafeInteger(intent.barCount) && intent.barCount>0 && window.length===intent.barCount &&
      digest([assetKey,asset.market,asset.venue,asset.quote,window])===intent.snapshotId,'snapshot_digest_mismatch');
    checked('source_and_instrument_verified');

    const end=window.at(-1)[0]*1000+DAY;
    requireFact(iso(window[0][0]*1000)===intent.evidenceStartAt && iso(end-1)===intent.asOf &&
      end===Math.floor(observed/DAY)*DAY && end<=fetched && fetched<=observed,'stale_or_future_evidence');
    result.snapshotId=intent.snapshotId;
    result.evidence={archiveSha256,venue:asset.venue,market:asset.market,quote:asset.quote,barCount:window.length,
      asOf:intent.asOf,retrievedAt:iso(fetched),sourceUrl:asset.sourceUrl};
    result.assurance.source=checkVenueInputs(proof);
    requireFact(result.assurance.source.status!=='blocked',result.assurance.source.reason);
    checked('closed_before_registration');

    const rebuilt=buildForwardIntent(archive,{assetKey,observedAt:intent.observedAt});
    requireFact(same(intent.features,rebuilt.features) && intent.sourceUrl===rebuilt.sourceUrl &&
      same(intent.candidates,rebuilt.candidates) && intent.selected===rebuilt.selected &&
      proof.selected===intent.selected && intent.reason===rebuilt.reason,'candidate_replay_mismatch');
    const eligible=intent.candidates.filter(candidate=>candidate.eligible);
    const winner=eligible.reduce((best,candidate)=>candidate.score>best.score?candidate:best);
    requireFact(winner.id===intent.selected,'selection_mismatch');
    result.evidence.sourceUrl=intent.sourceUrl;
    checked('candidate_ranking_reproduced');

    const {risk,assumptions}=intent;
    requireFact(same(rebuilt,intent) && proof.riskMode===risk.mode,'risk_replay_mismatch');
    const abstain=intent.selected==='cash' || ['pause','wait'].includes(risk.action);
    const modeledCostFraction=2*(assumptions.feeBps+assumptions.slippageBps)/10000;
    requireFact(risk.amount>=0 && risk.riskBudget>=0 && risk.amount<=intent.equityBefore*PROTECTION_RULES.notional &&
      risk.amount*(risk.stopFraction+modeledCostFraction)<=risk.riskBudget+1e-8 &&
      (abstain?risk.amount===0:risk.amount>0 && ['allow','reduce'].includes(risk.action)),'risk_budget_exceeded');
    result.assurance.strategy=inspectStrategyWitness(intent,archive,{includeSensitivity});
    requireFact(result.assurance.strategy.status==='verified',result.assurance.strategy.reason);
    result.selected=intent.selected;
    result.decision={selected:intent.selected,reason:intent.reason,candidates:intent.candidates,risk,features:intent.features,
      previousClose:window.at(-2)[4],equityBefore:intent.equityBefore};
    checked(abstain?'abstention_binding':'size_within_limits');

    requireFact(delivery==='paper','route_not_authorized');
    if(proof.venueVeto){
      requireFact(hashMatches(proof.venueVeto),'unverified_venue_veto');
      requireFact(false,checkVenueVeto(proof,now));
    }
    const disposition=abstain?'hold_cash':'admit_paper';
    const execution={route:'paper',maxNotional:risk.amount,quote:asset.quote,disposition,dispatchId:null,receiptId:null,receiptHash:null,status:null};
    result.execution=execution;
    if(dispatch){
      requireFact(hashMatches(dispatch),'dispatch_digest_mismatch');
      const d=dispatch.document;
      const expected={version:'paper-dispatch-v1',route:'paper',commitId:commit.sha256,decisionId:id,snapshotId:intent.snapshotId,
        assetKey,targetOpenAt:intent.scheduledOpenAt,issuedAt:d.issuedAt,disposition,maxNotional:risk.amount,quote:asset.quote};
      requireFact(same(d,expected),'dispatch_scope_mismatch');
      const issued=utc(d.issuedAt);
      requireFact(recorded<=issued && issued<target && issued<=now,'invalid_dispatch_clock');
      execution.dispatchId=dispatch.sha256;
      checked('paper_handoff_verified');
    }else{
      requireFact(!settlement && now<target,'missing_preopen_handoff');
      result.canIssuePaperHandoff=true;
      checked('awaiting_handoff','waiting');
    }
    result.action=abstain?'abstain':'paper_only';

    if(settlement){
      const row=settlement.document;
      requireFact(hashMatches(settlement) && proof.receiptHash===settlement.sha256 &&
        row.dispatchSha256===dispatch.sha256 && row.commitSha256===commit.sha256 &&
        proof.status==='settled' && same(proof.receipt,row.execution) &&
        same(proof.executionBar,row.bar) && proof.reconciledAt===row.observedAt,'receipt_lineage_mismatch');
      requireFact(utc(row.observedAt)<=now && utc(row.observedAt)>=target+DAY,'invalid_receipt_clock');
      verifyForwardProof(proof);
      result.assurance.settlementSource=checkSettlementInputs(proof);
      requireFact(result.assurance.settlementSource.status!=='blocked',result.assurance.settlementSource.reason);
      const fill=row.execution;
      requireFact(fill.decisionId===id && fill.snapshotId===intent.snapshotId && fill.amount>=0 && fill.amount<=risk.amount &&
        (!abstain || (fill.status==='skipped' && fill.amount===0 && fill.quantity===0 && fill.netPnl===0)),'receipt_exceeds_authority');
      result.assurance.execution=inspectExecutionWitness(proof,{checkedAt:now});
      requireFact(result.assurance.execution.status==='verified',result.assurance.execution.reason);
      execution.receiptId=fill.id;execution.receiptHash=settlement.sha256;execution.status=fill.status;
      execution.reconciledAt=row.observedAt;
      checked('paper_receipt_reconciled');
      result.status='verified';result.reason='paper_receipt_reconciled';
    }else{
      requireFact(proof.status==='pending' && proof.receipt===null && proof.receiptHash===null &&
        proof.executionBar===null && proof.reconciledAt===null && !proof.settlementArchive,'unbound_receipt');
      const reason=!dispatch?'awaiting_handoff':now<target?'awaiting_session_open':now<target+DAY?'awaiting_session_close':commit.document.protocol?'awaiting_verified_settlement_candle':'awaiting_receipt';
      result.assurance.execution=inspectExecutionWitness(proof,{checkedAt:now});
      requireFact(result.assurance.execution.status!=='blocked',result.assurance.execution.reason);
      execution.status='pending';
      checked(reason,'waiting');result.reason=reason;
    }
  }catch(error){
    const reason=error.proofReason??({INVALID_EVIDENCE:'invalid_market_evidence',UNSUPPORTED_ASSET:'instrument_mismatch',
      STALE_EVIDENCE:'stale_or_future_evidence'})[error.code]??(current===6?'receipt_replay_mismatch':'invalid_proof');
    checks[current].status='blocked';checks[current].reason=reason;
    result.status='blocked';result.action='blocked';result.reason=reason;result.canIssuePaperHandoff=false;
  }
  for(const layer of Object.keys(result.stages))result.stages[layer]=stageStatus(checks.filter(check=>check.layer===layer));
  return result;
}
