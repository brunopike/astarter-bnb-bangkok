import {walletBalance} from './wallet-balance.mjs';
import {createOpticalHeader,workbenchWalletMetric} from './workbench-optical-header.mjs?v=20261123s';
import {workbenchTracking,workbenchFilter,toggleWorkbenchWatch,activeWorkbenchOrders,readWorkbenchTargets,setWorkbenchTargets,focusWorkbenchAsset,renderWorkbenchTargets,bindWorkbenchTargets} from './workbench-targets.mjs';
export {workbenchTracking} from './workbench-targets.mjs';
import {createWorkbenchCharts} from './workbench-charts.mjs';
import {createWorkbenchConsole,createWorkbenchInformationDesk,workbenchOperationState,workbenchOperationLabel,workbenchPlainEvent} from './workbench-console.mjs?v=20261122e';
import {t} from './locale.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {L,label} from './execution-views.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {captureProductFocus,uiGlyph} from './product-composition.mjs';
import {escapeUI as esc} from './product-experience.mjs';

const groupNames=[['市场结构','Market structure'],['链上生态','On-chain'],['情绪异动','Sentiment'],['全球权益','Global equities'],['避险轮动','Defensive rotation'],['宏观事件','Macro events']];
const phaseNames={queued:['等待线索','Watching'],collect:['采集数据','Collecting'],verify:['交叉检查','Cross-checking'],queuedCore:['准备交接','Handoff queued'],core:['核心汇总','Core review'],complete:['已形成判断','Reviewed'],monitor:['持续扫描','Scanning']};
const number=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const wordmark=()=>`<span class="lenswave-wordmark">LENSWAVE</span>`;
const role=id=>'A'+String(id+1).padStart(2,'0');

export function renderWorkbenchWalletButton(balance,mobile=false){
 const tag=mobile?'strong':'b';
 return `<button type="button" data-terminal-action="wallet" aria-haspopup="dialog" aria-label="${esc(balance.description)}" title="${esc(balance.description)}"><small>${esc(balance.label)}</small><${tag} data-terminal-number="wallet">${esc(balance.amount)}</${tag}></button>`;
}

export function workbenchFeed(research,trade){
 const analysis=research.events.filter(event=>research.task(event.symbol)&&research.accepts(research.task(event.symbol))).slice(0,18).map(event=>({key:'research:'+event.id,stream:'research',sequence:event.id,symbol:event.symbol,kind:/采集|扫描/.test(event.text)?'market':'analysis',text:event.text,at:event.at}));
 const trading=(trade.events||[]).slice(0,18).map(event=>({key:'trade:'+event.id,stream:'trade',sequence:event.id,kind:event.kind==='risk'?'risk':'trade',text:event.text,at:event.at}));
 return [...analysis,...trading];
}

export class WorkbenchFeedCursor{
 constructor(){this.last={research:0,trade:0,source:-1};}
 accept(item){if(!Number.isFinite(item.sequence)||item.sequence<=this.last[item.stream])return false;this.last[item.stream]=item.sequence;return true;}
}

// Visual projections only: evidence changes never create research, credit or trading events.
export function workbenchTeamActivity(research,jobs=[],visibleTasks=research.tasks.filter(task=>research.accepts(task))){
 const visible=new Set(visibleTasks.map(task=>task.symbol));
 return RESEARCH_GROUPS.map((group,index)=>{
  const current=research.task(research.groups[index].task);
  const tasks=research.tasks.filter(task=>task.group===index&&research.accepts(task));
  const symbols=new Set(tasks.map(task=>task.symbol));
  for(const job of jobs){
   if(job.station!==index&&!(job.roles||[]).some(id=>group.roles.includes(id)))continue;
   for(const value of [job.symbol,...(job.subjects||[])])if(typeof value==='string')for(const symbol of value.split(/[\s/]+/))symbols.add(symbol);
  }
  const assets=research.tasks.filter(task=>symbols.has(task.symbol)&&research.accepts(task)&&visible.has(task.symbol));
  const task=current&&assets.includes(current)?current:assets.filter(t=>t.group===index&&t.phase==='complete').sort((a,b)=>(b.completed||0)-(a.completed||0))[0];
  const evidence=(task?.evidence||[]).filter(item=>item.status!=='na');
  return {group:index,task:task||null,assets,phase:task?.phase||'monitor',progress:task?.progress||0,evidence,available:assets.length>0};
 });
}
export function workbenchSourceRevisions(research){
 const result={};
 for(const task of research.tasks.filter(task=>research.accepts(task)))for(const item of task.evidence){
  if(['pending','na'].includes(item.status))continue;
  (result[item.key]??=[]).push(`${research.revision(task)}:${item.sourceId}:${item.status}`);
 }
 return Object.fromEntries(Object.entries(result).map(([key,items])=>[key,items.join('|')]));
}

export class WorkbenchUpdateQueue{
 constructor(){this.previous=new Map();this.pending=new Set();}
 read(values,active=true){
  const keys=new Set(Object.keys(values));
  for(const key of this.previous.keys())if(!keys.has(key)){this.previous.delete(key);this.pending.delete(key);}
  for(const [key,value] of Object.entries(values)){
   if(active&&this.previous.has(key)&&this.previous.get(key)!==value)this.pending.add(key);
   this.previous.set(key,value);
  }
  if(!active){this.pending.clear();return [];}
  const batch=[...this.pending].slice(0,2);for(const key of batch)this.pending.delete(key);return batch;
 }
 reset(){this.previous.clear();this.pending.clear();}
}

export function workbenchNextAction(trade,{draft,ready=false,scope='all',synced=true}={}){
 if(!synced)return 'account';
 if(trade.pending?.status==='unknown')return 'reconcile';
 if(trade.pending)return 'order';
 if(trade.signal&&trade.session?.mode==='confirm'&&trade.state==='running')return 'confirm';
 if(trade.position&&(!trade.session||trade.state==='stopped'))return 'position';
 if(trade.session&&trade.state!=='stopped')return ['paused','blocked'].includes(trade.state)?'paused':'running';
 if(trade.discovery?.armed)return 'watching';
 if(scope==='tradfi')return 'research';
 if(!draft||draft.validationId==='V-BUILTIN'&&draft.version===1)return 'choose';
 return ready?'start':'configure';
}

// A read-only projection: historical orders cannot complete a new research version.
export function workbenchFocus(research,trade,workspace,symbol,handoff=null){
 const tasks=research.tasks.filter(t=>research.accepts(t));
 const task=tasks.find(t=>t.symbol===symbol)||tasks.find(t=>t.phase==='complete'&&t.outcome==='candidate'&&t.domain==='Crypto')||tasks.find(t=>t.phase==='core')||tasks[0];
 if(!task)return {task:null,stages:[],orders:[],linked:false};
 const revision=research.revision(task),run=trade.session;
 const linked=Boolean(run?.researchRevision===revision&&run.market?.split('/')[0]===task.symbol);
 const handedOff=linked||Boolean(handoff?.revision===revision&&handoff.market?.split('/')[0]===task.symbol);
 const orders=linked?(trade.orders||[]).filter(o=>o.runId===run.id):[];
 const filled=orders.filter(o=>o.filled>0),unknown=orders.some(o=>o.status==='unknown');
 const complete=task.phase==='complete',candidate=complete&&task.outcome==='candidate'&&task.domain==='Crypto';
 const blocked=complete&&['conflict','missing'].includes(task.outcome);
 const draft=workspace.draft();
 const validated=Boolean(candidate&&(linked&&run.authorizationId||draft?.status==='passed'&&draft.validatedVersion===draft.version&&draft.riskVersion===workspace.s.risk.version));
 const issue=candidate&&draft?workspace.checkStart(draft):null;
 const sized=Boolean(validated&&(linked||!issue));
 const stages=[
  {state:task.phase==='queued'?'waiting':task.phase==='collect'?'active':'done',owner:RESEARCH_GROUPS[task.group].roles},
  {state:blocked?'blocked':complete?'done':['verify','queuedCore','core'].includes(task.phase)?'active':'waiting',owner:[12]},
  {state:linked&&run.authorizationId?'done':validated?'ready':candidate?draft?.status==='validating'?'active':'setup':'waiting',owner:[6,9,12]},
  {state:sized?linked?'done':'ready':validated?'blocked':'waiting',owner:[13,14]},
  {state:linked?unknown||trade.state==='blocked'?'blocked':trade.pending||trade.signal||trade.state==='running'?'active':orders.length?'done':'waiting':'waiting',owner:[15,16]},
  {state:filled.length?'done':'waiting',owner:[16,17]}
 ];
 return {task,revision,linked,handedOff,orders,filled,unknown,complete,candidate,blocked,draft,issue,stages};
}

export function workbenchEvents(research,task){
 const rows=research.events.filter(e=>e.symbol===task.symbol);
 const marker=new RegExp('\\bv'+task.version+'\\b');
 const start=rows.filter(e=>marker.test(e.text)).reduce((min,e)=>Math.min(min,e.id),Infinity);
 return rows.filter(e=>(!Number.isFinite(start)||e.id>=start)&&(task.started===null||e.at>=task.started)).slice(0,5);
}

export function createWorkbenchTerminal({research,desk,workspace,onSelect,onOpen,onResize,getJobs=()=>[],getHandoff=()=>null,privateUI=null}){
 const stage=document.querySelector('.network-stage'),main=document.querySelector('.workspace');
 const ribbon=document.createElement('section');ribbon.className='terminal-ribbon terminal-new';ribbon.setAttribute('data-localized-ui','');main.prepend(ribbon);let opticalHeader=null;
 const teams=document.createElement('section');teams.className='terminal-teams terminal-new';teams.setAttribute('data-localized-ui','');document.querySelector('.status-panel').append(teams);
 const flow=document.createElement('section');flow.className='terminal-flow terminal-new';flow.setAttribute('data-localized-ui','');stage.append(flow);
 const flowContent=document.createElement('div');flowContent.className='terminal-flow-content';flow.append(flowContent);
 const report=document.createElement('section');report.className='terminal-report terminal-new';report.setAttribute('data-localized-ui','');flow.append(report);
 const tape=document.createElement('section');tape.className='terminal-tape terminal-new';tape.setAttribute('data-localized-ui','');teams.append(tape);
 const chartSuite=createWorkbenchCharts(stage,{onMarketScan:rows=>research.ingestMarket?.(rows),onSharedContext:rows=>{if(research.mode==='live_readonly')research.ingest(rows);},onSelectSymbol:symbol=>{const task=research.task(symbol);if(!task||!research.accepts(task))return;selected=symbol;onSelect(RESEARCH_GROUPS[task.group].roles[0]);update();}});
 research.setSharedRefresh?.(resource=>chartSuite.refreshShared(resource));
 const chartToggle=document.createElement('button');chartToggle.type='button';chartToggle.className='terminal-data-toggle';chartToggle.setAttribute('aria-controls','workbench-analytics');stage.querySelector('.stage-controls').append(chartToggle);
 chartSuite.host.tabIndex=-1;
 chartToggle.onclick=()=>{
  chartSuite.host.focus({preventScroll:true});
  // The workbench above the charts can grow during startup and move a smooth scroll's destination.
  chartSuite.host.scrollIntoView({block:'start',behavior:'instant'});
 };
 const handoff=document.createElement('section');handoff.className='terminal-handoff terminal-new';handoff.setAttribute('data-localized-ui','');document.querySelector('.console-scroll').prepend(handoff);
 const trackbar=document.createElement('section');trackbar.className='pw-trackbar target-scope-bar terminal-new';trackbar.setAttribute('data-localized-ui','');(stage.querySelector('.workbench-header')||stage.querySelector('.stage-heading')).after(trackbar);
 const trackContent=document.createElement('div');trackContent.className='pw-track-content';trackbar.append(trackContent,stage.querySelector('.stage-controls'));
 const toggle=document.createElement('button');toggle.type='button';toggle.className='terminal-compare';toggle.setAttribute('data-localized-ui','');stage.querySelector('.stage-controls').append(toggle);

 const teamToggle=document.createElement('button');teamToggle.type='button';teamToggle.className='terminal-team-toggle';teamToggle.setAttribute('data-localized-ui','');stage.querySelector('.stage-controls').prepend(teamToggle);
 teamToggle.after(chartToggle);
 const phone=matchMedia('(max-width:900px)');
 function pane(value){document.body.dataset.mobileView=value;for(const b of document.querySelectorAll('[data-cockpit-pane],[data-mobile-pane]')){const active=(b.dataset.cockpitPane||b.dataset.mobilePane)===value;b.setAttribute('aria-pressed',String(active));b.classList.toggle('active',active);}onResize();requestUpdate();}
 let teamsOpen=true;
 teams.innerHTML=`<header><h2></h2><span>18 / 18</span><button class="terminal-rail-close" data-terminal-action="collapse">${uiGlyph('chevron')}</button></header><div class="terminal-mobile-overview"></div><div class="terminal-rail-tabs"><button data-terminal-mode="teams" aria-pressed="true"></button><button data-terminal-mode="feed" aria-pressed="false"></button><button data-terminal-mode="records" aria-pressed="false"></button></div><p class="terminal-team-summary"></p><div class="terminal-team-list">${RESEARCH_GROUPS.map((g,i)=>`<article class="terminal-team" data-terminal-group="${i}" role="group" style="--team:${g.color};--group-index:${i}"><button type="button" class="terminal-team-open" data-terminal-group="${i}"><span class="terminal-team-top"><b></b><span></span></span>${uiGlyph('chevron')}</button><div class="terminal-team-work"><span class="terminal-team-members" aria-hidden="true">${g.roles.map((id,j)=>`<i class="terminal-agent" style="--jump-delay:${-j*.43-i*.21}s"><span></span></i>`).join('')}</span><div class="terminal-team-assets"></div></div><p class="terminal-team-verdict"></p><div class="terminal-team-meter"><i></i></div></article>`).join('')}</div><div class="terminal-live-feed" hidden><div class="terminal-feed-status"></div><div class="terminal-feed-list" role="log" aria-live="off"></div><p class="terminal-feed-empty" hidden></p></div><div class="terminal-team-footer"></div>`;
 let railMode='teams',trackingFilter=workbenchFilter(workspace.s.workbenchFilter);
 const recordPane=document.createElement('div');recordPane.className='terminal-records-pane';recordPane.hidden=true;teams.querySelector('.terminal-team-footer').before(recordPane);recordPane.append(tape);
 const liveFeed=teams.querySelector('.terminal-live-feed');
 const informationDesk=createWorkbenchInformationDesk({feed:liveFeed,records:tape,research,workspace,onFocus:(symbol,kind)=>{const task=research.task(symbol);if(document.body.dataset.workbenchView!=='photonic'||!task||!research.accepts(task))return;selected=symbol;if(phone.matches)pane('network');update();document.dispatchEvent(new CustomEvent('hive:photonic-source',{detail:kind==='market'?'trend':kind==='news'?'macro':kind==='onchain'?'chain':kind==='social'?'social':RESEARCH_GROUPS[task.group].source}));return true;},onOpen:symbol=>{if(document.body.dataset.workbenchView==='photonic'){const task=research.task(symbol);if(task&&research.accepts(task)){selected=symbol;update();}}onOpen(symbol);}});
 teamToggle.onclick=()=>{if(matchMedia('(max-width:900px)').matches){pane('status');}else{teamsOpen=!teamsOpen;document.body.dataset.teamsOpen=String(phone.matches?document.body.dataset.mobileView==='status':teamsOpen);}teamToggle.setAttribute('aria-expanded',String(phone.matches?document.body.dataset.mobileView==='status':teamsOpen));onResize();};
 let enabled=new URLSearchParams(location.search).get('layout')!=='classic',selected=null,focusSymbol=null,elapsed=0;
 const intervention=document.createElement('div');intervention.className='ops-intervention';intervention.setAttribute('data-localized-ui','');document.querySelector('.console-header').append(intervention);
 const operations=createWorkbenchConsole({host:handoff,research,desk,workspace,intervention,privateUI});
 const controlPane=document.createElement('div');controlPane.className='ops-controls-panel';controlPane.id='ops-panel-controls';for(const id of ['plan','runs','positions'])controlPane.append(handoff.querySelector('#ops-'+id));handoff.prepend(controlPane);
 const infoPane=document.createElement('section');infoPane.className='ops-signals-panel';infoPane.id='ops-panel-signals';infoPane.innerHTML='<details class="ops-source-details"><summary></summary><div class="ops-information-panel"><div class="ops-source-data"></div></div></details><details class="ops-research-settings"><summary></summary><div data-ops-research-settings></div></details>';handoff.append(infoPane);infoPane.prepend(handoff.querySelector('#ops-signals'));for(const id of ['tracking','ai'])infoPane.querySelector('[data-ops-research-settings]').append(handoff.querySelector('#ops-'+id));
 const noticePane=document.createElement('section');noticePane.className='ops-notifications-panel';noticePane.id='ops-panel-notifications';noticePane.append(handoff.querySelector('#ops-notices'));handoff.append(noticePane);
 recordPane.id='pw-panel-records';
 const streams=document.createElement('section');streams.className='pw-information terminal-new';streams.setAttribute('data-localized-ui','');streams.dataset.streamPane='feed';streams.innerHTML='<header><h2></h2><div role="tablist"><button type="button" data-stream-pane="feed" role="tab" aria-controls="pw-panel-stream" aria-selected="true"></button><button type="button" data-stream-pane="records" role="tab" aria-controls="pw-panel-records" aria-selected="false"></button></div></header><div class="pw-stream-grid"><article id="pw-panel-stream"><h3></h3><div class="pw-stream-feed"></div></article><article class="pw-stream-records"><h3></h3></article></div>';stage.append(streams);
 streams.addEventListener('click',event=>{const button=event.target.closest('button[data-stream-pane]');if(!button)return;streams.dataset.streamPane=button.dataset.streamPane;for(const tab of streams.querySelectorAll('[data-stream-pane]'))tab.setAttribute('aria-selected',String(tab===button));});
 streams.addEventListener('keydown',event=>{if(!event.target.matches('[data-stream-pane]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...streams.querySelectorAll('[data-stream-pane]')],next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs.find(tab=>tab!==event.target);next.click();next.focus();});
 const consoleTabs=document.createElement('div');consoleTabs.className='ops-workbench-tabs';consoleTabs.setAttribute('role','tablist');consoleTabs.setAttribute('data-localized-ui','');consoleTabs.innerHTML=['controls','signals','notifications'].map(id=>`<button type="button" role="tab" id="ops-view-${id}" data-ops-view="${id}" aria-controls="ops-panel-${id}"></button>`).join('');document.querySelector('.console-header').append(consoleTabs);
 let rightView='controls',dockStamp='',updateTimer=0;
 function syncDock(){
  const photonic=document.body.dataset.workbenchView==='photonic';
  const stamp=[photonic,rightView,document.documentElement.lang,phone.matches,document.body.dataset.mobileView].join('|');if(stamp===dockStamp)return;dockStamp=stamp;
  if(photonic){if(liveFeed.parentElement!==streams.querySelector('.pw-stream-feed'))streams.querySelector('.pw-stream-feed').append(liveFeed);if(recordPane.parentElement!==streams.querySelector('.pw-stream-records'))streams.querySelector('.pw-stream-records').append(recordPane);if(document.body.dataset.mobileView==='status')pane('network');}
  else if(liveFeed.parentElement!==teams){teams.querySelector('.terminal-team-footer').before(liveFeed,recordPane);}
  controlPane.hidden=photonic&&rightView!=='controls';infoPane.hidden=!photonic||rightView!=='signals';noticePane.hidden=!photonic||rightView!=='notifications';
  intervention.hidden=consoleTabs.hidden=!photonic;
  for(const tab of consoleTabs.children){const active=tab.dataset.opsView===rightView;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.textContent=L(...({controls:['交易','Trading'],signals:['信号','Signals'],notifications:['通知','Notices']}[tab.dataset.opsView]));}
  for(const [id,panel] of [['controls',controlPane],['signals',infoPane],['notifications',noticePane]]){panel.setAttribute('role',photonic?'tabpanel':'region');panel.setAttribute('aria-labelledby','ops-view-'+id);}
  streams.hidden=!photonic;streams.querySelector('header h2').textContent=L('工作动态','Activity');streams.querySelector('#pw-panel-stream h3').textContent=L('信息流','Data stream');streams.querySelector('.pw-stream-records h3').textContent=L('Agent 日志','Agent log');
  trackbar.hidden=!photonic;
  for(const tab of streams.querySelectorAll('[data-stream-pane]'))tab.textContent=tab.dataset.streamPane==='feed'?L('信息流','Data stream'):L('Agent 日志','Agent log');
  infoPane.querySelector('.ops-source-details>summary').textContent=L('研究资料','Research sources');infoPane.querySelector('.ops-research-settings>summary').textContent=L('研究设置','Research settings');
 }
 function selectConsole(view,scrollTop=0){if(!['controls','signals','notifications'].includes(view))return;rightView=view;update();onResize();document.querySelector('.console-scroll').scrollTop=Number.isFinite(scrollTop)?Math.max(0,scrollTop):0;}
 consoleTabs.addEventListener('click',event=>{const button=event.target.closest('[data-ops-view]');if(button)selectConsole(button.dataset.opsView);});
 handoff.addEventListener('click',event=>{const button=event.target.closest('[data-ops-select-view]');if(button){selectConsole(button.dataset.opsSelectView);consoleTabs.querySelector('[data-ops-view="'+rightView+'"]')?.focus();}});
 document.addEventListener('hive:workbench-console',event=>{selectConsole(event.detail?.view,event.detail?.scrollTop);if(phone.matches)pane('console');});
 consoleTabs.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...consoleTabs.children],index=tabs.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;tabs[next].click();tabs[next].focus();});
 document.addEventListener('hive:workbench-information',event=>{
  if(document.body.dataset.workbenchView!=='photonic')return;
  rightView='signals';
  const sources=infoPane.querySelector('.ops-source-details');sources.open=true;
  if(phone.matches)pane('console');
  document.querySelector('.console-scroll').scrollTop=0;update();onResize();
  requestAnimationFrame(()=>{
   if(document.body.dataset.page!=='workbench'||rightView!=='signals'||(phone.matches&&document.body.dataset.mobileView!=='console'))return;
   const group=[...sources.querySelectorAll('[data-pw-group]')].find(node=>node.dataset.pwGroup===event.detail);
   const target=group?.querySelector('[data-channel-id]')||sources.querySelector('summary');
   target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',behavior:'instant'});
  });
 });
 const stamps=new Map(),sourceUpdates=new WorkbenchUpdateQueue(),cueAnimations=new Set();
 const reduced=matchMedia('(prefers-reduced-motion:reduce)');
 const sourceCards=[...stage.querySelectorAll('.reactor-source-chip')];
 for(const card of sourceCards){const wash=document.createElement('i');wash.className='terminal-source-wash';wash.setAttribute('aria-hidden','true');card.append(wash);const stream=document.createElement('i');stream.className='terminal-source-stream';stream.setAttribute('aria-hidden','true');card.append(stream);}
 function stopCues(){for(const animation of cueAnimations)animation.cancel();cueAnimations.clear();}
 reduced.addEventListener('change',()=>{if(reduced.matches){stage.dataset.feedbackActive='false';stopCues();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){stage.dataset.feedbackActive='false';document.body.dataset.teamMotion='false';sourceUpdates.reset();stopCues();}});
 function cue(element,wash=false){
  if(!element||!element.animate||reduced.matches||document.documentElement.dataset.reducedMotion==='true'||document.hidden||document.body.dataset.paused==='true')return;
  const frames=wash?[{opacity:0},{opacity:1,offset:.18},{opacity:0}]:[{opacity:.56,transform:'translateY(2px)'},{opacity:1,transform:'translateY(0)'}];
  const animation=element.animate(frames,{duration:wash?280:220,easing:'cubic-bezier(.23,1,.32,1)'});cueAnimations.add(animation);animation.onfinish=animation.oncancel=()=>cueAnimations.delete(animation);
 }
 function clip(){const layer=document.querySelector('.reactor-courier-layer');if(!layer||!enabled||document.hidden||document.body.dataset.workbenchView==='photonic')return;const r=layer.getBoundingClientRect(),s=stage.getBoundingClientRect();for(const [name,value]of Object.entries({top:s.top-r.top,right:r.right-s.right,bottom:r.bottom-s.bottom,left:s.left-r.left}))layer.style.setProperty('--terminal-clip-'+name,Math.max(0,value)+'px');}
 stage.addEventListener('scroll',clip,{passive:true});window.addEventListener('resize',()=>requestAnimationFrame(clip));

 function put(node,html,context){
  if(stamps.get(node)===html)return;
  const numbers=new Map([...node.querySelectorAll('[data-terminal-number]')].map(e=>[e.dataset.terminalNumber,e.textContent]));
  const previousActivity=node.querySelector('[data-terminal-activity-key]')?.dataset.terminalActivityKey;
  const previousRecord=node.querySelector('[data-terminal-record]')?.dataset.terminalRecord;
  const details=[...node.querySelectorAll('details')].map(element=>element.open);
  const folds=context&&node.dataset.context===context?[...node.querySelectorAll('details[open]')].map(d=>d.className):[];if(context)node.dataset.context=context;
  const stripSelector='.pw-target-chips,.terminal-asset-queue',strip=node.querySelector(stripSelector),left=strip?.scrollLeft;
  const atEnd=left>0&&strip.scrollWidth-strip.clientWidth-left<1,restore=captureProductFocus(node);
  node.innerHTML=html;stamps.set(node,html);for(const name of folds){const fold=node.querySelector('details.'+name);if(fold)fold.open=true;}
  if(strip){const next=node.querySelector(stripSelector);if(next)next.scrollLeft=atEnd?next.scrollWidth:left;}
  node.querySelectorAll('details').forEach((element,i)=>{if(i<details.length)element.open=details[i];});restore();
  for(const number of node.querySelectorAll('[data-terminal-number]'))if(numbers.has(number.dataset.terminalNumber)&&numbers.get(number.dataset.terminalNumber)!==number.textContent)cue(number);
  const activity=node.querySelector('[data-terminal-activity-key]');if(previousActivity&&activity?.dataset.terminalActivityKey!==previousActivity)cue(activity);
  const record=node.querySelector('[data-terminal-record]');if(previousRecord&&record?.dataset.terminalRecord!==previousRecord)cue(record);
 }
 function navigate(page){document.dispatchEvent(new CustomEvent('hive:navigate',{detail:page}));}
 function setLayout(){chartSuite.host.hidden=!enabled;chartToggle.hidden=!enabled;chartToggle.innerHTML=uiGlyph('chart');chartToggle.title=L('数据视图','Data view');chartToggle.setAttribute('aria-label',chartToggle.title);chartSuite.host.setAttribute('aria-label',chartToggle.title);document.body.dataset.liveTerminal=String(enabled);document.body.dataset.teamsOpen=String(teamsOpen);for(const node of [ribbon,teams,flow,report,tape,handoff])node.hidden=!enabled;
  teamToggle.hidden=!enabled;teamToggle.innerHTML=uiGlyph('strategy')+'<span>'+L('信息台','Information desk')+'</span>';teamToggle.setAttribute('aria-label',L('信息台','Information desk'));teamToggle.title=L('信息台','Information desk');teamToggle.setAttribute('aria-expanded',String(phone.matches?document.body.dataset.mobileView==='status':teamsOpen));
  toggle.hidden=enabled&&!new URLSearchParams(location.search).has('compare');
  toggle.textContent=enabled?phone.matches?L('原版','Original'):L('原版对比','Compare original'):L('返回新版','Use new layout');toggle.setAttribute('aria-pressed',String(!enabled));
  const h=document.getElementById('stage-title');h.innerHTML=wordmark();stage.setAttribute('aria-label',L('AI 星谱','LensWave'));h.setAttribute('aria-level',enabled&&!phone.matches?'2':'1');
  update();onResize();requestAnimationFrame(clip);
 }
 toggle.onclick=()=>{enabled=!enabled;const url=new URL(location.href);if(enabled)url.searchParams.delete('layout');else url.searchParams.set('layout','classic');history.replaceState(null,'',url);setLayout();};
 function setTrackingFilter(value){const issue=setWorkbenchTargets(workspace,research,{filter:value});if(issue){workspace.onError?.(issue);return;}trackingFilter=workbenchFilter(workspace.s.workbenchFilter);const visible=workbenchTracking(research,workspace.s.aiSignalWatch,trackingFilter,workspace.s.aiSignalPreferences);if(!visible.some(task=>task.symbol===selected))selected=null;update();}
 async function action(event){const target=event.target.closest('[data-terminal-action],[data-terminal-group],[data-terminal-symbol],[data-terminal-route],[data-terminal-pane],[data-terminal-mode],[data-terminal-filter]');if(!target)return;
  if(target.dataset.terminalMode){railMode=target.dataset.terminalMode;update();return;}
  if(target.dataset.terminalFilter){setTrackingFilter(target.dataset.terminalFilter);return;}
  if(target.dataset.terminalAction==='wallet'){document.querySelector('.header-wallet .wallet-login')?.click();return;}
  if(target.dataset.terminalAction==='collapse'){teamToggle.click();return;}
  if(target.dataset.terminalAction==='watch'){const task=workbenchFocus(research,desk.snapshot(),workspace,selected,getHandoff()).task;if(task){const issue=await toggleWorkbenchWatch(workspace,task.symbol);if(issue)workspace.onError?.(issue);if(trackingFilter!=='all'&&!workbenchTracking(research,workspace.s.aiSignalWatch,trackingFilter,workspace.s.aiSignalPreferences).some(t=>t.symbol===selected))selected=null;update();}return;}
  if(target.dataset.terminalAction==='setup'){document.dispatchEvent(new CustomEvent('hive:configure-strategy'));return;}
  if(target.dataset.terminalPane){pane(target.dataset.terminalPane);return;}
  if(target.dataset.terminalRoute){navigate(target.dataset.terminalRoute);return;}
  if(target.dataset.terminalGroup!==undefined){const i=Number(target.dataset.terminalGroup),activity=workbenchTeamActivity(research,getJobs(),workbenchTracking(research,workspace.s.aiSignalWatch,trackingFilter,workspace.s.aiSignalPreferences))[i];if(!activity?.available)return;selected=activity.task?.symbol||activity.assets[0]?.symbol;onSelect(RESEARCH_GROUPS[i].roles[0]);update();if(document.body.dataset.workbenchView!=='photonic')onOpen(selected);return;}
  if(target.dataset.terminalSymbol){const t=research.task(target.dataset.terminalSymbol);if(!t||!research.accepts(t))return;selected=t.symbol;if(!workbenchTracking(research,workspace.s.aiSignalWatch,trackingFilter,workspace.s.aiSignalPreferences).some(t=>t.symbol===selected))trackingFilter='all';onSelect(RESEARCH_GROUPS[t.group].roles[0]);update();if(target.hasAttribute('data-team-asset')&&document.body.dataset.workbenchView!=='photonic')onOpen(t.symbol);return;}
  const focus=workbenchFocus(research,desk.snapshot(),workspace,selected,getHandoff());if(focus.task)onOpen(focus.task.symbol);
 }
 document.addEventListener('hive:workbench-filter',event=>setTrackingFilter(event.detail));
 document.addEventListener('hive:workbench-focus',event=>{const issue=focusWorkbenchAsset(workspace,research,event.detail);if(issue){workspace.onError?.(issue);return;}trackingFilter=workbenchFilter(workspace.s.workbenchFilter);selected=event.detail;update();});
 for(const el of [ribbon,teams,flow,handoff,trackbar])el.addEventListener('click',action);
 stage.querySelector('.asset-research-grid').addEventListener('click',async event=>{const b=event.target.closest('[data-research-asset]');if(b){selected=b.dataset.researchAsset;update();}});
 function update(){
  if(!enabled||document.hidden||document.body.dataset.page!=='workbench'){informationDesk.suspend();stage.dataset.feedbackActive='false';document.body.dataset.teamMotion='false';sourceUpdates.reset();stopCues();return;}
  trackingFilter=workbenchFilter(workspace.s.workbenchFilter);
  const selection=readWorkbenchTargets(workspace,research),scopedTrade=desk.readSnapshot?desk.readSnapshot():desk.snapshot(),trade=scopedTrade||{state:'idle',cash:NaN,totalFees:NaN,orders:[],events:[]},visibleTasks=selection.tasks,requested=selection.focusAsset||(visibleTasks.some(t=>t.symbol===selected)?selected:(visibleTasks.find(t=>t.phase==='core')||visibleTasks.find(t=>t.phase==='complete'&&t.outcome==='candidate')||visibleTasks[0])?.symbol);
  const focus=workbenchFocus(research,trade,workspace,requested,getHandoff()),sum=research.summary(),paused=document.body.dataset.paused==='true';
  focusSymbol=visibleTasks.length?focus.task?.symbol:null;
  syncDock();if(!phone.matches||document.body.dataset.mobileView==='console')operations.update();else operations.stopReading();
  if(document.body.dataset.workbenchView==='photonic'){
   put(trackContent,renderWorkbenchTargets(workspace,research,{contentOnly:true}));
   bindWorkbenchTargets(main,{workspace,research,onManage:()=>navigate('watchlist'),onChange:next=>{
    if(next.focusAsset){selected=next.focusAsset;onSelect(RESEARCH_GROUPS[research.task(selected).group].roles[0]);}
    update();
    if(next.focusAsset)trackContent.querySelector('[data-target-asset][aria-pressed=true]')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
   }});
  }
  if(paused)stopCues();
  stage.dataset.feedbackActive=String(!paused&&!reduced.matches&&!document.hidden);
  document.body.dataset.teamMotion=String(!paused&&!document.hidden&&!reduced.matches);
  if(document.body.dataset.workbenchView!=='photonic'){
  const evidenceRevisions=workbenchSourceRevisions(research);
  const values=Object.fromEntries(sourceCards.map(card=>[card.dataset.collectorSource,(card.querySelector('[data-source-value]')?.textContent||'')+'|'+(evidenceRevisions[card.dataset.collectorSource]||'')]));
  const changedSources=sourceUpdates.read(values,!paused&&!reduced.matches&&!document.hidden);
  for(const key of changedSources){const card=sourceCards.find(card=>card.dataset.collectorSource===key);cue(card?.querySelector('.terminal-source-wash'),true);cue(card?.querySelector('[data-source-value]'));}
  for(const activity of workbenchTeamActivity(research,getJobs(),visibleTasks)){
   const node=teams.querySelector('.terminal-team-list').children[activity.group];
   const previousPhase=node.dataset.phase;
   node.dataset.unavailable=String(!activity.available);node.dataset.phase=activity.phase;node.dataset.selected=String(focus.task?.group===activity.group);
   const groupLabel=L(...groupNames[activity.group]),open=node.querySelector('.terminal-team-open');
   node.setAttribute('aria-label',groupLabel);open.disabled=!activity.available;open.setAttribute('aria-pressed',String(focus.task?.group===activity.group));
   open.setAttribute('aria-label',`${groupLabel} · ${L(...phaseNames[activity.phase])}`);open.title=RESEARCH_GROUPS[activity.group].roles.map(role).join(' / ');
   put(node.querySelector('.terminal-team-top b'),L(...groupNames[activity.group]));
   put(node.querySelector('.terminal-team-top>span'),activity.available?L(...phaseNames[activity.phase]):L('待分配','Standby'));
   const task=activity.task||activity.assets[0];put(node.querySelector('.terminal-team-verdict'),task?`<b>${esc(task.symbol)}</b><span>${esc(task.phase==='complete'?t(workbenchPlainEvent(task.title)):L(...phaseNames[task.phase]))}</span>`:`<span>${L('当前追踪范围内暂无任务','No task in the current view')}</span>`);
   put(node.querySelector('.terminal-team-assets'),activity.assets.map(asset=>{const symbol=esc(asset.symbol),name=esc(t(asset.name));return `<button type="button" class="terminal-team-asset" data-team-asset="${activity.group}" data-terminal-symbol="${symbol}" aria-label="${name}" aria-pressed="${focus.task?.symbol===asset.symbol}">${tokenIcon(asset.symbol,{size:21})}</button>`;}).join(''));
   node.querySelector('.terminal-team-meter i').style.transform=`scaleX(${activity.progress/100})`;
   if(previousPhase&&previousPhase!==activity.phase)cue(node.querySelector('.terminal-team-work'));
  }
  }
  const latest=research.events.find(event=>{const task=research.task(event.symbol);return task&&research.accepts(task);}),activity=latest&&research.task(latest.symbol);

  const balance=workbenchWalletMetric(walletBalance.snapshot());
  const operation=workbenchOperationState(scopedTrade),runStatus=workbenchOperationLabel(operation.status);
  const scanCount=workbenchTracking(research,workspace.s.aiSignalWatch,'scan',workspace.s.aiSignalPreferences).length,watchCount=workbenchTracking(research,workspace.s.aiSignalWatch,'tracked',workspace.s.aiSignalPreferences).length;
  if(document.body.dataset.workbenchView==='photonic'){
   const headerParent=phone.matches?stage:main;if(ribbon.parentElement!==headerParent)headerParent.prepend(ribbon);
   if(!opticalHeader)opticalHeader=createOpticalHeader(ribbon);ribbon.classList.add('terminal-halftone');opticalHeader.update(visibleTasks,balance,paused,chartSuite.scanRows());
  }else{
   if(ribbon.parentElement!==main)main.prepend(ribbon);
   opticalHeader?.dispose();opticalHeader=null;ribbon.classList.remove('terminal-halftone');
  put(ribbon,`<div class="terminal-title"><div><h1>${wordmark()}</h1><p class="terminal-os-identity" data-no-translate>AGENT TRADING OS</p></div></div><div class="terminal-system-overview"><div class="terminal-core-status"><i class="terminal-live-dot" data-paused="${paused}"></i><b>${paused?L('Agent 协作已暂停','Agent collaboration paused'):L('Agent 协作中','Agents at work')}</b></div><p><button data-terminal-route="watchlist">${L('我的追踪','My tracking')} ${watchCount}</button><span>·</span><button data-terminal-route="signals">${scanCount} ${L('个扫描候选',scanCount===1?'scan candidate':'scan candidates')}</button></p></div><div class="terminal-account">${renderWorkbenchWalletButton(balance)}<button data-terminal-route="usage"><small>${L('AI 积分','AI credits')}</small><b data-terminal-number="credits">${number(workspace.available,0)}<em>${workspace.reserved?L('预留 ','Held ')+workspace.reserved:L('可用','available')}</em></b></button></div><button class="terminal-session" data-terminal-route="execution" data-phase="${operation.status}"><span class="terminal-session-label">${L('交易运行','Trading activity')}${uiGlyph('arrow')}</span><b>${runStatus}</b><small>${scopedTrade?trade.position?1:0:'—'} ${L('持仓','positions')}<i>·</i>${scopedTrade?activeWorkbenchOrders(scopedTrade).length:'—'} ${L('挂单','open orders')}</small></button>`);
  }
  put(teams.querySelector('header h2'),L('信息台','Information desk'));
  const close=teams.querySelector('.terminal-rail-close');close.hidden=phone.matches;close.setAttribute('aria-label',L('收起','Collapse')+' · '+L('信息台','Information desk'));
  for(const button of teams.querySelectorAll('[data-terminal-mode]')){const active=button.dataset.terminalMode===railMode;button.setAttribute('aria-pressed',String(active));button.textContent=button.dataset.terminalMode==='teams'?(document.body.dataset.workbenchView==='photonic'?L('数据','Data'):L('战队','Squad')):button.dataset.terminalMode==='feed'?L('信息流','Live feed'):L('Agent 日志','Agent log');}
  const informationMode=document.body.dataset.workbenchView==='photonic'?'workspace':railMode;
  teams.querySelector('.terminal-team-list').hidden=railMode!=='teams';liveFeed.hidden=!['feed','workspace'].includes(informationMode);recordPane.hidden=!['records','workspace'].includes(informationMode);
  put(teams.querySelector('.terminal-mobile-overview'),`<div><span>${L('交易状态','Trading status')}<b>${runStatus}</b></span><button data-terminal-pane="console">${L('去操作台','Open controls')}${uiGlyph('arrow')}</button></div>${renderWorkbenchWalletButton(balance,true)}<button data-terminal-route="usage"><small>${L('可用 AI 积分','AI credits available')}</small><strong>${number(workspace.available,0)}</strong></button>`);
  put(teams.querySelector('.terminal-team-summary'),`<span>${paused?L('协作已暂停','Collaboration paused'):visibleTasks.some(t=>t.phase!=='complete')?L('研究中','Researching'):L('持续观察','Monitoring')}</span><b>${visibleTasks.filter(t=>t.phase==='complete'&&t.outcome==='candidate').length} ${L('个机会候选','candidates')}</b>`);
  put(teams.querySelector('.terminal-team-footer'),`<button data-terminal-route="risk">${uiGlyph('shield')}<span>${L('资金保护','Capital protection')}<b>${number(workspace.s.risk.cap,0)} USDT</b></span>${uiGlyph('chevron')}</button><button data-terminal-route="my-strategies">${uiGlyph('strategy')}${L('我的策略','My strategies')}${uiGlyph('chevron')}</button>`);
  teams.dataset.railMode=railMode;informationDesk.update(scopedTrade,informationMode,desk.syncStatus().scope,visibleTasks);
  const hasChart=Boolean(focus.task&&visibleTasks.length);
  chartSuite.host.hidden=!hasChart;chartToggle.hidden=!hasChart;
  if(!focus.task){put(flowContent,`<p>${L('等待研究范围中的新线索','Waiting for evidence in your research scope')}</p>`);return;}
  const {task,stages,linked,orders,filled,blocked,candidate,draft}=focus;
  chartSuite.update({task,researchMode:research.mode,scanTasks:research.tasks.filter(item=>research.accepts(item)),tasks:research.tasks.filter(item=>research.accepts(item)),focus,trade,syncStatus:desk.syncStatus?.(),risk:workspace.s.risk,time:research.time,paused});
  if(visibleTasks.length)selected=requested;
  if(document.body.dataset.workbenchView==='photonic')return;
  const notes=[L(...phaseNames[task.phase]),focus.complete?task.title:L('整理来源与分歧','Checking sources & conflicts'),linked?trade.session.strategy+' · v'+trade.session.strategyVersion:draft?draft.strategy+' · v'+draft.version:L('尚未选择','Not selected'),linked?`${trade.session.amount} / ${trade.session.cap} USDT`:draft?`${draft.amount} / ${draft.cap} USDT`:'—',linked?focus.unknown?L('结果待确认','Outcome unknown'):trade.signal?L('等待订单确认','Waiting for confirmation'):label(trade.state):L('尚未执行','Not executed'),filled.length?filled.length+L(' 笔委托已有成交',' orders with fills'):L('等待成交记录','Awaiting fill records')];
  const names=[['发现线索','Discover'],['形成判断','Review'],['策略检查','Strategy'],['金额与保护','Size & protect'],['执行交易','Execute'],['记录结果','Record']];
  const watch=workspace.s.aiSignalWatch||[],hasVisible=visibleTasks.length>0;
  const filters=[['all',L('全部','All')],['scan',L('市场扫描','Market scan')],['tracked',L('我的追踪','Watching')]];
  const heading=`<header class="terminal-tracking-heading"><div class="terminal-tracking-title"><h2>${L('追踪与机会','Tracks & opportunities')}</h2><button data-terminal-route="watchlist" aria-label="${L('管理我的追踪','Manage my watchlist')}">${uiGlyph('settings')}</button></div><div class="terminal-tracking-filters" aria-label="${L('研究范围筛选','Filter research')}" >${filters.map(([id,text])=>`<button data-terminal-filter="${id}" aria-pressed="${trackingFilter===id}">${text}<span>${workbenchTracking(research,watch,id,workspace.s.aiSignalPreferences).length}</span></button>`).join('')}</div></header>`;
  const assets=`<div class="terminal-asset-queue" aria-label="${L('当前研究资产','Assets under research')}">${visibleTasks.map(item=>`<button data-terminal-symbol="${item.symbol}" data-collector-source="${RESEARCH_GROUPS[item.group].source}" data-collector-zone="asset:${item.symbol}" data-collector-asset="${item.symbol}" data-collector-intent="asset" data-phase="${item.phase}" aria-pressed="${task.symbol===item.symbol}" style="--team:${RESEARCH_GROUPS[item.group].color}"><span>${tokenIcon(item.symbol,{size:20})}<b>${item.symbol}</b>${watch.includes(item.symbol)?'<i aria-label="'+L('已追踪','Watching')+'">'+uiGlyph('star')+'</i>':''}</span><small>${esc(t(item.phase==='complete'?item.title:L(...phaseNames[item.phase])))}</small><span class="terminal-asset-meter"><i style="transform:scaleX(${item.progress/100})"></i></span></button>`).join('')}</div>`;
  put(flowContent,heading+(hasVisible?assets+`<div class="terminal-focus-top"><div class="terminal-selected-asset">${tokenIcon(task.symbol,{size:26})}<b>${task.symbol}</b><span>${L(...groupNames[task.group])}<small>${L(...phaseNames[task.phase])}</small></span></div><div class="terminal-focus-actions"><button data-terminal-action="watch" aria-pressed="${watch.includes(task.symbol)}" title="${L('与 AI 信号共用追踪列表；追踪不会下单或扣积分。','Shared with AI Signals. Watching places no orders and uses no credits.')}">${uiGlyph('star')}${watch.includes(task.symbol)?L('已追踪','Watching'):L('追踪','Watch')}</button></div></div><ol class="terminal-chain">${stages.map((s,i)=>`<li data-state="${s.state}" data-collector-source="${i<2?RESEARCH_GROUPS[task.group].source:i===4?'depth':'risk'}" data-collector-zone="workflow:${i}:${task.symbol}" data-collector-asset="${task.symbol}" data-collector-roles="${s.owner.join(',')}" data-collector-intent="${['asset','review','strategy','risk','execution','result'][i]}" aria-label="${L(...names[i])} · ${L(...({done:['已完成','Complete'],active:['处理中','In progress'],blocked:['需处理','Needs attention'],ready:['已就绪，等待交接','Ready; awaiting handoff'],setup:['待设置','Needs setup'],waiting:['等待','Waiting']}[s.state]))}" title="${s.owner.map(role).join(' / ')}"><span class="terminal-step-node">${s.state==='done'?uiGlyph('check'):s.state==='blocked'?'!':uiGlyph(['search','file','strategy','shield','pulse','history'][i])}</span><b>${L(...names[i])}</b><i class="terminal-step-activity" aria-hidden="true"></i></li>`).join('')}</ol>`:`<div class="terminal-tracking-empty">${uiGlyph('star')}<b>${trackingFilter==='scan'?L('暂无符合偏好的扫描候选','No scan candidates match your preferences'):L('还没有追踪的资产','No watched assets yet')}</b><button data-terminal-route="${trackingFilter==='scan'?'signals':'watchlist'}">${trackingFilter==='scan'?L('查看 AI 信号','View AI Signals'):L('管理我的追踪','Manage my watchlist')}${uiGlyph('arrow')}</button></div>`));
  report.hidden=!hasVisible;tape.hidden=false;
  put(report,`<div class="terminal-verdict" data-blocked="${blocked}"><span><i></i>${esc(t(blocked?task.title:candidate?L('发现可继续跟进的机会','Ready for a closer look'):task.phase==='complete'?task.title:L('正在收集与比较','Collecting and comparing')))}</span><p>${esc(t(focus.complete?task.thesis:task.reason))}</p><button data-terminal-action="details">${candidate?L('选择策略','Choose strategy'):L('查看进展','View progress')}${uiGlyph('arrow')}</button></div>`,task.symbol+':'+task.version);

 }
 function requestUpdate(){if(!updateTimer)updateTimer=setTimeout(()=>{updateTimer=0;update();},0);}
 window.addEventListener('pagehide',()=>clearTimeout(updateTimer));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)requestUpdate();});
 document.addEventListener('hive:wallet-balance',update);
 phone.addEventListener('change',setLayout);
 document.getElementById('play-pause').addEventListener('click',update);
 document.addEventListener('hive:locale',()=>{stamps.clear();setLayout();});
 setLayout();
 return {refresh:update,setView(view){railMode='teams';stamps.clear();update();},context(){const trade=desk.readSnapshot?desk.readSnapshot():desk.snapshot();const tasks=workbenchTracking(research,workspace.s.aiSignalWatch,trackingFilter,workspace.s.aiSignalPreferences);return {research,trade:trade||{},tasks,marketRows:chartSuite.scanRows(),focus:workbenchFocus(research,trade||{},workspace,focusSymbol||selected,getHandoff())};},selectSymbol(symbol){const task=research.task(symbol);if(!task||!research.accepts(task))return;selected=symbol;update();},focusRole(id){const j=getJobs().find(j=>j.roles.includes(id));const symbol=j?.symbol?.split(/[ /]/)[0]||(j?.business?desk.snapshot().session?.market?.split('/')[0]:null);const g=research.groups.find(g=>g.roles.includes(id));selected=research.task(symbol)?.symbol||g?.task||research.tasks.find(t=>t.group===g?.station&&research.accepts(t))?.symbol;if(!workbenchTracking(research,workspace.s.aiSignalWatch,trackingFilter,workspace.s.aiSignalPreferences).some(t=>t.symbol===selected))trackingFilter='all';update();},tick(dt){elapsed+=dt;if(elapsed>.65){elapsed=0;requestUpdate();}}};
}
