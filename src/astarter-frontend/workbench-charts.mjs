import {marketAnalysisPlan,computeMarketStudy,createMarketScanner} from './workbench-market-analysis.mjs';
import {subscribeSpotDepth} from './spot-depth-client.mjs';
import {validateSpotDepthSnapshot} from './spot-depth-data.mjs';
import {candleRequest} from './trading-chart-data.mjs';
import {marketResearchObservation} from './live-research.mjs';
import {workbenchEvidenceSummary} from './workbench-evidence-summary.mjs';
import {observationPrice,ASSETS} from './product-data.mjs';
import {L} from './execution-views.mjs';
import {t} from './locale.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {uiGlyph,captureProductFocus} from './product-composition.mjs';
import {escapeUI as esc} from './product-experience.mjs';
import {workbenchEquityLabel} from './workbench-optical-header.mjs';
import {workbenchInsights,workbenchAccount,WorkbenchInsightHistory} from './workbench-insights.mjs';
import {tradingChartPanel,mountTradingCharts} from './trading-chart.mjs';
import {STATEMENT_EXAMPLE,statementExampleSnapshot,statementExampleAllowed,statementExampleContext} from './trading-preview.mjs';
import {statementRecords,projectStatements,statementScope,statementDay} from './statements-data.mjs';
import {sumAmounts} from './execution-records.mjs';
import {createResearchBackgroundClient} from './market-hub-data.mjs';

const chartInfoLabels={account:['总资产变化','Account value'],evidence:['研究进度','Research progress'],distribution:['研究分布','Research distribution']};
const fmt=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
export function marketScatterPosition(trend,rsi,width){
 const left=32,right=Math.max(240,width)-30;
 return {x:left+(Math.max(-3,Math.min(3,trend))+3)/6*(right-left),y:173-(Math.max(20,Math.min(80,rsi))-20)/60*142,clipped:Math.abs(trend)>3||rsi<20||rsi>80};
}
export function marketScatterLabels(rows,width){
 const right=Math.max(240,width)-30,mid=(32+right)/2,groups=[],labels=new Map();
 const points=[...rows].sort((a,b)=>a.x-b.x||a.symbol.localeCompare(b.symbol)).map((row,index)=>{
  const point=marketScatterPosition(row.x,row.y,width),textWidth=row.symbol.length*7.2;
  let direction=rows.length===1?(point.x<mid?-1:1):(index<rows.length/2?-1:1);
  if(direction<0&&point.x-12-textWidth<38||direction>0&&point.x+12+textWidth>right-6)direction*=-1;
  const start=Math.max(38,Math.min(right-6-textWidth,point.x+(direction<0?-12-textWidth:12))),end=start+textWidth;
  return {...point,symbol:row.symbol,start,end,dx:(direction<0?end:start)-point.x,anchor:direction<0?'end':'start'};
 }).sort((a,b)=>a.start-b.start||a.symbol.localeCompare(b.symbol));
 for(const point of points){
  let group=groups.at(-1);
  if(!group||point.start>=group.end+5){group={end:point.end,points:[]};groups.push(group);}
  group.end=Math.max(group.end,point.end);group.points.push(point);
 }
 for(const group of groups){
  const ordered=group.points.sort((a,b)=>a.y-b.y||a.symbol.localeCompare(b.symbol)),gap=Math.min(18,98/Math.max(1,ordered.length-1)),positions=[];
  for(const point of ordered)positions.push(Math.max(56,Math.min(154,point.y+4),(positions.at(-1)??56-gap)+gap));
  for(let i=positions.length-1;i>=0;i--)positions[i]=Math.min(positions[i],i===positions.length-1?154:positions[i+1]-gap);
  let shift=56-positions[0],cost=Infinity;
  for(let offset=shift;offset<=154-positions.at(-1)+1e-8;offset+=2){
   const next=ordered.reduce((sum,label,i)=>sum+Math.abs(positions[i]+offset-label.y-4)+100*points.filter(point=>point.x+9>label.start&&point.x-9<label.end&&point.y+9>positions[i]+offset-12&&point.y-9<positions[i]+offset+4).length,0);
   if(next<cost){cost=next;shift=offset;}
  }
  ordered.forEach((point,i)=>labels.set(point.symbol,{dx:point.dx,dy:positions[i]+shift-point.y,anchor:point.anchor}));
 }
 return labels;
}
export function marketScatterHit(rows,width,x,y){
 let symbol=null,distance=22**2+1;
 for(const row of rows){
  if(row.state!=='ready')continue;
  const point=marketScatterPosition(row.x,row.y,width),next=(point.x-x)**2+(point.y-y)**2;
  if(next<=22**2&&next<distance){symbol=row.symbol;distance=next;}
 }
 return symbol;
}
export class WorkbenchScanMotion{
 constructor(){this.previous=new Map();}
 read(rows,active,now=Date.now()/1000){
  const feedback=new Map(),next=new Map();
  for(const row of rows){
   const before=this.previous.get(row.symbol),at=Math.max(row.activityAt||0,row.freshAt||0);
   next.set(row.symbol,{state:row.state,x:row.x,y:row.y,at});
   if(!active||row.paused||row.state!=='ready')continue;
   const moved=before?.state==='ready'&&(before.x!==row.x||before.y!==row.y);
   const arrived=at>(before?.at||0)&&now-at>=0&&now-at<2;
   if(moved||arrived)feedback.set(row.symbol,{from:moved?before:null,pulse:arrived});
  }
  this.previous=next;return feedback;
 }
}
export function workbenchTimeLabel(at,now){
 const age=Math.max(0,Math.round(now-at));
 if(!Number.isFinite(age))return '—';
 if(age<2)return L('现在','Now');
 if(age<60)return L(`${age}秒前`,`${age}s ago`);
 return L(`${Math.floor(age/60)}分${age%60?`${age%60}秒`:''}前`,`${Math.floor(age/60)}m${age%60?` ${age%60}s`:''} ago`);
}
const statuses=['pending','collected','context','retain','conflict','missing','na'];
const statusLabel=s=>L(...({pending:['待采集','Pending'],collected:['待核对','To review'],context:['背景参考','Context only'],retain:['已核对','Reviewed'],conflict:['存在冲突','Conflicting'],missing:['资料不足','More needed'],na:['不适用','Not applicable']}[s]||['等待','Waiting']));
const dimensions=[['trend',['行情','Price']],['depth',['流动','Liquidity']],['macro',['宏观','Macro']],['social',['舆情','Social']],['chain',['链上','On-chain']],['risk',['风险','Risk']]];
export function workbenchEvidenceStatus(task,key){
 const status=task.evidence.find(e=>e.key===key)?.status;
 if(statuses.includes(status))return status;
 if(key==='chain'&&ASSETS.find(a=>a[0]===task.symbol)?.[2]==='TradFi')return 'na';
 return 'pending';
}

// These are deterministic market fixtures, not exchange candles, orders or account returns.
export function workbenchMarketSample(symbol,time=0,window=120){
 const asset=ASSETS.find(asset=>asset[0]===symbol);if(!asset)return null;
 window=[60,120,300].includes(window)?window:120;time=Number.isFinite(time)?Math.max(0,time):0;
 const step=window/80,end=Math.floor(time*2)/2;
 const bars=Array.from({length:80},(_,i)=>{
  const at=end-(79-i)*step,values=Array.from({length:5},(_,j)=>observationPrice(symbol,(at-step+j*step/4)*2));
  const open=values[0],close=values[4];
  return {at,open,close,high:Math.max(...values),low:Math.min(...values),volume:40+Math.abs(close/open-1)*120000+15*(1+Math.sin(at*.47))};
 });
 const price=bars.at(-1).close,span=Math.max(...bars.map(b=>b.high))-Math.min(...bars.map(b=>b.low)),gap=Math.max(price*.00008,span/160);
 const book=Array.from({length:12},(_,i)=>({bid:price-gap*(i+1),ask:price+gap*(i+1),bidSize:8+8*Math.abs(Math.sin(i*1.73+end*.07)),askSize:8+8*Math.abs(Math.cos(i*1.29+end*.09))}));
 const min=Math.min(...bars.map(b=>b.low)),max=Math.max(...bars.map(b=>b.high)),width=(max-min||price*.001)/20;
 const distribution=Array.from({length:20},(_,i)=>({price:min+(i+.5)*width,count:0}));
 for(const b of bars)distribution[Math.min(19,Math.max(0,Math.floor((b.close-min)/width)))].count++;
 const mean=bars.reduce((v,b)=>v+b.close,0)/bars.length;
 const deviation=Math.sqrt(bars.reduce((v,b)=>v+(b.close-mean)**2,0)/bars.length);
 return {symbol,unit:asset[3],bars,book,price,mean,deviation,distribution,change:asset[3]==='%'?(price-bars[0].open)*100:(price/bars[0].open-1)*100,changeUnit:asset[3]==='%'?'bp':'%',window};
}

const marketMode=context=>context?.researchMode||context?.task?.mode||globalThis.document?.body?.dataset.researchMode;
// Scanner rows contain actual closed daily observations, not intraday OHLC bars.
// The native chart owns its own existing read-only candle subscription.
export function workbenchMarketData(context,rows=[],window=120,nowMs=Date.now()){
 if(marketMode(context)==='demo')return workbenchMarketSample(context.task.symbol,context.time,window);
 const symbol=context?.task?.symbol,config=workbenchInsights({task:context?.task}).marketConfig,request=config&&candleRequest(config),row=rows.find(item=>item.symbol===symbol);
 const data={mode:'live_readonly',symbol,config,state:request?'loading':'unsupported',unit:request?.unit||'USDT',source:request?(request.source||'Binance Spot'):'',timezone:request?.timezone||'UTC',bars:[],book:[],price:null,change:null,changeUnit:'%',closes:[],distribution:[],mean:null,deviation:null,depth:null,depthState:['BTC','ETH','SOL'].includes(symbol)?'loading':'unsupported'};
 if(!request||!Number.isSafeInteger(nowMs)||nowMs<0)return data;
 const paused=Boolean(context.paused||row?.paused);
 data.state=paused?'paused':row?.state||'loading';data.depthState=['BTC','ETH','SOL'].includes(symbol)?paused?'paused':row?.depthState||'loading':'unsupported';
 if(!paused&&data.depthState==='ready')try{data.depth=validateSpotDepthSnapshot(row.depthSnapshot,symbol,nowMs);}catch{data.depthState='stale';}
 if(data.state!=='ready')return data;
 const observation=marketResearchObservation(row,nowMs/1000);
 if(observation?.state!=='ready'||nowMs>=observation.validUntil*1000){data.state=observation?.state==='ready'?'stale':observation?.state||'invalid';return data;}
 Object.assign(data,{price:observation.price,change:observation.change,sampleAt:observation.sampleAt,closedAt:observation.closedAt,validUntil:observation.validUntil});
 if(!Array.isArray(row.priceSeries)||!row.priceSeries.length||row.priceSeries.length>500||row.priceSeries.some(value=>!Number.isFinite(value)||value<=0)||row.priceSeries.at(-1)!==row.price)return data;
 const mean=row.priceSeries.reduce((sum,value)=>sum+value/row.priceSeries.length,0),deviation=Math.sqrt(row.priceSeries.reduce((sum,value)=>sum+(value-mean)**2/row.priceSeries.length,0));
 if(!Number.isFinite(mean)||!Number.isFinite(deviation))return data;
 data.closes=[...row.priceSeries];data.mean=mean;data.deviation=deviation;
 const min=Math.min(...data.closes),max=Math.max(...data.closes),width=(max-min||row.price*.001)/20;
 data.distribution=Array.from({length:20},(_,index)=>({price:min+(index+.5)*width,count:0}));
 for(const value of data.closes)data.distribution[Math.min(19,Math.max(0,Math.floor((value-min)/width)))].count++;
 return data;
}

// Feedback follows observed evidence; pausing or changing assets never replays old changes.
export class WorkbenchEvidenceMotion{
 constructor(){this.previous=null;}
 reset(){this.previous=null;}
 read(symbol,columns,active=true){
  const latest=columns.at(-1),before=this.previous;
  this.previous=latest?{symbol,at:latest.at,version:latest.version,values:[...latest.values]}:null;
  if(!active||!latest||!before||before.symbol!==symbol)return {sample:false,rows:[]};
  return {sample:before.at!==latest.at||before.version!==latest.version,rows:latest.values.flatMap((status,row)=>status!=='na'&&(before.version!==latest.version||before.values[row]!==status)?[row]:[])};
 }
}
const evidenceGlyph=key=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({
 trend:'<path class="ev-bar ev-bar-one" d="M5 19v-6"/><path class="ev-bar ev-bar-two" d="M12 19V5"/><path class="ev-bar ev-bar-three" d="M19 19V9"/>',
 depth:'<path class="ev-wave ev-wave-one" d="M3 8c3-4 6 4 9 0s6 4 9 0"/><path class="ev-wave ev-wave-two" d="M3 16c3-4 6 4 9 0s6 4 9 0"/>',
 macro:'<circle cx="12" cy="12" r="8"/><path class="ev-meridian" d="M12 4c5 5 5 11 0 16-5-5-5-11 0-16Z"/><path d="M4 12h16"/>',
 social:'<path d="M20 11c0 5-4 8-9 8l-6 2 1-6a8 8 0 1 1 14-4Z"/><circle class="ev-dot ev-dot-one" cx="8" cy="11" r=".7"/><circle class="ev-dot ev-dot-two" cx="12" cy="11" r=".7"/><circle class="ev-dot ev-dot-three" cx="16" cy="11" r=".7"/>',
 chain:'<g class="ev-orbit"><path d="m12 4 7 12H5L12 4Z"/><circle cx="12" cy="4" r="2"/><circle cx="19" cy="16" r="2"/><circle cx="5" cy="16" r="2"/></g>',
 risk:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path class="ev-tick" d="m8 12 3 3 5-6"/>',
 equity:'<path d="M4 6h14v3H4a2 2 0 0 1 0-4m0 4v11h17V9h-6v6h6m-3-3h.1"/>',
 evidence:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path class="ev-tick" d="m14 17 3 3 5-6"/>',
 distribution:'<path class="ev-bar ev-bar-one" d="M4 20v-6m5 6V8"/><path class="ev-bar ev-bar-two" d="M14 20V4"/><path class="ev-bar ev-bar-three" d="M19 20v-9"/>'
 })[key]||''}</svg>`;

export class WorkbenchChartHistory{
 constructor(){this.revision=null;this.evidence=[];this.timeline=[];this.streams=new Map();this.account=[];this.lastAccount=-1;this.accountScope=null;}
 record(task,trade,time,paused=false,observedAt=trade.time??0){
  const revision=task.symbol+':'+task.version;
  let stream=this.streams.get(task.symbol);
  if(!stream){stream={version:task.version,evidence:[],timeline:[]};this.streams.set(task.symbol,stream);}
  if(stream.version!==task.version){stream.version=task.version;stream.evidence=[];}
  const bucket=Math.floor(time/2)*2,point={at:bucket,version:task.version,values:dimensions.map(([key])=>workbenchEvidenceStatus(task,key))};
  if(!paused||!stream.evidence.length){
   for(const rows of [stream.evidence,stream.timeline]){
    if(rows.at(-1)?.at===bucket&&rows.at(-1)?.version===task.version)rows[rows.length-1]=point;else rows.push(point);
    if(rows.length>32)rows.splice(0,rows.length-32);
   }
  }
  this.revision=revision;this.evidence=stream.evidence;this.timeline=stream.timeline;
  // Account and research clocks are independent; account history is never backfilled.
  const at=Math.floor(observedAt),account=workbenchAccount(trade),equity=account.equity;
  if(at<this.lastAccount||this.accountScope!==account.scope||!account.known){this.account=[];this.lastAccount=-1;}
  this.accountScope=account.scope;
  if(Number.isFinite(equity)&&(at!==this.lastAccount||this.account.at(-1)?.value!==equity)){
   const point={at,value:equity};
   if(at===this.lastAccount)this.account[this.account.length-1]=point;
   else this.account.push(point);
   this.lastAccount=at;this.account=this.account.slice(-120);
  }
 }
}

const phaseLabel=phase=>L(...({queued:['排队中','Queued'],collect:['收集信息','Collecting'],verify:['交叉比对','Cross-checking'],queuedCore:['等待汇总','Awaiting synthesis'],core:['形成判断','Forming a view'],complete:['已形成判断','View formed']}[phase]||['等待','Waiting']));
const outcomeLabel=outcome=>L(...({candidate:['可继续评估','Candidate'],watch:['继续观察','Watching'],conflict:['暂缓操作','Conflicting'],missing:['等待补充','Missing data'],context:['市场背景','Context']}[outcome]||['评估中','Assessing']));
const runClock=seconds=>{const s=Math.max(0,Math.floor(seconds||0));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const money=value=>Number.isFinite(value)?fmt(value,value>=1000||value===0?0:2):'—';
const signed=value=>Number.isFinite(value)?`${value>0?'+':''}${fmt(value)}`:'—';
const PNL_DAY=86400000,PNL_HOUR=3600000,PNL_SHORT_DAYS=90;
const pnlPeriods=['day','week','month','all'];
const heatValue=value=>Number.isFinite(value)?value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8}):'—';
const pnlTone=value=>!Number.isFinite(value)?'unknown':value>0?'gain':value<0?'loss':'flat';
const pnlShiftDay=(day,offset)=>new Date(Date.parse(day+'T12:00:00Z')+offset*PNL_DAY).toISOString().slice(0,10);
const pnlMonday=day=>pnlShiftDay(day,-(new Date(day+'T12:00:00Z').getUTCDay()+6)%7);

function pnlDaySegments(day,offsetAt){
 const target=Date.parse(day+'T00:00:00Z'),left=target-36*PNL_HOUR,right=target+36*PNL_HOUR,parts=[];
 const add=(from,to,offset)=>{
  const start=Math.max(from,target-offset),end=Math.min(to,target+PNL_DAY-offset);
  if(end<=start)return;
  if(parts.at(-1)?.end===start)parts.at(-1).end=end;else parts.push({start,end});
 };
 // Intersect the local date with each UTC offset span, including a return to the previous date.
 let start=left,offset=offsetAt(left);
 for(let at=left+PNL_HOUR;at<=right;at+=PNL_HOUR){
  const next=offsetAt(at);
  if(next===offset)continue;
  let low=at-PNL_HOUR,high=at;
  while(high-low>1){const mid=Math.floor((low+high)/2);if(offsetAt(mid)===offset)low=mid;else high=mid;}
  add(start,high,offset);start=high;offset=next;
 }
 add(start,right,offset);return parts;
}

// Each point is a receipt-time interval. Missing history is never fabricated from a daily total.
export function pnlLedSeries(trade={}, {now=Date.now(),timeZone,period='all'}={}){
 period=pnlPeriods.includes(period)?period:'all';
 const account=workbenchAccount(trade),scope=statementScope('',{owner:'AI_SPECTRUM',accountId:account.accountId,environment:account.environment,currency:trade?.accountSummary?.unit||'USDT',timeZone});
 let to=statementDay(now,scope.timeZone);const base={...scope,period,from:'',to:to||'',cells:[],columns:[],rows:0,grain:'four-hour',max:0,total:null,fills:0,issues:0,undated:0,unclassified:0,hasHistory:false};
 if(!account.known||!to)return base;
 const records=statementRecords(trade,scope),currencyMatch=row=>row.currency===scope.currency||row.order?.currency===scope.currency;
 const relevant=[...records.fills,...records.events].filter(row=>(row.owner===scope.owner||!row.owner)&&currencyMatch(row));
 const dates=relevant.filter(row=>row.timestamp!==null&&row.timestamp<=now).map(row=>statementDay(row.timestamp,scope.timeZone)).filter(Boolean).sort();
 if(period!=='day'){
  const cutoff=period==='week'?pnlShiftDay(pnlMonday(to),6):period==='month'?pnlShiftDay(new Date(Date.UTC(Number(to.slice(0,4)),Number(to.slice(5,7)),1)).toISOString().slice(0,10),-1):'';
  const latest=cutoff?dates.findLast(day=>day<=cutoff):dates.at(-1);if(latest>to)to=latest;
 }
 const from=period==='day'?to:period==='week'?pnlMonday(to):period==='month'?to.slice(0,7)+'-01':dates[0]||to;
 const span=Math.round((Date.parse(to)-Date.parse(from))/PNL_DAY)+1,long=period==='all'&&span>PNL_SHORT_DAYS;
 const plotFrom=long?pnlMonday(from):from;
 const nextMonth=new Date(Date.UTC(Number(to.slice(0,4)),Number(to.slice(5,7)),1)).toISOString().slice(0,10);
 const plotTo=period==='week'||long?pnlShiftDay(pnlMonday(to),6):period==='month'?pnlShiftDay(nextMonth,-1):to;
 const range={...scope,from,to};
 const timely=row=>row.timestamp===null||row.timestamp<=now;
 const windowRecords={...records,fills:records.fills.filter(timely).map(row=>row.closing&&row.events.some(e=>e.type==='REALIZED_PNL'&&e.timestamp>now)&&!row.events.some(e=>e.type==='REALIZED_PNL'&&e.timestamp!==null&&e.timestamp<=now)?{...row,realizedGross:null}:row),events:records.events.filter(timely)};
 const model=projectStatements(windowRecords,range);
 const undatedEvents=records.events.filter(row=>row.owner===scope.owner&&row.timestamp===null&&(row.currency===scope.currency||row.order?.currency===scope.currency));
 const unclassifiedRows=relevant.filter(row=>!row.owner&&timely(row)&&(row.timestamp===null||statementDay(row.timestamp,scope.timeZone)>=from&&statementDay(row.timestamp,scope.timeZone)<=to));
 const unresolvedDays=new Set([...undatedEvents.map(row=>statementDay(row.fill?.timestamp??row.order?.timestamp,scope.timeZone)),...unclassifiedRows.filter(row=>row.timestamp===null).map(row=>statementDay(row.fill?.timestamp??row.order?.timestamp,scope.timeZone))].filter(Boolean));
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:scope.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),offsets=new Map(),days=new Map();
 const offsetAt=at=>{if(!offsets.has(at)){const p=Object.fromEntries(formatter.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));offsets.set(at,Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(at/1000)*1000);}return offsets.get(at);};
 const parts=day=>{if(!days.has(day))days.set(day,pnlDaySegments(day,offsetAt));return days.get(day);};
 const columns=[],slots=[];
 const addColumn=(day,segments,step)=>{
  const column=columns.length;columns.push({day,start:segments[0]?.start??null,end:segments.at(-1)?.end??null});let row=0;
  for(const {start,end}of segments)for(let at=start;at<end;at+=step,row++)slots.push({id:String(at),day,start:at,end:Math.min(end,at+step),column,row,amounts:[],fills:0,activity:false,incomplete:false});
 };
 if(period==='day'){
  for(const {start,end}of parts(to))for(let at=start;at<end;at+=PNL_HOUR)addColumn(to,[{start:at,end:Math.min(end,at+PNL_HOUR)}],PNL_HOUR/6);
 }else if(long){
  for(let week=plotFrom;week<=plotTo;week=pnlShiftDay(week,7)){
   const weekParts=Array.from({length:7},(_,i)=>parts(pnlShiftDay(week,i))).flat(),column=columns.length;columns.push({day:week,start:weekParts[0]?.start??null,end:weekParts.at(-1)?.end??null});
   for(let row=0;row<7;row++){const day=pnlShiftDay(week,row);if(day<from)continue;const segments=parts(day);if(segments.length)slots.push({id:String(segments[0].start),day,start:segments[0].start,end:segments.at(-1).end,...(segments.length>1?{segments}:{}),column,row,amounts:[],fills:0,activity:false,incomplete:false});}
  }
 }else for(let day=plotFrom;day<=plotTo;day=pnlShiftDay(day,1))addColumn(day,parts(day),4*PNL_HOUR);
 const intervals=slots.flatMap(slot=>(slot.segments||[slot]).map(part=>({start:part.start,end:part.end,slot}))).sort((a,b)=>a.start-b.start);
 const slotAt=at=>{
  if(at===null)return null;let low=0,high=intervals.length;
  while(low<high){const mid=(low+high)>>1;if(intervals[mid].start<=at)low=mid+1;else high=mid;}
  const part=intervals[low-1];return part&&at<part.end?part.slot:null;
 };
 for(const fill of model.fills){const slot=slotAt(fill.timestamp);if(slot){slot.fills++;slot.activity=true;slot.incomplete||=fill.pendingFee||fill.closing&&fill.realizedGross===null;}}
 for(const event of model.events){const slot=slotAt(event.timestamp);if(slot){slot.amounts.push(event.amount);slot.activity=true;}}
 for(const row of unclassifiedRows){const slot=slotAt(row.timestamp);if(slot)slot.incomplete=true;}
 for(const event of windowRecords.events.filter(row=>row.owner===scope.owner&&row.currency!==scope.currency&&row.order?.currency===scope.currency)){const slot=slotAt(event.timestamp);if(slot&&slot.day>=from&&slot.day<=to)slot.incomplete=true;}
 const cells=slots.map(({amounts,incomplete,activity,...slot})=>{
  const future=slot.start>now,net=activity?Number(sumAmounts(amounts)):null,value=!future&&!incomplete&&!unresolvedDays.has(slot.day)&&Number.isFinite(net)?net:null;
  return {...slot,value,state:future?'future':incomplete||unresolvedDays.has(slot.day)?'unknown':!activity?'empty':pnlTone(value),partial:slot.start<=now&&slot.end>now};
 });
 const unclassified=new Set(unclassifiedRows.map(row=>row.order?.key||row.key)).size;
 const undated=model.undated+undatedEvents.length,issues=model.pending+model.missingPnl+model.foreignCosts+undated+unclassified;
 const total=model.days.length&&!issues&&model.net!==null?Number(model.net):null;
 return {...base,...range,plotFrom,plotTo,columns,rows:long?7:Math.max(1,...cells.map(cell=>cell.row+1)),grain:period==='day'?'ten-minute':long?'day':'four-hour',cells,max:Math.max(0,...cells.map(cell=>Math.abs(cell.value||0))),total:Number.isFinite(total)?total:null,fills:model.fills.length,issues,undated,unclassified,hasHistory:relevant.length>0};
}
// The review sample is a separate display source; account metrics still use the original trade.
export function workbenchPnlSeries(trade,syncStatus,options={}){
 const actual=pnlLedSeries(trade,options);
 const explicit=options.example===STATEMENT_EXAMPLE.id&&statementExampleContext(trade,syncStatus,options.hostname);
 if(!explicit&&(options.accountOnly||options.example||actual.hasHistory||actual.issues||!statementExampleAllowed(trade,syncStatus,options.hostname)))return actual;
 return {...pnlLedSeries(statementExampleSnapshot(),{now:STATEMENT_EXAMPLE.asOf,timeZone:STATEMENT_EXAMPLE.timeZone,period:actual.period}),example:STATEMENT_EXAMPLE.id,accountIssues:actual.issues,accountUnclassified:actual.unclassified};
}
const pnlDateLabel=(day,full=false)=>new Intl.DateTimeFormat(globalThis.document?.documentElement?.lang||'zh-CN',{...(full?{year:'numeric'}:{}),month:'short',day:'numeric',timeZone:'UTC'}).format(Date.parse(day+'T12:00:00Z'));

// LED Matrix Sales by kedhareswer, 21st #44652 (MIT; workbench-pnl-led.LICENSE).
const pnlRollingMarkup=text=>[...text].map(ch=>/\d/.test(ch)?`<span class="lms-roll" data-digit="${ch}"><span class="lms-strip" style="transform:translateY(-${ch}em)">${'0123456789'.split('').map(n=>`<span>${n}</span>`).join('')}</span></span>`:`<span class="lms-static">${esc(ch)}</span>`).join('');
function updatePnlRolling(node,text){
 if(node.dataset.pnlText===text)return;
 node.dataset.pnlText=text;node.setAttribute('aria-label',text);node.querySelector('.lms-sr').textContent=text;
 const ink=node.querySelector('.lms-number'),old=[...ink.children],next=[];
 [...text].forEach((ch,i)=>{
  let item=old[i];
  if(/\d/.test(ch)&&item?.classList.contains('lms-roll')){item.dataset.digit=ch;item.querySelector('.lms-strip').style.transform=`translateY(-${ch}em)`;}
  else if(!/\d/.test(ch)&&item?.classList.contains('lms-static'))item.textContent=ch;
  else{const holder=document.createElement('span');holder.innerHTML=pnlRollingMarkup(ch);item=holder.firstElementChild;}
  next.push(item);
 });
 if(next.length!==old.length||next.some((item,i)=>item!==old[i]))ink.replaceChildren(...next);
}

export function pnlMatrixLevel(value,max){return Number.isFinite(value)&&value!==0&&Number.isFinite(max)&&max>0?Math.min(4,Math.max(1,Math.ceil(Math.abs(value)/max*4))):0;}
export function pnlMatrixTarget(cells,index,key){
 if(!cells[index])return -1;if(key==='Home')return 0;if(key==='End')return cells.length-1;
 const point=cells[index],row=point.row+(key==='ArrowUp'?-1:key==='ArrowDown'?1:0),column=point.column+(key==='ArrowLeft'?-1:key==='ArrowRight'?1:0);
 const candidates=cells.map((cell,i)=>({...cell,index:i})).filter(cell=>cell.column===column);
 if(!candidates.length)return index;
 if(key==='ArrowUp'||key==='ArrowDown')return candidates.find(cell=>cell.row===row)?.index??index;
 return candidates.reduce((best,cell)=>Math.abs(cell.row-row)<Math.abs(best.row-row)?cell:best).index;
}

function pnlLedMarkup(c,model,{selected=''}={}){
 const prefix=encodeURIComponent(`${c.accountId||'account'}:${c.environment||''}:${model.currency}:${model.timeZone}:${model.period}`);
 const recent=model.cells.findLast(cell=>cell.state!=='future')||model.cells.at(-1);
 const active=model.cells.some(cell=>`${prefix}-${cell.id}`===selected)?selected:recent?`${prefix}-${recent.id}`:'';
 const locale=globalThis.document?.documentElement?.lang||'zh-CN',clock=new Intl.DateTimeFormat(locale,{timeZone:model.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}),axisClock=new Intl.DateTimeFormat(locale,{timeZone:model.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:model.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}),fullDate=new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}),shortDate=new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',timeZone:'UTC'});
 const dateLabel=(day,full=false)=>(full?fullDate:shortDate).format(Date.parse(day+'T12:00:00Z'));
 const dots=model.cells.map(cell=>{
  const known=Number.isFinite(cell.value),level=pnlMatrixLevel(cell.value,model.max),key=`${prefix}-${cell.id}`;
  const parts=calendar.formatToParts(cell.end),endDay=['year','month','day'].map(type=>parts.find(p=>p.type===type).value).join('-'),end=(endDay!==cell.day?dateLabel(endDay)+' ':'')+clock.format(cell.end);
  const range=dateLabel(cell.day,true)+(model.grain==='day'?` · ${model.timeZone}`:` · ${clock.format(cell.start)} – ${end}`)+(cell.partial?' · '+L('进行中','In progress'):'');
  const amount=known?`${cell.value>0?'+':''}${Math.abs(cell.value)>=.01?fmt(cell.value):heatValue(cell.value)}`:'—';
  const description=cell.state==='future'?L('尚未到此时段','Future interval'):cell.state==='empty'?L('无结算记录','No settled activity'):cell.state==='unknown'?L('结算待确认','Settlement pending'):`${L('净盈亏','Net P&L')} ${amount} ${model.currency}`;
  const records=cell.state!=='future'&&cell.state!=='empty';
  const target=records?` data-pnl-records="true"${model.example?` data-statement-example="${esc(model.example)}"`:''} data-statement-from="${model.from}" data-statement-to="${model.to}" data-statement-day="${cell.day}" data-statement-zone="${esc(model.timeZone)}"`:'';
  return `<button type="button" class="lms-cell" id="pnl-point-${esc(key)}" tabindex="${key===active?0:-1}" data-pnl-key="${key}" data-pnl-day="${cell.day}" data-pnl-column="${cell.column}" data-pnl-row="${cell.row}" data-pnl-level="${level}"${target} data-pnl-fills="${cell.fills}" data-pnl-state="${cell.state}" data-pnl-range="${esc(range)}" data-pnl-amount="${amount}" data-pnl-unit="${esc(model.currency)}" aria-label="${esc(`${range} · ${description}${known?` · ${cell.fills} ${L('笔成交','fills')}`:''}${records?' · '+L('查看当日记录','View day records'):''}`)}" style="grid-column:${cell.column+1};grid-row:${cell.row+1}${level?`;--pnl-cell-color:var(--pnl-${cell.state}-${level})`:''}"><i class="lms-dot" aria-hidden="true"></i></button>`;
 }).join('');
 const crossYear=model.from.slice(0,4)!==model.to.slice(0,4),count=model.columns.length,ticks=[...new Set([0,Math.floor((count-1)/4),Math.floor((count-1)/2),Math.floor((count-1)*3/4),count-1])].filter(i=>i>=0&&i<count);
 const ranges=`<div class="lms-ranges" role="tablist" aria-label="${L('盈亏时间范围','P&L time range')}">${[['day','每日','Daily'],['week','每周','Weekly'],['month','每月','Monthly'],['all','全部','All']].map(([id,zh,en])=>`<button type="button" role="tab" id="pnl-period-${id}" data-pnl-period="${id}" aria-selected="${model.period===id}" tabindex="${model.period===id?0:-1}" aria-controls="pnl-period-panel">${L(zh,en)}</button>`).join('')}</div>`;
 const grain=L(...({'ten-minute':['10分钟 / 点','10 min / point'],'four-hour':['≤4小时 / 点','≤4h / point'],day:['1自然日 / 点','1 day / point']}[model.grain]));
 const scale=tone=>(tone==='loss'?[4,3,2,1]:[1,2,3,4]).map(level=>{const from=model.max*(level-1)/4,to=model.max*level/4,range=tone==='loss'?[to?-to:0,from?-from:0]:[from,to];return `<i class="lms-dot" style="--pnl-cell-color:var(--pnl-${tone}-${level})" title="${esc(`${heatValue(range[0])} – ${heatValue(range[1])} ${model.currency}`)}" aria-hidden="true"></i>`;}).join('');
 const statuses=[['empty','无记录','No records'],['unknown','待确认','Unconfirmed'],['future','未来','Future']].map(([state,zh,en])=>`<span data-pnl-state="${state}"><i class="lms-dot" aria-hidden="true"></i>${L(zh,en)}</span>`).join('');
 return `<div class="pnl-led-board"><div class="lms-toolbar">${ranges}<span class="lms-grain">${grain}</span></div><div id="pnl-period-panel" role="tabpanel" aria-labelledby="pnl-period-${model.period}"><div class="lms-scroll"><div class="lms-matrix" role="group" aria-label="${L('时间盈亏点阵，方向键移动；有记录的时间片可打开当日账单','P&L time matrix. Use arrow keys to move; recorded intervals open day records')}" style="--pnl-columns:${Math.max(1,count)};--pnl-rows:${Math.max(1,model.rows)}">${dots}</div><div class="lms-axis" style="--pnl-columns:${Math.max(1,count)}">${ticks.map(i=>{const col=model.columns[i],label=model.period==='day'?axisClock.format(col.start):dateLabel(col.day,crossYear);return `<time datetime="${model.period==='day'?new Date(col.start).toISOString():col.day}" style="grid-column:${i+1}">${esc(label)}</time>`;}).join('')}</div></div><div class="lms-legend"><span class="lms-scale" aria-label="${esc(L('红绿共用四档金额强度，上限 ','Four shared amount levels, up to ')+heatValue(model.max)+' '+model.currency)}"><span>${L('亏损','Loss')}</span><span class="lms-scale-ramp" data-pnl-scale="loss">${scale('loss')}</span><span class="lms-scale-zero" title="${esc(`0 ${model.currency}`)}">0</span><span class="lms-scale-ramp" data-pnl-scale="gain">${scale('gain')}</span><span>${L('盈利','Profit')}</span></span><span class="lms-statuses">${statuses}</span></div></div></div>`;
}

export function capitalPnlMarkup(c,model,options={}){
 if(c.known===false)model={...model,total:null,cells:[],columns:[],rows:0};
 const pnl=c.known===false?null:model.total,tone=pnlTone(pnl),chart=pnlLedMarkup(c,model,options),amount=signed(pnl);
 const crossYear=model.from.slice(0,4)!==model.to.slice(0,4);
 const cell=(label,value,tone='')=>`<div><dt>${label}</dt><dd${tone?` data-pnl-tone="${tone}"`:''}>${value}</dd></div>`;
 const reason=model.unclassified?L('历史盈亏待核对','Historical P&L needs review'):model.issues?L('结算待确认','Settlement pending'):model.cells.some(cell=>!['empty','future'].includes(cell.state))?L('已扣除费用','Net of fees'):L('无结算记录','No settled activity');
 const run=c.runId?`<div class="pnl-run"><span>${esc(c.runMarket)} · ${L(...({running:['运行中','Running'],paused:['已暂停','Paused'],blocked:['需要处理','Needs attention'],stopped:['已停止','Stopped']}[c.runState]||['状态待确认','Status unconfirmed']))}</span><dl class="insight-capital-line">${cell(L('每笔计划','Per order'),money(c.amount))}${cell(L('运行上限','Run cap'),money(c.cap))}${cell(L('止损','Stop loss'),money(c.stopLoss))}${cell(L('止盈','Take profit'),money(c.takeProfit))}${cell(L('成交委托','Filled orders'),c.filledOrders)}${cell(L('待确认','Unconfirmed'),c.unknownOrders)}</dl></div>`:'';
 return `<div class="pnl-led lms-root${options.on!==false?' lms-on':''}" data-pnl-tone="${tone}"><div class="lms-head"><div class="lms-id"><span class="lms-chip" aria-hidden="true">${uiGlyph('chart')}</span><div><span class="lms-title">${L('AI 交易盈亏','LensWave P&L')}${model.example?' · '+L('参考数据','Reference data'):''}</span><span class="lms-cap">${model.from?`${pnlDateLabel(model.from,crossYear)}${model.from===model.to?'':' — '+pnlDateLabel(model.to,crossYear)} · `:''}${esc(model.currency)}</span>${model.example&&(model.accountUnclassified||model.accountIssues)?`<span class="lms-cap">${model.accountUnclassified?L('历史盈亏待核对','Historical P&L needs review'):L('结算待确认','Settlement pending')}</span>`:''}</div></div><div class="lms-sum"><strong class="lms-big" data-pnl-text="${amount}" aria-label="${amount}"><span class="lms-sr">${amount}</span><span class="lms-number" aria-hidden="true">${pnlRollingMarkup(amount)}</span></strong><span class="lms-delta">${tone==='gain'||tone==='loss'?`<i class="lms-pill" aria-hidden="true">${uiGlyph('arrow')}</i>`:''}${reason}</span></div></div>${chart}<dl class="pnl-metrics">${cell(workbenchEquityLabel(c)+' · '+esc(c.unit),fmt(c.equity))}${cell(L('已实现','Realized'),signed(c.realized),pnlTone(c.realized))}${cell(L('未实现','Unrealized'),signed(c.unrealized),pnlTone(c.unrealized))}${cell(L('累计费用','Total fees'),fmt(c.fees,4))}</dl></div><details class="pnl-details"><summary>${L('资金与保护','Funds & protection')}</summary><dl class="insight-capital-line">${cell(L('可用资金','Available'),money(c.available))}${cell(L('现金','Cash'),money(c.cash))}${cell(L('持仓账面','Holdings book value'),money(c.held))}${cell(L('预留资金','Reserved'),money(c.reserved))}${cell(L('账户上限','Account cap'),money(c.accountCap))}${cell(L('单日亏损上限','Daily loss limit'),money(c.dailyLossLimit))}</dl>${run}</details>`;
}
const insightMarkup=()=>`<article class="terminal-insight insight-surface terminal-insight-market"><header class="insight-head"><div class="insight-title"><span class="insight-kicker">${L('行情与判断','Market & view')}</span><h3 data-insight-symbol></h3></div><div class="insight-sources"><span data-origin="market"><i></i>${L('K 线 · Binance 现货','Candles · Binance spot')}</span></div></header><div class="insight-verdict" data-outcome="pending"><span class="insight-verdict-chip"></span><div class="insight-verdict-copy"><h4></h4><p></p></div><small class="insight-verdict-next"></small></div><div class="insight-market-slot"></div></article><article class="terminal-insight insight-surface terminal-insight-evidence"><header class="insight-head"><div class="insight-title"><h3>${L('研究依据','Research evidence')}</h3></div></header><div class="insight-evidence-summary-slot"></div><div class="insight-tracks"></div><p class="insight-track-caption"></p><div class="insight-evidence-detail" aria-live="polite"></div><footer class="insight-judgment" data-phase="queued"><i class="insight-node" aria-hidden="true"></i><div><b></b><small></small></div></footer></article><article class="terminal-insight insight-surface terminal-insight-capital" data-run="none"><header class="insight-head"><div class="insight-title"><span class="insight-kicker">${L('盈亏概览','Profit & loss')}</span><h3></h3></div><span class="insight-lock" hidden>${L('资金保护已锁定','Capital locked')}</span><div class="insight-sources"><button type="button" class="st-button" data-pnl-example hidden></button><button type="button" class="pnl-history-link" data-statements="AI_SPECTRUM" aria-haspopup="dialog">${L('交易记录','Trade history')}${uiGlyph('arrow')}</button></div></header><div class="insight-capital-body" tabindex="-1"></div><div class="pnl-tooltip" id="workbench-pnl-tooltip" role="tooltip" popover="manual" hidden></div></article>`;
export function createWorkbenchCharts(stage,{onSelectSymbol=()=>{},onMarketScan=()=>{},onSharedContext=()=>{},backgroundFactory=createResearchBackgroundClient,scannerFactory=createMarketScanner,mountMarketCharts=mountTradingCharts}={}){
 const host=document.createElement('section');host.id='workbench-analytics';host.className='terminal-analytics terminal-new';host.setAttribute('data-localized-ui','');host.dataset.insightView=String(document.body.dataset.workbenchView==='photonic');stage.append(host);
 host.innerHTML=`${insightMarkup()}<article class="terminal-insight insight-surface terminal-insight-scatter"></article><article class="terminal-market-chart"><header><div class="terminal-chart-title"></div><div class="terminal-chart-ranges" aria-label="${L('合成行情窗口','Synthetic market window')}">${[[60,'1m'],[120,'2m'],[300,'5m']].map(([value,label])=>`<button data-market-window="${value}" aria-pressed="${value===120}">${label}</button>`).join('')}<button data-chart-fit title="${L('重置缩放','Reset zoom')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></div></header><div class="terminal-market-readout"></div><div class="terminal-market-layout"><div class="terminal-plot terminal-price-plot" tabindex="0" role="img"></div><div class="terminal-depth"><header></header><div class="terminal-asks"></div><b class="terminal-book-mid"></b><div class="terminal-bids"></div></div></div><footer class="terminal-chart-legend"></footer></article><article class="terminal-equity-chart"><header><div class="terminal-chart-heading"><span class="terminal-chart-glyph" data-chart-glyph="equity">${evidenceGlyph('equity')}</span><h3></h3></div><button class="terminal-chart-info" type="button" data-chart-info="account" aria-label="${L(...chartInfoLabels.account)}" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/></svg></button></header><p class="terminal-chart-note" hidden></p><div class="terminal-equity-readout"></div><div class="terminal-plot terminal-equity-plot" role="img"></div><footer class="terminal-account-stats"></footer></article><article class="terminal-evidence-chart"><header><div class="terminal-chart-heading"><span class="terminal-chart-glyph" data-chart-glyph="evidence">${evidenceGlyph('evidence')}</span><h3></h3></div><span class="terminal-evidence-revision"></span><button class="terminal-chart-info" type="button" data-chart-info="evidence" aria-label="${L(...chartInfoLabels.evidence)}" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/></svg></button></header><p class="terminal-chart-note" hidden></p><div class="terminal-evidence-stage"><div class="terminal-plot terminal-evidence-plot" tabindex="0" role="img"></div><div class="terminal-evidence-glyphs">${dimensions.map(([key,name],index)=>`<span class="terminal-evidence-source" data-source-glyph="${key}" style="--source-order:${index}"><i>${evidenceGlyph(key)}</i><span>${L(...name)}</span></span>`).join('')}</div><div class="terminal-evidence-current"></div><div class="terminal-evidence-cursor" aria-hidden="true"><i></i></div></div><footer class="terminal-evidence-legend"></footer></article><article class="terminal-distribution-chart"><header><div class="terminal-chart-heading"><span class="terminal-chart-glyph" data-chart-glyph="distribution">${evidenceGlyph('distribution')}</span><h3></h3></div><button class="terminal-chart-info" type="button" data-chart-info="distribution" aria-label="${L(...chartInfoLabels.distribution)}" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/></svg></button></header><p class="terminal-chart-note" hidden></p><div class="terminal-distribution-readout"></div><div class="terminal-plot terminal-distribution-plot" role="img"></div></article><details class="terminal-chart-data"><summary></summary><div></div></details>`;
 const insightHistory=new WorkbenchInsightHistory(),versionStart=new Map(),seenEvents=new Set();let marketKey='',marketDispose=null,marketFrame=null,marketPending=null,legacyMarket=null,insightStamp='',tracksStamp='',selectedKey='',selectedEvent='';
 const openedAt=performance.now(),history=new WorkbenchChartHistory(),evidenceMotion=new WorkbenchEvidenceMotion(),charts=new Map(),runningIcons=new Map(),reduced=matchMedia('(prefers-reduced-motion:reduce)');
 let disposed=false,suspended=false;
 let context=null,windowSize=120,api=null,loading=null,visible=false,renderStamp='',lastSymbol='',lastLocale='',loadFailed=false,quoteRevision='',equityValue=null,layoutMode='';
 const q=s=>host.querySelector(s);
 let pnlInspected='',pnlFocused='',pnlDismissed='',pnlScope='',pnlEntered=false,pnlAccountOnly=false,pnlPeriod='all';
 host.addEventListener('pointermove',event=>{
  const cell=event.target.closest('[data-pnl-key]');
  if(cell){if(cell.dataset.pnlKey!==pnlDismissed&&cell.dataset.pnlKey!==pnlInspected){pnlDismissed='';renderPnlDetail(cell.dataset.pnlKey);}return;}
  const point=scanPointFromEvent(event);if(point?.dataset.scanSymbol&&point.dataset.scanSymbol!==scanInspected&&point.dataset.scanSymbol!==scanDismissed)renderScanDetail(point.dataset.scanSymbol);
 },{passive:true});
 const sizes=new Map(),htmlCache=new WeakMap();let renderTimer=0,layoutPending=false;
 const scanner=scannerFactory(()=>{onMarketScan(scanner.rows());requestRender();},{subscribeDepth:subscribeSpotDepth}),scanMotion=new WorkbenchScanMotion();let scatterStamp='',scanInspected='',scanDismissed='',scanRestoringFocus=false;
 const background=backgroundFactory({onChange:rows=>{onSharedContext(rows);requestRender();}});
 function requestRender(){if(!disposed&&!suspended&&!renderTimer)renderTimer=setTimeout(()=>{renderTimer=0;render();},0);}
 const observers=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);syncMotion();if(visible)requestRender();else{releaseLegacyMarket();renderPnlDetail();}},{root:stage,rootMargin:'0px'});observers.observe(host);
 const pnlObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){pnlEntered=true;q('.pnl-led')?.classList.add('lms-on');q('.pnl-led-board')?.classList.add('lms-on');pnlObserver.disconnect();}},{root:stage,threshold:.2});pnlObserver.observe(q('.terminal-insight-capital'));
 const resize=new ResizeObserver(entries=>{
  for(const {target,contentRect} of entries)sizes.set(target,{width:contentRect.width,height:contentRect.height});
  layoutPending=true;requestRender();
 });
 for(const node of [host,q('.terminal-insight-scatter'),...host.querySelectorAll('.terminal-plot')])resize.observe(node);
 const themes=new MutationObserver(()=>{renderStamp='';render();});themes.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','lang','data-reduced-motion']});
 const fontsLoaded=()=>{if(!disposed&&!suspended){renderStamp='';render();}};document.fonts.addEventListener('loadingdone',fontsLoaded);
 function stopMotion(){host.dataset.chartMotion='false';evidenceMotion.reset();for(const animation of runningIcons.values())animation.cancel();runningIcons.clear();}
 function syncMotion(){
  const active=Boolean(!disposed&&!suspended&&context&&visible&&!host.hidden&&!document.hidden&&document.body.dataset.page==='workbench'&&document.body.dataset.paused!=='true'&&!context.paused&&!reduced.matches&&document.documentElement.dataset.reducedMotion!=='true');
  if(!active)stopMotion();else host.dataset.chartMotion='true';return active;
 }
 function signalIcon(element,kind='data'){
  if(!element?.animate||host.dataset.chartMotion!=='true')return;
  runningIcons.get(element)?.cancel();
  const frames=kind==='review'?[{transform:'scale(.94)',opacity:.5},{transform:'scale(1.12)',opacity:1,offset:.4},{transform:'scale(1)',opacity:1}]:[{transform:'translateY(0)',opacity:.65},{transform:'translateY(-2px)',opacity:1,offset:.35},{transform:'translateY(0)',opacity:1}];
  const easing=getComputedStyle(host).getPropertyValue('--ease-out').trim()||'cubic-bezier(0.23, 1, 0.32, 1)',animation=element.animate(frames,{duration:220,easing});runningIcons.set(element,animation);
  animation.onfinish=animation.oncancel=()=>{if(runningIcons.get(element)===animation)runningIcons.delete(element);};
 }
 function positionCursor(){
  if(!context)return;
  const plot=q('.terminal-evidence-plot'),cursor=q('.terminal-evidence-cursor'),columns=history.timeline.slice(-24),count=Math.max(12,columns.length),left=layoutMode==='compact'?66:80,width=Math.max(0,(sizes.get(plot)?.width||0)-left-88)/count;
  cursor.style.width=Math.max(2,width-3)+'px';cursor.style.transform=`translateX(${left+Math.max(0,columns.length-1)*width+1.5}px)`;cursor.hidden=!columns.length;
 }
 const stateObserver=new MutationObserver(()=>{syncMotion();if(document.body.dataset.page!=='workbench'){releaseMarket();releaseLegacyMarket();renderScanDetail();renderPnlDetail();}renderStamp='';insightStamp='';render();});stateObserver.observe(document.body,{attributes:true,attributeFilter:['data-page','data-paused','data-mobile-view','data-workbench-view']});
 reduced.addEventListener?.('change',()=>{syncMotion();renderStamp='';render();});
 function put(node,text){if(htmlCache.get(node)!==text){node.innerHTML=text;htmlCache.set(node,text);}}
 function plot(node,option,reset=false){
  let chart=charts.get(node);if(!chart){const size=sizes.get(node);if(!size?.width||!size.height)return;chart=api.init(node,null,{renderer:'canvas',devicePixelRatio:Math.min(devicePixelRatio,2),...size});charts.set(node,chart);}
  chart.setOption(option,{notMerge:reset,lazyUpdate:true});
 }
 function paint(){const s=getComputedStyle(host),color=k=>s.getPropertyValue(k).trim();return {ink:color('--b-ink'),muted:color('--b-muted'),line:color('--b-line'),panel:color('--b-panel'),accent:color('--chart-accent')||'#6fe3ff',context:color('--chart-series-2')||'#4a6bff',up:color('--chart-series-5')||'#5fe08a',down:color('--chart-series-7')||'#ff7a6b',gold:color('--chart-series-4')||'#ffd84d',spectrum:dimensions.map(([key],i)=>color('--optical-'+key)||color('--chart-series-'+[3,1,6,2,5,4][i]))};}
 const scanReasons=()=>({unsupported:L('待接入','Not connected'),loading:L('采集中','Fetching'),warmup:L('预热中','Warming up'),stale:L('待刷新','Stale'),invalid:L('待核验','Invalid data'),error:L('暂不可用','Unavailable'),reconnecting:L('重连中','Reconnecting'),'no-range':L('波动不足','No range')});
 const scanSignal=value=>L(...({'breakout-up':['上破 20 日区间','20-session high break'],'breakout-down':['下破 20 日区间','20-session low break'],overbought:['RSI ≥ 70','RSI ≥ 70'],oversold:['RSI ≤ 30','RSI ≤ 30'],balanced:['持续跟踪','Tracking']}[value]||['采集与核验','Fetching & validating']));
 function scanPointFromEvent(event){
  const point=event.target.closest('[data-scan-symbol]');
  if(point?.tagName?.toLowerCase()!=='g'||event.target.tagName?.toLowerCase()==='text'||(event.type==='click'&&event.detail===0))return point;
  const matrix=point.ownerSVGElement?.getScreenCTM();if(!matrix)return point;
  const local=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse()),width=sizes.get(q('.terminal-insight-scatter'))?.width||240;
  const symbol=marketScatterHit(scanner.rows(),Math.round(width),local.x,local.y);
  return symbol?q(`.scan-point[data-scan-symbol="${symbol}"]`):point;
 }
 function renderPnlDetail(key=''){
  const node=q('.pnl-tooltip'),prior=q('[data-pnl-inspected]'),cell=key?q(`[data-pnl-key="${key}"]`):null;
  prior?.removeAttribute('data-pnl-inspected');prior?.removeAttribute('aria-describedby');pnlInspected=cell?key:'';
  q('.pnl-led')?.classList.toggle('lms-hot',Boolean(cell));
  if(!node)return;
  if(!cell){if(node.matches?.(':popover-open'))node.hidePopover?.();node.hidden=true;return;}
  cell.setAttribute('data-pnl-inspected','');cell.setAttribute('aria-describedby',node.id);node.hidden=false;
  const {pnlState:state,pnlRange:range,pnlAmount:amount,pnlUnit:unit,pnlFills:fills}=cell.dataset;
  const records=cell.dataset.pnlRecords==='true'&&key===pnlFocused,restore=captureProductFocus(node);
  node.setAttribute('role',records?'dialog':'tooltip');node.setAttribute('aria-label',L('时间片盈亏','Interval P&L'));
  const action=records?`<button type="button" class="lms-day-records" data-statements="AI_SPECTRUM" data-statement-return-id="${esc(cell.id)}"${cell.dataset.statementExample?` data-statement-example="${esc(cell.dataset.statementExample)}"`:''} data-statement-from="${esc(cell.dataset.statementFrom)}" data-statement-to="${esc(cell.dataset.statementTo)}" data-statement-day="${esc(cell.dataset.statementDay)}" data-statement-zone="${esc(cell.dataset.statementZone)}" aria-haspopup="dialog">${L('查看当日记录','View day records')}${uiGlyph('arrow')}</button>`:'';
  put(node,`<span>${esc(range)}</span><strong data-state="${state}">${state==='future'?L('尚未到此时段','Future interval'):state==='empty'?L('无结算记录','No settled activity'):amount==='—'?L('结算待确认','Settlement pending'):esc(amount)+` <small>${esc(unit)}</small>`}</strong>${Number(fills)>0&&!['unknown','future'].includes(state)?`<small>${esc(fills)} ${L('笔成交','fills')}</small>`:''}${action}`);restore();
  if(node.showPopover&&!node.matches(':popover-open'))node.showPopover();
  const anchor=(cell.querySelector('.lms-dot')||cell).getBoundingClientRect(),box=node.getBoundingClientRect();
  node.style.left=Math.max(16,Math.min(window.innerWidth-box.width-16,anchor.right+14+box.width<=window.innerWidth-16?anchor.right+14:anchor.left-box.width-14))+'px';
  node.style.top=Math.max(16,Math.min(window.innerHeight-box.height-16,anchor.y+anchor.height/2-box.height/2))+'px';
 }
 function focusPnlCell(cell){
  pnlFocused=cell.dataset.pnlKey;
  for(const item of host.querySelectorAll('[data-pnl-key]'))item.setAttribute('tabindex',item===cell?'0':'-1');
  if(pnlFocused!==pnlDismissed)renderPnlDetail(pnlFocused);
 }
 function renderScanDetail(symbol){
  const target=q('.terminal-insight-scatter'),node=q('.scan-detail'),row=scanner.rows().find(r=>r.symbol===symbol);
  scanInspected=row?.symbol||'';if(scanInspected&&scanInspected!==scanDismissed)scanDismissed='';if(!node)return;if(!row&&node.matches?.(':popover-open'))node.hidePopover();node.hidden=!row;target.dataset.inspecting=String(Boolean(row));
  for(const point of target.querySelectorAll('[data-scan-symbol]')){
   point.dataset.inspected=String(point.dataset.scanSymbol===scanInspected);
   if(point.dataset.inspected==='true')point.setAttribute('aria-describedby','workbench-scan-detail');else point.removeAttribute('aria-describedby');
  }
  for(const trail of target.querySelectorAll('[data-scan-trail]'))trail.dataset.emphasized=String(trail.dataset.scanTrail===(scanInspected||context?.task.symbol));
  if(!row)return;
  const session=row.paused?L('已暂停','Paused'):row.session==='closed'?L('休市','Closed'):row.session==='delayed'?L('延迟日线','Delayed daily'):row.session==='last-close'?L('完整日线','Closed daily'):L('实时接收','Streaming');
  const title=row.state==='ready'?scanSignal(row.signal):scanReasons()[row.state]||L('等待','Waiting');
  const date=row.sessionDate|| (row.sampleAt?new Intl.DateTimeFormat('en-CA',{timeZone:row.timezone||'UTC',month:'2-digit',day:'2-digit'}).format(row.sampleAt*1000):'—');
  put(node,`<div><b>${esc(row.symbol)}</b><small>${row.state==='ready'?`${fmt(row.price,row.unit==='%'?3:2)} ${esc(row.unit||'USDT')}`:esc(title)}</small></div>${row.state==='ready'?`<dl><div><dt>${L('趋势','Trend')}</dt><dd>${row.x>0?'+':''}${fmt(row.x,2)} <span>ATR</span></dd></div><div><dt>${L('动量','Momentum')}</dt><dd>${fmt(row.y,1)} <span>RSI</span></dd></div></dl>`:''}<footer>${esc(row.source||'Binance Spot')} · ${esc(session)} · ${esc(date)}</footer>`);
  if(node.showPopover&&!node.matches(':popover-open'))node.showPopover();
  const point=target.querySelector(`[data-scan-symbol="${row.symbol}"]`),anchor=(point?.querySelector('.scan-core')||point||target).getBoundingClientRect(),box=node.getBoundingClientRect();
  node.style.left=Math.max(16,Math.min(window.innerWidth-box.width-16,anchor.x+anchor.width/2-box.width/2))+'px';
  node.style.top=(anchor.bottom+box.height+12<=window.innerHeight-16?anchor.bottom+12:Math.max(16,anchor.top-box.height-12))+'px';
 }
 function renderScatter(rows,feedback){
  if(disposed||suspended||!context||!visible||host.hidden||document.hidden||document.body.dataset.page!=='workbench'||document.body.dataset.workbenchView!=='photonic')return;
  const target=q('.terminal-insight-scatter'),size=sizes.get(target);if(!size?.width)return;
  const ready=rows.filter(row=>row.state==='ready'),locale=document.documentElement.lang;
  const stamp=JSON.stringify([rows.map(row=>[row.symbol,row.state,row.closedAt,row.x,row.y,row.paused,row.session,row.signal]),context.task.symbol,locale,document.documentElement.dataset.theme,size.width]);
  const width=Math.max(240,Math.round(size.width)),right=width-30,left=32,mid=(right+left)/2;
  const x=value=>marketScatterPosition(value,50,width).x,y=value=>marketScatterPosition(0,value,width).y;
  if(stamp!==scatterStamp){
   scatterStamp=stamp;
   const focused=target.contains(document.activeElement)?document.activeElement?.dataset.scanSymbol:null,labels=marketScatterLabels(ready,width);
   const palette=document.documentElement.dataset.theme==='light'?['#ac601f','#6e52a4','#0b8466','#1a749b','#365ba7','#9c781b','#a04394','#386779']:['#ffad65','#b69aff','#60e3b9','#64cfff','#7b98ff','#e3ce7d','#d18edc','#abdce4'];
   const color=row=>palette[Math.max(0,rows.findIndex(r=>r.symbol===row.symbol))%palette.length];
   target.innerHTML=`<header class="insight-head"><div class="insight-title"><h3>${L('市场扫描','Market scan')}</h3></div><span class="scan-count" aria-label="${ready.length} / ${rows.length} ${L('个标的已核验，日线','assets verified, daily bars')}"><b>${ready.length}</b><span> / ${rows.length}</span><i>D1</i></span></header>
   <div class="scan-chart"><svg viewBox="0 0 ${width} 207" role="group" aria-label="${L('固定四象限：趋势为收盘价与EMA20的偏离除以ATR14，范围正负3；动量为RSI14减50，范围正负30。点位来自完整日线，超界停靠边缘。悬浮或聚焦查看数值，点击联动分析。','Fixed quadrants: trend is (close minus EMA20)/ATR14, from −3 to +3; momentum is RSI14 minus 50, from −30 to +30. Positions use closed daily bars; outliers stop at the edge. Hover or focus for values; select for analysis.')}">
   <defs><pattern id="workbench-scan-grid" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" class="scan-grid-dot"/></pattern></defs>
   <rect x="${left}" y="31" width="${right-left}" height="142" fill="url(#workbench-scan-grid)"/>
   ${[20,80].map(v=>`<line class="scan-grid" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text class="scan-axis" x="25" y="${y(v)+4}" text-anchor="end">${v===80?'+30':'−30'}</text>`).join('')}
   ${[-3,3].map(v=>`<line class="scan-grid" x1="${x(v)}" x2="${x(v)}" y1="31" y2="173"/><text class="scan-axis" x="${x(v)}" y="192" text-anchor="middle">${v>0?'+3':'−3'}×</text>`).join('')}
   <text class="scan-axis" x="${mid}" y="192" text-anchor="middle">0</text><text class="scan-caption" x="${left}" y="16">${L('动量 ↑','MOMENTUM ↑')}</text><text class="scan-caption" x="${right}" y="16" text-anchor="end">${L('趋势 →','TREND →')}</text>
   <line class="scan-zero-axis" x1="${left}" x2="${right}" y1="${y(50)}" y2="${y(50)}"/><line class="scan-zero-axis" x1="${mid}" x2="${mid}" y1="31" y2="173"/>
   <text class="scan-quadrant" x="${left+7}" y="44">${L('动量修复','RECOVERY')}</text><text class="scan-quadrant" x="${right-7}" y="44" text-anchor="end">${L('上行共振','UPTREND')}</text><text class="scan-quadrant" x="${left+7}" y="167">${L('下行共振','DOWNTREND')}</text><text class="scan-quadrant" x="${right-7}" y="167" text-anchor="end">${L('动量回落','COOLING')}</text>
   ${ready.map(row=>`<g class="scan-history" data-scan-trail="${esc(row.symbol)}" data-emphasized="${row.symbol===(scanInspected||context.task.symbol)}" style="--point-color:${color(row)}"><polyline class="scan-trail" points="${(row.history||[]).map(p=>`${x(p.x)},${y(p.y)}`).join(' ')}"/>${(row.history||[]).slice(0,-1).map((p,i)=>`<circle class="scan-history-dot" cx="${x(p.x)}" cy="${y(p.y)}" r="1.8" opacity="${.18+i*.12}"/>`).join('')}</g>`).join('')}
   ${ready.map(row=>{const label=labels.get(row.symbol);return `<g role="button" tabindex="0" data-scan-symbol="${esc(row.symbol)}" aria-pressed="${row.symbol===context.task.symbol}" aria-label="${esc(row.symbol)} · ${fmt(row.x,2)} ATR · RSI ${fmt(row.y,1)}${marketScatterPosition(row.x,row.y,width).clipped?L(' · 超出显示范围',' · Outside display range'):''}" class="scan-point" data-clipped="${marketScatterPosition(row.x,row.y,width).clipped}" data-session="${esc(row.session||'open')}" data-discovered="${row.signal!=='balanced'}" style="--point-color:${color(row)}" transform="translate(${x(row.x)},${y(row.y)})"><circle class="scan-hit" r="22"/><circle class="scan-pulse" r="9"/><circle class="scan-halo" r="12"/><circle class="scan-ring" r="7.5"/><circle class="scan-core" r="3.5"/>${Math.abs(label.dy)>7?`<path class="scan-label-link" d="M0 0L${label.dx} ${label.dy-4}"/>`:''}<text x="${label.dx}" y="${label.dy}" text-anchor="${label.anchor}">${esc(row.symbol)}</text></g>`;}).join('')}
   ${ready.length?'':`<text class="scan-empty" x="${mid}" y="105" text-anchor="middle">${L('正在接入各市场日线','Connecting daily market feeds')}</text>`}</svg></div>
   <div class="scan-assets" aria-label="${L('各标的实际采集状态','Actual asset feed states')}">${rows.filter(row=>row.state!=='ready').map(row=>`<button type="button" data-scan-symbol="${esc(row.symbol)}" aria-pressed="${row.symbol===context.task.symbol}" data-state="${row.state}" style="--point-color:${color(row)}"><i></i><b>${esc(row.symbol)}</b><small>${scanReasons()[row.state]||'—'}</small></button>`).join('')}</div><div class="scan-detail" id="workbench-scan-detail" role="tooltip" popover="manual" hidden></div>`;
   if(focused){scanRestoringFocus=true;target.querySelector(`[data-scan-symbol="${focused}"]`)?.focus({preventScroll:true});scanRestoringFocus=false;}
   renderScanDetail(scanInspected);
  }else if(scanInspected)renderScanDetail(scanInspected);
  for(const [symbol,event]of feedback){
   const point=target.querySelector(`.scan-point[data-scan-symbol="${symbol}"]`);if(!point?.animate)continue;
   const animate=(node,frames,duration)=>{runningIcons.get(node)?.cancel();const animation=node.animate(frames,{duration,easing:'cubic-bezier(0.23, 1, 0.32, 1)'});runningIcons.set(node,animation);animation.onfinish=animation.oncancel=()=>{if(runningIcons.get(node)===animation)runningIcons.delete(node);};};
   if(event.from){const row=rows.find(r=>r.symbol===symbol);animate(point,[{transform:`translate(${x(event.from.x)}px,${y(event.from.y)}px)`},{transform:`translate(${x(row.x)}px,${y(row.y)}px)`}],420);}
   if(event.pulse)animate(point.querySelector('.scan-pulse'),[{transform:'scale(.7)',opacity:.7},{transform:'scale(2.4)',opacity:0}],850);
  }
 }
 function releaseMarket(){
  marketPending?.dispose?.();marketPending?.node.remove();marketPending=null;
  marketDispose?.();marketDispose=null;marketFrame?.node.remove();marketFrame=null;marketKey='';
  q('.insight-market-switch')?.remove();
 }
 function releaseLegacyMarket(){
  if(!legacyMarket)return;
  legacyMarket.dispose?.();legacyMarket=null;put(q('.terminal-price-plot'),'');
 }
 function renderLegacyMarket(sample,active){
  const target=q('.terminal-price-plot'),unit=sample.unit==='index'?L('点','pts'):sample.unit;
  target.style.height='auto';target.removeAttribute('role');target.removeAttribute('tabindex');
  q('.terminal-chart-ranges').hidden=true;
  put(q('.terminal-chart-title'),`${tokenIcon(sample.symbol,{size:20})}<h3>${esc(sample.symbol)}</h3><span>${esc(sample.source)}</span>`);
  const states={paused:L('行情已暂停','Market paused'),stale:L('日线已过期','Daily observation expired'),error:L('行情暂不可用','Market unavailable'),unsupported:L('行情源尚未接入','Market feed not connected')},state=states[sample.state]||L('正在接入行情','Loading market');
  const date=Number.isFinite(sample.closedAt)?new Intl.DateTimeFormat(document.documentElement.lang,{timeZone:sample.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(sample.closedAt*1000)):'';
  put(q('.terminal-market-readout'),sample.state==='ready'?`<strong>${fmt(sample.price,sample.unit==='%'?4:2)}<small>${esc(unit)}</small></strong><span>${L('日线收盘','Daily close')} · ${esc(date)}</span>`:`<span role="status">${state}</span>`);
  if(!active||!sample.config){releaseLegacyMarket();put(target,`<p role="status">${active?state:L('行情已暂停','Market paused')}</p>`);}
  else{
   const key=[sample.symbol,sample.config.period,document.documentElement.lang].join(':');
   if(legacyMarket?.key!==key){
    releaseLegacyMarket();const old=charts.get(target);if(old){old.dispose();charts.delete(target);}
    put(target,tradingChartPanel('workbench-live-'+sample.symbol,{...sample.config,analysisLayers:true}));
    legacyMarket={key,dispose:mountMarketCharts(target)};
   }
  }
  const depth=sample.depth;
  put(q('.terminal-depth>header'),`<span>${L('现货盘口 · 前100档快照','Spot book · top 100 snapshot')}</span><span>${L('数量','Qty')} · ${esc(sample.symbol)}</span>`);
  for(const [side,selector]of [['asks','.terminal-asks'],['bids','.terminal-bids']]){
   const levels=depth?.[side]?.slice(0,7)||[],max=Math.max(0,...levels.map(level=>Number(level[1])));
   put(q(selector),levels.length?(side==='asks'?[...levels].reverse():levels).map(([price,quantity])=>`<div class="terminal-book-level" data-side="${side==='asks'?'ask':'bid'}" style="--depth:${Number(quantity)/max*100}%"><span>${fmt(Number(price))}</span><b>${fmt(Number(quantity),6)}</b></div>`).join(''):side==='asks'?`<p role="status">${sample.depthState==='unsupported'?L('此标的无现货盘口','No spot book for this asset'):sample.depthState==='paused'?L('盘口已暂停','Order book paused'):L('盘口暂不可用','Order book unavailable')}</p>`:'');
  }
  put(q('.terminal-book-mid'),depth?fmt(depth.mid):'—');
  put(q('.terminal-chart-legend'),`${esc(sample.source)} · ${L('公开只读行情','Public read-only market')}${depth?' · '+L('请求观察时间','Request observed at')+' '+esc(new Date(depth.receivedAt).toISOString()):''}`);
  put(q('.terminal-distribution-chart h3'),L('日线收盘分布','Daily-close distribution'));
  put(q('.terminal-distribution-readout'),sample.closes.length?`<span>${L('样本均值','Sample mean')}<b>${fmt(sample.mean,sample.unit==='%'?4:2)} ${esc(unit)}</b></span><span>${sample.closes.length} ${L('个实际日线收盘价','observed daily closes')}</span>`:`<span role="status">${state}</span>`);
 }
 function marketIdentity(){
  const frame=marketFrame||marketPending;if(!frame)return;
  put(q('[data-insight-symbol]'),`${tokenIcon(frame.symbol,{size:20})}<span>${esc(frame.symbol)}</span>`);
  const origin=q('.insight-sources [data-origin=market]');put(origin,`<i></i>${esc(frame.sourceLabel())}`);origin.title=frame.source;
  q('.insight-market-slot').dataset.displaySymbol=frame.symbol;
 }
 function stageMarket(view,plan,key){
  const slot=q('.insight-market-slot');marketPending?.dispose?.();marketPending?.node.remove();marketPending=null;marketKey=key;
  q('.insight-market-switch')?.remove();
  if(!view.marketConfig){if(!marketFrame)slot.innerHTML=`<div class="insight-unsupported" role="status">${L('行情源尚未接入','Market feed not connected')}</div>`;return;}
  const node=document.createElement('div'),symbol=view.symbol;node.className='insight-market-frame';node.dataset.pending=String(Boolean(marketFrame));node.dataset.initial=String(!marketFrame);
  if(marketFrame){node.setAttribute('aria-hidden','true');node.inert=true;}
  const unit=['SPX','NDX'].includes(symbol)?['点','points']:symbol==='DXY'?['指数','index']:[view.marketConfig.unit,view.marketConfig.unit];
  const pending={node,symbol,key,source:view.marketConfig.source||(view.marketConfig.venueId==='binance'?L('Binance · 现货','Binance · spot'):view.marketConfig.venueId),sourceLabel:()=>view.marketConfig.sessionBased?`${L('日线 · 收盘价','Daily · close')} · ${L(...unit)}`:view.marketConfig.venueId==='binance'?L('Binance · 现货','Binance · spot'):view.marketConfig.source||view.marketConfig.venueId,dispose:null};marketPending=pending;
  node.innerHTML=tradingChartPanel('workbench-insight-'+symbol,{...view.marketConfig,analysisLayers:true,analysisTask:{plan,compute:computeMarketStudy,onComplete:result=>{
   if(marketFrame!==pending||marketKey!==key)return;
   document.dispatchEvent(new CustomEvent('hive:analysis-complete',{detail:{symbol,closedAt:result.closedAt}}));
  }}});slot.append(node);
  if(marketFrame){const note=document.createElement('div');note.className='insight-market-switch';note.setAttribute('role','status');note.textContent=`${marketFrame.symbol} → ${symbol} · ${L('接入行情','Loading market')}`;slot.append(note);}
  node.addEventListener('trading-chart:state',event=>{
   if(marketPending!==pending||marketKey!==key)return;
   if(['snapshot','live'].includes(event.detail?.state)&&Number(node.querySelector('.trading-chart')?.dataset.candleCount)>0){
    const old=marketFrame;marketDispose?.();old?.node.remove();marketFrame=pending;marketDispose=pending.dispose;marketPending=null;
    node.dataset.pending='false';delete node.dataset.initial;node.removeAttribute('aria-hidden');node.inert=false;q('.insight-market-switch')?.remove();marketIdentity();document.dispatchEvent(new CustomEvent('hive:market-displayed',{detail:{symbol}}));
   }else if(['error','stale','unsupported'].includes(event.detail?.state)&&marketFrame){
    const note=q('.insight-market-switch');if(note)note.textContent=`${symbol} · ${L('待重新连接，当前显示','Reconnecting; showing')} ${marketFrame.symbol}`;
   }
  },true);
  marketIdentity();
 }

 function renderInsights(active){
  const {task,trade,focus,risk,time,paused}=context,view=workbenchInsights({task,focus,trade,risk}),locale=document.documentElement.lang,events=insightHistory.record(task,time,paused).filter(event=>event.version===task.version);
  const versionKey=task.symbol+':'+task.version;if(!versionStart.has(versionKey))versionStart.set(versionKey,time);
  const start=Number.isFinite(task.started)?task.started:versionStart.get(versionKey),end=view.phase==='complete'&&Number.isFinite(task.completed)?task.completed:time,elapsed=Math.max(0,end-start),span=Math.max(30,elapsed,...events.map(event=>event.at-start));
  const fresh=events.filter(event=>!seenEvents.has(event.id));events.forEach(event=>seenEvents.add(event.id));
  const stamp=[versionKey,Math.floor(time),locale,layoutMode,paused,view.phase,view.outcome,events[0]?.id,JSON.stringify(view.capital),context.syncStatus?.state,context.syncStatus?.generation,context.syncStatus?.source,context.syncStatus?.scope?.accountId,context.syncStatus?.scope?.environment,location.search,pnlAccountOnly,pnlPeriod,history.account.at(-1)?.at].join('|');
  const plan=view.marketConfig?marketAnalysisPlan({market:view.marketConfig.market,sessionBased:view.marketConfig.sessionBased,trade,draft:focus?.draft}):null;
  const market=q('.terminal-insight-market'),slot=q('.insight-market-slot'),key=view.marketConfig?view.marketConfig.market+':'+plan.ref:'none:'+task.symbol;
  if(!market.querySelector('[data-insight-patrol]'))market.querySelector('.insight-sources').insertAdjacentHTML('afterbegin',`<button type="button" data-insight-patrol aria-pressed="${document.body.dataset.researchPatrol==='true'}">${document.body.dataset.researchPatrol==='true'?L('自动轮巡','Auto patrol'):L('固定标的','Pinned asset')}</button>`);
  market.dataset.feed=view.marketConfig?.venueId||'unsupported';
  if(marketKey!==key)stageMarket(view,plan,key);
  if(marketPending&&visible&&!marketPending.dispose)marketPending.dispose=mountTradingCharts(marketPending.node);
  put(q('.insight-evidence-summary-slot'),workbenchEvidenceSummary(view.evidence,host.id+'-evidence'));
  if(stamp===insightStamp&&!fresh.length)return;insightStamp=stamp;
  put(market.querySelector('.insight-kicker'),L('行情与判断','Market & view'));
  put(q('.terminal-insight-evidence h3'),L('研究依据','Research evidence'));
  put(q('.terminal-insight-capital .insight-kicker'),L('盈亏概览','Profit & loss'));
  marketIdentity();
  q('.insight-sources [data-origin="market"]').hidden=!view.marketConfig;
  const verdict=q('.insight-verdict'),complete=view.phase==='complete';verdict.hidden=true;verdict.dataset.outcome=complete?view.outcome||'watch':'pending';
  put(verdict.querySelector('.insight-verdict-chip'),complete?outcomeLabel(view.outcome):`${L('研究中','Researching')} · ${phaseLabel(view.phase)}`);
  const usable=view.evidence.filter(item=>item.status!=='na'),reviewed=usable.filter(item=>['retain','context','conflict'].includes(item.status)).length,waiting=usable.filter(item=>item.status==='pending').length;
  put(verdict.querySelector('h4'),complete&&view.title?esc(t(view.title)):L(`正在${phaseLabel(view.phase)}`,`Now ${phaseLabel(view.phase)}`));
  put(verdict.querySelector('p'),complete&&view.thesis?esc(t(view.thesis)):L(`已核对 ${reviewed} / ${usable.length} 项资料${waiting?`，${waiting} 项待采集`:''}`,`${reviewed} of ${usable.length} sources reviewed${waiting?`, ${waiting} pending`:''}`));
  put(verdict.querySelector('.insight-verdict-next'),complete&&view.next?`${L('下一步','Next')} · ${esc(t(view.next))}`:'');
  if(fresh.some(event=>event.type==='phase'&&event.to==='complete'||event.type==='conclusion')&&active)verdict.animate?.([{opacity:.4,transform:'translateY(4px)'},{opacity:1,transform:'none'}],{duration:420,easing:'cubic-bezier(.2,.7,.1,1)'});
  const freshIds=new Set(active?fresh.map(event=>event.id):[]),pos=at=>Math.min(100,Math.max(0,(at-start)/span*100)).toFixed(2);
  const phases=events.filter(event=>event.type==='phase').reverse(),evidenceEvents=events.filter(event=>event.type==='evidence');
  if(selectedKey&&!view.evidence.some(item=>item.key===selectedKey))selectedKey='';
  if(selectedEvent&&!evidenceEvents.some(event=>event.id===selectedEvent))selectedEvent='';
  const focused=document.activeElement?.closest?.('.insight-tracks [data-insight-key],.insight-tracks [data-insight-event]'),refocus=focused&&(focused.dataset.insightKey?`[data-insight-key="${focused.dataset.insightKey}"]`:`[data-insight-event="${focused.dataset.insightEvent}"]`);
  const nameOf=key=>L(...dimensions.find(([name])=>name===key)[1]);
  const tracksKey=[versionKey,start,locale,selectedKey,selectedEvent,events.map(event=>event.id).join(','),view.evidence.map(item=>item.status).join(',')].join('|');
  if(tracksKey===tracksStamp){for(const node of host.querySelectorAll('.insight-tracks [data-at]'))node.style.left=pos(Number(node.dataset.at))+'%';}
  else{tracksStamp=tracksKey;
  put(q('.insight-tracks'),`<div class="insight-phase-marks" aria-hidden="true">${phases.map(event=>`<i style="left:${pos(event.at)}%" data-at="${event.at}" data-to="${event.to}"></i>`).join('')}</div>${view.evidence.map(item=>{
   const dots=evidenceEvents.filter(event=>event.key===item.key).reverse(),selected=item.key===selectedKey;
   return `<div class="insight-track" data-key="${item.key}" data-state="${item.status}"${selected?' data-selected':''}><button type="button" class="insight-track-name" data-insight-key="${item.key}" aria-pressed="${selected}"><i>${evidenceGlyph(item.key)}</i>${nameOf(item.key)}</button><span class="insight-track-line"><i class="insight-track-carrier" aria-hidden="true"></i>${dots.map(event=>`<button type="button" style="left:${pos(event.at)}%" data-at="${event.at}" data-to="${event.to}" data-insight-event="${esc(event.id)}"${freshIds.has(event.id)?' data-new':''}${event.id===selectedEvent?' aria-pressed="true"':''} aria-label="${esc(`${nameOf(item.key)} ${statusLabel(event.from)} → ${statusLabel(event.to)} · ${runClock(event.at-start)}`)}"></button>`).join('')}</span><b class="insight-track-state">${statusLabel(item.status)}</b></div>`;
  }).join('')}<div class="insight-track-axis" aria-hidden="true"></div>`);
  if(refocus)q('.insight-tracks '+refocus)?.focus({preventScroll:true});}
  put(q('.insight-track-axis'),`<span>00:00</span><span>${runClock(span/2)}</span><span>${runClock(span)}</span>`);
  put(q('.insight-track-caption'),paused?L('监测已暂停 · 圆点保留依据变化','Monitoring paused · Evidence events retained'):L('光轨持续监测 · 圆点记录依据变化','Lanes monitor sources · Dots mark evidence changes'));
  const chosen=view.evidence.find(item=>item.key===selectedKey),change=evidenceEvents.find(event=>event.id===selectedEvent);
  const detail=q('.insight-evidence-detail');detail.dataset.key=selectedKey;detail.hidden=!chosen;
  if(chosen)put(detail,`<header><b><i aria-hidden="true">${evidenceGlyph(selectedKey)}</i>${nameOf(selectedKey)}</b><span data-state="${chosen.status}">${statusLabel(chosen.status)}</span></header>${change?`<p class="insight-change">${statusLabel(change.from)} → ${statusLabel(change.to)} · ${runClock(change.at-start)}${change.text&&change.text!==chosen.text?`<br>${esc(t(change.text))}`:''}</p>`:''}<p>${chosen.status==='na'?L('此资产不使用该类资料','This source does not apply to this asset'):chosen.text?esc(t(chosen.text)):L('本轮尚无这项资料','No input for this source yet')}</p>${chosen.source?`<small>${L('来源','Source')} · ${esc(t(chosen.source))}</small>`:''}`);
  const judgment=q('.insight-judgment');judgment.hidden=true;judgment.dataset.phase=view.phase;judgment.dataset.outcome=view.outcome||'';
  if(active&&fresh.some(event=>event.type==='phase'&&event.to==='complete'))judgment.dataset.converge=fresh[0].id;else delete judgment.dataset.converge;
  const latest=events.find(event=>event.type==='evidence');
  put(judgment.querySelector('b'),complete?outcomeLabel(view.outcome):phaseLabel(view.phase));
  put(judgment.querySelector('small'),latest?`${L('最新依据','Latest')} · ${L(...dimensions.find(([key])=>key===latest.key)[1])} ${statusLabel(latest.to)} · ${runClock(latest.at-start)}`:L('等待第一条资料变化','Waiting for the first evidence change'));
  const params=new URLSearchParams(location.search),canReview=statementExampleContext(trade,context.syncStatus);
  if(params.has('st_example')&&!canReview){params.delete('st_example');window.history.replaceState(null,'','?'+params);pnlAccountOnly=true;}
  const c=view.capital,daily=workbenchPnlSeries(trade,context.syncStatus,{example:params.get('st_example'),accountOnly:pnlAccountOnly,period:pnlPeriod}),card=q('.terminal-insight-capital'),running=Boolean(c.runId);card.dataset.run=running?'active':'none';card.dataset.runState=c.runState||'';q('.insight-lock').hidden=!c.locked;
  put(card.querySelector('h3'),esc(c.accountId));
  const body=q('.insight-capital-body'),expanded=body.querySelector?.('.pnl-details')?.open,restoreFocus=captureProductFocus(body),focusedPnl=document.activeElement?.closest?.('[data-pnl-key]')?.dataset?.pnlKey,focusedPeriod=document.activeElement?.closest?.('[data-pnl-period]')?.dataset?.pnlPeriod;
  const statementEntry=card.querySelector('.pnl-history-link');
  const exampleEntry=card.querySelector('[data-pnl-example]');exampleEntry.hidden=!canReview;exampleEntry.dataset.pnlExample=daily.example?'account':'example';put(exampleEntry,daily.example?L('返回当前账户','Back to current account'):L('参考账单','Reference records'));
  if(daily.example)statementEntry.dataset.statementExample=daily.example;else delete statementEntry.dataset.statementExample;
  for(const [field,value]of [['statementFrom',daily.from],['statementTo',daily.to],['statementZone',daily.timeZone]])statementEntry.dataset[field]=value;
  const scope=c.scope+':'+(daily.example||'account')+':'+pnlPeriod,scroll=body.querySelector('.lms-scroll')?.scrollLeft||0,sameScope=pnlScope===scope;
  const previousAmount=pnlScope===scope?body.querySelector('.lms-big'):null;
  if(pnlScope!==scope){pnlScope=scope;pnlFocused=pnlDismissed='';renderPnlDetail();}
  put(body,c.known?capitalPnlMarkup(c,daily,{selected:pnlFocused,on:pnlEntered||reduced.matches||document.documentElement.dataset.reducedMotion==='true'}):`<p class="insight-capital-empty">${L('账户数据暂不可用','Account data unavailable')}</p>`);
  if(sameScope&&body.querySelector('.lms-scroll'))body.querySelector('.lms-scroll').scrollLeft=scroll;
  const nextAmount=body.querySelector('.lms-big');
  if(previousAmount&&nextAmount&&previousAmount!==nextAmount){nextAmount.replaceWith(previousAmount);updatePnlRolling(previousAmount,nextAmount.dataset.pnlText);}
  if(expanded&&body.querySelector('.pnl-details'))body.querySelector('.pnl-details').open=true;
  if(focusedPnl){const next=body.querySelector(`[data-pnl-key="${focusedPnl}"]`);(next||body).focus({preventScroll:true});}else if(focusedPeriod)body.querySelector('[data-pnl-period="'+focusedPeriod+'"]')?.focus({preventScroll:true});else restoreFocus();
  if(pnlInspected)renderPnlDetail(pnlInspected);
 }
 async function render(){
  if(disposed||suspended)return;
  if(layoutPending){
   // Changing columns resizes the observed cards. Apply the measurements after observer delivery.
   layoutPending=false;
   const width=sizes.get(host)?.width||0,columns=width<800?'stacked':'wide';
   if(host.dataset.chartLayout!==columns)host.dataset.chartLayout=columns;
   for(const [node,chart]of charts){const size=sizes.get(node);if(size?.width&&size.height)chart.resize(size);}
   const mode=width<600?'compact':'wide';if(layoutMode!==mode){layoutMode=mode;renderStamp='';}
  }
  const active=syncMotion();
  const liveMarket=marketMode(context)!=='demo';
  const sourcesActive=Boolean(!disposed&&context&&!host.hidden&&!document.hidden&&document.body.dataset.page==='workbench'&&(document.body.dataset.workbenchView==='photonic'||liveMarket)&&!context.paused&&document.body.dataset.paused!=='true');
  scanner.update(context?.scanTasks||context?.tasks||[],sourcesActive);
  background.setActive(sourcesActive&&context.researchMode==='live_readonly'&&(context.scanTasks||context.tasks||[]).some(task=>task.domain==='Crypto'));background.tick();
  const scanRows=scanner.rows();onMarketScan(scanRows);const scanFeedback=scanMotion.read(scanRows,active);
  const insightView=document.body.dataset.workbenchView==='photonic';host.dataset.insightView=String(insightView);
  if(disposed||!context||host.hidden||document.hidden||document.body.dataset.page!=='workbench'){releaseLegacyMarket();return;}
  if(!visible)return;
  if(insightView){releaseLegacyMarket();renderInsights(active);renderScatter(scanRows,scanFeedback);return;}
  renderPnlDetail();releaseMarket();
  const sample=workbenchMarketData(context,scanRows,windowSize);if(!sample)return;
  if(liveMarket)renderLegacyMarket(sample,sourcesActive);else{releaseLegacyMarket();q('.terminal-chart-ranges').hidden=false;const target=q('.terminal-price-plot');target.style.height='';target.setAttribute('role','img');target.setAttribute('tabindex','0');}
  if(q('.terminal-chart-data').open)renderTable(sample,context.task);
  if(!api){if(!loading&&!loadFailed){host.dataset.loading='true';loading=import('./node_modules/echarts/dist/echarts.esm.min.mjs').then(module=>{api=module;host.dataset.loading='false';renderStamp='';render();}).catch(()=>{loadFailed=true;host.dataset.loading='false';host.dataset.loadFailed='true';q('.terminal-chart-data').open=true;if(marketMode(context)==='demo'&&document.body.dataset.workbenchView!=='photonic')q('.terminal-price-plot').textContent=L('图表暂未载入，可查看下方数据','Chart unavailable. View data below.');});}if(!api)return;}
  const {task,trade,time,paused,observedAt}=context,locale=document.documentElement.lang;
  const stamp=[task.symbol,task.version,Math.floor(time),Math.floor(observedAt),trade.seq,trade.time,windowSize,locale,paused,document.documentElement.dataset.theme,task.evidence.map(e=>e.status).join(','),sample.mode,sample.state,sample.closedAt,sample.depth?.receivedAt].join('|');
  if(stamp===renderStamp)return;renderStamp=stamp;
  const p=paint(),mobile=layoutMode==='compact',reset=lastSymbol!==task.symbol||lastLocale!==locale,optical=document.body.dataset.workbenchView==='photonic',dark=document.documentElement.dataset.theme==='dark';lastSymbol=task.symbol;lastLocale=locale;
  const gradient=(color,opacity=.35)=>({type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:api.color.modifyAlpha(color,opacity)},{offset:1,color:api.color.modifyAlpha(color,.015)}]});
  const base={backgroundColor:'transparent',textStyle:{fontFamily:getComputedStyle(host).fontFamily,color:p.muted,fontSize:11},animation:!paused&&!reduced.matches,animationDurationUpdate:350,animationEasingUpdate:'cubicOut',aria:{enabled:false},tooltip:{trigger:'axis',renderMode:'richText',confine:true,backgroundColor:p.panel,borderColor:p.line,textStyle:{color:p.ink,fontSize:12},axisPointer:{type:'cross',lineStyle:{color:p.muted,opacity:.5},crossStyle:{color:p.muted,opacity:.5}}}};
  const xAxis={type:'category',boundaryGap:true,axisTick:{show:false},axisLine:{lineStyle:{color:p.line}},axisLabel:{color:p.muted,hideOverlap:true,fontSize:11},splitLine:{show:false}};
  const yAxis={type:'value',scale:true,position:'right',axisLabel:{color:p.muted,fontSize:11,formatter:n=>fmt(n,Math.abs(n)<10?3:Math.abs(n)<1000?2:0)+(task.symbol==='US10Y'?'%':'')},splitLine:{lineStyle:{color:p.line,type:'dashed',opacity:.5}},axisPointer:{label:{backgroundColor:p.accent}},axisTick:{show:false},axisLine:{show:false}};
  const {bars,book,price}=sample,unit=sample.unit==='点'?L('点','pts'):sample.unit==='USD/盎司'?'USD/oz':sample.unit,yieldAsset=unit==='%',quoteValue=n=>fmt(n,yieldAsset?4:2),times=bars.map(b=>workbenchTimeLabel(b.at,bars.at(-1).at));
  const mean=bars.map((b,i)=>bars.slice(Math.max(0,i-9),i+1).reduce((v,b)=>v+b.close,0)/Math.min(i+1,10));
  const spread=bars.map((b,i)=>Math.max(b.high-b.low,price*.00022)*(1+.35*Math.sin(i*.2)));
  const nearPrice=liveMarket?sample.price:bars.at(-1).close,change=sample.change;
  if(!liveMarket){
  put(q('.terminal-chart-title'),`${tokenIcon(task.symbol,{size:20})}<h3>${task.symbol}</h3><span>${L('合成行情','Synthetic market')}</span>`);
  put(q('.terminal-market-readout'),`<strong>${quoteValue(price)}<small>${unit}</small></strong><span class="${change>=0?'chart-positive':'chart-negative'}">${change>=0?'+':''}${fmt(change)}${sample.changeUnit}</span><span>${paused?L('已暂停','Paused'):L('持续更新','Updating')} · ${L('窗口','Window')} ${windowSize}s</span>`);
  q('.terminal-price-plot').setAttribute('aria-label',`${task.symbol} ${L('合成K线、均线与成交量，可拖动缩放；完整数据在下方','synthetic candles, average and volume; drag to zoom. Data below')}`);
  plot(q('.terminal-price-plot'),{...base,grid:[{left:8,right:mobile?53:65,top:12,bottom:84},{left:8,right:mobile?53:65,height:36,bottom:34}],axisPointer:{link:[{xAxisIndex:[0,1]}]},xAxis:[{...xAxis,data:times,axisLabel:{show:false}},{...xAxis,data:times,gridIndex:1,axisLabel:{...xAxis.axisLabel,interval:Math.floor(bars.length/(mobile?3:5))}}],yAxis:[yAxis,{...yAxis,gridIndex:1,splitNumber:2,axisLabel:{show:false},splitLine:{show:false}}],dataZoom:[{id:'market-window',type:'inside',xAxisIndex:[0,1],...(reset?{start:0,end:100}:{}),zoomOnMouseWheel:'ctrl',moveOnMouseMove:true,preventDefaultMouseMove:false}],series:[{id:'market-candle',name:L('K线','OHLC'),type:'candlestick',data:bars.map(b=>[b.open,b.close,b.low,b.high]),itemStyle:{color:p.up,color0:p.down,borderColor:p.up,borderColor0:p.down,shadowBlur:optical?0:3,shadowColor:api.color.modifyAlpha(p.up,.15)},barMaxWidth:7,markLine:{silent:true,symbol:'none',label:{show:false},lineStyle:{color:p.accent,opacity:.5,type:'dashed'},data:[{yAxis:nearPrice}]}},...(optical&&dark?[{id:'market-ma-glow',type:'line',data:mean,symbol:'none',smooth:.25,silent:true,lineStyle:{width:5,color:p.accent,opacity:dark?.16:.1,shadowBlur:16,shadowColor:p.accent},tooltip:{show:false}}]:[]),{id:'market-ma',name:L('均线','Average'),type:'line',data:mean,symbol:'none',smooth:.25,lineStyle:{width:optical&&dark?1.3:1.7,color:optical&&dark?'#bdefff':p.accent,shadowBlur:optical&&dark?12:optical?0:9,shadowColor:api.color.modifyAlpha(p.accent,optical?.65:.3)},itemStyle:{color:p.accent}},{id:'market-upper',name:L('观察上沿','Upper band'),type:'line',data:mean.map((v,i)=>v+spread[i]),symbol:'none',silent:true,lineStyle:{width:1,color:p.context,opacity:.42,type:'dashed'}},{id:'market-lower',name:L('观察下沿','Lower band'),type:'line',data:mean.map((v,i)=>v-spread[i]),symbol:'none',silent:true,lineStyle:{width:1,color:p.context,opacity:.42,type:'dashed'}},...(optical?[{id:'market-latest',name:L('最新报价','Latest price'),type:active?'effectScatter':'scatter',coordinateSystem:'cartesian2d',data:[[bars.length-1,nearPrice]],symbolSize:5,silent:true,z:6,itemStyle:{color:dark?'#edfdff':p.accent,shadowBlur:10,shadowColor:p.accent},rippleEffect:{period:3,scale:2.3,brushType:'stroke'},tooltip:{show:false}}]:[]),{id:'market-volume',name:L('合成量','Synthetic volume'),type:'bar',xAxisIndex:1,yAxisIndex:1,data:bars.map(b=>({value:b.volume,itemStyle:{color:b.close>=b.open?p.up:p.down,opacity:optical&&dark?.32:.45}})),barMaxWidth:7}]},reset);
  const maxDepth=Math.max(...book.flatMap(level=>[level.bidSize,level.askSize]));
  put(q('.terminal-depth>header'),`<span>${L('合成报价梯度','Synthetic ladder')}</span><span>${L('量','Qty')}</span>`);
  for(const [side,selector]of [['ask','.terminal-asks'],['bid','.terminal-bids']])put(q(selector),(side==='ask'?[...book.slice(0,7)].reverse():book.slice(0,7)).map(level=>`<div class="terminal-book-level" data-side="${side}" style="--depth:${level[side+'Size']/maxDepth*100}%"><span>${quoteValue(level[side])}${yieldAsset?'%':''}</span><b>${fmt(level[side+'Size'])}</b></div>`).join(''));
  put(q('.terminal-book-mid'),quoteValue(price)+(yieldAsset?'%':''));
  put(q('.terminal-chart-legend'),`<span><i style="background:${p.up}"></i>${L('上涨','Up')}</span><span><i style="background:${p.down}"></i>${L('下跌','Down')}</span><span><i style="background:${p.accent}"></i>MA10</span><span>${L('拖动缩放 · Ctrl + 滚轮','Drag to pan · Ctrl + scroll to zoom')}</span>`);
  }
  put(q('.terminal-equity-chart h3'),L('模拟资产','Simulated equity'));
  const account=history.account,first=account[0]?.value??trade.cash,equity=workbenchAccount(trade).equity,delta=equity-first;
  put(q('.terminal-equity-readout'),`<strong>${fmt(equity)}</strong><span>USD eq.</span><b class="${delta>=0?'chart-positive':'chart-negative'}">${delta>=0?'+':''}${fmt(delta)}</b>`);
  q('.terminal-equity-plot').setAttribute('aria-label',L('页面打开后的模拟账面资产变化，暂无历史时显示当前记录','Simulated equity since opening this page. No earlier history is invented.'));
  plot(q('.terminal-equity-plot'),{...base,grid:{left:8,right:8,top:14,bottom:24},xAxis:{...xAxis,boundaryGap:false,data:account.map(p=>workbenchTimeLabel(p.at,account.at(-1)?.at)),axisLabel:{...xAxis.axisLabel,interval:Math.max(1,Math.floor(account.length/3))}},yAxis:{...yAxis,show:false,min:v=>v.min-Math.max(1,(v.max-v.min)*.3),max:v=>v.max+Math.max(1,(v.max-v.min)*.3)},series:[...(optical&&dark?[{id:'account-glow',type:'line',data:account.map(p=>p.value),smooth:.3,symbol:'none',silent:true,lineStyle:{width:6,color:p.accent,opacity:dark?.17:.08,shadowBlur:18,shadowColor:p.accent},tooltip:{show:false}}]:[]),{id:'account',name:L('账面资产','Book value'),type:'line',data:account.map(p=>p.value),smooth:.3,symbol:account.length<2?'circle':'none',symbolSize:7,lineStyle:{width:optical?1.3:2.2,color:optical&&dark?'#dbf8ff':p.accent,shadowColor:api.color.modifyAlpha(p.accent,.55),shadowBlur:10},itemStyle:{color:p.accent},areaStyle:{color:gradient(p.context,optical?.1:.22)}}]});
  put(q('.terminal-account-stats'),`<span>${L('成交委托','Orders with fills')}<b>${(trade.orders||[]).filter(o=>o.filled>0).length}</b></span><span>${L('手续费','Fees')}<b>${fmt(trade.totalFees||0,4)}</b></span><span>${L('待确认','Pending')}<b>${trade.pending?1:0}</b></span>`);
  put(q('.terminal-evidence-chart h3'),L('研究进展','Research progress'));put(q('.terminal-evidence-revision'),task.symbol);
  const columns=history.timeline.slice(-24),feedback=evidenceMotion.read(task.symbol,columns,active),heat=columns.flatMap((point,x)=>point.values.map((status,y)=>[x,y,statuses.indexOf(status)]));
  q('.terminal-evidence-plot').setAttribute('aria-label',L('各项资料的处理进展。右侧显示当前状态，点按色块查看该次记录；不适用的项目显示灰色轨道。','Research history with current states on the right. Select a cell for its record. Inapplicable sources use a grey track.'));
  const evidenceLeft=mobile?66:80,lastColumn=columns.length-1;
  function tile(params,chart){
   const xIndex=chart.value(0),row=chart.value(1),state=chart.value(2),point=chart.coord([xIndex,row]),size=chart.size([1,1]),w=Math.max(2,size[0]-2),h=state===6?2:Math.min(17,size[1]-12),x=point[0]-w/2,y=point[1]-h/2;
   const color=state===4?p.down:state===5?p.gold:state===0||state===6?p.muted:p.spectrum[row],latest=xIndex===lastColumn;
   if(optical){
    const level=state===0||state===6?.12:state===2?.4:state===3?.65:.9;
    return {type:'group',children:[{type:'rect',shape:{x,y:point[1]-12,width:w,height:24},style:{fill:'rgba(0,0,0,.001)'}},{type:'line',shape:{x1:x,y1:point[1],x2:x+w,y2:point[1]},style:{stroke:color,lineWidth:state===6?1:3,opacity:level,shadowBlur:dark&&state!==6?9:0,shadowColor:api.color.modifyAlpha(color,.65)},emphasis:{style:{lineWidth:6,opacity:1}},transition:['shape','style']},...(state===0||state===6?[]:[{type:'line',silent:true,shape:{x1:x+1,y1:point[1],x2:x+w-1,y2:point[1]},style:{stroke:dark?'#f1f8ff':color,lineWidth:.7,opacity:latest?.9:.35}},{type:'circle',silent:true,shape:{cx:point[0],cy:point[1],r:latest?2.5:0},style:{fill:dark?'#fff':color,shadowBlur:9,shadowColor:color}}])]};
   }
   const alpha=state===0||state===6?.18:state===2?.26:state===3?.5:.34;
   return {type:'group',children:[{type:'rect',shape:{x,y,width:w,height:h,r:2},style:{fill:api.color.modifyAlpha(color,alpha),stroke:'transparent',lineWidth:0},emphasis:{style:{fill:api.color.modifyAlpha(color,.8),stroke:color,lineWidth:.5}},transition:['shape','style']},...(state===0||state===6?[]:[{type:'line',silent:true,shape:{x1:x+1,y1:y+1,x2:x+w-1,y2:y+1},style:{stroke:color,lineWidth:latest?2:1.3,opacity:state===2?.45:.9,shadowBlur:dark?6:2,shadowColor:api.color.modifyAlpha(color,.7)}}])]};
  }
  plot(q('.terminal-evidence-plot'),{...base,animationDurationUpdate:200,tooltip:{...base.tooltip,trigger:'item',formatter:params=>{
   const [column,row,state]=params.value,point=columns[column],e=task.evidence.find(e=>e.key===dimensions[row][0]);
   return `${L(...dimensions[row][1])} · ${statusLabel(statuses[state])}\n${workbenchTimeLabel(point.at,columns.at(-1).at)}${state===6?'\n'+L('此资产不使用该类数据','This source does not apply to this asset'):point.version===task.version&&e?.text?'\n'+t(e.text):''}`;
  }},grid:{left:evidenceLeft,right:88,top:8,bottom:25},xAxis:{...xAxis,data:Array.from({length:Math.max(12,columns.length)},(_,i)=>columns[i]?workbenchTimeLabel(columns[i].at,columns.at(-1).at):''),axisLabel:{...xAxis.axisLabel,interval:Math.max(3,Math.floor(columns.length/(mobile?2:3)))}},yAxis:{type:'category',data:dimensions.map(d=>L(...d[1])),inverse:true,axisLine:{show:false},axisTick:{show:false},axisLabel:{show:false},splitArea:{show:false}},series:[{id:'evidence',type:'custom',renderItem:tile,clip:true,encode:{x:0,y:1},data:heat.map(value=>({id:`${columns[value[0]].version}:${columns[value[0]].at}:${value[1]}`,value})),markLine:{data:[]}}]},reset);
  put(q('.terminal-evidence-current'),dimensions.map(([key],row)=>{
   const status=columns.at(-1)?.values[row]||workbenchEvidenceStatus(task,key),color=status==='conflict'?p.down:status==='missing'?p.gold:['na','pending','context','collected'].includes(status)?p.muted:p.spectrum[row];
   return `<span data-current-state="${status}" style="--state-color:${color}">${status==='retain'?'✓ ':status==='conflict'?'! ':''}${statusLabel(status)}</span>`;
  }).join(''));
  for(const [row,[key,name]]of dimensions.entries()){
   const source=q(`[data-source-glyph="${key}"]`),status=columns.at(-1)?.values[row]||workbenchEvidenceStatus(task,key);source.dataset.state=status;source.dataset.working=String(active&&(status==='collected'||status==='pending'&&task.phase==='collect'));source.style.setProperty('--evidence-color',status==='na'?p.muted:p.spectrum[row]);put(source.querySelector('span'),L(...name));
   if(feedback.rows.includes(row))signalIcon(source.querySelector('svg'),'review');
  }
  positionCursor();
  if(feedback.sample||feedback.rows.length)signalIcon(q('[data-chart-glyph="evidence"]'),'review');
  const priceKey=task.symbol+':'+price;
  if(quoteRevision&&quoteRevision!==priceKey&&active){signalIcon(q('.terminal-chart-title .brand-mark'));signalIcon(q('[data-chart-glyph="distribution"]'));}
  quoteRevision=priceKey;
  if(equityValue!==null&&equityValue!==equity)signalIcon(q('[data-chart-glyph="equity"]'),'review');equityValue=equity;
  q('.terminal-evidence-legend').hidden=true;
  if(!liveMarket){
   put(q('.terminal-distribution-chart h3'),yieldAsset?L('收益率分布','Yield distribution'):L('价格分布','Price distribution'));
   put(q('.terminal-distribution-readout'),`<span>${L('样本均值','Sample mean')}<b>${quoteValue(sample.mean)}${yieldAsset?'%':''}</b></span><span>${L('波动幅度','Price spread')}<b>${fmt(yieldAsset?sample.deviation*100:sample.deviation)}${yieldAsset?' bp':''}</b></span><span>${L('当前价格','Current price')}<b>${quoteValue(price)}${yieldAsset?'%':''}</b></span>`);
  }
  q('.terminal-distribution-plot').setAttribute('aria-label',liveMarket?L('实际日线收盘价的分布；无数据时保持空白','Observed daily-close distribution; empty when unavailable'):L('当前窗口80根合成K线收盘价的分布，不是未来价格预测','Distribution of 80 synthetic closes in this window; not a price forecast'));
  plot(q('.terminal-distribution-plot'),{...base,tooltip:{...base.tooltip,trigger:'item',formatter:item=>`${L('收盘价区间中心','Price bin center')} ${sample.distribution[item.dataIndex]?quoteValue(sample.distribution[item.dataIndex].price):'—'}${yieldAsset?'%':''}\n${L('出现','Observed')} ${item.value} / ${liveMarket?sample.closes.length:bars.length} ${L('次','times')}`},grid:{left:8,right:14,top:12,bottom:30},xAxis:{...xAxis,data:sample.distribution.map(bin=>quoteValue(bin.price)+(yieldAsset?'%':'')),axisLabel:{...xAxis.axisLabel,interval:mobile?7:5}},yAxis:{...yAxis,show:false,min:0},series:[{id:'distribution',name:L('出现次数','Observations'),type:'bar',data:sample.distribution.map((bin,i)=>{
   const color=p.spectrum[(optical?[0,1,4,2,3,5]:[3,0,1,4,5,2])[Math.min(5,Math.floor(i/20*6))]];
   return {value:bin.count,itemStyle:{color:optical?gradient(color,dark?.64:.52):color,borderWidth:0,borderColor:'transparent',shadowBlur:optical?0:dark?7:2,shadowColor:api.color.modifyAlpha(color,dark?.5:.18)}};
  }),barWidth:optical?'58%':'65%',itemStyle:{borderRadius:optical?0:[2,2,0,0],borderWidth:0},emphasis:{itemStyle:{borderWidth:0,shadowBlur:dark?12:4}}},...(optical?[{id:'distribution-core',type:'pictorialBar',silent:true,symbol:'rect',symbolPosition:'end',symbolSize:['58%',1.5],z:3,data:sample.distribution.map((bin,i)=>{const color=p.spectrum[[0,1,4,2,3,5][Math.min(5,Math.floor(i/20*6))]];return {value:bin.count,itemStyle:{color:dark?'#eafaff':color,opacity:bin.count?1:0,shadowBlur:dark?9:3,shadowColor:color}};}),tooltip:{show:false}}]:[])]},reset);
  const info={account:L('仅记录页面打开后的模拟账面资产。没有历史记录时不补造收益曲线。','Records simulated equity observed since this page opened. Earlier returns are not invented.'),evidence:L('左侧为资料类型，中间按时间记录处理变化，右侧为当前状态。已核对表示资料通过本轮检查，不代表建议买入；背景参考不单独触发交易。不适用的项目不会计入缺失。','Sources on the left, observed history in the middle, current state on the right. Reviewed is not a buy recommendation; context alone cannot trigger a trade. Inapplicable sources do not count as missing.'),distribution:L('颜色按价格从低到高排列，柱高为出现次数。波动幅度是这些收盘价的标准差，不是未来价格或盈利概率。','Colors follow ascending price; height counts observations. Price spread is the standard deviation of closes, not a forecast or profit probability.')};
  for(const button of host.querySelectorAll('[data-chart-info]')){const text=info[button.dataset.chartInfo];button.setAttribute('aria-label',L(...chartInfoLabels[button.dataset.chartInfo]));put(button.closest('article').querySelector('.terminal-chart-note'),text);}
  put(q('.terminal-chart-data>summary'),L('资料与价格明细','Research & price details'));
  if(q('.terminal-chart-data').open||!q('.terminal-chart-data>div').innerHTML)renderTable(sample,task);
 }
 function renderTable(sample,task){
  if(sample.mode==='live_readonly'){
   const time=value=>new Date(value*1000).toISOString().replace('T',' ').replace('.000Z',' UTC');
   put(q('.terminal-chart-data>summary'),L('已观测日线记录','Observed daily record'));
   put(q('.terminal-chart-data>div'),`<section class="chart-data-section"><header><h4>${esc(task.symbol)} · ${L('实际日线收盘','Observed daily close')}</h4><span>${esc(sample.source)} · ${esc(sample.unit)}</span></header>${sample.state==='ready'?`<table><thead><tr>${[L('起始时间','Period start'),L('收盘确认时间','Closed at'),L('收盘价','Close')].map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody><tr><td>${time(sample.sampleAt)}</td><td>${time(sample.closedAt)}</td><td>${fmt(sample.price,sample.unit==='%'?4:2)}</td></tr></tbody></table>`:`<p role="status">${L('当前没有可用的已收盘记录','No current closed-bar observation')}</p>`}</section>`);
   return;
  }
  const scroller=q('.chart-record-scroll'),position=scroller&&{left:scroller.scrollLeft,top:scroller.scrollTop,focused:scroller===document.activeElement};
  const quote=n=>fmt(n,sample.unit==='%'?4:2),unit=sample.unit==='USD/盎司'?'USD/oz':sample.unit==='点'?L('点','pts'):sample.unit;
  put(q('.terminal-chart-data>div'),`<section class="chart-data-section"><header><h4>${L('研究资料','Research inputs')}</h4><span>${task.symbol}</span></header><div class="chart-evidence-records">${dimensions.map(([key,name])=>{
   const item=task.evidence.find(e=>e.key===key),status=workbenchEvidenceStatus(task,key),detail=status==='na'?L('此资产不使用链上资料','On-chain data does not apply to this asset'):status==='pending'?L('等待资料更新','Waiting for an update'):item?.text?t(item.text):L('等待核对','Awaiting review');
   return `<div><span>${L(...name)}</span><b data-state="${status}">${statusLabel(status)}</b><p>${esc(detail)}</p></div>`;
  }).join('')}</div></section><section class="chart-data-section"><header><h4>${L('最近12条价格记录','Last 12 price records')}</h4><span>${unit}</span></header><div class="chart-record-scroll" tabindex="0" role="region" aria-label="${L('价格明细，可横向滚动','Price records, scroll horizontally')}"><table><thead><tr>${[L('时间','Time'),L('开盘','Open'),L('最高','High'),L('最低','Low'),L('收盘','Close')].map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${sample.bars.slice(-12).reverse().map(bar=>`<tr><th scope="row">${workbenchTimeLabel(bar.at,sample.bars.at(-1).at)}</th><td>${quote(bar.open)}</td><td>${quote(bar.high)}</td><td>${quote(bar.low)}</td><td class="${bar.close>=bar.open?'chart-positive':'chart-negative'}">${quote(bar.close)}</td></tr>`).join('')}</tbody></table></div></section>`);
  if(position){const next=q('.chart-record-scroll');next.scrollLeft=position.left;next.scrollTop=position.top;if(position.focused)next.focus({preventScroll:true});}
 }
 // Refreshed cells under a stationary pointer must not override keyboard inspection.
 host.addEventListener('pointerover',event=>{const point=scanPointFromEvent(event);if(point&&point.dataset.scanSymbol!==scanDismissed)renderScanDetail(point.dataset.scanSymbol);});
 host.addEventListener('focusin',event=>{const cell=event.target.closest('[data-pnl-key]');if(cell){focusPnlCell(cell);return;}const point=event.target.closest('[data-scan-symbol]');if(point&&!scanRestoringFocus&&point.dataset.scanSymbol!==scanDismissed)renderScanDetail(point.dataset.scanSymbol);});
 host.addEventListener('pointerout',event=>{if(event.target.closest('[data-pnl-key],.pnl-tooltip')){if(event.target.isConnected&&!event.relatedTarget?.closest?.('[data-pnl-key],.pnl-tooltip')&&!document.activeElement?.closest?.('[data-pnl-key],.pnl-tooltip'))renderPnlDetail();return;}if(event.target.isConnected&&event.relatedTarget&&!event.relatedTarget.closest?.('[data-scan-symbol],.scan-detail'))scanDismissed='';if(event.target.closest('[data-scan-symbol],.scan-detail')&&!event.relatedTarget?.closest?.('[data-scan-symbol],.scan-detail')&&!document.activeElement?.closest?.('[data-scan-symbol]'))renderScanDetail();});
 host.addEventListener('focusout',event=>{if(event.target.closest('[data-pnl-key],.pnl-tooltip')&&!event.relatedTarget?.closest?.('[data-pnl-key],.pnl-tooltip')){pnlFocused='';renderPnlDetail();return;}if(event.target.closest('[data-scan-symbol]')&&!event.relatedTarget?.closest?.('[data-scan-symbol]'))renderScanDetail();});
 host.addEventListener('keydown',event=>{
  const range=event.target.closest('[data-pnl-period]');
  if(range&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){const i=pnlPeriods.indexOf(range.dataset.pnlPeriod),next=event.key==='Home'?0:event.key==='End'?3:(i+(event.key==='ArrowLeft'?-1:1)+4)%4,button=q('[data-pnl-period="'+pnlPeriods[next]+'"]');button.click();q('[data-pnl-period="'+pnlPeriods[next]+'"]')?.focus({preventScroll:true});event.preventDefault();return;}
  if(event.key==='Tab'&&event.shiftKey&&event.target.closest('.lms-day-records')){q('[data-pnl-key="'+pnlFocused+'"]')?.focus({preventScroll:true});event.preventDefault();return;}
  const cell=event.target.closest('[data-pnl-key]');
  if(cell){
   if(event.key==='Tab'&&!event.shiftKey&&q('.lms-day-records')){q('.lms-day-records').focus({preventScroll:true});event.preventDefault();return;}
   if(event.key==='Escape'){pnlDismissed=cell.dataset.pnlKey;renderPnlDetail();event.preventDefault();return;}
   if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)){
    const cells=[...host.querySelectorAll('[data-pnl-key]')],next=pnlMatrixTarget(cells.map(cell=>({column:Number(cell.dataset.pnlColumn),row:Number(cell.dataset.pnlRow)})),cells.indexOf(cell),event.key);
    pnlDismissed='';cells[next].focus({preventScroll:true});event.preventDefault();return;
   }
   if(['Enter',' '].includes(event.key)){pnlDismissed='';cell.dispatchEvent(new MouseEvent('click',{bubbles:true}));event.preventDefault();return;}
  }
  if(event.key==='Escape'&&pnlInspected){const key=pnlInspected;pnlDismissed=key;renderPnlDetail();q('[data-pnl-key="'+key+'"]')?.focus({preventScroll:true});event.preventDefault();return;}
  if(event.key==='Escape'&&scanInspected){scanDismissed=scanInspected;renderScanDetail();event.preventDefault();}});
 host.addEventListener('keydown',event=>{const point=event.target.closest('g[data-scan-symbol]');if(point&&['Enter',' '].includes(event.key)){event.preventDefault();onSelectSymbol(point.dataset.scanSymbol);}});
 host.addEventListener('click',event=>{
  const cell=event.target.closest('[data-pnl-key]');if(cell){pnlDismissed='';focusPnlCell(cell);cell.focus({preventScroll:true});return;}
  const point=scanPointFromEvent(event);if(point){scanDismissed='';point.focus({preventScroll:true});renderScanDetail(point.dataset.scanSymbol);onSelectSymbol(point.dataset.scanSymbol);return;}
  const button=event.target.closest('button');if(!button)return;
  if(pnlPeriods.includes(button.dataset.pnlPeriod)){pnlPeriod=button.dataset.pnlPeriod;pnlInspected=pnlFocused=pnlDismissed='';renderPnlDetail();insightStamp='';render();return;}
  if(button.hasAttribute('data-pnl-example')){
   if(!statementExampleContext(context?.trade,context?.syncStatus))return;
   const params=new URLSearchParams(location.search);pnlAccountOnly=button.dataset.pnlExample==='account';
   if(pnlAccountOnly)params.delete('st_example');else params.set('st_example',STATEMENT_EXAMPLE.id);
   window.history.replaceState(null,'','?'+params);insightStamp='';render();return;
  }
  if(button.hasAttribute('data-insight-patrol')){document.dispatchEvent(new CustomEvent('hive:photonic-patrol'));return;}
  if(button.dataset.insightKey||button.dataset.insightEvent){if(button.dataset.insightEvent){const id=button.dataset.insightEvent;selectedEvent=selectedEvent===id?'':id;selectedKey=button.closest('.insight-track').dataset.key;}else{selectedKey=selectedKey===button.dataset.insightKey?'':button.dataset.insightKey;selectedEvent='';}insightStamp='';render();return;}
  if(button.dataset.marketWindow){windowSize=Number(button.dataset.marketWindow);for(const b of host.querySelectorAll('[data-market-window]'))b.setAttribute('aria-pressed',String(Number(b.dataset.marketWindow)===windowSize));for(const chart of charts.values())chart.dispatchAction({type:'dataZoom',start:0,end:100});renderStamp='';render();}
  if(button.hasAttribute('data-chart-fit'))for(const chart of charts.values())chart.dispatchAction({type:'dataZoom',start:0,end:100});
  if(button.dataset.chartInfo){const note=button.closest('article').querySelector('.terminal-chart-note');note.hidden=!note.hidden;button.setAttribute('aria-expanded',String(!note.hidden));}
 });
 q('.terminal-chart-data').addEventListener('toggle',()=>{if(q('.terminal-chart-data').open&&context){const sample=workbenchMarketData(context,scanner.rows(),windowSize);if(sample)renderTable(sample,context.task);}});
 q('.terminal-price-plot').addEventListener('keydown',event=>{const chart=charts.get(q('.terminal-price-plot'));if(!chart)return;if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();const zoom=chart.getOption().dataZoom[0],step=event.key==='ArrowLeft'?-10:event.key==='ArrowRight'?10:0,start=event.key==='Home'?0:Math.max(0,Math.min(60,(zoom.start||0)+step));chart.dispatchAction({type:'dataZoom',start,end:event.key==='Home'?100:Math.min(100,start+40)});}});
 document.addEventListener('visibilitychange',()=>{if(disposed||suspended)return;if(document.hidden){releaseLegacyMarket();renderScanDetail();renderPnlDetail();}background.setActive(false);scanner.update(context?.scanTasks||context?.tasks||[],false);onMarketScan(scanner.rows());syncMotion();if(!document.hidden){renderStamp='';render();}});
 document.addEventListener('hive:locale',()=>{renderStamp='';render();});
 window.addEventListener('pagehide',event=>{
  if(disposed)return;
  suspended=Boolean(event.persisted);clearTimeout(renderTimer);renderTimer=0;
  background.setActive(false);scanner.update(context?.scanTasks||context?.tasks||[],false);onMarketScan(scanner.rows());stopMotion();releaseMarket();releaseLegacyMarket();
  if(suspended)return;
  disposed=true;background.dispose();scanner.dispose();stateObserver.disconnect();observers.disconnect();pnlObserver.disconnect();resize.disconnect();themes.disconnect();document.fonts.removeEventListener('loadingdone',fontsLoaded);for(const chart of charts.values())chart.dispose();charts.clear();
 });
 window.addEventListener('pageshow',event=>{if(!event.persisted||disposed||!suspended)return;suspended=false;renderStamp='';insightStamp='';scatterStamp='';render();});
 return {host,scanRows:()=>scanner.rows(),refreshShared:resource=>background.refresh(resource),update(value){if(disposed)return;const observedAt=Math.max(0,(performance.now()-openedAt)/1000);context={...value,observedAt};if(!suspended&&document.body.dataset.workbenchView!=='photonic'&&!document.hidden){put(q('.terminal-chart-title'),`${tokenIcon(value.task.symbol,{size:20})}<h3>${esc(value.task.symbol)}</h3><span>${marketMode(value)==='demo'?L('合成行情','Synthetic market'):L('公开行情','Public market')}</span>`);put(q('.terminal-equity-chart h3'),L('模拟资产','Simulated equity'));put(q('.terminal-evidence-chart h3'),L('研究进展','Research progress'));put(q('.terminal-distribution-chart h3'),value.task.symbol==='US10Y'?L('收益率分布','Yield distribution'):L('价格分布','Price distribution'));put(q('.terminal-chart-data>summary'),L('资料与价格明细','Research & price details'));}for(const task of value.tasks||[])history.record(task,value.trade,value.time,value.paused,observedAt);history.record(value.task,value.trade,value.time,value.paused,observedAt);for(const task of value.tasks||[])insightHistory.record(task,value.time,value.paused);insightHistory.record(value.task,value.time,value.paused);requestRender();}};
}
