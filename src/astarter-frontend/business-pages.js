import {routeSearch} from './site-routes.mjs';
import {createBotHub} from './bot-hub.mjs?v=20261125a';
import {createWatchlist} from './watchlist-view.mjs';
import {workbenchAttention} from './workbench-console.mjs';
import {ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {protectionValid} from './strategy-protection.mjs';
import {friendlyText,formatSimulationTime as time} from './product-help.mjs';
import {riskStrategyExperience,ASTARTER_PREVIEW_VERSION} from './risk-strategy.mjs';
import {createStrategyJourneys,createStrategyCenter,strategyName,strategySuggestions} from './strategy-journeys.mjs?v=20261125d';
import {signalsExperience,createAISignals} from './intelligence-experience.mjs';
import {catalogExperience,runExperience,settingsExperience,usageExperience,inboxExperience} from './product-experience.mjs';
import {setupView} from './setup-view.mjs';
import {capabilityDirectory} from './platform-context.mjs';
import {executionView,scopeHeader,flowDetail,canReviewResearchChange,executionActionFeedback,executionActionError,executionEndView,executionCloseView,executionAccountView,patchExecutionPrices,spotAccountFigures,accountContextLabel} from './execution-views.mjs';
import {runActionError,executionRunIdentity,executionRenderStamp,scopeKey,scopeExecutionRecords} from './execution-stream.mjs';
import {botPlanFingerprint} from './strategy-routing.mjs';
import {mountCharts} from './product-chart-ui.mjs';
import {CATALOG,strategyById} from './strategy-catalog.mjs';
import {strategyFlowAvailable} from './strategy-execution-data.mjs';
import {pageHead} from './product-views.mjs';
import {BRAIN_PAGE_NAME,TRADING_PAGES,portfolio,accountOrders} from './product-data.mjs';
import {t,pair} from './locale.mjs';
import {PHASE_NAMES,RESEARCH_GROUPS} from './multi-research.mjs';
import {tokenIcon} from './brand-icons.mjs';
export function resumeReviewedResearch(desk,research,expectedRevision){
 const status=desk.syncStatus(),data=desk.snapshot();
 if(status.state!=='LIVE'||status.scope?.accountId!=='SIM-01'||status.scope?.environment!=='DEMO')return '请先恢复模拟账户的读取。';
 if(!canReviewResearchChange(data))return '当前状态不可恢复。';
 const item=research.handoff(data.session.market);if(!item)return '先完成当前研究核验。';
 if(expectedRevision&&item.revision!==expectedRevision)return '研究、连接或风控已变化，无法确认。';
 return desk.resumeReviewed(item);
}
export const BUSINESS_PAGES=['watchlist','advisor','copy-trading','contributions','signals','inbox','mandate','opportunities','strategies','my-strategies','validation','execution','risk','usage','plans','topup','staking','billing','settings','setup'];
export const DOMAINS=[
 {name:BRAIN_PAGE_NAME[0],en:BRAIN_PAGE_NAME[1],home:'brain',pages:['brain']},
 {name:'AI 战队',en:'AI team',home:'workbench',pages:['workbench']},
 {name:'策略交易',en:'Strategy Agents',home:'strategies',navPages:['strategies','execution'],pages:TRADING_PAGES},
 {name:'AI 信号',en:'AI signals',home:'signals',navPages:['signals','opportunities'],pages:['signals','opportunities']},
 {name:'数据中心',en:'Data center',home:'markets',pages:['markets','tracking','intelligence','social','derivatives','etf']},
 {name:'AI 助手',en:'AI Chat',home:'assistant',pages:['assistant']},
 {name:'AI 积分',en:'AI credits',home:'usage',navPages:['plans','topup','usage','billing'],pages:['plans','topup','usage','billing']},
 {name:'设置',en:'Settings',home:'settings',navPages:['settings'],pages:['settings','setup']}
];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number(v||0).toLocaleString('en-US',{maximumFractionDigits:2});
const button=(label,action,value='',primary=false,disabled=false,pressed=null)=>`<button type="button" class="p-button ${primary?'p-primary':''}" data-biz="${action}" data-id="${esc(value)}" ${pressed===null?'':`aria-pressed="${pressed}"`} ${disabled?'disabled':''}>${label}</button>`;
const goto=(label,page)=>button(label,'go',page);
const chip=(text,tone='neutral')=>`<span class="biz-chip ${tone}">${esc(text)}</span>`;
const empty=(text,action='')=>`<div class="biz-empty"><b>还没有记录</b><p>${text}</p>${action}</div>`;
const card=(title,body,extra='')=>`<section class="p-card ${extra}"><h2>${title}</h2>${body}</section>`;
const field=(title,name,value,type='number',extra='')=>`<label class="p-field">${title}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const select=(label,name,value,options)=>`<label class="p-field">${label}<select name="${name}">${options.map(([v,l])=>`<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('')}</select></label>`;
const modes=[['auto','AI 自动执行'],['review','入场前先批准'],['signal','只研究，不交易']];
const report=(rows)=>`<dl class="biz-report">${rows.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const stats=rows=>`<div class="biz-stats">${rows.map(([name,value,sub])=>`<div><span>${name}</span><strong>${value}</strong><small>${sub||''}</small></div>`).join('')}</div>`;
const table=(heads,rows,none,cls='')=>{const message=none||'完成一次操作后，这里会显示相同编号的记录。';return rows.length?`<div class="p-table-scroll"><table class="p-table ${cls}"><thead><tr>${heads.map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty(message);};
const stateNames={draft:'待演练',validating:'演练中',passed:'交互演练通过',blocked:'已阻断',cancelled:'已取消',running:'运行中',paused:'已暂停新开仓',stopped:'已停止',idle:'尚未启动',submitted:'已提交',partial:'部分成交',filled:'已成交','partial-cancelled':'部分成交后撤余',waiting:'待确认',skipped:'已跳过',expired:'已过期 / 跳过',notified:'仅通知',settled:'已结算',reserved:'已预留',unknown:'回执未知 · 待对账',rejected:'已拒绝'};
const state=(v)=>chip(stateNames[v]||v,['passed','filled','settled'].includes(v)?'ok':['blocked','expired','rejected'].includes(v)?'bad':['unknown','paused'].includes(v)?'warn':'neutral');
const localized=pair;
const rankOpportunity=t=>t.phase==='complete'&&t.outcome==='candidate'&&t.domain==='Crypto'?0:t.phase!=='complete'?1:['conflict','missing'].includes(t.outcome)?2:3;
export function opportunityRows(tasks,accepts,filter='all'){const visible=tasks.filter(t=>accepts(t));const picked=filter==='active'?visible.filter(t=>t.phase!=='complete'):filter==='candidate'?visible.filter(t=>t.phase==='complete'&&t.outcome==='candidate'):filter==='attention'?visible.filter(t=>t.phase==='complete'&&['conflict','missing'].includes(t.outcome)):visible;return [...picked].sort((a,b)=>rankOpportunity(a)-rankOpportunity(b)||String(a.symbol).localeCompare(String(b.symbol)));}
export function handoffAllowed(task){return Boolean(task&&task.phase==='complete'&&task.outcome==='candidate'&&task.domain==='Crypto');}
export function signalStrategySource(record){
 if(!record)return null;
 const at=record.observedAt,recordedAt=at==null?null:record.clockKind==='simulation'?`SIM T+${Math.round(at)}s`:typeof at==='string'?Date.parse(at):at;
 return {type:'signal',id:record.signalId,revision:record.version,instrument:record.instrument,recordedAt,reason:record.condition||''};
}
export function blockReason(task){if(!task)return '没有符合条件的发现。';if(task.phase!=='complete')return '核心尚未汇总，不能交给策略执行。';if(task.domain!=='Crypto')return 'TradFi 目前只研究，不能进入模拟交易。';if(task.outcome==='conflict')return '存在反证，消除分歧前阻断执行。';if(task.outcome==='missing')return '证据待补，补齐前阻断执行。';if(task.outcome==='watch')return '结论是继续观察，不形成执行任务。';if(task.outcome==='context')return '这是市场背景，不能单独放行交易。';return '该结论不能单独放行模拟交易。';}
export function createBusinessPages({workspace:w,desk,research,onHandoff,onResearchStart,go,notify,show,root}){
 let executionMarket='all';
 let management=null,paintedManagement=null,cancelingSpotOrders=new Set();
 let editorOpen=false,riskScenario='crowded',riskMode='normal';
 let step=w.s.setupStep||1,filter='all',search='',validationScenario='normal',lastRenderClock=-1,selectedFinding='',selectedCatalog='S03';
 const privateRoute=()=>{const q=new URLSearchParams(globalThis.location?.search||'');return q.get('page')==='strategies'&&q.has('privateDraft')?{draftId:q.get('privateDraft'),sourceRequestId:q.get('sourceRequestId'),symbol:q.get('researchSymbol')}:null;};
 const center=createStrategyCenter({w,desk,root,go,refresh:()=>refresh(),notify,onResearchStart,onRecommendationSource:openRecommendationSource,openPage:(id,editor)=>{const params=new URLSearchParams(routeSearch());if(params.get('page')!=='strategies'||params.get('create')!==id||params.get('editor')!==editor)go('strategies',{create:id,editor});}});
 const botHub=createBotHub({w,desk,root,go,refresh:()=>refresh(),choose:(id,onReturn)=>center.openTemplate(id,onReturn,null,{fresh:true}),recommendations:()=>center.recommendations(),chooseRecommendation:(id,onReturn,options)=>center.chooseRecommendation(id,onReturn,options),show,renderInstances:(data,history)=>center.instancesView(data,history),renderSaved:()=>center.savedPlans(),renderLegacy:active=>active?execution(true):''});
 const watchlist=createWatchlist({workspace:w,research,root,go,refresh:()=>refresh(),notify});
 const aiSignals=createAISignals({w,desk,research,root,refresh:()=>refresh(),go,notify,onResearchStart,onStrategy:(id,onReturn,source)=>center.openTemplate(id,onReturn,signalStrategySource(source))});
 function openRecommendationSource(ref,onReturn){
  if(ref?.type==='signal')return aiSignals.openSource?.(ref,onReturn)===true;
  if(ref?.type!=='research')return false;
  const task=research.task(ref.asset);
  if(!task||task.id!==ref.taskId||research.revision(task)!==ref.revision||task.completed!==ref.asOf)return false;
  opDetail(ref.asset,onReturn,false);return true;
 }
 function openResearchStrategy(item,onReturn=null){
  const symbol=typeof item?.market==='string'?item.market.split('/')[0]:'',current=research.handoff(symbol);
  if(!current||current.taskId!==item?.taskId||current.revision!==item?.revision)return localized('研究状态已变化，请查看当前版本。','Research status has changed. Check the current version.');
  const suggestion=strategySuggestions(w).find(entry=>entry.symbol===symbol);
  if(!suggestion)return localized('当前研究暂无适用策略。','No matching strategy is available for this research.');
  const source={type:'research',id:current.taskId,revision:current.revision,instrument:{symbol},recordedAt:`SIM T+${Math.round(research.task(symbol)?.completed??current.at)}s`,reason:suggestion.reason};
  if(!center.openTemplate(suggestion.strategy,onReturn,source))return localized('来源信息不完整，请返回来源重新打开。','Source details are incomplete. Return to the source and reopen.');
  refresh();root.querySelector('[data-strategy][aria-checked="true"]')?.scrollIntoView({block:'nearest'});return null;
 }
 document.addEventListener('hive:workbench-strategy',event=>{
  if(document.body.dataset.page!=='workbench')return;
  const {kind,id,riskPreferenceRevision}=event.detail||{};
  if(typeof id!=='string'||!['recommendation','source','template','run','account'].includes(kind))return;
  const view=document.querySelector('.ops-workbench-tabs [aria-selected="true"]')?.dataset.opsView||'signals';
  const scrollTop=document.querySelector('.console-scroll')?.scrollTop||0,opener=document.activeElement;
  const back=()=>{if(document.body.dataset.page!=='workbench')go('workbench');document.dispatchEvent(new CustomEvent('hive:workbench-console',{detail:{view,scrollTop}}));if(opener?.isConnected)opener.focus({preventScroll:true});else document.querySelector('#ops-view-'+view)?.focus({preventScroll:true});};
  if(kind==='run'){openRun(id,{onReturn:back});return;}
  if(kind==='account'){if(id===desk.syncStatus()?.scope?.accountId)openAccount({onReturn:back});else notify(localized('账户已变化，请重新打开账户。','The account changed. Reopen the account.'),{tone:'error'});return;}
  if(kind==='source'){center.chooseRecommendation(id,back,{intent:'source'});return;}
  if(kind==='template'&&!strategyById(id))return;
  let defaultProtection=null;
  if(kind==='template'&&riskPreferenceRevision!==undefined){
   const preference=w.s.workbenchRisk,scope=desk.syncStatus()?.scope;
   if(!Number.isSafeInteger(riskPreferenceRevision)||riskPreferenceRevision<1||!preference||preference.revision!==riskPreferenceRevision||preference.accountId!==scope?.accountId||preference.environment!==scope?.environment||!preference.protection||!protectionValid(preference.protection)){
    notify(localized('风控配置已变化，请重新选择方案。','Risk settings changed. Select the plan again.'),{tone:'error'});return;
   }
   defaultProtection=structuredClone(preference.protection);
  }
  const opened=kind==='template'?center.openTemplate(id,back,null,{defaultProtection}):center.chooseRecommendation(id,back);
  if(opened)refresh();
 });
 const journeys=createStrategyJourneys({w,go,refresh:()=>refresh(),notify,onApply:id=>center.prepareDraft(id)});
 const getForm=(el)=>Object.fromEntries(new FormData(el).entries());
 function selected(){return w.draft()||w.s.drafts[0];}
 function brief(title,subtitle,actions='',section='本地模拟'){return pageHead(title,subtitle,actions,section);}
 function opportunities(){
  const accepted=research.tasks.filter(t=>research.accepts(t));
  const rows=opportunityRows(research.tasks,t=>research.accepts(t),filter);
  const active=rows.find(t=>t.symbol===selectedFinding)||rows[0];
  const tone=t=>t.phase!=='complete'?'info':t.outcome==='candidate'&&t.domain==='Crypto'?'ok':['conflict','missing'].includes(t.outcome)?'warn':'neutral';
  const phaseNames={queued:['等待资料','Waiting'],collect:['采集资料','Collecting'],verify:['小组检查','Team review'],queuedCore:['等待汇总','Queued for review'],core:['核心汇总','Core review'],complete:['研究完成','Reviewed']};
  const phase=t=>localized(...(phaseNames[t.phase]||[t.phase,t.phase]));
  const outcomeNames={candidate:['值得关注','Watch'],conflict:['存在分歧','Conflicting'],missing:['证据待补','Needs data'],watch:['继续观察','Watching'],context:['市场背景','Context']};
  const outcome=t=>t.phase!=='complete'?phase(t):localized(...(outcomeNames[t.outcome]||[t.outcome,t.outcome]));
  const rowTitle=t=>t.phase!=='complete'?phase(t):localized(...({candidate:t.domain==='Crypto'?['可交给策略','Ready for a strategy']:['研究线索','Research finding'],conflict:['信息存在分歧','Conflicting evidence'],missing:['还需要补充资料','More data needed'],watch:['继续观察','Watching for changes'],context:['相关市场背景','Market context']}[t.outcome]||[t.title,t.title]));
  const groupLabel=t=>localized(...([['市场结构','Market'],['链上生态','On-chain'],['情绪异动','Sentiment'],['全球权益','Equities'],['避险轮动','Rotation'],['宏观事件','Macro']][t.group]||['研究组','Team']));
  const evidence=active?.evidence.filter(e=>e.status!=='na')||[];
  const statusName={retain:'支持',context:'旁证',missing:'待补',conflict:'反证',pending:'采集中',collected:'已采集'};
  const signals=w.s.signals.slice(0,5);
  const ready=handoffAllowed(active);
  const ask=active&&ready?['ready','已汇总','机会已汇总','运行中的策略将根据配置与风险条件判断是否执行。']:active&&active.phase!=='complete'?['wait',phase(active),'尚未汇总','小组还在整理信息，暂时不用操作。']:active?['stop',outcome(active),'暂不交易',blockReason(active)]:null;
  return brief('机会发现','先看已汇总机会，再查看策略生成的信号与执行结果。',goto('管理运行策略','my-strategies'),'交易枢纽')+
   `<div class="biz-overview op-overview">${[['范围内',accepted.length,'当前研究范围'],[localized('进行中','In progress'),accepted.filter(t=>t.phase!=='complete').length,localized('采集、核验或汇总','Collection, checks or synthesis')],['可交给策略',accepted.filter(handoffAllowed).length,'已汇总的 Crypto 候选'],[localized('待处理信号','Pending signals'),w.s.signals.filter(s=>s.status==='waiting').length,localized('有新信号时再处理','Review when a new signal arrives')]].map(([l,v,sub])=>`<div><span>${l}</span><strong>${v}</strong><small>${sub}</small></div>`).join('')}</div>`+
   `<div class="biz-toolbar biz-toolbar-tight"><div class="p-segments" role="group" aria-label="发现状态">${[['all','全部'],['active','进行中'],['candidate','值得关注'],['attention','分歧 / 待补']].map(([v,l])=>button(l,'op-filter',v,false,false,filter===v)).join('')}</div><span class="biz-meta">同一研究版本 · 本地模拟</span></div>`+
   `<div class="biz-op-layout"><section class="p-card biz-op-list"><div class="biz-section-head"><h2>研究发现</h2><span>${rows.length} 条</span></div>${rows.map(t=>`<button type="button" class="biz-op-row ${active?.symbol===t.symbol?'active':''}" data-biz="op-select" data-id="${esc(t.symbol)}" aria-pressed="${active?.symbol===t.symbol}"><span class="biz-op-id"><b>${tokenIcon(t.symbol,{size:24})}${esc(t.symbol)}</b><small>${esc(groupLabel(t))} · ${esc(t.domain)}</small></span><span class="biz-op-text"><small>${t.phase==='complete'?`v${t.version}`:`${t.progress}%`}</small></span>${chip(outcome(t),tone(t))}<span class="biz-op-chevron">›</span></button>`).join('')||empty('换个筛选，或回到协作台看小组正在采集的资料。',goto('查看协作现场','workbench'))}</section>`+
   `<section class="p-card biz-op-detail">${active&&ask?`<div class="decision-card ${ask[0]}"><span>${ask[1]}</span><h2>${tokenIcon(active.symbol,{size:30})}${esc(active.symbol)} · ${ask[2]}</h2><p>${esc(active.phase==='complete'?active.thesis:ask[3])}</p><div class="p-actions">${ready?button(localized('查看模拟方案','Review demo trade'),'op-plan',active.symbol,true):''}${button('查看证据','op-detail',active.symbol,false,!evidence.length)}</div></div><div class="op-evidence-flow" aria-label="研究进度">${[['collect',localized('采集','Collect')],['verify',localized('检查','Review')],['core',localized('汇总','Synthesis')],['complete',localized('结论','Conclusion')]].map(([key,title],i)=>`<span class="${({queued:-1,collect:0,verify:1,queuedCore:1,core:2,complete:3}[active.phase]??-1)>=i?'done':''}"><i>${({queued:-1,collect:0,verify:1,queuedCore:1,core:2,complete:4}[active.phase]??-1)>i?'✓':i+1}</i>${title}</span>${i<3?'<b>›</b>':''}`).join('')}</div><div class="op-evidence-summary"><span><b>${evidence.filter(e=>e.status==='retain').length}</b> 支持</span><span><b>${evidence.filter(e=>e.status==='conflict').length}</b> 分歧</span><span><b>${evidence.filter(e=>e.status==='missing').length}</b> 待补</span></div><details class="decision-more"><summary>${esc(rowTitle(active))} · ${evidence.length} ${localized('项证据','evidence items')}</summary>${active.phase==='complete'?'':`<div class="biz-progress" aria-hidden="true"><i style="width:${Math.max(4,Math.min(100,active.progress))}%"></i></div>`}<div class="biz-evidence-list">${evidence.map(e=>`<div><i class="${e.status}"></i><b>${esc(e.name)}</b><span>${esc(statusName[e.status]||e.status)}</span></div>`).join('')||'<p class="p-footnote">这一组还在排队，证据会在采集开始后写入。</p>'}</div><div class="p-actions">${active.phase==='complete'?button('追加深度核验 · 最多 '+w.quote(8)+' 积分','research',active.symbol):goto('查看协作现场','workbench')}</div></details>`:empty('没有符合当前筛选的发现。',goto('查看协作现场','workbench'))}</section></div>`+
   `<section class="p-card biz-signal-section"><div class="biz-section-head"><div><h2>信号收件箱</h2><p>信号由已启动的模拟实例产生；发现本身不等于订单。</p></div>${goto('完整执行记录','logs')}</div>${table(['信号 / 交易','资产 / 方式','处理状态','去向'],signals.map(s=>[`${esc(s.id)}<small>${esc(s.runId)}</small>`,`${esc(s.market)}<small>${modes.find(m=>m[0]===s.mode)?.[1]||s.mode}</small>`,state(s.status),goto('查看执行','execution')]),'模拟实例启动后，信号会在这里与执行记录对应。','signal-ledger')}</section>`;
 }
 function strategies(){
  const rows=CATALOG.filter(s=>(filter==='all'||s.kind===filter)&&`${s.id} ${s.name}`.toLowerCase().includes(search.toLowerCase()));
  const active=rows.find(s=>s.id===selectedCatalog)||rows[0];
  const spot=CATALOG.filter(s=>s.execution==='spot').length;
  return brief('合同库','更换授权时从这里复制。复制后要重新演练，旧版本不能再接管。未适配的不能创建现货委托，不展示胜率。',goto('查看交易方式','mandate'),'授权')+
   `<div class="biz-overview">${[['研究合同',CATALOG.length+' 条','原版与子版可追溯'],['可演练现货',spot+' 条','仅固定前端剧本'],['研究专用',CATALOG.length-spot+' 条','不能创建现货委托'],['已保存的策略',w.s.drafts.length+' 份','参数与风控版本锁定']].map(([l,v,sub])=>`<div><span>${l}</span><strong>${v}</strong><small>${sub}</small></div>`).join('')}</div>`+
   `<div class="biz-toolbar biz-toolbar-tight"><div class="p-segments" role="group" aria-label="策略类别">${[['all','全部策略'],['technical','结构与技术'],['event','事件与情报']].map(([v,l])=>button(l,'strategy-filter',v,false,false,filter===v)).join('')}</div><input class="biz-search" id="biz-strategy-search" aria-label="搜索策略" placeholder="搜索编号、名称" value="${esc(search)}"></div>`+
   `<div class="biz-strategy-layout"><section class="p-card biz-strategy-list"><div class="biz-section-head"><h2>策略目录</h2><span>${rows.length} 条匹配</span></div>${rows.map(s=>`<button type="button" class="biz-strategy-row ${active?.id===s.id?'active':''}" data-biz="strategy-select" data-id="${esc(s.id)}" aria-pressed="${active?.id===s.id}"><span class="biz-code">${esc(s.id)}</span><span><b data-localized-ui>${esc(s.name)}</b><small>${esc(s.timeframe)}</small></span>${chip(s.execution==='spot'?'现货演练':'执行未适配',s.execution==='spot'?'ok':'warn')}</button>`).join('')||empty('没有匹配的策略。调整类别或搜索词。')}</section>`+
   `<section class="p-card biz-strategy-detail">${active?`<div class="decision-card ${active.execution==='spot'?'ready':'stop'}"><span>${esc(active.id)}</span><h2 data-localized-ui>${esc(active.name)}</h2><p>${active.execution==='spot'?'复制为已保存的策略。先检查这些设置，再用于交易。合同正文保留中文。':'执行未适配。可以阅读和复制，不能创建现货委托。'}</p><div class="p-actions">${button('复制为我的策略','copy',active.id,true)}</div></div><ol class="handoff-steps"><li class="on"><b>1</b><span>核对条件</span></li><li><b>2</b><span>复制个人版</span></li><li><b>3</b><span>演练后使用</span></li></ol><div data-localized-ui><p class="biz-op-thesis">${esc(active.market)} · ${esc(active.timeframe)}</p><div class="biz-contract-grid"><div><span>形成条件</span><p>${esc(active.setup)}</p></div><div><span>风险边界</span><p>${esc(active.risk)}</p></div></div><details><summary>入场、退出与数据依赖</summary>${report([['入场',esc(active.entry)],['退出',esc(active.exit)],['数据',esc(active.data)],['验证',esc(active.validation)]])}</details></div><div class="biz-next"><b>实施状态</b><p>${active.execution==='spot'?'可复制后做前端现货演练。真实指标、历史回测与交易引擎均未接入。':'执行未适配。可以阅读和复制研究合同，不能创建普通现货委托。'}</p></div><div class="p-actions">${button('查看完整规则','strategy-detail',active.id)}</div>`:empty('选择一条策略查看条件与风险。')}</section></div>`;
 }
 function myStrategies(){const d=selected(),s=strategyById(d.strategy);return `<div data-localized-ui><div class="ux-editor-summary"><h3>${esc(d.strategy)} · ${esc(d.name.replace('（冻结原版）',''))}</h3><p>${localized('修改下次启动使用的设置，不会改变正在运行的交易。保存后再检查。','Edit settings for the next start. Existing trades keep their settings. Save, then run a new check.')}</p></div><form id="biz-draft-form" data-draft="${d.id}"><div class="p-two">${field(localized('单笔金额 / USDT','Per order / USDT'),'amount',d.amount,'number','min="10" max="1000" step="any"')}${field(localized('这套策略最多用 / USDT','Strategy allocation / USDT'),'cap',d.cap,'number','min="10" max="3000"')}</div>${select(localized('交易方式','Trading mode'),'mode',d.mode,[['signal',localized('只提醒我','Notify me')],['confirm',localized('每笔先问我','Ask before each order')],['auto',localized('自动模拟交易','Automatic simulation')]])}<div class="p-actions"><button class="p-button" type="submit">${localized('保存设置','Save settings')}</button>${button(localized('检查已保存设置 · 最多 ','Check saved settings · up to ')+w.quote(20)+localized(' 积分',' credits'),'validate',d.id,true,d.status==='validating')}</div><p class="p-footnote">${localized('先检查，再决定是否启动。检查使用体验积分，不会下单。','Check first, then decide whether to start. Checking uses demo credits and creates no order.')}</p></form><details class="ux-detail-rules"><summary>${localized('查看策略规则与版本','Strategy rules & version')}</summary><p>${d.id} · v${d.version} · risk v${d.riskVersion}</p><div data-localized-ui>${report([['入场',esc(s.entry)],['退出',esc(s.exit)],['风险',esc(s.risk)]])}</div><p>${localized('当前使用固定模拟信号和成交，未接入真实指标或历史回测。','Uses scripted signals and fills. Live indicators and historical backtests are not connected.')}</p></details><div class="p-actions">${button(localized('查看最近检查','View latest check'),'validation-detail',d.validationId||'',false,!d.validationId)}${button(localized('继续启动设置','Continue setup'),'setup-draft',d.id,true)}</div></div>`;}
 function validation(){const runs=w.s.validations,v=w.s.selectedValidation?runs.find(x=>x.id===w.s.selectedValidation):runs[0];const draft=v?w.draft(v.draftId):selected(),stale=v?.status==='passed'&&(!draft||v.version!==draft.version||v.riskVersion!==w.s.risk.version);return `<div data-localized-ui>${brief(localized('策略检查','Strategy check'),localized('看看设置是否齐全、能不能开始模拟交易。','Check whether your settings are ready for simulated trading.'),goto(localized('我的策略','My strategies'),'my-strategies'))}<div class="biz-split">${card(localized('检查记录','Recent checks'),runs.length?runs.map(x=>`<button class="biz-list-button" aria-pressed="${x.id===v?.id}" data-biz="validation-detail" data-id="${x.id}"><span><b>${w.draft(x.draftId)?.strategy||x.draftId} · v${x.version}</b><small>${time(x.at)} · ${x.id}</small></span>${chip(localized(...({passed:['通过','Passed'],blocked:['需要调整','Needs changes'],running:['检查中','Checking'],cancelled:['已取消','Cancelled']}[x.status]||['待检查','Pending'])),x.status==='passed'?'ok':'neutral')}</button>`).join(''):empty(localized('还没检查过。先选一套策略并保存设置。','No checks yet. Choose a strategy and save its settings first.'),goto(localized('去选策略','Choose a strategy'),'strategies')))}${card(v?localized('本次检查','This check')+' · '+esc(v.id):localized('选择一条检查记录','Choose a check'),v?`<div class="decision-card ${stale?'wait':v.status==='passed'?'ready':v.status==='blocked'?'stop':'wait'}"><h3>${stale?localized('设置已变化，需要重新检查','Settings changed; check again'):localized(...({passed:['设置已通过检查','Your settings passed'],blocked:['还需要调整','Changes are needed'],running:['正在检查，请稍等','Checking your settings'],cancelled:['已取消检查','Check cancelled']}[v.status]||['等待检查','Waiting to check']))}</h3><p>${stale?localized('这条记录对应旧设置，请检查当前版本。','This check covers older settings. Check the current version.'):v.status==='passed'?localized('可以继续设置启动。检查通过不代表有收益，也不会立即下单。','Continue to setup. Passing does not imply profit or place an order.'):v.status==='blocked'?localized('有需要的数据尚未准备好，请补齐后重新检查。','Required data is missing. Resolve it before checking again.'):v.status==='cancelled'?localized('未使用的暂占积分已退回，需要时可重新开始。','Unused held credits are released. Run the check again when ready.'):localized('正在检查配置、数据与账户。完成后会显示下一步。','Checking settings, data and your account. The next action appears when ready.')}</p></div><progress max="100" value="${v.progress}"></progress><ol class="biz-checklist">${[localized('策略设置是否齐全','Strategy settings'),localized('需要的数据是否可用','Required data'),localized('账户与资金是否合适','Account and money limits'),localized('交易记录是否完整','Trade record flow')].map((x,i)=>`<li><span>${v.status==='blocked'&&i===1?'!':v.progress>i*25?'✓':'○'}</span>${x}</li>`).join('')}</ol><div class="p-actions">${v.status==='running'?button(localized('取消检查，退回未用积分','Cancel & release unused credits'),'cancel-validation',v.id):v.status==='passed'&&!stale?button(localized('继续启动设置','Continue setup'),'setup-draft',v.draftId,true):button(localized('修改策略设置','Edit strategy settings'),'edit-draft',v.draftId,true)}${goto(localized('查看积分记录','View credit history'),'billing')}</div><details class="ux-detail-rules"><summary>${localized('查看检查细节','Check details')}</summary><p>${esc(v.reason||'')}</p>${report([[localized('策略版本','Strategy version'),`${draft?.strategy} / v${v.version}`],[localized('风险设置版本','Risk settings version'),`v${v.riskVersion}`],[localized('积分记录','Credit record'),v.usageId],[localized('检查方式','Check type'),localized('本地模拟流程，不是历史回测','Local simulation, not a historical backtest')]])}</details>`:`<p>${localized('检查策略设置、数据、资金限制和交易记录。不会下单，也不会测试策略收益。','Checks settings, data, money limits and trade records. It neither places orders nor evaluates returns.')}</p>${goto(localized('去设置策略','Set up a strategy'),'my-strategies')}`)}</div><details class="ux-detail-rules"><summary>${localized('试试数据缺失时会怎样','Try a missing-data scenario')}</summary><p>${localized('仅改变下一次检查的模拟场景。缺少数据会暂停启动，并退回未用积分。','Changes only the next simulated check. Missing data blocks starting and releases unused credits.')}</p><div class="p-segments">${button(localized('正常检查','Normal check'),'scenario','normal',validationScenario==='normal')}${button(localized('模拟数据缺失','Missing data'),'scenario','missing',validationScenario==='missing')}${button(localized('开始检查 · 最多 ','Run check · up to ')+w.quote(20)+localized(' 积分',' credits'),'validate',selected().id,true)}</div></details></div>`;}
 function execution(legacyOnly=false){const data=desk.readSnapshot();if(!legacyOnly&&data?.botBook?.runs?.length&&!data.discovery?.armed&&!(data.session&&data.state!=='stopped'||data.position||data.pending))return center.nativeTrading();const d=w.draft(w.s.strategyCenterArmedDraftId),startup=data?.session&&w.s.usage.find(u=>u.id===data.session.usageId);return executionView({embedded:legacyOnly,data,marketFilter:legacyOnly?'all':executionMarket,credits:{start:startup?.status==='settled'?startup.settled:null,quote:w.account?0:w.quote(4),startup,tasks:w.account?.s.tasks||[]},status:desk.syncStatus(),researchReview:canReviewResearchChange(data)?{ready:Boolean(research.handoff(data.session.market))}:null,scenario:desk.snapshot().orderScenario,tradeDetails:aiSignals.protection({compact:true}),watchingDraft:d?{...d,name:strategyName(strategyById(d.strategy))}:null})+(legacyOnly?'':center.nativeInstances()+center.savedPlans());}
 function accountRisk(){const d=desk.snapshot(),r=w.s.risk,exposure=d.position?d.position.qty*d.position.price:0;return `<div data-localized-ui>${stats([[localized('账户上限','Account limit'),n(r.cap)+' <span class="metric-unit">USDT</span>',localized('所有策略共用','Shared by all strategies')],[localized('已买入金额','Amount invested'),n(exposure)+' <span class="metric-unit">USDT</span>',localized('按模拟成交价','At simulated fill prices')],[localized('等待完成','Pending orders'),d.pending?'1':'0',localized('结果未确认前不会重复下单','No duplicate order while unconfirmed')],[localized('累计手续费','Total fees'),d.totalFees.toFixed(4)+' <span class="metric-unit">USDT</span>',localized('本地模拟','Local simulation')]])}<div class="biz-split">${card(localized('设置资金上限','Set your limits'),`<form id="biz-risk-form">${field(localized('整个账户最多用 / USDT','Account allocation / USDT'),'cap',r.cap,'number','min="10" max="3000"')}${field(localized('累计亏损暂停线 / USDT','Simulation loss limit / USDT'),'dailyLoss',r.dailyLoss,'number','min="1" max="500"')}<p class="p-footnote">${localized('修改后需要重新检查策略，才会用于下一次启动。','Changed limits require a new strategy check before the next start.')}</p><button class="p-button p-primary" type="submit">${localized('保存上限','Save limits')}</button></form>`)}${card(localized('持仓操作','Position actions'),`<h3>${d.pending?localized('先等这笔订单确认','Wait for the pending order'):d.position?localized('已有持仓，可以继续观察','You have an open position'):localized('当前没有持仓','No open position')}</h3><p>${localized('暂停买入不会自动卖出。卖出已有持仓会提交一笔模拟卖单。','Pausing buys does not sell holdings. Selling creates a simulated sell order.')}</p><div class="p-actions">${button(localized('暂停买入','Pause buys'),'trade','pause',false,!['running','blocked'].includes(d.state))}${button(localized('卖出已有持仓','Sell holdings'),'trade','close',false,!d.position||!!d.pending)}</div><details class="ux-detail-rules"><summary>${localized('暂停、保护与积分的关系','How pausing, protection and credits work')}</summary><p>${localized('积分不足只限制新的收费研究，已有持仓仍可退出。暂停和停止会撤销未成交的剩余订单，已成交的部分保留。刷新页面后，新的自动买入保持暂停。','Low credits stop new paid research, not exits. Pause and stop cancel unfilled remainders and retain filled positions. After refresh, automatic new buys remain paused.')}</p><p>${localized('损失按持续模拟会话累计，当前只产生手续费损失；不会每天自动清零。','Losses accumulate across the ongoing simulation session. Currently only fees produce losses; there is no automatic daily reset.')}</p></details>`)}</div></div>`;}
 function risk(){return riskStrategyExperience({w,desk,scenario:riskScenario,mode:riskMode,accountPanel:accountRisk()});}
 function usage(){const s=w.s,grouped=['策略流程演练','账户私有复核','深度核验'].map(k=>[k,s.usage.filter(u=>u.kind===k).reduce((n,u)=>n+u.settled,0)]);return brief('研究成本','预留、结算和释放分开记。预算为 0 时停止新的付费研究，已有持仓仍可退出。',button('补充 500 体验积分','topup','',true),'账本')+stats([['可用积分',n(w.available),'初始赠送 1,000'],['已预留',n(w.reserved),'完成或取消后结算'],['累计消耗',n(w.spent),'查看对应任务'],['本模拟日预算',n(s.budget.daily),'0 = 停止新付费任务']])+`<div class="biz-split">${card('使用分布',`<div class="biz-bars">${grouped.map(([k,v])=>`<div><span>${k}</span><div><i style="width:${w.spent?v/w.spent*100:0}%"></i></div><b>${v}</b></div>`).join('')}</div><p class="p-footnote">模拟日按运行累计 24 小时划分。补充按钮只增加体验积分，不产生付款。</p>`)}${card('预算与模型费用',`<form id="biz-budget-form">${field('每模拟日上限 / 体验积分','daily',s.budget.daily,'number','min="0" max="10000"')}<label class="biz-check"><input name="byok" type="checkbox" ${s.budget.byok?'checked':''}> 演练 BYOK 计价（适用积分 × 80%）</label><p class="p-footnote">只切换模拟计价，不保存密钥，也不向模型供应商付款。</p><button class="p-button p-primary" type="submit">保存预算</button></form>`)}</div>`+card('任务账单',table(['任务 / 引用','状态','预留','结算','释放','原因'],s.usage.map(u=>[`${button(u.id,'usage-detail',u.id)}<small>${u.kind} · ${esc(u.ref)}</small>`,state(u.status),u.reserved,u.settled,u.released,esc(u.reason||'等待任务完成')]),'','usage-ledger')+`<div class="p-actions">${button('导出模拟档案','export')}</div>`)+card('积分流水',table(['流水','事项','积分变动','关联任务'],s.creditEntries.map(c=>[c.id,esc(c.text),`${c.points>0?'+':''}${c.points}`,c.ref||'模拟赠送']),'','credit-ledger'));}
 function settings(){const c=desk.snapshot().connections;const items=[['exchange','交易账户','SIM-01 · 10,000 USDT 初始现金','模拟连接，不接收 API Key'],['data','研究数据','行情、宏观、舆情、链上固定样例','本地样例，不请求外部接口'],['ai','AI 角色与模型','18 个角色 · 规则剧本','无真实推理，不保存密钥'],['wallet','链上钱包','未读取地址，也不发起签名','开关只改变演示状态'],['notifications','执行通知','站内信号、委托与风险回报','关闭页面后不继续推送']];return capabilityDirectory()+brief('模拟资源','按资源逐项检查。每一项都是模拟连接，这里不能填写真实密钥或钱包私钥。',goto('重新查看五步引导','setup'),'账本')+`<section class="settings-board"><header><div><h2>模拟资源</h2><p>这些开关只改变本地演示状态，不接收真实密钥或钱包签名。</p></div></header><ol class="settings-tasks">${items.map(([k,label,desc,limit],i)=>`<li><span>${String(i+1).padStart(2,'0')}</span><div><b>${label}</b><small>${desc}</small><em>${limit}</em></div>${chip(c[k]?'示例已启用':'未启用',c[k]?'ok':'neutral')}${button('检查与配置','connections',k)}</li>`).join('')}</ol></section>`+`<div class="biz-split">${card('本地档案',`<p>${esc(w.persistenceError||'草稿、模拟账本与积分保存在本浏览器。刷新不会自动恢复开仓。')}</p><div class="p-actions">${button('导出完整模拟档案','export')}${goto('积分与用量','usage')}</div>`)}${card('尚未接入',report([['登录与多用户','当前是单用户本地模拟'],['外部行情','接口预留；页面数据仍是固定样例'],['交易执行','不连接 Nautilus、交易所或链上网络。'],['算力贡献','未开放密钥接收、共享或奖励。']]))}</div>`;}
 function setup(){return setupView(w,step);}

 function inbox(){
  const data=desk.readSnapshot?desk.readSnapshot():desk.snapshot(),access=desk.access?.({operation:data?.session?.mode==='signal'?'observe':'entry'});
  const items=workbenchAttention(data,access).map(item=>({
   tone:['unknown','protection','blocked'].includes(item.id)?'stop':'wait',kicker:item.id==='connection'?localized('账户接入','Account access'):localized('Agent 执行','Agent execution'),title:item.title,body:item.text,
   actions:[[item.cta,item.action==='connect'?'connections':item.action==='reconcile'&&!item.disabled?'trade':'go',item.action==='connect'?'exchange':item.action==='reconcile'&&!item.disabled?'reconcile':'execution',true]]
  }));
  return inboxExperience(items);
 }

 function mandate(){
 const d=selected(),r=w.s.risk,run=desk.snapshot();
 const checked=d.status==='passed'&&d.validatedVersion===d.version&&d.riskVersion===r.version&&strategyFlowAvailable(d)&&['auto','review','signal'].includes(d.mode);
 const busy=Boolean(run.session&&run.state!=='stopped'||run.position||run.pending);
 const mode=localized(...({signal:['只研究与提醒','Research & alerts'],review:['入场前先批准','Approve new entries'],confirm:['旧版逐笔确认','Legacy per-order approval'],auto:['自动模拟交易','Automatic simulation']}[d.mode]||['需要更新执行设置','Update execution settings']));
 const explanation=localized(...({
  signal:['只给你发送信号，不会下单。','You receive signals only. No orders are created.'],
  review:['每次入场先由你批准；成交后按方案执行止损、止盈和退出。','Approve each new entry. After a fill, the plan handles stop-loss, take-profit and exits.'],
  auto:['按保存的金额和限制模拟交易，最多处理 3 个信号后暂停。','Trade with saved amounts and limits in simulation, then pause after up to three signals.']
 }[d.mode]||['请重新选择交易方式，再检查并启动。已有持仓保留。','Choose an execution mode, then check and start again. Existing positions remain open.']));
 return `<div data-localized-ui>${brief(localized('交易方式','Trading mode'),localized('机会出现时，由你确认，或按设置自动处理。','Decide whether to approve each opportunity or let saved rules handle it.'),goto(localized('修改设置','Change settings'),'my-strategies'))}<section class="decision-card ${busy?'wait':checked?'ready':'stop'}"><span>${localized('当前设置','Current settings')}</span><h2>${mode}</h2><p>${explanation}</p><div class="p-actions">${goto(localized('修改交易方式','Change trading mode'),'my-strategies')}${goto(localized('调整资金上限','Adjust limits'),'risk')}</div></section>${stats([[localized('研究范围','Research universe'),w.s.scope==='all'?'Crypto + TradFi':w.s.scope==='crypto'?'Crypto':'TradFi',localized('TradFi 暂时只做研究','TradFi is research only')],[localized('单笔金额','Per-order amount'),n(d.amount)+' USDT',localized('每次买入的金额','Amount for each buy')],[localized('这套策略最多用','Strategy allocation'),n(d.cap)+' USDT',localized('该策略的总限制','Total strategy limit')],[localized('账户上限','Account limit'),n(r.cap)+' USDT',localized('所有策略共用','Shared account limit')]])}${card(localized('下一次机会来了怎么办？','What happens at the next opportunity?'),`<p>${busy?localized('当前还有运行任务、持仓或未完成订单，处理完后才会开始下一项。','A run, position or pending order is still open. Finish it before starting another opportunity.'):checked?localized('设置已检查，可以从初始设定开启机会观察。','Settings are checked. Start watching for opportunities from setup.'):localized('先完成策略检查，再开启模拟交易。','Complete the strategy check before starting simulation.')}</p><div class="p-actions">${goto(busy?localized('查看当前交易','View current activity'):checked?localized('继续启动设置','Continue setup'):localized('去检查策略','Check my strategy'),busy?'execution':checked?'setup':'my-strategies')}</div><details class="ux-detail-rules"><summary>${localized('查看当前配置记录','View configuration record')}</summary><p>${d.strategy} / v${d.version} · ${d.id} · risk v${r.version}</p><p>${localized('自动模式仍受资金和保护限制。交易结果未确认时，不会重复下单。','Automatic mode still obeys capital and protection limits. Unconfirmed trades are never resubmitted.')}</p></details>`)}</div>`;
 }
 function render(page){if(!BUSINESS_PAGES.includes(page))return null;if(page==='strategies'&&privateRoute()&&w.privateDrafts){center.render('workbench');return w.privateDrafts.render();}w.privateDrafts?.leave();if(page==='watchlist')return watchlist.render();const botPage=botHub.render(page);if(botPage!==null)return botPage;const strategyCenter=center.render(page);if(strategyCenter!==null)return strategyCenter;const journey=journeys.render(page);if(journey!==null)return journey;if(page==='setup')step=w.s.setupStep||1;if(page==='signals')return aiSignals.render();if(page==='strategies')return catalogExperience({w,filter,search,selectedCatalog});if(page==='my-strategies')return runExperience({w,desk,editor:editorOpen?myStrategies().replace(/<header class="p-head">[\s\S]*?<\/header>/,''):''});if(page==='settings')return settingsExperience({w,desk});if(page==='usage')return usageExperience(w);return ({inbox,mandate,opportunities,strategies,'my-strategies':myStrategies,validation,execution,risk,usage,settings,setup}[page])();}
 function opDetail(symbol,onReturn=null,select=true){const task=research.task(symbol);if(!task)return;if(research.mode==='live_readonly'&&w.researchJobs){void w.researchJobs.open(symbol);show(symbol+' · '+localized('行情研究','Market research'),`<p>${esc(task.thesis)}</p>${w.researchJobs.render(symbol)}`,onReturn);return;}if(select)w.selectOpportunity(symbol);const ready=handoffAllowed(task);show(`${symbol} · ${task.phase==='complete'?task.title:PHASE_NAMES[task.phase]}`,`<p>${esc(task.thesis)}</p><details class="op-provenance"><summary>${localized('研究记录','Research record')}</summary>${chip(research.revision(task))}<p class="p-footnote">${time(research.time)} · ${task.completed===null?'尚未汇总':'汇总于 '+time(task.completed)} · 新证据或版本变化即失效</p></details>${task.evidence.length?report(task.evidence.map(e=>[e.name,`${esc(e.text||'该资产不适用')}<small> · ${esc(e.source)} / ${{retain:'保留',context:'旁证',missing:'待补',conflict:'分歧',pending:'等待采集',collected:'已采集',na:'不适用'}[e.status]}</small>`])):'<p>证据尚未写入。</p>'}<div class="biz-next"><b>${ready?'下一步':'阻断原因'}</b><p>${esc(ready?task.next:blockReason(task))}</p></div><div class="p-actions">${ready?button(localized('查看适用策略','View matching strategy'),'op-plan',symbol,true):''}${button('补充研究 · '+w.quote(8)+' 积分','research',symbol,false,task.phase!=='complete')}</div>`,onReturn);bind(document.querySelector('.product-dialog'));}
 function useDraft(id){
  const draft=w.draft(id);if(!draft)return localized('请先选择策略。','Choose a strategy first.');
  const data=desk.snapshot();if(data.discovery?.armed||data.session&&data.state!=='stopped'||data.position||data.pending){go('execution');return null;}
  center.openDraft(id,false,'auto');return null;
 }

 function managementState(){
  const status=desk.syncStatus(),data=desk.readSnapshot(),ctx=management;
  if(!ctx)return {status,data};
  if(ctx.accountId!=='SIM-01'||ctx.environment!=='DEMO')return {status,issue:localized('此账户或环境尚未接入，请从已连接的模拟账户重新打开。','This account or environment is not connected. Reopen from the connected demo account.')};
  if(ctx.scope!==scopeKey(status.scope||{})||ctx.workspace!==(w.account?.scope||''))return {status,issue:localized('账户已变化，请关闭后从当前账户重新打开。','The account changed. Close this view and reopen from the current account.')};
  if(!data)return {status,canReload:true,issue:localized('账户数据暂不可用，请重新读取。','Account data is unavailable. Reload the account feed.')};
  const account=data.accountSummary?.accountId||data.accountId;
  if(account&&account!==ctx.accountId||data.botSummary?.recoveryError)return {status,issue:localized('账户记录暂不可用，请核对原账户。','Account records are unavailable. Review the original account.')};
  if(ctx.type==='account')return {data,status};
  const run=data.botBook?.runs?.find(row=>row.id===ctx.id);
  if(ctx.native&&run&&run.plan.executionRoute.accountId===ctx.accountId&&run.environment===ctx.environment&&ctx.signature===botPlanFingerprint(run.plan))return {data,status,run};
  if(!ctx.native&&ctx.identity&&!runActionError(ctx.identity,data,status))return {data,status};
  return {status,issue:localized('原运行已不可用或版本已变化，请返回原运行重新打开。','The original run is unavailable or its version changed. Reopen it from the original run.')};
 }
 function paintManagement(force=false){
  const ctx=management;if(!ctx)return;const state=managementState(),{data,status,run,issue}=state,dialog=document.querySelector('.product-dialog');
  const spotStamp=rows=>(rows||[]).map(order=>[order.orderId,order.status,order.executedQty,order.strategy]);const stamp=JSON.stringify([ctx.tab,ctx.intent,ctx.detail,issue,status.state,status.scope,status.generation,ctx.type==='account'?[data?.position?.qty,data?.botBook?.runs?.map(run=>[run.id,run.quantity]),accountOrders(data||{}).map(order=>[order.id,order.status,order.filled,order.fee]),spotStamp(data?.connections?.spotBook?.orders),spotStamp(data?.connections?.spotBook?.history),data?.connections?.spotBook?.usdt,data?.connections?.spotBook?.btc,data?.connections?.spotBook?.btcPrice]:run?[run.status,run.pauseReason,run.endReason,run.endIntent,run.quantity,run.orders.map(order=>[order.id,order.status,order.filled,order.fee]),run.allocated,run.protectionDecision?.scope,run.protectionDecision?.action,run.protectionDecision?.reason,run.protectionDecision?.amount===0,(data.botBook.residentControl?.cancelRequests||[]).some(row=>row.runId===run.id&&row.state!=='RECONCILED')]:data?executionRenderStamp(data,status):null]);
  if(!force&&ctx.stamp===stamp){
   if(data&&ctx.type==='account'){const p=spotAccountFigures(data.connections?.spotBook)||portfolio(data);dialog?.querySelectorAll('[data-account-metric]').forEach(el=>{el.textContent=n(p[el.dataset.accountMetric]);});dialog?.querySelectorAll('[data-account-position-value]').forEach(el=>{const position=portfolio(data).positions.find(row=>row.runId===el.dataset.accountPositionValue);if(position?.nativeBot)el.textContent=n(position.inventoryValue)+' USD eq.';});}
   else if(data&&run){const pnl=Number(run.realizedPnl||0)+Number(run.unrealizedPnl||0),ended=['stopped','failed'].includes(run.status),values=[(pnl>=0?'+':'')+n(pnl),n(ended?run.returned:run.equity),n(ended?run.initialAllocation:run.allocated),n(run.fees)];dialog?.querySelectorAll('.bot-instance-metrics strong').forEach((el,i)=>{if(el.firstChild)el.firstChild.textContent=values[i];if(i===0){el.classList.toggle('profit',pnl>0);el.classList.toggle('loss',pnl<0);}});const mark=dialog?.querySelectorAll('.bot-instance-balance>span')?.[2];if(mark)mark.textContent=localized('模拟价格','Paper price')+' '+n(run.markPrice)+' USDT';}
   else if(data)patchExecutionPrices(dialog,data,status);
   return;
  }
  const sameView=paintedManagement===ctx;ctx.stamp=stamp;const active=document.activeElement,focused=ctx.returnFocus||(dialog?.contains(active)&&(active?.dataset?.biz||active?.dataset?.sc||active?.dataset?.flowId)?{...active.dataset}:null),scroll=sameView?dialog?.scrollTop||0:ctx.scrollTop||0,bodyScroll=sameView?dialog?.querySelector('.p-dialog-body')?.scrollTop||0:ctx.bodyScrollTop||0,expanded=[...(dialog?.querySelectorAll('details[open][data-persist-key]')||[])].map(el=>el.dataset.persistKey);
  ctx.dispose?.();
  let body=issue?`<p class="execution-manager-unavailable" role="status">${esc(issue)}</p>`:ctx.type==='account'?executionAccountView(data,ctx.tab):run?center.instancesView({...data,botBook:{...data.botBook,runs:[run]}},['stopped','failed'].includes(run.status)):ctx.detail?button(localized('返回运行','Back to run'),'management-back')+flowDetail(scopeExecutionRecords(data,ctx.identity),ctx.detail.type,ctx.detail.id).body:ctx.intent==='stop'?executionEndView(data,status,ctx.requestId):ctx.intent==='close'?executionCloseView(data,status):executionView({data,status,embedded:true});
  if(!issue&&status.state!=='LIVE')body=`<p class="execution-manager-unavailable" role="status">${localized('读取已中断，交易操作暂停。','The account feed is interrupted. Trading actions are paused.')}</p>`+body;
  body=`<div class="execution-management" data-management-type="${ctx.type}"><p class="execution-manager-context">${esc(accountContextLabel(ctx.accountId,ctx.environment,ctx.type==='account'?data?.connections?.spotBook:null))}${ctx.type==='run'?' · '+esc(ctx.id):''}</p>${body}<footer class="execution-manager-footer">${state.canReload||!issue&&status.state!=='LIVE'?button(localized('重新读取','Reload account'),'stream','retry'):''}${ctx.intent?button(localized('取消','Cancel'),'management-back'):button(localized('关闭','Close'),'management-close')}</footer></div>`;
  show(localized(ctx.type==='account'?'账户资产与订单':'运行详情',ctx.type==='account'?'Account holdings & orders':'Run details'),body,()=>{clearManagement(ctx);ctx.onReturn?.();});
  const host=document.querySelector('.product-dialog');paintedManagement=ctx;delete ctx.returnFocus;host?.classList.add('execution-management-dialog');bind(host);
  host?.querySelectorAll('[data-biz]').forEach(button=>{if(button.dataset.biz==='trade'&&['reconcile','cancel'].includes(button.dataset.id))button.dataset.managementOrder=data?.pending?.id||'';});
  host?.querySelectorAll('details[data-persist-key]').forEach(el=>{if(expanded.includes(el.dataset.persistKey))el.open=true;});
  if(status.state!=='LIVE')host?.querySelectorAll('[data-sc="bot-action"],[data-sc="bot-end"],[data-biz="trade"],[data-biz="stop-confirm"],[data-biz="close-position-confirm"]').forEach(button=>button.disabled=true);
  if(host){host.scrollTop=scroll;const body=host.querySelector('.p-dialog-body');if(body)body.scrollTop=bodyScroll;ctx.dispose=mountCharts(host);if(focused){const buttons=[...host.querySelectorAll('button')],same=buttons.find(button=>['sc','biz','id','kind','runId','flowId','orderId'].every(key=>button.dataset[key]===focused[key])),related=buttons.find(button=>focused.sc?button.dataset.sc===focused.sc&&button.dataset.id===focused.id:focused.runId&&button.dataset.biz===focused.biz&&button.dataset.runId===focused.runId);const target=same||related||host.querySelector('.p-dialog-head h2');if(target){if(target.tagName!=='BUTTON')target.tabIndex=-1;target.focus({preventScroll:true});}}}
 }
 function openManagement(type,id,{onReturn}={}){
  if(type==='run'&&(typeof id!=='string'||!id||id.length>160))return false;
  const status=desk.syncStatus(),data=desk.readSnapshot(),run=type==='run'?data?.botBook?.runs?.find(row=>row.id===id):null,identity=type==='run'?executionRunIdentity(data,status.scope):null;
  if(management){const dialog=document.querySelector('.product-dialog');management.scrollTop=dialog?.scrollTop||0;management.bodyScrollTop=dialog?.querySelector('.p-dialog-body')?.scrollTop||0;management.dispose?.();}management={type,id,tab:'holdings',intent:null,onReturn,scope:scopeKey(status.scope||{}),workspace:w.account?.scope||'',accountId:status.scope?.accountId,environment:status.scope?.environment,native:Boolean(run),signature:run?botPlanFingerprint(run.plan):null,identity:identity?.runId===id?identity:null};paintManagement(true);return true;
 }
 function clearManagement(ctx){
  if(management===ctx){management=null;paintedManagement=null;}
  ctx.dispose?.();document.querySelector('.product-dialog')?.classList.remove('execution-management-dialog');
 }
 document.addEventListener('hive:page-leave',()=>{if(management)clearManagement(management);});
 const openRun=(id,options)=>openManagement('run',id,options),openAccount=options=>openManagement('account',null,options);
 document.addEventListener('hive:locale',()=>{if(management)paintManagement(true);});
 document.addEventListener('hive:access',()=>{if(management)paintManagement(true);});
 function close(){document.querySelector('.product-dialog')?.close();}
 function refresh(){if(management)paintManagement(true);else go(null);}
 function moveSetup(target){
  step=target;w.s.setupStep=step;w.touch();refresh();
  root.querySelector('#biz-setup-form .setup-main h1')?.focus();
 }
 function revealDetail(selector){if(window.matchMedia('(max-width:700px)').matches)requestAnimationFrame(()=>root.querySelector(selector)?.scrollIntoView({behavior:'smooth',block:'start'}));}
 function bind(container=root){const input=privateRoute();if(input&&w.privateDrafts?.mount(container,input))return;watchlist.bind(container);aiSignals.bind(container);center.bind(container);journeys.bind(container);botHub.bind(container);const boundManagement=management&&container===document.querySelector('.product-dialog')?management:null;if(boundManagement)container.querySelectorAll('[data-sc]').forEach(button=>{const original=button.onclick;button.onclick=event=>{const state=managementState();if(management!==boundManagement||state.issue||state.status.state!=='LIVE'){paintManagement(true);return;}return original?.(event);};});container.querySelectorAll('[data-biz]').forEach(b=>b.onclick=async()=>{if(boundManagement&&management!==boundManagement){paintManagement(true);return;}const a=b.dataset.biz,id=b.dataset.id,runTarget=b.dataset.runId?{runId:b.dataset.runId,accountId:b.dataset.runAccount,environment:b.dataset.runEnvironment,connectionId:b.dataset.runConnection||null,instrumentId:b.dataset.runInstrument||null,profileId:b.dataset.runProfile||null,strategyVersion:b.dataset.runVersion||null}:null;let error=null,feedback=null;
  const managed=management&&container===document.querySelector('.product-dialog');
  if(managed&&a==='management-close'){close();return;}
  if(managed){const state=managementState();if(state.issue&&!(a==='stream'&&state.canReload)||state.status.state!=='LIVE'&&!['stream','account-tab'].includes(a)){paintManagement(true);return;}}
  if(managed&&b.dataset.managementOrder&&b.dataset.managementOrder!==desk.snapshot().pending?.id){paintManagement(true);notify(localized('原订单已变化，请核对当前记录后再操作。','The original order changed. Review the current record before acting.'),{tone:'error'});return;}
  if(managed&&a==='management-back'){management.detail=null;management.intent=null;paintManagement(true);return;}
  if(managed&&a==='go'){close();go(id);return;}
  if(managed&&a==='account-tab'){management.tab=id==='orders'?'orders':'holdings';paintManagement(true);return;}
  if(managed&&a==='cancel-spot-order'){
   if(!/^\d{1,20}$/.test(id)||cancelingSpotOrders.has(id))return;
   const open=desk.snapshot()?.connections?.spotBook?.orders?.find(order=>order.orderId===id);
   if(!open||!['S01','S02'].includes(open.strategy)||!['NEW','PARTIALLY_FILLED'].includes(open.status)){notify(localized('这笔订单不能撤销。','This order cannot be canceled.'),{tone:'error'});paintManagement(true);return;}
   cancelingSpotOrders.add(id);b.disabled=true;
   try{
    const response=await fetch('/api/trading-connections/cancel-order',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({orderId:id})});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.ok!==true){const message={'not-found':'没有找到这笔挂单。','not-strategy':'只有本策略挂出的订单可以撤销。','filled':'这笔订单已经成交。','trade-disabled':'当前账户不能撤单。','exchange-rejected':'交易所没有接受撤销。','sign-in-required':'请先连接钱包。'}[payload.error]||'这笔订单不能撤销。';notify(localized(message,'The order was not canceled.'),{tone:'error'});return;}
    notify(localized('已撤销这笔挂单。','The resting order was canceled.'),{tone:'success'});
    document.dispatchEvent(new CustomEvent('astarter:identity'));
   }catch{notify(localized('撤销没有完成。','The cancel did not finish.'),{tone:'error'});}
   finally{cancelingSpotOrders.delete(id);if(b.isConnected)b.disabled=false;}
   return;
  }
  if(managed&&a==='manage-run'){const parent=management;parent.returnFocus={...b.dataset};openRun(id,{onReturn:()=>{management=parent;paintManagement(true);}});return;}
  if(runTarget&&['trade','stop-confirm','close-position-confirm','approval-accept','approval-skip'].includes(a)&&runActionError(runTarget,desk.snapshot(),desk.syncStatus())){notify(localized('运行或账户已变化，请重新打开运行后再操作。','Run or account changed. Reopen the run before acting.'),{tone:'error'});refresh();return;}
  if(a==='op-plan'||a==='choose-op'){const search=routeSearch(),origin=document.body.dataset.page||'opportunities',error=openResearchStrategy(research.handoff(id),()=>{go(origin,{search,restore:true});opDetail(id);});if(error)notify(error);else close();return;}
  if(a==='signal-filter'){filter=id;refresh();return;}
  if(a==='signal-record'){const s=w.s.signals.find(x=>x.id===id);if(!s)return;go('logs',{orderId:s.runId});return;}
  if(a==='configure-preset'){let d=w.s.drafts.find(x=>x.strategy===id);if(!d){await w.createManagedDraft(id);d=w.draft();}if(!d)return;w.s.selectedDraftId=d.id;w.touch();close();center.openDraft(d.id);return;}
  if(a==='setup-draft'){const d=w.draft(id);if(!d){notify('这份策略已不存在，请重新选择。');return;}w.s.selectedDraftId=d.id;w.touch();center.openDraft(d.id);return;}
  if(a==='restart-setup'){const d=w.draft();if(d)center.openDraft(d.id);return;}
  if(a==='edit-draft'){if(!w.draft(id)){notify('这份策略已不存在，请重新选择。');return;}w.s.selectedDraftId=id;w.touch();center.openDraft(id);return;}
  if(a==='risk-scene'){riskScenario=id;refresh();return;}
  if(a==='risk-mode'){riskMode=id;refresh();return;}
  if(a==='risk-open'){const saved=w.s.astarterDrafts?.find(x=>x.id===id);if(saved)riskMode=saved.mode;go('risk');return;}
  if(a==='risk-save'){center.openDraft(w.s.selectedDraftId,true);return;}
  if(a==='close-editor'){editorOpen=false;refresh();return;}
  if(a==='disarm'){const error=desk.action('pause');refresh();notify(error||localized('已关闭机会等待。','Opportunity watching stopped.'),{tone:error?'error':'success'});return;}
  if(a==='review-position'){revealDetail('#contract-protection');return;}
  if(a==='stream'){const issue=desk.streamAction(id);if(issue)notify(issue,{tone:'error'});refresh();return;}
  if(a==='related-ledger'){close();go('logs',{orderId:id});return;}
  if(a==='go'){go(id);return;}if(a==='op-filter'||a==='strategy-filter'){filter=id;refresh();return;}
  if(a==='op-detail'){opDetail(id);return;}
  if(a==='op-select'){selectedFinding=id;w.selectOpportunity(id);refresh();revealDetail('.biz-op-detail');return;}
  if(a==='strategy-select'){selectedCatalog=id;refresh();revealDetail('.biz-strategy-detail');return;}
  if(a==='take'){w.selectOpportunity(id);error=useDraft(selected().id);if(error)notify(error,{tone:'error'});return;}
  if(a==='research'){error=await w.requestResearch(id);if(!error){onResearchStart?.();close();notify(localized('研究已开始，完成后会更新结论。','Research started. Findings update on completion.'),{tone:'success',action:()=>opDetail(id),actionLabel:localized('查看进度','View progress')});}refresh();}
  if(a==='copy'){const draft=await w.createManagedDraft(id);if(!draft){notify(localized('这套策略已不存在，请重新选择。','This strategy is no longer available.'),{tone:'error'});return;}close();center.openDraft(draft.id);return;}
  if(a==='select-draft'){if(!w.draft(id))return;w.s.selectedDraftId=id;w.touch();center.openDraft(id);return;}
  if(a==='strategy-detail'){const s=strategyById(id);show(s.name,`<div data-localized-ui>${chip(s.id+' / '+s.version)}${chip('研究合同 · 未回测')}${report([['适用市场',esc(s.market)],['建立条件',esc(s.setup)],['入场',esc(s.entry)],['退出',esc(s.exit)],['风险',esc(s.risk)],['数据依赖',esc(s.data)]])}</div>${button('复制为我的策略','copy',id,true)}`);bind(document.querySelector('.product-dialog'));return;}
  if(a==='validate'){const form=root.querySelector('#biz-draft-form');if(form){error=w.saveDraft(id,getForm(form));if(error){notify(error);return;}}const result=w.validate(id,validationScenario);error=result.error;if(!error){go('validation');return;}}
  if(a==='validation-detail'){if(id==='V-BUILTIN'){show('内置交互演练样例','<p>这是初始模拟配置，用于体验机会接管流程；没有历史回测或实际模型结果。复制或修改配置后，需要运行新的交互演练。</p>');return;}w.s.selectedValidation=id;go('validation');return;}
  if(a==='setup-research'){moveSetup(5);return;}
  if(a==='setup-validate'){const result=w.validateSetup();if(result.error)notify(result.error);else notify(w.account?localized('检查已开始，不扣 AI 积分。','Check started. No AI credits charged.'):'检查已开始，积分暂占中；没用完的会退回。');refresh();return;}
  if(a==='scenario'){validationScenario=id;refresh();return;}
  if(a==='cancel-validation'){w.cancelValidation(id);refresh();return;}
  if(a==='use-draft'){const form=root.querySelector('#biz-draft-form'),d=w.draft(id),f=form?getForm(form):null;if(f&&(Number(f.amount)!==d.amount||Number(f.cap)!==d.cap||f.mode!==d.mode)){notify('当前表单尚未保存，请保存新版本并完成演练。');return;}error=useDraft(id);}
  if(a==='execution-filter'){executionMarket=id;refresh();return;}
  if(a==='approval-accept'||a==='approval-skip'){const before=desk.snapshot();error=desk.action(a==='approval-accept'?'approve':'skip',id,{run:runTarget});if(!error)feedback=executionActionFeedback(a==='approval-accept'?'approve':'skip',before,desk.snapshot());refresh();if(error||feedback)notify(error?executionActionError(error):feedback.message,{tone:error?'error':feedback.tone});return;}
  if(a==='trade'&&id==='close'){const d=desk.snapshot();if(!d.position||d.pending){refresh();return;}if(managed){management.intent='close';paintManagement(true);return;}show(localized('确认平仓？','Close this position?'),executionCloseView(d,desk.syncStatus()));bind(document.querySelector('.product-dialog'));return;}
  if(a==='close-position-confirm'){error=desk.action('close',undefined,{run:runTarget,manual:true});if(error){notify(executionActionError(error),{tone:'error'});return;}if(managed)management.intent=null;else close();refresh();notify(localized('平仓已提交，等待成交。','Close submitted. Waiting for fills.'));return;}
  if(a==='trade'&&id==='stop'){if(managed){management.intent='stop';management.requestId=crypto.randomUUID();paintManagement(true);return;}show(localized('结束运行','End run'),executionEndView(desk.snapshot(),desk.syncStatus(),crypto.randomUUID()));bind(document.querySelector('.product-dialog'));return;}
  if(a==='stop-confirm'){
   const before=desk.snapshot(),requestId=b.dataset.requestId;
   error=desk.action('stop',undefined,{run:runTarget,intent:id,requestId});const after=desk.snapshot(),accepted=after.session?.endRequestId===requestId;
   if(error&&!accepted){notify(executionActionError(error),{tone:'error'});return;}
   const result=executionActionFeedback('stop',before,after);if(managed)management.intent=null;else close();refresh();notify(result?.message||executionActionError(error||localized('运行已结束。','Run ended.')),{tone:after.pending?'info':error?'error':'success'});return;
  }
  if(a==='review-research'){
   const data=desk.snapshot();if(!canReviewResearchChange(data)){refresh();return;}
   const item=research.handoff(data.session.market),task=research.task(data.session.market);
   if(!item){opDetail(data.session.market.split('/')[0]);return;}
   show(localized('恢复','Resume')+' '+esc(data.session.market),`<div data-localized-ui><h3>${esc(t(task.title))}</h3><p>${esc(t(task.thesis))}</p>${report([[localized('每次买入','Per order'),n(data.session.amount)+' USDT'],[localized('最多使用','Allocation limit'),n(data.session.cap)+' USDT'],[localized('交易方式','Trading mode'),localized(...({auto:['自动模拟交易','Automatic simulation'],confirm:['旧设置 · 需要更新','Legacy setup · update required'],review:['入场前先批准','Approve new entries'],signal:['只提醒我','Notify me']}[data.session.mode]||['只提醒我','Notify me']))]])}<p class="ux-form-feedback" data-research-resume-feedback role="alert"></p><div class="p-actions">${button(localized('恢复','Resume')+' · '+localized('免费','Free'),'research-resume-confirm',item.revision,true)}</div></div>`);
   bind(document.querySelector('.product-dialog'));return;
  }
  if(a==='research-resume-confirm'){const error=resumeReviewedResearch(desk,research,id);if(error){const feedback=document.querySelector('[data-research-resume-feedback]');if(feedback)feedback.textContent=friendlyText(error);return;}close();refresh();notify(localized('已恢复','Resumed'));return;}
  if(a==='trade'){if(['confirm','skip'].includes(id)){notify(localized('请在策略设置中选择 Agent 自动执行。','Choose Agent execution in strategy settings.'));return;}const sync=desk.syncStatus();if(sync.scope.accountId!=='SIM-01'||sync.scope.environment!=='DEMO'){notify('当前账户或环境尚未接入。',{tone:'error'});return;}if(sync.state!=='LIVE'&&!['reconcile','read'].includes(id)){notify('先恢复当前范围的读取，再处理交易动作。',{tone:'error'});return;}const before=desk.snapshot();error=desk.action(id,undefined,{run:runTarget});if(!error)feedback=executionActionFeedback(id,before,desk.snapshot());refresh();}
  if(a==='topup'){go('topup');return;}
  if(a==='connections'){desk.settings(id||'overview');return;}
  if(a==='setup-prev'){moveSetup(Math.max(1,step-1));return;}
  if(a==='usage-detail'){
   const u=w.s.usage.find(x=>x.id===id);if(!u)return;
   const v=w.s.validations.find(x=>x.usageId===u.id);
   const related=v?button(localized('查看这次检查','View this check'),'validation-detail',v.id,true):goto(u.kind==='深度核验'?'查看研究发现':'查看执行实例',u.kind==='深度核验'?'opportunities':u.kind==='跟随规则演练'?'copy-trading':'execution');
   show('任务账单 · '+u.id,report([['类型',esc(u.kind)],['关联对象',esc(u.ref)],['计价规则',u.priceVersion+(u.byok?' / BYOK 80% 向上取整':'')],['先暂占 / 实际使用 / 已退回',`${u.reserved} / ${u.settled} / ${u.released}`],['状态与原因',esc(u.reason||'等待完成')]])+related);
   bind(document.querySelector('.product-dialog'));return;
  }
  if(a==='export'){const blob=new Blob([JSON.stringify({mode:'simulation-only',workspace:w.s,membership:w.account?.s,trading:desk.snapshot(),research:research.snapshot()},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='hive-simulation-workspace.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已导出模拟档案，未包含任何真实凭据。');}
  if(error){const access=['trade','stop-confirm','start-execution'].includes(a)?desk.access?.({operation:id==='close'?'exit':'entry'}):null,copy=access&&!access.ready?ACCESS_COPY[access.code]:null;notify(a==='trade'?executionActionError(error):error,{tone:'error',action:copy?.[4]?()=>desk.recoverAccess(copy[4],access.profileId):null,actionLabel:copy?.[4]?localized(copy[5],copy[6]):''});}else if(feedback)notify(feedback.message,{tone:feedback.tone,action:feedback.orderId?()=>go('logs',{orderId:feedback.orderId}):null,actionLabel:localized('查看订单','View order')});
 });
 const scenarios=container.querySelector('.ux-risk-scenarios'),chosenScenario=scenarios?.querySelector('[aria-pressed=true]');
 if(chosenScenario&&scenarios.scrollWidth>scenarios.clientWidth)scenarios.scrollLeft+=chosenScenario.getBoundingClientRect().left-scenarios.getBoundingClientRect().left-16;
 container.querySelectorAll('[data-exec-context]').forEach(el=>el.onchange=()=>{desk.selectContext({[el.dataset.execContext]:el.value});refresh();});
 container.querySelectorAll('[data-flow-id]').forEach(el=>el.onclick=()=>{if(management&&container===document.querySelector('.product-dialog')){const current=managementState();if(current.issue){paintManagement(true);return;}management.detail={type:el.dataset.flowType,id:el.dataset.flowId};paintManagement(true);return;}const data=desk.readSnapshot();if(!data){notify('当前范围没有可读取的记录。');return;}const detail=flowDetail(data,el.dataset.flowType,el.dataset.flowId);show(detail.title,detail.body);bind(document.querySelector('.product-dialog'));});
 const f=container.querySelector('#biz-draft-form');if(f)f.onsubmit=e=>{e.preventDefault();const error=w.saveDraft(f.dataset.draft,getForm(f));notify(error||w.persistenceError||'已保存设置；修改后需重新演练。',{tone:error||w.persistenceError?'error':'success'});if(!error)refresh();};
 const r=container.querySelector('#biz-risk-form');if(r)r.onsubmit=e=>{e.preventDefault();const error=w.setRisk(getForm(r));notify(error||w.persistenceError||'风险版本已保存，后续新实例需重新演练。',{tone:error||w.persistenceError?'error':'success'});if(!error)refresh();};
 const b=container.querySelector('#biz-budget-form');if(b)b.onsubmit=async e=>{e.preventDefault();const f=getForm(b),error=await w.setBudget({daily:f.daily,byok:f.byok==='on'});notify(error||w.persistenceError||'模拟预算已保存。',{tone:error||w.persistenceError?'error':'success'});if(!error)refresh();};
 const scenario=container.querySelector('[name=orderScenario]');if(scenario)scenario.onchange=()=>{notify(desk.setScenario(scenario.value)||'下一笔模拟委托使用所选回报剧本。');};
 const q=container.querySelector('#biz-strategy-search');if(q)q.onchange=()=>{search=q.value;refresh();};
 const z=container.querySelector('#biz-setup-form');
 if(z){
  const arm=z.querySelector('[name=arm]'),submit=z.querySelector('button[type=submit]');
  if(arm&&submit){const reflectMode=()=>submit.textContent=arm.checked?localized('开启自动跟进','Start automatic follow-up'):localized('开始研究','Start research');arm.addEventListener('change',reflectMode);reflectMode();}
  const limits=()=>{
   const f=z.elements,amount=Number(f.amount?.value),strategyCap=Number(f.strategyCap?.value),cap=Number(f.cap?.value);
   f.strategyCap?.setCustomValidity(strategyCap>cap?localized('策略金额不能超过账户上限。','Strategy allocation cannot exceed the account limit.'):'');
   f.amount?.setCustomValidity(amount>strategyCap?localized('单笔金额不能超过策略总金额。','The order amount cannot exceed the strategy allocation.'):'');
   z.querySelectorAll('[aria-invalid="true"]').forEach(field=>{
    if(!field.validity.valid)return;
    field.removeAttribute('aria-invalid');
    const error=field.nextElementSibling;
    if(error?.classList.contains('setup-field-error')){
     const described=(field.getAttribute('aria-describedby')||'').split(' ').filter(id=>id&&id!==error.id);
     if(described.length)field.setAttribute('aria-describedby',described.join(' '));else field.removeAttribute('aria-describedby');
     error.remove();
    }
   });
  };
  z.addEventListener('invalid',e=>{
   const field=e.target;if(!field.matches('input,select'))return;
   for(let section=field.closest('details');section;section=section.parentElement?.closest('details'))section.open=true;
   e.preventDefault();field.setAttribute('aria-invalid','true');
   let error=field.nextElementSibling;
   if(!error?.classList.contains('setup-field-error')){
    error=document.createElement('small');error.className='setup-field-error';error.id=`setup-error-${field.name}`;
    field.insertAdjacentElement('afterend',error);
    field.setAttribute('aria-describedby',[field.getAttribute('aria-describedby'),error.id].filter(Boolean).join(' '));
   }
   error.textContent=field.validationMessage;
   if(field===z.querySelector(':invalid'))field.focus();
  },true);
  z.oninput=limits;limits();
 }
 if(z)z.onsubmit=async e=>{e.preventDefault();const f=getForm(z);let error=null;
  if(step===1)w.setSetupContext(f.connectorId);
  if(step===2){const entitlement=await w.ensureDraftEntitlement(w.draft(f.draftId));if(entitlement){notify(entitlement);return;}w.setScope(f.scope);w.s.selectedDraftId=f.draftId;const d=selected();error=w.saveDraft(d.id,{...d,mode:f.mode});}
  if(step===3){const daily=Number(f.daily),cap=Number(f.cap),loss=Number(f.dailyLoss),amount=Number(f.amount),strategyCap=Number(f.strategyCap);if(![daily,cap,loss,amount,strategyCap].every(Number.isFinite)||daily<0||daily>10000||cap<10||cap>3000||loss<1||loss>500||amount<10||amount>1000||strategyCap<amount||strategyCap>cap){notify(localized('请检查金额、额度和预算；策略敞口不能超过账户上限。','Check amounts and budgets. Strategy exposure cannot exceed the account limit.'));return;}const d=selected();const entitlement=await w.ensureDraftEntitlement(d);if(entitlement){notify(entitlement);return;}error=w.saveDraft(d.id,{...d,amount,cap:strategyCap})||w.setRisk({cap,dailyLoss:loss})||await w.setBudget({...w.s.budget,daily});}
  if(step===4&&!w.setupReady)error=localized('预检尚未通过或已经失效，请重新检查。','Precheck is missing or expired. Run it again.');
  if(error){notify(error);return;}w.touch();if(step<5){moveSetup(step+1);}else{if(f.arm==='on'){if(!w.setupReady){notify(localized('预检已失效，请返回检查。','Precheck expired. Go back and run it again.'));return;}desk.configure(selected());const gate=desk.arm();if(gate){notify(gate);return;}}w.s.started=true;w.touch();onResearchStart?.();go('workbench');notify(f.arm==='on'?'已准备好处理下一次机会，按你选择的方式运行。':'研究已开始。发现机会后，可在策略广场处理。');}};
 }
 return {render,bind,openRun,openAccount,beforeLeave:()=>w.privateDrafts?.beforeLeave()||center.beforeLeave(),openWatchlist:watchlist.open,closeWatchlist:watchlist.close,saveWatch:watchlist.save,signalSource:()=>aiSignals.sourceSnapshot(),openResearch:opDetail,openResearchStrategy,openSelectedStrategy(mode){const d=selected();if(d)center.openDraft(d.id,false,mode);},get setupLive(){return step===4;},resetFilter(){filter='all';},isPage:page=>BUSINESS_PAGES.includes(page),tick(dt){w.tick(dt,desk.snapshot());center.tick(dt);aiSignals.tick(dt);if(management)paintManagement();},get revision(){return w.revision;}};
}
