import {routeSearch} from './site-routes.mjs';
import {createMarketHubClient,HUB_ASSET_IDS,HUB_RESOURCES,HUB_CATEGORIES,hubSeriesChange,hubSourceTime,HUB_REFRESH_SECONDS,parseHubRefreshSeconds} from './market-hub-data.mjs';
import {atlasMarketFeed,currentAtlasPrice} from './atlas-feed-master.mjs';
import {loadWatchAssets,WATCH_ASSETS_KEY,watchAssetKey,isWatchAsset,watchAssetIcon,watchChain,fetchWatchAssets} from './market-watchlist.mjs';
import {formatDataTime} from './product-help.mjs';
import {tokenIcon,venueIcon,registerTokenMetadata} from './brand-icons.mjs';
import {uiGlyph,bindSearchRender,canAutoRefresh,dataRefreshControls} from './product-composition.mjs';
import {chartPanel,miniChart} from './product-chart-ui.mjs';
import {createHubCharts,createHubHourlyHistory,hubMarketShares} from './market-hub-charts.mjs';
import {L} from './execution-views.mjs';
import {readRelatedAsset} from './related-data.mjs';
import {tradingChartPanel} from './trading-chart.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const hubNumber=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
export function hubBreadth(assets,quote=a=>a){
 const rows=assets.map(a=>({asset:a,change:quote(a).change})),valid=rows.filter(r=>Number.isFinite(r.change));
 const limit=Math.max(1,...valid.map(r=>Math.abs(r.change)));
 return {limit,up:valid.filter(r=>r.change>0).length,down:valid.filter(r=>r.change<0).length,flat:valid.filter(r=>r.change===0).length,missing:rows.length-valid.length,rows:rows.map(r=>({...r,height:Number.isFinite(r.change)?Math.abs(r.change)/limit*46:0}))};
}
export const hubChangeTone=value=>!Number.isFinite(value)?'missing':value===0?'flat':value>0?'up':'down';
export const hubCandleIdentity=asset=>asset&&!asset.address&&Object.hasOwn(HUB_ASSET_IDS,asset.symbol)&&HUB_ASSET_IDS[asset.symbol]===asset.id?{market:asset.symbol+'/USDT',venueId:'binance',profileId:'cex-spot'}:null;
export function hubSortAssets(rows,key,direction,quote=a=>a){
 const value=a=>key==='price'||key==='change'?quote(a)[key]:a[key];
 return [...rows].sort((a,b)=>{const left=value(a),right=value(b);return Number.isFinite(left)&&Number.isFinite(right)?(left-right)*direction:Number.isFinite(left)?-1:Number.isFinite(right)?1:0;});
}
export function hubMoney(v){if(!Number.isFinite(v))return '—';const a=Math.abs(v);return (v<0?'-$':'$')+hubNumber(a/(a>=1e12?1e12:a>=1e9?1e9:a>=1e6?1e6:1),a<1?6:2)+(a>=1e12?'T':a>=1e9?'B':a>=1e6?'M':'');}
const price=v=>hubNumber(v,v<.001?8:v<1?5:v<10?4:2);
const change=v=>`<span class="${v==null||v===0?'':v>0?'hub-up':'hub-down'}">${v==null?'—':v!==0&&Math.abs(v)<.005?(v>0?'+':'-')+'&lt;0.01%':(v>0?'+':'')+hubNumber(v)+'%'}</span>`;
const clock=at=>Number.isFinite(at)?new Date(at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}):'—';
const date=at=>Number.isFinite(at)?new Date(at+8*3600000).toISOString().slice(0,10):'—';
export function hubFeedRows(events){
 let day='';
 return events.slice(0,5).map(e=>{
  const valid=Number.isFinite(e.at)&&Number.isFinite(new Date(e.at).getTime()),stamp=valid?date(e.at):'—';
  const heading=stamp!==day?`<li class="hub-feed-day"><time${valid?` datetime="${stamp}"`:''}>${valid?stamp:L('时间未提供','Time unavailable')}</time><small>UTC+8</small></li>`:'';day=stamp;
  return heading+`<li class="hub-feed-event"><div class="hub-feed-asset"><b>${esc(e.symbol)}</b><time${valid?` datetime="${new Date(e.at).toISOString()}" title="${stamp} ${clock(e.at)} UTC+8"`:''}>${valid?clock(e.at):'—'}</time></div><span class="hub-feed-price">${price(e.price)}<span class="sr-only"> USDT</span></span>${change(e.delta)}</li>`;
 }).join('')||`<li class="hub-feed-wait">${L('等待下一次报价变化','Waiting for the next quote change')}</li>`;
}
const feedHeader=()=>`<div class="hub-feed-head" aria-hidden="true"><span>${L('资产','Asset')}</span><span>${L('价格 / USDT','Price / USDT')}</span><span>${L('较前价','Change')}</span></div>`;
const resourceLabel=key=>({global:L('全市场','Global market'),assets:L('资产快照','Asset snapshots'),tickers:L('现货定时快照','Spot polling snapshot'),categories:L('赛道','Sectors'),exchanges:L('交易平台','Trading venues'),chains:L('公链 TVL','Chain TVL'),stablecoins:L('稳定币','Stablecoins'),tvl:'DeFi TVL',sentiment:L('市场情绪','Market sentiment')})[key];
const errorLabel=code=>({RATE_LIMIT:L('来源限流，稍后重试','Source rate limit; retrying shortly'),AUTH_REQUIRED:L('来源需要授权','Source authorization required'),INVALID_DATA:L('来源数据格式不符','Unexpected source data'),TIMEOUT:L('读取超时，稍后重试','Request timed out; retrying shortly'),FETCH_FAILED:L('更新失败，保留上次数据','Update failed; last data retained')})[code]||L('更新失败','Update failed');
const link=(text,params={},cls='')=>params.view==='watchlist'?`<button type="button" data-hub-add>${text}</button>`:`<a class="${cls}" data-dc-link${cls==='selected'?' aria-current="page"':''} href="?${new URLSearchParams({page:'markets',...params})}">${text}</a>`;
const info=(text,label=L('查看指标说明','About this metric'))=>`<details class="dc-info"><summary aria-label="${esc(label)}">i</summary><div>${esc(text)}</div></details>`;
const renderChart=(key,rows,color,unit='USD',initialRange=null)=>rows?.length>1?chartPanel('hub-'+key,{title:key==='stable'?L('稳定币供应量','Stablecoin supply'):key==='tvl'?L('DeFi 锁仓量','DeFi TVL'):key,values:rows.map(r=>r.value),labels:rows.map(r=>r.at),unit,color,compact:true,height:230,initialWindow:'all',initialRange,showPresets:false}):`<div class="hub-chart-empty">${L('等待数据','Waiting for data')}</div>`;
const icon=a=>watchAssetIcon(a);
export function hubOwnsRoute(page,search){const p=new URLSearchParams(search);return page==='markets'&&!['demo','live'].includes(p.get('data'))&&!(!p.get('coin')&&['SPX','NDX','XAU','DXY','US10Y'].includes(p.get('asset')));}
export function createMarketHub({root,account,rerender,notify,onAskSource=()=>{},saved,onSaveWatch=null,storage=globalThis.localStorage}){
 let enabled=false,search='',sort='cap',sortDirection=-1,scope='all',period=30,needsPaint=false,userPaint=false,fullTable=false,lastView='',lastPaint=0,lastIcons='',refreshing=false,dataVersion='';
 let refreshSeconds=60;try{refreshSeconds=parseHubRefreshSeconds(localStorage.getItem('hive.market.refreshSeconds')||60);}catch{}
 const resourceKeys=Object.keys(HUB_RESOURCES);
 let paintFrame=0,batchTimer=0,batchStarted=null,lastAutoPaint=-Infinity;
 const client=createMarketHubClient({refreshSeconds,onChange:()=>{
  const version=resourceVersion();
  if(version===dataVersion)return;
  dataVersion=version;patchStatus();schedule();
 },onPrice:schedulePrices});
 function resourceVersion(){
  return resourceKeys.map(key=>{const s=client.read(key);return [s.snapshot?.receivedAt,s.quality,s.error,s.fromCache].join(':');}).join('|');
 }
 const charts=createHubCharts(),hiddenSeries=new Set();let performanceWindow='7d',heroModels={};
 const performanceWindows=['6h','24h','7d','30d','90d'];
 const hourly=createHubHourlyHistory(()=>schedule(),{useAggregate:false});
 const param=k=>new URLSearchParams(location.search).get(k);
 const read=key=>client.read(key),data=key=>read(key).snapshot?.data;
 let watchRows=loadWatchAssets(storage),watchAt=0,watchTask=null,watchController=null;
 if(typeof document!=='undefined')document.addEventListener('hive:watchlist-change',()=>{watchRows=loadWatchAssets(storage);if(!account)try{saved.assets=JSON.parse(storage?.getItem('hive.dc.assets')||'[]');}catch{}lastIcons='';schedule(true);});
 function applyRefreshInterval(value){
  const seconds=parseHubRefreshSeconds(value);if(seconds!==refreshSeconds){client.setRefreshSeconds(seconds);refreshSeconds=seconds;watchAt=Date.now()+seconds*1000;}
  const select=root.querySelector('[data-hub-interval]');if(select)select.value=String(seconds);
 }
 if(typeof window!=='undefined'){
  window.addEventListener('hive:market-refresh-interval',event=>{try{applyRefreshInterval(event.detail?.seconds);}catch{}});
  window.addEventListener('storage',event=>{if(event.key==='hive.market.refreshSeconds')try{applyRefreshInterval(event.newValue||60);}catch{}});
 }
 const assets=()=>[...new Map([...watchRows.filter(a=>isWatchAsset(a,saved.assets)),...(data('assets')||[])].map(a=>[a.id,a])).values()];
 const watched=a=>isWatchAsset(a,saved.assets);
 const persistKey=a=>!a.address&&HUB_ASSET_IDS[a.symbol]===a.id?a.symbol:watchAssetKey(a);
 async function saveWatch(a,remove=false){
  if(onSaveWatch){await onSaveWatch(a,remove);watchRows=loadWatchAssets(storage);if(!account)try{saved.assets=JSON.parse(storage?.getItem('hive.dc.assets')||'[]');}catch{}lastIcons='';schedule(true);return;}
  if(account)await account.resource('asset',persistKey(a),remove);
  const next=remove?saved.assets.filter(key=>key!==watchAssetKey(a)&&(a.address||key!==a.symbol)):[...new Set([...saved.assets,persistKey(a)])];
  const rows=remove?watchRows.filter(row=>row.id!==a.id):[...new Map([...watchRows,a].map(row=>[row.id,row])).values()];
  if(rows.length>200)throw new Error('WATCHLIST_FULL');
  try{storage?.setItem(WATCH_ASSETS_KEY,JSON.stringify(rows));storage?.setItem('hive.dc.assets',JSON.stringify(next));}catch{throw new Error('STORAGE_FAILED');}
  watchRows=rows;saved.assets=next;lastIcons='';schedule(true);
 }
 function refreshWatch(force=false){
  if(watchTask)return watchTask;
  if(!enabled||typeof document!=='undefined'&&document.hidden||!force&&Date.now()<watchAt)return Promise.resolve({failed:0});
  const rows=watchRows.filter(a=>watched(a)&&!(data('assets')||[]).some(current=>current.id===a.id));
  watchAt=Date.now()+refreshSeconds*1000;if(!rows.length)return Promise.resolve({failed:0});
  watchController=new AbortController();
  watchTask=fetchWatchAssets(rows,{signal:watchController.signal}).then(result=>{
   if(!enabled||watchController.signal.aborted)return {failed:0};
   const updated=new Map(result.rows.map(a=>[a.id,a]));watchRows=watchRows.map(a=>updated.get(a.id)||a);
   try{storage?.setItem(WATCH_ASSETS_KEY,JSON.stringify(watchRows));}catch{}
   lastIcons='';schedule();return result;
  }).catch(error=>({failed:error.name==='AbortError'?0:rows.length})).finally(()=>{watchTask=null;watchController=null;});return watchTask;
 }
 const selectedAsset=()=>assets().find(a=>a.symbol===param('asset')&&(!param('coin')||a.id===param('coin')));
 const viewMemory=new Map(),viewKey=()=>location.search+'|'+period;
 const chart=(key,rows,color,unit)=>renderChart(key,rows,color,unit,viewMemory.get(viewKey())?.charts.get('hub-'+key));
 function rememberView(){
  const current=root.querySelector?.('.market-hub');if(!current)return;
  const charts=new Map([...current.querySelectorAll('[data-chart]')].filter(el=>Number(el.dataset.visibleCount)>0).map(el=>[el.dataset.chart,{start:Number(el.dataset.rangeStart),count:Number(el.dataset.visibleCount)}]));
  const scrolls=new Map([...current.querySelectorAll('.hub-table-wrap,.hub-kpis,.hub-nav')].map(el=>[el.className,el.scrollLeft]));
  const field=current.querySelector('[data-hub-search]'),input=field?{value:field.value,start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection,focused:document.activeElement===field}:null;
  viewMemory.set(current.dataset.hubLayout,{charts,scrolls,input});if(viewMemory.size>30)viewMemory.delete(viewMemory.keys().next().value);
 }
 function cancelPaint(){
  if(paintFrame)cancelAnimationFrame(paintFrame);
  clearTimeout(batchTimer);paintFrame=batchTimer=0;batchStarted=null;
 }
 function queuePaint(){
  if(paintFrame)return;
  paintFrame=requestAnimationFrame(()=>{
   paintFrame=0;
   if(!enabled||document.hidden||!userPaint&&(!canAutoRefresh(root)||root.querySelector('.chart-canvas.is-dragging,button:active,a:active')))return;
   needsPaint=false;userPaint=false;lastAutoPaint=performance.now();
   const focusWindow=document.activeElement?.dataset?.hubWindow;
   const y=root.scrollTop;rerender();root.scrollTop=y;
   if(focusWindow&&document.activeElement===document.body)root.querySelector('[data-hub-window="'+focusWindow+'"]')?.focus({preventScroll:true});
  });
 }
 function schedule(immediate=false){
  userPaint||=immediate;needsPaint=true;
  if(!enabled||typeof document==='undefined'||paintFrame)return;
  clearTimeout(batchTimer);batchTimer=0;
  if(userPaint){batchStarted=null;queuePaint();return;}
  // The market sources finish independently. Merge nearby completions, with
  // a deadline so one slow provider cannot hold earlier observations back.
  const now=performance.now();batchStarted??=now;
  const pending=resourceKeys.some(key=>client.read(key).pending);
  const deadline=Math.min(batchStarted+850,Math.max(now+(pending?190:0),lastAutoPaint+650));
  if(deadline<=now){batchStarted=null;queuePaint();return;}
  batchTimer=setTimeout(()=>{batchTimer=0;batchStarted=null;queuePaint();},deadline-now);
 }
 let priceScheduled=false;
 function schedulePrices(){if(priceScheduled||typeof document==='undefined')return;priceScheduled=true;requestAnimationFrame(()=>{priceScheduled=false;if(enabled&&!document.hidden)patchPrices();});}
 function source(key){
  const s=read(key),streaming=key==='tickers'&&client.stream==='live'&&Date.now()-client.lastMessage<10000,asOf=streaming?null:s.snapshot?.asOf,at=streaming?client.lastMessage:asOf??s.snapshot?.receivedAt;
  const status=streaming?L('即时行情','Live quotes'):s.error?errorLabel(s.error):s.quality==='loading'?L('读取中','Loading'):s.quality==='stale'?L('较早数据','Older data'):s.fromCache?L('已缓存','Cached'):L('已更新','Updated');
  return `<details class="dc-info hub-source ${streaming?'fresh':s.quality}"><summary aria-label="${esc(resourceLabel(key)+' · '+L('数据来源与时间','Source and time'))}">i</summary><div class="hub-source-detail"><b>${esc(s.snapshot?.provider??HUB_RESOURCES[key].provider)}</b><span>${asOf?L('数据时间','Data time'):L('获取时间','Retrieved at')}<time>${hubSourceTime(at,asOf?key:null)}</time></span>${asOf?`<span>${L('获取时间','Retrieved at')}<time>${formatDataTime(s.snapshot.receivedAt)}</time></span>`:''}<small>${['stablecoins','tvl','sentiment'].includes(key)?L('日频 · UTC 日期','Daily · UTC date')+' · ':''}${status}</small></div></details>`;
 }
 const panel=(title,html,key,extra=null,cls='')=>`<section class="dc-panel hub-panel ${cls}"><header><h2>${title}</h2>${extra??source(key)}</header>${html}</section>`;
 const stat=(title,value,sub='',extra='')=>`<section class="hub-stat"><span>${title}</span><strong>${value}</strong><div>${sub}</div>${extra}</section>`;
 const getQuote=a=>{const q=client.quote(a);return a.address?{...q,asOf:a.asOf??null,receivedAt:a.receivedAt??null}:q;};
 let atlasPrices={},atlasPriceAt=0,atlasController=null;
 const atlasPrice=a=>currentAtlasPrice(atlasPrices[a.symbol],atlasMarketFeed(a));
 const atlasAttr=a=>{const feed=atlasMarketFeed(a),row=atlasPrice(a);return feed?` data-atlas-feed="${feed.id}" data-atlas-asset="${esc(a.id)}"`+(row?` data-atlas-price="${row.price}"`:''):'';};
 const atlasValue=a=>{const row=atlasPrice(a);return row?price(row.price)+' '+row.quote+' · '+formatDataTime(row.timestamp*1000):'—';};
 const atlasLabel=()=>L('Atlas 预言机参考价','Atlas Oracle reference');
 const atlasField=a=>`<span data-hub-atlas-value="${esc(a.id)}">${esc(atlasValue(a))}</span>`;
 function patchAtlas(){
  const rows=new Map(assets().map(a=>[a.id,a]));
  for(const el of root.querySelectorAll('[data-hub-atlas-value],[data-atlas-asset]')){
   const asset=rows.get(el.dataset.hubAtlasValue||el.dataset.atlasAsset);
   if(!asset)continue;
   if(el.dataset.hubAtlasValue){
    const value=atlasValue(asset);if(el.textContent!==value)el.textContent=value;
   }else{
    const row=atlasPrice(asset);if(row)el.dataset.atlasPrice=String(row.price);else delete el.dataset.atlasPrice;
   }
  }
 }
 const quoteSource=(a,q)=>q.provider+' · '+(a.address?L('数据时间','Data time')+' '+formatDataTime(q.asOf)+' · '+L('获取时间','Retrieved at')+' '+formatDataTime(q.receivedAt):formatDataTime(q.asOf));
 const quoteTitle=(a,q)=>quoteSource(a,q)+(atlasPrice(a)?'\n'+atlasLabel()+' · '+atlasValue(a):'');
 function quoteCell(a){const q=getQuote(a);return `<span class="hub-price" data-hub-price="${esc(a.id)}" data-price="${q.price}" title="${esc(quoteTitle(a,q))}">${price(q.price)}</span><small data-hub-unit="${esc(a.id)}">${q.quote}</small>`;}
 function assetRow(a,index){const q=getQuote(a);return `<tr data-hub-row="${esc(a.symbol)}"${atlasAttr(a)}><td><button type="button" class="hub-watch" data-hub-watch="${esc(a.id)}" aria-label="${esc(L('收藏','Favorite')+' '+a.symbol)}" aria-pressed="${watched(a)}">${uiGlyph('star')}</button></td><td class="hub-rank">${Number.isSafeInteger(a.rank)&&a.rank>0?esc(a.rank):'—'}</td><td>${link(icon(a)+`<span><b>${esc(a.symbol)}</b><small>${esc(a.name)}${a.chain?' · '+esc(watchChain(a.chain)):''}</small></span>`,{asset:a.symbol,coin:a.id},'hub-asset')}</td><td>${quoteCell(a)}</td><td data-hub-change="${esc(a.id)}">${change(q.change)}</td><td>${hubMoney(a.volume)}</td><td>${hubMoney(a.cap)}</td><td class="hub-spark">${a.series.length>1?link(miniChart(a.series,'var(--chart-series-1)'),{asset:a.symbol,coin:a.id},'hub-spark-link').replace('<a ',`<a aria-label="${esc(a.symbol+' '+L('完整价格图表','full price chart'))}" `):'—'}</td><td>${change(a.change7d)}</td></tr>`;}
 // Card hierarchy adapted from 21st reuno-ui Crypto Dashboard (demo 5479); existing data and chart consumers are retained.
 function assetCard(a){
  const q=getQuote(a),metric=(label,value)=>`<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<article class="hub-asset-card" data-hub-card="${esc(a.id)}"${atlasAttr(a)}>
   <header>${link(icon(a)+`<span><b>${esc(a.symbol)}</b><small>${esc(a.name)}${a.chain?' · '+esc(watchChain(a.chain)):''}</small></span>`,{asset:a.symbol,coin:a.id},'hub-asset')}<button type="button" class="hub-watch" data-hub-watch="${esc(a.id)}" aria-label="${esc(L('收藏','Favorite')+' '+a.symbol)}" aria-pressed="${watched(a)}">${uiGlyph('star')}</button></header>
   <div class="hub-card-quote"><div>${quoteCell(a)}</div><span><span data-hub-change="${esc(a.id)}">${change(q.change)}</span><small>24h</small></span></div>
   <div class="hub-card-trend"><div><span>${L('7日走势','7-day trend')} · USD</span>${change(a.change7d)}</div>${a.series?.length>1?link(miniChart(a.series,'var(--chart-series-1)'),{asset:a.symbol,coin:a.id},'hub-card-chart').replace('<a ',`<a aria-label="${esc(a.symbol+' '+L('完整价格图表','full price chart'))}" `):`<div class="hub-card-chart hub-card-chart-empty">${L('暂无走势','History unavailable')}</div>`}</div>
   <dl>${metric(L('24h 成交额','24h volume')+` · <span data-hub-card-volume-unit="${esc(a.id)}">${esc(q.quote)}</span>`,`<span data-hub-card-volume="${esc(a.id)}">${hubMoney(q.volume).replace('$','')}</span>`)}${metric(L('市值','Market cap')+' · USD',hubMoney(a.cap).replace('$',''))}${metric(L('24h 高点','24h high')+' · USD',Number.isFinite(a.high)&&a.high>0?price(a.high):'—')}${metric(L('24h 低点','24h low')+' · USD',Number.isFinite(a.low)&&a.low>0?price(a.low):'—')}</dl>
   <details class="dc-info hub-card-source"><summary data-hub-card-source="${esc(a.id)}" aria-label="${esc(a.symbol+' · '+L('数据来源与时间','Source and time'))}">i</summary><div><b>${L('当前报价','Current quote')}</b><p data-hub-card-quote-source="${esc(a.id)}">${esc(quoteSource(a,q))} · ${esc(q.quote)}</p><b>${L('走势、市值与高低点','Trend, cap and range')}</b><p>${a.address?'DEX Screener':esc(a.provider||HUB_RESOURCES.assets.provider)} · USD · ${formatDataTime(a.asOf)}</p>${atlasMarketFeed(a)?`<b>${atlasLabel()}</b><p>${atlasField(a)}</p>`:''}</div></details>
  </article>`;
 }
 function tableRows(){
  const term=search.trim().toLowerCase(),rows=assets().filter(a=>(scope!=='watch'||watched(a))&&(!term||[a.id,a.symbol,a.name].join(' ').toLowerCase().includes(term)));
  return hubSortAssets(rows,sort,sortDirection,getQuote);
 }
 function assetTable(){
  const rows=tableRows(),ranking=param('view')==='ranking',cardView=!ranking&&!fullTable;
  const orderChoices=[['cap',L('市值','Market cap')],['change',L('24h 涨跌','24h change')],['price',L('价格','Price')],['volume',L('成交额','Volume')]];
  const order=!ranking?`<div class="hub-card-order" role="group" aria-label="${L('资产排序','Asset order')}"><span>${L('排序','Sort')}</span>${orderChoices.map(([key,label])=>`<button type="button" data-hub-sort="${key}" aria-label="${label}" aria-pressed="${sort===key}">${label}${sort===key?(sortDirection===-1?' ↓':' ↑'):''}</button>`).join('')}</div>`:'';
  const display=ranking?`<button type="button" class="hub-full-toggle" data-hub-full aria-pressed="${fullTable}" aria-label="${L('完整数据','Full data')}" title="${fullTable?L('简洁列表','Compact list'):L('完整数据','Full data')}"><span>${L('完整数据','Full data')}</span>${uiGlyph('columns')}</button>`:`<div class="hub-view-switch" role="group" aria-label="${L('显示方式','Display mode')}"><button type="button" data-hub-display="cards" aria-pressed="${cardView}" aria-label="${L('行情卡视图','Market card view')}" title="${L('行情卡视图','Market card view')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>${L('卡片','Cards')}</span></button><button type="button" data-hub-display="table" aria-pressed="${!cardView}" aria-label="${L('数据表视图','Data table view')}" title="${L('数据表视图','Data table view')}">${uiGlyph('columns')}<span>${L('表格','Table')}</span></button></div>`;
  const metadata=scope==='watch'?info(L('自选报价来自 CoinGecko / Binance；合约资产来自 DEX Screener。点击卡片底部查看来源与时间。','Quotes use CoinGecko / Binance; contracts use DEX Screener. Open a card’s source row for details.'),L('关于我的追踪','About my tracking')):source('assets');
  const scopeButtons=`<div class="hub-segments hub-asset-scope"><button type="button" data-hub-scope="all" aria-pressed="${scope==='all'}">${L('全部','All')} <b>${assets().length||'—'}</b></button><button type="button" data-hub-scope="watch" aria-pressed="${scope==='watch'}">${L('自选','Watchlist')} <b>${assets().filter(watched).length}</b></button></div>`;
  const compactScope=`<label class="hub-compact-scope"><span class="sr-only">${L('资产范围','Asset scope')}</span><select data-hub-scope-select aria-label="${L('资产范围','Asset scope')}"><option value="all" ${scope==='all'?'selected':''}>${L('全部','All')} ${assets().length||'—'}</option><option value="watch" ${scope==='watch'?'selected':''}>${L('自选','Watchlist')} ${assets().filter(watched).length}</option></select></label>`;
  const compactOrder=!ranking?`<div class="hub-compact-order" role="group" aria-label="${L('资产排序','Asset order')}"><select data-hub-sort-select aria-label="${L('排序指标','Sort by')}">${orderChoices.map(([key,label])=>`<option value="${key}" ${sort===key?'selected':''}>${label}</option>`).join('')}</select><button type="button" class="hub-order-direction" data-hub-sort="${sort}" aria-label="${L('降序排列','Sort descending')}" aria-pressed="${sortDirection===-1}" title="${sortDirection===-1?L('降序','Descending'):L('升序','Ascending')}">${uiGlyph('arrow')}</button></div>`:'';
  const tools=`<div class="hub-table-tools"><div class="hub-table-actions"><label class="hub-search">${uiGlyph('search')}<input type="search" data-hub-search value="${esc(search)}" placeholder="${esc(L('搜索资产','Search assets'))}" aria-label="${esc(L('搜索市场资产','Search market assets'))}"></label><button type="button" class="dc-button hub-add-asset" data-hub-add aria-label="${L('添加资产','Add asset')}" title="${L('添加资产','Add asset')}">${uiGlyph('plus')}<span>${L('添加资产','Add asset')}</span></button>${display}</div>${order}${compactOrder}</div>`;
  return panel(L('资产','Assets'),`${cardView?`<div class="hub-asset-cards">${rows.map(assetCard).join('')}${rows.length?'':`<div class="hub-empty">${scope==='watch'&&!assets().some(watched)?`<strong>${L('还没有自选资产','Your watchlist is empty')}</strong><button type="button" class="dc-button" data-hub-add>${uiGlyph('plus')} ${L('搜索或粘贴 CA 添加','Search or paste a CA to add')}</button>`:read('assets').quality==='loading'?L('正在读取行情','Loading markets'):search?L('没有匹配资产','No matching assets'):L('行情暂不可用，请稍后重试','Markets are unavailable. Try again shortly.')}</div>`}</div>`:`<div class="hub-table-wrap" data-full="${fullTable}" role="region" aria-label="${L('热门资产，可横向滚动','Popular assets, scroll horizontally')}" tabindex="0"><table class="hub-table"><thead><tr><th></th><th>#</th><th>${L('资产','Asset')}</th>${[['price',L('价格','Price')],['change','24h'],['volume',L('成交额 / USD','Volume / USD')],['cap',L('市值 / USD','Market cap / USD')]].map(([key,label])=>`<th aria-sort="${sort===key?(sortDirection===-1?'descending':'ascending'):'none'}"><button type="button" data-hub-sort="${key}">${label}${sort===key?(sortDirection===-1?' ↓':' ↑'):''}</button></th>`).join('')}<th>7D</th><th>${L('7d 涨跌','7d change')}</th></tr></thead><tbody>${rows.map(assetRow).join('')}</tbody></table>${rows.length?'':`<div class="hub-empty">${scope==='watch'&&!assets().some(watched)?`<strong>${L('还没有自选资产','Your watchlist is empty')}</strong><button type="button" class="dc-button" data-hub-add>${uiGlyph('plus')} ${L('搜索或粘贴 CA 添加','Search or paste a CA to add')}</button>`:read('assets').quality==='loading'?L('正在读取行情','Loading markets'):search?L('没有匹配资产','No matching assets'):L('行情暂不可用，请稍后重试','Markets are unavailable. Try again shortly.')}</div>`}</div>`}`, 'assets',scopeButtons+compactScope+metadata+tools,'hub-asset-panel'+(cardView?' hub-card-mode':''));
 }

 function liquidity(){
  const stable=data('stablecoins'),tvl=data('tvl'),sChange=hubSeriesChange(stable,period),tChange=hubSeriesChange(tvl,period);
  return `<div class="hub-section-heading"><h2>${L('资金与流动性','Capital & liquidity')}</h2><div class="hub-segments" aria-label="${L('流动性周期','Liquidity window')}">${[7,30,90].map(d=>`<button type="button" data-hub-period="${d}" aria-pressed="${period===d}">${d}D</button>`).join('')}</div></div><div class="hub-two">${panel(L('稳定币供应量','Stablecoin supply')+' '+info(L('所有锚定币按来源的 USD 估值合计。供应变化不是交易所净买入，也不是 ETF 申赎。','All pegs use the source USD valuation. Supply changes are not exchange net buying or ETF subscriptions.')),`<div class="hub-chart-value">${stable?.length>1?'':`<strong>${hubMoney(stable?.at(-1)?.value)}</strong>`}${change(sChange?.percent)}<span>${period}D · ${L('净变化','Net change')} ${hubMoney(sChange?.delta)}</span></div>${chart('stable',stable?.slice(-period-1),'var(--chart-series-1)')}`,'stablecoins',null,'hub-liquidity-card')}${panel(L('DeFi 锁仓量','DeFi TVL')+' '+info(L('DefiLlama 全球历史 TVL，排除流动性质押及重复计数；与资产市值是不同指标。','DefiLlama historical global TVL excludes liquid staking and double counting. TVL is not market capitalization.')),`<div class="hub-chart-value">${tvl?.length>1?'':`<strong>${hubMoney(tvl?.at(-1)?.value)}</strong>`}${change(tChange?.percent)}<span>${period}D · ${L('变化','Change')} ${hubMoney(tChange?.delta)}</span></div>${chart('tvl',tvl?.slice(-period-1),'var(--chart-series-3)')}`,'tvl',null,'hub-liquidity-card')}</div>`;
 }
 function rankings(){
  const sectors=HUB_CATEGORIES.map(([id,name])=>{const c=data('categories')?.find(c=>c.id===id);return c?{...c,name}:null;}).filter(Boolean),chains=(data('chains')||[]).slice(0,6),venues=data('exchanges')||[],total=venues.reduce((sum,v)=>sum+v.volume,0);
  return `<div class="hub-three">${panel(L('赛道热度','Sector performance')+' '+info(L('赛道的市值与 24h 变化。不同赛道可能包含同一个资产，不能相加成全市场。','Category capitalization and 24h change. Categories overlap and cannot be summed as a market total.')),sectors.map((c,i)=>`<div class="hub-sector"><span style="--series:var(--chart-series-${i+1})"><i></i><b>${c.name}</b></span><strong>${hubMoney(c.cap)}</strong>${change(c.change)}</div>`).join('')||emptyRows('categories'),'categories')}${panel(L('公链流动性','Chain liquidity'),chains.map((c,i)=>`<div class="hub-rank-row"><span class="hub-rank">${i+1}</span><b>${esc(c.name)}</b><strong>${hubMoney(c.tvl)}</strong><div class="hub-meter"><i style="width:${Math.max(1,c.tvl/(chains[0]?.tvl||1)*100)}%;--series:var(--chart-series-${i%6+1})"></i></div></div>`).join('')||emptyRows('chains'),'chains')}${panel(L('交易平台','Trading venues')+' '+info(L('CoinGecko 当前平台样本，按 24h 现货成交量排序；占比仅针对样本内平台，成交量单位为 BTC。','CoinGecko venue sample, sorted by 24h spot volume. Shares cover the loaded venues only. Volume is in BTC.')),venues.slice(0,6).map((v,i)=>`<div class="hub-venue"><span>${venueIcon({venue_id:v.id,venue:v.name,image_url:v.image},{size:24})}<b>${esc(v.name)}</b></span><strong>${hubNumber(v.volume,0)} BTC</strong><small>${hubNumber(total?v.volume/total*100:null,1)}%</small></div>`).join('')||emptyRows('exchanges'),'exchanges')}</div>`;
 }
 function emptyRows(key){return `<div class="hub-empty">${read(key).quality==='loading'?L('正在读取数据','Loading data'):L('数据暂不可用','Data unavailable')}</div>`;}
 function venueList(){
  const rows=data('exchanges')||[],total=rows.reduce((sum,row)=>sum+row.volume,0);
  return panel(L('交易平台','Trading venues')+' '+info(L('数据来自 CoinGecko，按 24h 现货成交量排序。占比仅在当前加载的平台中计算，不代表全市场份额。','CoinGecko venue data, sorted by 24h spot volume. Shares cover the loaded venues, not the whole market.')),`<div class="hub-venue-table-head"><span>${L('平台','Venue')}</span><span>24h / BTC</span><span>${L('样本占比','Sample share')}</span></div><ol class="hub-venue-list">${rows.map(v=>`<li><div>${venueIcon({venue_id:v.id,venue:v.name,image_url:v.image},{size:28})}<span><b>${esc(v.name)}</b></span></div><strong>${hubNumber(v.volume,0)}</strong><span>${hubNumber(total?v.volume/total*100:null,1)}%<i style="--share:${total?v.volume/total*100:0}%"></i></span></li>`).join('')}</ol>${rows.length?'':emptyRows('exchanges')}`,'exchanges');
 }
 function heatmap(){return panel(L('资产涨跌热力图','Asset performance heatmap')+' '+info(L('当前加载资产的 24h 涨跌幅，格子等大；颜色深浅代表涨跌幅度，不代表市值。点击查看资产。','24h change across loaded assets. Equal tiles use color intensity for price change, not market capitalization. Select an asset to inspect it.')),`<div class="hub-heatmap">${assets().map(a=>{const q=getQuote(a);return link(icon(a)+`<b>${esc(a.symbol)}</b><strong data-hub-change="${esc(a.id)}">${change(q.change)}</strong>`,{asset:a.symbol,coin:a.id},'hub-tile').replace('<a ',`<a data-hub-tile="${esc(a.id)}" data-tone="${hubChangeTone(q.change)}" style="--strength:${Math.min(.3,.06+Math.abs(q.change||0)/100)}" `);}).join('')||emptyRows('assets')}</div>`,'assets');}
 function pulse(){
  const breadth=hubBreadth(data('assets')||[],getQuote);
  const bars=breadth.rows.map(({asset:a,change:delta,height})=>link(`<i style="height:${height}%"></i>`,{asset:a.symbol,coin:a.id},!Number.isFinite(delta)?'hub-missing':delta>0?'hub-positive':delta<0?'hub-negative':'hub-flat').replace('<a ',`<a data-hub-breadth="${esc(a.id)}" data-tip="${esc(a.symbol+' · '+(delta==null?'—':(delta>0?'+':'')+hubNumber(delta)+'%'))}" aria-label="${esc(a.symbol+' · '+price(getQuote(a).price)+' '+getQuote(a).quote+' · '+(delta==null?'—':hubNumber(delta)+'%'))}" `)).join('');
  return `<div class="hub-two hub-pulse-row">${panel(L('市场温度','Market breadth')+' '+info(L('已加载资产的 24h 涨跌幅：绿柱在 0 上方，红柱在 0 下方，柱高共用同一比例。','24h changes across loaded assets: gains above zero, losses below, on one shared scale.')),`<div class="hub-breadth-summary"><strong>${breadth.rows.length?breadth.up:'—'}<small> / ${breadth.rows.length||'—'}</small></strong><span>${L('资产上涨','assets rising')}</span><span>${breadth.down} ${L('下跌','falling')}${breadth.flat?' · '+breadth.flat+' '+L('持平','flat'):''}${breadth.missing?' · '+breadth.missing+' '+L('暂无涨跌','unavailable'):''}</span></div><div class="hub-breadth" role="group" aria-label="${L('24h 涨跌幅，以零为中轴','24h change above and below zero')}"><span class="hub-breadth-axis top">+${hubNumber(breadth.limit)}%</span><span class="hub-breadth-axis zero">0</span><span class="hub-breadth-axis bottom">−${hubNumber(breadth.limit)}%</span><div class="hub-breadth-bars">${bars}</div><div class="hub-breadth-tooltip" id="hub-breadth-tooltip" role="tooltip" hidden></div></div><output class="hub-breadth-readout" data-hub-breadth-point></output>`,'assets')}${panel(L('行情变化','Market updates'),`${feedHeader()}<ol class="hub-feed" data-hub-feed>${eventRows()}</ol>`,'tickers')}</div>`;
 }
 function eventRows(){
  const a=selectedAsset();
  if(param('asset')&&(!a||HUB_ASSET_IDS[a.symbol]!==a.id))return `<li class="hub-feed-wait hub-feed-snapshot">${L('该资产当前仅提供定时快照','This asset currently has polling snapshots only')}</li>`;
  return hubFeedRows(a?client.events.filter(event=>event.symbol===a.symbol):client.events);
 }

 function headerSourceInfo(){
  const s=read('assets'),b=s.snapshot,status=s.quality==='loading'?L('正在读取','Loading'):s.quality==='unavailable'?L('暂无可用数据','Data unavailable'):s.error||s.quality==='stale'?L('较早数据','Older data'):L('已更新','Updated');
  return info(HUB_RESOURCES.assets.provider+' · '+L('数据时间','Data time')+' '+formatDataTime(b?.asOf)+' · '+L('获取时间','Retrieved at')+' '+formatDataTime(b?.receivedAt)+' · '+status,L('数据来源与时间','Source and time')).replace('class="dc-info"','class="dc-info data-header-info"');
 }
 function header(title){
  return `<header class="p-head hub-head"><div><h1>${title}</h1><span class="hub-state" data-hub-status hidden></span></div><div class="p-actions hub-actions">${dataRefreshControls({scope:'hub',seconds:refreshSeconds,intervals:HUB_REFRESH_SECONDS,busy:refreshing})}${headerSourceInfo()}<button type="button" class="dc-button" data-hub-ask aria-label="${L("问 AI","Ask AI")}">${uiGlyph('chat')} ${L('问 AI','Ask AI')}</button></div></header>`;
 }
 function sourceDetails(){return `<footer class="hub-source-footer"><details class="hub-sources"><summary>${L('数据来源','Data sources')}</summary><div>${Object.entries(HUB_RESOURCES).map(([key,p])=>{const s=read(key),at=s.snapshot?.asOf??s.snapshot?.receivedAt;return `<section><b>${esc(s.snapshot?.provider??p.provider)} · ${resourceLabel(key)}</b><span>${L('来源时间','Source time')}: ${s.snapshot?.asOf?hubSourceTime(at,key):L('来源未提供时间，显示获取时间','Source time unavailable; retrieval time shown')}</span><span>${L('获取时间','Retrieved at')}: ${s.snapshot?formatDataTime(s.snapshot.receivedAt):'—'}</span><span title="${esc(s.detail||'')}">${s.error?errorLabel(s.error)+(s.retryIn?' · '+s.retryIn+'s':''):s.quality==='stale'?L('较早数据','Older data'):L('自动更新','Auto updates')+' · '+refreshSeconds+'s'}</span></section>`;}).join('')}</div></details><a class="hub-credit" href="https://www.coingecko.com/en/api" target="_blank" rel="noopener noreferrer">Powered by CoinGecko API ↗</a><a class="hub-credit" href="https://coinmarketcap.com/api/" target="_blank" rel="noopener noreferrer">Powered by CoinMarketCap API ↗</a></footer>`;}
 function graphOverview(){
  const g=data('global'),shares=hubMarketShares(g),listing=read('assets').snapshot;
  const historyView=hourly.read(performanceWindow),rows=historyView.rows;
  const sent=data('sentiment')||[],fear=sent.at(-1),history=sent.slice(-30);
  if(rows.length&&rows.every(r=>hiddenSeries.has(r.symbol)))hiddenSeries.delete(rows[0].symbol);
  heroModels={performance:{rows,hidden:hiddenSeries,window:performanceWindow},shares,sentiment:sent};
  const daily=historyView.stepMs===86400000,interval=daily?L('日线收盘','Daily closes'):L('小时价格','Hourly prices');
  const plot=(kind,label)=>`<div class="hub-plot hub-${kind}-plot" data-hub-plot="${kind}" role="group" tabindex="0" aria-label="${esc(label+' · '+L('方向键查看数据','Arrow keys explore data'))}"></div>`;
  const visible=rows.filter(r=>!hiddenSeries.has(r.symbol));
  const legend=rows.map(r=>`<button type="button" data-hub-series="${r.symbol}" aria-pressed="${!hiddenSeries.has(r.symbol)}" ${visible.length===1&&visible[0]===r?'disabled':''} style="--series:var(--chart-series-${r.color+1})"><i></i><b>${r.symbol}</b>${change(r.values.at(-1)[1])}</button>`).join('');
  const windowTabs=`<div class="hub-segments hub-performance-windows" role="group" aria-label="${L('走势周期','Performance window')}">${performanceWindows.map(w=>`<button type="button" data-hub-window="${w}" aria-pressed="${performanceWindow===w}">${w}</button>`).join('')}</div>`;
  const tools=`<div class="hub-plot-tools"><output data-hub-window-label aria-live="off"></output><div class="hub-segments" aria-label="${L('图表缩放','Chart zoom')}"><button type="button" data-hub-zoom="out" aria-label="${L('缩小对比图','Zoom out comparison')}">−</button><button type="button" data-hub-reset aria-label="${L('复位对比图','Reset comparison')}" disabled>${L('复位','Reset')}</button><button type="button" data-hub-zoom="in" aria-label="${L('放大对比图','Zoom in comparison')}">+</button></div></div>`;
  const summary=rows.map(r=>r.symbol+' '+hubNumber(r.values.at(-1)[1])+'%').join(', ');
  const stamp=historyView.endAt?new Date(historyView.endAt).toISOString():'';
  const windowReturn={ '24h':'change','7d':'change7d' }[performanceWindow];
  const returns=windowReturn?(listing?.data||[]).filter(a=>['bitcoin','ethereum','solana'].includes(a.id)&&Number.isFinite(a[windowReturn])):[];
  const unavailable=daily?L('日线收盘价暂不可用','Daily closes are unavailable'):L('小时价格暂不可用','Hourly prices are unavailable');
  const fallback=historyView.loading?(daily?L('正在读取日线收盘价…','Loading daily closes…'):L('正在读取小时价格…','Loading hourly prices…')):unavailable;
  const snapshots=!historyView.loading&&returns.length?`<small>${esc(listing?.provider||'')} · ${performanceWindow} ${L('涨跌幅','return')}</small><div class="hub-period-returns">${returns.map(a=>`<span><b>${esc(a.symbol)}</b> ${change(a[windowReturn])}</span>`).join('')}</div>`:'';
  const missing=['BTC','ETH','SOL'].filter(symbol=>!rows.some(row=>row.symbol===symbol));
  const partial=rows.length&&!historyView.loading&&missing.length?`<small class="hub-history-missing">${missing.join(' · ')} · ${unavailable}</small>`:'';
  const performanceBody=rows.length?plot('performance',performanceWindow+' · '+summary)+tools+`<div class="hub-performance-legend" aria-label="${L('切换图表资产','Toggle chart assets')}">${legend}</div>`
   :`<div class="hub-empty hub-period-empty" role="status" aria-busy="${historyView.loading}"><span>${fallback}</span>${snapshots}</div>`;
  const historyStatus=historyView.stale?L('较早数据','Older data'):historyView.loading?L('更新中','Updating'):'';
  const footer=stamp?`<footer class="hub-graph-source hub-performance-source"><span>${esc(historyView.source)} · ${esc(historyView.currency)} · ${interval}</span><time datetime="${stamp}">${stamp.slice(0,16).replace('T',' ')} UTC</time>${historyStatus?`<span class="hub-history-missing" role="status">${historyStatus}</span>`:''}</footer>`:'';
  const performance=panel(L('主流资产走势','Major asset performance')+' '+info(L('各资产以同一周期起点的实测价格为基准。缩放只改变可见区间，图例显示所选时刻的累计涨跌幅。','Each asset starts at 0% at the same observation time. Zoom keeps that baseline. The legend shows the return at the inspected time.')),
   performanceBody+partial+footer,'assets',windowTabs,'hub-performance-card');
  return `<div class="hub-market-summary"><dl><div><dt>${L('总市值','Market cap')}</dt><dd>${hubMoney(g?.cap)} ${change(g?.change)}</dd></div><div><dt>${L('24h 成交额','24h volume')}</dt><dd>${hubMoney(g?.volume)} ${g?.volumeChange!=null?change(g.volumeChange):''}</dd></div></dl>${source('global')}</div><span class="sr-only" data-hub-chart-announcement aria-live="polite"></span><div class="hub-overview-charts">${performance}${panel(L('市值结构','Market composition')+' '+info(L('全市场市值占比。其它包含稳定币及其余加密资产；不是前 50 个资产的样本占比。','Global market capitalization shares. Other includes stablecoins and remaining cryptoassets, not just the loaded top-50 sample.')),`${shares.length?`<div class="hub-donut-wrap">${plot('shares',shares.map(s=>s.name+' '+hubNumber(s.value)+'%').join(', '))}<div class="hub-donut-center"><strong>${hubNumber(g.btcShare,1)}<small>%</small></strong><span>${L('BTC 占比','BTC dominance')}</span></div></div><ul class="hub-share-legend">${shares.map((s,i)=>`<li><i style="--series:var(--chart-series-${i+1})"></i>${['BTC','ETH'].includes(s.name)?link(s.name,{asset:s.name,coin:s.name==='BTC'?'bitcoin':'ethereum'},'hub-share-link').replace('<a ',`<a data-hub-share="${s.name}" `):`<span>${s.name}</span>`}<b>${hubNumber(s.value)}%</b></li>`).join('')}</ul>`:emptyRows('global')}<footer class="hub-graph-source">${source('global')}</footer>`,'global','','hub-composition-card')}${panel(L('恐慌与贪婪','Fear & Greed')+' '+info(L('Alternative.me 的比特币情绪指数，0–100，每日更新。底部曲线是最近 30 个日度样本；不是 RSI 或实时交易信号。','Alternative.me daily Bitcoin sentiment, 0–100. The lower line shows the latest 30 daily samples. This is not RSI or a live trading signal.')),`${fear?plot('sentiment',L('情绪指数','Sentiment index')+' '+fear.value+' / 100 · '+date(fear.at)):emptyRows('sentiment')}<div class="hub-sentiment-history"><span data-hub-sentiment-point>${L('近 30 日情绪','30-day sentiment')}</span><span>${history.length?date(history[0].at).slice(5)+' — '+date(fear.at).slice(5):'—'}</span></div><footer class="hub-graph-source">${source('sentiment')}</footer>`,'sentiment','','hub-sentiment-card')}</div>`;
 }
 function overview(){
  const rwa=data('categories')?.find(c=>c.id==='real-world-assets-rwa');
  return header(L('市场总览','Market overview'))+graphOverview()+pulse()+liquidity()+`<div class="hub-section-heading"><h2>${L('赛道与平台','Sectors & platforms')}</h2><span>${L('RWA 市值','RWA market cap')} ${hubMoney(rwa?.cap)} ${change(rwa?.change)}</span></div>`+rankings()+assetTable()+`<div class="hub-research-links"><b>${L('继续研究','Keep researching')}</b><a data-dc-link href="?page=tracking">${L('链上指标','On-chain metrics')} ${uiGlyph('arrow')}</a><a data-dc-link href="?page=intelligence">${L('新闻舆情','News & sentiment')} ${uiGlyph('arrow')}</a><a href="https://cn.rootdata.com/fundraising" target="_blank" rel="noopener noreferrer">${L('项目融资','Project funding')} ↗</a><a href="https://cn.rootdata.com/token-unlocks" target="_blank" rel="noopener noreferrer">${L('代币解锁','Token unlocks')} ↗</a></div>`+sourceDetails();
 }
 function detail(){
  const a=selectedAsset();
  if(!a)return header(esc(param('asset')))+`<div class="hub-empty hub-detail-empty">${emptyRows('assets')}${link(L('返回市场总览','Back to market overview'))}</div>`+sourceDetails();
  if(a.address)return contractDetail(a);
  const q=getQuote(a),spark=a.series.map((value,i)=>({value,at:a.asOf-(a.series.length-1-i)*3600000}));
  return header(icon(a)+' '+esc(a.symbol)+`<small>${esc(a.name)}</small>`)+`<div class="hub-detail-toolbar"${atlasAttr(a)}>${link('← '+L('市场总览','Market overview'))}<span><span data-hub-quote-provider>${q.provider} / ${q.quote}</span> · <time data-hub-quote-time>${formatDataTime(q.asOf)}</time></span><button type="button" class="dc-button" data-hub-watch="${esc(a.id)}">${watched(a)?L('已加入自选','On watchlist'):L('加入自选','Add to watchlist')}</button></div><section class="hub-detail-price"><strong>${quoteCell(a)}</strong><div data-hub-change="${esc(a.id)}">${change(q.change)}</div><span>24h</span></section><div class="hub-kpis hub-detail-kpis">${stat(L('市值 / USD','Market cap / USD'),hubMoney(a.cap))}${stat(L('24h 成交额 / USD','24h volume / USD'),hubMoney(a.volume))}${stat(L('24h 最高 / USD','24h high / USD'),hubMoney(a.high))}${stat(L('24h 最低 / USD','24h low / USD'),hubMoney(a.low))}</div>${hubCandleIdentity(a)?tradingChartPanel('hub-asset-candles',{...hubCandleIdentity(a),hostedMarket:true}):''}${hubCandleIdentity(a)?`<details class="hub-candle-history"><summary>${L('7日汇总报价走势','7d aggregate price history')}</summary>`:''}${panel(L('7d 价格走势','7d price history')+' '+info(L('CoinGecko 返回的 7d 小时价格样本，时间坐标按末次报价和每小时样本间隔重建，属于近似时间。即时价格单独来自已标明的交易所报价，不改写历史采样点。','CoinGecko 7d hourly samples. Approximate timestamps are reconstructed from the latest quote and hourly spacing. Live venue prices do not overwrite history samples.')),chart(a.symbol,spark,'var(--chart-series-1)'),'assets')}${hubCandleIdentity(a)?'</details>':''}<div class="hub-two">${panel(L('观察重点','What to watch'),`<dl class="hub-facts"><div><dt>${L('24h 涨跌','24h change')}</dt><dd data-hub-change="${esc(a.id)}">${change(q.change)}</dd></div><div><dt>${L('7d 涨跌','7d change')}</dt><dd>${change(a.change7d)}</dd></div><div><dt>${L('报价来源','Price source')}</dt><dd data-hub-quote-provider>${q.provider} / ${q.quote}</dd></div><div><dt>${L('最近报价','Latest quote')}</dt><dd data-hub-quote-time>${formatDataTime(q.asOf)}</dd></div>${atlasMarketFeed(a)?`<div><dt>${atlasLabel()}</dt><dd>${atlasField(a)}</dd></div>`:''}</dl><button class="dc-button" type="button" data-hub-ask>${uiGlyph('chat')} ${L("分析数据","Analyze data")}</button>`,'assets')}${panel(L('行情变化','Market updates'),`${feedHeader()}<ol class="hub-feed" data-hub-feed>${eventRows()}</ol>`,'tickers',`<span class="hub-stream-state" data-hub-stream></span>`)}</div>`+sourceDetails();
 }
 function contractDetail(a){
  const q=getQuote(a);
  return header(icon(a)+' '+esc(a.symbol)+`<small>${esc(a.name)}</small>`)+`<div class="hub-detail-toolbar"${atlasAttr(a)}>${link('← '+L('我的自选','My watchlist'),{view:'watchlist'})}<button type="button" class="dc-button" data-hub-watch="${esc(a.id)}">${watched(a)?L('已加入自选','On watchlist'):L('加入自选','Add to watchlist')}</button></div><div class="hub-contract"><b>${esc(watchChain(a.chain))}</b><code>${esc(a.address)}</code></div><section class="hub-detail-price"><strong>${quoteCell(a)}</strong>${change(q.change)}<span>24h</span>${info(quoteSource(a,q),a.symbol+' · '+L('数据来源与时间','Source and time'))}</section><div class="hub-kpis">${stat(L('市值 / USD','Market cap / USD'),hubMoney(a.cap))}${stat(L('24h 成交额 / USD','24h volume / USD'),hubMoney(a.volume))}${stat(L('池内流动性 / USD','Pool liquidity / USD'),hubMoney(a.liquidity))}${stat(L('交易平台','Trading venue'),esc(a.venue))}</div><button type="button" class="dc-button" data-hub-ask>${uiGlyph('chat')} ${L("分析数据","Analyze data")}</button>`;
 }
 function refreshAtlasPrices(){
  if(typeof window==='undefined'||!enabled||document.hidden||atlasController||Date.now()-atlasPriceAt<Math.max(30000,refreshSeconds*1000))return;
  atlasPriceAt=Date.now();
  const request=new AbortController();atlasController=request;
  fetch('/api/atlas/prices',{credentials:'omit',cache:'no-store',signal:request.signal}).then(response=>response.ok?response.json():null).then(body=>{
   if(!enabled||request.signal.aborted||!body?.prices)return;
   atlasPrices=body.prices;patchAtlas();
  }).catch(()=>{}).finally(()=>{if(atlasController===request)atlasController=null;});
 }
 function refreshHourly(force=false){
  const overview=!param('asset')&&(!param('view')||param('view')==='overview');
  if(enabled&&typeof document!=='undefined'&&!document.hidden&&overview)return hourly.refresh(force,performanceWindow);
  hourly.suspend();
 }
 function sync(page){
  const active=hubOwnsRoute(page,location.search);
  if(active&&!enabled){dataVersion=resourceVersion();lastAutoPaint=-Infinity;}
  if(!active&&enabled){cancelPaint();needsPaint=userPaint=false;charts.dispose();watchController?.abort();atlasController?.abort();atlasController=null;atlasPriceAt=0;}
  enabled=active;if(!enabled)hourly.suspend();client.setActive(enabled&&typeof document!=='undefined'&&!document.hidden);
  if(enabled)refreshAtlasPrices();
  return enabled;
 }
 function render(page){
  rememberView();
  if(!sync(page))return null;
  const list=assets(),iconKey=String(read('assets').snapshot?.receivedAt)+'|'+watchRows.map(a=>a.id+':'+(a.asOf??a.receivedAt)).join(',');if(iconKey!==lastIcons){registerTokenMetadata(list.map(a=>({asset_id:a.id,symbol:a.symbol,chain_id:a.chain,address:a.address,image_url:a.image})));lastIcons=iconKey;}
  const view=param('view')||'overview';if(view!==lastView){scope=view==='watchlist'?'watch':'all';sort=view==='ranking'?'change':'cap';sortDirection=-1;lastView=view;}
  const tabs=`<nav class="hub-nav" aria-label="${L('行情视图','Market views')}">${[['overview',L('总览','Overview')],['ranking',L('涨跌榜','Movers')],['heatmap',L('热力图','Heatmap')],['exchanges',L('交易平台','Trading venues')],['watchlist',L('自选','Watchlist')]].map(([id,title])=>link(title,id==='overview'?{}:{view:id},!param('asset')&&view===id?'selected':'')).join('')}${link(L('传统资产','Traditional assets'),{asset:'SPX'})}</nav>`;
  const content=param('asset')?detail():view==='overview'?overview():header(L('市场行情','Market data'))+(view==='exchanges'?venueList():view==='heatmap'?heatmap():assetTable())+sourceDetails();
  return `<div class="dc-root market-hub" data-data-center="markets" data-public-data="hub" data-hub-layout="${esc(viewKey())}">${tabs}${content}</div>`;
 }
 function patchStatus(){
  if(!enabled||!root.querySelectorAll)return;
  const s=read('assets'),failed=Object.keys(HUB_RESOURCES).filter(key=>read(key).error).length,status=s.quality==='unavailable'?L('行情暂不可用','Markets unavailable'):failed?L('部分数据未更新','Some data could not update')+' · '+failed:'';
  for(const el of root.querySelectorAll('[data-hub-status],[data-hub-stream]')){el.hidden=!status;el.textContent=status;el.dataset.state='warning';}
  const button=root.querySelector('[data-hub-refresh]');
  if(button){button.disabled=refreshing;button.setAttribute('aria-busy',String(refreshing));const label=button.querySelector('[data-hub-refresh-label]');if(label)label.textContent=refreshing?L('刷新中','Refreshing'):L('刷新','Refresh');}
 }
 async function refreshNow(){
  if(refreshing)return;const focused=document.activeElement===root.querySelector('[data-hub-refresh]');refreshing=true;patchStatus();
  try{
   const [result,watchResult]=await Promise.all([client.refresh(),refreshWatch(true),refreshHourly(true)]);
   if(watchResult.failed&&result.status==='complete')result.status='partial';
   if(!enabled||result.status==='cancelled')return;
   if(needsPaint&&result.status!=='cooldown'){cancelPaint();queuePaint();}
   notify(result.status==='complete'?L('刷新完成','Refresh complete'):result.status==='cooldown'?L('请在','Try again in')+' '+result.retryIn+' '+L('秒后重试','seconds'):result.status==='partial'?L('部分数据未更新，已保留上次结果','Some sources could not update; previous data retained'):result.status==='failed'?L('暂时无法更新，已保留上次数据','Unable to update; previous data retained'):L('返回行情页后重试','Return to markets to retry'));
  }catch{if(enabled)notify(L('刷新失败，请重试','Refresh failed. Try again.'));}
  finally{refreshing=false;patchStatus();if(focused&&enabled&&document.activeElement===document.body)root.querySelector('[data-hub-refresh]')?.focus({preventScroll:true});}
 }
 function patchPrices(){
  if(!enabled)return;
  const selected=param('asset')?selectedAsset():null;
  for(const a of assets()){
   const q=getQuote(a);
   for(const el of root.querySelectorAll(`[data-hub-price="${CSS.escape(a.id)}"]`)){
    el.title=quoteTitle(a,q);if(el.dataset.price===String(q.price))continue;const old=Number(el.dataset.price);el.dataset.price=String(q.price);el.textContent=price(q.price);
    if(Number.isFinite(old)&&document.documentElement.dataset.reducedMotion!=='true'&&!matchMedia('(prefers-reduced-motion:reduce)').matches)el.animate([{opacity:.45},{opacity:1}],{duration:180,easing:'ease-out'});
   }
   for(const el of root.querySelectorAll(`[data-hub-unit="${CSS.escape(a.id)}"]`))if(el.textContent!==q.quote)el.textContent=q.quote;
   for(const el of root.querySelectorAll(`[data-hub-change="${CSS.escape(a.id)}"]`)){const html=change(q.change);if(el.innerHTML!==html)el.innerHTML=html;}
   for(const [key,value]of [['volume',hubMoney(q.volume).replace('$','')],['volume-unit',q.quote],['quote-source',quoteSource(a,q)+' · '+q.quote]])for(const el of root.querySelectorAll(`[data-hub-card-${key}="${CSS.escape(a.id)}"]`))if(el.textContent!==value)el.textContent=value;
   for(const el of root.querySelectorAll(`[data-hub-tile="${CSS.escape(a.id)}"]`)){el.dataset.tone=hubChangeTone(q.change);el.style.setProperty('--strength',Math.min(.3,.06+Math.abs(q.change||0)/100));}
   if(a.id===selected?.id){
    for(const el of root.querySelectorAll('[data-hub-quote-time]'))el.textContent=formatDataTime(q.asOf);
    for(const el of root.querySelectorAll('[data-hub-quote-provider]'))el.textContent=q.provider+' / '+q.quote;
   }
  }
  patchAtlas();
  const eventVersion=String(client.events[0]?.id||0);
  for(const el of root.querySelectorAll('[data-hub-feed]'))if(el.dataset.eventVersion!==eventVersion&&!el.matches(':hover')&&!el.contains(document.activeElement)){el.innerHTML=eventRows();el.dataset.eventVersion=eventVersion;}
  patchStatus();
 }
 // Quote excerpts stay separate from the assistant's demo candle analysis.
 function sourceSnapshot(){
  const a=selectedAsset(),rows=a?[a]:param('asset')?[]:tableRows().slice(0,8);
  const stamp=at=>Number.isFinite(at)?new Date(at).toISOString():'—',times=(asOf,receivedAt)=>`${L('数据时间','Data time')}: ${stamp(asOf)}; ${L('获取时间','Retrieved at')}: ${stamp(receivedAt)}`;
  return {id:'public-market:'+location.search,title:a?a.symbol+' · '+L('公开行情','Public markets'):L('市场总览','Market overview'),text:rows.map(a=>{const q=getQuote(a),receivedAt=a.receivedAt??(a.address?null:read('assets').snapshot?.receivedAt);return `${a.symbol}: ${q.price??'—'} ${q.quote}; ${a.address?'chain='+a.chain+'; contract='+a.address+'; venue='+(a.venue||'—'):'assetId='+a.id+'; '+(q.provider==='Binance Spot'?'market='+a.symbol+'/USDT; venue=binance; type=SPOT':'market=aggregate; quote=USD')}; 24h ${q.change??'—'}%; ${q.provider}; ${times(q.asOf,q.receivedAt??receivedAt)}\n${L('市值','Market cap')}: ${a.cap??'—'} USD; ${a.address?'DEX Screener':esc(a.provider||HUB_RESOURCES.assets.provider)}; ${times(a.asOf,receivedAt)}`;}).join('\n\n'),href:routeSearch(),kind:'excerpt'};
 }
 function bind(){
  if(!root.querySelector('.market-hub'))return;
  refreshHourly();
  const memory=viewMemory.get(viewKey());if(memory)for(const el of root.querySelectorAll('.hub-table-wrap,.hub-kpis,.hub-nav'))el.scrollLeft=memory.scrolls.get(el.className)||0;
  const refresh=root.querySelector('[data-hub-refresh]');
  refresh?.addEventListener('pointerdown',event=>{if(event.button===0&&document.activeElement===root.querySelector('[data-hub-search]'))event.preventDefault();});
  refresh?.addEventListener('click',refreshNow);
  root.querySelector('[data-hub-interval]')?.addEventListener('change',event=>{
   try{const value=parseHubRefreshSeconds(event.target.value);localStorage.setItem('hive.market.refreshSeconds',String(value));applyRefreshInterval(value);window.dispatchEvent(new CustomEvent('hive:market-refresh-interval',{detail:{seconds:value}}));notify(L('自动刷新：','Auto refresh: ')+value+' '+L('秒','seconds'));}
   catch{event.target.value=String(refreshSeconds);notify(L('设置未保存，请重试','Settings could not be saved. Try again.'));}
  });
  root.querySelectorAll('[data-hub-ask]').forEach(b=>b.onclick=()=>{const source=sourceSnapshot();if(source.text)onAskSource(source);else notify(L('数据还未加载，请稍后再试','Data has not loaded yet. Try again shortly.'));});
  root.querySelectorAll('[data-hub-period]').forEach(b=>b.onclick=()=>{period=Number(b.dataset.hubPeriod);schedule(true);});
  root.querySelectorAll('[data-hub-window]').forEach(b=>b.onclick=()=>{const next=b.dataset.hubWindow;if(next===performanceWindow)return;performanceWindow=next;refreshHourly();schedule(true);});
  root.querySelectorAll('[data-hub-series]').forEach(b=>b.onclick=()=>{const symbol=b.dataset.hubSeries;hiddenSeries.has(symbol)?hiddenSeries.delete(symbol):hiddenSeries.add(symbol);schedule(true);});
  root.querySelectorAll('[data-hub-sort]').forEach(b=>b.onclick=()=>{const key=b.dataset.hubSort;sortDirection=sort===key?-sortDirection:-1;sort=key;schedule(true);});
  root.querySelectorAll('[data-hub-scope]').forEach(b=>b.onclick=()=>{scope=b.dataset.hubScope;schedule(true);});
  const scopeSelect=root.querySelector('[data-hub-scope-select]');if(scopeSelect)scopeSelect.onchange=()=>{scope=scopeSelect.value==='watch'?'watch':'all';schedule(true);};
  const sortSelect=root.querySelector('[data-hub-sort-select]');if(sortSelect)sortSelect.onchange=()=>{const key=sortSelect.value;if(!['cap','change','price','volume'].includes(key))return;sortDirection=sort===key?sortDirection:-1;sort=key;schedule(true);};
  root.querySelector('[data-hub-full]')?.addEventListener('click',()=>{fullTable=!fullTable;schedule(true);});
  root.querySelectorAll('[data-hub-display]').forEach(b=>b.onclick=()=>{const next=b.dataset.hubDisplay==='table';if(fullTable!==next){fullTable=next;schedule(true);}});
  root.querySelectorAll('[data-hub-add]').forEach(button=>button.onclick=()=>document.dispatchEvent(new CustomEvent('hive:navigate',{detail:'watchlist'})));
  root.querySelectorAll('[data-hub-watch]').forEach(b=>b.onclick=async()=>{const a=assets().find(a=>a.id===b.dataset.hubWatch);if(!a)return;try{const remove=watched(a);await saveWatch(a,remove);notify(a.symbol+' '+(remove?L('已移出自选','removed from watchlist'):L('已加入自选','added to watchlist')));}catch(e){notify(e.message||L('浏览器暂时无法保存','Browser storage is unavailable'));}});
  const input=root.querySelector('[data-hub-search]');if(input){
   const previous=memory?.input;
   if(previous?.value===input.value){
    if(previous.focused&&(document.activeElement===document.body||document.activeElement===input))input.focus({preventScroll:true});
    if(previous.start!==null&&previous.end!==null)input.setSelectionRange(previous.start,previous.end,previous.direction);
   }
   bindSearchRender(input,value=>{search=value;},()=>{const y=root.scrollTop;rerender();root.scrollTop=y;return root.querySelector('[data-hub-search]');});
  }
  const breadthReadout=root.querySelector('[data-hub-breadth-point]'),breadthTip=root.querySelector('.hub-breadth-tooltip'),breadthPlot=root.querySelector('.hub-breadth');
  const breadthBars=[...root.querySelectorAll('[data-hub-breadth]')];
  const hideBreadth=()=>{if(breadthTip)breadthTip.hidden=true;breadthBars.forEach(b=>{b.removeAttribute('aria-describedby');delete b.dataset.active;});};
  breadthBars.forEach(bar=>{
   const inspect=()=>{
    const a=assets().find(a=>a.id===bar.dataset.hubBreadth);if(!a||!breadthReadout||!breadthTip||!breadthPlot)return;
    const q=getQuote(a);hideBreadth();bar.dataset.active='true';bar.setAttribute('aria-describedby','hub-breadth-tooltip');
    breadthReadout.innerHTML=link(esc(a.symbol)+' '+uiGlyph('arrow'),{asset:a.symbol,coin:a.id},'hub-breadth-detail')+'<span>'+price(q.price)+' '+esc(q.quote)+' · '+change(q.change)+'</span>';
    breadthTip.innerHTML='<div><b>'+esc(a.symbol)+'</b><span>24h '+change(q.change)+'</span></div><strong>'+price(q.price)+' <small>'+esc(q.quote)+'</small></strong><small>'+esc(q.provider)+' · '+clock(q.asOf)+'</small>';
    breadthTip.hidden=false;
    const bounds=breadthPlot.getBoundingClientRect(),point=bar.getBoundingClientRect();
    const x=point.left-bounds.left+point.width/2-breadthTip.offsetWidth/2;
    breadthTip.style.left=Math.max(4,Math.min(bounds.width-breadthTip.offsetWidth-4,x))+'px';
    const mark=bar.querySelector('i').getBoundingClientRect(),y=(q.change>0?mark.top:mark.bottom)-bounds.top;
    breadthTip.style.top=Math.max(4,Math.min(bounds.height-breadthTip.offsetHeight-4,y-breadthTip.offsetHeight-12))+'px';
   };
   bar.addEventListener('pointerenter',inspect);bar.addEventListener('focus',inspect);
   bar.addEventListener('pointerleave',()=>{if(bar.dataset.inspected!=='true'&&document.activeElement!==bar)hideBreadth();});
   bar.addEventListener('blur',hideBreadth);
   bar.addEventListener('keydown',ev=>{if(ev.key==='Escape'){delete bar.dataset.inspected;hideBreadth();}});
   bar.addEventListener('click',ev=>{if(matchMedia('(hover:none)').matches&&bar.dataset.inspected!=='true'){ev.preventDefault();ev.stopPropagation();breadthBars.forEach(b=>delete b.dataset.inspected);bar.dataset.inspected='true';inspect();}});
  });
  patchStatus();
  charts.mount(root,heroModels);
 }
 return {render,bind,sync,capture:rememberView,previewAsset:(target,signal)=>readRelatedAsset(target,{rows:assets(),quote:getQuote,signal}),tick(){if(!enabled)return;client.setActive(!document.hidden);if(document.hidden)watchController?.abort();client.tick();refreshWatch();refreshHourly();refreshAtlasPrices();if(Date.now()-lastPaint>1000){lastPaint=Date.now();patchPrices();if(needsPaint)schedule();}},sourceSnapshot,
  companionBrief(cursor=0){
   if(!enabled)return null;
   const rows=assets(),requested=param('asset'),a=requested?selectedAsset():rows[Math.max(0,cursor)%Math.max(1,rows.length)];
   if(!a){const loading=read('assets').quality==='loading';return {kind:'data',label:L('公开行情','Public markets'),title:requested?requested+' · '+L('暂无行情','No quote available'):loading?L('正在连接数据源','Connecting market sources'):L('行情暂不可用','Markets unavailable'),body:requested?L('当前来源未覆盖该资产。','This asset is not covered by the current source.'):loading?L('正在读取公开行情。','Loading public market data.'):L('稍后重试。','Try again shortly.'),visual:'',href:'?page=markets',action:L('查看市场总览','View market overview'),source:(read('assets').snapshot?.provider??HUB_RESOURCES.assets.provider)+' / Binance',timestamp:null,modeLabel:L('公开数据','Public data')};}
   const q=getQuote(a);return {kind:'data',label:L('公开行情','Public markets'),title:a.symbol+' · '+price(q.price)+' '+q.quote,body:L('24h 变化','24h change')+' '+hubNumber(q.change)+'% · '+q.provider,visual:'',href:'?'+new URLSearchParams({page:'markets',asset:a.symbol,coin:a.id}),action:L('查看数据','View data'),source:q.provider,timestamp:a.address?L('获取时间','Retrieved at')+' '+formatDataTime(q.receivedAt):formatDataTime(q.asOf),modeLabel:L('公开数据','Public data')};
  },client};
}
