export const CROSS_MARKETS=Object.freeze({
 SPX:{id:'^GSPC',venueId:'yahoo',source:'Yahoo Finance · S&P 500',unit:'index',timezone:'America/New_York'},
 NDX:{id:'^NDX',venueId:'yahoo',source:'Yahoo Finance · Nasdaq 100',unit:'index',timezone:'America/New_York'},
 XAU:{id:'XAU-USD',venueId:'dukascopy',source:'Dukascopy · XAU/USD BID',unit:'USD/oz',timezone:'UTC'},
 DXY:{id:'DX-Y.NYB',venueId:'yahoo',source:'Yahoo Finance · ICE USD Index',unit:'index',timezone:'America/New_York'},
 US10Y:{id:'^TNX',venueId:'yahoo',source:'Yahoo Finance · US 10Y yield',unit:'%',timezone:'America/Chicago'}
});
const fields=['open','high','low','close'],day=86400,formatters=new Map();
// Only these observed empty weekday buckets were cross-checked against ICE's published calendar; this is not a full holiday calendar.
const emptyDxySessions=new Set(['2025-6-19','2025-7-4']);
const validPrice=b=>fields.every(k=>Number.isFinite(b[k])&&b[k]>0)&&b.low<=Math.min(b.open,b.close)&&b.high>=Math.max(b.open,b.close);
function parts(time,zone){if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));return Object.fromEntries(formatters.get(zone).formatToParts(time*1000).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
const sessionDate=(time,zone)=>{const p=parts(time,zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;};
function localTime(date,hour,minute,zone){
 const target=Date.UTC(date.year,date.month-1,date.day,hour,minute)/1000;let result=target;
 for(let i=0;i<3;i++){const p=parts(result,zone),represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)/1000;result+=target-represented;}
 return result;
}
function nextSessionEnd(time,hour,minute,zone,gold=false){
 let cursor=time;
 do{cursor+=day;}while(gold?new Date(cursor*1000).getUTCDay()===6:[0,6].includes(new Date(cursor*1000).getUTCDay()));
 return gold?Math.floor(cursor/day)*day+day:localTime(parts(cursor,zone),hour,minute,zone);
}
export function crossMarketRequest({market,period,profileId,venueId}={}){
 const spec=Object.hasOwn(CROSS_MARKETS,market||'')&&CROSS_MARKETS[market];
 return spec&&period==='1D'&&profileId==='public-market'&&venueId===spec.venueId?{...spec,market,symbol:market,period,interval:'1d',seconds:day,profileId,sessionBased:true}:null;
}
export function crossMarketPolicy(symbol,now=Date.now()){
 const spec=Object.hasOwn(CROSS_MARKETS,symbol||'')&&CROSS_MARKETS[symbol];if(!spec)return null;
 const year=new Date(now).getUTCFullYear();
 return {urls:spec.venueId==='yahoo'?[`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.id)}?range=2y&interval=1d`]:[
  `https://jetta.dukascopy.com/v1/candles/day/XAU-USD/BID/${year-1}`,
  // The endpoint returns the UTC year's shard. A fixed January URL can retain yesterday's version.
  `https://jetta.dukascopy.com/v1/candles/day/XAU-USD/BID?from=${Math.floor(now/3600000)*3600000}`
 ],headers:{'User-Agent':'Mozilla/5.0',...(spec.venueId==='dukascopy'?{Referer:'https://widgets.dukascopy.com/en/historical-data-export'}:{})},interval:60000,maxBytes:600000};
}
export const GOLD_SPOT=Object.freeze({source:'Gold API',sourceUrl:'https://gold-api.com/',url:'https://api.gold-api.com/price/XAU',interval:15000,stale:120000});
export function validateGoldSpot(body,now){
 return body?.symbol==='XAU'&&body.currency==='USD'&&body.unit==='USD/troy oz'&&body.source===GOLD_SPOT.source
  &&Number.isFinite(body.price)&&body.price>0&&Number.isSafeInteger(body.asOf)&&body.asOf>0&&body.asOf<=now+1000;
}
export function publicGoldSpotRequest(params){
 if(params.size)return null;
 return {key:'gold-spot',resource:'gold-spot',policy:{url:GOLD_SPOT.url,interval:GOLD_SPOT.interval,maxBytes:4096,cacheKey:'gold-spot-xau-usd-v1'},
  decode:([raw],now)=>{
   if(raw?.name!=='Gold'||typeof raw.updatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw.updatedAt))throw Error('INVALID_GOLD_QUOTE');
   const body={source:GOLD_SPOT.source,symbol:raw.symbol,currency:raw.currency,unit:'USD/troy oz',price:raw.price,asOf:Date.parse(raw.updatedAt)};
   if(!validateGoldSpot(body,now))throw Error('INVALID_GOLD_QUOTE');
   return body;
  }};
}
// The provider encodes price deltas in integer ticks; missing dates are never filled with flat candles.
export function decodeDukascopy(body){
 if(!body||!Number.isSafeInteger(body.timestamp)||body.shift!==day*1000||!Number.isFinite(body.multiplier)||body.multiplier<=0||body.multiplier>1||!Array.isArray(body.times)||!body.times.length||body.times.length>370||fields.some(k=>!Number.isFinite(body[k])||!Array.isArray(body[k+'s'])||body[k+'s'].length!==body.times.length))throw Error('INVALID_GOLD_DATA');
 let time=body.timestamp;const units=Object.fromEntries(fields.map(k=>[k,Math.round(body[k]/body.multiplier)]));
 return body.times.map((delta,i)=>{
  if(!Number.isSafeInteger(delta)||delta<0||i&&delta===0)throw Error('INVALID_GOLD_TIME');time+=delta*body.shift;
  const bar={time:time/1000,volume:null,closedAt:time/1000+day,closeTimeBasis:'source-daily-bound',validUntil:nextSessionEnd(time/1000,0,0,'UTC',true)+1800};
  for(const k of fields){const diff=body[k+'s'][i];if(!Number.isSafeInteger(diff))throw Error('INVALID_GOLD_PRICE');units[k]+=diff;bar[k]=Number((units[k]*body.multiplier).toFixed(6));}
  if(!validPrice(bar))throw Error('INVALID_GOLD_PRICE');return bar;
 });
}
export function normalizeCrossMarket(raw,symbol,receivedAt=Date.now()){
 const spec=Object.hasOwn(CROSS_MARKETS,symbol||'')&&CROSS_MARKETS[symbol];if(!spec||!Number.isFinite(receivedAt))throw Error('INVALID_MARKET');
 let bars,quoteAsOf,session='last-close',asOfKind='bar-close';
 if(spec.venueId==='dukascopy'){
  if(!Array.isArray(raw)||raw.length!==2)throw Error('INVALID_GOLD_WINDOWS');
  bars=raw.flatMap(decodeDukascopy);if(bars.some((b,i)=>i&&b.time<=bars[i-1].time))throw Error('OVERLAPPING_GOLD_WINDOWS');
  quoteAsOf=Math.min(bars.at(-1).closedAt,receivedAt/1000);
 }else{
  const result=raw?.chart?.result,source=result?.[0],meta=source?.meta,quote=source?.indicators?.quote?.[0],times=source?.timestamp,regular=meta?.currentTradingPeriod?.regular;
  if(raw?.chart?.error||result?.length!==1||meta?.symbol!==spec.id||meta.instrumentType!=='INDEX'||meta.exchangeTimezoneName!==spec.timezone||!Array.isArray(times)||!times.length||times.length>800||!quote||fields.some(k=>!Array.isArray(quote[k])||quote[k].length!==times.length)||!Number.isSafeInteger(regular?.start)||!Number.isSafeInteger(regular.end)||regular.end<=regular.start||!Number.isFinite(meta.regularMarketTime))throw Error('INVALID_INDEX_DATA');
  const close=parts(regular.end,spec.timezone);quoteAsOf=meta.regularMarketTime;asOfKind='quote';
  bars=times.flatMap((time,i)=>{
   if(!Number.isSafeInteger(time)||time<0||i&&time<=times[i-1])throw Error('INVALID_INDEX_TIME');
   const b={time,volume:null,...Object.fromEntries(fields.map(k=>[k,quote[k][i]]))};
   // Yahoo may append an unquoted current session before any trade; retain the actual closed history.
   if(i===times.length-1&&time===regular.start&&quoteAsOf<regular.start&&receivedAt/1000<regular.end&&fields.every(k=>b[k]===null))return [];
   // Yahoo includes empty Sunday buckets for DXY. A partial row or an empty trading weekday is an error.
   const p=parts(time,spec.timezone),weekday=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay();
   if(symbol==='DXY'&&([0,6].includes(weekday)||emptyDxySessions.has(`${p.year}-${p.month}-${p.day}`))&&fields.every(k=>b[k]===null))return [];
   if(!validPrice(b))throw Error('INVALID_INDEX_PRICE');
   b.validUntil=nextSessionEnd(time,close.hour,close.minute,spec.timezone)+1800;return [b];
  });
  const currentDate=parts(regular.start,spec.timezone);
  bars.forEach((bar,i)=>{
   const p=parts(bar.time,spec.timezone),sameSession=['year','month','day'].every(k=>p[k]===currentDate[k]);
   // Historic half-day closes are not supplied by this endpoint. The next observed open is a conservative completion bound.
   bar.closedAt=sameSession?regular.end:bars[i+1]?.time??localTime(p,23,59,spec.timezone)+60;
   bar.closeTimeBasis=sameSession?'source-session':bars[i+1]?'next-session-open-bound':'calendar-day-bound';
   bar.validUntil=Math.max(bar.validUntil,bar.closedAt+1800);
   if(bar.closedAt<=bar.time)throw Error('INVALID_SESSION');
  });
  const now=receivedAt/1000,nextOpen=nextSessionEnd(regular.start,parts(regular.start,spec.timezone).hour,parts(regular.start,spec.timezone).minute,spec.timezone);
  session=now>=regular.end&&now<nextOpen?'closed':'delayed';
 }
 if(!bars.length||bars.some((b,i)=>b.time>receivedAt/1000+60||!Number.isSafeInteger(b.time)||i&&b.time-bars[i-1].time>day*4+3600)||quoteAsOf>receivedAt/1000+60)throw Error('INVALID_MARKET_WINDOW');
 const last=bars.filter(b=>b.closedAt<=receivedAt/1000).at(-1);
 if(!last)throw Error('NO_CLOSED_SESSION');
 if(spec.venueId==='dukascopy')quoteAsOf=last.closedAt;
 return {schema:'cross-market-daily-v1',symbol,source:spec.source,timezone:spec.timezone,unit:spec.unit,volumeKind:'unavailable',period:'1D',session,quoteAsOf,asOfKind,receivedAt,closedAt:last.closedAt,closeTimeBasis:last.closeTimeBasis,sessionDate:sessionDate(last.time,spec.timezone),validUntil:last.validUntil,bars:bars.slice(-500)};
}
export function validateCrossSnapshot(body,request,now=Date.now()){
 if(body?.schema!=='cross-market-daily-v1'||body.symbol!==request.symbol||body.source!==request.source||body.unit!==request.unit||body.timezone!==request.timezone||body.period!=='1D'||body.volumeKind!=='unavailable'||!Number.isFinite(body.receivedAt)||now-body.receivedAt>120000||body.receivedAt>now+30000||!Number.isFinite(body.quoteAsOf)||body.quoteAsOf*1000>now+60000||!['closed','delayed','last-close'].includes(body.session)||!Array.isArray(body.bars)||!body.bars.length||body.bars.length>500)throw Error('INVALID_MARKET_SNAPSHOT');
 if(body.bars.some((b,i)=>!validPrice(b)||b.volume!==null||!Number.isSafeInteger(b.time)||!Number.isFinite(b.closedAt)||b.closedAt<=b.time||!Number.isFinite(b.validUntil)||b.validUntil<=b.closedAt||i&&(b.time<=body.bars[i-1].time||b.time-body.bars[i-1].time>day*4+3600)))throw Error('INVALID_MARKET_BARS');
 const last=body.bars.filter(b=>b.closedAt<=now/1000).at(-1);if(!last||last.closedAt!==body.closedAt||last.validUntil!==body.validUntil||last.closeTimeBasis!==body.closeTimeBasis||body.sessionDate!==sessionDate(last.time,request.timezone)||!['source-session','next-session-open-bound','calendar-day-bound','source-daily-bound'].includes(body.closeTimeBasis))throw Error('INVALID_MARKET_CLOSE');
 return body;
}
export function subscribeCrossMarket(request,{onSnapshot=()=>{},onStatus=()=>{}}={},
 {fetchImpl=globalThis.fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let stopped=false,controller=null,timer=null,deadline=null,failures=0,loaded=false;
 const later=(fn,delay)=>{timer=setTimer(fn,delay);timer?.unref?.();};
 async function load(){
  if(stopped||controller)return;controller=new AbortController();const active=controller;
  const abort=()=>rejectAbort(Error('SOURCE_TIMEOUT'));let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;active.signal.addEventListener('abort',abort,{once:true});});aborted.catch(()=>{});
  const timeout=deadline=setTimer(()=>active.abort(),12000);let delay=60000;
  try{
   onStatus({state:loaded?'refreshing':'loading'});if(stopped||controller!==active)return;
   const exchange=Promise.resolve(fetchImpl('/api/market-hub?'+new URLSearchParams({resource:'cross-candles',symbol:request.symbol}),{signal:active.signal,credentials:'omit',cache:'no-store'}));
   void exchange.then(response=>{if(active.signal.aborted)try{void response.body?.cancel().catch(()=>{});}catch{}},()=>{});
   const response=await Promise.race([exchange,aborted]);if(stopped||controller!==active)return;
   if(active.signal.aborted)throw Error('SOURCE_TIMEOUT');
   if(!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}delay=Math.min(300000,Math.max(15000,Number(response.headers?.get?.('Retry-After'))*1000||0));throw Error('SOURCE_UNAVAILABLE');}
   const relay=await Promise.race([response.json(),aborted]);if(stopped||controller!==active)return;
   if(active.signal.aborted)throw Error('SOURCE_TIMEOUT');
   const body=validateCrossSnapshot(relay.body,request,now());failures=0;loaded=true;
   onSnapshot(body.bars);if(!stopped&&controller===active)onStatus({state:body.validUntil*1000<now()?'stale':'snapshot',asOf:body.receivedAt,quoteAsOf:body.quoteAsOf,asOfKind:body.asOfKind,closedAt:body.closedAt,closeTimeBasis:body.closeTimeBasis,sessionDate:body.sessionDate,session:body.session,source:body.source,timezone:body.timezone,unit:body.unit});
  }catch{if(!stopped&&controller===active){onStatus({state:loaded?'stale':'error',source:request.source});delay=Math.max(delay,Math.min(300000,15000*2**Math.min(4,failures++)));}}
  finally{clearTimer(timeout);if(deadline===timeout)deadline=null;active.signal.removeEventListener('abort',abort);if(controller===active)controller=null;if(!stopped)later(load,delay);}
 }
 load();return ()=>{if(stopped)return;stopped=true;controller?.abort();controller=null;clearTimer(deadline);deadline=null;clearTimer(timer);};
}
