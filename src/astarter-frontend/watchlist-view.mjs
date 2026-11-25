import {L} from './execution-views.mjs';
import {TOKEN_IDS} from './brand-icon-data.mjs';
import {HUB_ASSET_IDS} from './market-hub-data.mjs';
import {captureProductFocus} from './product-composition.mjs';
import {openWatchPicker,loadWatchAssets,WATCH_ASSETS_KEY,watchAssetKey,isWatchAsset} from './market-watchlist.mjs';
import {WORKBENCH_TARGETS_KEY} from './workspace-sim.mjs';

// Only the explicit registry aliases symbols; CA assets always keep chain + address.
export function watchlistEntries(keys=[],assets=[],tasks=[]){
 const entries=new Map();
 for(const key of [...new Set(keys.filter(key=>typeof key==='string'))]){
  const found=assets.find(asset=>isWatchAsset(asset,[key]));
  const coin=key.startsWith('coin:')?key.slice(5):null,canonical=coin&&TOKEN_IDS[coin]||key;
  const identity=found?.address?watchAssetKey(found):canonical;
  if(entries.has(identity)){entries.get(identity).keys.push(key);continue;}
  const task=tasks.find(task=>task.symbol===identity),id=found?.id||coin||Object.keys(TOKEN_IDS).find(id=>TOKEN_IDS[id]===identity);
  const symbol=found?.symbol||task?.symbol||coin&&TOKEN_IDS[coin]||(!key.includes(':')?key:'');
  const asset=found||{id:id||key,symbol,name:task?.name||coin||key,price:null,series:[]};
  entries.set(identity,{key:identity,keys:[key],asset,task:task||null,known:Boolean(found||task||TOKEN_IDS[id])});
 }
 return [...entries.values()];
}

export function createWatchlist({workspace:w,research,go,refresh,notify}){
 let dialog=null,metadata=loadWatchAssets(w.storage),unsubscribe=()=>{},navigating=false;
 const readList=key=>{try{const value=JSON.parse(w.storage?.getItem(key)||'[]');return Array.isArray(value)?value.filter(key=>typeof key==='string'):[];}catch{return [];}};
 const keys=()=>w.account||w.privateUIOwner?.()?w.s.aiSignalWatch:[...new Set([...w.s.aiSignalWatch,...readList('hive.dc.assets')])];
 const entries=()=>watchlistEntries(keys(),metadata,research.tasks);
 const canonical=key=>key.startsWith('coin:')?TOKEN_IDS[key.slice(5)]||key:key;
 const assetKey=asset=>{
  const task=research.task(asset.symbol);
  return !asset.address&&task&&[task.symbol,HUB_ASSET_IDS[task.symbol]].includes(asset.id)?task.symbol:
   !asset.address&&HUB_ASSET_IDS[asset.symbol]===asset.id?asset.symbol:watchAssetKey(asset);
 };
 const asAsset=entry=>({...entry.asset,watchKeys:entry.keys,researchSymbol:entry.task?.symbol,unknown:!entry.known});
 const favorites=()=>entries().map(asAsset);
 const assets=()=>[...new Map([
  ...research.tasks.map(task=>({id:HUB_ASSET_IDS[task.symbol]||task.symbol,symbol:task.symbol,name:task.name,price:null,series:[],researchSymbol:task.symbol})),
  ...metadata.map(asset=>({...asset,researchSymbol:research.task(canonical(assetKey(asset)))?.symbol})),
  ...favorites(),
 ].map(asset=>[asset.id,asset])).values()];
 const isSaved=asset=>entries().some(entry=>entry.key===canonical(assetKey(asset))||entry.keys.some(key=>asset.watchKeys?.includes(key)));
 async function save(asset,remove){
  const before=keys(),key=assetKey(asset),entry=entries().find(entry=>entry.key===canonical(key)||entry.keys.some(key=>asset.watchKeys?.includes(key)));
  const removed=entry?.keys||[key],next=remove?before.filter(key=>!removed.includes(key)):[...new Set([...before,key])];
  const {watchKeys,researchSymbol,unknown,...record}=asset;
  const native=research.task(asset.symbol)&&asset.id===asset.symbol&&!asset.address;
  const rows=remove?metadata.filter(row=>row.id!==asset.id):native?metadata:[...new Map([...metadata,record].map(row=>[row.id,row])).values()];
  if(rows.length>200)throw new Error('WATCHLIST_FULL');
  try{
   const privateOwner=w.privateUIOwner?.();
   if(privateOwner){
    const issue=w.applyPrivateUIPreferences(privateOwner,{workbenchFilter:w.s.workbenchFilter,workbenchFocusAsset:w.s.workbenchFocusAsset,watchedAssets:next});
    if(issue)throw Error(issue);metadata=rows;document.dispatchEvent(new CustomEvent('hive:watchlist-change'));return;
   }else if(w.account){
    if(remove){for(const key of removed)await w.account.resource('asset',key,true);}
    else if(!isSaved(asset))await w.account.resource('asset',key,false);
    metadata=rows;
    try{w.storage?.setItem(WATCH_ASSETS_KEY,JSON.stringify(rows));w.storage?.setItem('hive.dc.assets',JSON.stringify(next));}
    catch{notify(L('收藏已保存，本机资料缓存未能更新','Watchlist saved; local asset details could not be cached'));}
   }else{
    const storage=w.storage;if(!storage)throw new Error('STORAGE_FAILED');
    const names=[WORKBENCH_TARGETS_KEY,'hive.dc.assets',WATCH_ASSETS_KEY],previous=names.map(name=>storage.getItem(name));
    let targets={};try{targets=JSON.parse(previous[0]||'{}')||{};}catch{}
    try{
     const values=[JSON.stringify({...targets,watched:next}),JSON.stringify(next),JSON.stringify(rows)];
     names.forEach((name,index)=>{storage.setItem(name,values[index]);if(storage.getItem(name)!==values[index])throw new Error('STORAGE_FAILED');});
    }catch(error){names.forEach((name,index)=>{try{if(previous[index]===null)storage.removeItem(name);else storage.setItem(name,previous[index]);}catch{}});throw error;}
    metadata=rows;w.workbenchPersistenceError='';
   }
   w.touch();document.dispatchEvent(new CustomEvent('hive:watchlist-change'));
  }catch(error){throw Object.assign(new Error(error.message==='STORAGE_FAILED'?L('未能保存，请检查浏览器存储后重试','Could not save. Check browser storage and retry.'):error.message),{name:'WatchlistSaveError'});}
 }
 function open(){
  if(dialog?.open){dialog.querySelector('input')?.focus();return dialog;}
  metadata=loadWatchAssets(w.storage);navigating=false;const restore=captureProductFocus(document.body);
  dialog=openWatchPicker({assets,isSaved,savedAssets:favorites,onAdd:asset=>save(asset,false),onRemove:asset=>save(asset,true),onOpenAsset:asset=>{
   const task=research.task(canonical(assetKey(asset)));
   navigating=true;dialog.close();
   if(task&&research.accepts(task)){go('workbench');document.body.dataset.mobileView='network';document.dispatchEvent(new CustomEvent('hive:workbench-focus',{detail:task.symbol}));}
   else go('markets',{search:'?'+new URLSearchParams({page:'markets',asset:asset.symbol,coin:asset.id})});
  },onClose:()=>{unsubscribe();unsubscribe=()=>{};dialog=null;if(!navigating){refresh();restore();}navigating=false;}});
  unsubscribe=w.account?.subscribe(()=>dialog?.refresh())||(()=>{});
  return dialog;
 }
 function sync(){metadata=loadWatchAssets(w.storage);dialog?.refresh();}
 if(typeof document!=='undefined')document.addEventListener('hive:watchlist-change',sync);
 if(typeof window!=='undefined')window.addEventListener('storage',event=>{if([WATCH_ASSETS_KEY,WORKBENCH_TARGETS_KEY,'hive.dc.assets'].some(key=>event.key===key||event.key?.startsWith(key+':')))sync();});
 return {open,save,close(){if(dialog?.open){navigating=true;dialog.close();}},render:()=>'',bind(){}};
}
