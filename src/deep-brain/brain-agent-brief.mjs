// Project the server's audited decision. This reader has no order or signing capability.
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key] ?? null]));

function projectThinking(proof) {
  const witness = proof.assurance.strategy;
  if (proof.stages.thinking !== 'verified' || witness?.status !== 'verified') {
    return {status:proof.stages.thinking, selected:null, candidates:[], conditions:[], rule:null, risk:null, sensitivity:null};
  }
  const {selection, calibration, risk} = witness;
  const {policyVersion, stopFraction, openGapLimit} = proof.decision.risk;
  return {
    status:'verified',
    ...pick(selection, ['selected','reason','runnerUp','marginPct']),
    rule:{
      version:witness.version, marketScope:'long_only_spot', ranking:'highest_eligible_score',
      scoreUnit:'percentage_points', score:'mean_after_cost_return_less_downside_penalty',
      minExclusiveScore:0, minSignals:calibration.minSignals, calibrationSessions:calibration.sessions,
      feeBpsPerSide:calibration.feeBps, slippageBpsPerSide:calibration.slippageBps,
      reconsiderAt:'next_registration', signalRequires:'all_conditions_for_candidate',
    },
    candidates:witness.candidates.map(row => pick(row, ['id','eligible','reason','signal','sampleCount','score'])),
    sensitivity:witness.sensitivity ?? null,
    conditions:selection.conditions.map(row => pick(row, ['candidate','metric','actual','operator','reference','threshold','met'])),
    risk:{policyVersion, ...pick(risk, ['effectiveProfile','action','reason','maxNotional','riskBudget']),
      quote:proof.evidence.quote, riskBudgetBasis:'before_veto', stopFraction, openGapLimit},
  };
}

function projectExecution(current) {
  const proof = current.decisionProof, audit = proof.assurance.execution, instruction = proof.execution;
  const frozen = proof.stages.thinking === 'verified' && proof.assurance.strategy?.status === 'verified';
  const permitted = proof.status !== 'blocked' && frozen && instruction?.route === 'paper';
  const delivered = Boolean(permitted && instruction.dispatchId && current.dispatch?.sha256 === instruction.dispatchId &&
    audit?.authority?.route === 'paper');
  const knownAt = Date.parse(instruction?.reconciledAt);
  const sessionClosedAt = Date.parse(proof.targetOpenAt) + 86400000;
  const settled = Boolean(knownAt >= sessionClosedAt && knownAt <= Date.parse(current.checkedAt) && delivered && proof.status === 'verified' && audit.status === 'verified' && audit.reconciliation &&
    instruction.receiptId && instruction.receiptHash);
  const blocked = proof.status === 'blocked';
  let state = 'awaiting_registration';
  if (blocked) state = 'blocked';
  else if (settled) state = 'settled';
  else if (delivered) state = 'dispatched';
  else if (permitted) state = 'awaiting_dispatch';
  const comparison = current.comparison;
  const verifiedComparison = settled && comparison?.status === 'verified' &&
    comparison.receiptId === instruction.receiptId && comparison.receiptHash === instruction.receiptHash;
  return {
    route:'paper', state, reason:proof.reason,
    disposition:permitted ? instruction.disposition : null,
    canIssuePaperHandoff:permitted && !delivered && proof.canIssuePaperHandoff === true,
    maxNotional:blocked ? 0 : permitted ? instruction.maxNotional : null,
    quote:proof.evidence?.quote ?? current.venueReview?.quote ?? null,
    dispatchId:delivered ? instruction.dispatchId : null,
    issuedAt:delivered ? current.dispatch.document.issuedAt : null,
    receipt:settled ? {id:instruction.receiptId, phase:'post_session', knownAt:instruction.reconciledAt, ...pick(audit.reconciliation,
      ['status','reason','amount','quantity','fees','slippage','netPnl','equityAfter'])} : null,
    comparison:{
      status:blocked ? 'blocked' : verifiedComparison ? 'verified' : comparison?.status === 'pending' ? 'pending' : 'unavailable',
      results:verifiedComparison ? {phase:'post_session', knownAt:instruction.reconciledAt,
        ...pick(comparison.results,['strategyNetPnl','excessVsCash','excessVsCappedHold'])} : null,
    },
  };
}

function priorMemory(memory, current) {
  if (memory?.version !== 'brain-agent-recall-v1' || memory.assetKey !== current.assetKey ||
      memory.targetDate !== current.targetDate || !['available','empty','partial','unavailable'].includes(memory.status)) return null;
  const cutoff = Math.min(Date.parse(current.checkedAt), Date.parse(current.targetDate+'T00:00:00Z'),
    current.decisionProof.recordedAt ? Date.parse(current.decisionProof.recordedAt) : Infinity,
    current.refusal?.document.observedAt ? Date.parse(current.refusal.document.observedAt) : Infinity);
  return Date.parse(memory.asOf) <= cutoff ? memory : null;
}

export function buildAgentBrief(current, memory = null) {
  const proof = current?.decisionProof;
  if (proof?.version !== 'decision-proof-v1' || proof.assetKey !== current.assetKey ||
      proof.liveAuthorized !== false || !['waiting','blocked','verified'].includes(proof.status) ||
      (proof.targetOpenAt && proof.targetOpenAt !== current.targetDate+'T00:00:00.000Z')) {
    throw new Error('Invalid audited decision context');
  }
  const source = proof.assurance.source, review = current.venueReview;
  const refusal = current.refusal?.document;
  const brain = {
    status:proof.stages.brain, registeredAt:proof.recordedAt, snapshotId:proof.snapshotId,
    instrument:proof.evidence ? pick(proof.evidence,['market','venue','quote'])
      : review ? pick(review,['market','venue','quote']) : null,
    cutoff:proof.evidence?.asOf ?? refusal?.asOf ?? null, retrievedAt:proof.evidence?.retrievedAt ?? null,
    bars:proof.evidence?.barCount ?? null,
    venueAtRegistration:source ? pick(source,['status','reason','id','observedAt','matchedBars']) : null,
    venueReview:review ? pick(review,['status','reason','id','observedAt','matchedBars','totalBars']) : null,
  };
  const execution = projectExecution(current);
  return {
    version:'brain-agent-brief-v1', assetKey:current.assetKey, targetDate:current.targetDate,
    asOf:current.checkedAt, decisionId:proof.decisionId, access:'read_only', liveAuthorized:false, status:proof.status, reason:proof.reason,
    brain, thinking:projectThinking(proof), execution, memory:priorMemory(memory,current),
    links:{
      review:current.reviewUrl ?? null, registration:current.recordUrl ?? null, evidence:current.evidenceUrl ?? null,
      venueObservation:review?.documentUrl ?? null, venueResponse:review?.responseUrl ?? null,
      handoff:execution.dispatchId ? current.handoffUrl ?? null : null,
    },
  };
}
