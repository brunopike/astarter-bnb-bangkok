import {routeSearch} from './site-routes.mjs';
import {walletBalance} from './wallet-balance.mjs';
import {initLocale,localeReady,pair} from './locale.mjs';
import {uiGlyph} from './product-composition.mjs';
import {createWorkbenchTerminal} from './workbench-terminal.mjs?v=20261123v';
import {BusinessMotion,researchMotionJobs,mergeMotionJobs} from './business-motion.mjs';
import {MembershipAccount} from './membership-account.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch,RESEARCH_GROUPS,PHASE_NAMES} from './multi-research.mjs';
import {MarketResearch} from './live-research.mjs';
import {createResearchBoard} from './research-board.js';
import {createResearchJobCoordinator} from './research-job-coordinator.mjs';
import {createPrivateUIController} from './private-ui-controller.mjs';
import {createPrivateDraftEditor} from './private-draft-editor.mjs';
import {createProduct} from './product.js?v=20261126a';
import {armSources,tickSources,queueSource} from './product-data.mjs';
import {coordinationForRole} from './coordination.mjs';
import {createTradingDesk} from './trading-desk.js?v=20261123z';
import {createResearchDesk} from './research-desk.js';
import { researchSnapshot } from './research-state.mjs';
import { evidenceProcess, evidenceRoleState, evidenceRoleOutput } from './evidence-process.mjs';
import { Simulation, ROLES, GROUPS, SCENARIOS } from './simulation.mjs';
import {createPhotonicWorkbench} from './photonic-workbench.mjs';
import {createReactorPanels} from './reactor-panels.js';

await localeReady;
const $=id=>document.getElementById(id);
const time=seconds=>`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
const stateNames={idle:'本轮未调用',queued:'等待交接',running:'处理中',done:'已完成',cancelled:'已中止'};
const media=matchMedia('(prefers-reduced-motion: reduce)'), small=matchMedia('(max-width: 900px)');
const reducedMotion=()=>media.matches||new URLSearchParams(location.search).get('motion')==='reduced';
const defaults={scenario:'liquidity',market:'BTC/USDT',cycles:1};
const visualDefaults={intensity:1.8,pointScale:1.6,labels:true,paths:true,focus:false,brickStyle:'outline'};
const sceneMode='reactor';
const workbenchView='photonic';
const createReactor=workbenchView==='photonic'?null:(await import('./reactor.js')).createReactor;
document.body.dataset.workbenchView=workbenchView;
const fixtureId=new URLSearchParams(location.search).get('localSim');
const {LocalSimClient,localSimFixture,localSimStorage}=fixtureId===null?{}:await import('./local-sim-client.mjs');
const {createLocalSimDesk}=fixtureId===null?{}:await import('./local-sim-desk.mjs');
if(fixtureId!==null)localSimFixture(location.search);
const storageKey=(fixtureId?'astarter.local-sim:'+fixtureId+':':'')+'hive-motion.config.v2';
const validConfig=x=>x&&Object.hasOwn(SCENARIOS,x.scenario)&&['BTC/USDT','ETH/USDT','SOL/USDT'].includes(x.market)&&[0,1,3].includes(x.cycles);
let active={...defaults},draft={...defaults},saved=false;
try{const stored=JSON.parse(localStorage.getItem(storageKey));if(validConfig(stored)){draft={scenario:stored.scenario,market:stored.market,cycles:stored.cycles};saved=true;}}catch{/* A corrupt or unavailable local draft never blocks the sample. */}
const demoResearch=new URLSearchParams(location.search).get('research')==='demo'||fixtureId!==null;
const research=demoResearch?new MultiResearch():new MarketResearch();
document.body.dataset.researchMode=demoResearch?'demo':'live_readonly';
let privateUI=null,privateDrafts=null,lastPrivateIdentity=null,lastInboxResearch=null,workbenchTerminal,researchBoard,needsPaint=true;
const researchJobs=demoResearch?null:createResearchJobCoordinator({onChange(_symbol,value){needsPaint=true;if(value?.status==='complete'&&value.requestId!==lastInboxResearch){lastInboxResearch=value.requestId;privateUI?.researchCompleted();}}});
researchJobs?.bind(document,{keepActive:()=>document.body.dataset.page==='workbench',onDraft:input=>{if(privateUI?.snapshot().workspace.canLoad)void privateUI.loadWorkspace();product.openPrivateDraft(input);},authenticate:()=>{if(window.dispatchEvent(new Event('astarter:authenticate-wallet',{cancelable:true})))document.querySelector('.header-wallet .wallet-login')?.click();}});
window.addEventListener('astarter:identity',event=>{walletBalance.setIdentity(event.detail);lastPrivateIdentity=event.detail;researchJobs?.setIdentity(event.detail);privateUI?.setIdentity(event.detail);privateDrafts?.setIdentity(event.detail);});
document.addEventListener('visibilitychange',walletBalance.refresh);
document.addEventListener('hive:page-leave',()=>queueMicrotask(walletBalance.refresh));
window.addEventListener('pagehide',()=>walletBalance.setIdentity(null));
document.addEventListener('hive:locale',()=>research.localize?.());
let localStore=null;try{localStore=localStorage;}catch{}
let priorWorkspace;try{priorWorkspace=JSON.parse(!fixtureId&&localStore?.getItem('hive.workspace.sim.v1')||'null');}catch{}
const membershipAccount=fixtureId?null:new MembershipAccount({storage:localStore,legacy:priorWorkspace});
await membershipAccount?.ready;
const initialScope=membershipAccount?.scope,personalScope=membershipAccount?.s.scopeType==='personal';
const scopedStore=fixtureId?localSimStorage(localStore,fixtureId):localStore?{getItem(key){return localStore.getItem(key+':'+initialScope)||(personalScope?localStore.getItem(key):null);},setItem(key,value){localStore.setItem(key+':'+initialScope,value);}}:null;
const workspaceSim=new WorkspaceSim({storage:scopedStore,research,researchJobs,account:membershipAccount});
if(!fixtureId){
 privateDrafts=createPrivateDraftEditor({getConnections:()=>tradingDesk.snapshot()?.connections,getDirectory:()=>privateUI?.snapshot().workspace.state?.drafts||[],onSaved:()=>{if(privateUI?.snapshot().workspace.canLoad)void privateUI.loadWorkspace();},onReturn:()=>product.go('workbench'),onAuthenticate:()=>privateUI?.requestAuthentication()});workspaceSim.privateDrafts=privateDrafts;
 privateUI=createPrivateUIController({onOpenDraft:id=>product.openPrivateDraft({draftId:id,sourceRequestId:null,symbol:null}),getWorkspaceInput(){const cloud=privateUI?.snapshot().workspace.state;return {preferences:{workbenchFilter:workspaceSim.s.workbenchFilter,workbenchFocusAsset:workspaceSim.s.workbenchFocusAsset,watchedAssets:[...workspaceSim.s.aiSignalWatch]},drafts:cloud?.drafts||[],selectedDraftId:cloud?.selectedDraftId||null};},applyWorkspaceInput(state){const issue=workspaceSim.applyPrivateUIPreferences(state.scope,state.preferences);if(issue)return issue;document.dispatchEvent(new CustomEvent('hive:watchlist-change'));workbenchTerminal?.refresh();return null;},onChange(value){const previous=workspaceSim.privateUIOwner();workspaceSim.setPrivateUIOwner(value.identityStatus==='ready'?value.ownerRef:null);if(previous!==workspaceSim.privateUIOwner())document.dispatchEvent(new CustomEvent('hive:watchlist-change'));workbenchTerminal?.refresh();if(['auth-required','forbidden','upgrade-required'].includes(value.identityStatus))privateDrafts?.setIdentity(null);privateDrafts?.refresh();}});
 privateUI.bind(document);if(lastPrivateIdentity){privateUI.setIdentity(lastPrivateIdentity);privateDrafts.setIdentity(lastPrivateIdentity);}
 window.addEventListener('pagehide',event=>{if(!event.persisted){workspaceSim.setPrivateUIOwner(null);privateUI.dispose();privateDrafts.dispose();}});
}
// Preserve existing saved items within the new entitlement caps; browser money is never imported.
void (async()=>{try{if(localStore&&membershipAccount&&membershipAccount.s.scopeType==='personal'&&!localStore.getItem('astarter.commerce.adopted:'+membershipAccount.scope)){
 let oldTargets=[],oldAssets=[];try{oldTargets=JSON.parse(localStore.getItem('hive.workbench.targets.v1')||'{}').watched||[];oldAssets=JSON.parse(localStore.getItem('hive.dc.assets')||'[]');}catch{}
 for(const key of [...new Set([oldTargets,oldAssets,priorWorkspace?.aiSignalWatch].flatMap(x=>Array.isArray(x)?x:[]))].filter(x=>typeof x==='string').slice(0,300)){try{await membershipAccount.resource('asset',key);}catch{break;}}
 for(const d of workspaceSim.s.drafts.filter(d=>d.id!=='D-S03'&&!d.resourceKey)){try{d.resourceKey='legacy:'+d.id;await membershipAccount.resource('strategy',d.resourceKey);d.billingScope=membershipAccount.scope;}catch{delete d.resourceKey;}}
 workspaceSim.persist();try{localStore.setItem('astarter.commerce.adopted:'+membershipAccount.scope,'1');}catch{}
}}catch{/* Saved browser items remain readable even when adoption is unavailable. */}})();
const businessMotion=new BusinessMotion();let businessJobs=[];
const visualModel={key:'liquidity',epoch:1,runId:'multi-research',elapsed:0,cycle:0,completed:false,events:[],flows:[],config:{actors:Array.from({length:18},(_,i)=>i)},coordinationJobs:[],visualRoles:[],multiResearch:research};
let importedResearch=workspaceSim.s.trade?.session?{market:workspaceSim.s.trade.session.market,revision:workspaceSim.s.trade.session.researchRevision}:null;
const model=new Simulation(active.scenario);model.reset(active.scenario,active.cycles);armSources(model);
let paused=reducedMotion(),stopped=false,speed=1,selected=4,globe,lastEvent='',uiElapsed=0,frame=0,previousTime=0,disposed=false,version=1;
let visual={...visualDefaults},ambientPaused=false;
const ambientActive=()=>false;
const roster=new Map();
const reactorPanels=createReactorPanels({onSelect:selectRole,onOpen:()=>researchBoard?.open(research.core?.symbol||'ETH'),onRole:id=>researchBoard?.openRole(id),onSource:id=>researchBoard?.openSource(id)});
const researchDesk=createResearchDesk({model,market:()=>active.market,notice,onWork(){ambientPaused=false;renderRoster();stopped=false;paused=reducedMotion();previousTime=performance.now();needsPaint=true;},onChange(){needsPaint=true;renderUI();}});
const localSim=fixtureId?new LocalSimClient({fixtureId,storage:scopedStore}):null;
if(localSim)await localSim.refresh();
const tradingDesk=localSim?createLocalSimDesk({client:localSim,workspace:workspaceSim,notice}):createTradingDesk({workspace:workspaceSim,privateUI,model,market:()=>active.market,notice,onDiscoveryHandoff(item){importedResearch=item;},getResearchContext:(market,revision)=>research.context(market,revision??(importedResearch?.market===market?importedResearch.revision:null)),async prepare(market){const symbol=market.split('/')[0];if(researchJobs){researchBoard.open(symbol);return pair('请在研究详情中确认开始研究。','Confirm the research request in its details.');}const error=await workspaceSim.requestResearch(symbol,{title:market+' · 操作台补充研究',href:routeSearch()});if(error)return error;researchBoard.open(symbol);paused=false;stopped=false;needsPaint=true;return null;}});
researchBoard=createResearchBoard({research,researchJobs,notice,onResearch:symbol=>workspaceSim.requestResearch(symbol,{title:symbol+' · 研究详情补充',href:routeSearch()}),getTrading:()=>tradingDesk.snapshot(),onSelect:selectRole,onChange(){paused=reducedMotion();stopped=false;needsPaint=true;renderUI();},onHandoff(item){
 const search=routeSearch(),symbol=item.market.split('/')[0];
 return product.openResearchStrategy(item,()=>{product.go('workbench',{search,restore:true});if(research.task(symbol))researchBoard.open(symbol);else notice('原研究已不可用，请选择其它研究。');});
}});
const motionActivity=document.createElement('div');motionActivity.className='motion-activity';motionActivity.setAttribute('aria-label','当前业务协作');document.querySelector('.reactor-bottom-grid').prepend(motionActivity);
function renderMotionActivity(){
 const jobs=businessJobs.slice(0,4),signature=jobs.map(j=>j.id+':'+j.badge).join('|');
 motionActivity.hidden=!jobs.length;if(motionActivity.dataset.signature===signature)return;motionActivity.dataset.signature=signature;motionActivity.replaceChildren();
 for(const j of jobs){const b=document.createElement('button');b.type='button';b.dataset.businessRef=j.ref;b.dataset.usageId=j.usageId||'';
 b.textContent=`${j.glyph} ${j.badge} · ${j.roles.map(id=>'A'+String(id+1).padStart(2,'0')).join(' / ')} ↗`;
 b.title=j.title+' · '+j.ref+(j.usageId?' · '+j.usageId:'');b.onclick=()=>{selectRole(j.roles[0],false);if(j.taskType==='validation'){workspaceSim.s.selectedValidation=j.ref;product.go('validation');}else product.go(j.taskType==='credits'?'usage':'execution');};motionActivity.append(b);}
}
const researchHelp=document.createElement('div');researchHelp.className='multi-console-research';researchHelp.innerHTML='<h3>多资产研究调度</h3><p>'+(demoResearch?'六组使用预设情境演示研究与交接。':pair('行情和盘口使用各自的数据时间。相关快讯、主题讨论与背景数据列在各标的研究依据中。','Each asset’s research evidence shows its market observations, related headlines and topic activity with their source times.'))+'</p><button class="button secondary" id="open-research-queue">查看研究发现 ↗</button><p>'+(demoResearch?'所有结果均为预设样例；共享情报更新会让相关资产的旧版本失效。':'行情观察不产生交易授权；过期或暂停的数据不会保留已核对状态。')+'</p>';$('pane-run').prepend(researchHelp);$('open-research-queue').onclick=()=>researchBoard.open(research.core?.symbol||'ETH');

function dirty(){return draft.scenario!==active.scenario||draft.market!==active.market||draft.cycles!==active.cycles;}
function notice(text,error=false){$('operation-notice').textContent=text;$('operation-notice').dataset.kind=error?'error':'normal';$('announcement').textContent=text;}
function selectRole(index,orient=true){selected=index;workbenchTerminal?.focusRole(index);globe?.focus(index,orient);needsPaint=true;renderUI();if(sceneMode==='reactor'&&small.matches&&document.body.dataset.mobileView==='network')reactorPanels.openRole(index);}
function createScene(){globe?.dispose();for(const key of ['pool','picked','assembled','modules','branches','revision','revisionModule','revisionStage','swaps','generations','process','streams','agents','strands','motionTime','collecting','carrying'])delete $('globe').dataset[key];$('agent-labels').replaceChildren();globe=workbenchView==='photonic'?createPhotonicWorkbench($('globe'),$('agent-labels'),{reducedMotion:reducedMotion(),getContext:()=>{
 const context=workbenchTerminal?.context();if(!context)return context;
 return {...context,researchJob:context.focus.task?researchJobs?.snapshot(context.focus.task.symbol):null,researchIdentity:lastPrivateIdentity};
},onSelectSymbol:symbol=>workbenchTerminal?.selectSymbol(symbol),onOpen:symbol=>researchBoard?.open(symbol)}):createReactor($('globe'),$('agent-labels'),{onSelect:selectRole,reducedMotion:reducedMotion()});globe.focus(selected,false);globe.setRotate($('auto-rotate').checked&&!reducedMotion());globe.setVisual(visual);const staticView=document.body.dataset.renderer!=='webgl';for(const id of ['brick-style','restore-bricks','zoom-in','zoom-out','reset-camera','auto-rotate','show-labels','show-paths','intensity','point-scale','view-network','view-flow'])$(id).disabled=staticView;if(staticView)for(const e of document.querySelectorAll('.interaction-hint span'))e.textContent=sceneMode==='bricks'?'静态组合示意':sceneMode==='field'?'静态流场示意':'静态支路示意';needsPaint=true;}
function syncSceneUI(){
 if(sceneMode==='reactor'){visual={...visualDefaults};speed=1;$('auto-rotate').checked=false;$('pane-run').hidden=false;$('pane-visual').hidden=true;}
 const brick=sceneMode==='bricks',field=sceneMode==='field',reactor=sceneMode==='reactor';document.body.dataset.scene=sceneMode;$('agent-labels').setAttribute('aria-hidden',String(!reactor));$('stage-title').textContent=reactor?'AI 协作台':brick?'策略构筑':field?'策略织构':'策略脉络';document.querySelector('.network-stage').setAttribute('aria-label',reactor?(workbenchView==='photonic'?'多源信息通过棱镜比对并分流到研究结论':'白色协作核心、彩色流线与 Agent 动向'):brick?'信号摘选与策略积木构筑':field?'从流动纤维中摘选并形成策略织构':'可交互的立体 Agent 线网球体');
 for(const b of document.querySelectorAll('[data-scene-choice]'))b.setAttribute('aria-pressed',String(b.dataset.sceneChoice===sceneMode));
 $('brick-style-field').hidden=!brick;$('intensity-label').textContent=reactor?'流线动势':brick?'聚合弧度':field?'场内流动':'纤维流动';$('point-scale-label').textContent=reactor?'线束与节点尺度':brick?'摘选强调':'证据流尺度';
 $('visual-timing-note').textContent=brick?'摘选、搭建和局部换块共用演示时钟，暂停时同步停留。':'流动、局部聚拢与证据替换共用演示时钟，暂停时同步停留。';
 $('canvas-instructions').textContent=reactor?'Agent 沿彩色证据环协作。注入事件后，相关线束向核心汇入、交叉核验，再向下一角色交接；点选 Agent 查看记录。':brick?'选择方案后应用，查看不同策略组合。注入信号后，相关模块重新摘选换块。拖动旋转，点击角色积木聚焦。':field?'连续纤维中显现紫色证据，牵引、收紧并交织成策略结构。注入示例证据查看局部重织；点击相关区域聚焦。':'纤维持续滑移与抽取。新证据在相关角色附近显影、聚拢，再替换原支路；点击角色聚焦，拖动旋转。';
 $('restore-bricks').textContent='恢复构筑全景';document.querySelector('.field-key').textContent=brick?'灰 · 候选信号　紫 · 已摘选':field?'灰 · 候选　紫 · 摘选证据':'灰 · 候选纤维　紫 · 流动证据';
 [...$('reading-phases').children].forEach((e,i)=>e.textContent=(brick?['摘选','搭建','调整','保留']:field?['显影','牵引','交织','重织']:['摘选','抽取','换入','续流'])[i]);
 for(const e of document.querySelectorAll('.interaction-hint .desktop-hint,.interaction-hint .mobile-hint'))e.textContent=brick?'拖动旋转 · 点选模块':field?'拖动旋转 · 点选角色':e.classList.contains('mobile-hint')?'拖动旋转 · 双指缩放':'拖动旋转 · 滚轮缩放';
}


syncSceneUI();
function renderRoster(){
  roster.clear();$('participants').replaceChildren();
  for(const index of visualModel.config.actors){const role=ROLES[index],button=document.createElement('button');button.className='participant';button.type='button';button.style.setProperty('--role-color',`var(--role-${role.group})`);button.setAttribute('aria-label',`聚焦 ${role.id} ${role.name}`);button.innerHTML=`<i class="participant-dot"></i><span class="participant-id">${role.id}</span><span class="participant-name">${role.name}</span><span class="participant-state"></span>`;button.addEventListener('click',()=>selectRole(index));$('participants').append(button);roster.set(index,button);}
}
function renderEvents(){
  const signature=sceneMode==='reactor'?`${model.epoch}:${model.cycle}:${Math.floor(model.elapsed*2)}:${model.events[0]?.id}`:model.events[0]?.id;if(signature===lastEvent)return;lastEvent=signature;if(sceneMode==='reactor')$('event-list').replaceChildren();
  const existing=new Map([...$('event-list').children].map(node=>[node.dataset.event,node]));const next=(sceneMode==='reactor'?researchSnapshot(model,active.market,{stopped,selected}).events:model.events).slice(0,5);
  for(const event of [...next].reverse()){if(existing.has(event.id))continue;const li=document.createElement('li');li.className='event-row';li.dataset.event=event.id;const ts=document.createElement('span');ts.className='event-time';ts.textContent=time(event.at);const message=document.createElement('span');message.className='event-message';const label=document.createElement('strong');label.textContent=event.from===null?'SYSTEM':`${ROLES[event.from].id} → ${ROLES[event.to].id}`;message.append(label,document.createTextNode(event.text));li.append(ts,message);$('event-list').prepend(li);}
  const ids=new Set(next.map(e=>e.id));for(const node of [...$('event-list').children])if(!ids.has(node.dataset.event))node.remove();
}
function roleState(index){const state=sceneMode==='reactor'?evidenceRoleState(model,index):model.status(index);return stopped&&['running','queued'].includes(state)?'cancelled':state;}
function renderUI(){
  document.body.dataset.paused=String(paused);document.body.dataset.stopped=String(stopped);document.body.dataset.simTime=model.elapsed.toFixed(2);document.body.dataset.scenario=model.key;document.body.dataset.participants=String(model.config.actors.length);document.body.dataset.phase=String(model.phase);document.body.dataset.activeMarket=active.market;document.body.dataset.version=String(version);document.body.dataset.configDirty=String(dirty());
  // The photonic view owns its UI; keep only shared controls and open research details current.
  if(workbenchView==='photonic'){
   document.body.dataset.researchTime=research.time.toFixed(2);document.body.dataset.participants='18';
   document.body.dataset.fps=String(globe?.fps||0);document.body.dataset.drawCalls=String(globe?.drawCalls||0);
   $('play-pause').disabled=false;$('play-pause').setAttribute('aria-pressed',String(paused));$('step').disabled=!paused;$('stop-run').disabled=false;
   researchBoard.update();return;
  }
  renderMotionActivity();
  if(sceneMode==='reactor'&&workbenchView==='agents'&&!document.hidden&&(!document.body.dataset.page||document.body.dataset.page==='workbench'))reactorPanels.update(visualModel,active.market,{stopped:false,selected});
  $('clock').textContent=time(model.elapsed);$('participant-count').textContent=String(model.config.actors.length).padStart(2,'0');$('handoff-count').textContent=String(model.handoffs).padStart(2,'0');
  $('running-count').textContent=String(model.config.actors.filter(i=>roleState(i)==='running').length).padStart(2,'0');$('done-count').textContent=String(model.config.actors.filter(i=>roleState(i)==='done').length).padStart(2,'0');
  $('cycle-progress').textContent=`${String(Math.floor(model.progress*100)).padStart(2,'0')}%`;$('progress-fill').style.width=`${model.progress*100}%`;
  [...$('phase-list').children].forEach((li,i)=>{li.classList.toggle('active',i===model.phase&&!stopped);li.classList.toggle('done',i<model.phase||model.completed);});
  $('task-counter').textContent=`#${String(1+model.cycle).padStart(4,'0')}`;$('event-count').textContent=String(model.sequence).padStart(2,'0');
  $('stage-state').textContent=stopped?(model.completed?'全局观察中':'本轮已中止'):paused?(reducedMotion()?'低动态 · 已暂停':'演示已暂停'):'演示运行中';$('mobile-run-state').textContent=$('stage-state').textContent+' · '+model.config.actors.length+' 个 Agent';$('mobile-play').textContent=paused?'▷':'Ⅱ';$('mobile-play').setAttribute('aria-label',stopped?'重新启动演示':paused?'继续演示':'暂停演示');
  $('play-text').textContent=sceneMode==='reactor'?(stopped?'再次研究':paused?'继续研究':'暂停研究'):(stopped?'重新启动演示':paused?'继续演示':'暂停演示');$('play-icon').textContent=paused?'▷':'Ⅱ';$('play-pause').setAttribute('aria-pressed',String(paused));$('step').disabled=!paused||stopped;$('stop-run').disabled=stopped;
  const resting=sceneMode==='reactor'&&model.completed;document.body.dataset.ambient=String(ambientActive());$('play-pause').disabled=resting&&reducedMotion();$('mobile-play').disabled=resting&&reducedMotion();
  if(resting){const moving=ambientActive(),label=reducedMotion()?'低动态 · 画面静止':moving?'暂停画面':'继续画面';$('play-text').textContent=label;$('play-icon').textContent=moving?'Ⅱ':'▷';$('mobile-play').textContent=moving?'Ⅱ':'▷';$('mobile-play').setAttribute('aria-label',label);$('play-pause').setAttribute('aria-pressed',String(!moving));}
  for(const button of document.querySelectorAll('[data-inject]'))button.disabled=stopped;
  for(const [index,button]of roster){const state=roleState(index);button.dataset.status=state;button.classList.toggle('selected',index===selected);button.setAttribute('aria-pressed',String(index===selected));button.querySelector('.participant-state').textContent=stateNames[state];}
  const role=ROLES[selected];$('focus-id').textContent=role.id;$('focus-name').textContent=role.name;$('focus-description').textContent=role.description;$('focus-status').textContent=stateNames[roleState(selected)];$('focus-output').textContent=roleState(selected)==='cancelled'?'本次运行已结束，未继续处理此角色的任务。':sceneMode==='reactor'?evidenceRoleOutput(model,selected):model.output(selected);$('focus-role').value=String(selected);const collaboration=coordinationForRole(visualModel.coordinationJobs||[],selected);if(sceneMode==='reactor'&&collaboration){$('focus-status').textContent='模拟协作';$('focus-output').textContent=collaboration.title+' · 与 '+collaboration.roles.filter(i=>i!==selected).map(i=>ROLES[i].id).join('、')+' 协同 · '+collaboration.trigger.split(' / ').at(-1);}
  $('active-market').replaceChildren(document.createTextNode(active.market.replace('/',' / ')));const sim=document.createElement('small');sim.textContent='SIM';$('active-market').append(sim);$('active-scenario').textContent=SCENARIOS[active.scenario].name.split(' · ')[1];$('config-version').textContent=`v${String(version).padStart(2,'0')}`;
  $('draft-state').textContent=dirty()?'修改待应用':'与运行一致';$('draft-role-note').textContent=`本方案按需调度 ${new Set([...SCENARIOS[draft.scenario].actors,0,3,16]).size} / 18 个 Agent（含多源核验）。`;$('apply-config').disabled=sceneMode==='reactor'?false:!dirty();$('apply-config').textContent=sceneMode==='reactor'?'开始新研究':'应用并重启';
  const observation=model.observation;document.body.dataset.observation=observation.result;document.body.dataset.observationPhase=String(observation.phase);$('route-pair').textContent=stopped?'本轮已结束':observation.label;$('route-text').textContent=observation.title+' · '+observation.detail;
  $('field-market').textContent=sceneMode==='reactor'?'多市场 · 多源研究':active.market.replace('/',' / ');$('field-state').textContent=observation.label;$('field-detail').textContent=SCENARIOS[active.scenario].name.split(' · ')[0];
  for(const [i,item]of [...$('reading-phases').children].entries()){item.classList.toggle('active',i===observation.phase);item.classList.toggle('past',i<observation.phase);}
  if(sceneMode==='reactor'){
   const flow=evidenceProcess(model);$('route-pair').textContent=stopped&&!flow.ready?'本轮中止':['采集回传','核心汇聚','证据筛选','结论形成'][flow.phase];$('route-text').textContent=`${active.market} 聚焦核验 · ${flow.detail}`;
  }
  if(sceneMode==='bricks'){
   const g=$('globe'),t=model.elapsed,staticView=document.body.dataset.renderer!=='webgl',quiet=staticView||reducedMotion(),adjust=g.dataset.revision==='adjusting',phase=quiet?3:t<5?0:t<12?1:adjust?2:3;
   const titles=['信号摘选','组合搭建','局部调整',quiet?'组合示意':'持续观察'];
   const notes=['候选信号铺陈，按当前方案筛选。','摘选的证据进入对应模块，逐层组成策略。','相关模块换入新证据，其余结构保持。',model.key==='volatility'?'风险分歧仍在，保护条件优先。':model.key==='review'?'证据仍有缺口，保留结构等待补充。':'保留当前组合，等待下一条证据。'];
   $('field-state').textContent=titles[phase];$('route-pair').textContent=stopped?'本轮已结束':titles[phase];$('route-text').textContent=staticView?'三维动效不可用，显示策略组合示意。':reducedMotion()?'低动态模式显示完整组合，可按需推进演示记录。':notes[phase];
   $('field-detail').textContent=staticView?'静态视图':g.clientWidth<640?`${g.dataset.picked||'0'} / ${g.dataset.pool||'270'} 摘选`:`${g.dataset.pool||'270'} 候选 · ${g.dataset.picked||'0'} 摘选 · ${model.config.actors.length} 模块`;
   [...$('reading-phases').children].forEach((e,i)=>{e.classList.toggle('active',i===phase);e.classList.toggle('past',i<phase);});
  }
  if(sceneMode==='network'){
   const g=$('globe'),t=model.elapsed,staticView=document.body.dataset.renderer!=='webgl',quiet=staticView||reducedMotion(),adjust=g.dataset.revision==='adjusting',phase=quiet?3:t<5?0:t<12?1:adjust?2:3;
   const titles=['纤维摘选','线束构筑','支路调整',quiet?'策略示意':'持续观察'];
   const notes=['流动线网保留全场，参与角色从中摘取证据纤维。','线束逐段收紧，组成通向整合节点的策略支路。',({locate:'新证据在相关角色附近显影。',gather:'局部纤维聚拢，准备接入原支路。',replace:'新纤维接入，旧线束逐段退场。',resume:'相关支路恢复流动，其余证据保留。'}[g.dataset.revisionStage]||'相关支路正在换入新纤维。'),model.key==='volatility'?'风险分歧仍在，保留支路并优先审阅保护条件。':model.key==='review'?'证据缺口保留，等待相关支路补充。':'保留当前策略脉络，等待新证据继续调整。'];
   $('field-state').textContent=titles[phase];$('route-pair').textContent=stopped?'本轮已结束':titles[phase];$('route-text').textContent=staticView?'三维动效不可用，显示策略支路示意。':reducedMotion()?'低动态模式显示完整线束，按需推进记录。':notes[phase];
   $('field-detail').textContent=staticView?'静态视图':g.clientWidth<640?`${g.dataset.picked||'0'} / 550 摘选`:`550 候选纤维 · ${g.dataset.picked||'0'} 摘选 · ${g.dataset.branches||model.config.actors.length-1} 支路`;
   [...$('reading-phases').children].forEach((e,i)=>{e.classList.toggle('active',i===phase);e.classList.toggle('past',i<phase);});
  }
  if(sceneMode==='field'){
   const g=$('globe'),staticView=document.body.dataset.renderer!=='webgl',quiet=staticView||reducedMotion(),process=g.dataset.process||'discover',phase=quiet?3:({discover:0,screen:1,assemble:2,retain:3,revise:3}[process]??0);
   const titles=['线索显影','证据牵引','策略交织',process==='revise'?'局部重织':quiet?'策略示意':'持续研判'];
   const notes=['候选纤维持续流动。','参与角色从流动中牵出证据。','证据收紧、交织，形成当前策略结构。',process==='revise'?({locate:'新证据在相关区域显影。',gather:'局部纤维牵引、收束。',replace:'对应纤维松开，新证据织入。',resume:'局部重织完成。'}[g.dataset.revisionStage]||'相关证据正在换入。'):model.key==='volatility'?'保留风险分歧，继续核验保护条件。':model.key==='review'?'保留证据缺口，等待补充线索。':'当前组合保留，新的候选持续流入。'];
   $('field-state').textContent=titles[phase];$('field-detail').textContent=staticView?'静态示意':`${g.dataset.branches||'0'} 证据组`;$('route-pair').textContent=stopped?'本轮已结束':titles[phase];$('route-text').textContent=staticView?'三维动效不可用，显示筛选与策略组合示意。':reducedMotion()?'低动态模式显示完整组合，可按需推进。':notes[phase];
   [...$('reading-phases').children].forEach((e,i)=>{e.classList.toggle('active',i===phase);e.classList.toggle('past',i<phase);});
  }
  const sum=research.summary();
  $('event-count').textContent=String(research.sequence);$('clock').textContent=time(research.time);$('participant-count').textContent='18';$('handoff-count').textContent=String(sum.complete).padStart(2,'0');$('running-count').textContent=String(sum.working).padStart(2,'0');$('done-count').textContent=String(sum.complete).padStart(2,'0');$('cycle-progress').textContent=`${sum.complete} / 8`;$('progress-fill').style.width=`${sum.complete/8*100}%`;
  $('active-market').textContent='全域研究 / '+(research.scope&&research.scope!=='all'?3:6)+' 个研究小组';$('active-scenario').textContent='多维度独立研究';$('config-version').textContent='SIM';$('field-market').textContent=(research.scope==='crypto'?'Crypto':research.scope==='tradfi'?'TradFi':'Crypto + TradFi')+' · 分组协作';$('stage-state').textContent=paused?'协作已暂停':'多组研究进行中';$('mobile-run-state').textContent=$('stage-state').textContent+' · 18 个 Agent';$('play-text').textContent=paused?'继续协作':'暂停协作';$('play-icon').textContent=paused?'▷':'Ⅱ';$('mobile-play').textContent=paused?'▷':'Ⅱ';$('mobile-play').setAttribute('aria-label',paused?'继续协作':'暂停协作');$('play-pause').disabled=false;$('mobile-play').disabled=false;$('step').disabled=!paused;$('stop-run').disabled=false;
  const group=research.groups.find(g=>g.roles.includes(selected)),task=research.task(group?.task);$('focus-status').textContent=task?PHASE_NAMES[task.phase]:'持续观察';$('focus-output').textContent=group?`${group.label} · ${task&&['queuedCore','core','complete'].includes(task.phase)?task.symbol:'广域扫描'} · ${task?'v'+task.version+' · '+(task.phase==='complete'?task.thesis:task.reason):'等待新证据'}`:'';
  const executionJob=(visualModel.coordinationJobs||[]).find(j=>j.roles.includes(selected));if(executionJob){$('focus-status').textContent=executionJob.business?'模拟执行协作':'跨组协作';$('focus-output').textContent=executionJob.title+' · '+executionJob.trigger;}
  for(const [id,b]of roster){const g=research.groups.find(g=>g.roles.includes(id)),t=research.task(g.task);const job=visualModel.coordinationJobs.find(j=>j.roles.includes(id));b.querySelector('.participant-state').textContent=job?.business?job.badge:job?.groupLabel||g.label;b.dataset.status=t?'running':'idle';}
  document.querySelector('.agent-population').textContent='18 个 Agent · 6 个研究组';document.body.dataset.researchTime=research.time.toFixed(2);document.body.dataset.participants='18';
  researchBoard.update();
  const fps=globe?.fps;$('performance').textContent=fps===null?'STATIC':paused&&!ambientActive()?'PAUSED':`${fps||'—'} FPS`;$('renderer-state').textContent=document.body.dataset.renderer==='webgl'?'WEBGL':'STATIC';document.body.dataset.fps=String(fps||0);document.body.dataset.drawCalls=String(globe?.drawCalls||0);$('event-list').innerHTML=research.events.slice(0,5).map(e=>`<li class="event-row"><span class="event-time">${time(e.at)}</span><span class="event-message"><strong>${research.groups[research.task(e.symbol)?.group]?.label||'共享'}</strong>${e.text}</span></li>`).join('');
}
function startRun(config){ambientPaused=false;active={...config,cycles:sceneMode==='reactor'?1:config.cycles};if(sceneMode==='reactor'){draft={...active};$('cycle-limit').value='1';}researchDesk.reset();model.reset(active.scenario,active.cycles);armSources(model);stopped=false;paused=reducedMotion();selected=active.scenario==='liquidity'?4:12;lastEvent='';$('event-list').replaceChildren();renderRoster();globe.focus(selected,false);globe.reset();needsPaint=true;previousTime=performance.now();renderUI();}
function updateDraft(){draft={scenario:$('scenario').value,market:$('market').value,cycles:sceneMode==='reactor'?1:Number($('cycle-limit').value)};$('save-note').textContent='配置尚未应用；应用时开启新的演示运行。';renderUI();}
for(const id of ['scenario','market','cycle-limit'])$(id).addEventListener('change',updateDraft);
$('save-draft').addEventListener('click',()=>{try{const text=JSON.stringify(draft);localStorage.setItem(storageKey,text);if(localStorage.getItem(storageKey)!==text)throw Error('readback');$('save-note').textContent=dirty()?'草稿已保存在本浏览器，应用后生效。':'草稿已保存，与当前运行配置一致。';notice('配置草稿已保存；当前运行参数保持原值。');}catch{notice('草稿未能保存，请保留当前页面后重试。',true);}});
$('apply-config').addEventListener('click',()=>{version++;startRun(draft);$('save-note').textContent='当前配置已应用；后续修改需再次应用。';notice(`配置 v${String(version).padStart(2,'0')} 已应用，新的演示运行已开始。`);});
$('play-pause').addEventListener('click',()=>{paused=!paused;stopped=false;needsPaint=true;previousTime=performance.now();renderUI();});
$('step').addEventListener('click',()=>{if(paused){research.advance(3);syncVisual();needsPaint=true;renderUI();}});
$('replay').addEventListener('click',()=>{for(const t of research.tasks)research.recheck(t.symbol,'操作员重新调度');paused=reducedMotion();stopped=false;needsPaint=true;renderUI();});
function finishRun(){paused=true;stopped=false;needsPaint=true;renderUI();}
$('stop-run').addEventListener('click',()=>{finishRun();notice('研究协作已暂停，已有研究版本保留。模拟执行请在交易页单独暂停。');});
for(const button of document.querySelectorAll('[data-inject]'))button.addEventListener('click',()=>{research.refreshShared(button.dataset.inject==='market'?'social':'macro');needsPaint=true;renderUI();});
for(const [group,definition]of Object.entries(GROUPS)){const optgroup=document.createElement('optgroup');optgroup.label=definition.label;for(const role of ROLES.filter(r=>r.group===group)){const option=document.createElement('option');option.value=String(role.index);option.textContent=`${role.id} · ${role.name}`;optgroup.append(option);}$('focus-role').append(optgroup);}
$('focus-role').addEventListener('change',e=>selectRole(Number(e.target.value)));
let exportUrl=null;
$('export-records').addEventListener('click',()=>{try{const record={schemaVersion:4,mode:research.mode||'simulation-only',multiResearch:research.snapshot(),importedResearch,trading:tradingDesk.snapshot(),paused,groups:research.jobs(),coverage:demoResearch?'Explicit demo research; no live data, model or trading.':'Public closed-candle analysis; unconnected evidence remains missing. No model inference or trading authority.'};const text=JSON.stringify(record,null,2);$('export-json').value=text;$('export-summary').textContent=demoResearch?'8 assets · 6 groups · 18 roles · Demo research':'8 assets · 6 groups · Public market analysis';if(exportUrl)URL.revokeObjectURL(exportUrl);exportUrl=URL.createObjectURL(new Blob([text],{type:'application/json'}));$('download-export').href=exportUrl;$('download-export').download='hive-simulation-v'+version+'-'+Date.now()+'.json';$('export-feedback').textContent='可直接检查 JSON、复制内容或交由浏览器下载。';$('export-dialog').showModal();document.body.dataset.lastExport=String(model.sequence);}catch{notice('导出预览失败，可保留页面后重试。',true);}});
$('close-export').addEventListener('click',()=>$('export-dialog').close());
$('export-dialog').addEventListener('close',()=>{if(exportUrl){URL.revokeObjectURL(exportUrl);exportUrl=null;}});
$('copy-export').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('export-json').value);$('export-feedback').textContent='JSON 已复制。';}catch{$('export-json').focus();$('export-json').select();$('export-feedback').textContent='浏览器未允许自动复制，已选中内容，可手动复制。';}});
$('download-export').addEventListener('click',()=>$('export-feedback').textContent='JSON 已交由浏览器下载，请查看浏览器下载记录。');

function chooseConsole(tab){for(const key of ['run','visual']){$(`tab-${key}`).setAttribute('aria-selected',String(key===tab));$(`pane-${key}`).hidden=key!==tab;}}
for(const key of ['run','visual']){$(`tab-${key}`).addEventListener('click',()=>chooseConsole(key));$(`tab-${key}`).addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const next=key==='run'?'visual':'run';chooseConsole(next);$(`tab-${next}`).focus();}});}
function updateVisual(){visual={...visual,intensity:Number($('intensity').value),pointScale:Number($('point-scale').value),labels:$('show-labels').checked,paths:$('show-paths').checked,brickStyle:$('brick-style').value};$('intensity-value').textContent=`${visual.intensity.toFixed(1)}×`;$('point-value').textContent=`${visual.pointScale.toFixed(1)}×`;globe.setVisual(visual);needsPaint=true;}
for(const id of ['intensity','point-scale','show-labels','show-paths','brick-style'])$(id).addEventListener('input',updateVisual);
$('speed').addEventListener('change',e=>speed=Number(e.target.value));$('auto-rotate').addEventListener('change',e=>globe.setRotate(e.target.checked&&!reducedMotion()));
function setView(focus){visual.focus=focus;globe.setVisual(visual);needsPaint=true;for(const [id,state]of [['view-network',!focus],['view-flow',focus]]){$(id).classList.toggle('active',state);$(id).setAttribute('aria-pressed',String(state));}}
$('view-network').addEventListener('click',()=>setView(false));$('view-flow').addEventListener('click',()=>setView(true));
$('reset-visual').addEventListener('click',()=>{visual={...visualDefaults};$('intensity').value='1.8';$('point-scale').value='1.6';$('brick-style').value='outline';$('show-labels').checked=true;$('show-paths').checked=true;$('auto-rotate').checked=false;$('speed').value='1';speed=1;setView(false);updateVisual();globe.setRotate(false);notice('动效参数已恢复默认。');});
$('restore-bricks').addEventListener('click',()=>{globe.restore?.();needsPaint=true;notice('已恢复策略全景，演示进度保持原位。');});
$('mobile-play').addEventListener('click',()=>$('play-pause').click());$('reset-camera').addEventListener('click',()=>globe.reset());$('zoom-in').addEventListener('click',()=>globe.zoom(.87));$('zoom-out').addEventListener('click',()=>globe.zoom(1.15));
for(const button of document.querySelectorAll('[data-mobile-pane]'))button.addEventListener('click',()=>{document.body.dataset.mobileView=button.dataset.mobilePane;for(const b of document.querySelectorAll('[data-mobile-pane]')){const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}needsPaint=true;if(document.body.dataset.page==='workbench')workbenchTerminal?.refresh();requestAnimationFrame(()=>globe.resize());});
function syncTheme(){const theme=document.documentElement.dataset.theme;for(const button of document.querySelectorAll('[data-theme-choice]'))button.setAttribute('aria-pressed',String(button.dataset.themeChoice===theme));document.querySelector('meta[name=theme-color]').content=theme==='dark'?'#100e0b':'#f6f3ee';}
for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>{const theme=button.dataset.themeChoice;document.documentElement.dataset.theme=theme;try{localStorage.setItem('hive-motion-theme',theme);}catch{/* Theme remains usable without storage. */}syncTheme();globe.setTheme();needsPaint=true;});
syncTheme();
small.addEventListener('change',()=>{needsPaint=true;requestAnimationFrame(()=>globe.resize());});
media.addEventListener('change',()=>{paused=reducedMotion()||paused;if(reducedMotion())$('auto-rotate').checked=false;document.documentElement.dataset.reducedMotion=String(reducedMotion());createScene();renderUI();});
if(reducedMotion()){$('auto-rotate').checked=false;$('motion-note').textContent='当前为低动态模式，默认暂停并关闭自动旋转。';}
document.documentElement.dataset.reducedMotion=String(reducedMotion());if(sceneMode==='reactor')draft.cycles=1;$('scenario').value=draft.scenario;$('market').value=draft.market;$('cycle-limit').value=String(draft.cycles);if(saved)$('save-note').textContent=dirty()?'已恢复本浏览器草稿；点击应用后才影响运行。':'已恢复草稿，内容与当前运行配置一致。';
createScene();renderRoster();renderUI();if(reducedMotion())notice('低动态模式默认暂停，可单步推进或继续演示。');
function syncVisual(){visualModel.elapsed=research.time;visualModel.handoffs=research.summary().complete;businessJobs=businessMotion.update(workspaceSim,tradingDesk.snapshot(),research);visualModel.coordinationJobs=mergeMotionJobs(businessJobs,researchMotionJobs(research));visualModel.visualRoles=businessJobs.flatMap(j=>j.roles);}

function animate(now){if(disposed)return;const dt=previousTime?Math.max(0,(now-previousTime)/1000):.016;previousTime=now;tradingDesk.tick(Math.min(dt,.1));if(!paused){research.advance(Math.min(dt,.1)*speed,{busyRoles:businessJobs.flatMap(j=>j.roles)});if(!model.completed){model.advance(Math.min(dt,.1));tickSources(model);}}tradingDesk.discover(research);product.tick(dt);workbenchTerminal?.tick(dt);syncVisual();const visible=document.body.dataset.page==='workbench'&&(!small.matches||document.body.dataset.mobileView==='network');if(visible&&(!paused||globe.needsRender||needsPaint)){globe.update(visualModel,Math.min(dt,.2),!paused,{ambient:false,forceUI:needsPaint});needsPaint=false;}uiElapsed+=dt;if(uiElapsed>=.18&&document.body.dataset.page==='workbench'){renderUI();uiElapsed=0;}frame=requestAnimationFrame(animate);}
document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);if(!document.hidden){previousTime=performance.now();needsPaint=true;frame=requestAnimationFrame(animate);}});window.addEventListener('pagehide',e=>{cancelAnimationFrame(frame);if(e.persisted)researchJobs?.leave();else researchJobs?.destroy();if(!e.persisted){disposed=true;globe.dispose();}});window.addEventListener('pageshow',e=>{if(e.persisted){researchJobs?.resumeVisible();previousTime=performance.now();needsPaint=true;frame=requestAnimationFrame(animate);}});frame=requestAnimationFrame(animate);

const product=createProduct({getTeamContext:()=>({model:visualModel,running:!paused&&!stopped,reducedMotion:reducedMotion()}),onOpenResearch:symbol=>researchBoard.open(symbol),onResearchStart(){paused=false;stopped=false;needsPaint=true;},workspace:workspaceSim,researchModel:research,onHandoff(item){importedResearch=item;tradingDesk.handoff(item);},desk:tradingDesk,model,async research(market,item){if(tradingDesk.snapshot().state==='running')return '请先暂停当前模拟运行，再发起新的研究。';const symbol=market.split('/')[0];if(researchJobs){researchBoard.open(symbol);return pair('请在研究详情中确认开始研究。','Confirm the research request in its details.');}const error=await workspaceSim.requestResearch(symbol,{title:item?.title||market+' · 补充研究',href:routeSearch()});if(error)return error;paused=false;stopped=false;researchBoard.open(symbol);return null;},resize(){workbenchTerminal?.refresh();requestAnimationFrame(()=>globe.resize());}});

workbenchTerminal=createWorkbenchTerminal({research,privateUI,getHandoff:()=>importedResearch,getJobs:()=>visualModel.coordinationJobs,desk:tradingDesk,workspace:workspaceSim,onSelect(id){selected=id;globe.focus(id,false);needsPaint=true;if(small.matches){document.body.dataset.mobileView='network';window.dispatchEvent(new Event('resize'));}},onOpen:symbol=>researchBoard.open(symbol),onResize(){requestAnimationFrame(()=>{globe.resize();needsPaint=true;});}});
const immersiveButton=document.createElement('button');immersiveButton.type='button';immersiveButton.className='photonic-expand';immersiveButton.setAttribute('data-localized-ui','');
function setImmersive(value){document.body.dataset.photonicImmersive=String(value);immersiveButton.setAttribute('aria-pressed',String(value));immersiveButton.innerHTML=uiGlyph(value?'collapse':'expand');immersiveButton.title=value?pair('返回工作台','Return'):pair('全屏视图','Expand');immersiveButton.setAttribute('aria-label',immersiveButton.title);requestAnimationFrame(()=>globe.resize());}
immersiveButton.addEventListener('click',()=>setImmersive(document.body.dataset.photonicImmersive!=='true'));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.dataset.photonicImmersive==='true')setImmersive(false);});
document.querySelector('.stage-controls').prepend(immersiveButton);setImmersive(false);
document.querySelector('.terminal-data-toggle').addEventListener('click',()=>{if(document.body.dataset.photonicImmersive==='true')setImmersive(false);},{capture:true});
document.addEventListener('hive:locale',()=>setImmersive(document.body.dataset.photonicImmersive==='true'));
document.addEventListener('hive:workbench-information',()=>{if(document.body.dataset.photonicImmersive==='true')setImmersive(false);});

initLocale();
requestAnimationFrame(()=>window.__appPreload?.done());
