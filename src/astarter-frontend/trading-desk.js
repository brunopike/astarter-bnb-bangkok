import {t} from './locale.mjs';
import {refreshNumberInputs} from './product-number-input.mjs';
import {strategyById} from './strategy-catalog.mjs';
import {strategyAccessOptions,strategyConnection,botPlanFingerprint} from './strategy-routing.mjs';
import {decorateIdentity} from './brand-icons.mjs';
import {positionValue,orderSideLabel,marketLabel} from './order-markets.mjs';
import {ExecutionFeed,runActionError} from './execution-stream.mjs';
import {EXECUTION_SCENARIOS} from './execution-records.mjs';
import {DiscoveryDispatch} from './multi-research.mjs';
import {createConnectionCenter,normalizeConnections} from './connections.mjs?v=20261123z';
import {applyCheckedTradingConnection,applySignedWallet,signedWalletSession,notificationAllowed} from './connection-options.mjs?v=20261123z';
import {createNotificationPublisher} from './notification-settings.mjs';
import {TradingAccess,accessTicketError,accessMessage} from './trading-access.mjs?v=20261120c';
import {coordinationJobs} from './coordination.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS,MARKETS} from './trading-demo.mjs';
import {BotBook,botPlanError,isBotSimulation} from './bot-runtime.mjs';
import {newProtectionState,advanceProtection} from './strategy-protection.mjs';
import {syntheticPrice} from './research-state.mjs';
import {evidenceProcess} from './evidence-process.mjs';
const $=id=>document.getElementById(id),money=n=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const STORAGE='hive-demo.connections.v1';
export function strategyConfigurationError({connections,workspace,session,totalFees=0}){
 if(session?.executionRoute&&!strategyConnection(session.executionRoute,connections))return accessMessage({code:'connection-missing'});
 if(!session?.executionRoute&&!connections.exchange||!connections.data||!connections.ai)return '请先恢复交易账户、研究数据和 AI 模型连接。';
 if(workspace&&session&&session.riskVersion!==workspace.s.risk.version)return '资金保护设置已变化，请重新检查策略设置。';
 if(workspace&&totalFees>=workspace.s.risk.dailyLoss)return '已达到当前资金保护上限，请先检查资金保护。';
 return '';
}
export function guardedResearchContext(context,{connections,workspace,session,totalFees=0,revision=session?.researchRevision,access}){
 const c=context||{};
 return {...c,ready:Boolean((!access||access.ready)&&(session?.executionRoute?access?.ready:connections.exchange)&&connections.data&&connections.ai&&(!workspace||!session||session.riskVersion===workspace.s.risk.version)&&(!workspace||totalFees<workspace.s.risk.dailyLoss)&&c.ready&&!c.conflict&&!c.missing&&(!session||c.market===session.market&&c.revision===revision))};
}
export function resumeWithResearch(demo,{connections,workspace,item,context,access}){
 if(demo.state!=='blocked'||!demo.session||demo.session.singleShot||demo.pending||demo.position||!demo.events[0]?.text?.startsWith('研究版本已变化'))return '当前状态不可恢复。';
 if(!item||item.mode!=='simulation-only'||!item.revision||item.market!==demo.session.market)return '先完成当前研究核验。';
 const c=guardedResearchContext(context,{connections,workspace,session:demo.session,totalFees:demo.totalFees,revision:item.revision,access});
 if(!c.ready)return '研究、连接或风控已变化，无法确认。';
 const error=demo.pause();return error||demo.resume(c);
}
export function createTradingDesk({model,market,prepare,notice,getResearchContext,onDiscoveryHandoff,workspace,privateUI=null}){
 let imported=null,configuredDraft=null;const dispatch=new DiscoveryDispatch(workspace?.s.trade?.discovery);let demo=new TradingDemo();let accessRuntime,lastAccessState='',accessEpoch=Date.now().toString(36);let connections={...DEFAULT_CONNECTIONS},tab='trade',section='exchange',opener=null,last='',uiTime=0;
 const savedTrade=workspace?.s.trade;let tradeRecoveryError='',unreadableTrade=savedTrade?.unreadableTrade;
 if(savedTrade)try{if(unreadableTrade||!demo.restore({...savedTrade,seq:savedTrade.legacySeq??savedTrade.seq}))tradeRecoveryError='原模拟资金账本无法完整恢复，已保留原记录；请先核对，不能重新分配资金。';}catch{tradeRecoveryError='原模拟资金账本无法完整恢复，已保留原记录；请先核对，不能重新分配资金。';}
 if(tradeRecoveryError){unreadableTrade||=structuredClone(savedTrade);demo=new TradingDemo();demo.cash=Number.isFinite(savedTrade.cash)&&savedTrade.cash>=0?savedTrade.cash:0;}
 let botBook=null,botRecoveryError=tradeRecoveryError;
 const rawBotBook=savedTrade?.botBook;
 if(!tradeRecoveryError)try{botBook=new BotBook({...(rawBotBook===undefined?{}:{state:rawBotBook}),
  debit(amount,route){if(route.accountId!=='SIM-01'||!Number.isFinite(amount)||amount<0||amount>sharedAvailableCash()+1e-9)return false;demo.cash-=amount;return true;},
  credit(amount,route){if(route.accountId!=='SIM-01'||!Number.isFinite(amount)||amount<0||!Number.isFinite(demo.cash+amount))return false;demo.cash+=amount;return true;},
  canBuy:run=>botEntryError(run)
 });}catch{botRecoveryError='BOT 账本暂时无法恢复；原记录和资金占用已保留，请先核对，不能新建或继续买入。';}
 Object.defineProperty(demo,'equity',{get:()=>demo.cash+positionValue(demo.position)+(botBook?.summary().equity||0)});
 const feed=new ExecutionFeed();
 const notificationPublisher=['localhost','127.0.0.1','[::1]'].includes(globalThis.location?.hostname)?createNotificationPublisher({getScope:()=>workspace?.account?.scope||'',onError(){notice(t('通知状态暂时无法确认，请检查通知设置。'),true);}}):{observe(){}};
 notificationPublisher.observe(demo.events,workspace?.s.notices);
 function snapshot(){const {records,...data}=demo;return {mode:'ui-fixture',...data,...(unreadableTrade?{unreadableTrade:structuredClone(unreadableTrade),cashKnown:Number.isFinite(unreadableTrade.cash)&&unreadableTrade.cash>=0}:{}),legacySeq:demo.seq,seq:demo.seq+(botBook?.s.revision||0),flow:records.data,botBook:botBook?botBook.snapshot():structuredClone(rawBotBook),botSummary:{...(botBook?.summary()||{}),revision:botBook?.s.revision||0,recoveryError:botRecoveryError},accountSummary:accountSummary(),strategyIssue:demo.session&&!demo.session.singleShot?strategyConfigurationError({connections,workspace,session:demo.session,totalFees:sharedFees()}):'',unread:demo.unread,discovery:{...dispatch.receipt,armed:Boolean(dispatch.policy),message:dispatch.message},connections:{...connections},accessRevision:accessRuntime?.revision||0};}
 function sharedFees(){return demo.totalFees+(botBook?.summary().fees||0);}
 function legacyAllocation(){const active=demo.session&&(demo.state!=='stopped'||demo.position||demo.pending),cap=active&&demo.session.mode!=='signal'?Number(demo.session.cap)||0:0;return Math.max(cap,dispatch.policy?.mode==='signal'?0:Number(dispatch.policy?.cap)||0);}
 function sharedAvailableCash(){const reserved=demo.cash-demo.availableCash,remaining=Math.max(0,legacyAllocation()-positionValue(demo.position)-reserved);return Math.max(0,demo.availableCash-remaining);}
 function accountSummary(){
  if(botRecoveryError)return null;
  const bot=botBook?.summary(),runs=botBook?.s.runs||[],cash=demo.cash+(bot?.cash||0),available=sharedAvailableCash(),equity=demo.equity;
  if(![cash,available,equity].every(Number.isFinite)||cash<0||available<0||available>cash+1e-9)return null;
  // BOT cash is already debited from demo.cash; reservations include only unspent budgets and pending cash.
  return {accountId:'SIM-01',environment:'DEMO',unit:'USDT',asOf:demo.time,equity,cash,available,reserved:Math.max(0,cash-available),
   risk:{allocated:(bot?.allocated||0)+legacyAllocation(),loss:Math.max(0,10000-equity),fees:sharedFees(),locked:Boolean(demo.capitalProtection?.locked)},
   positions:Number(Boolean(demo.position?.qty))+runs.filter(run=>run.quantity>0).length,
   orders:[...demo.orders,...runs.flatMap(run=>run.orders)].filter(order=>['submitted','partial','confirming','unknown'].includes(order.status)).length};
 }
 function accountRiskError(){
  if(botRecoveryError)return botRecoveryError;
  if(demo.capitalProtection?.locked||workspace?.s.trade?.capitalProtection?.locked)return '账户资金保护已暂停新买入，请先处理保护记录。';
  if(workspace&&(sharedFees()>=workspace.s.risk.dailyLoss||10000-demo.equity>=workspace.s.risk.dailyLoss))return '共享账户已达到亏损或费用保护上限，暂停新买入。';
  return null;
 }
 function botScopeError(plan,operation='entry'){
  const route=plan?.executionRoute,scope=feed.status.scope;
  if(!route||route.accountId!=='SIM-01'||plan.environment&&plan.environment!=='DEMO'||route.environment&&route.environment!=='DEMO'||scope.accountId!=='SIM-01'||scope.environment!=='DEMO')return '账户或环境已变化，请返回原 SIM-01 · DEMO 账户核对。';
  if(!strategyConnection(route,connections))return accessMessage({code:'connection-missing'});
  return accessError({...strategyAccessOptions(route,plan.mode),nativeBot:true,operation});
 }
 function legacyFundingError(plan){
  const risk=accountRiskError();if(risk)return risk;
  if(isBotSimulation(plan))return '此模拟版本请通过创建 BOT 运行，原单实例入口不能重复占用资金。';
  if(plan?.mode==='signal')return null;
  if((botBook?.summary().allocated||0)+Number(plan?.cap)>Number(workspace?.s.risk.cap??Infinity)+1e-9)return 'BOT 与原运行的总分配额度超过账户上限，请先释放额度。';
  const used=plan===demo.session?positionValue(demo.position)+demo.cash-demo.availableCash:0;
  if(Math.max(0,Number(plan?.cap)-used)>demo.availableCash+1e-9)return '共享可用模拟余额不足，已有 BOT 分配资金不能重复使用。';
  return null;
 }
 function botCreateError(approved){
  const requestId=approved?.botLaunch?.requestId,priorRequest=botBook?.s.requests.find(row=>row.requestId===requestId);
  const issue=botRecoveryError||botPlanError(approved,priorRequest)||botScopeError(approved)||accountRiskError();if(issue)return issue;
  if(priorRequest)return null;
  if(botBook.summary().allocated+legacyAllocation()+approved.cap>Number(workspace?.s.risk.cap??0)+1e-9)return '全部 BOT 与原运行的总分配额度超过账户上限，请先释放额度。';
  if(approved.cap>sharedAvailableCash()+1e-9)return '共享可用模拟余额不足，原运行和未完成订单的资金不能重复预留。';
  return null;
 }
 function createBot(approved){
  const guard=botCreateError(approved);if(guard)return guard;
  const requestId=approved.botLaunch?.requestId;if(!requestId)return '需要本次已批准方案的请求编号。';
  if(!botBook.s.requests.some(row=>row.requestId===requestId)){
   const original=workspace?.draft(approved.id);
   if(!workspace||!original||original.botLaunch?.requestId!==requestId||!['requested','accepted','started'].includes(original.botLaunch.status)||original.botLaunch.status==='requested'&&(!Number.isFinite(original.botLaunch.approvedAt)||original.botLaunch.fingerprint!==botPlanFingerprint(approved)))return '请先批准这份完整方案，再创建 BOT。';
   const issue=workspace.checkStart(approved,{...strategyAccessOptions(approved.executionRoute,approved.mode),nativeBot:true});if(issue)return issue;
  }
  const result=botBook.create(approved,{requestId});
  if(result.error)return result.error;
  if(approved.protection?.id==='astarter')demo.capitalProtection||=newProtectionState(demo.equity);
  sync();render();return null;
 }
 function botEntryError(run){
  const issue=accountRiskError()||botScopeError(run.plan);if(issue)return issue;
  if(workspace&&run.plan.riskVersion!==workspace.s.risk.version)return '账户风控版本已更新，请先检查原 BOT；新增买入已暂停。';
  if(workspace&&botBook.summary().allocated+legacyAllocation()>workspace.s.risk.cap+1e-9)return '全部 BOT 与原运行的总分配额度超过账户上限。';
  return null;
 }
 function botAction(runId,kind,options={}){
  if(botRecoveryError)return botRecoveryError;
  const run=botBook.s.runs.find(row=>row.id===runId);if(!run)return '原 BOT 实例不存在。';
  const expected=options.run||{},route=run.plan.executionRoute;
  if(run.environment!=='DEMO'||expected.runId&&expected.runId!==runId||['accountId','connectionId','environment'].some(key=>expected[key]!==undefined&&expected[key]!==({accountId:route.accountId,connectionId:route.connectionId,environment:'DEMO'})[key])||options.expectedAccountId!==undefined&&options.expectedAccountId!==route.accountId||options.expectedConnectionId!==undefined&&options.expectedConnectionId!==route.connectionId||options.expectedEnvironment!==undefined&&options.expectedEnvironment!=='DEMO')return '账户或接入已变化，请返回原 BOT 核对。';
  const operation=kind==='resume'?'entry':['stop-close','close-position','cancel'].includes(kind)?'exit':['query','reconcile'].includes(kind)?'query':'control';
  const guard=botScopeError(run.plan,operation)||(kind==='resume'?botEntryError(run):null);if(guard)return guard;
  const result=botBook.action(runId,kind,{...options,expectedAccountId:route.accountId,expectedConnectionId:route.connectionId,expectedEnvironment:'DEMO'});
  sync();render();return result.error||null;
 }
 function guardBotEntries(){
  if(!botBook)return;
  for(const run of botBook.s.runs)if(['running','waiting'].includes(run.status)){
   const issue=botEntryError(run);if(!issue)continue;
   botBook.action(run.id,'pause',{requestId:'guard:'+run.id+':'+botBook.s.revision,expectedAccountId:run.plan.executionRoute.accountId,expectedConnectionId:run.plan.executionRoute.connectionId,expectedEnvironment:'DEMO'});
   run.pauseReason=issue;
  }
 }
 function sync(){const data=snapshot();feed.publish(data);workspace?.tick(0,data);workspace?.persist();notificationPublisher.observe(demo.events,workspace?.s.notices);}
 function action(name,signalId,options={}){if(['confirm','approve','resume'].includes(name)&&!(demo.signal?.intent==='close'||demo.signal?.side==='sell')){const guard=legacyFundingError(demo.session);if(guard)return guard;}if(options.run&&runActionError(options.run,snapshot(),feed.status))return '运行或账户已变化，请重新打开运行后再操作。';let result=null;const operation=['confirm','approve','resume'].includes(name)?(demo.session?.mode==='signal'?'observe':'entry'):['close','cancel'].includes(name)?'exit':'control';if(name!=='read'){const issue=accessError({operation});if(issue)return issue;}if(name==='approve'){if(!currentContext().ready)return '研究、连接或资金保护已变化，请重新检查方案。';result=demo.approve(signalId);}else if(name==='confirm'){if(!currentContext().ready)return '研究、连接或风控已变化，无法确认。';result=demo.submit();}else if(name==='resume'){if(demo.session?.mode==='confirm'||demo.session?.singleShot)return '这项交易不能重新运行，请保留持仓或重新选择策略。';const problem=strategyConfigurationError({connections,workspace,session:demo.session,totalFees:sharedFees()});if(problem)return problem;const c=context(true);result=demo.resume(guardedResearchContext(c,{connections,workspace,session:demo.session,totalFees:sharedFees(),revision:c.revision,access:accessState({operation:demo.session?.mode==='signal'?'observe':'entry'})}));}else if(name==='close')result=demo.closePosition({manual:options.manual!==false});else if(name==='reconcile')result=demo.reconcile();else if(name==='cancel')result=demo.cancel();else if(name==='pause')result=demo.pause();else if(name==='stop')result=demo.stop(options.intent||'keep',options.requestId||'');else if(name==='skip')result=demo.skip(signalId);else if(name==='read')demo.markRead();else if(name==='deliver-receipt')result=demo.deliverReceipt();else if(name==='deliver-protection')result=demo.deliverProtection();else if(name==='deliver-fees')result=demo.deliverFees();else if(name==='replay-fill')result=demo.replayFill();if(['pause','stop'].includes(name))dispatch.disarm();sync();render();return result;}
 let checkedTrading=null;
 const overlayChecked=next=>checkedTrading?applyCheckedTradingConnection(next,checkedTrading):next;
 try{connections=overlayChecked(normalizeConnections(JSON.parse(localStorage.getItem(STORAGE))||{}));}catch{}
 if(workspace){workspace.getAIConfiguration=()=>connections.preferences.ai;if(workspace.account)workspace.account.getPayers=()=>({model:connections.preferences.ai.source==='custom'?'own':'official',data:connections.preferences.data.source==='custom'?'own':'official'});}
 accessRuntime=new TradingAccess(connections);
 function accessState(options={}){const route=demo.session?.executionRoute,ticket=demo.session?.ticket,access=accessRuntime.status(feed.status,{profileId:route?.profileId||ticket?.profileId||'cex-spot',...(route?{connectionId:route.connectionId||''}:ticket?.connectionId?{connectionId:ticket.connectionId}:{}),operation:'entry',...options});return options.nativeBot&&['data-off','ai-off'].includes(access.code)?{...access,ready:true,code:'ready'}:access;}
 function accessError(options={},ticket=null){const access=accessState(options),code=ticket?accessTicketError(access,ticket):access.ready?null:access.code;return code?accessMessage({...access,code}):null;}
 function accessChanged({invalidate=true}={}){if(invalidate)accessRuntime.revision++;const version=accessEpoch+':'+accessRuntime.revision+':'+feed.status.generation;workspace?.setTradingAccess(options=>accessState({...strategyAccessOptions(workspace?.draft()?.executionRoute,workspace?.draft()?.mode),...options}),version);const watch=dispatch.policy;if(watch&&!accessState({...strategyAccessOptions(watch.executionRoute,watch.mode),ignoreView:true}).ready)dispatch.disarm('交易接入变化，新的机会接管已暂停。','interrupted');const runAccess=accessState({ignoreView:true,operation:demo.session?.mode==='signal'?'observe':'entry'});if(!runAccess.ready&&demo.state==='running'&&!demo.pending)demo.pause();sync();render();document.dispatchEvent(new CustomEvent('hive:access'));}
 let signedWallet=null,walletBook=null,walletBookAccount='';
 function sessionWallet(body){return signedWalletSession(body);}
 function attachWalletBook(safe){const id=String(walletBook?.accountId||'').toLowerCase();return walletBook&&safe.tradingAccounts?.some(record=>record.id==='wallet-bsc'&&record.status==='connected'&&String(record.accountId||'').toLowerCase()===id)?{...safe,walletBook:{...walletBook,accountId:id}}:safe;}
 async function refreshWalletBook(address){
  const account=String(address||'').toLowerCase();
  walletBookAccount=account;
  if(!account){if(!walletBook)return;walletBook=null;connections=normalizeConnections(connections);document.dispatchEvent(new CustomEvent('hive:access'));return;}
  let book=null;
  try{const response=await fetch('/api/wallet/spot?read='+Date.now(),{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}});if(response.ok){const body=await response.json();const usdt=body?.usdt,btc=body?.btc;if(typeof usdt==='number'&&Number.isFinite(usdt)&&usdt>=0&&usdt<=1e15)book={accountId:account,usdt,btc:typeof btc==='number'&&Number.isFinite(btc)&&btc>=0&&btc<=1e15?btc:0};}}catch{}
  if(walletBookAccount!==account||!book)return;
  walletBook=book;connections=attachWalletBook(normalizeConnections(connections));document.dispatchEvent(new CustomEvent('hive:access'));
 }
 async function readSignedWallet(){try{const response=await fetch('/api/wallet/session',{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}});if(!response.ok)return null;return sessionWallet(await response.json());}catch{return null;}}
 async function currentSignedWallet(){const wallet=await readSignedWallet();signedWallet=wallet;return wallet;}
 function saveConnections(next,category){try{const safe=normalizeConnections(applySignedWallet(overlayChecked(next),signedWallet)),value=JSON.stringify(safe);localStorage.setItem(STORAGE,value);if(localStorage.getItem(STORAGE)!==value)throw Error();connections=attachWalletBook(safe);accessRuntime.configure(connections,category);accessChanged({invalidate:false});return null;}catch{return '保存失败，配置未应用。';}}
 async function refreshCheckedTrading(body){
  try{
   if(!body){
    const [response,wallet]=await Promise.all([fetch('/api/trading-connections',{method:'GET',cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}}),readSignedWallet()]);
    if(!response.ok){if(response.status===401){checkedTrading=null;signedWallet=null;walletBook=null;try{const safe=normalizeConnections(applySignedWallet(JSON.parse(localStorage.getItem(STORAGE))||{},null)),value=JSON.stringify(safe);localStorage.setItem(STORAGE,value);connections=safe;accessRuntime.configure(connections);accessChanged({invalidate:false});}catch{}}else void refreshWalletBook(signedWallet?.address||'');return;}
    signedWallet=wallet;body=await response.json();
   }
   if(!body||body.executionAuthority!=='NONE'||!Array.isArray(body.connections)){void refreshWalletBook(signedWallet?.address||'');return '检查结果无效。';}
   checkedTrading=body;
   let saved={};try{saved=normalizeConnections(JSON.parse(localStorage.getItem(STORAGE))||{});}catch{}
   const safe=normalizeConnections(applySignedWallet(overlayChecked(saved),signedWallet)),value=JSON.stringify(safe);
   try{localStorage.setItem(STORAGE,value);if(localStorage.getItem(STORAGE)!==value)throw Error();}catch{void refreshWalletBook(signedWallet?.address||'');return '保存失败，配置未应用。';}
   connections=attachWalletBook(safe);accessRuntime.configure(connections);accessChanged({invalidate:false});
   void refreshWalletBook(signedWallet?.address||'');
   return null;
  }catch{void refreshWalletBook(signedWallet?.address||'');return '检查结果无效。';}
 }
 function refreshBalances(){void refreshCheckedTrading();void refreshWalletBook(signedWallet?.address||'');}
 if(typeof globalThis.location==='object'&&globalThis.location&&/^https?:$/.test(globalThis.location.protocol||''))void refreshCheckedTrading();
 globalThis.addEventListener?.('astarter:identity',()=>{void refreshCheckedTrading();});
 const balanceTimer=setInterval(()=>{if(typeof document==='undefined'||document.hidden||!['workbench','strategies','execution'].includes(document.body?.dataset.page||''))return;refreshBalances();},15000);
 balanceTimer.unref?.();
 document?.addEventListener?.('visibilitychange',()=>{if(!document.hidden)refreshBalances();});
 function recoverAccess(action,profileId='cex-spot'){const current=accessState({profileId});if(current.code==='other-account'&&!['use-demo','data','ai'].includes(action))return accessMessage(current);if(['data','ai'].includes(action)){connectionCenter.open(action);return null;}if(['use-demo','enable-account','enable-trade','read-only'].includes(action)){const next=normalizeConnections(connections);if(action==='use-demo'){next.preferences.exchange.service='binance';next.preferences.exchange.market='spot';workspace?.setSetupContext('binance-spot-demo');feed.switchScope({accountId:'SIM-01',environment:'DEMO'});}next.exchange=true;if(action==='enable-trade')next.preferences.exchange.access='trade';if(action==='read-only')next.preferences.exchange.access='read';return saveConnections(next,'exchange');}if(action==='retry-read'){feed.fault('retry');accessChanged();return null;}if(action==='check-permissions')action='reconnect-api';if(action==='connect-wallet'||action==='switch-wallet-network'){accessRuntime.change(action==='connect-wallet'?'connect-wallet':'wallet-network',profileId==='dex-perp'?'Hyperliquid':'Arbitrum');}else accessRuntime.change(action);accessChanged({invalidate:false});return null;}
 feed.publish(snapshot());workspace?.setTradingAccess(options=>accessState({...strategyAccessOptions(workspace?.draft()?.executionRoute,workspace?.draft()?.mode),...options}),accessEpoch+':'+accessRuntime.revision+':'+feed.status.generation);
 if(rawBotBook!==undefined){workspace?.tick(0,snapshot());workspace?.persist();}
 document.addEventListener('click',event=>{const b=event.target.closest?.('[data-access-action]');if(!b||b.dataset.accessAction==='refresh-quote')return;event.preventDefault();const error=recoverAccess(b.dataset.accessAction,b.dataset.accessProfile);if(error)notice(error);});
 const population=document.createElement('div');population.className='agent-population reactor-only';document.querySelector('.stage-heading h1').after(population);
 const tabs=document.createElement('div');tabs.className='trade-tabs reactor-only';tabs.innerHTML='<button data-console-view="trade" aria-pressed="true">交易</button><button data-console-view="research" aria-pressed="false">研究</button><button data-console-view="receipts" aria-pressed="false">通知 <b id="receipt-count">0</b></button>';document.querySelector('.console-header').append(tabs);
 const el=document.createElement('section');el.id='trading-desk';el.className='reactor-only';
 el.innerHTML=`<div class="trade-discovery"><b>自动找机会</b><p id="discovery-status">按下方执行方式与限额，接收下一个合格机会。</p><button id="discovery-arm" class="button secondary">开启机会跟进</button></div><div class="trade-research-origin" id="trade-research-origin">全域研究中；发现后可自动接管，也可从机会详情手动交接。</div><div class="desk-heading"><h3>运行配置</h3><span id="trade-config-state">下一次运行</span></div>
 <label class="field">执行标的<select id="trade-market"><option value="">机会自动匹配</option><option>BTC/USDT</option><option>ETH/USDT</option><option>SOL/USDT</option></select></label>
 <div class="trade-venue"><span>模拟交易所 · 现货</span><span>SIM-01</span></div>
 <label class="field">策略版本<select id="trade-strategy"><option value="S03">S03 · 均线 + RSI / v1 示例</option></select></label>
 <label class="field">执行方式<select id="trade-mode"><option value="confirm" hidden disabled>旧设置 · 需要更新</option><option value="auto" selected>Agent 自动执行</option><option value="review">入场前先批准</option><option value="signal" hidden>只看信号</option></select></label>
 <div class="trade-fields"><label class="field">单笔 / USDT<input id="trade-amount" type="number" min="10" max="1000" step="10" value="250"></label><label class="field">最多使用 / USDT<input id="trade-cap" type="number" min="10" max="3000" step="50" value="1000"></label></div>
 <details class="trade-contract"><summary>入场、等待与保护条件</summary><p>A · 使用固定条件命中剧本，不计算真实指标。<br>B · 每 12 秒演示一条，最多 3 条后暂停。<br>C · 研究变化或分歧阻止新单。暂停撤销未成交部分，已有持仓保留。</p><p>固定示例价格，手续费 0.10%；非真实策略计算或交易引擎。</p></details>
 <div class="trade-gates" id="trade-gates"></div>
 <div class="trade-start"><button id="trade-research" class="button secondary">研究这个市场</button><button id="trade-start" class="button apply-button">启动模拟</button></div>
 <p class="biz-price-note"><span id="trade-check-cost"></span> · <a href="?page=my-strategies">编辑策略</a> · <a href="?page=usage">积分账单</a></p><p id="trade-feedback" role="status">配置执行方式与限额，开启机会跟进。</p>
 <section class="trade-session"><div class="desk-heading"><h3 id="trade-state">尚未启动</h3><span id="trade-session-id">—</span></div><div id="trade-locked"></div><div class="trade-controls"><button id="trade-pause">暂停</button><button id="trade-resume">恢复</button><button id="trade-stop">停止运行</button></div><div id="trade-confirm" hidden><p id="trade-signal"></p><button id="trade-confirm-order" class="button apply-button">确认模拟委托</button><button id="trade-skip">跳过</button></div></section>
 <div class="trade-account"><div><span>模拟账面 / USDT</span><strong id="trade-cash">10,000.00</strong></div><div><span>累计手续费 / USDT</span><strong id="trade-fees">0.00</strong></div></div><div id="trade-position">暂无模拟持仓</div><button id="trade-close">退出模拟持仓</button>`;
 document.querySelector('.console-scroll').prepend(el);
 const receipts=document.createElement('section');receipts.id='trade-receipts';receipts.className='reactor-only';receipts.innerHTML='<div class="desk-heading"><h3>交易通知</h3><button id="receipts-read">全部已读</button></div><p class="trade-help">本地持久化模拟回报 · 刷新后暂停<br>关闭页面不会继续运行或发送通知。</p><div id="trade-order-list"></div><h3 class="mini-title">通知记录</h3><ol id="trade-notices"></ol>';document.querySelector('.console-scroll').prepend(receipts);
 const toast=document.createElement('button');toast.className='trade-toast reactor-only';toast.hidden=true;toast.setAttribute('aria-label','查看最新模拟执行通知');toast.onclick=()=>{view('receipts');document.body.dataset.mobileView='console';for(const b of document.querySelectorAll('[data-mobile-pane]')){b.classList.toggle('active',b.dataset.mobilePane==='console');b.setAttribute('aria-pressed',String(b.dataset.mobilePane==='console'));}toast.hidden=true;};document.body.append(toast);let toastUntil=0;
 const connectionCenter=createConnectionCenter({getTime:()=>demo.time,get:()=>connections,getAccess:options=>accessState(options),onSave:saveConnections,onRecover:recoverAccess,getNotificationScope:()=>workspace?.account?.scope||'',privateUI,getSignedWallet:currentSignedWallet});
 function view(name){tab=name;document.body.dataset.consoleView=tab;document.dispatchEvent(new CustomEvent('hive:console-view',{detail:name}));for(const b of tabs.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.consoleView===tab));if(name==='receipts'){demo.markRead();render();}}
 for(const b of tabs.querySelectorAll('button'))b.onclick=()=>view(b.dataset.consoleView);view('trade');
 const draft=()=>({...configuredDraft||workspace?.draft(),market:$('trade-market').value,strategy:$('trade-strategy').value,mode:$('trade-mode').value,amount:Number($('trade-amount').value),cap:Number($('trade-cap').value)});
 function startRun(d,c){
  if(!['auto','review','signal'].includes(d.mode))return '请先更新执行方式：Agent 自动执行或只观察。';
  const options=strategyAccessOptions(d.executionRoute,d.mode),issue=accessError(options);if(issue)return issue;
  if(!strategyConnection(d.executionRoute,connections))return accessMessage({code:'connection-market'});
  const guard=workspace?.checkStart(d,options)||legacyFundingError(d);if(guard)return guard;
  const approved=JSON.parse(JSON.stringify(d)),error=demo.start(approved,connections,c);
  if(!error){workspace?.started(demo.session,approved);sync();}return error;
 }
 function armRun(approved=draft()){
  const d=JSON.parse(JSON.stringify(approved));
  if(dispatch.policy){if(d.botLaunch?.requestId&&dispatch.policy.botLaunch?.requestId===d.botLaunch.requestId&&botPlanFingerprint(dispatch.policy)===botPlanFingerprint(d))return null;return '另一策略正在等待机会，请先暂停它。';}
  if(!['auto','review','signal'].includes(d.mode))return '请先更新执行方式：Agent 自动执行或只观察。';
  const options=strategyAccessOptions(d.executionRoute,d.mode),issue=accessError(options);if(issue)return issue;
  if(!strategyConnection(d.executionRoute,connections))return accessMessage({code:'connection-market'});
  const error=workspace?.checkStart(d,options)||legacyFundingError(d);if(error)return error;
  if(demo.session&&demo.state!=='stopped'||demo.position||demo.pending)return '请先处理当前实例与持仓。';
  dispatch.arm(d);sync();render();return null;
 }
 function context(latest=false){if(getResearchContext){const selected=demo.session&&demo.state!=='stopped'?demo.session.market:draft().market,c=getResearchContext(selected);return latest?getResearchContext(selected,c.revision):c;}const p=evidenceProcess(model);return {ready:p.ready,market:market(),price:syntheticPrice(market(),model.elapsed*2),revision:`${model.runId}:${p.revision}`,conflict:p.counts.conflict,missing:p.counts.missing};}
 function currentContext(){const c=context(Boolean(demo.session?.followResearch)),guard=accountRiskError()||(demo.session?legacyFundingError(demo.session):null);return guardedResearchContext(guard?{...c,ready:false}:c,{connections,workspace,session:demo.session,totalFees:sharedFees(),revision:demo.session?.followResearch||demo.session?.awaitingResearch?c.revision:demo.session?.researchRevision,access:accessState({ignoreView:true,operation:demo.session?.mode==='signal'?'observe':'entry'})});}
 function feedback(text){$('trade-feedback').textContent=text;notice(text);sync();render();}
 $('trade-research').onclick=async()=>{if(demo.state==='running'){feedback('先暂停当前模拟运行，再重新研究。');return;}const error=await prepare(draft().market);feedback(error||'已开始此盘口的模拟研究，Credit 在完成后结算。');};
 $('discovery-arm').onclick=()=>{const issue=accessError({operation:'control'});if(issue){feedback(issue);return;}if(dispatch.policy){dispatch.disarm();sync();render();return;}if(demo.session&&demo.state!=='stopped'||demo.position||demo.pending){feedback('请先处理当前会话与持仓，再开启下一次机会接管。');return;}const gate=armRun();if(gate){feedback(gate);return;}feedback('已开启：等待下一条合格研究机会，执行方式和限额已锁定。');};
 $('trade-start').onclick=()=>{const issue=accessError(strategyAccessOptions(draft().executionRoute,draft().mode));if(issue){feedback(issue);return;}dispatch.disarm('已切换到手动启动');const error=startRun(draft(),context());feedback(error||'模拟运行已启动，等待第一条预设信号。');};
 $('trade-confirm-order').onclick=()=>feedback('请停止旧运行后重新设置 Agent 自动执行。');
 $('trade-skip').onclick=()=>{feedback(action('skip')||'已跳过这次信号。');};$('trade-pause').onclick=()=>feedback(action('pause')||'已暂停新增风险。');$('trade-stop').onclick=()=>feedback(action('stop')||'模拟会话已停止；已有持仓保留。');$('trade-resume').onclick=()=>feedback(action('resume')||'已恢复，等待下一条信号。');$('trade-close').onclick=()=>feedback(action('close')||'退出委托已模拟提交，等待回报。');$('receipts-read').onclick=()=>{demo.markRead();render();};
 for(const input of el.querySelectorAll('input,select'))input.addEventListener('change',render);
 let identityStamp='';
 function render(){
  const policy=workspace?.draft();if(policy){const label=t(strategyById(policy.strategy)?.name||policy.name||policy.strategy)+' · v'+policy.version;if($('trade-strategy').value!==policy.strategy||$('trade-strategy').selectedOptions[0]?.textContent!==label)$('trade-strategy').replaceChildren(new Option(label,policy.strategy));}$('trade-check-cost').textContent=workspace?.quote(4)===0?t('启动检查免费'):'启动检查 · '+(workspace?.quote(4)??4)+' Credit';
  $('discovery-status').textContent=dispatch.policy?`等待合格机会 · ${dispatch.policy.mode==='auto'?'自主模拟':dispatch.policy.mode==='review'?'入场前先批准':dispatch.policy.mode==='confirm'?'逐笔确认':'只看信号'} · 单笔 ${dispatch.policy.amount} USDT`:dispatch.message;
  $('discovery-arm').textContent=dispatch.policy?'关闭机会接管':'开启机会跟进';el.querySelector('.trade-discovery').dataset.armed=String(Boolean(dispatch.policy));
  const engaged=new Set([...model.config.actors,...(model.visualRoles||[]),...(model.coordinationJobs||[]).flatMap(j=>j.roles)]);if(document.body.dataset.multiResearch!=='true')population.textContent=`18 个角色 · ${engaged.size} 协作 · ${18-engaged.size} 待命`;
  const c=context(),d=draft(),isReady=c.ready&&!c.conflict&&!c.missing&&c.market===d.market,conn=connections.exchange&&connections.data&&connections.ai;
  if(getResearchContext&&imported){const latest=getResearchContext(imported.market);$('trade-research-origin').innerHTML=`<b>${imported.market} · ${imported.title}</b>${imported.revision}<br>${latest.revision!==imported.revision?'版本已失效，请重新核验并交接':latest.ready?(demo.session?.researchRevision===imported.revision?'已交接 · '+({running:'模拟执行中',paused:'已暂停',blocked:'已阻断',stopped:'已停止'}[demo.state]||'待启动'):'候选已接收 · 等待执行配置'):'候选尚未就绪'}`;}
  $('trade-gates').innerHTML=`<span data-ok="${isReady}"><i></i>${isReady?'研究已就绪':c.market!==d.market?'待核验所选盘口':c.conflict||c.missing?'证据待复核':'研究进行中'}</span><span data-ok="${conn}"><i></i>${conn?'示例连接就绪':'连接未就绪'}</span>`;
  const states={idle:'等待启动',running:'策略运行中',paused:'已暂停新增风险',blocked:'核验变化 · 已阻断',stopped:'已停止运行'};$('trade-state').textContent=demo.pending?.status==='unknown'?'回执未知 · 待对账':states[demo.state];$('trade-session-id').textContent=demo.session?.id||'—';
  $('trade-locked').textContent=demo.session?`${demo.session.market} · ${demo.session.mode==='auto'?'自主模拟':demo.session.mode==='review'?'入场前先批准':demo.session.mode==='confirm'?'逐笔确认':'只看信号'} · 单笔 ${demo.session.amount} USDT · 示例价 ${money(demo.session.price)}`:'本次会话无委托';
  $('trade-config-state').textContent=demo.session?'编辑仅影响下次启动':'下一次运行';
  $('trade-start').disabled=Boolean(!d.market||demo.session&&demo.state!=='stopped'||!accessState(strategyAccessOptions(d.executionRoute,d.mode)).ready);$('trade-research').disabled=!d.market||demo.state==='running';$('trade-pause').disabled=!['running','blocked'].includes(demo.state)||!accessState({operation:'control'}).ready;$('trade-resume').disabled=demo.state!=='paused'||!accessState().ready;$('trade-stop').disabled=!demo.session||demo.state==='stopped'||!accessState({operation:'control'}).ready;
  $('trade-confirm-order').disabled=!accessState({operation:demo.signal?.side==='sell'?'exit':'entry'}).ready;$('trade-confirm').hidden=true;$('trade-signal').textContent=demo.signal?`${demo.signal.side==='buy'?'买入':'退出'} ${demo.session.market} · 等待你的确认`:'';
  $('trade-cash').textContent=money(demo.cash);$('trade-fees').textContent=demo.totalFees.toFixed(4);$('trade-position').textContent=demo.position?`${demo.position.market} · ${demo.position.qty.toFixed(8)} · ${money(positionValue(demo.position))} USD eq.`:'暂无模拟持仓';$('trade-close').disabled=!demo.position||!!demo.pending||!accessState({operation:'exit'}).ready;
  $('receipt-count').textContent=demo.unread;
  connectionCenter.refresh();
  const status={confirming:'链上确认中',unknown:'回执未知 · 待对账',rejected:'已拒绝',submitted:'已提交',partial:'部分成交',filled:'已成交',cancelled:'已撤销','partial-cancelled':'部分成交 · 余量已撤'};
  const signature=demo.seq+':'+demo.orders.map(o=>o.status).join();if(signature!==last){last=signature;const list=$('trade-order-list');list.replaceChildren();if(!demo.orders.length)list.textContent='暂无模拟委托';for(const o of demo.orders.slice(0,8)){const row=document.createElement('article');row.className='trade-receipt';row.innerHTML=`<div><b>${orderSideLabel(o)} ${o.displayMarket||o.market} · ${marketLabel(o)}</b><span>${status[o.status]}</span></div><p>${o.id} · ${Math.round(o.filled*100)}%</p><small>${(o.qty*o.filled).toFixed(8)} / ${o.qty.toFixed(8)} · 费 ${o.fee.toFixed(4)} ${o.currency||'USDT'}</small>`;list.append(row);}const list2=$('trade-notices');list2.replaceChildren();for(const e of demo.events.slice(0,20)){const li=document.createElement('li');li.dataset.kind=e.kind;li.textContent=`${Math.floor(e.at/60).toString().padStart(2,'0')}:${Math.floor(e.at%60).toString().padStart(2,'0')} · ${e.text}`;list2.append(li);}}
  el.dataset.state=demo.state;el.dataset.orders=demo.orders.length;el.dataset.position=demo.position?.qty||0;
  if(identityStamp!==d.market){identityStamp=d.market;decorateIdentity(el);}
 }
 return {createBot,botCreateError,botAction,resumeReviewed(item){
   const issue=accessError()||legacyFundingError(demo.session);if(issue)return issue;
   const error=resumeWithResearch(demo,{connections,workspace,item,context:item?getResearchContext?.(item.market,item.revision):null,access:accessState()});
   if(!error){imported=item;onDiscoveryHandoff?.(item);}sync();render();return error;
  },quickOrder(item,d,ticket){
   if(!item?.market)return '信号已经更新，请重新查看评估。';
   const issue=accessError({profileId:ticket.profileId,connectionId:ticket.connectionId,operation:'entry'},ticket);if(issue)return issue;
   if(dispatch.policy)return '另一策略正在等待机会，请先暂停它。';
   if(demo.session&&demo.state!=='stopped'||demo.position||demo.pending)return '请先处理当前运行、持仓或未完成订单。';
   const gate=workspace?.checkStart(d,{profileId:ticket.profileId,connectionId:ticket.connectionId})||legacyFundingError(d);if(gate)return gate;
   imported=item;onDiscoveryHandoff?.(item);const c=getResearchContext?.(item.market);if(!c)return '研究上下文尚不可用。';
   const error=demo.quickOrder({...d,market:item.market},connections,c,ticket,session=>workspace?.started(session,d));
   if(!error){$('trade-market').value=item.market;feedback('模拟订单已提交，可在交易枢纽查看成交与保护。');}else sync();
   return error;
  },triggerProtection(kind){const issue=accessError({operation:'exit'});if(issue)return issue;const price=demo.session?.ticket?.[kind];const error=demo.triggerProtection(kind,price);sync();render();return error;},discover(research){
   const item=dispatch.next(research,demo);if(!item)return;
   const policy=dispatch.policy;
   const c=research.context(item.market,item.revision);
   const error=startRun({...policy,market:item.market},c);
   if(error){dispatch.failed(error);feedback(error);return;}
   imported=item;onDiscoveryHandoff?.(item);$('trade-market').value=item.market;
   dispatch.accepted(item);feedback(`${item.market} 已按${policy.mode==='auto'?'自主模拟':policy.mode==='review'?'入场前先批准':policy.mode==='confirm'?'逐笔确认':'只看信号'}接管。`);
  },disarm(){dispatch.disarm('已停止等待机会');sync();render();},arm:armRun,handoff(item){dispatch.disarm('已选择具体研究候选');imported=item;$('trade-market').value=item.market;view('trade');feedback('研究候选已接收，核对参数后点击启动模拟。');},configure(d){configuredDraft=JSON.parse(JSON.stringify(d));if(d.strategy)$('trade-strategy').replaceChildren(new Option(d.strategy+' · v'+(d.version||workspace?.draft()?.version||1)+' / 交互演练',d.strategy));for(const k of ['market','mode','amount','cap'])if(d[k]!==undefined)$('trade-'+k).value=d[k];refreshNumberInputs();render();},start(){const issue=accessError(strategyAccessOptions(draft().executionRoute,draft().mode));if(issue)return issue;dispatch.disarm('已切换到手动启动');const error=startRun(draft(),context());feedback(error||'模拟运行已启动');return error;},setScenario(value){if(!EXECUTION_SCENARIOS.some(([id])=>id===value))return '不支持的回报场景';demo.orderScenario=value;sync();return null;},settings(key='overview',options){connectionCenter.open(key,undefined,options);},action,tick(dt){const seq=demo.seq,revision=demo.flow.revision,botRevision=botBook?.s.revision||0;guardBotEntries();if(demo.state==='running'&&!demo.pending&&!accessState({ignoreView:true,operation:demo.session?.mode==='signal'?'observe':'entry'}).ready)demo.pause();if(demo.state==='running'&&!demo.pending&&!demo.session?.singleShot){const problem=strategyConfigurationError({connections,workspace,session:demo.session,totalFees:sharedFees()});if(problem){demo.pause();demo.event(problem,'risk');}}demo.tick(dt,currentContext());if(botBook?.s.runs.some(run=>!['stopped','failed'].includes(run.status)||Number(run.quantity)>0))botBook.tick(Math.min(.2,Math.max(0,Number(dt)||0)));if(demo.capitalProtection)demo.capitalProtection=advanceProtection(demo.capitalProtection,{policy:demo.session?.protection,equity:demo.equity,day:Math.floor(demo.time/86400)});guardBotEntries();feed.publish(snapshot());feed.tick(dt);const accessStamp=feed.status.state+':'+feed.status.generation+':'+accessRuntime.revision;if(lastAccessState!==accessStamp){lastAccessState=accessStamp;document.dispatchEvent(new CustomEvent('hive:access'));}if(demo.seq!==seq||demo.flow.revision!==revision||(botBook?.s.revision||0)!==botRevision){workspace?.tick(0,snapshot());workspace?.persist();}model.coordinationJobs=coordinationJobs(model,demo);model.visualRoles=demo.state==='running'?[6,12,13,14,15]:demo.pending?[15,16]:demo.position?[13,14,17]:[];if(demo.seq!==seq){if(demo.events[0]&&notificationAllowed(connections,demo.events[0])){notice(demo.events[0].text);toast.textContent=demo.events[0].text+' ↗';toast.hidden=false;toastUntil=demo.time+6;}render();}if(demo.time>toastUntil)toast.hidden=true;uiTime+=dt;if(uiTime>.35){uiTime=0;notificationPublisher.observe(demo.events,workspace?.s.notices);render();}},snapshot,readSnapshot:()=>feed.data,syncStatus:()=>({...feed.status,access:accessState()}),access:accessState,recoverAccess,setWalletNetwork(network){if(!['Arbitrum','Ethereum','Base','Solana','Hyperliquid'].includes(network))return '不支持的钱包网络。';accessRuntime.change('wallet-network',network);accessChanged({invalidate:false});return null;},streamAction(name){if(accessState().code==='other-account')return accessMessage(accessState());if(['disconnect-api','deny-api','reconnect-api','disconnect-wallet','read-only'].includes(name))recoverAccess(name);else{feed.fault(name);accessChanged();}},selectContext(patch){feed.switchScope(patch);workspace?.setSetupContext(feed.status.scope.accountId==='SIM-01'&&feed.status.scope.environment==='DEMO'?'binance-spot-demo':'unconnected');accessChanged();},render};
}
