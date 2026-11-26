// Server-only. Daily OHLCV supports a historical fill model, never an exchange receipt.
import {createHash} from 'node:crypto';
import {advanceProtection,newProtectionState,protectionConfig,protectionDecision,PROTECTION_RULES,PROTECTION_VERSION} from './strategy-protection.mjs';

const DAY=86400;
const FEATURES=30;
const CALIBRATION=60;
// An observed closed bar can arrive after the next UTC open. Leave that
// session for registration and trade the following open in scoring and replay.
const REGISTRATION_DAYS=1;
const WARMUP=FEATURES+CALIBRATION+REGISTRATION_DAYS;
const FIRST_SESSION=WARMUP+REGISTRATION_DAYS;
const STRATEGIES=['trend','breakout','pullback'];
const CAPITAL=10000;
const FEE=.001, SLIP=.0005;
export const PROOF_VERSION='daily-spot-proof-v1';
const assumptions=Object.freeze({
  initialCapital:CAPITAL,cappedHoldAllocationPct:PROTECTION_RULES.notional*100,feeBps:FEE*10000,slippageBps:SLIP*10000,intervalSeconds:DAY,
  featureBars:FEATURES,calibrationBars:CALIBRATION,minSignals:3,positionType:'long_only_spot',
  entry:'scheduled_utc_open',registrationDays:REGISTRATION_DAYS,replayDecisionClock:'12:00 UTC on the registration day',exit:'stop_or_same_session_close',stopFill:'assumes_liquidity_at_trigger_less_slippage',
  executionModel:'fractional_units_no_lot_rounding_or_market_impact',financing:'no_leverage_cash_yield_zero',
  selection:'highest_positive_downside_adjusted_mean_session_return',riskVersion:PROTECTION_VERSION,
  benchmark:'fully_invested_buy_at_first_open_sell_at_final_close_same_costs',
  drawdownBasis:'settled_daily_equity',closeTimeBasis:'historical_reconstruction',
});
const iso=seconds=>new Date(seconds*1000).toISOString();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rounded=value=>Number(value.toFixed(10));
const sum=values=>values.reduce((a,b)=>a+b,0);
const mean=values=>sum(values)/values.length;

function fail(code,message){
  const error=new Error(message);
  error.code=code;
  throw error;
}
function validBar(row){
  if(!Array.isArray(row)||row.length!==6||!row.every(Number.isFinite))return false;
  const [t,open,high,low,close,volume]=row;
  return Number.isSafeInteger(t) && t>0 && t%DAY===0 && low>0 && low<=Math.min(open,close) &&
    high>=Math.max(open,close) && volume>0;
}
export function validateProofMarket(archive,key){
  const matches=archive?.assets?.filter(asset=>asset.key===key)??[];
  if(!matches.length)fail('UNSUPPORTED_ASSET','No daily candle archive for this asset');
  if(matches.length>1)fail('INVALID_EVIDENCE','Ambiguous asset mapping');
  const {symbol,market,quote,venue,sourceUrl,bars}=matches[0];
  let url;
  try{url=new URL(sourceUrl);}catch{fail('INVALID_EVIDENCE','Invalid venue source URL');}
  const binance=venue==='Binance Spot' && quote==='USDT' && market===symbol+quote &&
    url.origin==='https://data-api.binance.vision' && url.pathname==='/api/v3/klines' &&
    url.searchParams.get('symbol')===market && url.searchParams.get('interval')==='1d';
  const coinbase=venue==='Coinbase Exchange' && quote==='USD' && market===symbol+'-'+quote &&
    url.origin==='https://api.exchange.coinbase.com' && url.pathname==='/products/'+market+'/candles' &&
    url.searchParams.get('granularity')==='86400';
  const fetched=Date.parse(archive.updatedAt??archive.retrievedAt);
  if((!binance && !coinbase)||!Number.isFinite(fetched)||!Array.isArray(bars))
    fail('INVALID_EVIDENCE','Unverified market mapping or archive timestamp');
  for(let i=0;i<bars.length;i++){
    if(!validBar(bars[i])|| (i && bars[i][0]!==bars[i-1][0]+DAY) || (bars[i][0]+DAY)*1000>fetched)
      fail('INVALID_EVIDENCE','Incomplete, duplicate, unordered or non-closed daily candle series');
  }
  return {asset:{key,symbol,market,quote,venue,sourceUrl},bars,fetched};
}
function sourceWindow(asset,first,last){
  const url=new URL(asset.sourceUrl);
  if(asset.venue==='Binance Spot'){
    url.searchParams.set('startTime',String(first*1000));
    url.searchParams.set('endTime',String((last+DAY)*1000-1));
  }else{
    url.searchParams.set('start',iso(first));
    url.searchParams.set('end',iso(last+DAY-1));
  }
  return url.href;
}
function signals(rows){
  const current=rows.at(-1), previous=rows.at(-2), closes=rows.map(r=>r[4]);
  const average30=mean(closes),average10=mean(closes.slice(-10));
  const ranges=rows.slice(-14).map((r,i)=>Math.max(r[2],rows[rows.length-15+i][4])-Math.min(r[3],rows[rows.length-15+i][4]));
  const atrPct=mean(ranges)/current[4];
  const priorHigh=Math.max(...rows.slice(-11,-1).map(r=>r[2]));
  const stopFraction=Math.max(.01,Math.min(.10,atrPct*1.5));
  const downFromMean=(current[4]-average10)/average10;
  return {
    close:current[4],average10,average30,atrPct,priorHigh,downFromMean,stopFraction,
    signal:{trend:average10>average30 && current[4]>average10,
      breakout:current[4]>priorHigh,
      pullback:downFromMean < -atrPct*.5 && current[4]>previous[4]},
  };
}
// Only the next bar's open is consulted at entry. Its low is used solely
// to model a resting sell stop after entry; a session carries no position overnight.
function simulate(amount,stopFraction,bar){
  const [,open,,low,close]=bar;
  const entryPrice=open*(1+SLIP),quantity=amount/entryPrice,stopPrice=open*(1-stopFraction);
  const stopped=low<=stopPrice;
  const exitReference=stopped?stopPrice:close,exitPrice=exitReference*(1-SLIP);
  const proceeds=quantity*exitPrice;
  const fees=(amount+proceeds)*FEE;
  const slippage=quantity*((entryPrice-open)+(exitReference-exitPrice));
  return {reason:stopped?'stop_loss':'session_close',entryPrice,exitPrice,stopPrice,quantity,fees,slippage,netPnl:proceeds-amount-fees};
}
function openGapLimit(atrPct){return Math.max(.02,Math.min(.08,2*atrPct));}
function gapExceeded(open,features){return Math.abs(open/features.close-1)>openGapLimit(features.atrPct);}
// Use a rolling calibration sample that ends before the decision. A quiet day,
// a failed signal and a gap veto contribute zero to the unconditional daily mean.
function rankCandidates(history,features){
  const candidates=STRATEGIES.map(id=>{
    const outcomes=history.filter(row=>row.signal[id] && !row.gap).map(row=>row.unitReturn);
    const downside=Math.sqrt(sum(outcomes.map(v=>Math.min(0,v)**2))/CALIBRATION);
    const score=(sum(outcomes)/CALIBRATION-.5*downside/Math.sqrt(CALIBRATION))*100;
    const signal=features.signal[id];
    const reason=!signal?'signal_absent':outcomes.length<assumptions.minSignals?'small_sample':score<=0?'nonpositive_score':'qualified';
    return {id,signal,eligible:reason==='qualified',reason,score,sampleCount:outcomes.length};
  });
  candidates.push({id:'cash',signal:true,eligible:true,reason:'cash_baseline',score:0,sampleCount:CALIBRATION});
  return candidates;
}
function prepare(bars){
  const features=new Array(bars.length+1),history=new Array(bars.length);
  for(let index=FEATURES;index<=bars.length;index++){
    features[index]=signals(bars.slice(index-FEATURES,index));
    const before=features[index-REGISTRATION_DAYS];
    if(before && index<bars.length){
      const gap=gapExceeded(bars[index][1],before);
      history[index]={signal:before.signal,gap,unitReturn:gap?0:simulate(1,before.stopFraction,bars[index]).netPnl};
    }
  }
  return {features,history};
}
function makeIntent({asset,bars,index,prepared,state,equity,mode,observedAt,scheduledOpenAt,previousReceiptId,previousReceiptAt}){
  const window=bars.slice(index-WARMUP,index);
  const first=window[0][0],last=window.at(-1)[0],asOf=new Date((last+DAY)*1000-1).toISOString();
  const snapshotId=digest([asset.key,asset.market,asset.venue,asset.quote,window]);
  const features=prepared.features[index];
  const candidates=rankCandidates(prepared.history.slice(index-CALIBRATION,index),features);
  let selected=candidates.at(-1);
  for(const item of candidates)if(item.eligible && item.score>selected.score)selected=item;
  const riskMode=features.atrPct>=.035 || equity<=state.high*(1-PROTECTION_RULES.soft)?'conservative':'normal';
  const policy=protectionConfig('astarter',riskMode);
  const sizing=protectionDecision({policy,state,equity,requested:equity,cap:equity,cash:equity,asset:asset.key,
    stopFraction:features.stopFraction,feeFraction:2*(FEE+SLIP)});
  const cash=selected.id==='cash', veto=features.atrPct>.10;
  const risk={mode:riskMode,modeReason:features.atrPct>=.035?'elevated_volatility':riskMode==='conservative'?'equity_drawdown':'standard_volatility',policyVersion:policy.version,action:cash?'wait':veto?'pause':sizing.action,
    reason:cash?'cash_selected':veto?'volatility_limit':sizing.reason??'within_limits',
    amount:cash||veto?0:sizing.amount,riskBudget:sizing.risk,limits:sizing.limits??{},stopFraction:features.stopFraction,
    reserve:state.reserve,priorHigh:state.high,locked:state.locked,
    openGapLimit:openGapLimit(features.atrPct)};
  const body={version:PROOF_VERSION,mode,assetKey:asset.key,market:asset.market,quote:asset.quote,equityBefore:equity,
    previousReceiptId,previousReceiptAt,snapshotId,asOf,observedAt,barOpenAt:scheduledOpenAt,scheduledOpenAt,
    sourceUrl:sourceWindow(asset,first,last),evidenceStartAt:iso(first),barCount:window.length,
    features,candidates,selected:selected.id,reason:cash?'no_candidate_beats_cash':'highest_eligible_score',risk};
  return {id:digest(body),...body};
}
function openingRisk(intent,account){
  const frozen=intent.risk;
  const mode=account.equity<=account.state.high*(1-PROTECTION_RULES.soft)?'conservative':frozen.mode;
  const policy=protectionConfig('astarter',mode);
  const sized=protectionDecision({policy,state:account.state,equity:account.equity,requested:frozen.amount,
    cap:frozen.amount,cash:account.equity,asset:intent.assetKey,stopFraction:frozen.stopFraction,feeFraction:2*(FEE+SLIP)});
  const amount=Math.min(frozen.amount,sized.amount);
  const reason=frozen.amount<=0?frozen.reason:sized.reason??(amount<frozen.amount?'open_risk_reduced':'within_limits');
  return {mode,action:frozen.amount<=0?frozen.action:sized.action,reason,amount,riskBudget:sized.risk,
    previousReceiptId:account.previousReceiptId,previousReceiptAt:account.previousReceiptAt};
}
function settle(intent,bar,account){
  const openRisk=openingRisk(intent,account);
  const skipReason=openRisk.amount<=0?openRisk.reason:gapExceeded(bar[1],intent.features)?'opening_gap':null;
  const amount=skipReason?0:openRisk.amount;
  const fill=skipReason?{reason:skipReason,entryPrice:null,exitPrice:null,stopPrice:null,quantity:0,fees:0,slippage:0,netPnl:0}
    :simulate(amount,intent.risk.stopFraction,bar);
  const row={decisionId:intent.id,snapshotId:intent.snapshotId,status:skipReason?'skipped':'filled',...fill,amount,openRisk,
    settlementBar:bar.slice(),barOpenAt:iso(bar[0]),barCloseAt:new Date((bar[0]+DAY)*1000-1).toISOString(),
    equityBefore:account.equity,equityAfter:account.equity+fill.netPnl};
  return {id:digest(row),...row};
}
function initialAccount(){
  return {state:newProtectionState(CAPITAL),equity:CAPITAL,previousReceiptId:null,previousReceiptAt:null};
}
export function buildBrainProof(archive,{assetKey='coin:bitcoin',days=90}={}){
  if(![30,90,180,365,'all'].includes(days))fail('INVALID_WINDOW','Unsupported evaluation window');
  const {asset,bars,fetched}=validateProofMarket(archive,assetKey);
  const count=days==='all'?bars.length-FIRST_SESSION:days;
  if(count<=0 || bars.length<count+FIRST_SESSION)fail('INSUFFICIENT_EVIDENCE','Not enough consecutive daily bars for warm-up and evaluation');
  const start=bars.length-count;
  const prepared=prepare(bars);
  // At registration noon, yesterday's intraday paper session has not yet
  // closed. Freeze only its opening ledger, then recheck against the settled
  // ledger at the new session's open. The latter may only reduce the order.
  let opening=initialAccount(),registration=opening,maxDrawdownPct=0;
  let wins=0,losses=0,flat=0,fees=0,slippage=0,exposureSum=0;
  const decisions=[];
  for(let i=start;i<bars.length;i++){
    const bar=bars[i],scheduledOpenAt=iso(bar[0]);
    const observedAt=iso(bar[0]-DAY/2);
    const intent=makeIntent({asset,bars,index:i-REGISTRATION_DAYS,prepared,...registration,mode:'historical_replay',observedAt,scheduledOpenAt});
    const execution=settle(intent,bar,opening);
    if(execution.status==='filled'){
      if(execution.netPnl>0)wins++;else if(execution.netPnl<0)losses++;else flat++;
    }
    fees+=execution.fees;slippage+=execution.slippage;
    exposureSum+=execution.amount/execution.equityBefore;
    const equity=execution.equityAfter;
    const state=advanceProtection(opening.state,{equity,settled:true,day:bar[0]/DAY,policy:protectionConfig('astarter',execution.openRisk.mode)});
    registration=opening;
    opening={equity,state,previousReceiptId:execution.id,previousReceiptAt:execution.barCloseAt};
    maxDrawdownPct=Math.max(maxDrawdownPct,(1-equity/state.high)*100);
    decisions.push({...intent,execution});
  }
  const {equity}=opening;
  const first=bars[start],last=bars.at(-1);
  const benchmarkUnits=CAPITAL/((1+FEE)*first[1]*(1+SLIP));
  const buyHoldEquity=benchmarkUnits*last[4]*(1-SLIP)*(1-FEE);
  const trades=wins+losses+flat,netReturnPct=rounded((equity/CAPITAL-1)*100);
  const buyHoldReturnPct=rounded((buyHoldEquity/CAPITAL-1)*100);
  const summary={startAt:iso(first[0]),endAt:new Date((last[0]+DAY)*1000-1).toISOString(),
    observations:count,trades,wins,losses,flat,skips:count-trades,netPnl:rounded(equity-CAPITAL),netReturnPct,
    maxDrawdownPct:rounded(maxDrawdownPct),buyHoldReturnPct,cappedHoldReturnPct:rounded((buyHoldEquity/CAPITAL-1)*PROTECTION_RULES.notional*100),
    meanExposurePct:rounded(exposureSum/count*100),cashReturnPct:0,excessVsBuyHoldPct:rounded(netReturnPct-buyHoldReturnPct),
    fees:rounded(fees),slippage:rounded(slippage)};
  const used=bars.slice(start-FIRST_SESSION);
  const brain={evidenceId:digest([asset.key,asset.market,asset.venue,asset.quote,used]),retrievedAt:new Date(fetched).toISOString(),
    firstAt:iso(used[0][0]),lastAt:summary.endAt,barCount:used.length,sourceUrl:asset.sourceUrl,
    availabilityBasis:'historical_reconstruction'};
  const report={version:PROOF_VERSION,mode:'historical_replay',asset,brain,assumptions,summary,decisions};
  return {runId:digest(report),...report};
}
export function buildForwardIntent(archive,{assetKey,observedAt}){
  const now=Date.parse(observedAt);
  if(!Number.isFinite(now))fail('INVALID_CLOCK','A valid observedAt is required');
  const {asset,bars,fetched}=validateProofMarket(archive,assetKey);
  if(fetched>now)fail('STALE_EVIDENCE','The archive was retrieved after this observation');
  if(bars.length<WARMUP)fail('INSUFFICIENT_EVIDENCE','Not enough closed bars to register a decision');
  const today=Math.floor(now/(DAY*1000))*DAY;
  if(bars.at(-1)[0]+DAY!==today)fail('STALE_EVIDENCE','The most recent completed UTC day is unavailable');
  const recent=bars.slice(-WARMUP);
  const intent=makeIntent({asset,bars:recent,index:recent.length,prepared:prepare(recent),...initialAccount(),
    mode:'forward_paper',observedAt:new Date(now).toISOString(),scheduledOpenAt:iso(today+DAY)});
  const {id:decisionHash,...decision}=intent;
  const frozen={...decision,asset,assumptions};
  return {id:digest(frozen),...frozen};
}
export function settleForwardIntent(intent,bar,{observedAt}){
  if(!intent || intent.mode!=='forward_paper' || intent.version!==PROOF_VERSION)fail('INVALID_INTENT','Expected a frozen forward intent');
  const {id,...body}=intent;
  if(id!==digest(body))
    fail('INVALID_INTENT','Frozen decision identity does not match');
  if(!validBar(bar)||iso(bar[0])!==body.scheduledOpenAt)fail('INVALID_EVIDENCE','Wrong settlement session or invalid candle');
  const now=Date.parse(observedAt);
  if(!Number.isFinite(now) || now<(bar[0]+DAY)*1000)fail('SESSION_OPEN','Settlement requires a completed session');
  return settle(intent,bar,initialAccount());
}
