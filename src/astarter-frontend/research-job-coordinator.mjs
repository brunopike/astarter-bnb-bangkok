import {createResearchJobClient,renderResearchJob} from './research-job-client.mjs';
import {ASSETS} from './product-data.mjs';
import {pair as L} from './locale.mjs';

const symbols=new Set(ASSETS.map(([symbol])=>symbol));
const sameAsset=(snapshot,symbol)=>snapshot.symbols.length===1&&snapshot.symbols[0]===symbol;

// Identity only partitions browser metadata. Cookies authenticate every service request.
export function createResearchJobCoordinator({storage,fetchImpl,now=Date.now,timeoutMs=15000,onChange=()=>{}}={}){
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{storage=null;}
 const entries=new Map(),painted=new WeakMap();
 let owner=null,expiresAt=null,timer=null,changing=false,destroyed=false,identityVersion=0,root=null,unbind=()=>{},walletReturn=null;
 function cancelWalletReturn(){if(walletReturn)delete walletReturn.dialog.dataset.walletSuspended;walletReturn=null;}
 function expire(){if(owner&&expiresAt<=now())setIdentity(null);}
 function entry(symbol){
  if(!symbols.has(symbol)||destroyed)return null;
  if(!entries.has(symbol)){
   const prefix='astarter.research-asset.v1:'+symbol+':';
   const scoped=storage?{getItem:key=>storage.getItem(prefix+key),setItem:(key,value)=>storage.setItem(prefix+key,value)}:null;
   const client=createResearchJobClient({storage:scoped,fetchImpl,ownerRef:owner,symbols:[symbol],now,timeoutMs,onChange:()=>emit(symbol)});
   entries.set(symbol,{client,active:false,version:0,authenticationFailed:false,expiryTimer:null});
  }
  return entries.get(symbol);
 }
 function snapshot(symbol){
  expire();const e=entry(symbol);if(!e)return null;
  const value=e.client.snapshot();
  if(value.ownerRef!==owner||!sameAsset(value,symbol))return {...value,symbols:[symbol],result:null,status:owner?'service-unavailable':'auth-required',error:'RESEARCH_SELECTION_INVALID',canStart:false,canQuery:false};
  return value;
 }
 function jobMarkup(symbol,value){return renderResearchJob(value)+(value.status==='complete'&&['BTC','ETH','SOL'].includes(symbol)?`<button class="p-button" type="button" data-research-job-action="draft">${L('创建策略草稿','Create strategy draft')}</button>`:'')+(entries.get(symbol)?.authenticationFailed?`<p role="status">${L('登录服务暂不可用，请稍后重试。','Sign-in is unavailable. Try again shortly.')}</p>`:'');}
 function render(symbol){const value=snapshot(symbol);return value?`<div class="live-research-job" data-live-research="${symbol}">${jobMarkup(symbol,value)}</div>`:'';}
 function paint(symbol){
  if(!root)return;
  const value=snapshot(symbol),signature=JSON.stringify([value,entries.get(symbol)?.authenticationFailed]);
  for(const slot of root.querySelectorAll('[data-live-research]')){
   if(slot.dataset.liveResearch!==symbol||painted.get(slot)===signature)continue;
   const focused=slot.contains(slot.ownerDocument.activeElement)?slot.ownerDocument.activeElement?.dataset.researchJobAction:null;
   const open=Boolean(slot.querySelector('details[open]'));
   slot.innerHTML=jobMarkup(symbol,value);painted.set(slot,signature);
   if(open&&slot.querySelector('details'))slot.querySelector('details').open=true;
   if(focused)slot.querySelector(`[data-research-job-action="${focused}"]`)?.focus({preventScroll:true});
  }
 }
 function emit(symbol){
  if(changing||destroyed)return;
  const value=snapshot(symbol),e=entries.get(symbol);clearTimeout(e.expiryTimer);e.expiryTimer=null;
  if(value.status==='complete'&&Number.isSafeInteger(value.result?.validUntil)){
   const identity=identityVersion,id=value.requestId;
   // Expiry must reach a paused workbench without polling or another request.
   e.expiryTimer=setTimeout(()=>{if(!destroyed&&identity===identityVersion&&e.client.snapshot().requestId===id)emit(symbol);},Math.max(0,Math.min(value.result.validUntil-now(),2147483647)));
  }
  paint(symbol);onChange(symbol,value);
 }
 function setIdentity(identity){
  if(destroyed)return;
  clearTimeout(timer);
  const valid=typeof identity?.ownerRef==='string'&&/^[A-Za-z0-9:_@.\-]{1,256}$/.test(identity.ownerRef)&&Number.isSafeInteger(identity.expiresAt)&&identity.expiresAt>now();
  const next=valid?identity.ownerRef:null,changed=next!==owner;
  if(changed)identityVersion++;
  owner=next;expiresAt=valid?identity.expiresAt:null;changing=true;
  for(const [symbol,e]of entries){
   clearTimeout(e.expiryTimer);e.expiryTimer=null;
   e.authenticationFailed=false;
   e.client.setOwner(owner);
   if(!e.client.snapshot().requestId)e.client.select([symbol]);
  }
  changing=false;
  if(valid)timer=setTimeout(()=>setIdentity({ownerRef:owner,expiresAt}),Math.min(expiresAt-now(),2147483647));
  for(const [symbol,e]of entries){emit(symbol);if(changed&&e.active&&owner)void e.client.resume();}
 }
 async function open(symbol){
  if(walletReturn&&walletReturn.symbol!==symbol)cancelWalletReturn();
  expire();const e=entry(symbol);if(!e)return null;
  if(!sameAsset(e.client.snapshot(),symbol))return snapshot(symbol);
  if(!e.active){e.active=true;await e.client.resume();}
  return snapshot(symbol);
 }
 async function start(symbol){
  expire();const e=entry(symbol);if(!e)return null;
  const identity=identityVersion,version=e.version;
  await open(symbol);
  if(identity!==identityVersion||version!==e.version||!e.active)return {...snapshot(symbol),status:'cancel-view',result:null,canStart:false,canQuery:false};
  const value=snapshot(symbol);if(!value?.canStart)return value;
  await entry(symbol).client.start([symbol]);return snapshot(symbol);
 }
 async function query(symbol){
  expire();const e=entry(symbol);if(!e)return null;
  if(!e.active)return open(symbol);
  if(!sameAsset(e.client.snapshot(),symbol))return snapshot(symbol);
  await e.client.query();return snapshot(symbol);
 }
 async function retry(symbol){
  expire();const e=entry(symbol);if(!e?.active||!snapshot(symbol)?.canRetryOriginal)return snapshot(symbol);
  await e.client.retryOriginal();return snapshot(symbol);
 }
 function leave(symbol){
  if(walletReturn&&(!symbol||walletReturn.symbol===symbol))cancelWalletReturn();
  const targets=symbol?[entries.get(symbol)].filter(Boolean):[...entries.values()];
  for(const e of targets){e.active=false;e.version++;e.client.leave();}
 }
 async function request(symbol){
  const value=await start(symbol);
  return ['processing','complete'].includes(value?.status)?null:value?.status==='auth-required'?L('请先验证钱包身份，再开始研究。','Verify your wallet identity before starting research.'):value?.status==='unknown'?L('原研究结果待确认，请查询原请求。','Check the original research request before continuing.'):L('研究服务暂不可用，请查看原请求状态。','Research is unavailable. Check the original request status.');
 }
 function bind(element,{authenticate=()=>{},keepActive=()=>false,onDraft=()=>{}}={}){
  unbind();root=element;
  const view=element.defaultView||element.ownerDocument?.defaultView;
  const finishWallet=event=>{
   if(root.querySelector?.('[data-rk] [role="dialog"][aria-modal="true"]'))return;
   const saved=walletReturn;cancelWalletReturn();
   if(!saved||destroyed||!saved.dialog.isConnected||saved.dialog.open||saved.href!==view?.location.href||entries.get(saved.symbol)?.version!==saved.version||root.querySelector?.('dialog:modal')||!saved.dialog.querySelector(`[data-live-research="${saved.symbol}"]`))return;
   entries.get(saved.symbol).authenticationFailed=event?.detail?.error==='service';
   saved.dialog.showModal();void open(saved.symbol);paint(saved.symbol);
   saved.dialog.querySelector('[data-research-job-action]')?.focus({preventScroll:true});
  };
  const click=event=>{
   const button=event.target.closest?.('[data-research-job-action]'),slot=button?.closest('[data-live-research]');
   if(!slot||!root.contains(slot))return;
   const symbol=slot.dataset.liveResearch,action=button.dataset.researchJobAction;
   if(action==='authenticate'){
    const dialog=slot.closest('dialog');
    if(entries.has(symbol))entries.get(symbol).authenticationFailed=false;
    if(dialog?.open){
     leave(symbol);walletReturn={dialog,symbol,version:entries.get(symbol)?.version,href:view?.location.href};
     // A native modal makes the wallet portal inert, regardless of its z-index.
     dialog.dataset.walletSuspended='true';dialog.close();
    }
    try{authenticate();}catch(error){finishWallet();throw error;}
   }
   else if(action==='start')void start(symbol);
   else if(action==='query')void query(symbol);
   else if(action==='retry')void retry(symbol);
   else if(action==='draft'){
    const value=snapshot(symbol);if(value?.status!=='complete'||!['BTC','ETH','SOL'].includes(symbol)||!value.requestId)return;
    const input={draftId:value.requestId,sourceRequestId:value.requestId,symbol};
    const dialog=slot.closest('dialog');if(dialog?.open)dialog.close();onDraft(input);
   }
  };
  // Closing details can leave the same request visible on the main workbench.
  const close=event=>{if(event.target?.tagName==='DIALOG'&&!event.target.open&&event.target!==walletReturn?.dialog)for(const slot of event.target.querySelectorAll('[data-live-research]'))if(keepActive(slot.dataset.liveResearch)!==true)leave(slot.dataset.liveResearch);};
  const locale=()=>{for(const slot of root.querySelectorAll('[data-live-research]'))painted.delete(slot);for(const symbol of entries.keys())paint(symbol);};
  root.addEventListener('click',click);root.addEventListener('close',close,true);
  root.addEventListener('hive:locale',locale);
  view?.addEventListener('astarter:wallet-flow-end',finishWallet);view?.addEventListener('popstate',cancelWalletReturn);
  unbind=()=>{cancelWalletReturn();element.removeEventListener('click',click);element.removeEventListener('close',close,true);element.removeEventListener('hive:locale',locale);view?.removeEventListener('astarter:wallet-flow-end',finishWallet);view?.removeEventListener('popstate',cancelWalletReturn);};
 }
 function resumeVisible(){
  for(const slot of root?.querySelectorAll('[data-live-research]')||[]){
   const dialog=slot.closest('dialog');if(dialog?dialog.open:slot.offsetParent!==null)void open(slot.dataset.liveResearch);
  }
 }
 return {snapshot,render,open,start,query,retry,request,setIdentity,leave,bind,resumeVisible,
  destroy(){if(destroyed)return;destroyed=true;clearTimeout(timer);unbind();root=null;for(const e of entries.values()){clearTimeout(e.expiryTimer);e.client.destroy();}}
 };
}
