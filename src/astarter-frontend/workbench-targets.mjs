import {TOKEN_IDS} from './brand-icon-data.mjs';
import {ASSETS} from './product-data.mjs';
import {signalPreferences} from './signal-tracking.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {normalizeConnectionPreferences,AI_MODES} from './connection-options.mjs?v=20261120c';
import {agentModelsIssue} from './agent-models.mjs';
import {L} from './execution-views.mjs';
import {sameWatchAssetKey} from './market-watchlist.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {uiGlyph} from './product-composition.mjs';
import {escapeUI as esc} from './product-experience.mjs';

export const workbenchFilter=value=>['all','scan','tracked'].includes(value)?value:'all';
export const watchedSymbols=workspace=>[...new Set(Array.isArray(workspace.s.aiSignalWatch)?workspace.s.aiSignalWatch:[])];

// Research scope is independent of signal strategy eligibility and never authorizes an order.
export function marketScanSymbols(research,preferences={}){
 const {scope,focus}=signalPreferences(preferences),source={market:'trend',onchain:'chain',social:'social',macro:'macro'}[focus];
 return research.tasks.filter(task=>research.accepts(task)&&(scope==='all'||task.domain.toLowerCase()===scope)&&(focus==='all'||source&&RESEARCH_GROUPS[task.group]?.source===source)).map(task=>task.symbol);
}
export function workbenchTracking(research,watched=[],filter='all',preferences={}){
 const watch=new Set((Array.isArray(watched)?watched:[]).map(key=>key.startsWith('coin:')?TOKEN_IDS[key.slice(5)]||key:key)),scan=new Set(marketScanSymbols(research,preferences));
 return research.tasks.filter(task=>research.accepts(task)&&(filter==='tracked'?watch.has(task.symbol):filter==='scan'?scan.has(task.symbol):watch.has(task.symbol)||scan.has(task.symbol)));
}

export function readWorkbenchTargets(workspace,research=workspace.research){
 const filter=workbenchFilter(workspace.s.workbenchFilter),tasks=research?workbenchTracking(research,workspace.s.aiSignalWatch,filter,workspace.s.aiSignalPreferences):[];
 const focusAsset=tasks.find(task=>task.symbol===workspace.s.workbenchFocusAsset)?.symbol||null;
 return {filter,tasks,focusAsset};
}
export function matchesWorkbenchTarget(symbol,{filter,tasks,focusAsset}){
 return focusAsset?sameWatchAssetKey(symbol,focusAsset):filter==='all'||tasks.some(task=>sameWatchAssetKey(symbol,task.symbol));
}
export function setWorkbenchTargets(workspace,research,patch){
 const current=readWorkbenchTargets(workspace,research),filter=patch.filter===undefined?current.filter:workbenchFilter(patch.filter);
 const tasks=workbenchTracking(research,workspace.s.aiSignalWatch,filter,workspace.s.aiSignalPreferences);
 let focusAsset=patch.focusAsset===undefined?(patch.filter==='all'?null:current.focusAsset):patch.focusAsset;
 if(focusAsset!==null&&!tasks.some(task=>task.symbol===focusAsset)){
  if(patch.focusAsset!==undefined)return L('这个标的不在当前范围','This asset is outside the current scope');
  focusAsset=null;
 }
 if(filter===workspace.s.workbenchFilter&&focusAsset===(workspace.s.workbenchFocusAsset||null))return null;
 const issue=workspace.setWorkbenchTargets({filter,focusAsset});if(issue)return issue;
 if(!workspace.privateUIOwner?.())workspace.touch();return null;
}
export function focusWorkbenchAsset(workspace,research,symbol){
 const task=research.task(symbol);if(!task||!research.accepts(task))return L('这个标的尚未接入协作研究','This asset is not available for team research yet');
 const tracked=workbenchTracking(research,workspace.s.aiSignalWatch,'tracked',workspace.s.aiSignalPreferences).some(item=>item.symbol===task.symbol);
 return setWorkbenchTargets(workspace,research,{filter:tracked?'tracked':'all',focusAsset:task.symbol});
}
export function renderWorkbenchTargets(workspace,research=workspace.research,{contentOnly=false}={}){
 if(!research)return '';
 const {filter,tasks,focusAsset}=readWorkbenchTargets(workspace,research);
 const scopes=[['tracked','追踪','Watching'],['scan','扫描','Scan'],['all','全部','All']].map(([id,zh,en])=>({id,text:L(zh,en),count:workbenchTracking(research,workspace.s.aiSignalWatch,id,workspace.s.aiSignalPreferences).length}));
 const content=`<button class="pw-track-manage" type="button" data-target-manage aria-label="${L('标的收藏','Watchlist')}" title="${L('标的收藏','Watchlist')}">${uiGlyph('settings')}</button><select class="pw-track-select" data-target-filter-select aria-label="${L('研究范围','Research scope')}">${scopes.map(({id,text,count})=>`<option value="${id}" ${filter===id?'selected':''}>${text} ${count}</option>`).join('')}</select><div class="pw-track-filters" aria-label="${L('研究范围','Research scope')}">${scopes.map(({id,text,count})=>`<button type="button" data-target-filter="${id}" aria-pressed="${filter===id}">${text}<span>${count}</span></button>`).join('')}</div><div class="pw-target-chips" aria-label="${L('研究标的','Research assets')}">${tasks.map(task=>{const on=focusAsset===task.symbol;return `<button type="button" data-target-asset="${esc(task.symbol)}" aria-pressed="${on}" aria-label="${esc(task.symbol+(on?' · '+L('取消专注','Clear focus'):''))}" data-outcome="${task.phase==='complete'?task.outcome:'working'}">${tokenIcon(task.symbol,{size:18})}<b>${esc(task.symbol)}</b><i></i>${on?`<span class="pw-target-clear" aria-hidden="true">${uiGlyph('close')}</span>`:''}</button>`;}).join('')||`<span>${L('当前范围暂无标的','No assets in this scope')}</span>`}</div>`;
 return contentOnly?content:`<section class="pw-trackbar target-scope-bar" data-localized-ui aria-label="${L('研究标的','Research assets')}"><div class="pw-track-content">${content}</div></section>`;
}
export function bindWorkbenchTargets(container,{workspace,research=workspace.research,onChange=()=>{},onManage=()=>{},notify=issue=>workspace.onError?.(issue)}){
 const disposers=[];
 for(const bar of container.querySelectorAll('.target-scope-bar')){
  const apply=(patch,button)=>{
   const focused=bar.ownerDocument.activeElement===button,issue=setWorkbenchTargets(workspace,research,patch);
   if(issue){notify(issue);return;}
   const next=readWorkbenchTargets(workspace,research);
   bar.ownerDocument.dispatchEvent(new CustomEvent('hive:target-scope-change',{detail:{filter:next.filter,focusAsset:next.focusAsset}}));onChange(next);
   if(focused){const key=button.dataset.targetAsset?'targetAsset':button.dataset.targetFilter?'targetFilter':'targetFilterSelect';[...container.querySelectorAll('[data-target-asset],[data-target-filter],[data-target-filter-select]')].find(node=>node.dataset[key]===button.dataset[key])?.focus({preventScroll:true});}
  };
  const click=event=>{const button=event.target.closest('[data-target-filter],[data-target-asset],[data-target-manage]');if(!button||!bar.contains(button))return;if(button.dataset.targetManage!==undefined){onManage();return;}apply(button.dataset.targetFilter?{filter:button.dataset.targetFilter}:{focusAsset:readWorkbenchTargets(workspace,research).focusAsset===button.dataset.targetAsset?null:button.dataset.targetAsset},button);};
  const change=event=>{if(event.target.matches('[data-target-filter-select]'))apply({filter:event.target.value},event.target);};
  bar.onclick=click;bar.onchange=change;
  disposers.push(()=>{if(bar.onclick===click)bar.onclick=null;if(bar.onchange===change)bar.onchange=null;});
 }
 return ()=>disposers.forEach(dispose=>dispose());
}
export function toggleWorkbenchWatch(workspace,symbol){
 if(workspace.account||workspace.privateUIOwner?.())return workspace.toggleTracked(symbol);
 const list=watchedSymbols(workspace),tracked=list.some(item=>sameWatchAssetKey(item,symbol));
 if(!ASSETS.some(asset=>asset[0]===symbol)&&!tracked)return L('这个标的尚未接入协作研究','This asset is not available for team research yet');
 workspace.s.aiSignalWatch=tracked?list.filter(item=>!sameWatchAssetKey(item,symbol)):[...list,symbol];
 workspace.touch();
 return workspace.persistenceError||null;
}
export const activeWorkbenchOrders=trade=>(trade?.orders||[]).filter(order=>['submitted','partial','unknown','cancel-pending'].includes(order.status));

export function workbenchAIHealth(connections={},workspace){
 const preferences=normalizeConnectionPreferences(connections.preferences),issues=[];
 const missingAgent=agentModelsIssue(preferences.ai);
 if(!connections.ai)issues.push({id:'ai',text:L('AI 模型未连接','AI models are not connected'),action:'ai'});
 else if(missingAgent!==null)issues.push({id:'models',text:L('部分 Agent 的模型配置不完整','Some Agent model settings are incomplete'),action:'ai'});
 if(!connections.data)issues.push({id:'data',text:L('研究数据未连接','Research data is not connected'),action:'data'});
 const paid=preferences.ai.source==='official'||preferences.data.source==='official';
 if(paid&&workspace.available<=0)issues.push({id:'credits',text:L('可用 AI 积分不足','No AI credits available'),route:'usage'});
 if(paid&&workspace.todayUsage>=workspace.s.budget.daily)issues.push({id:'budget',text:workspace.s.budget.daily===0?L('自动研究预算为 0','Automatic research budget is 0'):L('今日研究预算已用完','Daily research budget reached'),route:'usage'});
 return {preferences,issues,model:preferences.ai.source==='custom'?L('自带 API · 18 Agents','Own API · 18 Agents'):'Astarter AI · '+L(...AI_MODES.find(([id])=>id===preferences.ai.model).slice(1))};
}
