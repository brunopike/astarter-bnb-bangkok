// Independent accounting witness for daily-spot-proof-v1. Changes to the paper
// execution model require an explicit revision of these checks.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';

const DAY=86400000;
const FEE=.001,SLIP=.0005,CAPITAL=10000;
const ids=['registration','dispatch','settlement_source','fill','costs','equity'];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasHash=(envelope)=>envelope?.document && envelope.sha256===digest(envelope.document);
const allowedStrategies=['trend','breakout','pullback','cash'];
const check=(condition,reason)=>{if(!condition)throw Object.assign(new Error(reason),{invariant:reason});};
const utc=value=>typeof value==='string'?Date.parse(value):NaN;
const keysMatch=(object,keys)=>object && equal(Object.keys(object).sort(),keys.split(' ').sort());
const positive=n=>Number.isFinite(n)&&n>0;
const nonnegative=n=>Number.isFinite(n)&&n>=0;
// Permit only floating-point accumulation error, including cancellation in quote P&L.
const near=(actual,expected,scale=0)=>Number.isFinite(actual)&&Number.isFinite(expected)&&
  Math.abs(actual-expected)<=32*Number.EPSILON*Math.max(Math.abs(actual),Math.abs(expected),Math.abs(scale));

function frozenMarket(archive,intent){
  const matches=archive?.assets?.filter(row=>row.key===intent.assetKey);
  check(matches?.length===1,'asset_scope_mismatch');
  const market=matches[0];
  for(const key of ['key','symbol','market','venue','quote'])check(market[key]===intent.asset[key],'asset_scope_mismatch');
  check(intent.asset.quote===intent.quote && intent.asset.market===intent.market &&
    intent.asset.key===intent.assetKey && Array.isArray(market.bars),'asset_scope_mismatch');
  // The market identity is verifiable at the venue even when fetch dates differ.
  const url=new URL(market.sourceUrl);
  const binance=market.venue==='Binance Spot' && market.quote==='USDT' && market.market===market.symbol+'USDT' &&
    url.origin==='https://data-api.binance.vision' && url.pathname==='/api/v3/klines' &&
    url.searchParams.get('symbol')===market.market && url.searchParams.get('interval')==='1d';
  const coinbase=market.venue==='Coinbase Exchange' && market.quote==='USD' && market.market===market.symbol+'-USD' &&
    url.origin==='https://api.exchange.coinbase.com' && url.pathname==='/products/'+market.market+'/candles' &&
    url.searchParams.get('granularity')==='86400';
  check(binance || coinbase,'asset_scope_mismatch');
  return market;
}
function checkBar(bar){
  check(Array.isArray(bar) && bar.length===6 && bar.every(Number.isFinite),'invalid_session_bar');
  const [seconds,open,high,low,close,volume]=bar;
  check(Number.isSafeInteger(seconds) && seconds>0 && seconds%86400===0 && low>0 &&
    low<=Math.min(open,close) && high>=Math.max(open,close) && volume>0,'invalid_session_bar');
}
function readCommit(proof,now){
  check(hasHash(proof.commit) && proof.id===proof.commit.sha256,'unbound_registration');
  const {intent,recordedAt,archiveSha256}=proof.commit.document;
  const {id,...terms}=intent;
  check(id===digest(terms) && equal(proof.intent,intent) && proof.recordedAt===recordedAt &&
    proof.targetOpenAt===intent.scheduledOpenAt && proof.selected===intent.selected && proof.quote===intent.quote &&
    proof.riskMode===intent.risk.mode,'unbound_registration');
  const {asset,assumptions:a,risk,features}=intent;
  check(intent.mode==='forward_paper' && intent.version==='daily-spot-proof-v1' &&
    allowedStrategies.includes(intent.selected) && a.positionType==='long_only_spot' &&
    a.entry==='scheduled_utc_open' && a.exit==='stop_or_same_session_close' && a.financing==='no_leverage_cash_yield_zero' &&
    a.feeBps===10 && a.slippageBps===5 && a.intervalSeconds===86400 && a.initialCapital===CAPITAL &&
    intent.equityBefore===CAPITAL && intent.previousReceiptId===null && intent.previousReceiptAt===null &&
    !['route','side','direction'].some(key=>Object.hasOwn(intent,key)),'unauthorized_execution_model');
  const target=utc(intent.scheduledOpenAt),recorded=utc(recordedAt),observed=utc(intent.observedAt);
  check(Number.isSafeInteger(target) && target%DAY===0 && intent.barOpenAt===intent.scheduledOpenAt &&
    observed>=target-DAY && observed<=recorded && recorded+60000<target && recorded<=now,'invalid_registration_clock');
  check(proof.archive && archiveSha256===proof.archiveSha256 && digest(proof.archive)===archiveSha256,'unbound_plan_source');
  const market=frozenMarket(proof.archive,intent),bar=market.bars.at(-1);
  check(market.sourceUrl===asset.sourceUrl && intent.barCount===91 && market.bars.length>=intent.barCount,'unbound_plan_source');
  const window=market.bars.slice(-intent.barCount);
  check(digest([asset.key,asset.market,asset.venue,asset.quote,window])===intent.snapshotId,'snapshot_mismatch');
  for(const [index,row] of window.entries()){
    checkBar(row);
    check(index===0 || row[0]-window[index-1][0]===86400,'nonconsecutive_reference_bars');
  }
  const last15=window.slice(-15);
  let trueRange=0;
  for(let i=1;i<last15.length;i++){
    const [, ,high,low]=last15[i],previousClose=last15[i-1][4];
    trueRange+=Math.max(high-low,Math.abs(high-previousClose),Math.abs(low-previousClose));
  }
  const atrFraction=trueRange/14/bar[4];
  const fetched=utc(proof.archive.updatedAt??proof.archive.retrievedAt);
  check(bar[0]*1000+DAY===target-DAY && utc(intent.asOf)===target-DAY-1 &&
    fetched>=target-DAY && fetched<=observed && features.close===bar[4],'unbound_reference_close');
  check(nonnegative(features.atrPct) && near(features.atrPct,atrFraction) &&
    risk.mode===(atrFraction>=.035?'conservative':'normal') &&
    near(risk.stopFraction,Math.min(.1,Math.max(.01,1.5*features.atrPct))) &&
    near(risk.openGapLimit,Math.min(.08,Math.max(.02,2*features.atrPct))),'invalid_protective_limits');
  const cash=intent.selected==='cash'||risk.action==='pause'||risk.action==='wait';
  const budget=CAPITAL*(risk.mode==='conservative'?.00125:.0025);
  check(nonnegative(risk.amount) && risk.amount<=.1*CAPITAL && near(risk.riskBudget,budget) &&
    risk.amount*(risk.stopFraction+2*(FEE+SLIP))<=budget+32*Number.EPSILON*budget &&
    (cash?risk.amount===0 && ['wait','pause'].includes(risk.action):
      risk.amount>0 && ['allow','reduce'].includes(risk.action)),'invalid_frozen_risk');
  return {intent,recorded,target,cash};
}
function readDispatch(proof,plan,now){
  const envelope=proof.dispatch;
  check(hasHash(envelope),'unbound_dispatch');
  const d=envelope.document,{intent,target,recorded,cash}=plan;
  check(d.route==='paper' && keysMatch(d,'version route commitId decisionId snapshotId assetKey targetOpenAt issuedAt disposition maxNotional quote') &&
    d.version==='paper-dispatch-v1','unauthorized_dispatch');
  check(d.commitId===proof.id && d.decisionId===intent.id && d.snapshotId===intent.snapshotId &&
    d.assetKey===intent.assetKey && d.quote===intent.quote && d.targetOpenAt===intent.scheduledOpenAt,'dispatch_scope_mismatch');
  check(d.disposition===(cash?'hold_cash':'admit_paper') && d.maxNotional===intent.risk.amount,'dispatch_exceeds_plan');
  const issued=utc(d.issuedAt);
  check(issued>=recorded && issued<target && issued<=now,'invalid_dispatch_clock');
  return {route:'paper',assetKey:d.assetKey,quote:d.quote,targetOpenAt:d.targetOpenAt,disposition:d.disposition,maxNotional:d.maxNotional};
}
function readSettlement(proof,plan,now){
  const {intent,target}=plan,{settlement}=proof;
  check(hasHash(settlement) && settlement.sha256===proof.receiptHash && proof.status==='settled','unbound_settlement');
  const row=settlement.document;
  const {comparisonPlanSha256,protocol,settlementObservationId,...executionFields}=row;
  const legacy=!Object.hasOwn(row,'protocol') && !Object.hasOwn(row,'settlementObservationId');
  check(legacy || (protocol==='venue-settlement-v2' && typeof settlementObservationId==='string' &&
    /^[a-f0-9]{64}$/.test(settlementObservationId)),'invalid_settlement_observation');
  check(comparisonPlanSha256==null || (typeof comparisonPlanSha256==='string' &&
    /^[a-f0-9]{64}$/.test(comparisonPlanSha256) && comparisonPlanSha256===proof.comparisonPlan?.sha256),'comparison_plan_mismatch');
  check(keysMatch(executionFields,'commitSha256 dispatchSha256 archiveSha256 bar capturedAt venue market observedAt execution') &&
    row.commitSha256===proof.id && row.dispatchSha256===proof.dispatch.sha256 && row.venue===intent.asset.venue &&
    row.market===intent.market && equal(proof.receipt,row.execution) && proof.reconciledAt===row.observedAt &&
    equal(proof.executionBar,row.bar),'settlement_scope_mismatch');
  check(proof.settlementArchive && digest(proof.settlementArchive)===row.archiveSha256,'unbound_settlement_source');
  const market=frozenMarket(proof.settlementArchive,intent);
  const hits=market.bars.filter(bar=>bar[0]*1000===target);
  check(hits.length===1 && equal(row.bar,hits[0]),'wrong_settlement_candle');
  checkBar(row.bar);
  const capture=utc(row.capturedAt);
  check(capture===utc(proof.settlementArchive.updatedAt??proof.settlementArchive.retrievedAt) &&
    capture>=target+DAY && capture<=utc(row.observedAt) && utc(row.observedAt)<=now,'invalid_settlement_clock');
  const x=row.execution,{id,...body}=x;
  check(id===digest(body) && keysMatch(x,'id decisionId snapshotId status reason entryPrice exitPrice stopPrice quantity fees slippage netPnl amount openRisk settlementBar barOpenAt barCloseAt equityBefore equityAfter') &&
    x.decisionId===intent.id && x.snapshotId===intent.snapshotId && equal(x.settlementBar,row.bar) &&
    utc(x.barOpenAt)===target && utc(x.barCloseAt)===target+DAY-1,'unbound_execution');
  return {x,bar:row.bar};
}

function reconstruct(intent,authority,bar,reported){
  const [,open,,low,close]=bar,r=intent.risk;
  // Forward v1 gives each registration an isolated, fully funded cash account.
  // At execution the already-frozen quote amount is rounded DOWN to cents again.
  const ceiling=Math.min(authority.maxNotional,CAPITAL*.1,CAPITAL/(1+FEE),r.riskBudget/(r.stopFraction+2*(FEE+SLIP)));
  const cents=Math.floor(ceiling*100)/100,atOpen=cents<5?0:cents;
  const expectedAction=r.amount===0?r.action:atOpen===0?'pause':atOpen<r.amount?'reduce':'allow';
  const openReason=r.amount===0?r.reason:atOpen===0?'budget':atOpen<r.amount?'open_risk_reduced':'within_limits';
  const expectedRisk={mode:r.mode,action:expectedAction,reason:openReason,amount:atOpen,riskBudget:r.riskBudget,
    previousReceiptId:null,previousReceiptAt:null};
  check(equal(reported.openRisk,expectedRisk),'opening_risk_mismatch');
  const gap=Math.abs(open/intent.features.close-1);
  const skip=atOpen===0?openReason:gap>r.openGapLimit?'opening_gap':null;
  if(skip){
    check(reported.status==='skipped' && reported.reason===skip && reported.amount===0 && reported.quantity===0 &&
      reported.entryPrice===null && reported.stopPrice===null && reported.exitPrice===null,'invalid_skipped_fill');
    return {status:'skipped',reason:skip,amount:0,quantity:0,entryPrice:null,stopPrice:null,exitPrice:null,
      entryFee:0,exitFee:0,fees:0,slippage:0,netPnl:0,gapFraction:gap,cashAfterEntry:CAPITAL,equityBefore:CAPITAL,equityAfter:CAPITAL};
  }
  const stopPrice=open*(1-r.stopFraction);
  const stopHit=low<=stopPrice;
  const exitReference=stopHit?stopPrice:close,entryPrice=open*(1+SLIP),exitPrice=exitReference*(1-SLIP);
  const amount=atOpen,quantity=amount/entryPrice,sale=quantity*exitPrice;
  const entryFee=FEE*amount,exitFee=FEE*sale,fees=entryFee+exitFee;
  const cashAfterEntry=CAPITAL-amount-entryFee,netPnl=(sale-exitFee)-(amount+entryFee);
  const reason=stopHit?'stop_loss':'session_close';
  check(authority.disposition==='admit_paper' && reported.status==='filled' && reported.reason===reason &&
    positive(reported.amount) && reported.amount===amount && reported.amount<=authority.maxNotional &&
    positive(reported.quantity) && near(reported.quantity,quantity) && near(reported.entryPrice,entryPrice) &&
    near(reported.exitPrice,exitPrice) && near(reported.stopPrice,stopPrice) && cashAfterEntry>=0,'invalid_long_fill');
  // Slippage is already incorporated in both trade prices. It is disclosed
  // separately and must never be subtracted a second time from the cash ledger.
  return {status:'filled',reason,amount,quantity,entryPrice,stopPrice,exitPrice,entryFee,exitFee,fees,
    slippage:quantity*SLIP*(open+exitReference),netPnl,gapFraction:gap,cashAfterEntry,equityBefore:CAPITAL,equityAfter:cashAfterEntry+sale-exitFee};
}

// Missing records describe pending evidence. When supplied, checkedAt also
// rejects a missed pre-open handoff or artifacts from the auditor's future.
export function inspectExecutionWitness(proof,{checkedAt}={}){
  const checks=ids.map(id=>({id,status:'waiting',reason:'prerequisite_unverified'}));
  const report={version:'paper-execution-witness-v1',status:'waiting',reason:'awaiting_registration',checks,
    authority:null,reconciliation:null,liveAuthorized:false};
  let position=0;
  function pass(reason){Object.assign(checks[position++],{status:'verified',reason});}
  function wait(reason){report.reason=checks[position].reason=reason;return report;}
  try{
    const now=checkedAt===undefined?Infinity:typeof checkedAt==='number'?checkedAt:utc(checkedAt);
    check(checkedAt===undefined || Number.isSafeInteger(now),'invalid_audit_time');
    if(proof===null)return wait('awaiting_registration');
    const plan=readCommit(proof,now);pass('frozen_paper_terms_verified');
    if(!proof.settlement){
      check(proof.status==='pending' && proof.receipt===null && proof.receiptHash===null && proof.reconciledAt===null &&
        proof.executionBar===null && proof.settlementArchive==null,'unbound_receipt');
    }
    if(!proof.dispatch){
      check(!proof.settlement,'receipt_without_dispatch');
      check(checkedAt===undefined || now<plan.target,'missing_preopen_dispatch');
      return wait('awaiting_dispatch');
    }
    const authority=readDispatch(proof,plan,now);report.authority=authority;pass('paper_dispatch_bound');
    if(!proof.settlement)return wait('awaiting_receipt');
    const {x,bar}=readSettlement(proof,plan,now);pass('closed_candle_bound');
    const ledger=reconstruct(plan.intent,authority,bar,x);pass('paper_fill_reconstructed');
    if(ledger.status==='skipped')check(x.fees===0 && x.slippage===0,'nonzero_abstention_costs');
    else check(nonnegative(x.fees) && nonnegative(x.slippage) && near(x.fees,ledger.fees) &&
      near(x.slippage,ledger.slippage,ledger.amount+ledger.quantity*ledger.exitPrice),'costs_mismatch');
    pass('fees_and_slippage_reconciled');
    check(x.equityBefore===CAPITAL && near(x.equityAfter,ledger.equityAfter,CAPITAL) &&
      (ledger.status==='skipped'?x.netPnl===0 && x.equityAfter===CAPITAL:near(x.netPnl,ledger.netPnl,ledger.amount+ledger.quantity*ledger.exitPrice)),
      'cash_equity_mismatch');
    pass('cash_equity_conserved');
    report.status='verified';report.reason='paper_receipt_reconciled';report.reconciliation=ledger;
  }catch(error){
    report.status='blocked';report.reason=error.invariant??'invalid_execution_witness';report.authority=null;
    Object.assign(checks[position],{status:'blocked',reason:report.reason});
  }
  return report;
}
