// Recall only evidence available before the decision. Dates are UTC sessions.
import {createHash} from 'node:crypto';
import {readForwardProof, readForwardRefusal} from './brain-proof-forward.mjs';
import {evaluateDecisionProof} from './brain-decision-proof.mjs';

const DAY = 86400000;
const DAYS = 7;
const LIMIT = 3;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const dateOf = value => new Date(value).toISOString().slice(0, 10);
const digest = val => createHash('sha256').update(JSON.stringify(val)).digest('hex');
const rejectionReasons = new Set(['STALE_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'INVALID_EVIDENCE',
  'MISSED_COMMIT_WINDOW', 'SOURCE_OBSERVATION_MISSING', 'SOURCE_OBSERVATION_CONFLICT',
  'SOURCE_OBSERVATION_UNAVAILABLE', 'SOURCE_OBSERVATION_STALE']);

function reviewUrl(assetKey, date) {
  return '/api/brain/proof?' + new URLSearchParams({current:'1', asset:assetKey, date});
}

// Verify the time on the envelope itself before using it to hide later events.
function publishedAt(envelope, field) {
  const time = Date.parse(envelope.document?.[field]);
  if (!Number.isFinite(time) || digest(envelope.document) !== envelope.sha256) throw Error('Invalid memory envelope');
  return time;
}

function asKnown(proof, cutoff) {
  if (publishedAt(proof.commit, 'recordedAt') >= cutoff) return null;
  const view = {...proof};
  if (view.settlement && publishedAt(view.settlement, 'observedAt') >= cutoff) {
    Object.assign(view, {settlement:null, receipt:null, receiptHash:null, executionBar:null, reconciledAt:null,
      settlementArchive:null, settlementVenueEvidence:null, status:'pending'});
  }
  if (view.dispatch && publishedAt(view.dispatch, 'issuedAt') >= cutoff) view.dispatch = null;
  if (view.venueVeto && publishedAt(view.venueVeto, 'issuedAt') >= cutoff) {
    view.venueVeto = null;
    view.vetoEvidence = null;
  }
  if (view.comparisonPlan && publishedAt(view.comparisonPlan, 'issuedAt') >= cutoff) view.comparisonPlan = null;
  return view;
}

function decisionMemory(proof, assetKey, date, cutoff, scope) {
  const check = evaluateDecisionProof(proof, {assetKey, date, checkedAt:cutoff - 1});
  const veto = check.reason === 'venue_conflict_veto';
  if (check.status === 'blocked' && !veto) return {kind:'rejected'};
  if (check.stages.brain !== 'verified' || check.stages.thinking !== 'verified' ||
      check.assurance.strategy?.status !== 'verified') return {kind:'rejected'};
  const {market, quote} = check.evidence;
  const sourceStatus = check.assurance.source.status;
  const settled = check.status === 'verified' && check.assurance.execution?.status === 'verified';
  const verifiedOutcome = settled && sourceStatus === 'verified' && check.assurance.settlementSource?.status === 'verified';
  const match = {market:scope.market ? market === scope.market : null,
    quote:scope.quote ? quote === scope.quote : null, strategy:scope.selected ? check.selected === scope.selected : null};
  const review = reviewUrl(assetKey, date);
  const row = {date, status:veto ? 'vetoed' : settled ? 'settled' : 'pending', selected:check.selected,
    market, quote, riskMode:check.decision.risk.mode, reason:check.reason, sourceStatus, match, outcome:null,
    provenance:{reviewUrl:review, commitUrl:review + '&artifact=commit&sha256=' + check.commitId,
      commitId:check.commitId, decisionId:check.decisionId,
      recordedAt:check.recordedAt, sourceId:check.assurance.source.id ?? null}};
  if (veto) Object.assign(row.provenance, {vetoId:proof.venueVeto.sha256, vetoAt:proof.venueVeto.document.issuedAt});
  if (verifiedOutcome) {
    row.outcome = {mode:'forward_paper', fill:proof.receipt.status, reason:proof.receipt.reason, netPnl:proof.receipt.netPnl,
      quote, receiptId:check.execution.receiptId, receiptSha256:check.execution.receiptHash, knownAt:proof.reconciledAt};
  }
  return {kind:'matched', row};
}

function refusalMemory(refused, assetKey, date, cutoff) {
  if (!refused) return {kind:'missing'};
  const doc = refused.document, open = Date.parse(date);
  const when = publishedAt(refused, 'observedAt');
  if (!['source-refusal-v1', 'venue-refusal-v2'].includes(doc.version) || !hex(doc.archiveSha256) ||
      !rejectionReasons.has(doc.reason) || !(when >= open - DAY && when < open) ||
      doc.assetKey !== assetKey || doc.targetDate !== date) return {kind:'rejected'};
  if (when >= cutoff) return {kind:'missing'};
  return {kind:'matched', row:{date, status:'refused', selected:null, market:null, quote:null, reason:doc.reason,
    riskMode:null, sourceStatus:'refusal_reproduced', match:{market:null, quote:null, strategy:null}, outcome:null,
    provenance:{reviewUrl:reviewUrl(assetKey, date), refusalId:refused.sha256, recordedAt:doc.observedAt,
      archiveSha256:doc.archiveSha256, sourceId:doc.sourceObservationId ?? null}}};
}

async function recallDay(assetKey, date, cutoff, scope, read, readRefusal) {
  // Storage returns null before opening any archive when a dated registration is absent.
  const raw = await read(assetKey, {date, includeEvidence:true});
  if (raw) {
    if (raw.intent?.assetKey !== assetKey || raw.targetOpenAt !== date + 'T00:00:00.000Z') return {kind:'rejected'};
    const proof = asKnown(raw, cutoff);
    if (proof) return decisionMemory(proof, assetKey, date, cutoff, scope);
  }
  return refusalMemory(await readRefusal(assetKey, {date}), assetKey, date, cutoff);
}

function relevance(row) {
  // Never promote another venue or quote as a comparable trade for the same token.
  if (row.match.market === false || row.match.quote === false) return 0;
  if (row.match.strategy === true) return 3;
  if (row.match.market === true || row.match.quote === true) return 2;
  return 1;
}

export async function recallAgentMemory({assetKey, targetDate, cutoff, selected = null, market = null, quote = null,
  read = readForwardProof, readRefusal = readForwardRefusal} = {}) {
  const open = Date.parse(targetDate), time = typeof cutoff === 'number' ? cutoff : Date.parse(cutoff);
  if (typeof assetKey !== 'string' || !assetKey.length || assetKey.length > 128 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !Number.isSafeInteger(open) || dateOf(open) !== targetDate ||
      !Number.isSafeInteger(time) || time <= 0) throw Object.assign(Error('Invalid recall request'), {code:'BAD_QUERY'});
  const end = Math.min(time, open);
  const coverage = {days:DAYS, from:dateOf(open - DAYS * DAY), to:dateOf(open - DAY),
    matched:0, missing:0, rejected:0, unavailable:0, returned:0};
  const records = [];
  for (let offset = 1; offset <= DAYS; offset++) {
    const date = dateOf(open - offset * DAY);
    try {
      const {kind, row} = await recallDay(assetKey, date, end, {selected, market, quote}, read, readRefusal);
      coverage[kind]++;
      if (row) records.push(row);
    } catch {
      coverage.unavailable++;
    }
  }
  records.sort((a, b) => relevance(b) - relevance(a) || b.date.localeCompare(a.date));
  // Keep a closed case and a prior gate failure visible when recent pending cases crowd them out.
  const chosen = new Set();
  if (records.length) chosen.add(records[0]);
  const outcome = records.find(row => row.outcome && relevance(row) > 0);
  const stop = records.find(row => row.status === 'vetoed' || row.status === 'refused');
  if (outcome) chosen.add(outcome);
  if (stop) chosen.add(stop);
  for (const row of records) {
    if (chosen.size === LIMIT) break;
    chosen.add(row);
  }
  const returned = records.filter(row => chosen.has(row));
  coverage.returned = returned.length;
  const incomplete = coverage.rejected + coverage.unavailable > 0;
  const status = incomplete ? (returned.length ? 'partial' : 'unavailable') : (returned.length ? 'available' : 'empty');
  return {version:'brain-agent-recall-v1', status, assetKey, targetDate, asOf:new Date(end).toISOString(), coverage, records:returned};
}
