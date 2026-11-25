import {ROLES} from './simulation.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {AGENT_MODEL_CATALOG,AGENT_MODEL_FAMILIES,agentModelPlan,agentModelsIssue,catalogModel,safeModelIdentity} from './agent-models.mjs';
import {t} from './locale.mjs';
import {DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {accessPanel} from './trading-access-view.mjs';
import {ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {venueIcon,tokenIcon} from './brand-icons.mjs';
import {PAGES} from './product-data.mjs';
import {createConnectionTicker} from './connection-ticker.mjs';
import {L} from './execution-views.mjs';
import {createNotificationSettings,notificationSummary} from './notification-settings.mjs';
import {CONNECTION_OPTIONS,WALLET_NETWORKS,AI_MODES,normalizeConnectionPreferences,demoCredentialIssue,connectionPreviewIssue,safeGatewayURL,connectionBilling,walletTradingProfile,normalizeTradingConnections,tradingConnections,preferredTradingConnection,connectionReturnContext,apiCredentialIssue,publicSpotBook} from './connection-options.mjs?v=20261123z';
const TYPES=[['exchange','交易接入','account'],['data','研究数据','data'],['ai','AI 模型','brain'],['wallet','钱包','wallet'],['notifications','通知','bell']];
const NAV_TYPES=TYPES.filter(([type])=>type!=='wallet');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const connectionStatusVisible=(page,width)=>page==='workbench'||(width>900&&page!=='setup'&&PAGES.some(([id])=>id===page));
export function normalizeConnections(value={}){
 value=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const result={...DEFAULT_CONNECTIONS};
 for(const [key]of TYPES)if(typeof value[key]==='boolean')result[key]=value[key];
 result.wallet=false;
 if(['OpenRouter','自有模型网关'].includes(value.provider))result.provider=value.provider;
 if(Number.isFinite(value.budget)&&value.budget>=1&&value.budget<=100)result.budget=value.budget;
 result.preferences=normalizeConnectionPreferences(value.preferences||{ai:{service:value.provider==='自有模型网关'?'gateway':value.provider==='OpenRouter'?'openrouter':'official'}});
 result.provider=result.preferences.ai.source==='official'?'Astarter':result.preferences.ai.service==='gateway'?'自有模型网关':'OpenRouter';
 if(Array.isArray(value.tradingAccounts)){result.tradingAccounts=normalizeTradingConnections(value.tradingAccounts);result.preferredTradingConnection=result.tradingAccounts.some(r=>r.id===value.preferredTradingConnection)?value.preferredTradingConnection:'';}
 const spotBook=publicSpotBook(value.spotBook);
 if(spotBook&&result.tradingAccounts.some(record=>record.id==='binance-spot'&&record.status==='connected'))result.spotBook=spotBook;
 return result;
}
export function connectionIssue(d){return !Number.isFinite(Number(d.budget))||Number(d.budget)<1||Number(d.budget)>100?'研究预算须为 1–100 USD。':!['Astarter','OpenRouter','自有模型网关'].includes(d.provider)?'请选择受支持的模型配置。':null;}
export function connectionSummary(d){const ready=['exchange','data','ai'].filter(k=>d[k]).length;return {ready,total:3,complete:ready===3};}
export function mergeConnectionSection(saved,draft,section){
 const safe=normalizeConnections(saved),next=normalizeConnections(draft);
 if(!TYPES.some(([type])=>type===section))return safe;
 safe.preferences[section]=next.preferences[section];
 if(['exchange','data','ai','notifications'].includes(section))safe[section]=next[section];
 if(section==='ai'){safe.provider=next.provider;safe.budget=next.budget;}
 if(['exchange','wallet'].includes(section)&&Array.isArray(next.tradingAccounts)){
  safe.tradingAccounts=[...tradingConnections(safe).filter(r=>r.kind!==section),...next.tradingAccounts.filter(r=>r.kind===section)];
  const preferred=safe.preferredTradingConnection||next.preferredTradingConnection;
  safe.preferredTradingConnection=safe.tradingAccounts.some(r=>r.id===preferred)?preferred:'';
 }
 return normalizeConnections(safe);
}
const paths={info:'M12 17v-6m0-4v.1M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0Z',shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-5',account:'M3 20h18M5 20V9m7 11V9m7 11V9M3 8l9-5 9 5H3Z',data:'M4 5c0-3 16-3 16 0s-16 3-16 0Zm0 0v14c0 3 16 3 16 0V5M4 12c0 3 16 3 16 0',brain:'M9 4a4 4 0 0 0-6 5 4 4 0 0 0 0 7 4 4 0 0 0 6 4V4Zm6 0a4 4 0 0 1 6 5 4 4 0 0 1 0 7 4 4 0 0 1-6 4V4ZM9 9H6m9 6h3',wallet:'M20 8V5H4a2 2 0 0 0-2 2v12h18V8H4M20 11h-6v5h6m-3-3h.1',bell:'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 4h4',arrow:'M5 12h14m-5-5 5 5-5 5',check:'m5 12 4 4 10-10',close:'m6 6 12 12M18 6 6 18'};
export const uiIcon=(name)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.data}"/></svg>`;
const titleFor=k=>L(...({overview:['连接与配置','Connections'],exchange:['交易接入','Trading access'],data:['研究数据','Research data'],ai:['AI 模型','AI models'],wallet:['交易接入','Trading access'],notifications:['通知','Notifications']}[k]));
const nameFor=o=>L(o.name,o.nameEn||o.name);
const control=(text,action)=>`<button type="button" class="p-button" data-cc="${action}">${text}</button>`;
const mark=o=>o.venue?venueIcon(o.venue,{size:40}):['metamask','phantom'].includes(o.id)?tokenIcon(o.id==='phantom'?'SOL':'BNB',{size:40}):o.id==='official'?`<span class="cc-monogram cc-astarter" aria-hidden="true"><img src="/brand/astarter-icon-gradient-primary.svg" alt=""></span>`:`<span class="cc-monogram" aria-hidden="true">${uiIcon(o.id==='gateway'||o.id==='openrouter'?'brain':o.id==='inapp'||o.id==='telegram'||o.id==='email'?'bell':'data')}</span>`;
export function connectionRecordStatus(record,getAccess=()=>null){
 const profileId=record&&(record.kind==='wallet'?walletTradingProfile(record):'cex-'+record.market);
 const access=profileId?getAccess({connectionId:record.id,profileId}):null;
 let code=!record?'connection-missing':!profileId?'unsupported-route':ACCESS_COPY[access?.code]?access.code:'connection-unchecked';
 if(code==='ready'&&access?.ready!==true)code='connection-unchecked';
 return {profileId,access,code,label:L(...ACCESS_COPY[code].slice(0,2))};
}
export function updateTradingConnectionStatus(button,connections,getAccess=()=>null){
 const record=preferredTradingConnection(connections),state=connectionRecordStatus(record,getAccess);
 const status=record?state.label:L('尚未选择','Not selected');
 button.dataset.enabled=String(state.code==='ready'&&state.access?.ready===true);
 button.querySelector('small').textContent=status;
 button.title=titleFor('exchange')+' · '+status;button.setAttribute('aria-label',button.title);
}
export function connectionAccountFields({record=null,label='',kind='exchange',service='binance',accountText=null}={}){
 const accountId=accountText!==null?accountText:record?.accountId||(kind==='wallet'?'SIM-01':service==='binance'?'': 'UNCONNECTED');
 const accountValue=accountId===''?L('请先连接钱包','Connect the wallet first'):accountId==='UNCONNECTED'?L('此平台账户尚未接入','Account not connected for this platform'):accountId||L('保存并检查后显示','Shown after the access check');
 return `<div class="cc-two"><label class="cc-field">${L('接入名称','Connection name')}<input data-connection-label value="${esc(label)}" maxlength="40" placeholder="${L('接入名称','Connection name')}" autocomplete="off"></label><label class="cc-field">${L('使用账户','Account')}<input type="text" readonly aria-label="${L('使用账户','Account')}" value="${esc(accountValue)}"></label></div>`;
}
const usdtText=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' USDT':'';
export function savedConnectionCard(record,{preferred=false,getAccess=()=>null,returnDraft=false}={}){
 const state=connectionRecordStatus(record,getAccess),provider=CONNECTION_OPTIONS[record.kind].find(o=>o.id===record.service);
 const details=record.kind==='exchange'?(record.market==='spot'?L('现货','Spot'):L('合约','Futures')):record.venue==='hyperliquid'?'Hyperliquid':WALLET_NETWORKS.find(n=>n.id===record.chain)?.name||record.chain,sessionWallet=record.id==='wallet-bsc';
 const disconnect=!sessionWallet&&(state.code==='ready'&&state.access?.ready||['read-only','wallet-authority'].includes(state.code));
 const balance=record.status==='connected'&&typeof record.available==='number'?`<small class="cc-account-balance">${L('可用','Available')} ${esc(usdtText(record.available))}</small>`:'';
 return `<section class="cc-account-row"><div class="cc-account-identity">${mark(provider)}<div><strong${record.label===record.accountId?' class="cc-account-id"':''}>${esc(record.label)}</strong><span>${nameFor(provider)} · ${esc(details)}${record.label!==record.accountId&&!sessionWallet?`<span class="cc-account-id"> · ${esc(record.accountId)}</span>`:''}</span></div>${preferred?`<b class="cc-source-chip">${L('首选','Preferred')}</b>`:''}</div><div class="cc-account-status" data-access-code="${esc(state.code)}">${esc(state.label)}${balance}</div><div class="cc-account-actions">${sessionWallet?'':`<button type="button" class="p-button" data-connection-edit="${esc(record.id)}">${L('检查 / 编辑','Check / edit')}</button>`}${!preferred?`<button type="button" class="p-button cc-quiet-action" data-connection-prefer="${esc(record.id)}">${L('设为首选','Make preferred')}</button>`:''}${disconnect?`<button type="button" class="p-button cc-quiet-action" data-connection-disconnect="${esc(record.id)}">${L('断开接入','Disconnect')}</button>`:''}${returnDraft?`<button type="button" class="p-button p-primary" data-connection-use="${esc(record.id)}">${L('用于此草稿','Use for this draft')}</button>`:''}</div></section>`;
}
export function connectionOverview(connections,{getAccess=()=>null,notificationScope='',accountNotifications=false}={}){
 const current=normalizeConnections(connections),p=current.preferences,records=tradingConnections(current),preferred=preferredTradingConnection(current);
 const provider=preferred&&CONNECTION_OPTIONS[preferred.kind].find(o=>o.id===preferred.service);
 const state=connectionRecordStatus(preferred,getAccess),status=preferred?state.label:L('尚未选择','Not selected');
 const market=preferred?.kind==='exchange'?(preferred.market==='spot'?'SPOT':'PERP'):preferred?.venue==='hyperliquid'?'Hyperliquid':WALLET_NETWORKS.find(n=>n.id===preferred?.chain)?.name||'';
 const manage=(type,label)=>`<button type="button" class="cc-overview-action" data-section="${type}" aria-label="${titleFor(type)} · ${label}">${label}${uiIcon('arrow')}</button>`;
 const dataName=p.data.source==='official'?L('Astarter 数据','Astarter data'):p.data.services.map(id=>nameFor(CONNECTION_OPTIONS.data.find(o=>o.id===id))).join(' · ')||L('尚未选择','Not selected');
 const aiName=p.ai.source==='official'?'Astarter AI':nameFor(CONNECTION_OPTIONS.ai.find(o=>o.id===p.ai.service));
 const notifications=accountNotifications?{label:L('账户站内通知','Account inbox')}:notificationSummary(notificationScope,current.notifications);
 return `<div class="cc-overview">
  <section class="cc-overview-trading" aria-labelledby="cc-overview-trading-title">
   <div class="cc-overview-label"><h4 id="cc-overview-trading-title">${titleFor('exchange')}</h4><span>${records.length} ${records.length===1?L('个接入','connection'):L('个接入','connections')}</span></div>
   <div class="cc-overview-account">${provider?mark(provider):`<span class="cc-monogram">${uiIcon('account')}</span>`}<div><b>${esc(preferred?.label||L('选择交易接入','Choose connection'))}</b><p>${preferred?`${esc(nameFor(provider))} · ${esc(market)}`:L('添加交易所或钱包，设置使用权限。','Add an exchange or wallet and choose its access.')}</p></div>${manage(preferred?.kind||'exchange',records.length?L('管理接入','Manage connections'):L('添加接入','Add connection'))}</div>
   <div class="cc-overview-access"><span data-access-code="${esc(state.code)}">${esc(status)}</span>${preferred&&typeof preferred.available==='number'&&preferred.status==='connected'?`<span>${L('可用','Available')} ${esc(usdtText(preferred.available))}</span>`:''}${preferred?`<span>${L('首选','Preferred')}${preferred.label!==preferred.accountId?' · '+esc(preferred.accountId):''}</span>`:''}</div>
   ${preferred?`<p class="cc-authority-note" data-preferred-scope>${uiIcon('info')}${L('首选接入只用于新建草稿；已有运行继续使用原接入。','Preferred is used for new drafts only. Existing runs keep their original connection.')}</p>`:''}
  </section>
  <section class="cc-overview-resource"><div class="cc-overview-label">${uiIcon('data')}<h4>${titleFor('data')}</h4></div><b>${esc(dataName)}</b><p>${!current.data?L('已关闭','Off'):p.data.source==='official'?L('按量积分','Usage credits'):L('自带 API · 调用积分 0','Your API · 0 call credits')}</p>${manage('data',L('更改来源','Change source'))}</section>
  <section class="cc-overview-resource"><div class="cc-overview-label">${uiIcon('brain')}<h4>${titleFor('ai')}</h4></div><b>${esc(aiName)}</b><p>${!current.ai?L('已关闭','Off'):p.ai.source==='official'?L(...AI_MODES.find(([id])=>id===p.ai.model).slice(1)):L('自带 API · 调用积分 0','Your API · 0 call credits')}</p>${manage('ai',L('调整模型','Configure models'))}</section>
  <section class="cc-overview-notifications"><span class="cc-monogram">${uiIcon('bell')}</span><div><h4>${titleFor('notifications')}</h4><p>${esc(notifications.label)}</p></div>${manage('notifications',L('管理渠道','Manage channels'))}</section>
 </div><div class="cc-overview-next"><button type="button" data-cc="execution">${L('查看交易枢纽','Open trading hub')}${uiIcon('arrow')}</button></div>`;
}
export function createConnectionCenter({get,onSave,getAccess=()=>null,onRecover=()=>null,getTime=()=>0,getNotificationScope=()=>'',privateUI=null,getSignedWallet=null}){
 const bar=document.createElement('div');bar.className='connection-bar reactor-only';bar.setAttribute('data-localized-ui','');
 bar.innerHTML=`<button class="connection-hub" data-connect="overview"><svg viewBox="0 0 20 18" aria-hidden="true"><path d="M2 16v-3m5 3V9m5 7V5m5 11V1" stroke="currentColor" stroke-width="3"/></svg><b class="connection-speed"></b></button><span class="connection-ticker-source" data-no-translate><b>${L('行情','Markets')}</b></span><div class="connection-ticker" tabindex="0"></div><div class="connection-shortcuts">${NAV_TYPES.map(([key,,icon])=>`<button data-connect="${key}" aria-label="${titleFor(key)}">${uiIcon(icon)}<span>${titleFor(key)}<small></small></span><i></i></button>`).join('')}</div><button class="connection-manage" data-connect="overview">${uiIcon('data')}<span>${L('配置','Settings')}</span></button>`;document.body.append(bar);
 const ticker=createConnectionTicker(bar);
 let probe=null,probedAt=-Infinity,latency=null,localReady=null;
 function speedLabel(){bar.querySelector('.connection-speed').textContent=localReady===false?L('连接中断','Offline'):latency===null?L('检测连接','Checking'):L('连接 ','Connection ')+latency+' ms';bar.querySelector('.connection-hub').dataset.health=localReady===false?'offline':localReady?'ready':'checking';bar.querySelector('.connection-hub').title=L('当前页面与服务的往返速度，非交易所延迟。','Round-trip time to this application; not exchange latency.');}
 async function measure(){
  if(probe||document.hidden||!connectionStatusVisible(document.body.dataset.page,window.innerWidth)||performance.now()-probedAt<15000)return;
  const controller=new AbortController();probe=controller;probedAt=performance.now();const timeout=setTimeout(()=>controller.abort(),3000),start=performance.now();
  try{const response=await fetch('/favicon.ico',{method:'HEAD',cache:'no-store',signal:controller.signal});if(!response.ok||response.headers.get('X-App-Mode')!=='simulation-only')throw new Error('Local service unavailable');latency=Math.max(1,Math.round(performance.now()-start));localReady=true;}catch{if(!document.hidden){latency=null;localReady=false;}}finally{clearTimeout(timeout);if(probe===controller)probe=null;speedLabel();}
 }
 const dialog=document.createElement('dialog');dialog.id='connection-dialog';dialog.className='connection-center';dialog.setAttribute('data-localized-ui','');dialog.setAttribute('aria-labelledby','connection-title');
 dialog.innerHTML=`<header><h2 id="connection-title">${titleFor('overview')}</h2><button type="button" id="connections-close" aria-label="${L('关闭连接配置','Close connections')}">${uiIcon('close')}</button></header><div class="connection-layout"><nav aria-label="${L('连接分类','Connection categories')}"><button data-setting="overview">${uiIcon('data')}${L('全部配置','All settings')}</button>${NAV_TYPES.map(([k,,i])=>`<button data-setting="${k}">${uiIcon(i)}${titleFor(k)}</button>`).join('')}</nav><div id="connection-content"></div></div><footer><span id="connection-feedback" role="status"></span><div class="connection-footer-actions"><button id="connections-check" type="button" class="p-button">${L('取消','Cancel')}</button><button id="connections-save" type="button" class="p-button p-primary">${L('保存设置','Save settings')}</button></div></footer>`;document.body.append(dialog);
 let draft,section='overview',chosen=null,opener,saved=false,dirty=new Set(),walletPreview=null,scenario='normal',afterClose=null,editingId=null,accountLabel='',returnContext=null,onReturn=null,selectedReturn=null;
 const q=selector=>dialog.querySelector(selector);
 const notificationSettings=createNotificationSettings({getScope:getNotificationScope,getLocal:()=>({inapp:get().notifications}),saveLocal({inapp,events}){const next=normalizeConnections(get());next.notifications=inapp;next.preferences.notifications={...next.preferences.notifications,service:'inapp',events};const error=onSave(next,'notifications');if(!error)keepEdits('notifications');return error;}});
 const msg=(text,state='')=>{const el=q('#cc-inline-feedback')||q('#connection-feedback');el.textContent=text;el.dataset.state=state;el.setAttribute('role',state==='error'?'alert':'status');};
 // Sections that hold an unsaved draft change; the hint shows only in such a section while it still differs from the stored settings (unsaved()). Demo credentials never count because they are never saved.
 const dirtyHint=()=>msg(dirty.has(section)&&!saved&&!dialog.querySelector('footer').hidden&&unsaved()?L('有未保存的更改，保存后才会生效。','Unsaved changes. They apply only after you save.'):'');
 const option=()=>CONNECTION_OPTIONS[section]?.find(o=>o.id===chosen);
 const isTrading=()=>section==='exchange'||section==='wallet';
 const profile=()=>section==='wallet'?walletTradingProfile(draft.preferences.wallet):'cex-spot';
 const official=()=>['data','ai'].includes(section)&&draft?.preferences[section].source==='official';
 const recordProfile=record=>record.kind==='wallet'?walletTradingProfile(record):'cex-'+record.market;
 const recordAccess=record=>connectionRecordStatus(record,getAccess).access;
 function returnDraft(connectionId){
  if(connectionId){if(!onReturn||!tradingConnections(get()).some(r=>r.id===connectionId)){msg(L('原接入已变化，请重新选择。','The connection changed. Choose it again.'),'error');return;}selectedReturn={connectionId,context:returnContext};}
  dialog.close();
 }
 function savedConnections(){return tradingConnections(normalizeConnections(get()));}
 // After a save the draft is reloaded from the stored settings; the sections not saved keep their unsaved edits and their hints.
 function keepEdits(key,base=get()){const previous=draft;draft=normalizeConnections(base);dirty.delete(key);for(const type of dirty)if(previous?.preferences[type]){draft[type]=previous[type];draft.preferences[type]=previous.preferences[type];}}
 // Whether the section on screen differs from the stored settings: a connection form by its name and the fields it shows (a saved connection against itself), Research data by the sources a save would keep (a provider picked but not yet added counts), other sections by their whole preference. An edit that the dialog itself puts back leaves no hint.
 function unsaved(){
  const p=draft.preferences[section],stored=normalizeConnections(get()).preferences[section],sorted=(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:1)):value,same=(a,b)=>JSON.stringify(a,sorted)===JSON.stringify(b,sorted);
  if(isTrading()){const record=editingId?savedConnections().find(r=>r.id===editingId):null;return accountLabel!==(record?record.label:'')||(section==='exchange'?['market','access']:p.venue==='hyperliquid'||p.network!=='evm'?['access']:['access','chain']).some(key=>p[key]!==(record||stored)[key]);}
  if(section==='data')return p.source!==stored.source||!same(p.source==='custom'&&chosen?[...new Set([...p.services,chosen])]:p.services,stored.services);
  return !same(p,stored);
 }
 function savePreferred(id){
  const current=normalizeConnections(get()),records=tradingConnections(current),record=records.find(r=>r.id===id);if(!record)return;
  const next=normalizeConnections({...current,tradingAccounts:records,preferredTradingConnection:id}),error=onSave(next,{section:record.kind,operation:'prefer',connectionId:id});
  if(error){msg(error,'error');return;}keepEdits();panel();q(`[data-connection-edit="${id}"]`)?.focus({preventScroll:true});msg(L('首选已更新，只用于新建草稿。','Preferred connection updated for new drafts only.'));
 }
 function disconnectRecord(id){
  const current=normalizeConnections(get()),record=tradingConnections(current).find(r=>r.id===id);if(!record)return;
  const error=onSave(current,{section:record.kind,operation:'disconnect',connectionId:id});if(error){msg(error,'error');return;}
  keepEdits();panel();q(`[data-connection-edit="${id}"]`)?.focus({preventScroll:true});msg(L('新的提交已阻止，已有运行和委托保留。','New submissions are blocked. Existing runs and orders are retained.'));
 }
 function editRecord(id){
  const record=savedConnections().find(r=>r.id===id);if(!record)return;
  section=record.kind;chosen=record.service||(record.kind==='exchange'&&(record.id==='legacy-exchange'||record.id==='binance-spot'||record.id==='binance-perp')?'binance':record.service);editingId=id;accountLabel=record.label;saved=false;scenario='normal';walletPreview=null;
  draft.preferences[section]={...draft.preferences[section],...record};if(chosen)draft.preferences[section].service=chosen;dirty.delete(section);panel(true);
 }
 function capture(){
  if(!draft)return;
  const enabled=q('#connection-enabled');if(enabled)draft[enabled.dataset.type]=enabled.checked;
  if(q('[data-connection-label]'))accountLabel=q('[data-connection-label]').value;
  for(const input of dialog.querySelectorAll('[data-pref]')){const [type,key]=input.dataset.pref.split('.');draft.preferences[type][key]=input.value;}
  for(const input of dialog.querySelectorAll('[data-agent-input]'))draft.preferences.ai.agents[input.dataset.agentId][input.dataset.agentInput]=input.value;
  if(section==='notifications'&&q('[data-event]'))draft.preferences.notifications.events=[...dialog.querySelectorAll('[data-event]:checked')].map(el=>el.dataset.event);
 }
 const focusField=input=>{input?.focus();input?.scrollIntoView({block:'center',inline:'nearest'});};
 function wipe(){for(const input of dialog.querySelectorAll('[data-credential]')){input.value='';input.type='password';}}
 function sharedExchange(){return section==='exchange'&&chosen==='binance'&&editingId!=='legacy-exchange'&&!(editingId&&tradingConnections(normalizeConnections(get())).some(row=>row.id===editingId&&row.accountId==='SIM-01'));}
 function updateFooter(){
  const hidden=section==='overview'||section==='notifications'||isTrading()&&!chosen||sharedExchange();
  dialog.querySelector('footer').hidden=hidden;
  q('#connections-check').hidden=hidden||saved;q('#connections-check').textContent=L('取消','Cancel');
  q('#connections-save').disabled=false;
  q('#connections-save').textContent=saved?(returnContext?L('返回原草稿','Return to draft'):L('完成','Done')):isTrading()?L('检查权限并保存','Check access & save'):official()?L('使用官方数据','Use official data'):L('保存设置','Save settings');
  if(section==='ai'&&!saved)q('#connections-save').textContent=official()?L('使用 Astarter AI','Use Astarter AI'):L('保存设置','Save settings');
 }
 function exitTo(action){const previous=afterClose;afterClose=()=>{previous?.();action();};dialog.close();}
 const info=(label,text)=>`<details class="cc-billing-info"><summary>${label}${uiIcon('info')}</summary><p>${text}</p></details>`;
 const heading=(title,extra='')=>`<div class="cc-heading"><h3>${title}</h3>${extra}</div>`;
 const facts=rows=>`<dl class="cc-review-facts">${rows.map(([name,value])=>`<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>`;

 function failure(code){return L(...({withdraw:['请先关闭 API 提现权限，再重新检查。','Turn off API withdrawals, then check again.'],permissions:['缺少所需权限，请调整 API 权限后重试。','Required access is missing. Update API permissions and retry.'],ip:['交易权限需要设置 IP 白名单，请完成后重试。','Trading access requires an IP allowlist. Set it and retry.'],timeout:['检查超时，请重试。设置还没有应用。','Check timed out. Retry; settings have not been applied.'],refused:['连接已取消，可以重新选择钱包。','Connection cancelled. Choose your wallet again.'],network:['网络不一致，请切换到所选网络。','Network mismatch. Switch to the selected network.']}[code]));}
 function fields(o){return `<div class="cc-credentials"><div class="cc-form-heading"><b>${L('API 凭据','API credentials')}</b>${control(L('填入预设值','Fill preset values'),'fill')}</div>${o.fields.map(key=>`<label class="cc-field">${{key:'API Key',secret:'Secret Key',passphrase:'Passphrase'}[key]}<span class="cc-secret"><input type="password" data-credential="${key}" aria-describedby="connection-feedback" aria-label="${{key:'API Key',secret:'Secret Key',passphrase:'Passphrase'}[key]}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="85"><button type="button" data-reveal="${key}" aria-label="${L('显示','Show')} ${{key:'API Key',secret:'Secret Key',passphrase:'Passphrase'}[key]}" aria-pressed="false">${L('显示','Show')}</button></span></label>`).join('')}</div><div class="cc-key-safety">${uiIcon('shield')}<span>${L('连接尚未开放，请勿填写真实密钥。表单内容不发送、不保存，关闭后清空。','Connection unavailable. Do not enter real keys. Form values are never sent or saved and are cleared on close.')}</span></div>`;}
 function accessTabs(){return `<div class="cc-access-tabs" role="group" aria-label="${L('交易接入方式','Trading access type')}"><button data-access-tab="exchange" aria-pressed="${section==='exchange'}">${uiIcon('account')}${L('交易所','Exchanges')}</button><button data-access-tab="wallet" aria-pressed="${section==='wallet'}">${uiIcon('wallet')}${L('链上钱包','Wallets')}</button></div>`;}
 function providerGrid(type){const options=CONNECTION_OPTIONS[type].filter(o=>type!=='wallet'||o.id==='metamask');return `<div class="cc-provider-grid">${options.map(o=>`<button type="button" class="cc-provider" data-provider="${o.id}">${mark(o)}<span><strong>${nameFor(o)}</strong><small>${L(...o.detail)}</small></span>${uiIcon('arrow')}</button>`).join('')}</div>`;}
 function tradingChooser(){
  const records=savedConnections().filter(r=>r.kind===section),preferred=preferredTradingConnection(normalizeConnections(get()));
  return heading(titleFor('exchange'),returnContext?control(L('返回原草稿','Return to draft'),'return-draft'):'')+'<p id="cc-inline-feedback" class="cc-inline-feedback" role="status"></p>'+accessTabs()+(records.length?`<div class="cc-section-heading"><h4>${L('已保存的接入','Saved connections')}</h4><span>${records.length}</span></div><div class="cc-account-list">${records.map(record=>savedConnectionCard(record,{preferred:preferred?.id===record.id,getAccess,returnDraft:Boolean(returnContext&&onReturn)})).join('')}</div>`:'')+`<div class="cc-section-heading"><h4>${L('添加接入','Add connection')}</h4></div>`+providerGrid(section);
 }
 let signedSession=null,ensuringWallet=false;
 const sessionAccount=()=>signedSession?.address?signedSession.address.slice(0,6)+'…'+signedSession.address.slice(-4):'';
 function accountFields(){const record=savedConnections().find(r=>r.id===editingId);const formRecord=section==='exchange'&&chosen==='binance'&&record?.accountId==='SIM-01'?null:record;const bsc=section==='wallet'&&chosen==='metamask'&&draft?.preferences.wallet.chain==='56'&&draft.preferences.wallet.venue!=='hyperliquid';return connectionAccountFields({record:formRecord,label:accountLabel,kind:section,service:chosen,...(bsc?{accountText:sessionAccount()}:{})});}
 async function ensureSignedWallet(){
  if(ensuringWallet||typeof getSignedWallet!=='function')return;
  ensuringWallet=true;
  try{
   const session=await getSignedWallet();
   if(!dialog.open)return;
   signedSession=session?.chain===56&&/^0x[0-9a-f]{40}$/.test(session.address||'')?{address:session.address.toLowerCase(),chain:56}:null;
   const records=savedConnections(),ready=records.some(record=>record.id==='wallet-bsc'&&record.accountId===signedSession?.address),placeholder=records.some(record=>record.kind==='wallet'&&record.chain==='56'&&record.venue!=='hyperliquid'&&record.accountId==='SIM-01');
   if(signedSession&&(!ready||placeholder)){const error=onSave(get(),{section:'wallet',operation:'verify',connectionId:'wallet-bsc'});if(error){msg(error,'error');return;}}
   if(section==='wallet')panel(true);
  }finally{ensuringWallet=false;}
 }
 function exchangeForm(o){
  if(sharedExchange()){
   const record=tradingConnections(normalizeConnections(get())).find(row=>row.id==='binance-spot');
   return heading(L('共享币安现货','Shared Binance spot'))+facts([[L('访问权限','Access'),L('只读','Read only')],[L('接入状态','Connection'),record?.status==='connected'?L('已连接','Connected'):L('尚未核实','Unverified')]])+'<p class="cc-key-safety">'+L('此接入的凭据由运营团队维护。','The operations team manages this connection.')+'</p>';
  }
  const p=draft.preferences.exchange;return `<fieldset class="cc-form-group"><legend>${L('账户与权限','Account & access')}</legend>${accountFields()}<div class="cc-two"><label class="cc-field">${L('市场类型','Market')}<select data-pref="exchange.market"><option value="spot" ${p.market==='spot'?'selected':''}>${L('现货','Spot')}</option><option value="perp" ${p.market==='perp'?'selected':''}>${L('合约','Futures')}</option></select></label><label class="cc-field">${L('使用权限','Access')}<select data-pref="exchange.access"><option value="read" ${p.access==='read'?'selected':''}>${L('只看数据','View only')}</option><option value="trade" ${p.access==='trade'?'selected':''}>${L('读取与交易','Read & trade')}</option></select></label></div></fieldset>${fields(o)}<div class="cc-permission-strip"><b>${L('权限要求','Required access')}</b><span>${L('读取账户','Read account')}</span><span>${L('关闭提现','Withdrawals off')}</span><span>${L('交易权限需 IP 白名单','Trading needs an IP allowlist')}</span></div>`;}
 function walletForm(o){const p=draft.preferences.wallet,family=o.id==='phantom'?'solana':'evm';return `<fieldset class="cc-form-group"><legend>${L('账户与权限','Account & access')}</legend>${accountFields()}<label class="cc-field">${L('使用权限','Access')}<select data-pref="wallet.access"><option value="read" ${p.access==='read'?'selected':''}>${L('仅查看','View only')}</option><option value="confirm" ${p.access==='confirm'?'selected':''}>${L('逐笔确认','Confirm each trade')}</option></select></label>${p.venue==='hyperliquid'?`<div class="cc-wallet-network">${venueIcon('hyperliquid',{size:24})}<b>Hyperliquid</b><span>EVM</span></div>`:family==='evm'?`<div class="cc-wallet-network">${tokenIcon('BNB',{size:24})}<b>BNB Chain</b><span>BSC</span></div>`:`<div class="cc-wallet-network">${tokenIcon('SOL',{size:24})}<b>Solana</b><span>${L('主网','Mainnet')}</span></div>`}</fieldset><section class="cc-wallet-preview" data-state="${walletPreview?.state||'idle'}">${mark(o)}<div><b>${walletPreview?.state==='ready'?L('连接配置已检查','Connection configuration checked'):walletPreview?.state==='network'?L('切换网络后继续','Switch network to continue'):L('检查钱包配置','Check wallet configuration')}</b></div>${control(walletPreview?.state==='network'?L('核对所选网络','Check selected network'):walletPreview?.state==='ready'?L('重新检查','Check again'):L('检查配置','Check configuration'),walletPreview?.state==='network'?'switch-network':'wallet-preview')}</section><div class="cc-key-safety">${uiIcon('shield')}<span>${L('不需要私钥或助记词，不会自动授权代币。','No private key or seed phrase. Tokens are not approved automatically.')}</span></div>`;}
 function billing(type){const own=connectionBilling(draft.preferences)[type]==='own-api';return `<div class="cc-billing" data-billing="${own?'own-api':'credits'}"><div><b>${own?L('调用积分 0','0 call credits'):L(type==='data'?'调用消耗数据积分':'调用消耗 AI 积分',type==='data'?'Calls use data credits':'Calls use AI credits')}</b><span>${own?L('使用自己的 API 额度','Uses your own API allowance'):L('按用量计费，执行前确认','Usage based; confirm before running')}</span></div>${info(L('费用说明','About charges'),L('自带 API 不收对应的数据或模型调用积分，供应商费用由你承担。研究和策略等任务费用仍按各自报价；保存设置不扣积分。','Own APIs use no corresponding data or model call credits. You pay the provider. Research and strategy tasks keep their quoted fees. Saving settings uses no credits.'))}</div>`;}
 function sourceTabs(type){const current=draft.preferences[type].source;return `<div class="cc-source-options" role="group" aria-label="${L('服务来源','Service source')}">${[['official',type==='data'?'Astarter 数据':'Astarter AI',type==='data'?'Astarter data':'Astarter AI',L('官方提供','Provided by Astarter')],['custom',L('自带 API','Your own API'),L('自带 API','Your own API'),L('使用自己的额度','Use your own allowance')]].map(([id,zh,en,detail])=>`<button type="button" data-source-mode="${id}" aria-pressed="${current===id}"><span class="cc-source-icon">${id==='official'?mark(CONNECTION_OPTIONS.ai[0]):uiIcon('data')}</span><span><strong>${L(zh,en)}</strong><small>${detail}</small></span><i>${current===id?uiIcon('check'):''}</i></button>`).join('')}</div>`;}
 function serviceSelect(type){const options=CONNECTION_OPTIONS[type].filter(o=>o.id!=='official');return `<label class="cc-field">${L(type==='data'?'数据服务商':'模型服务商',type==='data'?'Data provider':'Model provider')}<select id="cc-service">${type==='data'?`<option value="" ${!chosen?'selected':''}>${L('添加数据来源','Add a data source')}</option>`:''}${options.map(o=>`<option value="${o.id}" ${chosen===o.id?'selected':''}>${nameFor(o)}</option>`).join('')}</select></label>`;}
 const modelDate=version=>{const date=version?.match(/(\d{4})(\d{2})(\d{2})$/);return date?`${date[1]}-${date[2]}-${date[3]}`:version;};
 const versionLabel=model=>`${model.name.match(/\d+(?:\.\d+)*/)?.[0]||model.name} · ${modelDate(model.version)}`;
 function agentModelsView(open=false){
  const p=draft.preferences.ai,own=p.source==='custom',plan=agentModelPlan(p);
  return `<details class="cc-agent-models" ${open||own?'open':''}><summary>${L('Agent 模型方案','Agent model plan')}<span class="cc-model-count" data-no-translate aria-label="18 Agents">18</span></summary><div class="cc-model-teams">${RESEARCH_GROUPS.map((group,index)=>`<details data-model-group="${index}" ${own&&index===0?'open':''}><summary><b>${t(group.label)}</b><span class="cc-model-count" data-no-translate aria-label="3 Agents">3</span></summary>${group.roles.map(roleIndex=>{
   const role=ROLES[roleIndex],assigned=plan.assignments[role.id],model=catalogModel(assigned),family=model?.family||'custom';
   const identity=`<div class="cc-agent-model-name"><span>${role.id}</span><b>${t(role.name)}</b></div>`;
   if(!own)return `<div class="cc-agent-model-row is-readonly">${identity}<div><b>${esc(model?.name||assigned.model)}</b><span title="${esc(assigned.version)}">${esc(modelDate(assigned.version))}</span></div></div>`;
   return `<div class="cc-agent-model-row" data-model-role="${role.id}">${identity}<div class="cc-agent-model-fields"><label class="cc-field">${L('模型','Model')}<select data-agent-family="${role.id}" aria-label="${role.id} ${L('模型','Model')}">${AGENT_MODEL_FAMILIES.map(f=>`<option value="${f.id}" ${family===f.id?'selected':''}>${f.name}</option>`).join('')}<option value="custom" ${family==='custom'?'selected':''}>${L('自定义模型','Custom model')}</option></select></label>${family==='custom'?`<label class="cc-field">${L('模型 ID','Model ID')}<input data-agent-input="model" data-agent-id="${role.id}" aria-label="${role.id} ${L('模型 ID','Model ID')}" value="${esc(assigned.model)}" placeholder="provider/model-id" autocomplete="off" spellcheck="false" maxlength="160"></label><label class="cc-field">${L('版本号','Version')}<input data-agent-input="version" data-agent-id="${role.id}" aria-label="${role.id} ${L('版本号','Version')}" value="${esc(assigned.version)}" placeholder="v1 / 2026-11-03" autocomplete="off" spellcheck="false" maxlength="160"></label>`:`<label class="cc-field">${L('版本号','Version')}<select data-agent-version="${role.id}" aria-label="${role.id} ${L('版本号','Version')}">${AGENT_MODEL_CATALOG.filter(m=>m.family===family).map(m=>`<option value="${m.id}" ${m.id===assigned.model?'selected':''}>${versionLabel(m)}</option>`).join('')}</select></label>`}</div></div>`;
  }).join('')}</details>`).join('')}</div></details>`;
 }
 function refreshAgentModels(){
  const previous=q('.cc-agent-models'),open=previous?.open,groups=[...dialog.querySelectorAll('[data-model-group][open]')].map(el=>el.dataset.modelGroup);
  if(!previous)return;previous.outerHTML=agentModelsView(open);for(const detail of dialog.querySelectorAll('[data-model-group]'))detail.open=groups.includes(detail.dataset.modelGroup);bindAgentModels();
 }
 function bindAgentModels(){
  for(const select of dialog.querySelectorAll('[data-agent-family]'))select.onchange=()=>{capture();const role=select.dataset.agentFamily;if(select.value==='custom')draft.preferences.ai.agents[role]={model:'',version:''};else{const m=AGENT_MODEL_CATALOG.find(model=>model.family===select.value);draft.preferences.ai.agents[role]={model:m.id,version:m.version};}dirty.add(section);refreshAgentModels();dirtyHint();q(`[data-agent-family="${role}"]`)?.focus();};
  for(const select of dialog.querySelectorAll('[data-agent-version]'))select.onchange=()=>{capture();const m=AGENT_MODEL_CATALOG.find(model=>model.id===select.value);if(m){draft.preferences.ai.agents[select.dataset.agentVersion]={model:m.id,version:m.version};dirty.add(section);}select.removeAttribute('aria-invalid');dirtyHint();};
  for(const input of dialog.querySelectorAll('[data-agent-input]'))input.oninput=()=>{const before=draft.preferences.ai.agents[input.dataset.agentId]?.[input.dataset.agentInput];input.removeAttribute('aria-invalid');if(input.value&&(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(input.value)||/^(?:sk[-_]|rk[-_]|AIza|gh[pousr]_|Bearer)/.test(input.value))){input.value='';if(before)dirty.add(section);msg(L('这里只填写模型名称和版本，请勿填写密钥。','Enter only a model name and version, never an API key.'),'error');}else{capture();dirty.add(section);dirtyHint();}capture();};
 }
 function resources(){const p=draft.preferences[section];let html=heading(titleFor(section))+sourceTabs(section)+billing(section);
  if(section==='data'){
   if(!official())html+=serviceSelect('data')+(option()?option().fields.length?fields(option()):`<div class="cc-official-summary"><b>${L('此来源无需 API Key','This source needs no API key')}</b></div>`:'')+(p.services.length?`<div class="cc-configured"><span>${L('已保存的来源','Saved sources')}</span>${p.services.map(id=>`<span class="cc-source-chip">${nameFor(CONNECTION_OPTIONS.data.find(o=>o.id===id))}<button data-remove-source="${id}" data-no-translate aria-label="${L('移除 {name}','Remove {name}').replace('{name}',()=>esc(nameFor(CONNECTION_OPTIONS.data.find(o=>o.id===id))))}">${uiIcon('close')}</button></span>`).join('')}</div>`:'');
  }else{
   if(official())html+=`<fieldset class="cc-model-modes"><legend>${L('运行模式','Run mode')}</legend><div>${AI_MODES.map(([id,z,en])=>`<button type="button" data-ai-mode="${id}" aria-pressed="${p.model===id}">${L(z,en)}</button>`).join('')}</div></fieldset>`;
   if(!official())html+=serviceSelect('ai')+(p.service==='gateway'?`<div class="cc-gateway"><label class="cc-field">Base URL<input data-pref="ai.endpoint" type="url" value="${esc(p.endpoint)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" maxlength="300"></label></div>`:'')+fields(option());
   html+=agentModelsView();
  }
  return html;
 }
 function overview(){return heading(L('配置概览','Overview'),returnContext?control(L('返回原草稿','Return to draft'),'return-draft'):'')+connectionOverview(get(),{getAccess,notificationScope:getNotificationScope(),accountNotifications:Boolean(privateUI)})+(privateUI?'<div data-private-workspace-slot></div>':'');}
 function success(){
  const trading=isTrading(),wallet=section==='wallet',o=option(),record=trading?savedConnections().find(r=>r.id===editingId):null,route=record?recordProfile(record):null;
  const message=trading?wallet?record.access==='read'?L('已保存钱包配置，交易权限仍为仅查看。','Wallet configuration saved. Trading access remains view only.'):L('已保存钱包配置。每笔交易仍需单独确认，不支持自动授权。','Wallet configuration saved. Each trade needs confirmation; automatic authority is unavailable.'):L('配置已保存，已有运行继续使用原接入。','Configuration saved. Existing runs keep their original connection.'):L('来源与计费偏好已保存，本次没有扣积分。','Source and billing preferences saved. No credits were used.');
  const rows=trading?[[L('接入名称','Connection name'),esc(record?.label)],[L('使用账户','Account'),esc(record?.accountId)],...(wallet?[[L('钱包类型','Wallet type'),nameFor(o)],[L('使用网络','Network'),record.venue==='hyperliquid'?'Hyperliquid':WALLET_NETWORKS.find(n=>n.id===record.chain)?.name||'Solana'],[L('交易权限','Trading access'),record.access==='read'?L('仅查看','View only'):L('逐笔确认','Confirm each trade')]]:[[L('交易所','Exchange'),nameFor(o)],[L('市场类型','Market'),record.market==='spot'?L('现货','Spot'):L('合约','Futures')],[L('使用权限','Access'),record.access==='trade'?L('读取与交易','Read & trade'):L('只看数据','View only')],[L('API 凭据','API credentials'),section==='exchange'&&chosen==='binance'?L('已加密保存在服务器，未保存在浏览器','Encrypted on the server; not stored in the browser'):L('已清空，未保存','Cleared; not saved')]])]:[];
  return `<div class="cc-saved"><span>${uiIcon('check')}</span><h3>${trading?L('接入配置已保存','Connection configuration saved'):L('设置已保存','Settings saved')}</h3><p>${message}</p></div>${trading?facts(rows)+(route?accessPanel(recordAccess(record),{compact:true}):`<p class="cc-key-safety">${L('此网络暂未开放模拟交易。','Simulated trading is not available on this network yet.')}</p>`):billing(section)}<div class="cc-success-actions">${control(L('返回配置','Back to settings'),'back')}${trading?(returnContext?(onReturn?control(L('用于此草稿','Use for this draft'),'use-draft'):''):wallet?control(L('查看交易枢纽','Open trading hub'),'execution'):control(L('设置金额与保护','Set amount & protection'),'strategy')):''}</div>`;
 }

 function detail(){const o=option();return `<div class="cc-detail-heading"><button type="button" class="cc-back" data-cc="back" aria-label="${L('返回选择','Back to selection')}">${uiIcon('arrow')}</button><div>${mark(o)}<h3>${nameFor(o)}</h3>${o.docs?`<a href="${o.docs}" target="_blank" rel="noopener noreferrer">${L('官方说明','Official guide')} ↗</a>`:''}</div></div>`+(section==='exchange'?exchangeForm(o):walletForm(o));}
 function panel(focus=false){
  dialog.dataset.view=section;
  notificationSettings.close();wipe();msg('');for(const b of dialog.querySelectorAll('[data-setting]'))b.setAttribute('aria-pressed',String(b.dataset.setting===(section==='wallet'?'exchange':section)));
  q('#connection-content').innerHTML=(section==='overview'?overview():saved?success():isTrading()?chosen?detail():tradingChooser():section==='notifications'?'<div id="cc-notification-settings"></div>':resources())+'<div id="cc-result" role="status"></div>';
  if(section==='notifications'){if(privateUI)privateUI.mount(q('#cc-notification-settings'),'settings');else notificationSettings.mount(q('#cc-notification-settings'));}
  if(section==='overview'&&privateUI)privateUI.mount(q('[data-private-workspace-slot]'),'workspace');
  updateFooter();bindAgentModels();dirtyHint();
  for(const b of dialog.querySelectorAll('[data-section]'))b.onclick=()=>open(b.dataset.section);
  for(const b of dialog.querySelectorAll('[data-access-tab]'))b.onclick=()=>open(b.dataset.accessTab);
  for(const b of dialog.querySelectorAll('[data-provider]'))b.onclick=()=>{capture();editingId=null;accountLabel='';chosen=b.dataset.provider;scenario='normal';walletPreview=null;if(option()?.wallet){section='wallet';chosen='metamask';draft.preferences.wallet={...draft.preferences.wallet,service:'metamask',network:'evm',venue:'hyperliquid',access:'read'};panel(true);return;}draft.preferences[section].service=chosen;if(section==='wallet'){draft.preferences.wallet.venue='wallet';draft.preferences.wallet.network='evm';draft.preferences.wallet.chain='56';}if(section==='wallet')draft.preferences=normalizeConnectionPreferences(draft.preferences);panel(true);if(section==='wallet'&&draft.preferences.wallet.chain==='56')void ensureSignedWallet();};
  for(const b of dialog.querySelectorAll('[data-connection-edit]'))b.onclick=()=>editRecord(b.dataset.connectionEdit);
  for(const b of dialog.querySelectorAll('[data-connection-prefer]'))b.onclick=()=>savePreferred(b.dataset.connectionPrefer);
  for(const b of dialog.querySelectorAll('[data-connection-disconnect]'))b.onclick=()=>disconnectRecord(b.dataset.connectionDisconnect);
  for(const b of dialog.querySelectorAll('[data-connection-use]'))b.onclick=()=>returnDraft(b.dataset.connectionUse);
  for(const b of dialog.querySelectorAll('[data-source-mode]'))b.onclick=()=>{if(draft.preferences[section].source===b.dataset.sourceMode)return;capture();dirty.add(section);draft.preferences[section].source=b.dataset.sourceMode;if(section==='ai'){draft.preferences.ai.service=b.dataset.sourceMode==='official'?'official':draft.preferences.ai.customService||'openrouter';chosen=draft.preferences.ai.service;}else chosen=draft.preferences.data.services.length?null:'coinglass';panel();q(`[data-source-mode="${b.dataset.sourceMode}"]`)?.focus();};
  for(const b of dialog.querySelectorAll('[data-ai-mode]'))b.onclick=()=>{if(draft.preferences.ai.model===b.dataset.aiMode)return;capture();dirty.add(section);draft.preferences.ai.model=b.dataset.aiMode;refreshAgentModels();dirtyHint();for(const button of dialog.querySelectorAll('[data-ai-mode]'))button.setAttribute('aria-pressed',String(button===b));};
  for(const b of dialog.querySelectorAll('[data-remove-source]'))b.onclick=()=>{capture();dirty.add(section);draft.preferences.data.services=draft.preferences.data.services.filter(id=>id!==b.dataset.removeSource);if(chosen===b.dataset.removeSource)chosen=null;panel();q('#cc-service')?.focus();};
  q('#cc-service')?.addEventListener('change',event=>{capture();dirty.add(section);chosen=event.target.value;if(section!=='data')draft.preferences[section].service=chosen;if(section==='ai')draft.preferences.ai.customService=chosen;panel();q('#cc-service')?.focus();});
  for(const b of dialog.querySelectorAll('[data-cc]'))b.onclick=()=>act(b.dataset.cc);
  for(const b of dialog.querySelectorAll('[data-reveal]'))b.onclick=()=>{const field=q(`[data-credential="${b.dataset.reveal}"]`),show=field.type==='password';field.type=show?'text':'password';b.setAttribute('aria-pressed',String(show));b.textContent=show?L('隐藏','Hide'):L('显示','Show');b.setAttribute('aria-label',(show?L('隐藏','Hide'):L('显示','Show'))+' '+field.getAttribute('aria-label'));};
  dialog.querySelectorAll('input,select').forEach(input=>input.addEventListener('input',()=>{if(input.hasAttribute('data-agent-input'))return;if(input.hasAttribute('data-credential')&&!(section==='exchange'&&chosen==='binance')&&input.value&&!('demo-'.startsWith(input.value)||/^demo-[a-zA-Z0-9-]{0,80}$/.test(input.value))){input.value='';input.type='password';msg(L('这里只接受演示值，请勿粘贴真实密钥。','Use demo values here. Do not paste real credentials.'),'error');return;}input.removeAttribute('aria-invalid');capture();if(!input.hasAttribute('data-credential')){dirty.add(section);dirtyHint();}else msg('');if(section==='notifications')q('#cc-result')?.replaceChildren();}));
  q('#cc-scenario')?.addEventListener('change',event=>{scenario=event.target.value;walletPreview=null;panel();q('.cc-recovery-demo').open=true;q('#cc-scenario')?.focus();});
  q('[data-pref="wallet.chain"]')?.addEventListener('change',()=>{capture();dirty.add(section);walletPreview=null;panel();q('[data-pref="wallet.chain"]')?.focus();});
  if(focus){const h=q('#connection-content h3');h?.setAttribute('tabindex','-1');h?.focus({preventScroll:true});q('#connection-content').scrollTop=0;}
 }
 function act(action){
  if(action==='back'){capture();saved=false;editingId=null;accountLabel='';chosen=isTrading()?null:section==='ai'?draft.preferences.ai.service:section==='data'?draft.preferences.data.services.length?null:'coinglass':draft.preferences.notifications.service;walletPreview=null;scenario='normal';panel(true);}
  else if(action==='return-draft')returnDraft();
  else if(action==='use-draft')returnDraft(editingId);
  else if(action==='fill'){for(const input of dialog.querySelectorAll('[data-credential]')){input.value='demo-'+chosen+'-'+input.dataset.credential;input.removeAttribute('aria-invalid');}dirtyHint();}
  else if(action==='wallet-preview'||action==='switch-network'){capture();const issue=action==='switch-network'?null:connectionPreviewIssue('wallet',draft.preferences.wallet,scenario);walletPreview={state:issue==='network'?'network':issue?'failed':'ready'};if(issue!=='network')scenario='normal';panel();q(`[data-cc="${issue==='network'?'switch-network':'wallet-preview'}"]`)?.focus();if(issue)msg(failure(issue),'error');}
  else if(action==='execution')exitTo(()=>document.dispatchEvent(new CustomEvent('hive:navigate',{detail:'execution'})));
  else if(action==='strategy')exitTo(()=>document.dispatchEvent(new CustomEvent('hive:configure-strategy')));
  else if(action==='setup')exitTo(()=>document.dispatchEvent(new CustomEvent('hive:navigate',{detail:'setup'})));
 }
 function validate(){capture();const o=option();if(['data','ai'].includes(section))draft[section]=true;
  if(section==='ai'&&draft.preferences.ai.source==='custom'&&draft.preferences.ai.service==='gateway'){
   const p=draft.preferences.ai;if(!safeGatewayURL(p.endpoint)){const input=q('[data-pref="ai.endpoint"]');input.setAttribute('aria-invalid','true');focusField(input);msg(L('请填写 HTTPS 服务地址，不要附带密钥、账号或查询参数。','Use an HTTPS service URL without credentials or query parameters.'),'error');return false;}
  }
  if(section==='ai'&&!official()){const id=agentModelsIssue(draft.preferences.ai);if(id){q('.cc-agent-models').open=true;const row=q(`[data-model-role="${id}"]`);if(row){row.closest('[data-model-group]').open=true;const field=safeModelIdentity(draft.preferences.ai.agents[id].model)?'version':'model',input=row.querySelector(`[data-agent-input="${field}"]`)||row.querySelector('select');input?.setAttribute('aria-invalid','true');focusField(input);}msg(id+' · '+L('请填写模型和版本号。','Enter the model and version.'),'error');return false;}}
  if(!official()&&o?.fields.length){const values=Object.fromEntries([...dialog.querySelectorAll('[data-credential]')].map(input=>[input.dataset.credential,input.value]));const issue=apiCredentialIssue(o,values);if(issue){for(const input of dialog.querySelectorAll('[data-credential]'))input.setAttribute('aria-invalid',String(Boolean(apiCredentialIssue({...o,fields:[input.dataset.credential]},{[input.dataset.credential]:input.value}))));focusField(q('[aria-invalid="true"]'));msg(issue==='live-required'||issue==='invalid-credentials'?L('请填写有效的 API Key 和 Secret。','Enter a valid API Key and Secret.'):L('请点击“填入演示值”后继续。','Choose “Use demo values” to continue.'),'error');return false;}}
  if(section==='wallet'&&walletPreview?.state!=='ready'&&!(draft.preferences.wallet.chain==='56'&&draft.preferences.wallet.venue!=='hyperliquid')){msg(L('请先完成钱包连接体验。','Preview the wallet connection first.'),'error');return false;}
  if(isTrading()&&!(section==='exchange'&&chosen==='binance')){const issue=connectionPreviewIssue(section,draft.preferences[section],scenario);if(issue){if(issue==='timeout')scenario='normal';msg(failure(issue),'error');return false;}}
  if(section==='data'&&draft.preferences.data.source==='custom'){if(chosen)draft.preferences.data.services=[...new Set([...draft.preferences.data.services,chosen])];if(!draft.preferences.data.services.length){msg(L('请添加一个数据来源，或改用官方数据。','Add a data source or choose official data.'),'error');focusField(q('#cc-service'));return false;}}
  if(section==='exchange')draft.exchange=true;
  return true;
 }
 async function saveCurrent(){
  if(section==='notifications'||sharedExchange())return;
  if(saved){returnDraft();return;}
  if(!validate())return;
  if(isTrading()){
   const bscWallet=section==='wallet'&&draft.preferences.wallet.chain==='56'&&draft.preferences.wallet.venue!=='hyperliquid';
   if(bscWallet&&typeof getSignedWallet==='function'){const session=await getSignedWallet();signedSession=session?.chain===56&&/^0x[0-9a-f]{40}$/.test(session.address||'')?{address:session.address.toLowerCase(),chain:56}:null;}
   if(bscWallet&&!signedSession?.address){msg(L('请先连接钱包。','Connect the wallet first.'),'error');return;}
   const current=normalizeConnections(get()),records=tradingConnections(current),existing=bscWallet?records.find(r=>r.id==='wallet-bsc'):records.find(r=>r.id===editingId);
   if(!bscWallet&&editingId&&!existing){msg(L('原接入已变化，请重新选择。','The connection changed. Choose it again.'),'error');return;}
   if(!existing&&records.length>=20){msg(L('最多保存 20 个接入，请编辑已有接入。','Up to 20 connections can be saved. Edit an existing connection.'),'error');return;}
   const id=bscWallet?'wallet-bsc':existing?.id||crypto.randomUUID(),accountId=bscWallet?signedSession.address:existing?.accountId||(section==='wallet'?'SIM-01':'UNCONNECTED'),record=normalizeTradingConnections([{...draft.preferences[section],id,kind:section,label:accountLabel||(bscWallet?sessionAccount():''),accountId,...(bscWallet?{status:'connected',chain:'56',service:'metamask',network:'evm',venue:'wallet'}:{})}])[0];
   if(!record){msg(L('请检查接入配置。','Check the connection configuration.'),'error');return;}
   const pool=bscWallet?records.filter(r=>r.id!=='wallet-bsc'&&!(r.kind==='wallet'&&r.chain==='56'&&r.venue!=='hyperliquid'&&r.accountId==='SIM-01')):records;
   const nextAccounts=bscWallet?[...pool,record]:existing?records.map(r=>r.id===id?record:r):[...records,record];
   const next=normalizeConnections({...current,tradingAccounts:nextAccounts,preferredTradingConnection:nextAccounts.some(r=>r.id===current.preferredTradingConnection)?current.preferredTradingConnection:''});
   const error=onSave(next,{section,operation:'verify',connectionId:id});if(error){msg(error,'error');return;}
   keepEdits(section);draft.preferences[section]={...draft.preferences[section],...record};editingId=id;accountLabel=record.label;wipe();saved=true;panel(true);refresh();return;
  }
  const normalized=mergeConnectionSection(get(),draft,section),error=onSave(normalized,section);if(error){msg(error,'error');return;}
  keepEdits(section,normalized);wipe();saved=true;panel(true);refresh();
 }
 function open(key='overview',button,options={}){
  if(!TYPES.some(([type])=>type===key)&&key!=='overview')key='overview';
  if(!dialog.open){dialog.returnValue='';draft=normalizeConnections(get());dirty.clear();opener=button||document.activeElement;afterClose=typeof options.onClose==='function'?options.onClose:null;returnContext=connectionReturnContext(options.returnContext);onReturn=returnContext&&typeof options.onReturn==='function'?options.onReturn:null;selectedReturn=null;}else capture();
  section=key;saved=false;editingId=null;accountLabel='';chosen=key==='ai'?draft.preferences.ai.service:key==='data'?draft.preferences.data.services.length?null:'coinglass':key==='notifications'?draft.preferences.notifications.service:null;if(options.service&&CONNECTION_OPTIONS[key]?.some(o=>o.id===options.service)){chosen=options.service;draft.preferences[key].service=chosen;}if(key==='wallet'&&WALLET_NETWORKS.some(n=>n.id===options.chain))draft.preferences.wallet.chain=options.chain;walletPreview=null;scenario='normal';if(isTrading()&&returnContext&&!options.connectionId&&savedConnections().some(r=>r.kind===section))chosen=null;labels();if(options.connectionId&&isTrading()&&savedConnections().some(r=>r.id===options.connectionId))editRecord(options.connectionId);else panel(dialog.open);if(key==='wallet')void ensureSignedWallet();if(!dialog.open)dialog.showModal();dialog.querySelector(`[data-setting="${section==='wallet'?'exchange':section}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});
 }
 q('#connections-save').onclick=saveCurrent;q('#connections-check').onclick=()=>{draft=normalizeConnections(get());dirty.clear();chosen=isTrading()?null:section==='ai'?draft.preferences.ai.service:section==='data'?draft.preferences.data.services.length?null:'coinglass':draft.preferences.notifications.service;walletPreview=null;scenario='normal';panel(true);msg(L('已取消，未保存的更改已放弃；已保存的设置不变。','Cancelled. Unsaved changes were discarded; saved settings are unchanged.'));};
 q('#connections-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{
  if(dialog.open)return;
  notificationSettings.close();wipe();q('#connection-content').replaceChildren();
  draft=null;dirty.clear();chosen=null;saved=false;walletPreview=null;editingId=null;accountLabel='';
  const action=afterClose,selection=selectedReturn,callback=onReturn,preserveDraft=Boolean(returnContext);
  afterClose=null;onReturn=null;returnContext=null;selectedReturn=null;
  if(dialog.returnValue==='page-leave'){opener=null;return;}
  try{if(selection&&callback)callback(selection);}
  finally{try{if(action)action();}finally{if(opener?.isConnected)opener.focus();if(!preserveDraft)document.dispatchEvent(new CustomEvent('hive:access'));}}
 });
 document.addEventListener('click',event=>{const button=event.target.closest?.('[data-connection-open]');if(!button)return;event.preventDefault();const data=button.dataset;open(data.connectionOpen,button,{connectionId:data.connectionId,returnContext:{route:data.connectionReturn,draftId:data.connectionDraft,version:data.connectionVersion?Number(data.connectionVersion):undefined}});});
 dialog.querySelectorAll('[data-setting]').forEach(b=>b.onclick=()=>open(b.dataset.setting));bar.querySelectorAll('[data-connect]').forEach(b=>b.onclick=()=>open(b.dataset.connect,b));
 const mobile=document.createElement('button');mobile.id='mobile-connections';mobile.textContent=L('配置','Connections');mobile.onclick=()=>open('overview',mobile);document.querySelector('.mobile-nav').append(mobile);
 function labels(){speedLabel();bar.querySelector('.connection-manage').setAttribute('aria-label',L('打开全部配置','Open all settings'));bar.querySelector('.connection-manage span').textContent=L('配置','Settings');for(const [k]of NAV_TYPES){const b=bar.querySelector(`[data-connect="${k}"]`);b.querySelector('span').firstChild.textContent=titleFor(k);}q('#connection-title').textContent=titleFor('overview');q('#connections-close').setAttribute('aria-label',L('关闭连接配置','Close connections'));for(const b of dialog.querySelectorAll('[data-setting]'))b.innerHTML=uiIcon(TYPES.find(t=>t[0]===b.dataset.setting)?.[2]||'data')+(b.dataset.setting==='overview'?L('配置概览','Overview'):titleFor(b.dataset.setting));mobile.textContent=L('配置','Connections');updateFooter();}
 function refresh(){
  labels();const d=get();measure();ticker.refresh();
  for(const [key]of NAV_TYPES){const b=bar.querySelector(`[data-connect="${key}"]`);if(key==='exchange'){updateTradingConnectionStatus(b,d,getAccess);continue;}b.dataset.enabled=String(key==='notifications'?notificationSummary(getNotificationScope(),d.notifications).active:d[key]);const status=key==='data'?d.preferences?.data.source==='custom'?L('自带 API','Your API'):L('Astarter 数据','Astarter data'):key==='ai'?d.preferences?.ai.source==='custom'?L('自带 API','Your API'):'Astarter AI':notificationSummary(getNotificationScope(),d.notifications).label;b.querySelector('small').textContent=status;b.title=titleFor(key)+' · '+status;b.setAttribute('aria-label',b.title);}
 }
 window.addEventListener('resize',()=>{if(dialog.open)q('nav [aria-pressed=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});});
 window.addEventListener('pagehide',event=>{wipe();probe?.abort();if(event.persisted)ticker.pause();else ticker.dispose();});
 window.addEventListener('pageshow',event=>{if(event.persisted){ticker.resume();refresh();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){wipe();probe?.abort();ticker.pause();}else{probedAt=-Infinity;ticker.resume();refresh();}});
 document.addEventListener('hive:access',()=>{refresh();if(!dialog.open||!isTrading())return;if(saved){keepEdits();panel(true);return;}if(!chosen){draft=normalizeConnections(get());panel(saved);}});
 document.addEventListener('hive:page-leave',()=>{if(dialog.open)dialog.close('page-leave');});
 document.addEventListener('hive:locale',()=>{if(dialog.open)dialog.close();refresh();});refresh();return {open,refresh};
}
