// Fixed UTC-calendar coverage of independent paper sleeves. Fetch and discard
// each day's full proofs before reading another day's potentially large archive.
import {readForwardProof, readForwardRefusal} from './brain-proof-forward.mjs';
import {evaluateDecisionProof} from './brain-decision-proof.mjs';
import {inspectForwardComparison} from './brain-forward-comparison.mjs';

const DAY = 86400000;
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function side(amount, equity) {
  // One result can be expressed through two different IEEE-754 evaluations.
  if (Math.abs(amount) <= Number.EPSILON * equity * 16) return 'flat';
  return amount > 0 ? 'win' : 'loss';
}

function baseRow(date) {
  return {date, status:'missing', reason:'no_registration', registered:false, hasPlan:null,
    commitId:null, receiptId:null, quote:null, initialEquity:null, selected:null, fillStatus:null,
    outcome:null, netPnl:null, excessVsCash:null, excessVsCappedHold:null};
}

async function projectDay(assetKey, date, now, read, readRefusal) {
  const row = baseRow(date);
  try {
    const proof = await read(assetKey, {date, includeEvidence:true});
    if (proof === null) {
      const refused = await readRefusal?.(assetKey, {date});
      if (!refused) return row;
      const r = refused.document;
      if (!hex(refused.sha256) || r.assetKey !== assetKey || r.targetDate !== date ||
        typeof r.reason !== 'string' || !(Date.parse(r.observedAt) <= now)) {
        return {...row, status:'blocked', reason:'invalid_refusal'};
      }
      return {...row, status:'refused', reason:r.reason};
    }
    if (!proof?.intent) return {...row, status:'unavailable', reason:'record_unavailable'};
    if (proof.intent.assetKey !== assetKey || proof.targetOpenAt !== date + 'T00:00:00.000Z')
      return {...row, status:'blocked', reason:'record_scope_mismatch'};

    row.registered = true;
    row.hasPlan = Boolean(proof.comparisonPlan);
    if (row.hasPlan) {
      // Validates the original source, ranking, policy, paper handoff, closing
      // source, receipt and previously registered controls before exposing P&L.
      const c = inspectForwardComparison(proof, proof.comparisonPlan, {checkedAt:now});
      if (c.status === 'blocked') return {...row, status:'blocked', reason:c.reason};
      Object.assign(row, {commitId:proof.id, selected:proof.selected, quote:c.quote, initialEquity:c.initialEquity});
      if (c.status === 'pending') return {...row, status:'pending', reason:c.reason};
      if (c.status !== 'verified') return {...row, status:'excluded', reason:c.reason};
      Object.assign(row, {receiptId:c.receiptId, fillStatus:proof.receipt.status});
      // Earlier compatibility paths can verify the hash of an old decision
      // without an independent venue observation. Keep those dates visible.
      if (proof.commit.document.protocol !== 'venue-observed-v2' || proof.settlement.document.protocol !== 'venue-settlement-v2') {
        return {...row, status:'excluded', reason:'unwitnessed_legacy_source'};
      }
      const {strategyNetPnl, excessVsCash, excessVsCappedHold} = c.results;
      return {...row, status:'settled', reason:proof.receipt.reason,
        outcome:side(strategyNetPnl, c.initialEquity), netPnl:strategyNetPnl, excessVsCash, excessVsCappedHold};
    }

    const check = evaluateDecisionProof(proof, {assetKey, date, checkedAt:now});
    if (check.status === 'blocked') return {...row, status:'blocked', reason:check.reason};
    Object.assign(row, {commitId:check.commitId, quote:check.evidence?.quote ?? null,
      initialEquity:check.decision?.equityBefore ?? null, selected:check.selected});
    if (check.status !== 'verified') return {...row, status:'pending', reason:check.reason};
    return {...row, status:'no_plan', reason:'no_preopen_comparison_plan',
      receiptId:check.execution.receiptId, fillStatus:proof.receipt.status};
  } catch {
    // A disk, decoding or integrity error is distinct from a day with no entry.
    return {...row, status:'unavailable', reason:'record_unavailable'};
  }
}

function tally(scores, delta, equity) {
  const outcome = side(delta, equity);
  if (outcome === 'win') scores.wins++;
  else if (outcome === 'loss') scores.losses++;
  else scores.ties++;
  scores.excessPnl += delta;
}

function summarize(rows) {
  const counts = {calendarDays:rows.length, registered:0, missing:0, refused:0, blocked:0, unavailable:0,
    pending:0, withoutPlan:0, excluded:0, settled:0, noTrade:0, comparable:0, wins:0, losses:0, flat:0};
  const groups = new Map();
  const comparison = () => ({wins:0, losses:0, ties:0, excessPnl:0});
  for (const row of rows) {
    if (row.registered) counts.registered++;
    if (row.hasPlan === false) counts.withoutPlan++;
    if (['missing', 'refused', 'blocked', 'unavailable', 'pending', 'excluded'].includes(row.status)) counts[row.status]++;
    if (row.receiptId) counts.settled++;
    if (row.fillStatus === 'skipped') counts.noTrade++;
    if (row.status !== 'settled') continue;
    counts.comparable++;
    if (row.outcome === 'win') counts.wins++;
    else if (row.outcome === 'loss') counts.losses++;
    else counts.flat++;
    let g = groups.get(row.quote);
    if (!g) {
      g = {quote:row.quote, samples:0, netPnl:0, againstCash:comparison(), againstCappedHold:comparison()};
      groups.set(row.quote, g);
    }
    g.samples++;
    g.netPnl += row.netPnl;
    tally(g.againstCash, row.excessVsCash, row.initialEquity);
    tally(g.againstCappedHold, row.excessVsCappedHold, row.initialEquity);
  }
  const byQuote = [...groups.values()].sort((a, b) => a.quote.localeCompare(b.quote));
  return {counts, performance:byQuote.length === 1 ? byQuote[0] : null, byQuote};
}

export async function summarizeForwardTrack(assetKey, {
  days = 30, checkedAt = Date.now(), read = readForwardProof,
  readRefusal = read === readForwardProof ? readForwardRefusal : null,
} = {}) {
  const now = typeof checkedAt === 'string' ? Date.parse(checkedAt) : checkedAt;
  if (typeof assetKey !== 'string' || !assetKey.length || assetKey.length > 128 || !Number.isInteger(days) ||
    days < 1 || days > 30 || !Number.isSafeInteger(now) || now < days * DAY || now >= 8.64e15) {
    throw Object.assign(new Error('Invalid forward track query'), {code:'BAD_QUERY'});
  }
  const today = Math.floor(now / DAY) * DAY;
  const rows = [];
  for (let day = today - days * DAY; day < today; day += DAY) {
    rows.push(await projectDay(assetKey, utcDate(day), now, read, readRefusal));
  }
  const active = await projectDay(assetKey, utcDate(today), now, read, readRefusal);
  return {version:'forward-track-v1', assetKey, checkedAt:new Date(now).toISOString(), days,
    startDate:rows[0].date, endDate:rows.at(-1).date, basis:'independent_daily_paper',
    rows, active:active.status === 'missing' ? null : active, ...summarize(rows)};
}
