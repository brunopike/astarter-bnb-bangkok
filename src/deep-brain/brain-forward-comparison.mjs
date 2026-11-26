// Both controls use the same independently funded paper sleeve and UTC session as
// the registered choice. The caller persists the plan before that session opens.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {evaluateDecisionProof} from './brain-decision-proof.mjs';

const VERSION = 'forward-comparison-v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requireCheck(condition, code) {
  if (!condition) throw Object.assign(new Error(code), {code});
}
function timestamp(value) {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  requireCheck(Number.isSafeInteger(time) && time > 0 && time <= 8.64e15, 'invalid_comparison_clock');
  return time;
}
function decisionCheck(proof, checkedAt) {
  const result = evaluateDecisionProof(proof, {assetKey:proof?.intent?.assetKey, checkedAt});
  requireCheck(result.status !== 'blocked', result.reason);
  requireCheck(proof?.dispatch && result.execution?.dispatchId === proof.dispatch.sha256, 'unverified_paper_handoff');
  return result;
}
function planDocument(proof, check, issuedAt) {
  const time = timestamp(issuedAt), opened = timestamp(proof.targetOpenAt);
  requireCheck(time >= timestamp(proof.dispatch.document.issuedAt) && time < opened, 'outside_comparison_window');
  const equity = check.decision.equityBefore;
  requireCheck(Number.isFinite(equity) && equity > 0 && proof.intent.assumptions.feeBps === 10 &&
    proof.intent.assumptions.slippageBps === 5, 'unsupported_comparison_method');
  return {
    version:VERSION, route:'paper', commitId:check.commitId, decisionId:check.decisionId,
    dispatchId:check.execution.dispatchId, snapshotId:check.snapshotId, assetKey:check.assetKey,
    market:check.evidence.market, venue:check.evidence.venue, date:proof.targetOpenAt.slice(0,10),
    targetOpenAt:proof.targetOpenAt, issuedAt:new Date(time).toISOString(), quote:proof.intent.quote, initialEquity:equity,
    cash:{allocationPct:100, cashYieldPct:0},
    cappedHold:{allocationPct:10, uninvestedCashPct:90, allocationIncludesBuyFee:true, leverage:1,
      entry:'session_open', exit:'session_close', stop:null, feeBps:10, slippageBps:5},
  };
}

// Returns the document suitable for the store's exclusive, content-addressed write.
export function createComparisonPlan(proof, issuedAt) {
  const time = timestamp(issuedAt);
  requireCheck(proof?.status === 'pending' && !proof.settlement && !proof.receipt, 'registration_closed');
  const check = decisionCheck(proof, time);
  return planDocument(proof, check, time);
}

function simulateCappedHold(plan, bar) {
  const [, open, , , close] = bar;
  const rule = plan.cappedHold, fee = rule.feeBps / 10000, slip = rule.slippageBps / 10000;
  const allocation = plan.initialEquity * rule.allocationPct / 100;
  const notional = allocation / (1 + fee); // entry fee is inside the published 10% cash budget
  const entryPrice = open * (1 + slip), exitPrice = close * (1 - slip);
  const quantity = notional / entryPrice;
  const proceeds = quantity * exitPrice;
  const buyFee = notional * fee, sellFee = proceeds * fee;
  const buySlippage = quantity * (entryPrice - open), sellSlippage = quantity * (close - exitPrice);
  const fees = buyFee + sellFee, slippage = buySlippage + sellSlippage;
  const netPnl = proceeds - sellFee - allocation;
  const grossPnl = quantity * (close - open);
  const netReturnPct = netPnl / plan.initialEquity * 100;
  const result = {allocationPct:rule.allocationPct, allocation, notional, quantity, entryPrice, exitPrice, buyFee, sellFee,
    buySlippage, sellSlippage, fees, slippage, grossPnl, netPnl, netReturnPct};
  requireCheck(Object.values(result).every(Number.isFinite) && entryPrice > 0 && exitPrice > 0 && quantity > 0 &&
    Math.abs(grossPnl - fees - slippage - netPnl) <= Math.max(1, allocation, Math.abs(netPnl)) * 1e-12, 'comparison_accounting_mismatch');
  return result;
}

export function inspectForwardComparison(proof, planEnvelope, {checkedAt} = {}) {
  const empty = {version:VERSION, planId:null, receiptId:null, receiptHash:null, quote:null, initialEquity:null, results:null};
  if (planEnvelope == null) return {...empty, status:'unavailable', reason:'no_preopen_comparison_plan'};
  try {
    const now = timestamp(checkedAt);
    requireCheck(planEnvelope.document && digest(planEnvelope.document) === planEnvelope.sha256, 'comparison_digest_mismatch');
    const plan = planEnvelope.document;
    const issued = timestamp(plan.issuedAt);
    requireCheck(issued <= now, 'comparison_plan_not_yet_issued');
    const check = decisionCheck(proof, now);
    const expected = planDocument(proof, check, issued);
    requireCheck(isDeepStrictEqual(plan, expected), 'comparison_scope_mismatch');
    const registered = {...empty, planId:planEnvelope.sha256, quote:plan.quote, initialEquity:plan.initialEquity};
    if (check.status !== 'verified') {
      requireCheck(proof.status === 'pending' && !proof.receipt && !proof.settlement, 'unverified_final_receipt');
      return {...registered, status:'pending', reason:check.reason};
    }
    requireCheck(proof.status === 'settled' && check.execution.receiptId === proof.receipt?.id &&
      check.execution.receiptHash === proof.receiptHash && proof.receipt.equityBefore === plan.initialEquity, 'unverified_final_receipt');
    requireCheck(proof.settlement.document.comparisonPlanSha256 === planEnvelope.sha256, 'comparison_receipt_binding_mismatch');
    const strategyNetPnl = proof.receipt.netPnl;
    const cappedHold = simulateCappedHold(plan, proof.executionBar);
    const excessVsCappedHold = strategyNetPnl - cappedHold.netPnl;
    requireCheck(Number.isFinite(strategyNetPnl) && Number.isFinite(excessVsCappedHold), 'invalid_comparison_pnl');
    return {...registered, status:'verified', reason:'precommitted_comparison_reconciled',
      receiptId:check.execution.receiptId, receiptHash:check.execution.receiptHash,
      results:{strategyNetPnl, cash:{netPnl:0, netReturnPct:0}, cappedHold,
        excessVsCash:strategyNetPnl, excessVsCappedHold}};
  } catch (error) {
    return {...empty, status:'blocked', reason:error.code ?? 'invalid_comparison'};
  }
}
