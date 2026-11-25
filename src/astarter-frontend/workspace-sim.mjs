import {strategyRouteValid,strategyAccessOptions} from './strategy-routing.mjs';
import {isBotSimulation,botPlanError,editorPlanError,liveBinanceSpotRoute,liveWalletSpotRoute,MIN_ORDER_USDT} from './bot-runtime.mjs';
import {strategyFlowAvailable} from './strategy-execution-data.mjs';
import {DEFAULT_CONTEXT,contextError,setupFingerprint,setupPrecheck} from './platform-context.mjs';
import {agentModelPlan,agentModelsIssue} from './agent-models.mjs';
import {protectionConfig,protectionValid,protectionKey} from './strategy-protection.mjs';
import {strategyById} from './strategy-catalog.mjs';
import {accessMessage} from './trading-access.mjs?v=20261120c';
import {sameWatchAssetKey} from './market-watchlist.mjs';
import {validatePrivateUIWorkspaceInput} from './private-ui-data.mjs';
export const WORKSPACE_KEY='hive.workspace.sim.v1';
export const WORKBENCH_TARGETS_KEY='hive.workbench.targets.v1';
// Asset-list presentation only. The adapter supplies no membership or research grant.
export function createPrivateWatchAccountAdapter(workspace){
 const account=workspace.account;if(!account)return null;
 return new Proxy(account,{get(target,property){
  if(workspace.privateUIOwner?.()){
   if(property==='s')return {...target.s,resources:[...target.s.resources.filter(row=>row.kind!=='asset'),...workspace.s.aiSignalWatch.map(key=>({kind:'asset',key}))]};
   if(property==='resource')return ()=>{throw Error('Use workspace tracking preferences.');};
  }
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
}
const clone=v=>JSON.parse(JSON.stringify(v));
const finite=n=>Number.isFinite(n)&&n>=0;
const defaults=()=>({schema:1,seq:1,clock:0,selectedDraftId:'D-S03',selectedOpportunity:null,started:false,setupStep:1,setupContext:{...DEFAULT_CONTEXT},setupPrecheckId:null,scope:'all',risk:{cap:1000,dailyLoss:100,version:1},budget:{daily:200,byok:false},credits:1000,creditEntries:[{id:'C-WELCOME',kind:'grant',points:1000,text:'初始体验积分 · 模拟赠送',at:0}],usage:[],validations:[],drafts:[{id:'D-S03',strategy:'S03',name:'均线 + RSI · 内置演练',version:1,amount:100,cap:500,mode:'auto',status:'passed',validatedVersion:1,riskVersion:1,validationId:'V-BUILTIN',created:0}],signals:[],notices:[],seenSignals:[],selectedValidation:null,trade:null,research:null});
export class WorkspaceSim{
 constructor({storage=null,research=null,researchJobs=null,account=null,getAIConfiguration=()=>({})}={}){this.getAIConfiguration=getAIConfiguration;this.account=account;this.storage=storage;this.research=research;this.researchJobs=researchJobs;this.s=defaults();this.revision=0;this.persistenceError='';this.saveAge=0;
  try{const v=JSON.parse(storage?.getItem(WORKSPACE_KEY)||'null');if(v?.schema===1&&finite(v.credits)&&Array.isArray(v.drafts)&&v.drafts.length>0&&v.drafts.every(d=>strategyById(d.strategy))&&Array.isArray(v.usage)&&Array.isArray(v.validations)&&v.risk&&v.budget){this.s={...defaults(),...v};for(const d of this.s.drafts)if(d.status==='validating')d.status='draft';for(const u of this.s.usage)if(this.account&&u.status==='reserved'&&u.membershipTaskId&&u.priceVersion!=='P0.6.1'){u.status='legacy';u.reason='旧版浏览器预留仅存档，未转入新账本。';}else if(u.status==='reserved'&&!u.membershipTaskId){u.status='cancelled';u.settled=0;u.released=u.reserved;u.reason='刷新后释放未完成的演练预留';}for(const v of this.s.validations)if(v.status==='running')v.status='cancelled';}}
  catch{this.persistenceError='本地记录不可读，已进入新的模拟会话。';}
  // Keep targets separate: an already-open page may still save an older full workspace snapshot.
  const watchlist=value=>[...new Set(Array.isArray(value)?value.filter(item=>typeof item==='string'):[])];
  const filter=value=>['all','scan','tracked'].includes(value)?value:'all';
  const focusAsset=value=>typeof value==='string'&&/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value)?value:null;
  let targets={watched:watchlist(this.s.aiSignalWatch),filter:filter(this.s.workbenchFilter),focusAsset:focusAsset(this.s.workbenchFocusAsset)};
  let privateTargets=null;
  const readLocalTargets=()=>{
   if(!this.workbenchPersistenceError)try{const saved=JSON.parse(this.storage?.getItem(WORKBENCH_TARGETS_KEY)||'null');if(saved&&Array.isArray(saved.watched))targets={watched:watchlist(saved.watched),filter:filter(saved.filter),focusAsset:focusAsset(saved.focusAsset)};}catch{}
   if(this.account)return {...targets,watched:this.account.s.resources.filter(r=>r.kind==='asset').map(r=>r.key)};
   if(this.workbenchPersistenceError)return targets;
   try{targets.watched=watchlist([...targets.watched,...watchlist(JSON.parse(this.storage?.getItem('hive.dc.assets')||'[]'))]);}catch{}
   return targets;
  };
  const readTargets=()=>privateTargets?clone(privateTargets.targets):readLocalTargets();
  this.privateUIOwner=()=>privateTargets?.ownerRef||null;
  this.setPrivateUIOwner=ownerRef=>{
   if(typeof ownerRef!=='string'||!/^[A-Za-z0-9:_.@-]{1,128}$/.test(ownerRef)){privateTargets=null;return;}
   if(privateTargets?.ownerRef!==ownerRef)privateTargets={ownerRef,targets:{watched:[],filter:'all',focusAsset:null}};
  };
  this.applyPrivateUIPreferences=(ownerRef,preferences)=>{
   if(!privateTargets||privateTargets.ownerRef!==ownerRef)return '账户状态已更新，请重新读取偏好。';
   try{const p=validatePrivateUIWorkspaceInput({requestId:'private-targets-validation',baseRevision:0,preferences,drafts:[],selectedDraftId:null}).preferences;privateTargets.targets={watched:[...p.watchedAssets],filter:p.workbenchFilter,focusAsset:p.workbenchFocusAsset};this.workbenchPersistenceError='';this.revision++;return null;}
   catch{return '账户偏好未通过校验。';}
  };
  this.localTargetFields=()=>{const local=readLocalTargets();return {aiSignalWatch:[...local.watched],workbenchFilter:local.filter,workbenchFocusAsset:local.focusAsset};};
  const saveTargets=patch=>{
   if(privateTargets){privateTargets.targets={...privateTargets.targets,...patch};this.workbenchPersistenceError='';this.revision++;return;}
   targets={...readTargets(),...patch};this.workbenchPersistenceError='';
   if(this.storage){
    const names=this.account?[WORKBENCH_TARGETS_KEY]:[WORKBENCH_TARGETS_KEY,'hive.dc.assets'];let previous=[];
    try{
     previous=names.map(name=>this.storage.getItem(name));
     const values=[JSON.stringify(targets),JSON.stringify(targets.watched)];
     names.forEach((name,index)=>{this.storage.setItem(name,values[index]);if(this.storage.getItem(name)!==values[index])throw Error();});
    }catch{
     if(previous.length===names.length)names.forEach((name,index)=>{try{if(previous[index]==null)this.storage.removeItem?.(name);else this.storage.setItem(name,previous[index]);}catch{}});
     this.workbenchPersistenceError='追踪配置暂未保存，刷新可能丢失；请检查浏览器存储权限。';
    }
   }
  };
  this.setWorkbenchTargets=patch=>{
   const previous=readTargets();
   saveTargets({filter:filter(patch.filter===undefined?previous.filter:patch.filter),focusAsset:focusAsset(patch.focusAsset===undefined?previous.focusAsset:patch.focusAsset)});
   if(this.workbenchPersistenceError)targets=previous;
   return this.workbenchPersistenceError||null;
  };
  Object.defineProperties(this.s,{
   aiSignalWatch:{enumerable:true,get:()=>readTargets().watched,set:value=>saveTargets({watched:watchlist(value)})},
   workbenchFilter:{enumerable:true,get:()=>readTargets().filter,set:value=>saveTargets({filter:filter(value)})},
   workbenchFocusAsset:{enumerable:true,get:()=>readTargets().focusAsset,set:value=>this.setWorkbenchTargets({focusAsset:value})}
  });
  for(const u of this.s.usage)this.labelResearch(u);
  if(research&&research.mode!=='live_readonly'&&this.s.research?.tasks?.length===research.tasks.length&&this.s.research.groups?.length===6){for(const k of ['scope','time','sequence','events','core','shared','tasks','groups'])if(this.s.research[k]!==undefined)research[k]=clone(this.s.research[k]);}
  if(research?.mode==='live_readonly')research.setScope(this.s.scope);
 }
 setScope(scope){if(!['all','crypto','tradfi'].includes(scope))return;this.s.scope=scope;this.research?.setScope(scope);for(const u of this.s.usage)if(u.kind==='深度核验'&&u.status==='reserved'&&!this.research.accepts(this.research.task(u.symbol)))this.cancelUsage(u.id);this.touch();}
 id(prefix){return `${prefix}-${++this.s.seq}`;}
 touch(){this.revision++;this.persist();}
 draft(id=this.s.selectedDraftId){return this.s.drafts.find(d=>d.id===id);}
 get available(){if(this.account)return this.account.available;return this.s.credits-this.s.usage.filter(u=>u.status==='reserved').reduce((n,u)=>n+u.reserved,0);}
 get spent(){if(this.account)return this.account.spent;return this.s.usage.reduce((n,u)=>n+(u.settled||0),0);}
 get reserved(){if(this.account)return this.account.reserved;return this.s.usage.filter(u=>u.status==='reserved').reduce((n,u)=>n+u.reserved,0);}
 get todayUsage(){if(this.account)return this.account.budget.spent+this.account.budget.reserved;return this.s.usage.filter(u=>Math.floor(u.at/86400)===Math.floor(this.s.clock/86400)).reduce((n,u)=>n+(u.status==='reserved'?u.reserved:u.settled||0),0);}
 quote(base){if(this.account)return this.account.price(base);return this.s.budget.byok?Math.ceil(base*.8):base;}
 notice(text,kind='info',ref=''){this.s.notices.unshift({id:this.id('N'),text,kind,ref,at:this.s.clock,read:false});this.s.notices=this.s.notices.slice(0,80);}
 reserve(kind,base,ref){if(this.account){if(![4,20].includes(base))return {error:'付费研究需要先确认服务端报价。'};const u={id:this.id('U'),kind,ref,at:this.s.clock,reserved:0,settled:0,released:0,status:'reserved',priceVersion:'P0.6.1'};this.s.usage.unshift(u);this.touch();return {usage:u};}const amount=this.quote(base);if(!finite(amount)||amount>this.available)return {error:'体验积分不足；请到积分与用量补充模拟积分。'};if(this.todayUsage+amount>this.s.budget.daily)return {error:'已达本日研究预算；请调整预算或等待下一日，持仓保护不受影响。'};const u={id:this.id('U'),kind,ref,at:this.s.clock,reserved:amount,settled:0,released:0,status:'reserved',byok:this.s.budget.byok,priceVersion:'SIM-PRICE-1'};this.s.usage.unshift(u);this.touch();return {usage:u};}
 settle(id,actual,reason='已完成'){if(!finite(actual))return false;const u=this.s.usage.find(u=>u.id===id);if(!u||u.status!=='reserved')return false;if(this.account){const task=this.account.s.tasks.find(t=>t.id===u.membershipTaskId);if(u.membershipTaskId&&(!task||['reserved','unknown'].includes(task.status)))return false;u.settled=task?.settled||0;u.released=u.reserved-u.settled;u.status=task?.status||'settled';u.reason=reason;this.touch();return true;}const charge=Math.min(u.reserved,u.byok?Math.ceil(actual*.8):actual);u.settled=charge;u.released=u.reserved-charge;u.status='settled';u.reason=reason;this.s.credits-=charge;this.s.creditEntries.unshift({id:this.id('C'),kind:'debit',points:-charge,text:u.kind,ref:u.id,at:this.s.clock});this.touch();return true;}
 cancelUsage(id){const u=this.s.usage.find(u=>u.id===id);if(u?.status!=='reserved')return;if(this.account&&u.membershipTaskId){this.account.cancel(u.membershipTaskId).then(()=>{u.status='cancelled';u.released=u.reserved;this.touch();}).catch(e=>this.onError?.(e.message));return;}u.status='cancelled';u.released=u.reserved;u.reason='用户取消，未结算部分全部释放';this.touch();}
 topup(){if(this.account)return '请到充值页确认金额，不再自动赠分。';this.s.credits+=500;this.s.creditEntries.unshift({id:this.id('C'),kind:'grant',points:500,text:'补充体验积分 · 无真实支付',at:this.s.clock});this.notice('已补充 500 体验积分，没有支付或兑换。');this.touch();}
 createDraft(strategy){const s=strategyById(strategy);if(!s)return null;const d={id:this.id('D'),strategy,name:s.name,version:1,amount:100,cap:500,mode:'auto',status:'draft',validatedVersion:null,riskVersion:this.s.risk.version,created:this.s.clock};this.s.drafts.unshift(d);this.s.selectedDraftId=d.id;this.notice('策略已复制为个人草稿','strategy',d.id);this.touch();return d;}
 saveDraft(id,values){
  const d=this.draft(id);if(!d)return '策略草稿不存在。';
  const amount=Number(values.amount),cap=Number(values.cap);
  if(!finite(amount)||amount<MIN_ORDER_USDT||amount>1000||!finite(cap)||cap<amount||cap>3000||!['confirm','signal','auto','review'].includes(values.mode))return `单笔需 ${MIN_ORDER_USDT}–1,000 USDT；上限覆盖单笔且不超过 3,000 USDT。`;
  if(d.status==='validating')return '先等待或取消当前演练，再修改草稿。';
  const protection=values.protection===undefined?(d.protection||protectionConfig('original')):values.protection;
  if(!protectionValid(protection))return '资金保护版本无效，请重新选择。';
  const executionRoute=values.executionRoute?{connectionId:values.executionRoute.connectionId||'',profileId:values.executionRoute.profileId,venueId:values.executionRoute.venueId,accountId:values.executionRoute.accountId,chainId:values.executionRoute.chainId||''}:d.executionRoute,market=values.market??d.market;
  if(executionRoute&&!strategyRouteValid(d.strategy,{...executionRoute,market}))return '交易市场、平台或资产设置无效。';
  const next={amount,cap,mode:values.mode,protection:clone(protection),...(market?{market}:{}),...(executionRoute?{executionRoute:clone(executionRoute)}:{}),...(values.planVariant!==undefined?{planVariant:values.planVariant}:{}),...(values.botParameters!==undefined?{botParameters:clone(values.botParameters)}:{}),...(values.simulationReference!==undefined?{simulationReference:clone(values.simulationReference)}:{})};
  const clearReference=Object.hasOwn(values,'simulationReference')&&values.simulationReference===undefined,candidate={...d,...next};if(clearReference)delete candidate.simulationReference;if(isBotSimulation(candidate)){const held=liveBinanceSpotRoute(candidate.executionRoute,candidate.market)||liveWalletSpotRoute(candidate.executionRoute,candidate.market);const issue=(held?editorPlanError:botPlanError)(candidate);if(issue)return issue;}
  const changed=JSON.stringify([d.executionRoute,d.market,d.amount,d.cap,d.mode,protectionKey(d.protection),d.planVariant,d.botParameters,d.simulationReference])!==JSON.stringify([next.executionRoute,next.market,next.amount,next.cap,next.mode,protectionKey(next.protection),candidate.planVariant,candidate.botParameters,candidate.simulationReference]);
  Object.assign(d,next);if(clearReference)delete d.simulationReference;if(changed){d.version++;d.status='draft';d.validatedVersion=null;}this.s.selectedDraftId=id;this.touch();return null;
 }
 validate(id,scenario='normal'){const d=this.draft(id);if(!d)return {error:'草稿不存在'};if(d.status==='validating')return {error:'这份草稿正在演练，请勿重复提交。'};if(!['normal','missing'].includes(scenario))return {error:'不支持的演练场景'};const q=this.reserve('策略流程演练',20,`${id}:v${d.version}`);if(q.error)return q;const v={id:this.id('V'),draftId:id,version:d.version,riskVersion:this.s.risk.version,status:'running',scenario,usageId:q.usage.id,at:this.s.clock,progress:0,kind:'ui-rehearsal'};this.s.validations.unshift(v);d.status='validating';d.validationId=v.id;this.s.selectedValidation=v.id;this.touch();return {run:v};}
 setSetupContext(connectorId){const next=connectorId==='binance-spot-demo'?{...DEFAULT_CONTEXT}:{connectorId,accountId:'UNCONNECTED',venueId:connectorId,marketType:'UNAVAILABLE',environment:'DEMO'};if(JSON.stringify(next)!==JSON.stringify(this.s.setupContext)){this.s.setupContext=next;this.s.setupPrecheckId=null;}this.touch();}
 setTradingAccess(read,revision){this.tradingAccess=read;if(this.s.accessRevision===revision)return;this.s.accessRevision=revision;this.s.setupPrecheckId=null;for(const v of this.s.validations)if(v.status==='running'&&v.configurationHash)this.cancelValidation(v.id);this.touch();}
 validateSetup(options={}){const bound=this.draft();if(isBotSimulation(bound))return this.validateBotSetup();if(bound?.executionRoute)options=strategyAccessOptions(bound.executionRoute,bound.mode);if(!strategyFlowAvailable(bound))return {error:'所选交易路线尚未适配执行，可以保存配置。'};const access=this.tradingAccess?.(options);if(access&&!access.ready)return {error:accessMessage(access)};if(!protectionValid(this.draft()?.protection))return {error:'资金保护版本需要重新选择。'};const error=contextError(this.s.setupContext);if(error)return {error};const d=this.draft();if(strategyById(d.strategy)?.execution!=='spot'||d.cap>this.s.risk.cap)return {error:'策略与执行市场或资金限额不兼容；可先开启研究。'};const result=this.validate(this.s.selectedDraftId);if(result.run){result.run.configurationHash=setupFingerprint(this.s);result.run.expiresAt=this.s.clock+300;this.s.setupPrecheckId=result.run.id;this.touch();}return result;}
 validateBotSetup(){
  const d=this.draft(),issue=botPlanError(d)||contextError(this.s.setupContext);if(issue)return {error:issue};
  if(this.s.scope==='tradfi'||d.cap>this.s.risk.cap)return {error:'策略与执行市场或资金限额不兼容；可先开启研究。'};
  const access=this.tradingAccess?.({...strategyAccessOptions(d.executionRoute,d.mode),nativeBot:true});if(access&&!access.ready)return {error:accessMessage(access)};
  const run={id:this.id('V'),draftId:d.id,version:d.version,riskVersion:this.s.risk.version,status:'passed',kind:'bot-configuration',at:this.s.clock,progress:100,expiresAt:this.s.clock+300,configurationHash:setupFingerprint(this.s)};
  this.s.validations.unshift(run);this.s.setupPrecheckId=run.id;this.s.selectedValidation=run.id;
  Object.assign(d,{status:'passed',validationId:run.id,validatedVersion:d.version,riskVersion:this.s.risk.version});this.touch();return {run};
 }
 get setupReady(){return setupPrecheck(this.s);}
 cancelValidation(id){const v=this.s.validations.find(v=>v.id===id);if(!v||v.status!=='running')return;v.status='cancelled';const d=this.draft(v.draftId);if(d?.version===v.version)d.status='draft';this.cancelUsage(v.usageId);this.touch();}
 requestResearch(symbol,source=null){if(this.research?.mode==='live_readonly'&&this.researchJobs)return this.researchJobs.request(symbol);if(this.research?.mode==='live_readonly')return 'Market analysis updates from public candles. Model verification requires a connected research service.';if(this.account)return this.requestPaidResearch(symbol,source);const ai=this.getAIConfiguration(),modelIssue=agentModelsIssue(ai);if(modelIssue)return modelIssue+' 的模型和版本尚未配置，请先到 AI 模型完成设置。';const modelPlan=agentModelPlan(ai);if(this.research?.task(symbol)&&!this.research.accepts(this.research.task(symbol)))return '此资产不在当前研究范围；请先在初始设定中调整。';if(!this.research?.task(symbol))return '该资产不在模拟研究覆盖范围内。';if(this.s.usage.some(u=>u.kind==='深度核验'&&u.symbol===symbol&&u.status==='reserved'))return '该资产已有付费核验任务，请等待结果。';const q=this.reserve('深度核验',8,symbol);if(q.error)return q.error;const origin=source&&typeof source.title==='string'?{title:source.title.slice(0,200),href:String(source.href||'').slice(0,500),mode:'simulation-only'}:null;this.research.recheck(symbol,origin?'数据中心线索：'+origin.title:'用户发起深度核验 · 体验积分');const task=this.research.task(symbol);task.modelPlan=clone(modelPlan);task.modelPlanVersion=task.version;Object.assign(q.usage,{modelPlan:clone(modelPlan),symbol,version:task.version,ref:this.research.revision(task),...(origin?{source:origin}:{})});this.labelResearch(q.usage);this.notice(`${symbol} 深度核验已排队，预留 ${q.usage.reserved} 体验积分`,'research',q.usage.ref);this.touch();return null;}
 labelResearch(){}
 async requestPaidResearch(symbol,source){
  if(this.research?.mode==='live_readonly')return this.requestResearch(symbol,source);
  const ai=this.getAIConfiguration(),issue=agentModelsIssue(ai),task=this.research?.task(symbol);
  if(issue)return issue+' 的模型和版本尚未配置。';if(!task||!this.research.accepts(task))return '此资产不在当前研究覆盖范围。';
  if(this.s.usage.some(u=>u.symbol===symbol&&u.status==='reserved')||this.pendingResearch?.has(symbol))return '该资产已有研究任务或待确认报价。';
  (this.pendingResearch||=new Set()).add(symbol);
  try{const job=await this.account.runTask({profile:'R1',payers:{...(this.account.getPayers?.()||this.account.payers),model:ai.source==='custom'?'own':'official'},input:{title:symbol+' · 补充研究',symbol,assets:[symbol],days:7,source:source?.title||'workbench',href:source?.href||''}});if(!job)return '已取消，未扣 Credit。';
   this.research.recheck(symbol,'模拟补充研究');const u={id:this.id('U'),kind:'深度核验',ref:this.research.revision(task),at:this.s.clock,reserved:job.reserved,settled:0,released:0,status:'reserved',membershipTaskId:job.id,symbol,version:task.version,priceVersion:'P0.6.1',modelPlan:agentModelPlan(ai)};this.s.usage.unshift(u);this.touch();return null;
  }catch(e){return e.message;}finally{this.pendingResearch.delete(symbol);}
 }
 async ensureDraftEntitlement(d){if(!d)return '策略草稿不存在。';if(!this.account||d.id==='D-S03')return null;try{const key=d.resourceKey||'legacy:'+d.id;await this.account.resource('strategy',key);d.resourceKey=key;d.billingScope=this.account.scope;return null;}catch(e){return e.message;}}
 async createManagedDraft(strategy){this.draftSaveError='';if(!this.account)return this.createDraft(strategy);if(this.pendingDrafts?.has(strategy))return null;(this.pendingDrafts||=new Set()).add(strategy);try{const key=crypto.randomUUID();await this.account.resource('strategy',key);const d=this.createDraft(strategy);if(!d){await this.account.resource('strategy',key,true);return null;}d.resourceKey=key;d.billingScope=this.account.scope;this.touch();return d;}catch(e){this.draftSaveError=e.message||'草稿未能保存。';this.onError?.(e.message);return null;}finally{this.pendingDrafts.delete(strategy);}}
 async toggleTracked(key){
  if(!sameWatchAssetKey(key,key))return '无效的追踪标的。';
  const list=this.s.aiSignalWatch||[],matches=list.filter(item=>sameWatchAssetKey(item,key)),account=this.account,scope=account?.scope;
  try{
   if(this.privateUIOwner()){
    if(!matches.length&&list.length>=200)return '账户追踪最多支持 200 个标的。';
    this.s.aiSignalWatch=matches.length?list.filter(item=>!matches.includes(item)):[...list,key];
    return null;
   }else if(account){
    for(const stored of matches.length?matches:[key]){
     if(this.account!==account||account.scope!==scope)return '账户状态已更新，请重新操作。';
     await account.resource('asset',stored,matches.length>0);
    }
    if(this.account!==account||account.scope!==scope)return '账户状态已更新，请重新操作。';
   }else this.s.aiSignalWatch=matches.length?list.filter(item=>!matches.includes(item)):[...list,key];
   this.touch();return account?null:this.workbenchPersistenceError||this.persistenceError||null;
  }catch(e){return e.message;}
 }

 selectOpportunity(symbol){const t=this.research?.task(symbol);if(!t)return '研究记录不存在';this.s.selectedOpportunity=symbol;this.touch();return null;}
 checkStart(draft,options={}){
  const d=draft?.id?this.draft(draft.id):this.draft();
  if(d?.executionRoute)options={...strategyAccessOptions(d.executionRoute,d.mode),...(isBotSimulation(d)?{nativeBot:true}:{})};
  if(!strategyFlowAvailable(draft))return '所选交易路线尚未适配执行，专用执行适配尚未实现。';
  const access=this.tradingAccess?.(options);if(access&&!access.ready)return accessMessage(access);
  if(this.s.trade?.capitalProtection?.locked)return '账户资金保护已暂停新买入，请先处理保护记录。';
  if(!protectionValid(d?.protection))return '资金保护版本需要重新选择。';
  const capability=contextError(this.s.setupContext);if(capability)return capability;
  if(this.account&&d&&d.id!=='D-S03'&&!this.account.s.resources.some(r=>r.kind==='strategy'&&r.key===d.resourceKey))return '这份历史策略尚未保存到当前工作区，请先保存设置。';
  if(!draft||!d||d.strategy!==draft.strategy)return '请选择个人策略版本，再交给操作台。';
  if(d.status!=='passed'||d.validatedVersion!==d.version||d.riskVersion!==this.s.risk.version)return '策略或风险版本尚未完成模拟流程演练，请前往我的策略核验。';
  if(!isBotSimulation(d)&&strategyById(d.strategy)?.execution!=='spot')return '此类策略当前仅支持研究流程演练，专用执行适配尚未实现。';
  if(draft.id&&draft.id!==d.id||draft.version!==undefined&&draft.version!==d.version||JSON.stringify(draft.executionRoute)!==JSON.stringify(d.executionRoute)||d.executionRoute&&draft.market!==d.market||draft.amount!==d.amount||draft.cap!==d.cap||draft.mode!==d.mode||protectionKey(draft.protection)!==protectionKey(d.protection)||(draft.planVariant||'baseline')!==(d.planVariant||'baseline')||JSON.stringify(draft.botParameters)!==JSON.stringify(d.botParameters)||JSON.stringify(draft.simulationReference)!==JSON.stringify(d.simulationReference))return '操作参数与已演练版本不一致；请到我的策略保存新版本并重新演练。';
  if(draft.cap>this.s.risk.cap)return '策略额度超过 Astarter 账户上限，请调整策略或账户风控。';
  if(isBotSimulation(d)){const issue=botPlanError(d);if(issue)return issue;const v=this.s.validations.find(v=>v.id===d.validationId);if(v?.kind!=='bot-configuration'||this.s.clock>=v.expiresAt||v.configurationHash!==setupFingerprint({...this.s,selectedDraftId:d.id}))return '设置已变化或检查已过期，请重新检查。';return null;}
  if(!this.account&&(this.available<this.quote(4)||this.todayUsage+this.quote(4)>this.s.budget.daily))return '账户私有复核所需体验积分或日预算不足；已有持仓保护继续。';
  return null;
 }
 started(session,d=this.draft()){const q=this.reserve('账户私有复核',4,session.id);if(q.usage)this.settle(q.usage.id,4);Object.assign(session,{protection:clone(d.protection||protectionConfig('original')),strategyVersion:d.version,draftId:d.id,riskVersion:this.s.risk.version,validationId:d.validationId,usageId:q.usage?.id,authorizationId:this.id('AUTH'),...(d.executionRoute?{executionRoute:clone(d.executionRoute),connectionId:d.executionRoute.connectionId,accountId:d.executionRoute.accountId}:{}),...(d.botLaunch?.requestId?{requestId:d.botLaunch.requestId}:{})});this.notice(`${session.market} 模拟实例已启动`,'execution',session.id);this.touch();}
 setRisk(values){const cap=Number(values.cap),dailyLoss=Number(values.dailyLoss);if(!finite(cap)||cap<10||cap>3000||!finite(dailyLoss)||dailyLoss<1||dailyLoss>500)return '账户上限需 10–3,000 USDT，累计亏损或费用暂停线需 1–500 USDT。';if(cap!==this.s.risk.cap||dailyLoss!==this.s.risk.dailyLoss){this.s.risk={cap,dailyLoss,version:this.s.risk.version+1};this.notice('风控版本已更新，后续新实例需要重新演练。','risk');}this.touch();return null;}
 setBudget(values){if(this.account)return this.account.setBudget(values).then(error=>{if(!error)this.touch();return error;});const daily=Number(values.daily);if(!Number.isFinite(daily)||daily<0||daily>10000)return '日预算需为 0–10,000 体验积分；0 表示停止新付费任务。';this.s.budget={daily,byok:!!values.byok};this.touch();return null;}
 tick(dt,trade){this.s.clock+=Math.min(.2,Math.max(0,dt));this.saveAge+=dt;
  for(const v of this.s.validations){if(v.status!=='running')continue;v.progress=Math.min(100,Math.floor((this.s.clock-v.at)/4*100));if(v.progress<100)continue;const d=this.draft(v.draftId);v.status=v.scenario==='missing'?'blocked':'passed';v.reason=v.scenario==='missing'?'样例缺少必需数据，执行被阻断。':'模拟合同、权限与订单交互检查完成；不是指标回测。';if(d?.version===v.version){d.status=v.status;d.validatedVersion=v.status==='passed'?v.version:null;d.riskVersion=v.riskVersion;}this.settle(v.usageId,v.status==='passed'?16:4,v.reason);this.notice(v.reason,'validation',v.id);this.touch();}
  for(const u of this.s.usage){if(u.kind!=='深度核验'||u.status!=='reserved'||this.research?.mode==='live_readonly')continue;if(this.account){this.settle(u.id,0,'服务端模拟任务结算');continue;}const t=this.research?.task(u.symbol);if(t?.version!==u.version){this.settle(u.id,0,'证据版本已替换，本次预留释放');}else if(t.phase==='complete'){this.settle(u.id,6,`${t.symbol} ${t.title}`);this.notice(`${t.symbol} 深度核验已汇总`,'research',u.ref);}}
  if(trade){if(trade.signal&&!this.s.seenSignals.includes(trade.signal.id)){const s={...clone(trade.signal),market:trade.session.market,runId:trade.session.id,mode:trade.session.mode,strategy:trade.session.strategy,status:'waiting',revision:trade.session.researchRevision};this.s.signals.unshift(s);this.s.seenSignals.push(s.id);this.touch();}
   for(const s of this.s.signals){const o=trade.orders.find(o=>o.signalId===s.id),decision=trade.signalHistory?.find(item=>item.id===s.id);s.status=o?o.status:decision?decision.status:trade.signal?.id===s.id?'waiting':s.status==='waiting'?'expired':s.status;}
   // Signal-only records are retained by the single execution engine too.
   for(const s of trade.signalHistory||[])if(!this.s.seenSignals.includes(s.id)){this.s.signals.unshift(clone(s));this.s.seenSignals.push(s.id);this.touch();}
   const session=trade.session;
   const runReceipt=session?.requestId?{requestId:session.requestId,draftId:session.draftId,version:session.strategyVersion??session.version,connectionId:session.connectionId,accountId:session.accountId,runId:session.id,status:trade.state==='stopped'&&!trade.position&&!trade.pending?'stopped':'started'}:null;
   for(const receipt of [trade.discovery,runReceipt]){
    const d=receipt&&this.draft(receipt.draftId);
    if(d?.botLaunch?.requestId&&d.botLaunch.requestId===receipt.requestId&&d.version===receipt.version&&d.executionRoute?.connectionId===receipt.connectionId&&d.executionRoute?.accountId===receipt.accountId&&['started','stopped','failed','interrupted'].includes(receipt.status)){
     // A completed run is stronger evidence than its earlier discovery handoff.
     if(receipt===trade.discovery&&d.botLaunch.receipt?.runId)continue;
     d.botLaunch.receipt=clone(receipt);
    }
   }
   this.s.trade=clone(trade);
  }
  if(this.saveAge>2){this.saveAge=0;this.persist();}
 }
 persist(){if(this.account){this.s.credits=this.account.available+this.account.reserved;this.s.budget={daily:this.account.s.preferences.autoBudget,byok:this.account.s.preferences.byok};}if(!this.storage)return;if(this.research){if(this.research.mode==='live_readonly')this.s.marketResearch=this.research.snapshot();else this.s.research=clone(this.research);}try{const data=JSON.stringify(this.privateUIOwner()?{...this.s,...this.localTargetFields()}:this.s);this.storage.setItem(WORKSPACE_KEY,data);if(this.storage.getItem(WORKSPACE_KEY)!==data)throw Error();this.persistenceError=this.workbenchPersistenceError||'';}catch{this.persistenceError='本浏览器无法保存记录；请导出模拟档案，刷新可能丢失本次状态。';}}
}
