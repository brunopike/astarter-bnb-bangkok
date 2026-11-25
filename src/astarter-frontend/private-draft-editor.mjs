import {createPrivateDraftClient} from './private-draft-client.mjs';
import {validatePrivateDraftPreviewInput} from './private-draft-data.mjs';
import {botCreationFrame} from './strategy-bot-views.mjs';
import {mountCharts} from './product-chart-ui.mjs';
import {refreshNumberInputs} from './product-number-input.mjs';
import {tradingConnections} from './connection-options.mjs';
import {pair as L} from './locale.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const GRID=['lower','upper','count','spacing','triggerPrice','takeProfitPrice','stopLossPrice'];
const BASKET=['deviationPct','sizeMultiplier','maxEntries','takeProfitPct','stopLossPct','triggerPrice'];
const LABELS={name:['草稿名称','Draft name'],strategy:['策略模板','Strategy template'],planVariant:['模板版本','Template version'],market:['交易资产','Instrument'],environment:['账户环境','Environment'],mode:['运行方式','Mode'],amount:['单次买入','Order amount'],cap:['资金上限','Allocation limit'],researchBudget:['研究预算','Research budget'],botParameters:['策略参数','Strategy parameters'],protection:['风控方案','Protection'],executionRoute:['模拟接入','Paper connection'],source:['研究来源','Research source'],lower:['最低价格','Lower price'],upper:['最高价格','Upper price'],count:['网格数量','Grid count'],spacing:['网格类型','Spacing'],triggerPrice:['触发价格','Trigger price'],takeProfitPrice:['止盈价格','Take-profit price'],stopLossPrice:['止损价格','Stop-loss price'],deviationPct:['加仓间距','Entry deviation'],sizeMultiplier:['买入金额倍率','Entry size multiplier'],maxEntries:['最多买入次数','Maximum entries'],takeProfitPct:['整篮止盈','Basket take-profit'],stopLossPct:['整篮止损','Basket stop-loss'],episode:['单笔风险','Risk per episode'],notional:['名义敞口','Notional exposure'],daily:['单日亏损','Daily loss'],epoch:['周期亏损','Period loss'],soft:['软回撤','Soft drawdown'],hard:['硬回撤','Hard drawdown']};
const label=key=>LABELS[key]?L(...LABELS[key]):L('待补参数','Missing parameter');
const template=id=>id==='S01'?L('区间网格 · 纸面模拟','Range grid · Paper'):L('分批买入 · 纸面模拟','Scaled entries · Paper');
const parameterKeys=fields=>fields.strategy==='S01'?GRID:BASKET;
const nullable=value=>value===''?null:Number(value);
const date=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,96}$/.test(value);
const requestId=value=>validId(value)&&value.length>=8;

export function emptyPrivateDraftFields(strategy,symbol){
 if(!['S01','S02'].includes(strategy)||!['BTC','ETH','SOL'].includes(symbol))throw Error('PRIVATE_REQUEST_INVALID');
 return {name:symbol+' · '+template(strategy),strategy,planVariant:strategy+'-SIM',market:symbol+'/USDT',environment:'DEMO',mode:'auto',amount:null,cap:null,researchBudget:null,botParameters:null,protection:null,executionRoute:null};
}

// Empty controls stay null; no amount, risk or entry parameter is inferred from report prose.
export function privateDraftFormInput(form,base){
 const fields=structuredClone(base),read=name=>form.elements.namedItem(name)?.value;
 const numeric=name=>{const control=form.elements.namedItem(name);if(!control||control.validity?.badInput)throw Error('PRIVATE_REQUEST_INVALID');const value=nullable(control.value);if(value!==null&&!Number.isFinite(value))throw Error('PRIVATE_REQUEST_INVALID');return value;};
 fields.name=read('name');for(const key of ['amount','cap','researchBudget'])fields[key]=numeric(key);
 const params=Object.fromEntries(parameterKeys(fields).map(key=>[key,key==='spacing'?read('param_'+key)||null:numeric('param_'+key)]));
 fields.botParameters=base.botParameters===null&&Object.values(params).every(value=>value===null)?null:params;
 const protection=read('protection');
 fields.protection=protection==='original'?{id:'original',version:'strategy-original'}:protection==='normal'||protection==='conservative'?{id:'astarter',version:'astarter-research-v0.1/sim-2',mode:protection}:protection==='custom'&&base.protection?.version==='astarter-research-v0.1/sim-3'?{...structuredClone(base.protection),parameters:Object.fromEntries(['episode','notional','daily','epoch','soft','hard'].map(key=>{const value=numeric('risk_'+key);if(value===null)throw Error('PRIVATE_REQUEST_INVALID');return [key,value/100];}))}:null;
 const connectionId=read('connection');fields.executionRoute=connectionId?{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId,chainId:''}:null;
 return fields;
}

function display(value,key){
 if(value===null||value===undefined)return L('待填写','Not set');
 if(key==='source')return value.symbol+' · '+date(value.createdAt);
 if(key==='strategy')return template(value);
 if(key==='protection')return value.id==='original'?L('策略原有保护','Strategy protection'):'Astarter · '+L(value.mode==='conservative'?'保守':'标准',value.mode==='conservative'?'Conservative':'Standard')+(value.parameters?' · '+Object.entries(value.parameters).map(([name,n])=>label(name)+' '+(n*100)+'%').join(' / '):'');
 if(key==='executionRoute')return 'Binance · SIM-01 · '+value.connectionId;
 if(key==='botParameters')return Object.entries(value).filter(([,n])=>n!==null).map(([name,n])=>label(name)+' '+(name==='spacing'?n==='geometric'?L('等比','Geometric'):L('等差','Arithmetic'):n)).join(' · ')||L('待填写','Not set');
 if(key==='environment')return L('纸面模拟','Paper simulation');if(key==='mode')return L('自动规则','Automatic rules');
 return String(value);
}

export function renderPrivateDraftDiff(preview){
 if(!preview)return '';
 return `<section class="pd-diff" aria-label="${L('保存前确认','Review before saving')}"><h3>${L('确认本次变更','Review changes')}</h3>${preview.changedFields.length?`<dl>${preview.changedFields.map(group=>{const key=group==='source'?'source':group.slice(7),before=group==='source'?preview.current?.content.source:preview.current?.content.fields[key],after=group==='source'?preview.proposal.source:preview.proposal.fields[key];return `<div><dt>${label(key)}</dt><dd><span>${esc(display(before,key))}</span><b aria-hidden="true">→</b><strong>${esc(display(after,key))}</strong></dd></div>`;}).join('')}</dl>`:`<p>${L('参数与已保存版本一致。','Parameters match the saved version.')}</p>`}${preview.proposal.missingFields.length?`<p class="pd-missing">${L('尚待补充','Still needed')} · ${preview.proposal.missingFields.map(key=>esc(label(key.split('.').at(-1)))).join(' / ')}</p>`:''}<p>${L('保存到当前账户的私人草稿，不会开始交易。','Saves a private draft to this account. Trading does not start.')}</p></section>`;
}

const messages=value=>{
 if(['auth-required','forbidden'].includes(value.status))return L('验证钱包后，继续编辑私人草稿。','Verify your wallet to edit private drafts.');
 if(['loading','previewing','adopting'].includes(value.status))return value.status==='adopting'?L('正在保存…','Saving…'):value.requestId?L('正在核对原请求…','Checking the original request…'):L('处理中…','Working…');
 if(value.requestId)return L('保存结果待确认，请查询原请求。','Save outcome unconfirmed. Check the original request.');
 if(value.status==='preview')return L('已生成变更预览','Changes ready to review');
 if(value.status==='conflict')return L('云端版本已变化。输入仍保留，请重新预览。','The cloud version changed. Your edits are retained; preview again.');
 if(value.status==='ready'&&value.draft)return value.error==='PRIVATE_STORAGE_UNAVAILABLE'?L('草稿已保存，浏览器恢复信息未能更新。','Draft saved. Browser recovery information could not be updated.'):L('私人草稿已保存','Private draft saved');
 if(value.error==='PRIVATE_DRAFT_PREVIEW_EXPIRED')return L('研究已过期。已保存草稿仍可读取，新变更需要有效研究。','Research expired. Saved drafts remain readable; changes need current research.');
 if(value.error==='PRIVATE_STORAGE_UNAVAILABLE')return L('浏览器未能保留恢复信息，未发送新的保存请求。','Recovery information could not be stored. No new save request was sent.');
 return value.error?L('暂时无法确认，请保留输入并重试读取或预览。','Unable to confirm. Keep your edits and retry loading or previewing.'):'';
};

export function createPrivateDraftEditor({storage,fetchImpl,now=Date.now,clientFactory=createPrivateDraftClient,getConnections=()=>null,getDirectory=()=>[],onSaved=()=>{},onAuthenticate=()=>{},onReturn=()=>{}}={}){
 let host=null,mountedInput=null,blockedTarget=false,fields=null,baseline=null,sourceRequestId=null,incomingSource=null,draftId=null,symbol=null,owner=null,activeKey=null,epoch=0,error='',mobileView='settings',dirty=false,invalidEditing=false,disposeCharts=()=>{},suppress=false,disposed=false;
 const client=clientFactory({storage,fetchImpl,now,onChange:()=>{if(!suppress)paint();}});
 const current=()=>client.snapshot();
 const busy=value=>['loading','previewing','adopting'].includes(value.status)||Boolean(value.requestId);
 const capture=()=>{const form=host?.querySelector('form');if(form&&fields)try{fields=privateDraftFormInput(form,fields);invalidEditing=false;}catch(cause){invalidEditing=true;dirty=true;throw cause;}};
 const changed=()=>{dirty=JSON.stringify(fields)!==baseline;};
 const holdRender=()=>{const value=current();return Boolean(host?.isConnected&&dirty&&invalidEditing&&value.ownerRef&&!['auth-required','forbidden'].includes(value.status));};
 function restorePending(){const value=current();if(value.requestId&&value.localInput){draftId=value.localInput.draftId;sourceRequestId=value.localInput.sourceRequestId;fields=structuredClone(value.localInput.fields);symbol=fields.market.split('/')[0];dirty=false;}}
 function field(key,value,{prefix='',min=0,step='any',max='',unit=''}={}){return `<label class="sc-field">${label(key)}<span><input name="${prefix+key}" type="number" inputmode="decimal" step="${step}" min="${min}" ${max!==''?`max="${max}"`:''} value="${esc(value??'')}" placeholder="—">${unit?`<b>${esc(unit)}</b>`:''}</span></label>`;}
 function controls(value){
  if(!sourceRequestId||!['BTC','ETH','SOL'].includes(symbol))return `<p>${L('读取完整私人草稿后即可继续编辑。','Load a full private draft to continue editing.')}</p>`;
  const selected=fields?.strategy||'',pending=busy(value),options=getDirectory().filter(item=>validId(item.id)&&['S01','S02'].includes(item.strategyId));
  const target=incomingSource?`<label class="sc-field">${L('保存位置','Save to')}<select name="target" data-pd-change="target" ${pending?'disabled':''}><option value="${esc(incomingSource)}">${L('新建私人草稿','New private draft')}</option>${options.filter(item=>item.id!==incomingSource).map(item=>`<option value="${esc(item.id)}" ${item.id===draftId?'selected':''}>${esc(item.name)}</option>`).join('')}</select></label>`:'';
  if(blockedTarget)return target+`<p>${L('所选草稿的标的与当前研究不一致，请选择同标的草稿或新建。','This draft uses a different instrument. Choose a matching draft or create a new one.')}</p>`;
  const choose=`${target}<label class="sc-field">${L('策略模板','Strategy template')}<select name="template" data-pd-change="template" ${pending?'disabled':''}><option value="">${L('选择模板','Choose a template')}</option>${['S01','S02'].map(id=>`<option value="${id}" ${id===selected?'selected':''}>${template(id)}</option>`).join('')}</select></label>`;
  if(!fields)return choose+`<p>${L('报告提供研究依据；策略、资金与保护由你确认。','Use the report as evidence. Confirm the strategy, allocation and protection yourself.')}</p>`;
  const p=fields.botParameters||{},custom=fields.protection?.version==='astarter-research-v0.1/sim-3',protection=custom?'custom':fields.protection?.id==='original'?'original':fields.protection?.mode||'',connections=tradingConnections(getConnections()).filter(item=>item.kind==='exchange'&&item.service==='binance'&&item.market==='spot'&&item.accountId==='SIM-01');
  const existing=fields.executionRoute?.connectionId;if(existing&&!connections.some(item=>item.id===existing))connections.push({id:existing,label:L('已保存接入','Saved connection')});
  const params=parameterKeys(fields).map(key=>key==='spacing'?`<label class="sc-field">${label(key)}<select name="param_spacing"><option value="">${L('选择','Choose')}</option>${[['arithmetic','等差','Arithmetic'],['geometric','等比','Geometric']].map(([id,zh,en])=>`<option value="${id}" ${p.spacing===id?'selected':''}>${L(zh,en)}</option>`).join('')}</select></label>`:field(key,p[key],{prefix:'param_',min:['count','maxEntries'].includes(key)?key==='count'?2:1:key==='sizeMultiplier'?1:0,step:['count','maxEntries'].includes(key)?1:'any',unit:/Pct$/.test(key)?'%':['count','maxEntries','sizeMultiplier'].includes(key)?'':'USDT'})).join('');
  return choose+`<form data-pd-form novalidate><fieldset ${pending?'disabled':''}><label class="sc-field">${label('name')}<input name="name" maxlength="120" value="${esc(fields.name)}"></label><div class="bot-parameter-pair">${field('amount',fields.amount,{min:10,max:1000,unit:'USDT'})}${field('cap',fields.cap,{min:10,max:3000,unit:'USDT'})}</div><details class="bot-native-advanced" data-pd-section="parameters" open><summary>${L('策略参数','Strategy parameters')}</summary><div class="bot-native-fields pd-parameters">${params}</div></details><details class="bot-native-advanced" data-pd-section="protection"><summary>${L('资金保护与研究预算','Protection & research budget')}</summary><label class="sc-field">${label('protection')}<select name="protection"><option value="">${L('尚未选择','Not selected')}</option>${[['original','策略原有保护','Strategy protection'],['normal','Astarter · 标准','Astarter · Standard'],['conservative','Astarter · 保守','Astarter · Conservative'],...(custom?[['custom','Astarter · 自定义','Astarter · Custom']]:[])].map(([id,zh,en])=>`<option value="${id}" ${protection===id?'selected':''}>${L(zh,en)}</option>`).join('')}</select></label>${custom?`<div class="pd-risk">${Object.entries(fields.protection.parameters).map(([key,value])=>field(key,value*100,{prefix:'risk_',min:0,unit:'%'})).join('')}</div>`:''}${field('researchBudget',fields.researchBudget,{min:0,max:10000,step:1,unit:L('AI 积分','AI credits')})}<label class="sc-field">${label('executionRoute')}<select name="connection"><option value="">${L('稍后选择','Choose later')}</option>${connections.map(item=>`<option value="${esc(item.id)}" ${existing===item.id?'selected':''}>${esc(item.label)} · SIM-01</option>`).join('')}</select></label></details></fieldset></form>`;
 }
 function paint(){
  if(disposed||!host?.isConnected)return;
  if(holdRender()){const note=host.querySelector('.pd-footer [role="status"]');if(note&&error)note.textContent=error;return;}
  const sections=[...host.querySelectorAll('[data-pd-section]')],openSections=new Set(sections.filter(node=>node.open).map(node=>node.dataset.pdSection));
  const value=current(),focused=host.contains(host.ownerDocument.activeElement)?host.ownerDocument.activeElement:null,name=focused?.name,selection=[focused?.selectionStart,focused?.selectionEnd],scroll=host.querySelector('.bot-settings-scroll')?.scrollTop||0;
  const header=`<div class="sc-drawer-head"><div><h2>${esc(symbol||L('私人策略','Private strategy'))}</h2><span class="bot-editor-status">${L('私人草稿','Private draft')}${value.draft?' · v'+value.draft.revision:''}</span></div></div>`;
  const canEdit=value.ownerRef&&value.status!=='auth-required'&&value.status!=='forbidden';
  const content=canEdit?`<div class="pd-source">${sourceRequestId?L('研究来源','Research source'):L('读取已保存草稿','Loading saved draft')}${value.preview?' · '+esc(date(value.preview.proposal.source.createdAt)):''}</div>${controls(value)}${renderPrivateDraftDiff(value.preview)}`:`<p>${messages(value)}</p><button class="sc-button" type="button" data-pd="authenticate">${L('验证钱包','Verify wallet')}</button>`;
  const feedback=error||messages(value),footer=`<footer class="sc-drawer-footer pd-footer"><div role="status">${esc(feedback)}${value.requestId?`<details><summary>${L('原请求编号','Original request')}</summary><code>${esc(value.requestId)}</code></details>`:''}</div><div>${value.requestId?`<button class="sc-button sc-primary" type="button" data-pd="query" ${value.canQuery?'':'disabled'}>${L('查询原请求','Check original request')}</button>`:canEdit?`<button class="sc-button" type="button" data-pd="reload" ${value.canGet&&!dirty?'':'disabled'}>${L('重新读取','Reload draft')}</button><button class="sc-button" type="button" data-pd="discard" ${busy(value)?'disabled':''}>${L('撤回编辑','Revert edits')}</button><button class="sc-button ${value.preview?'':'sc-primary'}" type="button" data-pd="preview" ${fields&&value.canPreview?'':'disabled'}>${L('预览变更','Preview changes')}</button>${value.preview?`<button class="sc-button sc-primary" type="button" data-pd="adopt" ${value.canAdopt?'':'disabled'}>${L('确认保存草稿','Confirm & save draft')}</button>`:''}`:''}</div></footer>`;
  disposeCharts();host.innerHTML=botCreationFrame({content,market:fields?.market||(symbol?symbol+'/USDT':''),view:null,mobileView,strategyId:fields?.strategy||'',nativeBot:true,embedded:{header,footer,details:''}});if(sections.length)for(const node of host.querySelectorAll('[data-pd-section]'))node.open=openSections.has(node.dataset.pdSection);disposeCharts=mountCharts(host);refreshNumberInputs(host);
  const area=host.querySelector('.bot-settings-scroll');if(area)area.scrollTop=scroll;
  if(name){const control=host.querySelector(`[name="${name}"]`);control?.focus({preventScroll:true});try{if(selection[0]!==null)control.setSelectionRange(...selection);}catch{}}
 }
 async function load(target){
  const token=++epoch,scope=owner;draftId=target;error='';blockedTarget=false;
  if(current().requestId){restorePending();paint();return;}
   let result;try{result=await client.get(target);}catch{if(token===epoch&&scope===owner){error=L('草稿暂不可读，请返回来源重新打开。','Unable to read this draft. Reopen it from its source.');paint();}return;}if(disposed||token!==epoch||scope!==owner)return;
  if(result.status==='ready'){
   if(result.draft){if(incomingSource&&mountedInput?.symbol!==result.draft.content.source.symbol){blockedTarget=true;fields=null;sourceRequestId=incomingSource;symbol=mountedInput.symbol;}else{fields=structuredClone(result.draft.content.fields);sourceRequestId=incomingSource||result.draft.content.source.sourceRequestId;symbol=fields.market.split('/')[0];}}
   else if(incomingSource){fields=null;sourceRequestId=incomingSource;}
   else {fields=null;sourceRequestId=null;error=L('该目录项没有可读取的完整私人草稿。','This directory entry has no readable full private draft.');}
   baseline=JSON.stringify(fields);dirty=false;
  }
  paint();
 }
 async function action(kind){
  error='';try{
   if(kind==='authenticate'){onAuthenticate();return;}
   if(kind==='return'){onReturn();return;}
   if(kind==='reload'){if(!dirty)await load(draftId);return;}
   if(kind==='discard'){fields=baseline?JSON.parse(baseline):null;dirty=false;invalidEditing=false;client.invalidate();paint();return;}
   if(kind==='query'||kind==='adopt'){
    if(kind==='adopt'){capture();changed();const input=validatePrivateDraftPreviewInput({draftId,sourceRequestId,fields});if(JSON.stringify(input)!==JSON.stringify(current().localInput)){client.invalidate();error=L('输入已变化，请重新预览。','Your inputs changed. Preview them again.');paint();return;}}
    const token=epoch,scope=owner,result=await client[kind]();if(disposed||token!==epoch||scope!==owner)return;
    if(result.status==='ready'&&result.draft){fields=structuredClone(result.draft.content.fields);sourceRequestId=result.draft.content.source.sourceRequestId;baseline=JSON.stringify(fields);dirty=false;onSaved(result.draft);await load(result.draft.draftId);}
   }else if(kind==='preview'){
    capture();changed();const input=validatePrivateDraftPreviewInput({draftId,sourceRequestId,fields});await client.preview(input);
   }
  }catch{error=L('请核对金额、价格区间和风控参数。未确认的保存请查询原请求。','Review amounts, price bounds and protection. Check the original request for any unconfirmed save.');}
  paint();
 }
 function bindEvents(){
  const invalidateInput=()=>{dirty=true;suppress=true;client.invalidate();suppress=false;host.querySelector('.pd-diff')?.remove();const adopt=host.querySelector('[data-pd="adopt"]');if(adopt)adopt.disabled=true;};
  const inputStatus=()=>{const note=host.querySelector('.pd-footer [role="status"]');if(note)note.textContent=error||(dirty?L('有未保存编辑','Unsaved changes'):messages(current()));};
  host.onsubmit=event=>{event.preventDefault();if(!busy(current()))void action('preview');};
  host.onclick=event=>{const button=event.target.closest('[data-pd],[data-sc="mobile-view"]');if(!button||button.disabled)return;if(button.dataset.sc==='mobile-view'){capture();mobileView=button.dataset.id;paint();}else void action(button.dataset.pd);};
  host.oninput=event=>{if(!event.target.closest('form')||busy(current()))return;invalidateInput();try{capture();changed();error='';}catch{error=L('请输入有效数字。','Enter a valid number.');}inputStatus();};
  host.onchange=async event=>{
   if(busy(current()))return;
   try{capture();}catch{invalidateInput();error=L('请输入有效数字。','Enter a valid number.');inputStatus();return;}
   const kind=event.target.dataset.pdChange;
   // Keep native controls mounted while focus moves to the next field.
   if(!kind&&event.target.name!=='protection'){invalidateInput();changed();error='';inputStatus();return;}
   if(kind==='target'){if(dirty){error=L('请先保存或撤回编辑，再切换草稿。','Save or revert your edits before switching drafts.');paint();return;}client.invalidate();await load(event.target.value);return;}
   if(kind==='template'){
    const id=event.target.value;if(!['S01','S02'].includes(id)){fields=null;}else if(fields?.strategy!==id){fields=fields?{...fields,strategy:id,planVariant:id+'-SIM',botParameters:null}:emptyPrivateDraftFields(id,symbol);}
   }
   changed();client.invalidate();paint();
  };
 }
 return {
  client,holdRender,
  setIdentity(identity){const verified=identity?.authVersion===2&&identity.permissionProfile==='private-ui-v2'&&typeof identity.ownerRef==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(identity.ownerRef)&&Number.isSafeInteger(identity.expiresAt)&&identity.expiresAt>now()?{ownerRef:identity.ownerRef,expiresAt:identity.expiresAt}:null,next=verified?.ownerRef||null,changedOwner=next!==owner;if(changedOwner){epoch++;owner=next;fields=null;baseline=null;sourceRequestId=null;dirty=false;invalidEditing=false;error='';activeKey=null;}client.setIdentity(verified);restorePending();if(changedOwner&&host?.isConnected&&mountedInput&&current().canGet){draftId=mountedInput.draftId;incomingSource=mountedInput.sourceRequestId;sourceRequestId=incomingSource;symbol=mountedInput.symbol;void load(draftId);}paint();},
  refresh(){if(!host?.querySelector('form')?.contains(host.ownerDocument.activeElement))paint();},
  render(){return `<section class="sc-root pd-page" data-localized-ui><header class="sc-heading"><h1>${L('研究转策略','Research to strategy')}</h1><button type="button" class="sc-button" data-private-draft-return>${L('返回 AI 星谱','Back to LensWave')}</button></header><section class="pd-workspace" data-private-draft-editor></section></section>`;},
  mount(container,input){
   const next=container.querySelector('[data-private-draft-editor]');if(!next)return false;
   host=next;mountedInput=input;container.querySelector('[data-private-draft-return]').onclick=onReturn;bindEvents();
   if(!validId(input?.draftId)||input.sourceRequestId!==null&&!requestId(input.sourceRequestId)||input.sourceRequestId&&!['BTC','ETH','SOL'].includes(input.symbol)){error=L('草稿入口无效，请返回研究重新打开。','This draft link is invalid. Reopen it from research.');paint();return true;}
   const key=JSON.stringify([owner,input]);if(activeKey!==key){epoch++;if(!current().requestId)client.invalidate();activeKey=key;blockedTarget=false;draftId=input.draftId;incomingSource=input.sourceRequestId;sourceRequestId=input.sourceRequestId;symbol=input.symbol;fields=null;baseline=null;dirty=false;restorePending();if(!current().requestId&&current().canGet)void load(draftId);}
   paint();return true;
  },
  beforeLeave(){return host?.isConnected&&dirty&&!current().requestId?L('私人草稿尚有未保存编辑。请先保存或撤回编辑。','This private draft has unsaved edits. Save or revert them before leaving.'):null;},
  leave(){disposeCharts();host=null;mountedInput=null;},
  dispose(){disposed=true;epoch++;disposeCharts();host=null;fields=null;client.dispose();}
 };
}
