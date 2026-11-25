import {normalizeConnections} from './connections.mjs?v=20261120c';
import {botPlanError, isBotSimulation} from './bot-runtime.mjs';
import {botPlanFingerprint} from './strategy-routing.mjs';
import {L} from './execution-views.mjs';

const offline=()=>L('本机模拟服务未连接；只保留上次记录，不能确认保护正在运行。','The local simulator is offline. Last records are retained; active protection is not confirmed.');
const pending=()=>L('原操作结果尚未确认，请查询原请求；不会重复提交。','The original result is unresolved. Check the original request; it will not be resubmitted.');
const unavailable=()=>L('此隔离工作区仅支持 S01/S02 本机模拟，不使用原账户或真实交易接入。','This isolated workspace supports S01/S02 local simulation only. It does not use your original account or live connections.');
const commandError=receipt=>receipt?.ok!==false?null:receipt.code==='RECONCILIATION_REQUIRED'?L('正在核对原订单，确认前资金继续保留；请查询原订单。','Reconciling the original order. Capital stays reserved until confirmed; query the original order.'):L('操作未完成','Request not completed')+' ('+(receipt.code||'LOCAL_REJECTED')+')';

export function createLocalSimDesk({client,workspace,notice=()=>{}}){
 const connections=normalizeConnections({exchange:true,data:true,ai:true,wallet:false,notifications:false,preferences:{exchange:{service:'binance',market:'spot',access:'trade'}},tradingAccounts:[{id:'local-fixture',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01',label:'Local SIM'}],preferredTradingConnection:'local-fixture'});
 const scope={workspaceId:client.fixtureId,permissionView:'LOCAL_FIXTURE',accountId:'SIM-01',environment:'DEMO',filter:'all'};
 let age=0,accessStamp='';
 const unsupported=()=>{const message=unavailable();notice(message,true);return message;};
 const staleProtection=()=>client.snapshot?.trade.botBook.runs.some(run=>!['stopped','failed'].includes(run.status)&&client.snapshot.quotes?.[run.plan.market]?.state!=='fresh');
 function parameterQuote(route){
  const quote=client.snapshot?.quotes?.[route?.market];
  if(client.state!=='LIVE'||client.snapshot?.recovery.accountingKnown===false||route?.connectionId!=='local-fixture'||route.profileId!=='cex-spot'||route.venueId!=='binance'||quote?.state!=='fresh'||!Number.isFinite(quote.price)||quote.price<=0||Date.now()-client.receivedAt>30000)return null;
  // Reuse the reference snapshot fields; the UI labels this as a received SIM quote, never a market candle.
  return {market:route.market,profileId:route.profileId,venueId:route.venueId,period:'1H',price:quote.price,closedPrice:quote.price,closedAt:client.receivedAt,asOf:client.receivedAt,state:'snapshot',source:'LOCAL_SYNTHETIC_QUOTE'};
 }
 function snapshot(){
  const source=client.snapshot;
  const trade=source?structuredClone(source.trade):{cash:0,cashKnown:false,totalFees:0,time:0,seq:0,state:'idle',position:null,pending:null,session:null,orders:[],events:[],signalHistory:[],flow:{revision:0,plans:[],fills:[],signals:[],commands:[],operations:[],reservations:[],protections:[],ledger:[]},botBook:{runs:[],requests:[],history:[]},botSummary:{},accountSummary:null};
  return {...trade,mode:'ISOLATED_LOCAL_SIMULATION',connections,accessRevision:source?.owner.epoch||0,discovery:{armed:false},localService:source?{fixtureId:source.fixtureId,owner:source.owner,recovery:source.recovery,accountingKnown:source.recovery.accountingKnown!==false}:null,botSummary:{...trade.botSummary,revision:source?.stateRevision??source?.revision??0,...(client.state!=='LIVE'||source?.recovery.accountingKnown===false?{recoveryError:offline()}: {})}};
 }
 function access({connectionId,profileId='cex-spot',operation='entry'}={}){
  let code='ready';
  if(connectionId&&connectionId!=='local-fixture')code='connection-missing';
  else if(profileId!=='cex-spot')code='unsupported-route';
  else if(client.state!=='LIVE'||!client.snapshot||client.snapshot.recovery.accountingKnown===false||client.snapshot.owner.state!=='RUNNING'||!client.snapshot.owner.protectionAvailable||client.pendingError)code='local-service-offline';
  else if(client.pending)code='local-result-pending';
  else if(client.snapshot.recovery.phase==='RECEIPT_CONFLICT'&&operation!=='control')code='local-receipt-conflict';
  else if(staleProtection()&&operation!=='control')code='local-price-wait';
  else if(client.snapshot.recovery.newRiskPaused&&['entry','auto'].includes(operation))code='local-risk-paused';
  return {code,ready:code==='ready',revision:client.snapshot?.owner.epoch||0,scopeGeneration:client.snapshot?.owner.epoch||0,connectionId:'local-fixture',accountId:'SIM-01',environment:'DEMO',profileId,exchange:client.state==='LIVE'?'connected':'disconnected',trade:true,wallet:{connected:false},localFixture:true};
 }
 function syncStatus(){return {state:client.state,scope:{...scope},source:'LOCAL_SERVICE',lastSyncedAt:client.receivedAt??null,generation:client.snapshot?.owner.epoch||0,lastSequence:client.snapshot?.revision||0,reason:client.state==='LIVE'?L('隔离本机模拟 · 无真实交易','Isolated local simulation · No live trading'):offline(),access:access()};}
 function changed(){
  const status=access(),stamp=[status.code,status.revision].join(':');
  if(stamp!==accessStamp){accessStamp=stamp;workspace.setTradingAccess(access,client.fixtureId+':'+stamp);if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('hive:access'));}
  if(client.snapshot){workspace.tick(0,snapshot());workspace.persist();}
 }
 const priorChange=client.onChange;client.onChange=()=>{priorChange?.(client);changed();};changed();
 function botCreateError(plan){
  const prior=client.snapshot?.trade.botBook.requests?.find(row=>row.requestId===plan.botLaunch?.requestId),issue=botPlanError(plan,prior);if(issue)return issue;
  if(!isBotSimulation(plan)||plan.executionRoute?.connectionId!=='local-fixture'||plan.executionRoute.accountId!=='SIM-01'||plan.executionRoute.venueId!=='binance'||plan.executionRoute.profileId!=='cex-spot')return unavailable();
  if(!prior&&!parameterQuote({...plan.executionRoute,market:plan.market}))return L('等待有效本机模拟报价；公共行情图不用于此账户成交。','Waiting for a valid local simulated quote. The public chart does not execute this account’s trades.');
  if(!access().ready)return client.pending?pending():client.snapshot?.recovery.newRiskPaused?L('本机服务已暂停新增，请核对后恢复。','New risk is paused in the local service. Review it before resuming.'):offline();
  if(prior)return null;
  if(Number(client.snapshot.trade.botSummary?.allocated||0)+plan.cap>workspace.s.risk.cap||plan.cap>client.snapshot.trade.accountSummary.available)return L('可分配资金或账户限额不足，原运行资金保持占用。','Available capital or the account limit is insufficient. Existing allocations remain reserved.');
  return null;
 }
 async function send(command,payload,requestId){
  try{
   const receipt=await client.command(command,payload,requestId);
   if(command==='action'&&['stop-close','stop-keep','close-position'].includes(payload.kind)&&receipt?.code==='RECONCILIATION_REQUIRED'&&receipt.requestStatus==='COMMITTED'&&receipt.result?.runId===payload.runId){
    const run=client.snapshot?.trade.botBook.runs.find(row=>row.id===payload.runId);
    if(run?.endIntent===(payload.kind==='stop-keep'?'keep':'close')){
     if(run.status==='stopped')return null;
     if(run.status==='stopping')return {pending:true,message:L('结束请求已记录，正在核对订单；确认前资金继续保留。','End request recorded. Orders are being reconciled; capital stays reserved until confirmation.')};
    }
   }
   return commandError(receipt);
  }
  catch(error){if(error.unknown)throw Error(pending());return error.code==='LOCAL_SERVICE_UNAVAILABLE'?offline():L('操作未完成','Request not completed')+' ('+error.code+')';}
 }
 async function createBot(plan){
  await client.refresh();const issue=botCreateError(plan);if(issue)return issue;
  const original=workspace.draft(plan.id),launch=original?.botLaunch;
  if(!launch?.requestId||launch.requestId!==plan.botLaunch?.requestId||launch.status!=='requested'||!Number.isFinite(launch.approvedAt)||launch.fingerprint!==botPlanFingerprint(plan))return L('请先批准这份完整方案，再创建 BOT。','Approve this complete plan before creating the BOT.');
  const guard=workspace.checkStart(plan);if(guard)return guard;
  return send('create',{plan},launch.requestId);
 }
 async function botAction(runId,kind,options={}){
  if(client.pending){if(kind==='query'&&client.pending.payload.runId===runId){await client.recover();return null;}return pending();}
  await client.refresh();
  const run=client.snapshot?.trade.botBook.runs.find(row=>row.id===runId),route=run?.plan.executionRoute;
  if(!run||['accountId','connectionId','environment'].some(key=>options['expected'+key[0].toUpperCase()+key.slice(1)]!==undefined&&options['expected'+key[0].toUpperCase()+key.slice(1)]!==(key==='environment'?'DEMO':route[key])))return L('运行或账户已变化，请重新打开运行后再操作。','Run or account changed. Reopen the run before acting.');
  if(!['pause','resume','stop-close','stop-keep','close-position','cancel','query'].includes(kind))return unavailable();
  if(!access({operation:kind==='resume'?'entry':'control'}).ready)return offline();
  return send('action',{runId,kind,...(options.orderId?{orderId:options.orderId}:{})},options.requestId||runId+':'+kind+':'+crypto.randomUUID());
 }
 async function recoverAccess(action){
  if(action==='local-resume'){
   await client.refresh();const error=await send('new-risk',{enabled:true},'LOCAL-RESUME:'+crypto.randomUUID());if(error)notice(error,true);return error;
  }
  if(client.pending)try{await client.recover();}catch{notice(pending(),true);}
  await client.refresh();return client.state==='LIVE'?null:offline();
 }
 if(typeof document!=='undefined')document.addEventListener('click',event=>{const button=event.target.closest?.('[data-access-action]');if(!button)return;event.preventDefault();recoverAccess(button.dataset.accessAction).catch(()=>notice(pending(),true));});
 return {parameterQuote,snapshot,readSnapshot:()=>client.snapshot?snapshot():null,syncStatus,access,botCreateError,createBot,botAction,recoverAccess,recoverBotLaunch:async id=>{try{return commandError(await client.recover(id));}catch{throw Error(pending());}},tick(dt){age+=Math.max(0,Number(dt)||0);if(age>=1){age=0;client.refresh();}},render(){},discover(){},configure(){},settings:unsupported,start:unsupported,arm:unsupported,action:unsupported,disarm:unsupported,handoff:unsupported,resumeReviewed:unsupported,quickOrder:unsupported,triggerProtection:unsupported,setScenario:unsupported,setWalletNetwork:unsupported,streamAction:recoverAccess,selectContext(patch){if(patch.accountId&&patch.accountId!=='SIM-01'||patch.environment&&patch.environment!=='DEMO')return unsupported();return null;}};
}
