import {tokenIcon} from './brand-icons.mjs';
import {liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';
import {pair as L} from './locale.mjs';
import {publicRetryDelay} from './public-data-client.mjs';

const minute=60_000;
const markets={SPX:['标普 500','S&P 500'],XAU:['现货黄金','Spot gold'],DXY:['美元指数','US Dollar Index'],US10Y:['美国十年期国债','US 10Y Treasury']};

export function createIntelligenceContext({fetchImpl=globalThis.fetch,now=Date.now,onChange=()=>{}}={}){
 const slots=Object.fromEntries(['calendar',...Object.keys(markets)].map(key=>[key,{
  route:key==='calendar'?liveDataRoute('intelligence','view=calendar'):liveDataRoute('markets','asset='+key),
  due:0,failures:0,receipt:null,controller:null
 }]));
 const status=s=>({snapshot:s.receipt?.body??null,pending:!!s.controller,
  stale:!!s.receipt&&(!!s.failures||now()>=s.receipt.validUntil||globalThis.navigator?.onLine===false)});
 const read=()=>({calendar:status(slots.calendar),quotes:Object.fromEntries(Object.keys(markets).map(key=>[key,status(slots[key])]))});
 async function update(s,force){
  if(s.controller||now()<s.due&&(s.failures||!force))return;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(14_000)]);
  s.controller=controller;
  let retry=0;
  try{
   const {route}=s,url='/api/market-hub?'+new URLSearchParams({resource:route.resource,...route.query});
   const response=await fetchImpl(url,{headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'error',signal});
   retry=publicRetryDelay(response.headers?.get('Retry-After'),now())??0;
   if(!response.ok)throw Error('SOURCE_UNAVAILABLE');
   const text=await response.text();
   if(text.length>1_000_000||signal.aborted)throw Error('INVALID_DATA');
   const receipt=validateLiveDataResponse(JSON.parse(text),route,now());
   if(s.controller!==controller)return;
   s.receipt=receipt;s.failures=0;
   s.due=now()+Math.max(route.interval,15*minute,retry);
  }catch{
   if(s.controller!==controller)return;
   s.failures++;
   s.due=now()+Math.max(retry,minute*2**Math.min(s.failures-1,4));
  }finally{
   if(s.controller===controller){s.controller=null;onChange();}
  }
 }
 function cancel(){
  for(const s of Object.values(slots)){
   const controller=s.controller;s.controller=null;controller?.abort();
  }
 }
 function tick(active,force=false){
  if(!active||globalThis.document?.hidden||globalThis.navigator?.onLine===false){cancel();return;}
  return Promise.all(Object.values(slots).map(s=>update(s,force)));
 }
 return {read,tick,dispose:cancel};
}

const number=(n,d)=>n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});

export function renderIntelligenceMarkets(quotes={}){
 const rows=Object.entries(markets).map(([symbol,name])=>{
  const {snapshot,pending,stale}=quotes[symbol]??{};
  const bars=snapshot?.bars.filter(bar=>bar.closedAt<=snapshot.receivedAt/1000)??[];
  const last=bars.at(-1),previous=bars.at(-2),yieldRate=symbol==='US10Y';
  const delta=previous?(yieldRate?(last.close-previous.close)*100:(last.close/previous.close-1)*100):null;
  const price=last?number(last.close,yieldRate?3:2)+(yieldRate?'%':''):'—';
  const change=delta===null?'—':(delta>0?'+':'')+number(delta,2)+(yieldRate?' bp':'%');
  const date=last?snapshot.sessionDate:'',label=date?(stale?L('上次收盘','Last known close')+' · ':'')+date:
   pending?L('读取中','Loading'):L('暂无收盘价','Close unavailable');
  return `<div><a class="dc-asset" data-dc-link href="?page=markets&amp;asset=${symbol}">${tokenIcon(symbol,{size:26,className:'dc-coin'})}<span><b>${symbol}</b><small>${L(...name)}</small></span></a><span title="${date?label+' · '+snapshot.source:label}"><b>${price}</b><span class="${delta>0?'dc-up':delta<0?'dc-down':''}">${change}</span><small>${label}</small></span></div>`;
 }).join('');
 return `<section class="dc-panel df-side-panel"><header><h2>${L('跨市场','Across markets')}</h2><small>${L('日收盘','Daily close')}</small></header><div class="df-market-list">${rows}</div></section>`;
}
