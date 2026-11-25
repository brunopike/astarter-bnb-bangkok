import {pair as L} from './locale.mjs';
import {readWorkbenchTargets,matchesWorkbenchTarget,renderWorkbenchTargets,bindWorkbenchTargets} from './workbench-targets.mjs';
import {CATALOG,BOT_PRODUCT_CAPABILITIES} from './strategy-catalog.mjs';
import {strategyPlan,defaultBotVariant,strategyScope,strategyVariants} from './strategy-execution-data.mjs';
import {strategyTimeframe,STRATEGY_STORY,strategyArt} from './strategy-art.mjs';
import {strategyName} from './strategy-journeys.mjs';
import {strategyAccessOptions,STRATEGY_MARKETS,strategyMarkets,strategyVenues,loadBotEditors,clearBotEditor,unpinnedCexSpotSetup} from './strategy-routing.mjs?v=20261123m';
import {liveBinanceSpotRoute} from './bot-runtime.mjs';
import {connectedAccountBalances,spotBookPerformance} from './connection-options.mjs?v=20261125c';
import {ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {botInstancesView,botHistoryView,botRunHistory} from './strategy-bot-views.mjs';
import {executionRunIdentity} from './execution-stream.mjs';
import {uiGlyph,bindSearchRender} from './product-composition.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {strategyActivityModel,strategyActivityTrendView,mountStrategyActivityTrend} from './strategy-activity-trend.mjs';

const glyphs={grid:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 10h18"/>',exchange:'<path d="M4 6h16m-4-4 4 4-4 4M20 18H4m4-4-4 4 4 4"/>'};
Object.assign(glyphs,{"S00":"<path d=\"M4 19h4V9H4zm6 0h4V5h-4zm6 0h4V2h-4z\" fill=\"currentColor\" fill-opacity=\".12\"/><path d=\"M4 9h4v10H4zm6-4h4v14h-4zm6-3h4v17h-4M3 22h18\"/>","S01":"<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"3\" fill=\"currentColor\" fill-opacity=\".1\"/><path d=\"M3 9h18M3 15h18M9 3v18M15 3v18\"/><path d=\"m5 17 5-6 4 2 5-7\"/>","S02":"<path d=\"M3 5h5v5h5v5h8\"/><path d=\"M3 19h18M6 14v5m6-3v3m6-1v1\"/><circle cx=\"6\" cy=\"13\" r=\"2\" fill=\"currentColor\" fill-opacity=\".18\"/><circle cx=\"12\" cy=\"15\" r=\"2\" fill=\"currentColor\" fill-opacity=\".18\"/><circle cx=\"18\" cy=\"17\" r=\"2\" fill=\"currentColor\" fill-opacity=\".18\"/>","S03":"<path d=\"M3 18c3 0 4-8 7-7s4 5 7 0l4-7\"/><path d=\"M3 21c5-1 8-3 11-6s5-4 7-5\" opacity=\".45\"/><path d=\"M17 4h4v4\"/>","S04":"<path d=\"M3 9h18M3 19h18\" opacity=\".4\"/><path d=\"m3 16 4-3 4 2 4-5 3 1 3-7\"/><path d=\"M18 4h3v3\"/><path d=\"M3 9h9v10H3\" fill=\"currentColor\" fill-opacity=\".08\"/>","S05":"<path d=\"M3 5h10v3H3zm0 6h7v3H3zm0 6h5v3H3\" fill=\"currentColor\" fill-opacity=\".18\"/><path d=\"M21 5h-5v3h5zm0 6h-7v3h7zm0 6H11v3h10\"/><path d=\"M12 3v18\" opacity=\".35\"/>","S06":"<path d=\"M3 19c3-9 6-12 9-8s5 3 9-7\"/><path d=\"M4 21c5-6 9-8 16-8\" opacity=\".4\"/><path d=\"m17 4 4-1v4\"/><circle cx=\"14\" cy=\"13\" r=\"2\" fill=\"currentColor\" fill-opacity=\".15\"/>","S07":"<path d=\"M3 20h18M5 14v6m5-9v9m5-13v13m5-16v16\"/><path d=\"m3 11 5-3 5 1 7-6\" opacity=\".45\"/>","S08":"<path d=\"M3 4h18M3 20h18\" opacity=\".35\"/><path d=\"M6 6v12m-2-9h4v6H4zm7-1v10m-2-8h4v6h-4zm7-4v6m-2-5h4v4h-4z\"/><path d=\"m3 4 18 6M3 20l18-6\" opacity=\".35\"/>","S09-A":"<path d=\"M4 5h6v14H4zm10 0h6v14h-6z\" fill=\"currentColor\" fill-opacity=\".08\"/><path d=\"M3 3h8v18H3zm10 0h8v18h-8zM7 8h10m-3-3 3 3-3 3M17 16H7m3-3-3 3 3 3\"/>","S09-L":"<path d=\"M3 5h18v14H3z\" fill=\"currentColor\" fill-opacity=\".08\"/><path d=\"M7 3v18m10-18v18\" opacity=\".4\"/><path d=\"M4 17c2-8 5-11 8-5s6 3 8-5\"/><circle cx=\"8\" cy=\"10\" r=\"2\"/><circle cx=\"16\" cy=\"14\" r=\"2\"/>","RX01":"<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"3\" fill=\"currentColor\" fill-opacity=\".08\"/><path d=\"M7 3v4m10-4v4M3 10h18m-12 3-2 4h4l-1 3 5-6h-4l2-3\"/>","RX02-P":"<circle cx=\"4\" cy=\"6\" r=\"2\"/><circle cx=\"4\" cy=\"18\" r=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"3\" fill=\"currentColor\" fill-opacity=\".12\"/><path d=\"m6 6 4 4m-4 8 4-4m5-2h6m-3-3 3 3-3 3\"/>","RX02-A":"<circle cx=\"7\" cy=\"8\" r=\"3\" fill=\"currentColor\" fill-opacity=\".12\"/><path d=\"M2 18v-2c0-3 2-5 5-5h2m6-7a3 3 0 0 1 0 6m-3 10 3-5 3 2 4-7\"/><circle cx=\"18\" cy=\"5\" r=\"1\" fill=\"currentColor\"/>","RX03-S":"<path d=\"M3 5h7v6H3zm11 8h7v6h-7z\" fill=\"currentColor\" fill-opacity=\".12\"/><path d=\"M3 5h7v6H3zm11 8h7v6h-7zM10 8h7v3m-3-3 3 3 3-3M14 16H7v-3m-3 3 3-3 3 3\"/>","RX03-B":"<path d=\"m3 7 9-4 9 4M5 10v7m5-7v7m5-7v4M3 20h11\"/><path d=\"M16 17h6m-3-3 3 3-3 3\"/><path d=\"M3 7h18\" opacity=\".4\"/>","RX04":"<path d=\"m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z\" fill=\"currentColor\" fill-opacity=\".1\"/><path d=\"m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6zM8 9h8m-8 4h8m-4-6v8\"/>","RX05":"<path d=\"M4 4v10m5-8v8m5-5v5m5-3v3\" opacity=\".6\"/><path d=\"m3 17 4 3 5-1 4 1 5-4M3 3l7 6 5 1 6 1\"/>"});
const glyph=key=>glyphs[key]?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[key]}</svg>`:uiGlyph(key==='trend'?'chart':key==='activity'?'pulse':key);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=v=>v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
const money=v=>v==null?'—':(v>0?'+':'')+number(v);
const ended=run=>['stopped','failed'].includes(run.status);
const hasExistingRun=trade=>Boolean(trade?.discovery?.armed||trade?.session&&!trade.session.singleShot&&(trade.state!=='stopped'||trade.position||trade.pending));
const sum=(runs,key)=>Math.round(runs.reduce((n,r)=>n+(Number(r[key])||0),0)*1e8)/1e8;
const nameOf=id=>{const item=CATALOG.find(c=>c.id===id),name=item?strategyName(item):id;return [name,name];};
const timeframeOf=id=>id==='S01'?L('逐笔 · 区间触发','Ticks · grid levels'):id==='S02'?L('逐笔 · 价格偏离','Ticks · deviation'):strategyTimeframe({id});
const btn=(text,action,id='',primary=false,disabled=false)=>`<button type="button" class="bh-button p-button${primary?' bh-primary p-primary':''}" data-bh="${action}" data-id="${esc(id)}" ${disabled?'disabled':''}>${text}</button>`;
const info=(label,text,key=label)=>`<details class="bh-info tc-info" data-persist-key="bh-info-${esc(key)}"><summary aria-label="${esc(label)}">i</summary><p>${text}</p></details>`;

const GROUPS=[['range','区间与分批','Range & scaling'],['trend','趋势与结构','Trend & structure'],['orderflow','盘口短线','Order book'],['chain','链上与资金流','On-chain & flows'],['event','事件与风控','Events & protection']];
const RECOMMENDATION_MARKETS=[['all','全部市场','All markets'],['spot','现货','Spot'],['perp','合约','Futures'],['lp','流动性','Liquidity']];
export function botRecommendationScope(row){
 const profile=STRATEGY_MARKETS.find(p=>p.id===row?.source?.instrument?.profileId);
 return profile?{profileId:profile.id,venue:profile.id.split('-')[0],market:profile.id.split('-')[1]}:null;
}
const TYPE_CONTEXT={"S00":["先看多周期，再做方向判断","Check the higher timeframes first."],"S01":["提前排好区间内的买卖","Plan each buy and sell within a range."],"S02":["把买入拆成有上限的几步","Stage entries within a fixed budget."],"S03":["顺着趋势找机会，等动量确认","Follow the trend. Wait for momentum."],"S04":["等突破站稳，再观察回踩","Wait for the break, then the retest."],"S05":["看清短时买卖力，也算清成本","Read order flow. Account for costs."],"S06":["等待回调走完，再观察延续","Wait for the pullback, then watch continuation."],"S07":["用成交量，验证价格的试探","Use volume to confirm the price test."],"S08":["等波动收窄，再看突破方向","Watch contraction, then the breakout."],"S09-A":["算清成本，再判断价差","Check costs before the spread."],"S09-L":["盯住区间，也盯住两币库存","Manage the range and both assets."],"RX01":["消息落地后，再看市场怎么走","After the news, follow the market's response."],"RX02-P":["找到叙事源头，再看现货确认","Trace the narrative. Wait for price confirmation."],"RX02-A":["从关注异动里，找值得深挖的线索","Spot attention shifts worth investigating."],"RX03-S":["区分转账与成交，核对链上买卖力量","Separate transfers from trades when reading on-chain flow."],"RX03-B":["盯住异常净流出，等待价格确认","Watch unusual outflows. Wait for price confirmation."],"RX04":["结合解锁压力，评估已有持仓的减仓条件","Assess held-position reductions against unlock pressure."],"RX05":["观察杠杆变化，再验证现货承接","Watch leverage shifts, then confirm spot demand."]};
function botTypes(){
 return CATALOG.map(c=>{
  const scope=strategyScope(c.id),name=strategyName(c),icon=c.id;
  const group=scope.icon==='chain'?'chain':c.kind==='event'?'event':c.id==='S05'?'orderflow':['S01','S02','S08'].includes(c.id)?'range':'trend';
  return {id:c.id,name:[name,name],description:TYPE_CONTEXT[c.id]||STRATEGY_STORY[c.id][0],group,icon};
 });
}
const futuresProduct=p=>p.id.startsWith('perp-')||p.id==='funding-hedge';
const canSimulate=id=>['S01','S02'].includes(id)&&strategyPlan(id,defaultBotVariant(id)).flowAvailable;
function strategyWalletLabels(id){
 const profiles=strategyMarkets(id),labels=[];
 if(profiles.some(profile=>profile.startsWith('cex')))labels.push(['币安 CEX','Binance CEX']);
 labels.push(String(id).startsWith('S09')?['Ethereum 钱包','Ethereum wallet']:['BNB Chain 钱包','BNB Chain wallet']);
 return labels;
}
// Entry capability is read from the routing profiles, the simulation gate and the plan's own flow; the catalog execution field is not proof of a run path.
export function botEntryCapability(id){
 if(!CATALOG.some(c=>c.id===id))return null;
 const ready=canSimulate(id),plan=strategyPlan(id,defaultBotVariant(id)),flow=!ready&&Boolean(plan?.flowAvailable),profiles=strategyMarkets(id);
 return {id,ready,action:ready?'simulate':flow?'workspace':'research',profiles,
  markets:profiles.map(key=>STRATEGY_MARKETS.find(p=>p.id===key)).filter(Boolean).map(p=>[p.zh,p.en]),
  requirements:ready?['DEMO 账户 SIM-01 的 Binance 现货接入；交易对在设置时选择。','A Binance spot connection on DEMO account SIM-01. Choose the trading pair during setup.']:flow?[...plan.need]:['暂无可运行路径；交易对在设置时选择。','No run path yet. Choose the trading pair during setup.'],
  actions:ready?['查看规则 · 保存方案 · 本机运行','Review rules · Save plan · Local run']:flow?['查看规则 · 保存方案 · 本机配置','Review rules · Save plan · Local setup']:['仅研究：查看规则 · 保存方案','Research only: review rules · Save plan']};
}

export function filterBotRuns(runs,type='all'){
 return type==='all'?runs:runs.filter(run=>run.plan.strategy===type);
}

export function botRunTarget(trade,scope,id){
 if(!trade||!id)return null;
 const own=row=>(row.accountId||trade.accountId||'SIM-01')===scope.accountId&&(row.environment||trade.environment||'DEMO')===(scope.environment||'DEMO');
 const native=trade.botBook?.runs?.find(run=>run.id===id&&own(run.plan.executionRoute));
 if(native)return {id,tab:ended(native)&&!Number(native.quantity)?'history':'current'};
 const legacy=executionRunIdentity(trade,{accountId:trade.accountId||'SIM-01',environment:trade.environment||'DEMO'});
 if(legacy?.runId===id&&own(legacy)&&hasExistingRun(trade))return {id,tab:'current'};
 const history=botRunHistory({...trade,events:(trade.events||[]).filter(own),orders:(trade.orders||[]).filter(own)}).find(run=>run.id===id);
 return history?{id,tab:'history'}:null;
}

function walletAccountId(value){
 const id=typeof value==='string'?value.toLowerCase():'';
 return /^0x[0-9a-f]{40}$/.test(id)?id:'';
}
function matchesLiveAccount(route,market,live){
 if(!route)return false;
 if(live.kind==='wallet'){
  const accountId=walletAccountId(route.accountId);
  if(accountId!==live.accountId||route.connectionId!=='wallet-bsc')return false;
  const chainId=route.chainId==null||route.chainId===''?'56':String(route.chainId);
  return chainId==='56'&&(!route.venueId||route.venueId==='pancakeswap')&&(!route.profileId||route.profileId==='dex-spot')&&(!market||!route.market||route.market===market);
 }
 return liveBinanceSpotRoute({...route,chainId:route.chainId||''},market||route.market);
}
function editorParameters(editor){
 const direct=editor?.botParameters;
 if(direct&&typeof direct==='object'&&Number(direct.lower)>0&&Number(direct.upper)>0)return direct;
 const sets=Object.values(editor?.botParameterSets||{});
 return sets.find(set=>set?.parameters&&Number(set.parameters.lower)>0&&Number(set.parameters.upper)>0)?.parameters||direct||{};
}
function livePlanRows(w,live){
 const match=(route,market)=>matchesLiveAccount(route,market,live);
 const drafts=(w?.s?.drafts||[]).filter(draft=>Number(draft.cap)>0&&match(draft.executionRoute,draft.market));
 const ids=new Set(drafts.map(draft=>draft.id));
 const editors=w?.s?Object.entries(loadBotEditors(w)).flatMap(([key,editor])=>{
  if(!editor||ids.has(editor.draftId)||!CATALOG.some(item=>item.id===editor.id)||!editor.executionRoute?.market||!match(editor.executionRoute,editor.executionRoute.market))return [];
  const botParameters=editorParameters(editor),cap=Number(editor.cap);
  if(!(Number.isFinite(cap)&&cap>0))return [];
  return [{id:'editor:'+key,strategy:editor.id,market:editor.executionRoute.market,cap,botParameters,executionRoute:editor.executionRoute,configured:true}];
 }):[];
 return [...drafts,...editors];
}
const planAllocation=rows=>Math.round(rows.reduce((total,draft)=>total+(Number(draft.cap)||0),0)*1e8)/1e8;
function dropEditorKey(w,key){
 const editors=loadBotEditors(w),editor=editors[key];if(!editor)return false;
 const names=Object.keys(editors).filter(name=>name===key||editor.draftId&&editors[name]?.id===editor.id&&(editors[name].draftId===editor.draftId||name===editor.id+':draft:'+editor.draftId));
 return names.every(name=>clearBotEditor(w,name));
}
export async function removeLivePlan(w,id,trade){
 if(!w?.s||typeof id!=='string'||!id||id==='D-S03')return false;
 if(trade?.botBook?.runs?.some(run=>run.plan?.id===id&&!['stopped','failed'].includes(run.status)))return false;
 if(id.startsWith('editor:'))return dropEditorKey(w,id.slice(7));
 const draft=w.s.drafts?.find(row=>row.id===id);if(!draft)return false;
 if(w.account&&draft.resourceKey){try{await w.account.resource('strategy',draft.resourceKey,true);}catch{return false;}}
 w.s.drafts=w.s.drafts.filter(row=>row.id!==id);
 if(w.s.selectedDraftId===id)w.s.selectedDraftId=w.s.drafts.find(row=>row.id!=='D-S03')?.id||w.s.drafts[0]?.id||null;
 for(const name of Object.keys(loadBotEditors(w)))if(w.s.botEditors[name]?.draftId===id)clearBotEditor(w,name);
 w.touch?.();
 return true;
}

export function botHubSummary(trade,accountId='SIM-01'){
 if(!trade)return {current:[],history:[],runs:[],activeCount:0,existingActive:false,pnl:null,fees:null,allocated:null,equity:null,realized:null};
 const runs=(trade.botBook?.runs||[]).filter(run=>run.plan?.executionRoute?.accountId===accountId);
 const current=runs.filter(run=>!ended(run)||Number(run.quantity)>0),history=runs.filter(ended);
 return {runs,current,history,activeCount:runs.filter(run=>!ended(run)).length+(hasExistingRun(trade)?1:0),existingActive:hasExistingRun(trade),
  pnl:sum(runs,'realizedPnl')+sum(runs,'unrealizedPnl'),fees:sum(runs,'fees'),
  allocated:sum(current,'allocated'),equity:sum(current,'equity'),realized:sum(runs,'realizedPnl')};
}

export function botHubCards(trade,accountId='SIM-01'){
 const runs=botHubSummary(trade,accountId).runs;
 return botTypes().map(type=>{
  const records=runs.filter(run=>run.plan.strategy===type.id),allocation=sum(records,'initialAllocation');
  const pnl=records.length?sum(records,'realizedPnl')+sum(records,'unrealizedPnl'):null;
  const plan=strategyPlan(type.id,defaultBotVariant(type.id));
  return {...type,plan,pnl,roi:pnl==null||!allocation?null:pnl/allocation*100,
   scope:strategyScope(type.id).label,runs:records,series:botReturnSeries(records),ready:canSimulate(type.id),capability:botEntryCapability(type.id)};
 });
}

export function botReturnSeries(runs){
 let capital=0,pnl=0;
 return runs.filter(run=>run.status==='stopped'&&Number(run.quantity)===0&&run.startedAt!=null&&Number.isFinite(run.endedAt)&&Number.isFinite(run.initialAllocation)&&run.initialAllocation>0&&Number.isFinite(run.realizedPnl)).sort((a,b)=>a.endedAt-b.endedAt).map(run=>{
  capital+=run.initialAllocation;pnl+=run.realizedPnl;
  return {id:run.id,at:run.endedAt,value:pnl/capital*100};
 });
}
function returnCurve(points){

 const min=Math.min(0,...points.map(p=>p.value)),max=Math.max(0,...points.map(p=>p.value)),range=max-min||1;
 const xy=points.map((p,i)=>[4+i*104/(points.length-1),42-(p.value-min)/range*32]),zero=42-(0-min)/range*32;
 return `<svg class="bh-run-curve ${points.at(-1).value<0?'bh-loss':'bh-profit'}" viewBox="0 0 112 50" role="img" aria-label="${L('按结束顺序累计的模拟收益率','Cumulative simulated return, in completion order')}"><path class="bh-curve-area" d="M4 ${zero}L${xy.map(p=>p.join(' ')).join('L')}L108 ${zero}Z"/><path class="bh-curve-baseline" d="M4 ${zero}H108"/><polyline points="${xy.map(p=>p.join(',')).join(' ')}"/>${points.map((p,i)=>`<circle cx="${xy[i][0]}" cy="${xy[i][1]}" r="2"><title>${esc(p.id)} · ${money(p.value)}%</title></circle>`).join('')}</svg>`;
}

function strategyCard(card,tracked=[]){
 const p=card.plan,hasReturn=card.roi!=null;
 return `<article class="bh-strategy-card" data-bot-strategy="${card.id}" data-simulation-ready="${card.ready}" data-entry-action="${card.capability.action}">
  <header><div><span class="bh-card-symbol">${glyph(card.icon)}</span><div><h3 title="${esc(L(...card.name))}">${esc(L(...card.name))}</h3><span>${esc(L(...card.scope))}</span></div></div><button class="bh-icon-button" type="button" data-bh="track" data-id="${card.id}" aria-label="${L('追踪此策略','Track strategy')}" aria-pressed="${tracked.includes(card.id)}">${glyph('star')}</button></header>
  <div class="bh-tags">${strategyWalletLabels(card.id).map(label=>`<span data-wallet-type>${esc(L(...label))}</span>`).join('')}<span>${L(card.ready?'可运行模拟':'研究方案',card.ready?'Simulation available':'Research plan')}</span><span>${strategyVariants(card.id).length?strategyVariants(card.id).length+1+' '+L('个版本','versions'):L('原版','Original')}</span>${card.capability.markets.map(m=>`<span data-entry-market>${esc(L(...m))}</span>`).join('')}</div>
  <p class="bh-card-context">${esc(L(...card.description))}</p>
  ${hasReturn?`<div class="bh-return"><div><span>${L('累计模拟收益率','Cumulative paper return')}${info(L('收益率口径','Return definition'),L('本账户实例净收益 ÷ 原始分配资金，包含浮动盈亏与交易费。曲线仅按结束顺序展示已结束且清仓实例的累计收益率；不是行情、净值时间线或回测。','Net paper PnL divided by initial allocations, including unrealized PnL and fees. The curve accumulates closed, flat runs in completion order; it is not a market chart, NAV timeline or backtest.'),'return-'+card.id)}</span><strong class="${card.roi<0?'bh-loss':card.roi>0?'bh-profit':''}">${money(card.roi)}%</strong></div>${card.series.length>1?returnCurve(card.series):''}</div>`:''}
  <footer class="bh-card-actions"><details class="bh-card-rules tc-info" data-persist-key="bh-rules-${card.id}"><summary aria-label="${L('查看规则摘要','View rule summary')} · ${esc(L(...card.name))}">${L('规则摘要','Rules')}${glyph('chevron')}</summary><div class="bh-rules-panel"><b>${esc(L(...card.name))}</b><dl class="bh-card-facts"><div><dt>${L('执行周期','Timeframe')}</dt><dd>${timeframeOf(card.id)}</dd></div><div><dt>${L('策略条件','Setup')}</dt><dd>${esc(L(...p.entry))}</dd></div><div><dt>${L('退出规则','Exit')}</dt><dd>${esc(L(...p.exit))}</dd></div><div><dt>${L('运行条件','Requirements')}</dt><dd>${esc(L(...card.capability.requirements))}</dd></div><div><dt>${L('可用操作','Available actions')}</dt><dd>${esc(L(...card.capability.actions))}</dd></div></dl></div></details>${btn(L('创建','Create'),'choose',card.id)}</footer>
 </article>`;
}

function overviewMetrics(trade,accountId){
 const s=botHubSummary(trade,accountId);
 return `<section class="bh-overview-account" aria-label="${L("Agent 资产概览","Agent asset overview")}"><div class="bh-overview-metrics"><div><span class="bh-equity-label"><span>${L("模拟盘 · Agent 权益","Paper Agent equity")} <small>USDT</small></span>${info(L('资产口径','Asset definition'),L("网格与分批买入 Agent 的本地模拟资产与收益。其它策略运行在“我的 Agent”中单列。","Local simulated assets and PnL from grid and DCA Agents. Other strategy runs are listed separately in My Agents."))}</span><strong>${number(s.equity)}</strong></div><div><span>${L('累计模拟盈亏','Cumulative simulated PnL')} <small>USDT</small></span><strong class="${s.pnl>0?'bh-profit':s.pnl<0?'bh-loss':''}">${money(s.pnl)}</strong></div><button type="button" class="bh-running-link" data-bh="assets"><span>${L('进行中','Ongoing')} ${glyph('chevron')}</span><strong>${number(trade?s.activeCount:null)}</strong></button></div><div class="bh-account-actions"><button type="button" class="bh-button" data-statements="STRATEGY_AGENT" aria-haspopup="dialog">${glyph('history')}${L('交易记录','Trade history')}</button><button type="button" class="bh-button" data-bh="assets">${glyph('strategy')}${L("我的 Agent","My Agents")}</button>${btn(glyph('plus')+L("添加 Agent","Add Agent"),'create','',true)}</div></section>`;
}

function typeTile(id,name,description,icon,available=true,productId=id){
 const action=available?L('创建','Create'):BOT_PRODUCT_CAPABILITIES.find(p=>p.id===productId)?.kind==='execution'?L("支持状态","Check support"):L("查看方案","View plan");
 return `<button class="bh-type-card" data-bot-product="${esc(productId)}" type="button" data-bh="${available||CATALOG.some(c=>c.id===id)?'choose':'capability'}" data-id="${id}"><span class="bh-type-icon">${glyph(icon)}</span><h3>${L(...name)}</h3><p>${L(...description)}</p><footer><span>${action}</span>${glyph('arrow')}</footer></button>`;
}

function recommendationExecutable(row){
 return Boolean(row?.canAdopt&&row.status==='ready'&&row.executable===true&&row.freshness==='current'&&canSimulate(row.strategy)&&row.variant===defaultBotVariant(row.strategy)&&botRecommendationScope(row)?.profileId==='cex-spot'&&row.source?.instrument?.venueId==='binance');
}
function recommendationConfigurable(row){
 const plan=typeof row?.variant==='string'?strategyPlan(row.strategy,row.variant):null;
 if(row?.freshness==='expired'||!row?.source?.instrument||!CATALOG.some(item=>item.id===row.strategy)||plan?.variant!==row.variant)return false;
 if(canSimulate(row.strategy))return recommendationExecutable(row);
 const input=row.source.instrument,scope=botRecommendationScope(row);
 const venueOk=(!input.profileId||scope&&strategyMarkets(row.strategy).includes(scope.profileId))&&(!scope||!input.venueId||strategyVenues(scope.profileId).some(v=>v.id===input.venueId));
 if(!venueOk)return false;
 return Boolean(row.canAdopt&&row.status!=='unavailable'||unpinnedCexSpotSetup(row));
}
function recommendationLogic(row){
 const plan=strategyPlan(row.strategy,row.variant),scope=botRecommendationScope(row),profile=STRATEGY_MARKETS.find(p=>p.id===scope?.profileId),ready=recommendationExecutable(row),configurable=recommendationConfigurable(row);
 const text=value=>Array.isArray(value)?L(...value):value||'—';
 const reason=text(row.reason),issue=ready?L('设置投入与资金保护后，确认启动','Set allocation and protection, then confirm the start'):text(row.unavailableReason||['模拟条件尚待核对','Simulation conditions need review']);
 return `<section class="bh-recommendation-logic" data-localized-ui><header><div>${tokenIcon(row.asset||'',{size:36})}<div><h3>${esc(row.market||row.asset)}</h3><span>${esc(L(...nameOf(row.strategy)))}</span></div></div><span class="bh-logic-status">${L(ready?'可模拟':configurable?'可配置':'待确认',ready?'Simulation ready':configurable?'Ready to configure':'Needs review')}</span></header><div class="bh-logic-visual">${strategyArt(row.strategy).replace('viewBox="0 0 400 240"','viewBox="0 35 400 170"')}</div><div class="bh-logic-steps"><article><span class="bh-logic-step">1</span><h4>${L('研究线索','Research lead')}</h4><p>${esc(reason)}</p></article><article><span class="bh-logic-step">2</span><h4>${L('入场条件','Entry conditions')}</h4><p>${esc(L(...plan.entry))}</p></article><article><span class="bh-logic-step">3</span><h4>${L('退出与保护','Exit & protection')}</h4><p>${esc(L(...plan.exit))}</p></article></div><dl class="bh-logic-facts"><div><dt>${L('执行周期','Timeframe')}</dt><dd>${esc(timeframeOf(row.strategy))}</dd></div><div><dt>${L('交易市场','Market')}</dt><dd>${profile?esc(L(profile.zh,profile.en)):L('待确认','Unconfirmed')}</dd></div><div><dt>${L('来源时效','Source freshness')}</dt><dd>${L(row.freshness==='current'?'有效':row.freshness==='expired'?'已过期':'待核实',row.freshness==='current'?'Current':row.freshness==='expired'?'Expired':'Unverified')}</dd></div></dl><div class="bh-logic-verdict" role="status">${glyph(ready?'check':'info')}<p>${esc(issue)}</p></div><footer>${btn(L('原始依据','Original evidence'),'recommendation-source',row.id)}${btn(L('使用此策略','Use this strategy'),'recommendation',row.id,true,!configurable)}</footer></section>`;
}
export function recommendationKey(row){
 const source=row.source||{},instrument=source.instrument||{};
 return JSON.stringify([row.sourceType||source.type||'',row.sourceId||source.id||row.id,row.strategy,row.market||row.asset,instrument.profileId||'',instrument.venueId||'',instrument.chainId||'']);
}
export function recommendationItems(rows,{venue='all',market='all'}={}){
 const latest=new Map();
 for(const row of rows){
  if(!row?.id||!CATALOG.some(s=>s.id===row.strategy)||row.freshness==='expired'||row.sourceType==='signal'&&!Number.isFinite(row.expiresAt))continue;
  const scope=botRecommendationScope(row);
  if(venue!=='all'&&scope?.venue!==venue||market!=='all'&&scope?.market!==market)continue;
  const key=recommendationKey(row),previous=latest.get(key);
  if(!previous||Number(row.asOf??-1)>Number(previous.asOf??-1))latest.set(key,row);
 }
 const priority=row=>recommendationExecutable(row)?2:recommendationConfigurable(row)?1:0;
 return [...latest.values()].sort((a,b)=>priority(b)-priority(a)||Number(b.asOf??-1)-Number(a.asOf??-1)||String(a.asset).localeCompare(String(b.asset)));
}
const FLOW_PICK_EXIT=["2 ATR 止损、2R 目标；条件失效或 16 根 K 线退出。", "2 ATR stop, 2R target. Exit on invalidation or 16 bars."];
const PICK_PREVIEWS={
 "S03":{entry:["均线上行，等待 RSI 上穿 50。", "Wait for RSI to cross above 50 in an uptrend."],exit:["2 ATR 止损；RSI 转弱或 36 根 K 线退出，无固定止盈。", "2 ATR stop. Exit on weak RSI or 36 bars; no fixed target."]},
 "RX03-S":{entry:["指定池买卖差达标，等待现货突破确认。", "Qualified pool flow, then a confirmed spot breakout."],exit:FLOW_PICK_EXIT},
 "RX02-A":{entry:["社媒提及和互动异常增加，等待现货突破确认。", "Unusual mentions and engagement, then a confirmed spot breakout."],exit:FLOW_PICK_EXIT},
};
function recommendationCard(row){
 const scope=botRecommendationScope(row),ready=recommendationExecutable(row),configurable=recommendationConfigurable(row),marketName=RECOMMENDATION_MARKETS.find(([id])=>id===scope?.market),plan=strategyPlan(row.strategy,row.variant);
 // Unclassified research gets a stable visual accent, never an inferred market.
 const accent=scope?'':['red','yellow','green','blue'][[...recommendationKey(row)].reduce((sum,char)=>sum+char.charCodeAt(0),0)%4];
 const preview=plan.variant==='baseline'?(PICK_PREVIEWS[row.strategy]||plan):plan;
 const issue=Array.isArray(row.unavailableReason)?L(...row.unavailableReason):row.unavailableReason;
 return `<article class="bh-suggestion bh-recommendation-card" data-recommendation="${esc(row.id)}" data-pick-key="${esc(recommendationKey(row))}" data-recommendation-profile="${scope?.profileId||''}"${accent?` data-research-accent="${accent}"`:''} data-recommendation-strategy="${esc(row.strategy)}" role="group" aria-label="${esc(L(...nameOf(row.strategy)))} · ${esc(row.market||row.asset)}"><div class="bh-suggestion-body">${scope?`<div class="bh-ai-meta"><span class="bh-ai-market">${scope.venue.toUpperCase()} · ${L(marketName[1],marketName[2])}</span></div>`:`<div class="bh-ai-meta"><span class="bh-ai-market bh-ai-market-unconfirmed">${L('市场待确认','Confirm market')}</span></div>`}<header><div><h3>${esc(L(...nameOf(row.strategy)))}</h3></div></header><div class="bh-pick-asset">${tokenIcon(row.asset||row.market?.split('/')[0]||'',{size:28})}<strong>${esc(row.market||row.asset)}</strong></div><dl class="bh-pick-plan"><div class="bh-pick-timeframe"><dt>${L('执行周期','Timeframe')}</dt><dd>${esc(timeframeOf(row.strategy))}</dd></div><div><dt>${L('入场','Entry')}</dt><dd>${esc(L(...preview.entry))}</dd></div><div><dt>${L('退出','Exit')}</dt><dd>${esc(L(...preview.exit))}</dd></div></dl></div><footer>${btn(L('查看','View'),'recommendation-logic',row.id)}<span${!ready?' title="'+esc(issue||L('模拟条件尚待核对','Simulation conditions need review'))+'"':''}>${btn(L('使用此策略','Use this strategy'),'recommendation',row.id,true,!configurable)}</span></footer></article>`;
}
function suggestionCards(rows,{venue='all',market='all'}={}){
 const cards=recommendationItems(rows,{venue,market}),filtered=venue!=='all'||market!=='all';
 const filters=(key,label,options,value)=>`<div class="bh-recommendation-filter"><span class="bh-filter-label">${key==='venue'?L('场所','Venue'):L('市场','Market')}</span><div class="bh-recommendation-segment segmented" role="group" aria-label="${label}">${options.map(([id,zh,en])=>`<button type="button" data-bh="recommendation-${key}" data-id="${id}" aria-pressed="${value===id}" tabindex="${value===id?0:-1}">${L(zh,en)}</button>`).join('')}</div></div>`;
 const controls=cards.length>1?`<div class="bh-carousel-controls"><button type="button" class="bh-button p-button" data-bh="recommendation-prev" aria-controls="bh-recommendation-rail" aria-label="${L('上一组策略','Previous picks')}">${glyph('chevron')}</button><output class="bh-pick-count" data-pick-count>1 / ${cards.length}</output><button type="button" class="bh-button p-button" data-bh="recommendation-next" aria-controls="bh-recommendation-rail" aria-label="${L('下一组策略','Next picks')}">${glyph('chevron')}</button><button type="button" class="bh-button p-button bh-carousel-pause" data-bh="recommendation-pause" aria-label="${L('暂停轮播','Pause carousel')}" aria-pressed="false">${L('暂停','Pause')}</button></div>`:'';
 const heading=`<header class="section-heading bh-suggestions-heading"><h2 id="bh-suggestions-title">${L('此刻臻选','In focus now')}</h2><div class="bh-recommendation-filters">${filters('venue',L('推荐场所','Recommendation venue'),[['all','全部','All'],['cex','CEX','CEX'],['dex','DEX','DEX']],venue)}${filters('market',L('推荐市场','Recommendation market'),RECOMMENDATION_MARKETS.map(row=>row[0]==='all'?['all','全部','All']:row),market)}</div></header>`;
 if(!cards.length)return `<section class="bh-suggestions bh-suggestions-empty" aria-labelledby="bh-suggestions-title">${heading}<div class="bh-research-empty"><span class="bh-empty-research-icon">${glyph('pulse')}</span><div><h3>${L('暂无匹配机会','No matching opportunities')}</h3></div>${filtered?btn(L('重置筛选','Reset filters'),'recommendation-reset'):btn(L('浏览 Agent','Explore Agents'),'library')}</div></section>`;
 return `<section class="bh-suggestions" aria-labelledby="bh-suggestions-title">${heading}<div class="bh-suggestion-grid" id="bh-recommendation-rail" data-bh-recommendation-rail data-card-count="${cards.length}" tabindex="0" role="region" aria-roledescription="carousel" aria-labelledby="bh-suggestions-title">${cards.map(recommendationCard).join('')}</div>${controls}</section>`;
}
// Orbital placement adapted from NexusUI / 21st Circular Carousel, demo 21951.
export function recommendationCarouselPosition(index,active,total,width){
 if(!Number.isInteger(total)||total<1)return null;
 active=((active%total)+total)%total;
 let offset=index-active;if(offset>total/2)offset-=total;if(offset< -total/2)offset+=total;
 // Leave room between desktop neighbors and the 380px center card.
 const distance=Math.abs(offset),angle=Math.max(-3,Math.min(3,offset))/5*Math.PI,radius=Math.max(0,width*.56,width>=768?690:0);
 return {x:Math.sin(angle)*radius,y:0,scale:1,opacity:distance>2?0:1-distance*.16,zIndex:10-distance,offset};
}
export function mountRecommendationCarousel(root,state){
 const rail=root.querySelector('[data-bh-recommendation-rail]');
 if(!rail?.querySelectorAll||!rail.getBoundingClientRect||!rail.clientWidth)return null;
 const cards=[...rail.querySelectorAll('[data-recommendation]')];if(!cards.length)return null;
 const media=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),count=root.querySelector('[data-pick-count]'),pause=root.querySelector('[data-bh="recommendation-pause"]');
 let index=cards.findIndex(card=>card.dataset.pickKey===state.key),timer=null,disposed=false,hovered=rail.matches?.(':hover')||false,focused=rail.contains?.(document.activeElement)||false,visible=true,drag=null,motionTimer=null,ignoreClickUntil=0;
 if(index<0)index=Math.min(state.index||0,cards.length-1);if(!state.nextAt)state.nextAt=Date.now()+12000;
 const reduced=()=>media?.matches||document.documentElement?.dataset?.reducedMotion==='true';
 const controlTarget=target=>target?.closest?.('button,a,input,select,textarea,footer');
 const blocked=()=>state.paused||drag||reduced()||hovered||focused||!visible||document.visibilityState==='hidden'||document.querySelector('dialog[open]');
 function paint(){
  const width=rail.clientWidth,mobile=(rail.ownerDocument?.defaultView?.innerWidth||width)<768;
  rail.classList.add('is-circular');rail.classList.toggle('is-reduced',Boolean(reduced()));
  cards.forEach((card,i)=>{const pos=recommendationCarouselPosition(i,index,cards.length,width),exposed=pos.opacity>0&&(i===index||!mobile&&Math.abs(pos.x)<(width+(card.offsetWidth||380)*pos.scale)/2);card.style.transform=`translateX(${pos.x}px)`;card.style.opacity=pos.opacity?'1':'0';card.style.setProperty('--bh-pick-opacity',String(pos.opacity));card.style.zIndex=String(pos.zIndex);card.style.pointerEvents=pos.opacity?'':'none';card.classList.toggle('is-active',i===index);card.setAttribute('aria-current',String(i===index));card.setAttribute('aria-hidden',String(!exposed));for(const button of card.querySelectorAll('button,a'))button.tabIndex=exposed?0:-1;});
  state.index=index;state.key=cards[index].dataset.pickKey;
  if(count)count.textContent=(index+1)+' / '+cards.length;
  if(pause){pause.hidden=Boolean(reduced());pause.textContent=L(state.paused?'继续':'暂停',state.paused?'Resume':'Pause');pause.setAttribute('aria-label',L(state.paused?'继续轮播':'暂停轮播',state.paused?'Resume carousel':'Pause carousel'));pause.setAttribute('aria-pressed',String(Boolean(state.paused)));}
 }
 function schedule(){clearTimeout(timer);timer=null;if(!disposed&&cards.length>1&&!blocked()&&rail.isConnected!==false)timer=setTimeout(()=>{if(blocked()){state.nextAt=Date.now()+12000;return;}go(index+1);},Math.max(0,state.nextAt-Date.now()));}
 function go(next,keyboard=false){clearTimeout(motionTimer);if(!reduced()){rail.dataset.interacting='true';motionTimer=setTimeout(()=>{if(!drag)delete rail.dataset.interacting;},700);}index=((next%cards.length)+cards.length)%cards.length;state.nextAt=Date.now()+12000;paint();schedule();if(keyboard)rail.focus({preventScroll:true});}
 function interaction(){state.nextAt=Date.now()+12000;schedule();}
 rail.onmouseenter=()=>{hovered=true;interaction();};rail.onmouseleave=()=>{hovered=false;if(drag?.control){drag=null;delete rail.dataset.interacting;}interaction();};
 rail.onfocusin=()=>{focused=true;interaction();};rail.onfocusout=event=>{focused=rail.contains(event.relatedTarget);interaction();};
 rail.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||controlTarget(event.target))return;event.preventDefault();go(event.key==='Home'?0:event.key==='End'?cards.length-1:index+(event.key==='ArrowLeft'?-1:1),true);};
 rail.onclick=event=>{if(Date.now()<ignoreClickUntil||controlTarget(event.target))return;const card=event.target.closest('[data-recommendation]'),next=cards.indexOf(card);if(next>=0)go(next);};
 rail.onpointerdown=event=>{if(event.button>0)return;const control=Boolean(controlTarget(event.target));drag={x:event.clientX,y:event.clientY,card:control?null:event.target.closest('[data-recommendation]'),control};rail.dataset.interacting='true';if(!control)rail.setPointerCapture?.(event.pointerId);interaction();};
 const finish=event=>{const start=drag;drag=null;delete rail.dataset.interacting;if(start&&!start.control&&event.type!=='pointercancel'){const dx=event.clientX-start.x,dy=event.clientY-start.y;if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)*1.2){ignoreClickUntil=Date.now()+300;go(index+(dx<0?1:-1));}else if(Math.abs(dx)<8&&Math.abs(dy)<8&&start.card){ignoreClickUntil=Date.now()+300;go(cards.indexOf(start.card));}}interaction();};
 rail.onpointerup=finish;rail.onpointercancel=finish;
 const visibility=()=>{state.nextAt=Date.now()+12000;schedule();},motion=()=>{paint();visibility();};
 document.addEventListener?.('visibilitychange',visibility);media?.addEventListener?.('change',motion);
 let resize,intersection;if(typeof ResizeObserver==='function'){resize=new ResizeObserver(paint);resize.observe(rail);cards.forEach(card=>resize.observe(card));}
 if(typeof IntersectionObserver==='function'){intersection=new IntersectionObserver(entries=>{const next=entries.some(entry=>entry.isIntersecting);if(next!==visible){visible=next;visibility();}});intersection.observe(rail);}
 paint();schedule();
 return {step:direction=>go(index+direction),toggle(){state.paused=!state.paused;paint();interaction();},dispose(){disposed=true;clearTimeout(timer);clearTimeout(motionTimer);resize?.disconnect();intersection?.disconnect();document.removeEventListener?.('visibilitychange',visibility);media?.removeEventListener?.('change',motion);delete rail.dataset.interacting;}};
}

export function renderBotOverview({w,trade,accountId='SIM-01',environment='DEMO',activityMetric='fills',category='recommended',group='all',query='',sort='default',trackedOnly=false,readyOnly=false,recommendationVenue='all',recommendationMarket='all',recommendations=[]}={}){
 const library=botHubCards(trade,accountId);
 let cards=library.filter(card=>(group==='all'||(group==='ready'?card.ready:card.group===group))&&(!query||[...card.name,...card.scope,card.id].join(' ').toLowerCase().includes(query.toLowerCase()))&&(!trackedOnly||(w.s.botTrackedTypes||[]).includes(card.id))&&(!readyOnly||card.ready));
 if(sort==='default')cards.sort((a,b)=>Number(b.ready)-Number(a.ready));
 if(sort==='returns')cards.sort((a,b)=>(b.roi??-Infinity)-(a.roi??-Infinity));
 if(sort==='runs')cards.sort((a,b)=>b.runs.length-a.runs.length);
 const categories=[['recommended','推荐','Recommended'],['spot','现货','Spot'],['onchain','链上','On-chain'],['futures','合约','Futures']];
 if(category==='onchain')cards=cards.filter(c=>c.group==='chain');
 if(category==='spot')cards=cards.filter(c=>!c.id.startsWith('S09'));
 const types=botTypes();
 const selection=readWorkbenchTargets(w),suggestions=suggestionCards(recommendations.filter(row=>matchesWorkbenchTarget(row.asset||row.source?.instrument?.symbol||row.market?.split('/')[0],selection)),{venue:recommendationVenue,market:recommendationMarket});
 const products=BOT_PRODUCT_CAPABILITIES.filter(p=>futuresProduct(p)&&!readyOnly&&(group==='all'||library.some(c=>c.id===p.family&&c.group===group))&&(!query||[...p.name,...p.scope,p.id,p.family||''].join(' ').toLowerCase().includes(query.toLowerCase()))&&(!trackedOnly||(w.s.botTrackedTypes||[]).includes(p.family)));
 const tiles=products.map(p=>typeTile(p.id,p.name,p.scope,p.id.includes('grid')?'grid':p.id.includes('dca')?'layers':'strategy',false,p.id)).join('');
 return `<div class="bh-root bh-overview" data-bot-page="overview" data-localized-ui>
 <header class="bh-overview-hero page-head"><div class="bh-hero-copy"><h1>${L("策略总览","Strategy overview")}</h1></div></header>
 ${renderWorkbenchTargets(w)}
 ${overviewMetrics(trade,accountId)}<section class="bh-library-area">

 ${suggestions}
 ${strategyActivityTrendView(strategyActivityModel(trade,{accountId,environment}),activityMetric)}
 <section class="bh-catalog" aria-labelledby="bh-ai-title"><div class="bh-section-heading section-heading"><h2 id="bh-ai-title">${L("Agent 列表","Agent catalog")}<span class="bh-result-count">${category==='futures'?products.length:cards.length}</span></h2></div><nav class="bh-category-tabs segmented" aria-label="${L('适用市场','Market')}">${categories.map(([id,zh,en])=>`<button type="button" data-bh="category" data-id="${id}" aria-pressed="${category===id}">${L(zh,en)}</button>`).join('')}</nav><div class="bh-filter-bar"><div class="bh-filter-options"><label><span class="sr-only">${L('策略类型','Strategy type')}</span><select data-bh-select="group" aria-label="${L('策略类型','Strategy type')}">${[['all','全部类型','All types'],...GROUPS].map(([v,zh,en])=>`<option value="${v}" ${v===group?'selected':''}>${L(zh,en)}</option>`).join('')}</select></label><label class="bh-search search-field">${glyph('search')}<input type="search" name="strategySearch" autocomplete="off" autocapitalize="off" spellcheck="false" data-bh-search aria-label="${L("搜索 Agent","Search Agents")}" placeholder="${L("名称或编号，如 S01","Name or ID, e.g. S01")}" value="${esc(query)}"></label><button type="button" class="bh-filter-chip p-button" data-bh="tracked-only" aria-label="${L('我的追踪','Tracking')}" aria-pressed="${trackedOnly}">${glyph('star')}<span>${L('我的追踪','Tracking')}</span></button><button type="button" class="bh-filter-chip p-button" data-bh="ready-only" title="${L('支持本地模拟；启动前仍需账户与风控检查','Supports local simulation; account and risk checks still apply')}" aria-pressed="${readyOnly}">${glyph('check')}<span>${L('支持模拟','Supports simulation')}</span></button></div><label class="bh-sort"><span class="sr-only">${L('排序','Sort')}</span><select data-bh-select="sort" aria-label="${L('排序','Sort')}">${[['default','默认排序','Default'],['returns','模拟收益率','Paper ROI'],['runs','实例数','Runs']].map(([v,zh,en])=>`<option value="${v}" ${v===sort?'selected':''}>${L(zh,en)}</option>`).join('')}</select></label></div><div class="${category==='futures'?'bh-type-grid':'bh-strategy-grid'}">${(category==='futures'?tiles:cards.map(c=>strategyCard(c,w.s.botTrackedTypes||[])).join(''))||`<div class="bh-filter-empty">${L('没有匹配策略，换个条件再看看','No matches yet. Try another filter.')}${btn(L('重置筛选','Reset filters'),'reset')}</div>`}</div></section>
 </section>
 <section class="bh-help"><h2>${L('常见问题','FAQ')}</h2>${[[L("如何选择 Agent？","How do I choose an Agent?"),L("用信号或行情资料缩小范围，建议会带入资产与依据。启动可模拟的 Agent 前，由你确认账户、金额与资金保护。","Use signals or market research to narrow the choices. Suggestions bring the asset and evidence into the plan. Confirm the account, allocation and protection before starting a supported simulation.")],[L("怎样限制 Agent 的交易范围？","How do I set an Agent’s limits?"),L("设定投入与止盈止损，也可选择 Astarter 资金保护。触发限制时暂停新增买入；关键设置变更后，需要重新检查并批准。","Set allocation and exit rules, with optional Astarter capital protection. Limits can pause new entries. Material changes require a new check and approval.")],[L("如何暂停或结束运行？","How do I pause or end a run?"),L("在“我的 Agent”查看状态、成交与费用。暂停只停止新增买入；结束时选择留仓或卖出。订单待确认时，先查询原订单。","View status, fills and fees in My Agents. Pausing stops new entries only. When ending, choose whether to keep or sell holdings. Check unresolved original orders before continuing.")],[L("哪些 Agent 可以模拟？","Which Agents support simulation?"),L("现货网格与有限分批买入支持独立模拟；其它 Agent 可查看规则、保存研究方案。模拟使用 DEMO 资金与独立行情，成交和费用均为模拟，不向真实账户下单。","Spot grid and bounded DCA support independent simulation. Other Agents offer rules and research plans. Funds, fills and fees use a separate DEMO market, with no real orders.")]].map(([q,a],index)=>`<details data-persist-key="bh-faq-${index}"><summary>${q}${glyph('chevron')}</summary><p>${a}</p></details>`).join('')}</section></div>`;
}

const emptyIcon=()=>`<svg class="bh-empty-art" viewBox="0 0 100 84" fill="none" aria-hidden="true"><path d="m20 34 30-17 30 17v32L50 82 20 66Z"/><path d="m20 34 30 18 30-18M50 52v30M20 34 4 46l30 18 16-12 16 12 30-18-16-12M50 17V3M39 7l3 5M61 7l-3 5"/></svg>`;

function sidebar(type){
 const types=botTypes();
 return `<aside class="bh-sidebar"><button class="bh-sidebar-home" type="button" data-bh="type" data-id="all" aria-current="${type==='all'?'page':'false'}">${glyph('strategy')}${L("我的 Agent","My Agents")}</button>${GROUPS.map(([group,zh,en])=>`<section><h2>${L(zh,en)}</h2>${types.filter(t=>t.group===group).map(t=>`<button type="button" class="bh-sidebar-item" data-bh="choose" data-id="${t.id}" aria-pressed="${type===t.id}">${glyph(t.icon)}<span><b>${L(...t.name)}</b><small>${L(canSimulate(t.id)?'可运行模拟':'研究方案',canSimulate(t.id)?'Simulation available':'Research plan')}</small></span></button>`).join('')}</section>`).join('')}<button class="bh-sidebar-back" type="button" data-bh="overview">${glyph('arrow')}${L("策略总览","Strategy overview")}</button></aside>`;
}

function planAccountLabel(route){
 if(!route||route.accountId==='SIM-01')return null;
 if(route.connectionId==='wallet-bsc'||route.profileId==='dex-spot'||route.venueId==='pancakeswap')return String(route.chainId)==='1'?['Ethereum 钱包','Ethereum wallet']:['BNB Chain 钱包','BNB Chain wallet'];
 if(route.connectionId==='binance-spot'||route.accountId==='BINANCE-SPOT')return ['币安现货','Binance spot'];
 return null;
}
function livePlanCard(draft){
 const name=nameOf(draft.strategy)[0],p=draft.botParameters||{},account=planAccountLabel(draft.executionRoute);
 const range=[p.lower,p.upper].every(value=>Number.isFinite(Number(value)))?`${number(p.lower)} – ${number(p.upper)}`:'';
 const grid=Number.isInteger(Number(p.count))?`${Number(p.count)} ${L('格','levels')}`:'';
 const action=draft.configured?`<button type="button" class="bh-button p-button" data-sc="open-editor" data-id="${esc(draft.id.slice(7))}">${L('查看方案','View plan')}</button>`:`<button type="button" class="bh-button p-button" data-sc="draft" data-id="${esc(draft.id)}">${L('查看方案','View plan')}</button>`;
 return `<article class="bh-live-plan" data-draft="${esc(draft.id)}"><header><h3>${esc(name)}</h3><span>${draft.configured?L('已配置','Configured'):L('已提交','Submitted')}</span></header><p>${esc(draft.market||'')}${account?`<span data-plan-account>${esc(L(...account))}</span>`:''}</p><dl><div><dt>${L('策略总金额','Allocation')}</dt><dd>${number(Number(draft.cap))} USDT</dd></div>${account?`<div><dt>${L('账户','Account')}</dt><dd>${esc(L(...account))}</dd></div>`:''}${range?`<div><dt>${L('价格区间','Price range')}</dt><dd>${range}</dd></div>`:''}${grid?`<div><dt>${L('网格','Grid')}</dt><dd>${grid}</dd></div>`:''}</dl><div class="bh-live-actions">${action}<button type="button" class="bh-button p-button" data-bh="delete-plan" data-id="${esc(draft.id)}">${L('删除','Delete')}</button></div></article>`;
}
function liveOrderPrice(order){
 const qty=Number(order.executedQty),quote=Number(order.cummulativeQuoteQty),limit=Number(order.price);
 if(qty>0&&Number.isFinite(quote)&&quote>0)return quote/qty;
 if(Number.isFinite(limit)&&limit>0)return limit;
 return null;
}
function liveOrderCard(order){
 const price=liveOrderPrice(order);
 return `<article class="bh-live-plan" data-live-order="${esc(order.orderId)}"><header><h3>BTC/USDT</h3><span>${order.side==='BUY'?L('买入','Buy'):L('卖出','Sell')} · ${esc(order.status)}</span></header><p>${price==null?'—':number(price)} USDT · ${esc(order.origQty)}</p></article>`;
}
function liveTradeCard(row){
 const fee=row.commissionAsset==='USDT'?row.commission:row.commissionAsset==='BTC'?row.commission*row.price:null;
 return `<article class="bh-live-plan" data-live-trade="${esc(row.id)}"><header><h3>BTC/USDT</h3><span>${row.buyer?L('买入','Buy'):L('卖出','Sell')}</span></header><dl><div><dt>${L('成交价','Fill price')}</dt><dd>${number(row.price)} USDT</dd></div><div><dt>${L('数量','Quantity')}</dt><dd>${row.qty} BTC</dd></div><div><dt>${L('手续费','Fee')}</dt><dd>${fee===null?'—':number(fee)+' USDT'}</dd></div></dl></article>`;
}
export function renderBotAssets({w,trade,accountId='SIM-01',environment='DEMO',tab='current',type='all',accountKind='wallet',runId='',renderInstances,renderSaved=()=>'',renderLegacy=()=>'',legacyHistory='',accessFor=()=>null}={}){
 const accounts=connectedAccountBalances(trade?.connections);
 const live=accounts.find(row=>row.kind===accountKind)||accounts[0];
 const owned=live?livePlanRows(w,live):[],plans=type==='all'?owned:owned.filter(draft=>draft.strategy===type);
 const s=botHubSummary(trade,accountId),runs=filterBotRuns(tab==='history'?s.history:s.current,type),tracked=w.s.botTrackedTypes||[];
 const names=Object.fromEntries(CATALOG.map(c=>[c.id,L(...nameOf(c.id))]));
 const renderRunList=(rows,history)=>{
  if(!rows.length)return '';
  const data={...trade,botBook:{...trade.botBook,runs:rows}};
  return renderInstances?renderInstances(data,history):history?botHistoryView(data,names):botInstancesView(data,names);
 };
 const retained=runs.filter(run=>ended(run)&&Number(run.quantity)>0);
 const instances=tab==='history'?renderRunList(runs,true):tab==='current'?renderRunList(runs.filter(run=>!ended(run)),false)+(retained.length?`<section class="bh-retained"><h2>${L('已结束 · 保留持仓','Ended · retained holdings')} <span>${retained.length}</span></h2>${renderRunList(retained,false)}</section>`:''):'';
 const accessNotes=tab==='current'?runs.map(run=>{
  const access=accessFor(run),copy=ACCESS_COPY[access?.code];
  if(!copy||access.ready||!(/^(connection-|api-offline$|permissions$|read-only$)/.test(access.code)))return '';
  return `<aside class="bh-access-note" role="status"><div><b>${esc(run.plan.market)} · ${L(copy[0],copy[1])}</b><p>${L("此运行仍绑定","This run remains bound to")} ${esc(run.plan.executionRoute.accountId)} · ${L('检查后再继续操作','Check access before continuing')}</p></div>${btn(L('检查原接入','Check original connection'),'run-connection',run.id)}</aside>`;
 }).join(''):'';
 const liveLegacy=s.existingActive;
 const legacyMatches=type==='all'||trade?.session?.strategy===type||w.s.drafts.find(d=>d.id===trade?.discovery?.draftId)?.strategy===type;
 const trackedCards=botHubCards(trade,accountId).filter(c=>tracked.includes(c.id)&&(type==='all'||c.id===type));
 const legacyIds=new Set(botRunHistory(trade).filter(run=>(!run.current||run.state==='stopped')&&(type==='all'||run.strategy===type)).map(run=>run.id));
 const oldHistory=legacyIds.size?botHistoryView({...trade,session:null,events:(trade.events||[]).filter(row=>legacyIds.has(row.runId)),orders:(trade.orders||[]).filter(row=>legacyIds.has(row.runId)),botBook:{runs:[]}},names):'';
 const paperList=tab==='tracked'?(trackedCards.length?`<div class="bh-strategy-grid">${trackedCards.map(c=>strategyCard(c,tracked)).join('')}</div>`:''):accessNotes+instances+(tab==='current'?(legacyMatches&&liveLegacy?`<section class="bh-existing-run"><h2>${L("Agent 运行","Agent run")}</h2>${renderLegacy(true)}</section>`:''):tab==='history'?oldHistory+legacyHistory:'');
 const spotRows=key=>(trade?.connections?.spotBook?.[key]||[]).filter(order=>type==='all'||order.strategy===type);
 const spotTrades=live?.kind==='binance'?(trade?.connections?.spotBook?.trades||[]):[];
 const historyCards=live?.kind==='binance'?(()=>{const filled=spotRows('history').filter(order=>Number(order.executedQty)>0);return (filled.length?filled.map(liveOrderCard):spotTrades.map(liveTradeCard)).join('');})():'';
 const liveCards=tab==='current'?plans.map(livePlanCard).join('')+(live?.kind==='binance'?spotRows('orders').map(liveOrderCard).join(''):''):tab==='history'?historyCards:'';
 const list=live&&tab!=='tracked'?(liveCards?`<div class="bh-live-list">${liveCards}</div>`:''):paperList;
 const saved=!live&&tab==='current'&&type==='all'?renderSaved():'';
 const savedPanel=saved?`<details class="bh-saved-plans" data-persist-key="bh-saved-plans"><summary>${L('已保存方案','Saved plans')}${glyph('chevron')}</summary>${saved}</details>`:'';
 const filtered=type!=='all';
 const title=live&&tab==='history'&&!filtered?L('这个账户还没有成交记录','No fills on this account yet'):live&&tab==='current'&&!filtered?L('还没有提交的方案','No submitted plan'):tab==='tracked'?L(filtered&&tracked.length?"尚未追踪此 Agent":"尚未追踪 Agent",filtered&&tracked.length?"This Agent is not tracked":"No tracked Agents"):tab==='history'?L(filtered?"此 Agent 暂无运行记录":"暂无运行记录",filtered?"No history for this Agent":"No run history yet"):L(filtered?"此 Agent 暂无运行实例":"暂无 Agent 运行",filtered?"No runs for this Agent":"No Agent runs yet");
 const emptyDescription=live&&tab==='history'&&!filtered?L('成交之后，订单会留在这里。','Fills stay here after they happen.'):live&&tab==='current'&&!filtered?(live.kind==='wallet'?L('为这个钱包保存的方案会显示在这里。','Plans saved for this wallet appear here.'):L('为共享币安账户保存的方案会显示在这里。','Plans saved for the shared Binance account appear here.')):tab==='tracked'?L("在 Agent 列表点“追踪”，方便继续查看它的规则与更新。","Track an Agent in the catalog to revisit its rules and updates."):tab==='history'?L('结束后的参数、成交和费用会保留在这里','Ended runs retain parameters, fills and fees here.'):L(filtered?"查看其它 Agent 运行，或查看这套策略的规则。":"选择 Agent，确认金额与资金保护，再到这里查看运行、持仓与费用。",filtered?"Browse other Agent runs or review this strategy’s rules.":"Choose an Agent and confirm allocation and protection. Follow its runs, positions and fees here.");
 const emptyActions=tab==='tracked'?`${filtered&&tracked.length?btn(L('清除筛选','Clear filters'),'type','all',true):''}${btn(L("浏览 Agent","Explore Agents"),'library','',!filtered||!tracked.length)}`:filtered?`${btn(L('清除筛选','Clear filters'),'type','all',true)}${btn(L('创建','Create'),'choose',type)}`:`${btn(L("选择 Agent","Choose Agent"),'library','ready',true)}`;
 const targetNotice=runId&&!live&&!botRunTarget(trade,{accountId,environment},runId)?`<div class="bh-run-notice" role="status"><p>${L("当前账户中未找到这条运行，请检查账户或查看全部 Agent。","This run is not in this account. Check the account or view all Agents.")}</p>${btn(L("全部 Agent","All Agents"),'assets')}</div>`:'';
 const wallet=live?.kind==='wallet';
 const equity=live?live.equity:s.equity,allocated=live?wallet?planAllocation(owned):live.locked:s.allocated;
 const amountLabel=wallet?L('钱包可用 USDT','Wallet available USDT'):live?live.basis==='equity'?L('共享币安现货权益','Shared Binance spot equity'):L('共享币安可用 USDT','Shared Binance available USDT'):L('模拟盘 · Agent 权益','Paper Agent equity');
 const unit=live?.basis==='equity'?'USDT eq.':'USDT';
 const accountLine=wallet?`${esc(live.accountId.slice(0,6)+'…'+live.accountId.slice(-4))} · BNB Chain`:live?L('共享账户 · 币安现货','Shared account · Binance spot'):`${esc(accountId)} · DEMO`;
 const held=live?.btc>0?` · BTC ${Number(live.btc).toLocaleString('en-US',{maximumFractionDigits:8})}`:'';
 const definition=wallet?L('当前钱包在 BNB Chain 上的 USDT 余额。','USDT held by this wallet on BNB Chain.'):live?L('资金属于共享演示账户。','Funds belong to the shared demo account.'):L("本模拟账户的网格与分批买入资产。","Grid and DCA assets in this paper account.");
 const performance=live?.kind==='binance'?spotBookPerformance(trade?.connections?.spotBook):null;
 const picker=accounts.length>1?`<nav class="bh-category-tabs segmented" aria-label="${L('选择资金账户','Select account')}">${accounts.map(row=>`<button type="button" data-bh="account-kind" data-id="${row.kind}" aria-pressed="${live.kind===row.kind}">${row.kind==='wallet'?L('我的钱包','My wallet'):L('共享币安现货','Shared Binance spot')}</button>`).join('')}</nav>`:'';
 const actions=wallet?`<a class="bh-button" target="_blank" rel="noopener noreferrer" href="https://bscscan.com/address/${esc(live.accountId)}">${L('在 BscScan 查看钱包资产','View wallet assets on BscScan')} ↗</a>`:live?`<button type="button" class="bh-button p-button" data-bh="tab" data-id="history" data-statements="STRATEGY_AGENT" data-statement-account="binance" data-statement-tab="fills" aria-haspopup="dialog">${L('现货成交记录','Spot trade history')}</button>`:`<button type="button" class="bh-button" data-go="assets">${L('查看模拟盘','View paper account')}</button><button type="button" class="bh-button" data-statements="STRATEGY_AGENT" aria-haspopup="dialog">${L('交易记录','Trade history')} ${glyph('arrow')}</button>`;
 const stats=live?[[L('当前盈亏','Current PnL'),performance?performance.current:null],[L('已实现盈亏','Realized PnL'),performance?performance.realized:null],[L('累计交易费','Trading fees'),performance?performance.fees:null]]:[[L('当前盈亏','Current PnL'),s.current.length?sum(s.current,'realizedPnl')+sum(s.current,'unrealizedPnl'):trade?0:null],[L('累计模拟盈亏','Cumulative simulated PnL'),s.pnl],[L('累计交易费','Trading fees'),s.fees]];
 return `<div class="bh-root bh-assets" data-bot-page="assets" data-localized-ui>${sidebar(type)}<div class="bh-assets-main"><header class="bh-assets-heading"><h1 class="bh-assets-title">${L("我的 Agent","My Agents")}</h1><div>${actions}</div></header>${targetNotice}${picker}
 <section class="bh-assets-summary" aria-label="${L("Agent 资产","Agent assets")}"><div class="bh-total"><span>${amountLabel}${info(L('资产口径','Asset definition'),definition)}</span><strong>${number(equity)} <small>${unit}</small></strong><p>${live?.kind==='binance'?L('冻结 USDT','Locked USDT'):L('已分配金额','Allocated capital')} <b>${number(allocated)} USDT</b><span class="bh-account">${accountLine}${held}</span></p></div><dl class="bh-assets-stats">${stats.map(([label,value])=>`<div><dt>${label} <span>(USDT)</span></dt><dd class="${value>0&&label!==L('累计交易费','Trading fees')?'bh-profit':value<0?'bh-loss':''}">${number(value)}</dd></div>`).join('')}</dl></section>
 <div class="bh-assets-nav"><nav class="bh-assets-tabs" role="tablist" aria-label="${L("Agent 记录","Agent history")}">${[['current',"运行实例","Agent runs"],['history',"历史记录","Run history"],['tracked',"已追踪 Agent","Tracked Agents"]].map(([id,zh,en])=>`<button type="button" role="tab" aria-selected="${tab===id}" data-bh="tab" data-id="${id}" aria-controls="bh-assets-list">${L(zh,en)}${id==='current'?` <span>(${number(live?owned.length:trade?s.activeCount:null)})</span>`:''}</button>`).join('')}</nav><div class="bh-assets-actions">${btn(glyph('arrow')+L("策略总览","Strategy overview"),'overview')}${btn(L("添加 Agent","Add Agent"),'create','',true)}</div></div>
 <div class="bh-assets-filters"><div class="bh-type-filters" role="group" aria-label="${L('类型筛选','Filter by type')}">${[['all','全部','All'],...botTypes().map(t=>[t.id,...t.name])].map(([id,zh,en])=>`<button type="button" data-bh="type" data-id="${id}" aria-pressed="${type===id}">${L(zh,en)}</button>`).join('')}</div></div>
 <section id="bh-assets-list" class="bh-assets-list" role="tabpanel" tabindex="0">${!trade?`<div class="bh-empty" role="status">${emptyIcon()}<h2>${L('当前账户尚未就绪','Account data is unavailable')}</h2><p>${L('检查账户连接后继续','Check the connection to continue')}</p>${btn(L('检查连接','Check connection'),'connection','',true)}</div>`:!live&&trade.botSummary?.recoveryError?`<p class="bh-error" role="alert">${esc(trade.botSummary.recoveryError)}</p>`:list.trim()&&!(tab==='tracked'&&!tracked.length)?list:`<div class="bh-empty">${emptyIcon()}<h2>${title}</h2><p>${emptyDescription}</p><div>${emptyActions}</div></div>`}</section>
 ${savedPanel}</div></div>`;
}

export function createBotHub({w,desk,root,go,refresh,choose,show,renderInstances,renderSaved,renderLegacy,renderLegacyHistory,recommendations=()=>[],chooseRecommendation=()=>false}){
 let activityMetric='fills';
 let category='recommended',group='all',query='',sort='default',trackedOnly=false,readyOnly=false,tab='current',type='all',accountKind='wallet',recommendationVenue='all',recommendationMarket='all';
 let requestedRun='',requestKey='',focusRun=false,focusAdvisor=false,advisorRouteObserver=null;
 const clearAdvisorFocus=()=>{focusAdvisor=false;advisorRouteObserver?.disconnect();advisorRouteObserver=null;};
 let recommendationScroll=0,recommendationResize=null,recommendationCarousel=null;
 const recommendationState={key:'',index:0,paused:false,nextAt:0};
 let sidebarKey='',sidebarScroll=0,keepSidebar=false;
 const syncRail=rail=>{
  if(rail.isConnected===false)return;
  const max=Math.max(0,rail.scrollWidth-rail.clientWidth),controls=root.querySelector('.bh-carousel-controls');
  if(controls)controls.hidden=max<2;
  const previous=root.querySelector('[data-bh="recommendation-prev"]'),next=root.querySelector('[data-bh="recommendation-next"]');
  if(previous)previous.disabled=rail.scrollLeft<=1;
  if(next)next.disabled=rail.scrollLeft>=max-1;
  rail.tabIndex=max<2?-1:0;recommendationScroll=Math.max(0,rail.scrollLeft);
 };
 const moveRail=(rail,direction)=>{
  const max=Math.max(0,rail.scrollWidth-rail.clientWidth),card=rail.querySelector('.bh-suggestion'),step=(card?.getBoundingClientRect().width||rail.clientWidth)+16;
  const count=Math.max(1,Math.floor((rail.clientWidth+16)/step));
  const left=direction==='start'?0:direction==='end'?max:(Math.round(rail.scrollLeft/step)+direction*count)*step;
  const reduced=globalThis.document?.documentElement?.dataset?.reducedMotion==='true'||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  rail.scrollTo({left:Math.max(0,Math.min(max,left)),behavior:reduced?'auto':'smooth'});
 };
 const focusSegment=(key,id)=>requestAnimationFrame(()=>root.querySelector(`[data-bh="recommendation-${key}"][data-id="${id}"]`)?.focus({preventScroll:true}));
 const action=async button=>{
  const {bh:a,id}=button.dataset;
  if(a==='delete-plan'){await removeLivePlan(w,id,desk.readSnapshot?.());refresh();return;}
  if(a==='overview'){go('strategies');return;}
  if(a==='assets'){tab='current';go('execution');return;}
  if(a==='advisor'){
   clearAdvisorFocus();focusAdvisor=true;
   if(typeof MutationObserver==='function'){
    advisorRouteObserver=new MutationObserver(()=>{if(!['strategies','advisor'].includes(root.dataset?.renderedPage))clearAdvisorFocus();});
    advisorRouteObserver.observe(root,{attributes:true,attributeFilter:['data-rendered-page']});
   }
   go('advisor');return;
  }
  if(a==='connection'){go('settings');return;}
  if(a==='recommendation-prev'||a==='recommendation-next'){const rail=root.querySelector('[data-bh-recommendation-rail]');if(recommendationCarousel)recommendationCarousel.step(a==='recommendation-prev'?-1:1);else if(rail)moveRail(rail,a==='recommendation-prev'?-1:1);return;}
  if(a==='recommendation-pause'){recommendationCarousel?.toggle();return;}
  if(a==='recommendation-reset'){recommendationVenue='all';recommendationMarket='all';recommendationScroll=0;recommendationState.key='';recommendationState.index=0;recommendationState.nextAt=0;refresh();focusSegment('venue','all');return;}
  if(a==='library'){category='recommended';group='all';readyOnly=id==='ready';query='';trackedOnly=false;if(root.dataset?.renderedPage==='execution')go('strategies');else refresh();requestAnimationFrame(()=>{const target=root.querySelector('.bh-catalog');if(target){root.scrollTop+=target.getBoundingClientRect().top-root.getBoundingClientRect().top-20;const heading=target.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}});return;}
  if(a==='recommendation-venue'){recommendationVenue=['all','cex','dex'].includes(id)?id:'all';recommendationScroll=0;recommendationState.key='';recommendationState.index=0;recommendationState.nextAt=0;refresh();focusSegment('venue',recommendationVenue);return;}
  if(a==='recommendation-market'){recommendationMarket=RECOMMENDATION_MARKETS.some(([key])=>key===id)?id:'all';recommendationScroll=0;recommendationState.key='';recommendationState.index=0;recommendationState.nextAt=0;refresh();focusSegment('market',recommendationMarket);return;}
  if(a==='recommendation-logic'){const row=recommendations().find(row=>row.id===id);if(!row){refresh();return;}show(L('入选逻辑','Selection logic'),recommendationLogic(row));bind(document.querySelector('.product-dialog'));return;}
  if(a==='recommendation'||a==='recommendation-source'){
   const source=a==='recommendation-source',row=recommendations().find(row=>row.id===id);if(!source&&!recommendationConfigurable(row)){refresh();return;}
   const y=root.scrollTop;
   const back=()=>{recommendationState.nextAt=Date.now()+12000;if(new URLSearchParams(globalThis.location?.search||'').has('create'))go('strategies');else refresh();requestAnimationFrame(()=>{if(root.dataset?.renderedPage&&root.dataset.renderedPage!=='strategies')return;root.scrollTop=y;const trigger=[...root.querySelectorAll(`[data-bh="${a}"]`)].find(b=>b.dataset.id===id);if(trigger)trigger.focus({preventScroll:true});else{const heading=root.querySelector('#bh-suggestions-title');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}});};
   if(chooseRecommendation(id,back,source?{intent:'source'}:undefined))button.closest?.('.product-dialog')?.close();else refresh();return;
  }
  if(a==='run-connection'){
   const run=desk.readSnapshot()?.botBook?.runs?.find(run=>run.id===id);if(!run){refresh();return;}
   const route=run.plan.executionRoute;
   desk.settings?.('exchange',{connectionId:route.connectionId,service:route.venueId,onBack:()=>refresh()});return;
  }
  if(a==='choose'){
   const y=root.scrollTop,origin=root.dataset?.renderedPage==='execution'?'execution':'strategies',source=button.closest?.('.product-dialog');
   const marketEntry=button.closest?.('[data-market-entry]')?.dataset.marketEntry;
   const trigger=marketEntry?`[data-market-entry="${marketEntry}"] [data-bh="choose"]`:button.closest?.('[data-featured-strategy]')?`[data-featured-strategy="${id}"] [data-bh="choose"]`:
    button.closest?.('[data-bot-strategy]')?`[data-bot-strategy="${id}"] [data-bh="choose"]`:button.closest?.('.bh-empty')?`.bh-empty [data-bh="choose"][data-id="${id}"]`:`.bh-type-card[data-id="${id}"]`;
   if(source?.querySelector('.bh-create-choices'))source.close();
   choose(id,()=>{if(new URLSearchParams(globalThis.location?.search||'').has('create'))go(origin);else refresh();requestAnimationFrame(()=>{root.scrollTop=y;(root.querySelector(trigger)||root.querySelector('[data-bh="create"]'))?.focus({preventScroll:true});});});return;
  }
  if(a==='create'){const y=root.scrollTop,origin=root.dataset?.renderedPage==='execution'?'execution':'strategies';choose('S01',()=>{if(new URLSearchParams(globalThis.location?.search||'').has('create'))go(origin);else refresh();requestAnimationFrame(()=>{root.scrollTop=y;root.querySelector('[data-bh="create"]')?.focus({preventScroll:true});});});return;}
  if(a==='capability'){const p=BOT_PRODUCT_CAPABILITIES.find(p=>p.id===id);if(p)show(L(...p.name),`<div class="bh-capability"><span class="bh-capability-icon">${glyph('strategy')}</span><h3>${L(p.kind==='execution'?'尚未适配':'研究方案',p.kind==='execution'?'Not yet supported':'Research plan')}</h3><p>${esc(L(...p.detail))}</p><p>${L("此 Agent 仅支持研究。可查看规则并保存方案；如需模拟，可选择现货网格或有限分批买入。","This Agent is research only. Review its rules and save a plan, or choose spot grid or bounded DCA to simulate.")}</p></div>`);return;}
  if(a==='track'){const ids=w.s.botTrackedTypes||[];w.s.botTrackedTypes=ids.includes(id)?ids.filter(t=>t!==id):[...ids,id];w.touch();}
  if(a==='category'){category=id;}
  if(a==='account-kind'&&['wallet','binance'].includes(id)){accountKind=id;tab='current';type='all';}
  if(a==='tab'){tab=id;refresh();if(id==='history')requestAnimationFrame(()=>root.querySelector('#bh-assets-list')?.scrollIntoView?.({block:'nearest'}));return;}
  if(a==='type')type=id;
  if(a==='tracked-only')trackedOnly=!trackedOnly;
  if(a==='ready-only')readyOnly=!readyOnly;
  if(a==='reset'){group='all';query='';sort='default';trackedOnly=false;readyOnly=false;}
  refresh();
 };
 function bind(container=root){
  if(w.research)bindWorkbenchTargets(container,{workspace:w,onChange:()=>refresh(),onManage:()=>go('watchlist')});
  const preserveSidebar=container===root&&keepSidebar,sidebar=preserveSidebar?root.querySelector('.bh-sidebar'):null;
  if(sidebar)sidebar.scrollTop=Math.min(sidebarScroll,Math.max(0,sidebar.scrollHeight-sidebar.clientHeight));
  if(container===root)mountStrategyActivityTrend(root,{onMetric:key=>activityMetric=key,onViewRun:typeof go==='function'?runId=>go('execution',{runId}):null});
  if(container===root&&focusAdvisor&&root.dataset?.renderedPage==='strategies'&&root.querySelector('[data-bh="advisor"]')){
   const trigger=root.querySelector('[data-bh="advisor"]');clearAdvisorFocus();
   requestAnimationFrame(()=>{if(trigger.isConnected!==false&&root.dataset?.renderedPage==='strategies')trigger.focus({preventScroll:true});});
  }
  if(container===root){
   recommendationResize?.disconnect();recommendationResize=null;
   recommendationCarousel?.dispose();recommendationCarousel=mountRecommendationCarousel(root,recommendationState);
   const rail=root.querySelector('[data-bh-recommendation-rail]');
   if(rail&&!recommendationCarousel){
    rail.scrollLeft=Math.min(recommendationScroll,Math.max(0,rail.scrollWidth-rail.clientWidth));
    rail.onscroll=()=>syncRail(rail);
    rail.onkeydown=event=>{
     if(event.target!==rail||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
     event.preventDefault();moveRail(rail,event.key==='Home'?'start':event.key==='End'?'end':event.key==='ArrowLeft'?-1:1);
    };
    syncRail(rail);
    if(typeof ResizeObserver==='function'){recommendationResize=new ResizeObserver(()=>syncRail(rail));recommendationResize.observe(rail);}
   }
  }
  container.querySelectorAll('[data-bh]').forEach(button=>button.onclick=()=>action(button));
  container.querySelectorAll('[data-bh-select]').forEach(field=>field.onchange=()=>{
   const key=field.dataset.bhSelect;
   if(key==='group')group=field.value;
   if(key==='sort')sort=field.value;
   if(key==='recommendationVenue'){recommendationVenue=field.value;recommendationScroll=0;}
   if(key==='recommendationMarket'){recommendationMarket=field.value;recommendationScroll=0;}
   refresh();requestAnimationFrame(()=>root.querySelector(`[data-bh-select="${key}"]`)?.focus({preventScroll:true}));
  });
  const search=container.querySelector('[data-bh-search]');if(search)bindSearchRender(search,value=>query=value,()=>{refresh();return root.querySelector('[data-bh-search]');});
  // Keyboard and overflow behavior adapted from 21st.dev/@kuratlielia/components/segmented-control.
  container.querySelectorAll('.bh-recommendation-segment').forEach(strip=>{
   const buttons=[...strip.querySelectorAll('button')];
   buttons.forEach((button,index)=>button.onkeydown=event=>{
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:['ArrowRight','ArrowDown'].includes(event.key)?(index+1)%buttons.length:['ArrowLeft','ArrowUp'].includes(event.key)?(index+buttons.length-1)%buttons.length:-1;
    if(next<0)return;event.preventDefault();return action(buttons[next]);
   });
  });
  const strips=[...container.querySelectorAll('.bh-assets-tabs,.bh-type-filters,.bh-sidebar,.bh-recommendation-segment')];
  if(strips.length)requestAnimationFrame(()=>{
   for(const strip of strips){
    const active=strip.querySelector('[aria-selected="true"],[aria-pressed="true"],[aria-current="page"]');if(!active)continue;
    const box=strip.getBoundingClientRect(),item=active.getBoundingClientRect();
    if(strip.classList?.contains('bh-sidebar')){if(!preserveSidebar&&(item.bottom>box.bottom||item.top<box.top))strip.scrollTop+=item.top-box.top-(strip.clientHeight-item.height)/2;continue;}
    if(strip.scrollWidth<=strip.clientWidth)continue;
    if(item.right>box.right||item.left<box.left)strip.scrollLeft+=item.left-box.left-(strip.clientWidth-item.width)/2;
   }
  });
  if(container===root&&requestedRun)requestAnimationFrame(()=>{
   const target=[...root.querySelectorAll('[data-bot-instance],.bh-existing-run .contract-run[data-run],[data-bot-history]')].find(node=>(node.dataset.botInstance||node.dataset.run||node.dataset.botHistory)===requestedRun);
   if(!target)return;
   target.classList.add('bh-run-target');target.tabIndex=-1;
   if(focusRun){root.scrollTop+=target.getBoundingClientRect().top-root.getBoundingClientRect().top-24;target.focus({preventScroll:true});focusRun=false;}
  });
 }
 return {render(page){
  const previousSidebar=sidebarKey?root.querySelector('.bh-sidebar'):null;
  if(previousSidebar&&previousSidebar.isConnected!==false)sidebarScroll=Math.max(0,Number(previousSidebar.scrollTop)||0);
  recommendationResize?.disconnect();recommendationResize=null;recommendationCarousel?.dispose();recommendationCarousel=null;
  if(!['strategies','advisor'].includes(page))clearAdvisorFocus();
  if(!['strategies','execution'].includes(page)){sidebarKey='';keepSidebar=false;return null;}
  if(page==='strategies'&&CATALOG.some(item=>item.id===new URLSearchParams(globalThis.location?.search||'').get('create'))){clearAdvisorFocus();return null;}
  const status=desk.syncStatus(),trade=desk.readSnapshot(),accountId=status.scope?.accountId||'SIM-01',environment=status.scope?.environment||'DEMO';
  requestedRun=page==='execution'?new URLSearchParams(globalThis.location?.search||'').get('runId')||'':'';
  const target=botRunTarget(trade,{accountId,environment},requestedRun),key=`${page}:${accountId}:${environment}:${requestedRun}:${Boolean(target)}`;
  if(key!==requestKey){requestKey=key;recommendationState.key='';recommendationState.index=0;recommendationState.nextAt=0;focusRun=Boolean(target);if(target){tab=target.tab;type='all';}}
  const nextSidebarKey=page==='execution'?`${key}:${tab}:${type}`:'';
  keepSidebar=Boolean(nextSidebarKey&&nextSidebarKey===sidebarKey);sidebarKey=nextSidebarKey;if(!keepSidebar)sidebarScroll=0;
  return page==='strategies'?renderBotOverview({w,trade,accountId,environment,activityMetric,category,group,query,sort,trackedOnly,readyOnly,recommendationVenue,recommendationMarket,recommendations:recommendations()}):renderBotAssets({w,trade,accountId,environment,tab,type,accountKind,runId:requestedRun,renderInstances,renderSaved,renderLegacy,legacyHistory:renderLegacyHistory?.()||'',accessFor:run=>desk.access?.({...strategyAccessOptions(run.plan.executionRoute,run.plan.mode),nativeBot:true})});
 },bind};
}
