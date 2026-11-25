import {ExecutionRecords,decimal} from './execution-records.mjs';
import {MARKETS} from './trading-demo.mjs';
import {gridChartLevels,CANDLE_PERIODS} from './trading-chart-data.mjs';
import {protectionConfig,protectionValid,newProtectionState,advanceProtection,protectionDecision} from './strategy-protection.mjs';

// Independent paper versions; frozen S01/S02 research baselines never enter this runtime.
export const BOT_SIM_VERSION='paper-bot-v1';
export const BOT_MARKETS=Object.freeze({...MARKETS});
export const BOT_ERRORS=Object.freeze({
 PLAN_INVALID:'模拟方案字段或版本无效。',STRATEGY_UNSUPPORTED:'请选择明确的 S01-SIM 或 S02-SIM 模拟版本，原研究版本不能运行。',
 MODE_UNSUPPORTED:'此模拟版本只支持批准完整方案后自动模拟。',ROUTE_UNSUPPORTED:'仅支持已选接入的 SIM-01 · DEMO · Binance 现货账户。',
 MARKET_UNSUPPORTED:'这个交易对尚未适配 BOT 纸面模拟。',PROTECTION_INVALID:'资金保护版本无效，或缺少保护所需的止损。',
 PARAMETERS_INVALID:'请检查网格或有限 DCA 参数的范围与价格关系。',BUDGET_EXCEEDED:'全部计划买入金额与买入手续费超过 BOT 分配额度。',
 COST_INFEASIBLE:'目标价差不足以覆盖买卖手续费，请调整策略参数。',
 REQUEST_REQUIRED:'需要本次已批准方案的请求编号。',REQUEST_CONFLICT:'这个请求编号已经绑定另一份方案或操作，请查看原请求。',
 CASH_OWNER_REQUIRED:'共享模拟资金账本尚未接入。',INSUFFICIENT_CASH:'共享可用模拟余额不足，未创建 BOT。',DEBIT_FAILED:'模拟资金预留未确认，未创建 BOT。',
 CREDIT_FAILED:'模拟现金返还未确认；资金仍保留在原 BOT，请明确重试。',RUN_NOT_FOUND:'原 BOT 实例不存在。',SCOPE_MISMATCH:'账户或接入已变化，请返回原 BOT 核对。',
 RUN_ENDED:'这个 BOT 已结束，保留持仓可单独退出，不能恢复新增买入。',RUN_BLOCKED:'原订单回执或资金状态尚未确认，请先查询原请求。',
 ACTION_UNSUPPORTED:'不支持这个 BOT 操作。',ORDER_NOT_FOUND:'原 BOT 订单不存在。',ORDER_NOT_UNKNOWN:'这笔订单无需回执恢复。',
 RECEIPT_REQUIRED:'需要原订单的明确模拟回执结果；查询不会重新下单。',PRICE_INVALID:'纸面价格必须是已支持交易对的有限正数。',
 REFERENCE_INVALID:'模拟参考价无效或与当前标的不匹配，请刷新行情后重新检查。',
 TIME_INVALID:'纸面时间步长必须是 0–3,600 秒的有限数。'
});
const FEE=.001,EPS=1e-9,QTY_EPS=1e-12;
export const MIN_ORDER_USDT=5;
const clone=value=>structuredClone(value);
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const object=value=>Boolean(value&&Object.getPrototypeOf(value)===Object.prototype);
const identity=value=>typeof value==='string'&&value.trim().length>0&&value.length<=160&&!/[\u0000-\u001f\u007f<>]/.test(value);
const open=order=>['submitted','partial','unknown'].includes(order.status);
const ended=run=>['stopped','failed'].includes(run.status);
const error=code=>({code,error:BOT_ERRORS[code]||code});
const jsonSafe=(value,seen=new Set())=>{
 if(value===undefined||value===null||['string','boolean'].includes(typeof value))return true;
 if(typeof value==='number')return Number.isFinite(value);
 if(typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)return false;
 seen.add(value);const valid=Object.values(value).every(item=>jsonSafe(item,seen));seen.delete(value);return valid;
};
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().filter(key=>item[key]!==undefined).map(key=>[key,item[key]])):item);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const round=value=>Number(decimal(value));
const atOrBelow=(value,limit)=>value<=limit+Math.max(1,value,limit)*1e-10;
const atOrAbove=(value,limit)=>value>=limit-Math.max(1,value,limit)*1e-10;

export const isBotSimulation=plan=>Boolean(plan&&['S01','S02'].includes(plan.strategy)&&plan.planVariant===plan.strategy+'-SIM');
export function botParameters(strategy,referencePrice=BOT_MARKETS['BTC/USDT']){
 if(!positive(referencePrice))throw Error('INVALID_PAPER_REFERENCE');
 if(['S01','S01-SIM'].includes(strategy))return {lower:Number((referencePrice*.96).toFixed(4)),upper:Number((referencePrice*1.04).toFixed(4)),count:4,spacing:'arithmetic',stopLossPrice:Number((referencePrice*.9).toFixed(4)),takeProfitPrice:Number((referencePrice*1.1).toFixed(4))};
 if(['S02','S02-SIM'].includes(strategy))return {deviationPct:2,sizeMultiplier:1.5,maxEntries:3,takeProfitPct:2,stopLossPct:8};
 return null;
}
export function botGridLevels(parameters){
 return gridChartLevels({...parameters,mode:parameters.spacing,referencePrice:parameters.lower}).map(level=>level.price);
}
// NaN means invalid sizing inputs; botPlanError checks the complete plan and route.
export function botRequiredCapital(plan){
 const p=plan?.botParameters,amount=plan?.amount;
 if(!isBotSimulation(plan)||!positive(amount)||amount<MIN_ORDER_USDT||amount>1000||!p)return NaN;
 if(plan.strategy==='S01')return Number.isInteger(p.count)&&p.count>=2&&p.count<=100?amount*p.count*(1+FEE):NaN;
 if(!Number.isInteger(p.maxEntries)||p.maxEntries<1||p.maxEntries>3||!positive(p.sizeMultiplier)||p.sizeMultiplier<1||p.sizeMultiplier>10)return NaN;
 return Array.from({length:p.maxEntries},(_,i)=>amount*p.sizeMultiplier**i*(1+FEE)).reduce((a,b)=>a+b,0);
}
export function liveBinanceSpotRoute(route,market=route?.market){
 return Boolean(route&&route.accountId==='BINANCE-SPOT'&&route.connectionId==='binance-spot'&&route.venueId==='binance'&&route.profileId==='cex-spot'&&!route.chainId&&(!route.market||!market||route.market===market));
}
export function liveWalletSpotRoute(route,market=route?.market){
 return Boolean(route&&route.connectionId==='wallet-bsc'&&/^0x[0-9a-f]{40}$/.test(route.accountId||'')&&route.venueId==='pancakeswap'&&route.profileId==='dex-spot'&&route.chainId==='56'&&(!route.market||!market||route.market===market));
}
function planIssue(plan,{allowLive=false}={}){
 if(!plan||!jsonSafe(plan)||!identity(plan.id)||!Number.isSafeInteger(plan.version)||plan.version<1||plan.riskVersion!==undefined&&(!Number.isSafeInteger(plan.riskVersion)||plan.riskVersion<1))return 'PLAN_INVALID';
 if(!isBotSimulation(plan))return 'STRATEGY_UNSUPPORTED';
 if(plan.mode!=='auto')return 'MODE_UNSUPPORTED';
 const route=plan.executionRoute,market=plan.market||route?.market;
 if(!route||!identity(route.connectionId)||!/^[\w][\w:.-]{0,79}$/.test(route.connectionId)||route.market&&route.market!==market)return 'ROUTE_UNSUPPORTED';
 const paper=route.accountId==='SIM-01'&&!route.chainId&&route.venueId==='binance'&&route.profileId==='cex-spot'&&!(plan.environment&&plan.environment!=='DEMO')&&!(route.environment&&route.environment!=='DEMO');
 const live=liveBinanceSpotRoute(route,market)&&!(plan.environment&&plan.environment!=='LIVE')&&!(route.environment&&route.environment!=='LIVE');
 const wallet=liveWalletSpotRoute(route,market)&&!(plan.environment&&plan.environment!=='LIVE')&&!(route.environment&&route.environment!=='LIVE');
 if(!paper&&!(allowLive&&(live||wallet)))return 'ROUTE_UNSUPPORTED';
 if(!Object.hasOwn(BOT_MARKETS,market))return 'MARKET_UNSUPPORTED';
 const reference=plan.simulationReference;
 if(reference!==undefined&&(!object(reference)||Object.keys(reference).length!==7||Object.keys(reference).some(key=>!['market','profileId','venueId','period','closedPrice','closedAt','asOf'].includes(key))||reference.market!==market||reference.profileId!==route.profileId||reference.venueId!==route.venueId||!Object.hasOwn(CANDLE_PERIODS,reference.period)||!positive(reference.closedPrice)||!Number.isFinite(reference.closedAt)||!Number.isFinite(reference.asOf)||reference.closedAt>reference.asOf))return 'REFERENCE_INVALID';
 if(!positive(plan.amount)||plan.amount<MIN_ORDER_USDT||plan.amount>1000||!positive(plan.cap)||plan.cap>3000||plan.cap<plan.amount)return 'BUDGET_EXCEEDED';
 if(!protectionValid(plan.protection))return 'PROTECTION_INVALID';
 const p=plan.botParameters;
 if(!p||!jsonSafe(p)||p.triggerPrice!==undefined&&!positive(p.triggerPrice))return 'PARAMETERS_INVALID';
 if(plan.simulationScenario!==undefined&&!['normal','unknown','partial-unknown','rejected','exit-rejected'].includes(plan.simulationScenario))return 'PARAMETERS_INVALID';
 if(plan.strategy==='S01'){
  if(![p.lower,p.upper].every(positive)||p.upper<=p.lower||!Number.isInteger(p.count)||p.count<2||p.count>100||!['arithmetic','geometric'].includes(p.spacing)||p.stopLossPrice!==undefined&&(!positive(p.stopLossPrice)||p.stopLossPrice>=p.lower)||p.takeProfitPrice!==undefined&&(!positive(p.takeProfitPrice)||p.takeProfitPrice<=p.upper)||p.triggerPrice!==undefined&&(p.triggerPrice<p.lower||p.triggerPrice>p.upper))return 'PARAMETERS_INVALID';
  if(plan.protection?.id==='astarter'&&!positive(p.stopLossPrice))return 'PROTECTION_INVALID';
 }else{
  if(!positive(p.deviationPct)||p.deviationPct>=100||!positive(p.sizeMultiplier)||p.sizeMultiplier<1||p.sizeMultiplier>10||!Number.isInteger(p.maxEntries)||p.maxEntries<1||p.maxEntries>3||!positive(p.takeProfitPct)||p.takeProfitPct>1000||!positive(p.stopLossPct)||p.stopLossPct>=100)return 'PARAMETERS_INVALID';
 }
 return botRequiredCapital(plan)>plan.cap+EPS?'BUDGET_EXCEEDED':null;
}
function entryCostIssue(plan){
 if(plan.strategy==='S02'){
  const sell=1+plan.botParameters.takeProfitPct/100;
  return sell*(1-FEE)>1+FEE+sell*Number.EPSILON*8?null:'COST_INFEASIBLE';
 }
 if(plan.strategy!=='S01')return null;
 const levels=botGridLevels(plan.botParameters);
 return levels.some((sell,i)=>i>0&&!(sell*(1-FEE)>levels[i-1]*(1+FEE)+Math.max(sell,levels[i-1])*Number.EPSILON*8))?'COST_INFEASIBLE':null;
}
export function botPlanError(plan,priorRequest){
 const issue=planIssue(plan);if(issue)return BOT_ERRORS[issue];
 if(priorRequest)return canonical(frozenPlan(plan))===priorRequest.payload?null:BOT_ERRORS.REQUEST_CONFLICT;
 const costIssue=entryCostIssue(plan);return costIssue?BOT_ERRORS[costIssue]:null;
}
export function editorPlanError(plan,priorRequest){
 const issue=planIssue(plan,{allowLive:true});if(issue)return BOT_ERRORS[issue];
 if(priorRequest)return canonical(frozenPlan(plan))===priorRequest.payload?null:BOT_ERRORS.REQUEST_CONFLICT;
 const costIssue=entryCostIssue(plan);return costIssue?BOT_ERRORS[costIssue]:null;
}
function frozenPlan(plan){
 const route=plan.executionRoute,market=plan.market||route.market;
 return freeze(clone({id:plan.id,version:plan.version,riskVersion:plan.riskVersion,strategy:plan.strategy,planVariant:plan.planVariant,environment:'DEMO',market,executionRoute:{...route,market,chainId:route.chainId||''},amount:plan.amount,cap:plan.cap,mode:plan.mode,protection:plan.protection||protectionConfig('original'),botParameters:plan.botParameters,simulationScenario:plan.simulationScenario||'normal',...(plan.simulationReference===undefined?{}:{simulationReference:plan.simulationReference})}));
}
const fresh=()=>({schema:1,version:BOT_SIM_VERSION,time:0,seq:0,revision:0,runs:[],requests:[],actions:[],history:[],flow:null});

export class BotBook{
 constructor({state,debit,credit,canBuy}={}){
  this.debit=debit;this.credit=credit;this.canBuy=canBuy;this.s=fresh();this.records=new ExecutionRecords();this.s.flow=this.records.data;
  if(state!==undefined&&!this.restore(state))throw Error('BOT_STATE_INVALID');
 }
 get flow(){return this.records.data;}
 snapshot(){return clone({...this.s,flow:this.flow});}
 summary(){
  const total={allocated:0,equity:0,cash:0,inventoryValue:0,fees:0,realizedPnl:0,unrealizedPnl:0,activeCount:0,historyCount:0};
  for(const run of this.s.runs){const metrics=this._metrics(run);for(const key of ['allocated','fees','realizedPnl'])total[key]+=run[key];for(const key of ['equity','inventoryValue','unrealizedPnl'])total[key]+=metrics[key];total.cash+=run.cash;total[ended(run)?'historyCount':'activeCount']++;}
  return total;
 }
 create(plan,{requestId,at=this.s.time}={}){
  const issue=planIssue(plan);if(issue)return error(issue);
  if(!identity(requestId))return error('REQUEST_REQUIRED');
  if(typeof at!=='number'||!Number.isFinite(at)||at<0)return error('PLAN_INVALID');
  const approved=frozenPlan(plan),payload=canonical(approved),old=this.s.requests.find(row=>row.requestId===requestId);
  if(old)return old.payload===payload?{run:clone(this._run(old.runId)),duplicate:true}:error('REQUEST_CONFLICT');
  if(this.s.actions.some(row=>row.requestId===requestId))return error('REQUEST_CONFLICT');
  // New-entry costs must not prevent restoring or querying an existing financial book.
  const costIssue=entryCostIssue(approved);if(costIssue)return error(costIssue);
  if(typeof this.debit!=='function'||typeof this.credit!=='function'||this.debit.constructor.name==='AsyncFunction'||this.credit.constructor.name==='AsyncFunction')return error('CASH_OWNER_REQUIRED');
  try{const result=this.debit(approved.cap,clone(approved.executionRoute));if(result===false)return error('INSUFFICIENT_CASH');if(result&&typeof result.then==='function')return error('DEBIT_FAILED');}catch{return error('DEBIT_FAILED');}
  const id=this._id('BOT'),reference=approved.simulationReference?.closedPrice??BOT_MARKETS[approved.market],run={id,requestId,tradeOwner:'STRATEGY_AGENT',recordedAt:Date.now(),plan:approved,simVersion:BOT_SIM_VERSION,environment:'DEMO',status:approved.botParameters.triggerPrice!==undefined?'waiting':'running',createdAt:at,...(approved.simulationReference?{simulationStartedAt:this.s.time}:{}),updatedAt:this.s.time,startedAt:null,endedAt:null,endIntent:null,endReason:null,cash:approved.cap,initialAllocation:approved.cap,allocated:approved.cap,returned:0,fees:0,realizedPnl:0,markPrice:reference,priceSource:'SYNTHETIC_PAPER_CLOCK',clockKind:'synthetic',triggerDirection:(approved.botParameters.triggerPrice??reference)<reference?'below':'above',anchorPrice:null,entries:0,slots:[],lots:[],orders:[],events:[],protectionState:newProtectionState(approved.cap),protectionDecision:null};
  this.s.runs.push(run);this.s.requests.push({requestId,payload,runId:id,at});
  this.flow.reservations.push({id:'ALLOC-'+id,revision:1,kind:'BOT_ALLOCATION',instanceId:id,accountId:'SIM-01',unit:'USDT',amount:decimal(approved.cap),state:'HELD',releaseEvidenceId:null});
  this.records.cost({sourceId:'BOT-ALLOCATION-'+id,accountId:'SIM-01',amount:approved.cap,type:'BOT_ALLOCATION',at:this.s.time});
  this._event(run,'created',run.status==='waiting'?'等待纸面触发价；额度已分配。':'批准方案已冻结；仅使用独立纸面价格钟。');this._changed();return {run:clone(run)};
 }
 tick(dt,prices){
  if(typeof dt!=='number'||!Number.isFinite(dt)||dt<0||dt>3600)return error('TIME_INVALID');
  if(prices!==undefined&&(!prices||typeof prices!=='object'||Array.isArray(prices)||Object.entries(prices).some(([market,price])=>!Object.hasOwn(BOT_MARKETS,market)||!positive(price))))return error('PRICE_INVALID');
  this.s.time+=dt;
  for(const run of this.s.runs){
   const supplied=prices&&Object.hasOwn(prices,run.plan.market),reference=run.plan.simulationReference,base=reference?.closedPrice??BOT_MARKETS[run.plan.market];
   // Existing runs keep their original global paper clock.
   const elapsed=reference?this.s.time-run.simulationStartedAt:this.s.time;
   run.markPrice=supplied?prices[run.plan.market]:base*(1+.045*Math.sin(elapsed/12)+.015*Math.sin(elapsed/5));run.priceSource=supplied?'INJECTED_PAPER_PRICE':'SYNTHETIC_PAPER_CLOCK';
  }
  for(const run of this.s.runs){if(!ended(run)&&!['interrupted','blocked'].includes(run.status))this._advance(run);this._sync(run);}
  this._changed();return this.summary();
 }
 action(runId,kind,options={}){
  const run=this._run(runId);if(!run)return error('RUN_NOT_FOUND');
  if(!object(options)||!jsonSafe(options))return error('PLAN_INVALID');
  const route=run.plan.executionRoute;
  if(options.expectedAccountId!==undefined&&options.expectedAccountId!==route.accountId||options.expectedConnectionId!==undefined&&options.expectedConnectionId!==route.connectionId||options.expectedEnvironment!==undefined&&options.expectedEnvironment!=='DEMO')return error('SCOPE_MISMATCH');
  if(!identity(options.requestId))return error('REQUEST_REQUIRED');
  const payload=canonical({...options,runId,kind}),old=this.s.actions.find(row=>row.requestId===options.requestId);
  if(old){if(old.payload!==payload)return error('REQUEST_CONFLICT');return {...(old.code?error(old.code):{}),run:clone(run),duplicate:true};}
  if(this.s.requests.some(row=>row.requestId===options.requestId))return error('REQUEST_CONFLICT');
  let result={},code;
  if(kind==='query'){
   const order=run.orders.find(row=>row.id===options.orderId)||(!options.orderId?run.orders.find(row=>row.status==='unknown'):null);
   if(!order)code='ORDER_NOT_FOUND';else result.operation=this.records.query(order.operationId,this.s.time);
  }else if(kind==='reconcile'){
   const order=run.orders.find(row=>row.id===options.orderId);
   if(!order)code='ORDER_NOT_FOUND';else if(order.status!=='unknown')code='ORDER_NOT_UNKNOWN';else if(!['filled','cancelled','rejected','accepted'].includes(options.outcome))code='RECEIPT_REQUIRED';
   else{
    this.records.venueReceipt(order,this.s.time);const receipt=this.flow.venueReceipts.find(row=>row.operationId===order.operationId);receipt.state=options.outcome.toUpperCase();receipt.source='PAPER_RECEIPT';
    if(options.outcome==='filled'){this._fill(run,order,1);this._terminal(order,'filled');}
    else if(['cancelled','rejected'].includes(options.outcome))this._terminal(order,options.outcome==='cancelled'?(order.filled?'partial-cancelled':'cancelled'):'rejected');
    else{order.status=order.filled?'partial':'submitted';order.scenario='normal';order.eligibleAt=this.s.time;this.records.orderState(order,'RUNNING');}
    run.status='paused';this._event(run,'reconciled','已核对原模拟订单；没有重新提交。');if(run.endIntent)code=this._finishEnd(run);
   }
  }else if(kind==='pause'){
   if(ended(run)||run.endIntent)code='RUN_ENDED';else if(run.status==='blocked')code='RUN_BLOCKED';else{run.resumeStatus=run.status==='waiting'?'waiting':'running';run.status='paused';this._event(run,'paused','暂停新买入；原订单与已有库存保留。');}
  }else if(kind==='resume'){
   if(ended(run))code='RUN_ENDED';else if(run.orders.some(order=>order.status==='unknown'))code='RUN_BLOCKED';else if(run.endIntent){if(run.endIntent==='keep')code='RUN_ENDED';else{run.status='stopping';code=this._finishEnd(run);}}
   else if(run.protectionState.locked)code='RUN_BLOCKED';else{run.status=run.startedAt===null&&run.plan.botParameters.triggerPrice!==undefined?'waiting':'running';run.pauseReason=null;this._event(run,'resumed','明确恢复原实例和原订单，没有重建批准方案。');}
  }else if(['stop-close','stop-keep','close-position'].includes(kind)){
   if(kind==='close-position'&&this._quantity(run)<=EPS){if(ended(run))result.alreadyClosed=true;else code='RUN_ENDED';}
   else if(ended(run)&&kind!=='close-position')result.alreadyEnded=true;
   else code=this._beginEnd(run,kind==='stop-keep'?'keep':'close',kind==='close-position'?'manual-exit':kind==='stop-keep'?'user-keep':'user-close');
  }else if(kind==='cancel'){
   const order=run.orders.find(row=>row.id===options.orderId);
   if(!order)code='ORDER_NOT_FOUND';else if(order.status==='unknown')code='RUN_BLOCKED';else{if(open(order))this._cancel(order);if(!ended(run)&&!run.endIntent)run.status='paused';this._event(run,'cancelled','仅撤销原订单未成交部分，已有库存仍归原 BOT。');}
  }else code='ACTION_UNSUPPORTED';
  this.s.actions.push({requestId:options.requestId,payload,runId,kind,...(code?{code}:{}),at:this.s.time});this._sync(run);this._changed();return {...result,...(code?error(code):{}),run:clone(run)};
 }
 interrupt(reason='refresh-interrupted'){
  for(const run of this.s.runs)if(!ended(run)&&run.status!=='interrupted'){
   run.resumeStatus=run.status;run.status='interrupted';this._event(run,'interrupted',reason);this._sync(run);
  }
  this._changed();return this.snapshot();
 }
 restore(state){
  if(!state||state.schema!==1||state.version!==BOT_SIM_VERSION||!jsonSafe(state)||!Number.isSafeInteger(state.seq)||state.seq<0||!Number.isFinite(state.time)||state.time<0||!Array.isArray(state.runs)||!Array.isArray(state.requests)||!Array.isArray(state.actions)||!Array.isArray(state.history)||state.flow?.schema!==1)return false;
  if(!['signals','plans','admissions','commands','operations','fills','ledger','reservations','protections','sourceEvents','venueReceipts'].every(key=>Array.isArray(state.flow[key])))return false;
  if(![state.runs,state.requests,state.actions,state.history,...Object.entries(state.flow).filter(([key,value])=>key!=='sourceEvents'&&Array.isArray(value)).map(([,value])=>value)].every(rows=>rows.every(object)))return false;
  const ids=new Set(),orderIds=new Set();
  for(const run of state.runs){
   if(!identity(run.id)||ids.has(run.id)||run.environment!=='DEMO'||run.simVersion!==BOT_SIM_VERSION||planIssue(run.plan)||!['waiting','running','paused','interrupted','blocked','stopping','stopped','failed'].includes(run.status)||!['cash','allocated','initialAllocation','returned','fees','markPrice'].every(key=>Number.isFinite(run[key])&&run[key]>=0)||!Number.isFinite(run.realizedPnl)||run.allocated>run.initialAllocation+EPS||![run.orders,run.lots,run.slots,run.events].every(rows=>Array.isArray(rows)&&rows.every(object))||!object(run.protectionState))return false;
   if(run.plan.simulationReference?(!Number.isFinite(run.simulationStartedAt)||run.simulationStartedAt<0||run.simulationStartedAt>state.time||run.events.find(event=>event.kind==='created')?.at!==run.simulationStartedAt):run.simulationStartedAt!==undefined)return false;
   ids.add(run.id);
   if(run.orders.some(order=>order.runId!==run.id||order.accountId!=='SIM-01'||!positive(order.price)||!positive(order.qty)||!Number.isFinite(order.filled)||order.filled<0||order.filled>1)||run.lots.some(lot=>!Number.isFinite(lot.qty)||lot.qty<0||!Number.isFinite(lot.costBasis)||lot.costBasis<0))return false;
   const basis=run.lots.reduce((n,lot)=>n+lot.costBasis,0);
   if(run.initialAllocation!==run.plan.cap||Math.abs(run.cash+run.returned+basis-run.realizedPnl-run.initialAllocation)>1e-6||run.lots.some(lot=>lot.runId!==run.id||!run.orders.some(order=>order.id===lot.orderId&&order.side==='buy'))||ended(run)&&run.orders.some(open))return false;
   for(const order of run.orders){
    if(!identity(order.id)||orderIds.has(order.id)||!['buy','sell'].includes(order.side)||order.environment!=='DEMO'||order.market!==run.plan.market||order.connectionId!==run.plan.executionRoute.connectionId||order.side==='sell'&&(!Array.isArray(order.lotIds)||order.lotIds.some(id=>!run.lots.some(lot=>lot.id===id))))return false;
    if(!state.flow.operations.some(row=>row.id===order.operationId&&row.orderId===order.id)||!state.flow.commands.some(row=>row.id===order.commandId&&row.planId===order.planId)||!state.flow.plans.some(row=>row.id===order.planId&&row.instanceId===run.id)||!state.flow.admissions.some(row=>row.id===order.admissionId&&row.planId===order.planId))return false;
    const filled=state.flow.fills.filter(row=>row.orderId===order.id).reduce((n,row)=>n+Number(row.quantity),0);if(!Number.isFinite(filled)||Math.abs(filled-order.qty*order.filled)>1e-9)return false;
    orderIds.add(order.id);
   }
  }
  const generated=[...state.runs,...Object.values(state.flow).filter(Array.isArray).flat()].map(row=>Number(row?.id?.match(/-(\d{6,})$/)?.[1]||0));
  if(state.seq<Math.max(0,...generated)||state.flow.reservations.some(row=>!Number.isFinite(Number(row.amount))||Number(row.amount)<0)||state.flow.ledger.some(row=>!Number.isFinite(Number(row.amount))))return false;
  if(Math.abs(state.runs.reduce((n,run)=>n+run.cash,0)-state.flow.ledger.reduce((n,row)=>n+Number(row.amount),0))>1e-6||Math.abs(state.runs.reduce((n,run)=>n+run.fees,0)+state.flow.ledger.filter(row=>row.type==='FEE').reduce((n,row)=>n+Number(row.amount),0))>1e-6)return false;
  if(state.requests.length!==state.runs.length||state.requests.some(row=>!identity(row.requestId)||!ids.has(row.runId)||row.payload!==canonical(state.runs.find(run=>run.id===row.runId).plan))||new Set([...state.requests,...state.actions].map(row=>row.requestId)).size!==state.requests.length+state.actions.length||state.actions.some(row=>!identity(row.requestId)||!ids.has(row.runId)))return false;
  if(state.history.length!==state.runs.length||state.runs.some(run=>!state.requests.some(row=>row.runId===run.id&&row.requestId===run.requestId)||!state.history.some(row=>row.runId===run.id&&canonical(row.plan)===canonical(run.plan))))return false;
  const next=clone(state);for(const run of next.runs)run.plan=freeze(run.plan);
  this.s=next;this.records=new ExecutionRecords(next.flow);this.s.flow=this.flow;this.interrupt();return true;
 }
 _run(id){return this.s.runs.find(run=>run.id===id);}
 _id(prefix){return `${prefix}-${String(++this.s.seq).padStart(6,'0')}`;}
 _changed(){this.s.revision++;}
 _quantity(run){return run.lots.reduce((n,lot)=>n+lot.qty,0);}
 _metrics(run){
  const quantity=this._quantity(run),costBasis=run.lots.reduce((n,lot)=>n+lot.costBasis,0),inventoryValue=quantity*run.markPrice;
  return {quantity,costBasis,inventoryValue,equity:run.cash+inventoryValue,unrealizedPnl:inventoryValue-costBasis};
 }
 _available(run){const ids=new Set(run.orders.map(order=>order.id));return Math.max(0,run.cash-this.flow.reservations.filter(row=>ids.has(row.orderId)&&row.state==='HELD'&&row.unit==='USDT').reduce((n,row)=>n+Number(row.amount),0));}
 _event(run,kind,reason){run.events.push({at:this.s.time,kind,reason});this._sync(run);}
 _sync(run){
  Object.assign(run,this._metrics(run),{updatedAt:this.s.time,freeCash:this._available(run)});
  let row=this.s.history.find(row=>row.runId===run.id);if(!row){row={runId:run.id,plan:run.plan,requestId:run.requestId,createdAt:run.createdAt};this.s.history.push(row);}
  Object.assign(row,{status:run.status,startedAt:run.startedAt,endedAt:run.endedAt,endReason:run.endReason,allocated:run.allocated,equity:run.equity,fees:run.fees,realizedPnl:run.realizedPnl,unrealizedPnl:run.unrealizedPnl,returned:run.returned,events:clone(run.events)});
 }
 _advance(run){
  const p=run.plan.botParameters;
  if(run.status==='waiting'){
   const hit=run.triggerDirection==='below'?atOrBelow(run.markPrice,p.triggerPrice):atOrAbove(run.markPrice,p.triggerPrice);
   if(!hit)return;run.status='running';this._event(run,'triggered','已命中独立纸面触发价。');
  }
  if(run.startedAt===null&&run.status==='running'){
   run.startedAt=this.s.time;run.anchorPrice=run.markPrice;
   if(run.plan.strategy==='S01'){const levels=botGridLevels(p);run.slots=levels.slice(0,-1).map((price,i)=>({id:`${run.id}-GRID-${i}`,buyPrice:price,sellPrice:levels[i+1],armed:atOrAbove(run.markPrice,price),lotId:null,orderId:null}));}
  }
  for(const order of run.orders.filter(open))this._process(run,order);
  if(run.status==='blocked')return;
  if(run.endIntent){this._finishEnd(run);return;}
  if(run.startedAt===null)return;
  if(this._quantity(run)>QTY_EPS){
   const stop=run.plan.strategy==='S01'?p.stopLossPrice:run.anchorPrice*(1-p.stopLossPct/100),take=run.plan.strategy==='S01'?p.takeProfitPrice:this._average(run)*(1+p.takeProfitPct/100);
   if(stop!==undefined&&atOrBelow(run.markPrice,stop)){this._beginEnd(run,'close','stop-loss');return;}
   if(take!==undefined&&atOrAbove(run.markPrice,take)){this._beginEnd(run,'close','take-profit');return;}
  }
  if(run.plan.protection.id==='astarter'){
   run.protectionState=advanceProtection(run.protectionState,{policy:run.plan.protection,equity:this._metrics(run).equity,day:Math.floor(this.s.time/86400)});
   if(run.protectionState.locked&&run.status==='running'){run.status='paused';this._event(run,'risk-paused','BOT 分配额度的资金保护已暂停新增买入。');}
  }
  if(run.plan.strategy==='S01')this._grid(run);else if(run.status==='running')this._dca(run);
 }
 _average(run){const qty=this._quantity(run);return qty?run.lots.reduce((n,lot)=>n+lot.qty*lot.buyPrice,0)/qty:0;}
 _grid(run){
  for(const slot of run.slots){
   if(run.status==='blocked')break;
   const order=run.orders.find(order=>order.id===slot.orderId);if(order&&open(order))continue;
   const lot=run.lots.find(lot=>lot.id===slot.lotId);
   if(lot?.qty>QTY_EPS){this._submit(run,'sell',slot.sellPrice,lot.qty,{slotId:slot.id,lotIds:[lot.id],intent:'grid-sell'});continue;}
   slot.lotId=null;if(atOrAbove(run.markPrice,slot.buyPrice))slot.armed=true;
   if(run.status==='running'&&slot.armed)this._buy(run,slot.buyPrice,run.plan.amount,{slotId:slot.id});
  }
 }
 _dca(run){
  if(run.orders.some(open))return;
  const p=run.plan.botParameters;if(run.entries>=p.maxEntries)return;
  const price=run.anchorPrice*(1-p.deviationPct/100)**run.entries;
  if(run.entries!==0&&!atOrBelow(run.markPrice,price))return;
  const costIssue=entryCostIssue(run.plan);
  if(costIssue){run.status='paused';run.pauseReason=BOT_ERRORS[costIssue];this._event(run,'risk-paused',run.pauseReason);return;}
  this._buy(run,price,run.plan.amount*p.sizeMultiplier**run.entries,{entry:run.entries});
 }
 _buy(run,price,requested,details){
  const costIssue=entryCostIssue(run.plan);
  if(costIssue){run.status='paused';run.pauseReason=BOT_ERRORS[costIssue];this._event(run,'risk-paused',run.pauseReason);return null;}
  const costBasis=this._metrics(run).costBasis,pending=run.orders.filter(order=>open(order)&&order.side==='buy').reduce((n,order)=>n+order.qty*(1-order.filled)*order.price*(1+FEE),0);
  let amount=Math.min(requested,this._available(run)/(1+FEE),Math.max(0,run.plan.cap-costBasis-pending)/(1+FEE));
  if(run.plan.protection.id==='astarter'){
   const p=run.plan.botParameters,stop=run.plan.strategy==='S01'?p.stopLossPrice:run.anchorPrice*(1-p.stopLossPct/100),stopFraction=(price-stop)/price;
   const decision=protectionDecision({policy:run.plan.protection,state:run.protectionState,equity:this._metrics(run).equity,requested:amount,cap:run.plan.cap,cash:this._available(run),stopFraction});
   const inventoryRisk=run.lots.reduce((n,lot)=>n+Math.max(0,lot.costBasis-lot.qty*stop*(1-FEE)),0),pendingRisk=run.orders.filter(order=>open(order)&&order.side==='buy').reduce((n,order)=>n+order.qty*(1-order.filled)*Math.max(0,order.price*(1+FEE)-stop*(1-FEE)),0),remainingRisk=Math.max(0,decision.risk-inventoryRisk-pendingRisk);
   amount=Math.floor(Math.max(0,Math.min(decision.amount,remainingRisk/(stopFraction+.002)))*100)/100;
   run.protectionDecision={...decision,amount,inventoryRisk,pendingRisk,remainingRisk,scope:'BOT_ALLOCATION'};
  }
  if(amount<MIN_ORDER_USDT-EPS)return null;
  if(this.canBuy!==undefined){
   let permitted;try{const current=clone({...run,...this._metrics(run),freeCash:this._available(run)});current.plan=freeze(current.plan);permitted=typeof this.canBuy==='function'&&this.canBuy.constructor.name!=='AsyncFunction'?this.canBuy(current):false;}catch{permitted=false;}
   if(permitted!==true&&permitted!==undefined&&permitted!==null){run.status='paused';run.pauseReason=typeof permitted==='string'&&permitted.trim()?permitted.slice(0,500):'共享账户买入检查未确认，已暂停新增。';this._event(run,'risk-paused',run.pauseReason);return null;}
  }
  return this._submit(run,'buy',price,Math.floor(amount/price*1e12)/1e12,{...details,intent:'open'});
 }
 _submit(run,side,price,qty,details={}){
  if(!positive(qty))return null;
  if(side==='sell'&&details.lotIds.reduce((n,id)=>n+(run.lots.find(lot=>lot.id===id)?.qty||0),0)+EPS<qty)return null;
  const signal={id:this._id('BOT-SIG'),side,intent:side==='sell'?'close':'open'},session={id:run.id,market:run.plan.market,strategy:run.plan.planVariant,strategyVersion:BOT_SIM_VERSION,price,amount:run.plan.amount,cap:run.plan.cap,accountId:'SIM-01',environment:'DEMO',authorizationId:run.requestId,executionKind:'BOT',tradeOwner:run.tradeOwner||'STRATEGY_AGENT',planRef:{id:run.plan.id,version:run.plan.version}};
  const {plan,admission}=this.records.prepare(signal,session,qty,'normal',this.s.time),scenario=run.plan.simulationScenario==='exit-rejected'&&side==='sell'&&!run.orders.some(order=>order.side==='sell'&&order.status==='rejected')?'rejected':run.orders.length===0&&run.plan.simulationScenario!=='exit-rejected'?run.plan.simulationScenario:'normal';
  const order={id:this._id('BOT-ORD'),runId:run.id,market:run.plan.market,side,price,qty,filled:0,fee:0,feeRate:FEE,at:this.s.time,eligibleAt:null,status:'submitted',scenario,marketType:'SPOT',venueId:'binance',profileId:'cex-spot',currency:'USDT',connectionId:run.plan.executionRoute.connectionId,priceSource:run.priceSource,...details};
  this.records.submitted(order,plan,admission,this.s.time);run.orders.push(order);
  if(details.slotId){const slot=run.slots.find(slot=>slot.id===details.slotId);slot.orderId=order.id;}
  if(side==='buy'&&run.plan.strategy==='S02')run.entries++;
  if(scenario==='rejected'){
   this._terminal(order,'rejected');run.endReason=side==='sell'?'exit-rejected':'entry-rejected';run.status=side==='sell'||this._quantity(run)>EPS?'blocked':'failed';
   this._event(run,'failed',run.endReason);if(run.status==='failed'){run.endedAt=this.s.time;this._release(run);}
  }else if(!['unknown','partial-unknown'].includes(scenario))this.records.venueReceipt(order,this.s.time);
  return order;
 }
 _process(run,order){
  if(order.status==='unknown')return;
  const eligible=order.intent==='close'||(order.side==='buy'?atOrBelow(run.markPrice,order.price):atOrAbove(run.markPrice,order.price));
  if(!eligible)return;if(order.eligibleAt===null)order.eligibleAt=this.s.time;
  const age=this.s.time-order.eligibleAt;
  if(order.scenario==='unknown'&&age>=1.2-EPS||order.scenario==='partial-unknown'&&age>=2.5-EPS){order.status='unknown';run.status='blocked';this.records.orderState(order,'UNKNOWN');this._event(run,'unknown','原模拟订单回执未知，保留原请求、库存与资金预留。');return;}
  if(age>=1.2-EPS&&order.filled<.5)this._fill(run,order,.5);
  if(age>=2.5-EPS){this._fill(run,order,1);this._terminal(order,'filled');}
 }
 _fill(run,order,ratio){
  const wanted=order.qty*(ratio-order.filled);
  if(wanted<=0)return;
  const lots=order.side==='sell'?order.lotIds.map(id=>run.lots.find(lot=>lot.id===id)).filter(Boolean):[];
  if(order.side==='sell'&&lots.reduce((n,lot)=>n+lot.qty,0)+EPS<wanted)throw Error('BOT_INVENTORY_INVARIANT');
  if(order.side==='buy'&&run.cash+EPS<wanted*order.price*(1+FEE))throw Error('BOT_CASH_INVARIANT');
  const receipt=this.records.recordFill(order,ratio,this.s.time);if(!receipt)return;
  const {qty,notional,fill}=receipt,fee=notional*FEE;order.filled=ratio;order.fee+=fee;order.status=ratio===1?'filled':'partial';run.fees+=fee;
  this.records.cost({sourceId:'BOT-FEE-'+fill.id,fillId:fill.id,orderId:order.id,accountId:'SIM-01',amount:-fee,at:this.s.time});
  if(order.side==='buy'){
   run.cash-=notional+fee;let lot=run.lots.find(lot=>lot.id==='LOT-'+order.id);
   if(!lot){lot={id:'LOT-'+order.id,runId:run.id,orderId:order.id,slotId:order.slotId||null,qty:0,costBasis:0,buyPrice:order.price};run.lots.push(lot);}
   lot.qty+=qty;lot.costBasis+=notional+fee;
   if(order.slotId)run.slots.find(slot=>slot.id===order.slotId).lotId=lot.id;
  }else{
   let remaining=qty,cost=0,principal=0;for(const lot of lots){const part=Math.min(remaining,lot.qty);if(part<=0)continue;const basis=lot.costBasis*part/lot.qty;cost+=basis;principal+=part*lot.buyPrice;lot.qty-=part;lot.costBasis-=basis;remaining-=part;if(lot.qty<QTY_EPS){lot.qty=0;lot.costBasis=0;}}
   run.cash+=notional-fee;run.realizedPnl+=notional-fee-cost;
   // Persist the already settled lot result; statements never reconstruct old cost bases.
   Object.assign(fill,{realizedPnlGross:decimal(notional-principal),realizedPnlNet:decimal(notional-fee-cost),settledCostBasis:decimal(cost)});
  }
  if(Math.abs(run.cash)<EPS)run.cash=0;this.records.reservation(order,ratio===1);this._sync(run);
 }
 _terminal(order,status){order.status=status;this.records.orderState(order,status==='filled'?'SUCCEEDED':status==='rejected'?'FAILED':'CANCELLED');this.records.reservation(order,true);}
 _cancel(order){this._terminal(order,order.filled?'partial-cancelled':'cancelled');}
 _beginEnd(run,intent,reason){
  run.endIntent=intent;run.endReason=reason;run.status='stopping';this._event(run,'ending',reason);
  return this._finishEnd(run);
 }
 _finishEnd(run){
  if(run.orders.some(order=>order.status==='unknown')){run.status='blocked';return;}
  const closing=run.orders.find(order=>open(order)&&order.intent==='close');
  for(const order of run.orders.filter(order=>open(order)&&order!==closing))this._cancel(order);
  if(run.endIntent==='keep'){
   if(closing)this._cancel(closing);
   const code=this._release(run);if(code)return code;run.status='stopped';run.endedAt=this.s.time;this._event(run,'ended',run.endReason);return;
  }
  if(closing){run.status='stopping';return;}
  const quantity=this._quantity(run);
  if(quantity>QTY_EPS){
   // shortcut: local paper exits use the submitted paper mark, replace with venue receipt pricing for a real adapter.
   run.status='stopping';this._submit(run,'sell',run.markPrice,quantity,{lotIds:run.lots.filter(lot=>lot.qty>QTY_EPS).map(lot=>lot.id),intent:'close'});return;
  }
  const code=this._release(run);if(code)return code;run.status='stopped';run.endedAt=this.s.time;this._event(run,'ended',run.endReason);
 }
 _release(run){
  if(run.cash<=0)return;
  if(typeof this.credit!=='function'){run.status='blocked';return 'CREDIT_FAILED';}
  const amount=run.cash;
  try{const result=this.credit(amount,clone(run.plan.executionRoute));if(result===false||result&&typeof result.then==='function'){run.status='blocked';return 'CREDIT_FAILED';}}catch{run.status='blocked';return 'CREDIT_FAILED';}
  run.cash=0;run.returned+=amount;run.allocated=Math.max(0,run.allocated-amount);
  if(this._quantity(run)<=QTY_EPS)run.allocated=0;
  const allocation=this.flow.reservations.find(row=>row.id==='ALLOC-'+run.id);if(allocation)Object.assign(allocation,{amount:decimal(run.allocated),state:run.allocated>EPS?'HELD':'RELEASED',revision:allocation.revision+1,releaseEvidenceId:run.allocated>EPS?null:'BOT-RETURN-'+run.id});
  this.records.cost({sourceId:this._id('BOT-RETURN'),accountId:'SIM-01',amount:-amount,type:'BOT_RETURN',at:this.s.time});
 }
}
