import {executionRunIdentity} from './execution-stream.mjs';
import {crossMarketRequest,subscribeCrossMarket} from './cross-market-data.mjs';
export const CANDLE_PERIODS=Object.freeze({'1m':60,'5m':300,'15m':900,'1H':3600,'4H':14400,'1D':86400});
// Only closed candles confirm pivots; the live candle never moves a confirmed anchor.
export function candleTechnicalStudy(input,{seconds=3600,now=Date.now()/1000,sessionBased=false}={}){
 if(!Number.isFinite(seconds)||seconds<=0||!Number.isFinite(now))return {bars:[],lines:[],pivots:{high:[],low:[]}};
 const bars=input.filter(bar=>(sessionBased?bar.closedAt:bar.time+seconds)<=now);
 if(bars.some((bar,i)=>!['time','open','high','low','close'].every(key=>Number.isFinite(bar[key]))||bar.low<=0||bar.low>Math.min(bar.open,bar.close)||bar.high<Math.max(bar.open,bar.close)||(sessionBased?bar.volume!==null||!Number.isFinite(bar.closedAt)||bar.closedAt<=bar.time||i&&(bar.time<=bars[i-1].time||bar.time-bars[i-1].time>86400*4+3600):!Number.isFinite(bar.volume)||bar.volume<0||i&&bar.time-bars[i-1].time!==seconds)))return {bars:[],lines:[],pivots:{high:[],low:[]}};
 const lines=[],pivots={high:[],low:[]},vwap=[];
 for(let i=19;i<bars.length;i++){const window=bars.slice(i-19,i+1);if(window.some(b=>!Number.isFinite(b.volume)))continue;const volume=window.reduce((n,b)=>n+b.volume,0);if(volume>0)vwap.push({time:bars[i].time,value:window.reduce((n,b)=>n+(b.high+b.low+b.close)/3*b.volume,0)/volume});else vwap.length=0;}
 if(vwap.length>1)lines.push({key:'vwap',zh:'20 根成交量加权均价',en:'20-bar volume-weighted mean',color:'#ffd84d',points:vwap});
 for(let i=2;i<bars.length-2;i++)for(const kind of ['high','low']){
  const value=bars[i][kind],neighbors=[bars[i-2],bars[i-1],bars[i+1],bars[i+2]];
  if(neighbors.every(bar=>kind==='high'?value>bar.high:value<bar.low))pivots[kind].push({time:bars[i].time,value,confirmedAt:sessionBased?bars[i+2].closedAt:bars[i+2].time+seconds});
 }
 if(bars.length>=20){const tail=bars.slice(-20),last=bars.at(-1);
  for(const [kind,key,zh,en,color] of [['high','range-high','20 根区间高点','20-bar range high','#ff965c'],['low','range-low','20 根区间低点','20-bar range low','#52e0ac']]){
   const anchor=tail.reduce((best,bar)=>kind==='high'?bar.high>best.high?bar:best:bar.low<best.low?bar:best);
   if(anchor.time<last.time)lines.push({key,zh,en,color,points:[{time:anchor.time,value:anchor[kind]},{time:last.time,value:anchor[kind]}]});
  }
 }
 for(const [kind,zh,en,color] of [['high','已确认高点连线','Confirmed swing highs','#a783ff'],['low','已确认低点连线','Confirmed swing lows','#55b9ff']]){
  const points=pivots[kind].slice(-2);if(points.length===2)lines.push({key:'swing-'+kind,zh,en,color,points});
 }
 return {bars,lines,pivots};
}
const numeric=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
const positive=v=>numeric(v)&&Number(v)>0;
export function candleRequest({market='BTC/USDT',period='1H',profileId='cex-spot',venueId='binance'}={}){
 if(profileId==='public-market')return crossMarketRequest({market,period,profileId,venueId});
 const pair=/^([A-Z0-9]{2,18})\/USDT$/.exec(market);
 if(!pair||!Object.hasOwn(CANDLE_PERIODS,period))return null;
 const candle={market,symbol:pair[1]+'USDT',interval:period.toLowerCase(),period,seconds:CANDLE_PERIODS[period],venueId,profileId};
 if(venueId==='pancakeswap'&&['BTC','ETH'].includes(pair[1]))return {...candle,profileId:'dex-spot',reference:true};
 if(profileId!=='cex-spot'||venueId!=='binance')return null;
 return candle;
}
function candle(row,request){
 const [time,open,high,low,close,volume,end]=row;
 if(!Number.isSafeInteger(time)||time<0||time>8.64e15||time%(request.seconds*1000)!==0||end!==time+request.seconds*1000-1||![open,high,low,close].every(positive)||!numeric(volume)||Number(volume)<0)throw Error('INVALID_CANDLE');
 const bar={time:time/1000,open:Number(open),high:Number(high),low:Number(low),close:Number(close),volume:Number(volume)};
 if(bar.low>Math.min(bar.open,bar.close)||bar.high<Math.max(bar.open,bar.close))throw Error('INVALID_CANDLE');
 return bar;
}
export function normalizeKlines(rows,request){
 if(!request||!Array.isArray(rows)||!rows.length||rows.length>500)throw Error('INVALID_CANDLES');
 const bars=rows.map(row=>{if(!Array.isArray(row)||row.length<7)throw Error('INVALID_CANDLE');return candle(row,request);});
 if(bars.some((bar,i)=>i&&bar.time-bars[i-1].time!==request.seconds))throw Error('CANDLE_GAP');
 return bars;
}
export function normalizeStreamCandle(event,request){
 const k=event?.k;
 if(event?.e!=='kline'||event.s!==request.symbol||k?.s!==request.symbol||k.i!==request.interval||!Number.isSafeInteger(event.E))throw Error('WRONG_STREAM');
 return {bar:candle([k.t,k.o,k.h,k.l,k.c,k.v,k.T],request),eventAt:event.E};
}
export function mergeCandle(bars,bar,seconds){
 const last=bars.at(-1);if(!last)return [bar];
 if(bar.time<last.time)return bars;
 if(bar.time===last.time)return [...bars.slice(0,-1),bar];
 if(bar.time!==last.time+seconds)throw Error('CANDLE_GAP');
 return [...bars,bar].slice(-500);
}
export function movingAverage(bars,length=20){
 if(!Number.isInteger(length)||length<1)return [];
 let sum=0;const data=[];
 for(let i=0;i<bars.length;i++){sum+=bars[i].close;if(i>=length)sum-=bars[i-length].close;if(i>=length-1)data.push({time:bars[i].time,value:sum/length});}
 return data;
}
export function captureMarketWindow(config,bars,range,status,now=Date.now()){
 const request=candleRequest(config);
 if(!request||request.sessionBased||!['live','snapshot'].includes(status?.state)||!Number.isFinite(status.asOf)||now-status.asOf>30_000||status.asOf>now+30_000||!range||![range.from,range.to].every(Number.isFinite))throw Error('MARKET_NOT_READY');
 const selected=bars.slice(Math.max(0,Math.ceil(range.from)),Math.max(0,Math.floor(range.to)+1)).filter(bar=>(bar.time+request.seconds)*1000<=now);
 if(!selected.length)throw Error('MARKET_NOT_READY');
 return {market:request.market,period:request.period,venueId:request.venueId,profileId:request.profileId,clockKind:'wall',provider:'Binance Spot',asOf:status.asOf,capturedAt:now,bars:selected.map(bar=>({...bar,time:bar.time*1000}))};
}
export function recordedChartSnapshot(input,market){
 const fail=()=>{throw Error('INVALID_CHART_SNAPSHOT');};
 if(!input||input.market!==market||typeof input.id!=='string'||!input.id.trim()||!['string','number'].includes(typeof input.version)||!String(input.version).trim()||!['wall','historical','simulation'].includes(input.clockKind)||typeof input.provider!=='string'||!input.provider.trim()||input.provider.length>100)fail();
 const kind=Array.isArray(input.bars)?'candle':'line',rows=kind==='candle'?input.bars:input.points;
 if(!Array.isArray(rows)||!rows.length||rows.length>500)fail();
 const data=rows.map(row=>{
  if(!Number.isSafeInteger(row?.time)||row.time<0||row.time>8.64e12)fail();
  if(kind==='line'){if(!positive(row.value))fail();return {time:row.time,close:Number(row.value)};}
  if(!['open','high','low','close'].every(key=>positive(row[key]))||!numeric(row.volume)||row.volume<0||row.low>Math.min(row.open,row.close)||row.high<Math.max(row.open,row.close))fail();
  return Object.fromEntries(['time','open','high','low','close','volume'].map(key=>[key,Number(row[key])]));
 });
 if(data.some((bar,i)=>i&&bar.time<=data[i-1].time))fail();
 const levels=(input.levels||[]).map(level=>{if(!['planned-entry','stop','target'].includes(level.kind)||!positive(level.price))fail();return {kind:level.kind,price:Number(level.price),state:'plan'};});
 return {id:input.id,version:String(input.version),market,kind,provider:input.provider,clockKind:input.clockKind,period:Object.hasOwn(CANDLE_PERIODS,input.period)?input.period:'1H',data,levels,asOf:Number.isFinite(input.asOf)?input.asOf:null};
}
export function gridChartLevels({lower,upper,count,mode='arithmetic',referencePrice}){
 if(!positive(lower)||!positive(upper)||!positive(referencePrice)||Number(upper)<=Number(lower)||!Number.isInteger(count)||count<2||count>100||!['arithmetic','geometric'].includes(mode))throw Error('INVALID_GRID');
 const lo=Number(lower),hi=Number(upper),reference=Number(referencePrice);
 return Array.from({length:count+1},(_,i)=>({id:'grid-'+i,price:i===count?hi:i===0?lo:mode==='geometric'?lo*(hi/lo)**(i/count):lo+(hi-lo)*i/count,kind:i===0?'lower':i===count?'upper':null})).map(level=>({...level,kind:level.kind||(Math.abs(level.price-reference)<=reference*1e-10?'grid-mid':level.price<reference?'grid-buy':'grid-sell'),state:'plan'}));
}
export function chartDraftConfig({identity,planRef,period='1H',gridPlan=null}={}){
 const fail=(code,field)=>{throw Object.assign(Error(code),{code,field});};
 if(!identity||['accountId','connectionId','venueId','environment','market','instrumentId'].some(key=>typeof identity[key]!=='string'||!identity[key].trim()||identity[key].length>256))fail('INVALID_IDENTITY','identity');
 const types={'cex-spot':'SPOT','cex-perp':'PERPETUAL','dex-spot':'SPOT','dex-perp':'PERPETUAL'};
 if(!Object.hasOwn(types,identity.profileId)||types[identity.profileId]!==identity.marketType||identity.clockKind!=='market'||!['DEMO','PAPER','LIVE'].includes(identity.environment)||identity.instrumentId!==`${identity.venueId}:${identity.marketType}:${identity.market}`)fail('IDENTITY_MISMATCH','identity');
 if(!planRef||typeof planRef.id!=='string'||!planRef.id.trim()||planRef.id.length>256||!(typeof planRef.version==='number'?Number.isSafeInteger(planRef.version)&&planRef.version>0:typeof planRef.version==='string'&&planRef.version.trim()&&planRef.version.length<=128))fail('INVALID_PLAN_REF','planRef');
 if(!Object.hasOwn(CANDLE_PERIODS,period))fail('INVALID_PERIOD','period');
 let grid=null;
 if(gridPlan){if(!['lower','upper','count'].every(key=>numeric(gridPlan[key])))fail('INVALID_GRID','gridPlan');grid={lower:Number(gridPlan.lower),upper:Number(gridPlan.upper),count:Number(gridPlan.count),mode:gridPlan.mode??'arithmetic'};try{gridChartLevels({...grid,referencePrice:grid.lower});}catch{fail('INVALID_GRID','gridPlan');}}
 return {market:identity.market,venueId:identity.venueId,profileId:identity.profileId,period,identity:{...identity},planRef:{...planRef},gridPlan:grid};
}
const matchingChartScope=(trade,scope)=>{if(!scope)return true;const run=executionRunIdentity(trade);return !!run&&['runId','accountId','environment','connectionId','instrumentId','market','venueId','marketType','profileId'].every(key=>!scope[key]||scope[key]===run[key]);};
const matchingRunOrder=(order,session,scope)=>order.runId===session.id&&order.market===session.market&&(!scope||(!scope.runId||scope.runId===session.id)&&(!scope.accountId||scope.accountId===order.accountId)&&(!scope.instrumentId||scope.instrumentId===order.instrumentId)&&(!scope.environment||scope.environment===order.environment)&&(!scope.connectionId||scope.connectionId===(order.connectionId||session.connectionId||session.ticket?.connectionId))&&(!scope.venueId||!order.venueId||scope.venueId===order.venueId)&&(!scope.marketType||!order.marketType||scope.marketType===order.marketType));
export function orderChartLevels(trade,scope=null){
 const session=trade?.session;if(!session||!matchingChartScope(trade,scope))return [];
 return (trade.orders||[]).filter(order=>matchingRunOrder(order,session,scope)&&['submitted','partial','unknown'].includes(order.status)&&positive(order.price)&&positive(order.qty)&&Number.isFinite(order.filled)&&order.filled>=0&&order.filled<1&&['buy','sell'].includes(order.side)).map(order=>({id:order.id,kind:order.side+'-order',price:Number(order.price),quantity:Number(order.qty)*(1-order.filled),state:order.status}));
}
export function paperChartData(trade,scope=null){
 if(!matchingChartScope(trade,scope))return {runId:null,market:'',fills:[],bars:[],levels:[]};
 const session=trade?.session,market=session?.market,orders=new Map((trade?.orders||[]).filter(o=>session&&matchingRunOrder(o,session,scope)).map(o=>[o.id,o]));
 const ids=new Set(),fills=[];
 for(const fill of trade?.flow?.fills||[]){
  const order=orders.get(fill.orderId),key=fill.venueFillId||fill.id;
  if(!order||typeof fill.id!=='string'||!fill.id||!key||ids.has(key)||!positive(fill.price)||!positive(fill.quantity)||!Number.isFinite(fill.executedAt)||fill.executedAt<0||fill.executedAt>8.64e12||!['buy','sell'].includes(fill.side)||fill.accountId&&order.accountId&&fill.accountId!==order.accountId||fill.instrumentId&&order.instrumentId&&fill.instrumentId!==order.instrumentId)continue;
  ids.add(key);fills.push({id:fill.id,orderId:fill.orderId,time:Math.floor(fill.executedAt),executedAt:fill.executedAt,price:Number(fill.price),quantity:Number(fill.quantity),side:fill.side});
 }
 fills.sort((a,b)=>a.executedAt-b.executedAt||a.id.localeCompare(b.id));
 // The execution fixture has its own elapsed clock. Never project these fills onto live UTC candles.
 const buckets=new Map();
 for(const fill of fills){const b=buckets.get(fill.time);if(b){b.high=Math.max(b.high,fill.price);b.low=Math.min(b.low,fill.price);b.close=fill.price;b.volume+=fill.quantity;}else buckets.set(fill.time,{time:fill.time,open:fill.price,high:fill.price,low:fill.price,close:fill.price,volume:fill.quantity});}
 const levels=[],position=trade?.position;
 if(position&&session&&matchingRunOrder(position,session,scope)&&positive(position.price))levels.push({kind:'entry',price:Number(position.price)});
 for(const [field,kind] of [['stopLoss','stop'],['takeProfit','target']])if(positive(session?.ticket?.[field]))levels.push({kind,price:Number(session.ticket[field])});
 return {runId:session?.id||null,market:market||'',fills,bars:[...buckets.values()],levels};
}

export function chartWindowRestore(saved,bars){
 if(!bars.length||!Number.isFinite(saved?.from)||!Number.isFinite(saved?.to)||saved.from>saved.to)return null;
 if(saved.first===bars[0].time&&saved.last===bars.at(-1).time&&Number.isFinite(saved.logical?.from)&&Number.isFinite(saved.logical?.to)&&saved.logical.from<saved.logical.to)return {kind:'logical',range:{...saved.logical}};
 return {kind:'time',range:{from:saved.from,to:saved.to}};
}

export function subscribeCandles(request,{onSnapshot=()=>{},onBar=()=>{},onStatus=()=>{}}={},
 {fetchImpl=globalThis.fetch,WebSocketImpl=globalThis.WebSocket,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(request.sessionBased)return subscribeCrossMarket(request,{onSnapshot,onStatus},{fetchImpl,now,setTimer,clearTimer});
 let stopped=false,pending=null,socket=null,retryTimer=null,healthTimer=null,deadline=null,lastEvent=0,lastSeen=0,bars=[],failures=0;
 const state=(value,extra={})=>{if(!stopped)onStatus({state:value,...extra});};
 const later=(fn,delay)=>{const id=setTimer(fn,delay);id?.unref?.();return id;};
 function disconnect(){if(socket){const old=socket;socket=null;old.close();}clearTimer(healthTimer);healthTimer=null;}
 function retry(delay){if(stopped)return;clearTimer(retryTimer);retryTimer=later(()=>{retryTimer=null;load();},delay);}
 function watch(){
  clearTimer(healthTimer);healthTimer=later(()=>{if(stopped)return;if(now()-lastSeen>15_000){disconnect();state('reconnecting');load();}else watch();},10_000);
 }
 function connect(){
  if(stopped)return;
  if(!WebSocketImpl){state('snapshot');retry(10_000);return;}
  try{
   const ws=new WebSocketImpl(`wss://data-stream.binance.vision:443/ws/${request.symbol.toLowerCase()}@kline_${request.interval}`);socket=ws;lastSeen=now();
   ws.addEventListener('message',event=>{
    if(stopped||socket!==ws)return;
    try{
     const next=normalizeStreamCandle(JSON.parse(event.data),request);if(next.eventAt<=lastEvent)return;
     const merged=mergeCandle(bars,next.bar,request.seconds);if(merged===bars)return;
     bars=merged;lastEvent=next.eventAt;lastSeen=now();failures=0;onBar(next.bar);state('live',{asOf:next.eventAt});
    }catch{disconnect();state('reconnecting');retry(2000);}
   });
   const lost=()=>{if(stopped||socket!==ws)return;disconnect();state('reconnecting');retry(Math.min(30_000,2000*2**Math.min(4,failures++)));};
   ws.addEventListener('error',lost);ws.addEventListener('close',lost);watch();
  }catch{state('snapshot');retry(10_000);}
 }
 async function load(){
  if(stopped||pending)return;
  disconnect();const controller=new AbortController();pending=controller;
  const abort=()=>rejectAbort(Error('MARKET_TIMEOUT'));let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;controller.signal.addEventListener('abort',abort,{once:true});});aborted.catch(()=>{});
  const timeout=deadline=later(()=>controller.abort(),8000);
  try{
   state(bars.length?'reconnecting':'loading');if(stopped||pending!==controller)return;
   const query=new URLSearchParams({resource:'candles',symbol:request.symbol,interval:request.interval});
   const exchange=Promise.resolve(fetchImpl('/api/market-hub?'+query,{signal:controller.signal,credentials:'omit',cache:'no-store'}));
   void exchange.then(response=>{if(controller.signal.aborted)try{void response.body?.cancel().catch(()=>{});}catch{}},()=>{});
   const response=await Promise.race([exchange,aborted]);if(stopped||pending!==controller)return;
   if(controller.signal.aborted)throw Error('MARKET_TIMEOUT');
   if(!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}const error=Error('MARKET_UNAVAILABLE');error.retryAfter=Math.min(300_000,Math.max(2000,Number(response.headers?.get?.('Retry-After'))*1000||0));throw error;}
   const body=await Promise.race([response.json(),aborted]);if(stopped||pending!==controller)return;
   if(controller.signal.aborted)throw Error('MARKET_TIMEOUT');const next=normalizeKlines(body.body,request);
   if(!Number.isFinite(body.receivedAt)||now()-next.at(-1).time*1000>request.seconds*1000+30_000||next.at(-1).time*1000>now()+30_000)throw Error('STALE_MARKET');
   bars=next;lastEvent=0;failures=0;onSnapshot(bars);state('snapshot',{asOf:body.receivedAt});connect();
  }catch(error){if(!stopped&&pending===controller){state(bars.length?'stale':'error');retry(Math.max(error.retryAfter||0,Math.min(60_000,3000*2**Math.min(4,failures++))));}}
  finally{clearTimer(timeout);if(deadline===timeout)deadline=null;controller.signal.removeEventListener('abort',abort);if(pending===controller)pending=null;}
 }
 load();
 return ()=>{if(stopped)return;stopped=true;pending?.abort();pending=null;clearTimer(deadline);deadline=null;clearTimer(retryTimer);disconnect();};
}
