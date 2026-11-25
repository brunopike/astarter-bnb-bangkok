import {TOKEN_IDS} from './brand-icon-data.mjs';
import {normalizeHubResource} from './market-hub-data.mjs';
import {tokenIcon,approvedTokenImageURL,registerTokenMetadata} from './brand-icons.mjs';
import {uiGlyph} from './product-composition.mjs';
import {L} from './execution-views.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CG='https://api.coingecko.com/api/v3',DEX='https://api.dexscreener.com';
export const WATCH_ASSETS_KEY='hive.market.watch-assets.v1';
const validId=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9._-]{0,149}$/.test(id);
const addressKey=address=>/^0x/i.test(address)?address.toLowerCase():address;
const validAddress=address=>typeof address==='string'&&(/^(?:0x[\da-f]{40}|0x[\da-f]{64})$/i.test(address)||/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address));
export function sameWatchAssetKey(a,b){
 const valid=key=>{
  if(typeof key!=='string')return false;
  if(key.startsWith('coin:'))return validId(key.slice(5));
  if(key.startsWith('ca:')){const parts=key.split(':');return parts.length===3&&validId(parts[1])&&validAddress(parts[2]);}
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(key);
 };
 if(!valid(a)||!valid(b))return false;
 const canonical=key=>key.startsWith('coin:')?TOKEN_IDS[key.slice(5)]||key:key;
 return canonical(a)===canonical(b);
}
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
export function parseWatchQuery(value){
 const query=String(value??'').trim();
 if(!query||query.length>100||/[\u0000-\u001f]/.test(query))throw new Error('INVALID_QUERY');
 if(/^0x/i.test(query)&&!validAddress(query))throw new Error('INVALID_ADDRESS');
 return {query,isAddress:validAddress(query)};
}
export function watchAssetKey(asset){return asset.chain&&asset.address?'ca:'+asset.chain+':'+addressKey(asset.address):'coin:'+asset.id;}
export const isWatchAsset=(asset,keys)=>keys.includes(watchAssetKey(asset))||(!asset.address&&TOKEN_IDS[asset.id]===asset.symbol&&keys.includes(asset.symbol));
export const watchChain=chain=>({ethereum:'Ethereum',bsc:'BNB Chain',solana:'Solana',base:'Base',arbitrum:'Arbitrum',polygon:'Polygon',optimism:'Optimism',avalanche:'Avalanche',sui:'Sui',ton:'TON'})[chain]||chain;
export function normalizeDexAssets(body,query='',receivedAt=Date.now()){
 const pairs=Array.isArray(body)?body:body?.pairs;if(!Array.isArray(pairs)||pairs.length>3000)throw new Error('INVALID_DATA');
 const byIdentity=new Map();
 for(const pair of pairs){
  const token=pair?.baseToken,chain=pair?.chainId,price=finite(pair?.priceUsd);
  if(!token||!validAddress(token.address)||!validId(chain)||typeof token.symbol!=='string'||!token.symbol.trim()||token.symbol.length>30||typeof token.name!=='string'||token.name.length>120||price===null||price<=0)continue;
  if(query&&addressKey(token.address)!==addressKey(query))continue;
  const row={id:'ca:'+chain+':'+addressKey(token.address),chain,address:token.address,symbol:token.symbol.toUpperCase(),name:token.name,price,cap:finite(pair.marketCap),volume:finite(pair.volume?.h24),change:finite(pair.priceChange?.h24),change7d:null,rank:null,high:null,low:null,image:approvedTokenImageURL(pair.info?.imageUrl),asOf:null,receivedAt,series:[],provider:'DEX Screener',liquidity:finite(pair.liquidity?.usd),venue:typeof pair.dexId==='string'?pair.dexId.slice(0,50):''};
  const old=byIdentity.get(row.id);if(!old||(row.liquidity??0)>(old.liquidity??0))byIdentity.set(row.id,row);
 }
 return [...byIdentity.values()].sort((a,b)=>(b.liquidity??0)-(a.liquidity??0));
}
async function request(url,{signal,fetchImpl=globalThis.fetch}={}){
 const browser=typeof window!=='undefined';
 let target=url,relay=false;
 if(browser&&url.startsWith(CG)){const upstream=new URL(url);target=upstream.pathname.endsWith('/search')?'/api/market-hub?resource=search&query='+encodeURIComponent(upstream.searchParams.get('query')):'/api/market-hub?resource=watch-assets&ids='+encodeURIComponent(upstream.searchParams.get('ids'));relay=true;}
 const response=await fetchImpl(target,{credentials:'omit',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
 if(!response.ok)throw new Error(response.status===429?'RATE_LIMIT':'FETCH_FAILED');
 const text=await response.text();if(text.length>2001000)throw new Error('INVALID_DATA');const result=JSON.parse(text);if(relay){if(result?.schema!=='public-market-relay-v1'||!['search','watch-assets'].includes(result.resource))throw new Error('INVALID_DATA');return result.body;}return result;
}
export async function searchWatchAssets(value,{signal,fetchImpl,local=[]}={}){
 const {query,isAddress}=parseWatchQuery(value),term=query.toLowerCase();
 if(isAddress)return {rows:normalizeDexAssets(await request(DEX+'/latest/dex/search?q='+encodeURIComponent(query),{signal,fetchImpl}),query),partial:false};
 const matched=local.filter(a=>[a.name,a.symbol,a.id].some(v=>String(v).toLowerCase().includes(term)));
 let body;try{body=await request(CG+'/search?query='+encodeURIComponent(query),{signal,fetchImpl});}catch(error){if(signal?.aborted||!matched.length)throw error;return {rows:matched,partial:true};}
 if(!Array.isArray(body?.coins))throw new Error('INVALID_DATA');
 const rows=body.coins.slice(0,40).filter(a=>validId(a.id)&&typeof a.name==='string'&&a.name.length<=120&&typeof a.symbol==='string'&&a.symbol.length<=30).map(a=>local.find(row=>row.id===a.id)||{id:a.id,symbol:a.symbol.toUpperCase(),name:a.name,image:approvedTokenImageURL(a.large||a.thumb),rank:a.market_cap_rank,price:null,cap:null,volume:null,change:null,change7d:null,series:[],asOf:null,provider:'CoinGecko'});
 return {rows:[...new Map([...matched,...rows].map(a=>[a.id,a])).values()],partial:false};
}
export async function fetchWatchAssets(rows,options={}){
 const tasks=[],coins=rows.filter(a=>!a.address),chains=new Map();
 for(let i=0;i<coins.length;i+=100)tasks.push(request(CG+'/coins/markets?vs_currency=usd&ids='+encodeURIComponent(coins.slice(i,i+100).map(a=>a.id).join(','))+'&per_page=100&sparkline=true&price_change_percentage=24h,7d',options).then(body=>normalizeHubResource('assets',body).data));
 for(const a of rows.filter(a=>a.address)){if(!chains.has(a.chain))chains.set(a.chain,[]);chains.get(a.chain).push(a.address);}
 for(const [chain,addresses]of chains)for(let i=0;i<addresses.length;i+=30)tasks.push(request(DEX+'/tokens/v1/'+encodeURIComponent(chain)+'/'+addresses.slice(i,i+30).map(encodeURIComponent).join(','),options).then(body=>normalizeDexAssets(body)));
 const results=await Promise.allSettled(tasks),updated=new Map(results.flatMap(r=>r.status==='fulfilled'?r.value:[]).map(a=>[a.id,a]));
 if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
 return {rows:rows.map(a=>updated.get(a.id)||a),failed:rows.filter(a=>!updated.has(a.id)).length};
}
export function loadWatchAssets(storage=globalThis.localStorage){
 try{const parsed=JSON.parse(storage?.getItem(WATCH_ASSETS_KEY)||'[]');if(!Array.isArray(parsed))return [];return parsed.slice(0,200).filter(a=>a&&typeof a.symbol==='string'&&a.symbol.length<=30&&typeof a.name==='string'&&a.name.length<=120&&Array.isArray(a.series)&&(a.address?validId(a.chain)&&validAddress(a.address)&&a.id==='ca:'+a.chain+':'+addressKey(a.address):validId(a.id))).map(a=>({...a,image:approvedTokenImageURL(a.image),series:a.series.filter(n=>Number.isFinite(n)&&n>0).slice(-168),price:finite(a.price),cap:finite(a.cap),volume:finite(a.volume),change:finite(a.change),change7d:finite(a.change7d),asOf:finite(a.asOf),receivedAt:finite(a.receivedAt)}));}catch{return [];}
}
export function watchAssetIcon(a,size=28){return tokenIcon({symbol:a.symbol,asset_id:a.id,chain_id:a.chain,address:a.address,image_url:a.image},{size});}
const errorCopy=error=>({INVALID_QUERY:L('输入币名、代码或合约地址','Enter a name, symbol or contract address'),INVALID_ADDRESS:L('合约地址不完整，请检查后重试','Check the full contract address and try again'),RATE_LIMIT:L('查询较多，请稍后重试','Too many requests. Try again shortly.'),WATCHLIST_FULL:L('自选最多保存 200 个，请先移除一些','Watchlist is full (200). Remove an asset first.'),STORAGE_FAILED:L('未能保存，请检查浏览器存储后重试','Could not save. Check browser storage and retry.')}[error?.message]||L('查询失败，请重试','Could not load results. Try again.'));
export function openWatchPicker({assets,isSaved,onAdd,onRemove,savedAssets,onOpenAsset,onClose=()=>{}}){
 const collection=typeof savedAssets==='function';
 const dialog=document.createElement('dialog');dialog.className='product-dialog hub-watch-dialog';dialog.setAttribute('aria-labelledby','hub-watch-title');
 dialog.innerHTML=`<header class="p-dialog-head"><h2 id="hub-watch-title">${collection?L('标的收藏','Watchlist'):L('添加自选','Add to watchlist')}</h2><button class="p-dialog-close" type="button" aria-label="${L('关闭','Close')}">${uiGlyph('close')}</button></header><div class="p-dialog-body"><form class="hub-watch-form"><label class="hub-watch-query">${uiGlyph('search')}<input autofocus type="search" maxlength="100" autocomplete="off" spellcheck="false" aria-label="${L('搜索名称、代码或 CA','Search name, symbol or CA')}" placeholder="${L('搜索名称、代码或粘贴 CA','Search name, symbol or paste CA')}"></label><button type="submit" class="p-button p-primary">${L('搜索','Search')}</button></form>${collection?`<div class="hub-watch-tabs"><button type="button" data-watch-tab="saved" aria-pressed="true">${L('我的追踪','My watchlist')}</button><button type="button" data-watch-tab="browse" aria-pressed="false">${L('添加标的','Add assets')}</button></div>`:''}<p class="hub-watch-feedback" role="status"></p><div class="hub-watch-results"></div></div>`;
 document.body.append(dialog);let queryController=null,sequence=0,adding=false,currentRows=[],showingSaved=collection;
 const input=dialog.querySelector('input'),list=dialog.querySelector('.hub-watch-results'),feedback=dialog.querySelector('[role=status]'),submit=dialog.querySelector('[type=submit]');
 function showRows(rows){
  currentRows=rows;for(const tab of dialog.querySelectorAll('[data-watch-tab]'))tab.setAttribute('aria-pressed',String((tab.dataset.watchTab==='saved')===showingSaved));
  registerTokenMetadata(rows.map(a=>({asset_id:a.id,symbol:a.symbol,chain_id:a.chain,address:a.address,image_url:a.image})));
  list.innerHTML=rows.length?rows.map((a,i)=>{
   const saved=isSaved(a),name=esc(a.symbol||L('未识别标的','Unidentified asset'));
   return `<article class="hub-watch-result">${a.researchSymbol?tokenIcon(a.researchSymbol,{size:32}):watchAssetIcon(a,32)}<div>${onOpenAsset&&!a.unknown?`<button type="button" class="hub-watch-open" data-open="${i}">${name}</button>`:`<b>${name}</b>`}<small>${esc(a.name||a.id)}${a.address?' · '+esc(watchChain(a.chain)):''}</small></div><button type="button" class="dc-button hub-watch-save" data-add="${i}" aria-pressed="${saved}" aria-label="${name} · ${saved?L('移除追踪','Remove from watchlist'):L('添加追踪','Add to watchlist')}" ${saved&&!onRemove?'disabled':''}>${saved?uiGlyph('star'):uiGlyph('plus')}<span>${saved?L('已追踪','Watching'):L('追踪','Watch')}</span></button>${a.address?`<code>${esc(a.address)}</code>`:''}</article>`;
  }).join(''):`<div class="hub-watch-empty"><p>${showingSaved?L('还没有追踪的标的','Your watchlist is empty'):L('没有匹配的标的','No matching assets')}</p>${showingSaved?`<button type="button" class="p-button" data-browse>${L('添加研究标的','Add research assets')}</button>`:''}</div>`;
  list.querySelector('[data-browse]')?.addEventListener('click',()=>{showingSaved=false;showRows(assets().slice(0,12));feedback.textContent=L('选择要添加的资产','Choose an asset to add');input.focus({preventScroll:true});});
  for(const button of list.querySelectorAll('[data-open]'))button.onclick=()=>onOpenAsset(rows[Number(button.dataset.open)]);
  for(const button of list.querySelectorAll('[data-add]'))button.onclick=async()=>{
   if(adding)return;
   const row=rows[Number(button.dataset.add)],remove=isSaved(row);if(remove&&!onRemove)return;
   adding=true;button.disabled=true;button.setAttribute('aria-busy','true');
   try{
    // A favorite needs its validated asset identity; a missing quote remains unavailable.
    await (remove?onRemove(row):onAdd(row));
    if(!dialog.open)return;
    feedback.textContent=(row.symbol||row.name)+' '+(remove?L('已取消追踪','Removed from watchlist'):L('已加入自选','added to watchlist'));
    const next=showingSaved?savedAssets():currentRows;showRows(next);
    const target=list.querySelector(`[data-add="${Math.min(Number(button.dataset.add),next.length-1)}"]`);
    (target||input).focus({preventScroll:true});
   }catch(error){
    if(dialog.open){button.disabled=false;feedback.textContent=error.name==='WatchlistSaveError'?error.message:errorCopy(error);}
   }finally{adding=false;button.removeAttribute('aria-busy');}
  };
 }
 function showDefault(){showingSaved=collection;showRows(collection?savedAssets():assets().slice(0,8));feedback.textContent=collection?'':L('热门资产','Popular assets');}
 showDefault();
 for(const tab of dialog.querySelectorAll('[data-watch-tab]'))tab.onclick=()=>{queryController?.abort();sequence++;submit.disabled=false;submit.removeAttribute('aria-busy');input.value='';showingSaved=tab.dataset.watchTab==='saved';showRows(showingSaved?savedAssets():assets().slice(0,12));feedback.textContent='';};
 dialog.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(adding)return;
  queryController?.abort();queryController=new AbortController();const own=++sequence;
  if(!input.value.trim()){showingSaved=false;showRows(assets().slice(0,12));feedback.textContent=L('选择要添加的资产','Choose an asset to add');return;}
  try{
   parseWatchQuery(input.value);submit.disabled=true;submit.setAttribute('aria-busy','true');feedback.textContent=L('正在查询…','Searching…');list.innerHTML='';showingSaved=false;
   const result=await searchWatchAssets(input.value,{signal:queryController.signal,local:assets()});
   if(own!==sequence||!dialog.open)return;showRows(result.rows);feedback.textContent=result.partial?L('外部搜索暂不可用，显示已加载资产','External search unavailable. Showing loaded assets.'):result.rows.length?'':L('没有找到，可换个名称或粘贴完整 CA','No matches. Try another name or paste the full CA.');
  }catch(error){if(error.name!=='AbortError'&&own===sequence&&dialog.open)feedback.textContent=errorCopy(error);}
  finally{if(own===sequence){submit.disabled=false;submit.removeAttribute('aria-busy');}}
 };
 input.oninput=()=>{
  queryController?.abort();sequence++;submit.disabled=false;submit.removeAttribute('aria-busy');
  if(adding)return;
  if(!input.value.trim()){showDefault();return;}
  const term=input.value.trim().toLowerCase();showingSaved=false;
  showRows(assets().filter(asset=>[asset.symbol,asset.name,asset.address,asset.id].some(value=>String(value||'').toLowerCase().includes(term))));
  feedback.textContent=L('按回车搜索','Press Enter to search');
 };
 dialog.refresh=()=>{if(dialog.open&&!adding&&showingSaved){const next=savedAssets(),identity=rows=>JSON.stringify(rows.map(row=>[row.id,row.name,row.watchKeys]));if(identity(next)===identity(currentRows))return;const focused=list.querySelector('[data-add]:focus')?.dataset.add;showRows(next);if(focused)list.querySelector(`[data-add="${focused}"]`)?.focus({preventScroll:true});}};
 dialog.querySelector('.p-dialog-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{sequence++;queryController?.abort();dialog.remove();onClose();},{once:true});
 dialog.showModal();return dialog;
}
