import {EXECUTION_DEFAULTS} from './strategy-execution-data.mjs';
import {exponentialAverage,wilderSeries} from './workbench-market-analysis.mjs';

const record=EXECUTION_DEFAULTS.S03;
export const S03_SOURCE=Object.freeze({strategy:'S03',version:record.version,contract:'docs/product/S03_策略卡与ABC_v0.1.md',contractVersion:'0.1.1',parameterSource:'EXECUTION_DEFAULTS.S03',nativeOracle:'nautilus_trader==2.0.0rc3',nativeAccepted:false,periodSeconds:300});
const defaults=Object.freeze(Object.fromEntries(Object.entries(record.parameters).map(([key,item])=>[key,typeof item.value==='string'?Number(item.value):item.value])));
const copy=value=>structuredClone(value),finite=Number.isFinite;
const fail=code=>{throw Error(code);};

// rc3 uses f64::mul_add. JS has no Math.fma: evaluate the exact binary integer
// product+sum, then round once to binary64 (nearest, ties-to-even). This is local
// to S03; changing the shared chart arithmetic would change other study outputs.
const floatBits=new DataView(new ArrayBuffer(8));
function binary(value){
 floatBits.setFloat64(0,value);const bits=floatBits.getBigUint64(0),exponent=Number(bits>>52n&2047n);
 const mantissa=(bits&((1n<<52n)-1n))|(exponent?1n<<52n:0n);
 return [(bits>>63n?-1n:1n)*mantissa,exponent?exponent-1075:-1074];
}
function fusedMultiplyAdd(a,b,c){
 if(a===0||b===0)return c;if(c===0)return a*b;
 const [am,ae]=binary(a),[bm,be]=binary(b),[cm,ce]=binary(c),exponent=Math.min(ae+be,ce);
 let exact=(am*bm<<BigInt(ae+be-exponent))+(cm<<BigInt(ce-exponent));if(exact===0n)return 0;
 const sign=exact<0n?-1:1;if(exact<0n)exact=-exact;
 const shift=Math.max(exact.toString(2).length-53,-1074-exponent);let rounded;
 if(shift>0){rounded=exact>>BigInt(shift);const remainder=exact-(rounded<<BigInt(shift)),half=1n<<BigInt(shift-1);if(remainder>half||remainder===half&&(rounded&1n))rounded++;}
 else rounded=exact<<BigInt(-shift);
 return sign*Number(rounded)*2**(exponent+shift);
}

export function s03Parameters(overrides={},version=record.version){
 if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).some(key=>!Object.hasOwn(defaults,key)))fail('S03_PARAMETERS_INVALID');
 const p={...defaults,...overrides},count=(key,min,max)=>Number.isSafeInteger(p[key])&&p[key]>=min&&p[key]<=max;
 if(!count('ema_fast',5,100)||!count('ema_slow',10,250)||p.ema_fast>=p.ema_slow||!count('rsi_period',5,50)||!count('atr_period',5,50)||!count('hold_boundaries',6,288)||!count('cooldown_full_bars',1,12)||Object.entries(p).some(([key,value])=>key!=='target_enabled'&&!finite(value)))fail('S03_PARAMETERS_INVALID');
 if(p.rsi_cross<40||p.rsi_cross>60||p.rsi_ceiling<=p.rsi_cross||p.rsi_ceiling>75||p.rsi_fail<25||p.rsi_fail>50||p.rsi_fail>=p.rsi_cross||p.volatility_min<=0||p.volatility_max<=p.volatility_min||p.volatility_max>.05||p.stop_atr<1||p.stop_atr>4||p.risk_fraction<=0||p.risk_fraction>.005||p.notional_fraction<=0||p.notional_fraction>.20||p.target_enabled!==false||p.signal_ttl!==5||p.quote_max_age!==2000)fail('S03_PARAMETERS_INVALID');
 if(typeof version!=='string'||!version.length||version.length>128||JSON.stringify(p)!==JSON.stringify(defaults)&&version===record.version)fail('S03_PARAMETER_VERSION_REQUIRED');
 return Object.freeze(p);
}

// Native rc3 Wilder starts at the first observation; shared Wilder uses an SMA
// seed. EMA(2*n-1) has alpha=1/n. Constant prefix padding only exposes the seed;
// it introduces no later observations and preserves the shared EMA arithmetic.
function seededEMA(values,length){
 if(!values.length)return [];
 const prefix=Array.from({length:length-1},(_,i)=>({...values[0],time:values[0].time-(length-1-i)*300}));
 const shared=exponentialAverage([...prefix,...values],length),alpha=2/(length+1);let value=values[0].close;
 return shared.map((point,i)=>{if(i)value=fusedMultiplyAdd(values[i].close,alpha,value*(1-alpha));return {...point,value};});
}
export function s03Indicators(bars,parameters=defaults){
 if(!bars.length)return [];
 const fast=seededEMA(bars,parameters.ema_fast),slow=seededEMA(bars,parameters.ema_slow);
 const tr=wilderSeries(bars,1).atr.map(item=>({time:item.time,close:item.value}));
 const atr=seededEMA(tr,2*parameters.atr_period-1),gains=[],losses=[];
 bars.forEach((bar,i)=>{const delta=i?bar.close-bars[i-1].close:0;gains.push({time:bar.time,close:Math.max(delta,0)});losses.push({time:bar.time,close:Math.max(-delta,0)});});
 const up=seededEMA(gains,2*parameters.rsi_period-1),down=seededEMA(losses,2*parameters.rsi_period-1);
 return bars.map((bar,i)=>({time:bar.time,closedAt:bar.time+300,close:bar.close,emaFast:fast[i].value,emaSlow:slow[i].value,atr:atr[i].value,rsi:down[i].value===0?100:100*(1-1/(1+up[i].value/down[i].value)),nativeReady:i+1>=Math.max(parameters.ema_fast,parameters.ema_slow,parameters.rsi_period,parameters.atr_period)}));
}

export function s03RiskProposal(signal,parameters=defaults){
 const stop=signal.close-parameters.stop_atr*signal.atr;
 return {mode:'paper_analysis',executionAuthority:'NONE',referenceMode:'offline_closed_bar',referencePrice:signal.close,stopUnrounded:stop,stopAtSignal:true,takeProfit:null,trailingStop:null,riskFraction:parameters.risk_fraction,notionalFraction:parameters.notional_fraction,dailyLossFraction:.02,maximumActivationSeconds:86400,newsHealthMaxAgeSeconds:120,quoteMaxAgeMilliseconds:parameters.quote_max_age,feeBuy:.001,feeSell:.001,feeCurrency:'quote',feeStatus:'SIM_ASSUMPTION',capMultiplier:1.002,stressExitMultiplier:.998,quantity:null,reservedQuote:null,requires:['fresh-ask-and-bid','account-and-pending-reservations','daily-loss-baseline-and-owner-locks','versioned-tick-step-quote-unit','quote-fees-and-rounding','news-health-and-risk-locks','authorization-and-execution-capability'],sizingFormula:'min(risk_budget/loss_per_unit, equity*notional_fraction/p_cap, available_quote/(p_cap*(1+fee_buy))); round down and recheck conservative split-fill fee bounds'};
}

export function s03EntryConditions(previous,current,p=defaults){
 return {trend:current.emaFast>current.emaSlow&&current.close>current.emaFast,cross:Boolean(previous&&previous.rsi<=p.rsi_cross&&current.rsi>p.rsi_cross&&current.rsi<=p.rsi_ceiling),volatility:current.atr>0&&current.atr/current.close>=p.volatility_min&&current.atr/current.close<=p.volatility_max};
}

function barValue(bar,now){
 if(!bar||!['time','open','high','low','close','volume'].every(key=>finite(bar[key]))||!Number.isSafeInteger(bar.time)||bar.time<0||bar.time%300||bar.volume<0||bar.low<=0||bar.low>Math.min(bar.open,bar.close)||bar.high<Math.max(bar.open,bar.close)||!finite(now))fail('S03_BAR_INVALID');
 if(bar.revision!==undefined&&(!Number.isSafeInteger(bar.revision)||bar.revision<0))fail('S03_BAR_INVALID');
 return {time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,revision:bar.revision??0};
}

export function createS03Strategy({parameters={},version=record.version,market='BTC/USDT'}={}){
 if(market!=='BTC/USDT')fail('S03_MARKET_UNSUPPORTED');
 const p=s03Parameters(parameters,version),warmup=Math.max(250,5*Math.max(p.ema_fast,p.ema_slow,p.rsi_period,p.atr_period));
 let bars=[],seen=new Map(),latestTime=null,dataVersion=1,last=null,candidate=null,intent=null,position=null,exitTarget=null,flatAt=null,failures=0,dataLock=null;
 const receipts=new Map(),decisions=[];
 const key=bar=>JSON.stringify(bar);
 const cooldownBoundary=()=>{const completed=flatAt===null?null:bars.filter(bar=>bar.time>=flatAt)[p.cooldown_full_bars-1];return completed?completed.time+300:null;};
 const snapshot=()=>copy({strategy:'S03',version,market,parameters:p,dataVersion,warmup,continuousBars:bars.length,ready:bars.length>=warmup&&!dataLock,indicator:last,candidate,intent,position,exitTarget,flatAt,cooldownRemaining:flatAt===null?0:Math.max(0,p.cooldown_full_bars-bars.filter(bar=>bar.time>=flatAt).length),momentumFailures:failures,dataLock,decisions,mode:'paper_analysis',executionAuthority:'NONE',nativeAccepted:false});
 function propose(branch,reasons,at){
  if(!position&&!intent)return null;
  const id=exitTarget?.id||`${version}:${position?.candidateId||intent.candidateId}:exit`;
  const allReasons=[...new Set([...(exitTarget?.reasons||[]),...reasons])],effectiveBranch=exitTarget?.branch==='C'?'C':branch;
  exitTarget={id,branch:effectiveBranch,reasons:allReasons,at:exitTarget?.at??at,action:effectiveBranch==='C'&&allReasons.some(reason=>['DATA_GAP','HISTORY_REVISION','ACCOUNT_UNKNOWN'].includes(reason))?'retain_protection_and_reconcile':'request_unique_exit_owner',executionAuthority:'NONE'};
  return copy(exitTarget);
 }
 function onBar(input,{now=Date.now()/1000}={}){
  const bar=barValue(input,now),closedAt=bar.time+300,previousExit=JSON.stringify(exitTarget);
  if(closedAt>now)return {accepted:false,reason:'BAR_NOT_CLOSED',state:snapshot()};
  const prior=seen.get(bar.time);
  if(prior){
   if(prior===key(bar))return {accepted:false,reason:'DUPLICATE_BAR',state:snapshot()};
   seen.set(bar.time,key(bar));dataVersion++;dataLock='HISTORY_REVISION';bars=[];last=null;failures=0;if(!intent)candidate=null;propose('C',['HISTORY_REVISION'],closedAt);
   return {accepted:false,reason:dataLock,state:snapshot()};
  }
  if(latestTime!==null&&bar.time<latestTime){seen.set(bar.time,key(bar));dataLock='OUT_OF_ORDER';propose('C',['ACCOUNT_UNKNOWN'],closedAt);return {accepted:false,reason:dataLock,state:snapshot()};}
  if(bars.length&&bar.time!==bars.at(-1).time+300){dataVersion++;dataLock='DATA_GAP';bars=[];failures=0;if(!intent)candidate=null;propose('C',['DATA_GAP'],closedAt);}
  seen.set(bar.time,key(bar));latestTime=bar.time;bars.push(bar);const values=s03Indicators(bars,p),previous=values.at(-2);last=values.at(-1);
  if(candidate&&!intent&&now>=candidate.expiresAt)candidate={...candidate,status:'expired'};
  let decision=exitTarget&&JSON.stringify(exitTarget)!==previousExit?copy(exitTarget):null;
  if(position&&closedAt>position.firstFillAt){
   const usable=bars.length>=warmup&&!dataLock,c=[];if(usable&&last.emaFast<=last.emaSlow)c.push('EMA_INVALID');
   // A post-fill close is available. Signal-bar high/low is never a fill or stop.
   if(last.close<=position.stop)c.push('STOP_CLOSE_BREACH');
   failures=usable&&last.rsi<p.rsi_fail?failures+1:0;
   const held=Math.max(0,Math.floor(closedAt/300)-Math.floor(position.firstFillAt/300));position.holdBoundaries=held;
   if(c.length)decision=propose('C',c,closedAt);
   else if(!dataLock&&(failures>=2||held>=p.hold_boundaries))decision=propose('B',[...(failures>=2?['RSI_FAILURE']:[]),...(held>=p.hold_boundaries?['HOLD_LIMIT']:[])],closedAt);
  }
  const openAfter=cooldownBoundary(),cooldown=flatAt!==null&&(openAfter===null||closedAt<=openAfter);
  const conditions={warmup:bars.length>=warmup,...s03EntryConditions(previous,last,p),cooldown:!cooldown,data:!dataLock,flat:!position&&!intent};
  if(!decision&&Object.values(conditions).every(Boolean)){
   const proposal=s03RiskProposal(last,p);
   if(proposal.stopUnrounded>0){
    candidate={id:`${version}:BTCUSDT:${closedAt}:upward-rsi-cross`,version,market,dataVersion,closedAt,expiresAt:closedAt+p.signal_ttl,signal:copy(last),riskProposal:proposal,status:now>=closedAt+p.signal_ttl?'expired':'awaiting_next_available_price',executionAuthority:'NONE',admission:'NOT_EVALUATED'};
    decision={branch:'A',type:'technical_candidate',candidate:copy(candidate),conditions};
   }
  }
  if(decision?.id&&JSON.stringify(exitTarget)===previousExit)decision=null;
  if(decision)decisions.push(copy(decision));return {accepted:true,decision,conditions,state:snapshot()};
 }
 function applyPaperReceipt(receipt){
  if(!receipt||typeof receipt.id!=='string'||!receipt.id||!finite(receipt.at)||receipt.at<0)fail('S03_RECEIPT_INVALID');
  const fingerprint=JSON.stringify(receipt),prior=receipts.get(receipt.id);
  if(prior){if(prior!==fingerprint)fail('S03_RECEIPT_CONFLICT');return {accepted:false,reason:'DUPLICATE_RECEIPT',state:snapshot()};}
  if(receipt.type==='submitted'){
   if(!candidate||intent||position||receipt.candidateId!==candidate.id||typeof receipt.intentId!=='string'||!receipt.intentId||receipt.at<candidate.closedAt||receipt.at>=candidate.expiresAt||!finite(receipt.stop)||receipt.stop<=0||receipt.stop>candidate.riskProposal.stopUnrounded||dataLock)fail('S03_INTENT_INVALID');
   intent={id:receipt.intentId,candidateId:candidate.id,submittedAt:receipt.at,stop:receipt.stop,status:'pending'};candidate={...candidate,status:'awaiting_paper_receipt'};
  }else if(receipt.type==='fill'){
   if(!candidate||!intent||receipt.intentId!==intent.id||receipt.candidateId!==candidate.id||!finite(receipt.quantity)||receipt.quantity<=0||!finite(receipt.price)||receipt.price<=0||receipt.at<intent.submittedAt||position&&receipt.at<position.firstFillAt)fail('S03_FILL_INVALID');
   position=position?{...position,quantity:position.quantity+receipt.quantity}:{candidateId:candidate.id,intentId:intent.id,firstFillAt:receipt.at,quantity:receipt.quantity,stop:intent.stop,stopSource:'paper-ledger-accepted-plan',holdBoundaries:0};
   if(receipt.price<=position.stop)propose('C',['FILL_AT_OR_BELOW_STOP'],receipt.at);
  }else if(receipt.type==='unfilled'){
   if(!intent||position||receipt.intentId!==intent.id||receipt.at<intent.submittedAt||receipt.confirmed!==true||receipt.ordersTerminal!==true)fail('S03_TERMINAL_RECEIPT_REQUIRED');intent=null;candidate=null;
  }else if(receipt.type==='flat'){
   if(!position||receipt.intentId!==position.intentId||receipt.confirmed!==true||receipt.ordersTerminal!==true||receipt.inventoryQty!==0||receipt.at<position.firstFillAt)fail('S03_CONFIRMED_FLAT_REQUIRED');
   flatAt=receipt.at;position=null;intent=null;candidate=null;exitTarget=null;failures=0;
  }else if(receipt.type==='unknown'){
   if(!intent||receipt.intentId!==intent.id||receipt.at<intent.submittedAt)fail('S03_INTENT_INVALID');intent={...intent,status:'unknown'};propose('C',['ACCOUNT_UNKNOWN'],receipt.at);
  }else if(receipt.type==='risk'){
   if(!['NATIVE_STOP_TRIGGERED','DAILY_LOSS','EMERGENCY_STOP','PROTECTION_FAILURE','NEWS_LOCK'].includes(receipt.reason))fail('S03_RISK_INVALID');
   dataLock=receipt.reason;if(receipt.reason!=='NEWS_LOCK')propose('C',[receipt.reason],receipt.at);
  }else fail('S03_RECEIPT_INVALID');
  receipts.set(receipt.id,fingerprint);return {accepted:true,state:snapshot()};
 }
 function restoreHistory(input,{now=Date.now()/1000,verified=false,reconciled=false}={}){
  if(verified!==true||reconciled!==true||!Array.isArray(input)||input.length<warmup)fail('S03_VERIFIED_HISTORY_REQUIRED');
  const next=input.map(bar=>barValue(bar,now));if(next.some((bar,i)=>bar.time+300>now||i&&bar.time!==next[i-1].time+300))fail('S03_CONTINUOUS_HISTORY_REQUIRED');
  if(dataLock&&!['DATA_GAP','HISTORY_REVISION','OUT_OF_ORDER'].includes(dataLock))fail('S03_RISK_LOCK_REQUIRES_OWNER');
  if(latestTime!==null&&next.at(-1).time<latestTime)fail('S03_STALE_HISTORY');
  bars=next;seen=new Map(next.map(bar=>[bar.time,key(bar)]));latestTime=next.at(-1).time;last=s03Indicators(bars,p).at(-1);dataVersion++;dataLock=null;failures=0;if(!intent)candidate=null;
  return snapshot();
 }
 return {onBar,applyPaperReceipt,restoreHistory,snapshot};
}
