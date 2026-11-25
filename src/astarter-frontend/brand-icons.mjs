import {TOKEN_ICONS,TOKEN_IDS,VENUE_ICONS} from './brand-icon-data.mjs';
export {TOKEN_ICONS,VENUE_ICONS} from './brand-icon-data.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>Math.max(14,Math.min(48,Number(n)||24));
const fallback='<svg class="brand-fallback" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m12 6 5 6-5 6-5-6Z"/><path d="M7 12h10"/></svg>';
const imageCache=new Map(),CACHE_TTL=86400000,CACHE_LIMIT=1000,CACHE_KEY='hive.ui.token-icons.v1';let cacheLoaded=false;
export function approvedTokenImageURL(value){
 if(typeof value==='string'&&value.length<600&&/^https:\/\/cdn\.dexscreener\.com\/cms\/images\/[a-f0-9]{32,128}(?:\?(?:width|height|quality|format)=[a-z0-9]+(?:&(?:width|height|quality|format)=[a-z0-9]+)*)?$/.test(value))return value;
 if(typeof value!=='string'||value.length>600||!/^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(value))return null;
 try{const u=new URL(value);if(u.username||u.password||u.port||u.hash||!/^\/coins\/images\/\d+\/(thumb|small|large)\/[A-Za-z0-9_().-]+\.(png|jpg|jpeg|webp|svg)$/.test(decodeURIComponent(u.pathname))||u.search&&!/^\?\d+$/.test(u.search))return null;return u.href;}catch{return null;}
}
export function approvedVenueImageURL(value){
 if(typeof value!=='string'||value.length>600)return null;
 try{const u=new URL(value);return u.protocol==='https:'&&['coin-images.coingecko.com','assets.coingecko.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.hash&&/^\/markets\/images\/\d+\/(thumb|small|large)\/[A-Za-z0-9_().-]+\.(png|jpg|jpeg|webp|svg)$/.test(decodeURIComponent(u.pathname))&&(!u.search||/^\?\d+$/.test(u.search))?u.href:null;}catch{return null;}
}
function tokenKey(a){
 const symbol=String(a.symbol||'').toUpperCase(),id=a.asset_id??a.assetId,chain=a.chain_id??a.chainId,address=a.address??a.contract_address;
 if(!/^[A-Z0-9._-]{1,30}$/.test(symbol))return null;
 if(chain!==undefined&&address){const c=String(chain),addr=String(address);if(c.length>50||addr.length>150)return null;return JSON.stringify(['contract',c,/^0x/i.test(addr)?addr.toLowerCase():addr,symbol]);}
 return typeof id==='string'&&/^[a-z0-9][a-z0-9._-]{0,149}$/.test(id)?JSON.stringify(['asset',id,symbol]):null;
}
function restoreCache(){
 if(cacheLoaded)return;cacheLoaded=true;
 try{const rows=JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY)||'[]'),now=Date.now();if(Array.isArray(rows))for(const [key,value]of rows.slice(-CACHE_LIMIT)){if(typeof key==='string'&&key.length<300&&approvedTokenImageURL(value?.url)&&Number.isFinite(value?.until)&&value.until>now)imageCache.set(key,value);}}catch{}
}
export function registerTokenMetadata(rows,{persist=false,now=Date.now()}={}){
 restoreCache();let changed=0;
 for(const value of rows||[]){const a=value?.data||value,key=tokenKey(a||{}),url=approvedTokenImageURL(a?.image_url);if(!key||!url)continue;imageCache.delete(key);imageCache.set(key,{url,until:now+CACHE_TTL});changed++;}
 while(imageCache.size>CACHE_LIMIT)imageCache.delete(imageCache.keys().next().value);
 if(persist&&changed)try{globalThis.localStorage?.setItem(CACHE_KEY,JSON.stringify([...imageCache.entries()]));}catch{}
 return changed;
}
export function tokenLogo(identity){
 const a=typeof identity==='string'?{symbol:identity}:identity||{},symbol=String(a.symbol||'').toUpperCase(),id=a.asset_id??a.assetId;
 const key=tokenKey(a),direct=key&&approvedTokenImageURL(a.image_url);
 if(direct)return direct;
 restoreCache();const cached=key&&imageCache.get(key);if(cached&&cached.until>Date.now())return cached.url;
 // A symbol alone does not identify a contract on an arbitrary chain.
 if(a.address||a.contract_address)return null;
 if(id!==undefined&&(!TOKEN_IDS[id]||TOKEN_IDS[id]!==symbol))return null;
 return Object.hasOwn(TOKEN_ICONS,symbol)?TOKEN_ICONS[symbol]:null;
}
const venueAliases={okex:'okx','gate.io':'gate',gateio:'gate','bybit_spot':'bybit','binance-spot-demo':'binance','binance-perp':'binance','dex / hyperliquid':'hyperliquid'};
function venueKey(identity){const raw=String(typeof identity==='object'?identity?.venue_id??identity?.venueId??identity?.venue??'':identity||'').trim().toLowerCase();return venueAliases[raw]||raw;}
export function venueLogo(identity){const id=venueKey(identity);return Object.hasOwn(VENUE_ICONS,id)?VENUE_ICONS[id]:null;}
function mark(src,label,{size:dimension=24,className='',fallbackSrc=null}={}){
 const s=size(dimension),classes=String(className).split(/\s+/).filter(x=>/^[a-zA-Z][\w-]*$/.test(x)).join(' ');
 return `<span class="brand-mark ${classes}" style="--brand-size:${s}px" data-logo-state="${src?'known':'unavailable'}" aria-hidden="true" title="${esc(src?label:label+' · 图标待补充 / Logo unavailable')}">${fallback}${src?`<img src="${esc(src)}" ${fallbackSrc?`data-logo-fallback="${esc(fallbackSrc)}"`:''} alt="" width="${s}" height="${s}" decoding="async" referrerpolicy="no-referrer" ${src.startsWith('https://cdn.dexscreener.com/')?'':'crossorigin="anonymous"'}>`:''}</span>`;
}
export function tokenIcon(identity,options={}){
 const a=typeof identity==='string'?{symbol:identity}:identity||{},symbol=String(a.symbol||'').toUpperCase(),id=a.asset_id??a.assetId,src=tokenLogo(a);
 const local=!a.address&&!a.contract_address&&(id===undefined||TOKEN_IDS[id]===symbol)?TOKEN_ICONS[symbol]:null;
 const instruments={SPX:'S&P 500 · Index',NDX:'Nasdaq-100 · Index',XAU:'Gold · USD/oz',DXY:'US Dollar Index',US10Y:'US Treasury · 10Y yield',USD:'US Dollar'};
 const instrument=local&&instruments[symbol];
 return mark(src,instrument||a.symbol||a.asset_id||'Token',{...options,className:[options.className,local&&symbol==='SOL'?'brand-solana':'',instrument?'brand-instrument':''].filter(Boolean).join(' '),fallbackSrc:local&&local!==src?local:null});
}
export function venueIcon(identity,options={}){
 const id=venueKey(identity);
 const remote=typeof identity==='object'&&approvedVenueImageURL(identity?.image_url),local=venueLogo(identity);
 return mark(local||remote,typeof identity==='string'?identity.trim():identity?.venue||identity?.venue_id||identity?.venueId||'Exchange',{...options,fallbackSrc:local&&remote?remote:null,className:[options.className,'brand-venue',/^[a-z]+$/.test(id)?'brand-venue-'+id:''].filter(Boolean).join(' ')});
}
export function pairSymbols(value){
 const s=String(value||'').trim().toUpperCase(),split=s.match(/^([A-Z0-9]{2,12})\s*([\/\-])\s*([A-Z0-9]{2,12})(?:\s|$)/);
 // Hyphenated account/version IDs are not markets; slash pairs retain unknown asset support.
 if(split&&/[A-Z]/.test(split[3])&&(split[2]==='/'||Object.hasOwn(TOKEN_ICONS,split[3])))return [split[1],split[3]];
 if(Object.hasOwn(TOKEN_ICONS,s))return [s];
 const compact=s.match(/^([A-Z0-9]{2,12}?)(USDT|USDC|USD|BTC|ETH)$/);return compact?[compact[1],compact[2]]:[];
}
export function pairIcon(value,options={}){const symbols=pairSymbols(value);return symbols.length?`<span class="brand-pair" aria-hidden="true">${symbols.map(s=>tokenIcon(s,{size:20,...options})).join('')}</span>`:'';}
const boundSelects=new WeakSet();
export function refreshSelectIdentity(select){
 const value=select.value||'',text=select.selectedOptions?.[0]?.textContent.trim()||'';
 const pair=pairSymbols(value).length?value:pairSymbols(text).length?text:null,venue=venueLogo(value)?value:venueLogo(text)?text:null;
 const field=select.closest('.liquid-native-host')||select;
 let wrap=field.parentElement?.classList.contains('brand-select')?field.parentElement:null;
 if(!pair&&!venue){if(wrap){wrap.before(field);wrap.remove();}return;}
 if(!wrap){wrap=select.ownerDocument.createElement('span');wrap.className='brand-select';field.before(wrap);wrap.append(field);}
 if(wrap.dataset.identityValue===value&&wrap.dataset.identityText===text)return;
 wrap.querySelector('.brand-select-leading')?.remove();const box=select.ownerDocument.createElement('span');box.className='brand-select-leading';
 box.innerHTML=pair?pairIcon(pair,{size:18}):venueIcon(venue,{size:21});wrap.prepend(box);wrap.dataset.identityValue=value;wrap.dataset.identityText=text;
}

// Add identity marks to structured names and native select values; never scan prose or charts.
export function decorateIdentity(root){
 if(!root)return;
 const candidates=root.querySelectorAll('a[href*="asset="],button[data-symbol],button[data-market],td,th,h1,h2,h3,.biz-op-row .biz-op-asset,.rb-card header strong');
 for(const el of candidates){
  if(el.closest('svg,canvas,option,select,.brand-mark,.brand-pair')||el.querySelector('.brand-mark,.brand-pair,.dc-coin,.sig-coin,img'))continue;
  const identityGroup=el.closest('.da-identity,.pd-asset,.df-holding-asset,.sig-asset');
  if(identityGroup&&identityGroup!==el&&identityGroup.querySelector('.brand-mark,.dc-coin,.sig-coin,img'))continue;
  if(el.matches('td,th,h1,h2,h3')&&el.querySelector('a,button,h1,h2,h3'))continue;
  const text=el.textContent.trim(),first=text.match(/^([A-Z0-9]{2,12})(?=[\s/·:：]|$)/)?.[1];
  const pair=text.match(/^([A-Z0-9]{2,12})\s*\/\s*([A-Z0-9]{2,12})(?=\s|$)/);
  const venue=Object.keys(VENUE_ICONS).find(k=>text.toLowerCase()===k||text.toLowerCase().startsWith(k+' '));
  if(!first&&!venue)continue;
  let html=pair&&TOKEN_ICONS[pair[1]]?pairIcon(pair[0],{size:18}):first&&TOKEN_ICONS[first]?tokenIcon(first,{size:el.matches('h1')?26:el.matches('h2,h3')?22:18}):venue?venueIcon(venue,{size:22}):'';
  if(!html)continue;
  if(el.closest('.dc-heatmap,.dc-treemap')&&el.getBoundingClientRect().width<75)continue;
  el.insertAdjacentHTML('afterbegin',html);el.classList.add('has-brand-identity');
 }
 for(const el of root.querySelectorAll('.da-venue-mark')){
  const name=el.parentElement?.textContent.trim().replace(el.textContent,'').trim();if(venueLogo(name))el.outerHTML=venueIcon(name,{size:24});
 }
 for(const select of root.querySelectorAll('select')){
  refreshSelectIdentity(select);if(!boundSelects.has(select)){boundSelects.add(select);select.addEventListener('change',()=>refreshSelectIdentity(select));}
 }
 for(const img of root.querySelectorAll('.brand-mark img')){
  if(img.dataset.fallbackBound)continue;img.dataset.fallbackBound='true';
  const fail=()=>{if(img.dataset.logoFallback&&!img.dataset.logoFallbackUsed){img.dataset.logoFallbackUsed='true';img.src=img.dataset.logoFallback;return;}img.hidden=true;img.parentElement.dataset.logoState='unavailable';};
  img.addEventListener('error',fail);if(img.complete&&!img.naturalWidth)fail();
 }
}
