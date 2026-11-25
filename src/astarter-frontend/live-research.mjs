import {ASSETS} from './product-data.mjs';
import {DIMENSIONS,RESEARCH_GROUPS} from './multi-research.mjs';
import {candleRequest} from './trading-chart-data.mjs';
import {validateSpotDepthSnapshot,SPOT_DEPTH_CLOCK_SKEW_MS} from './spot-depth-data.mjs';
import {pair as L,getLocale} from './locale.mjs';
import {RESEARCH_BACKGROUND_RESOURCES,validateResearchBackground} from './market-hub-data.mjs';

import {publicResearchFacts,publicResearchSummary} from './workbench-public-evidence.mjs';

const METHOD='ema20-atr14-rsi14-v1',MODE='live_readonly';
const DEPTH_SYMBOLS=new Set(['BTC','ETH','SOL']);
const signals=new Set(['breakout-up','breakout-down','overbought','oversold','balanced']);
const assets=new Map(ASSETS.map(([symbol,name,domain])=>{
 const request=candleRequest(domain==='Crypto'?{market:symbol+'/USDT',period:'1D'}:{market:symbol,period:'1D',profileId:'public-market',venueId:symbol==='XAU'?'dukascopy':'yahoo'});
 return [symbol,{symbol,name,domain,request,source:request?.source||'Binance Spot',timezone:request?.timezone||'UTC',unit:request?.unit||'USDT'}];
}));
const missingText={
 depth:['尚无已验证的盘口与流动性数据','Verified depth and liquidity data is unavailable'],
 macro:['尚无已验证的宏观事件资料','Verified macro-event evidence is unavailable'],
 social:['尚无已验证的舆情来源','Verified sentiment sources are unavailable'],
 chain:['尚无已验证的链上资金证据','Verified on-chain flow evidence is unavailable'],
 risk:['尚未完成账户、预算和执行保护核验','Account, budget and execution protection remain unchecked']
};
const stateText={loading:['等待行情数据','Waiting for market data'],paused:['行情观察已暂停','Market observation paused'],stale:['行情依据已过期','Market evidence expired'],error:['日线暂不可用','Daily candles unavailable'],invalid:['行情依据未通过校验','Market evidence failed validation'],unsupported:['当前来源不支持该资产','Unsupported market source'],warmup:['历史数据尚不足','Insufficient history'],reconnecting:['行情连接恢复中','Market feed reconnecting']};
const finite=Number.isFinite;
const copy=value=>structuredClone(value);
const format=value=>Number(value.toFixed(3)).toString();
const depthAmount=(value,complete)=>complete?format(value):value>=1e12?String(value):String(Math.floor(value*1000)/1000);
const depthText={loading:['等待现货盘口','Waiting for spot depth'],paused:['盘口观察已暂停','Spot depth paused'],stale:['盘口快照已过期','Spot depth expired'],error:['盘口来源暂不可用','Spot depth unavailable'],invalid:['盘口快照未通过校验','Spot depth failed validation'],unsupported:['尚无该资产的现货盘口来源','No spot-depth source for this asset']};
const backgroundResource={macro:'stablecoins',social:'sentiment',chain:'chains'};
const backgroundAssets={sentiment:['BTC'],chains:['ETH','SOL'],stablecoins:['BTC','ETH','SOL']};
const backgroundName={macro:['稳定币供应背景','Stablecoin supply context'],social:['BTC 情绪背景','BTC sentiment context'],chain:['公链 TVL 背景','Chain TVL context']};
function backgroundText(resource,snapshot,symbol){
 const day=snapshot.asOf===null?null:new Date(snapshot.asOf).toISOString().slice(0,10),amount=value=>value.toLocaleString('en-US',{maximumFractionDigits:0});
 if(resource==='sentiment')return L(`CoinMarketCap · BTC 日度情绪 ${snapshot.data.value}/100 · ${day} UTC；不代表全资产社交舆情。`,`CoinMarketCap · BTC daily sentiment ${snapshot.data.value}/100 · ${day} UTC; not all-asset social sentiment.`);
 if(resource==='stablecoins')return L(`DefiLlama · 全市场稳定币 USD 供应 ${amount(snapshot.data.totalUsd)} · ${day} UTC；仅背景，未核验宏观事件或资金流入。`,`DefiLlama · aggregate stablecoin USD supply ${amount(snapshot.data.totalUsd)} · ${day} UTC; context only, not verified macro events or inflows.`);
 const row=snapshot.data.find(row=>row.name===(symbol==='SOL'?'Solana':'Ethereum'));
 return row?L(`DefiLlama · ${row.name} TVL ${amount(row.tvl)} USD；获取于 ${new Date(snapshot.receivedAt).toISOString()}，无源事件时间；不是资产净流量。`,`DefiLlama · ${row.name} TVL ${amount(row.tvl)} USD; retrieved ${new Date(snapshot.receivedAt).toISOString()}, no source event time; not asset netflow.`):null;
}

// Receipt clocks describe our request observation window, not an exchange event time.
export function marketDepthObservation(row,now=Date.now()/1000){
 const asset=assets.get(row?.symbol);if(!asset)return null;
 if(!DEPTH_SYMBOLS.has(row.symbol))return {state:'unsupported'};
 const unavailable=state=>({state,source:'Binance Spot',unit:'USDT'});
 if(!finite(now)||now<0||!Number.isSafeInteger(Math.round(now*1000))||typeof row.paused!=='boolean')return unavailable('invalid');
 if(row.paused)return unavailable('paused');
 if(row.depthState!=='ready')return unavailable(['loading','error','stale','unsupported'].includes(row.depthState)?row.depthState:'invalid');
 try{return {state:'ready',...validateSpotDepthSnapshot(row.depthSnapshot,row.symbol,Math.round(now*1000))};}
 catch(error){
  if(error.message==='STALE_SPOT_DEPTH'){
   try{return {state:'stale',...validateSpotDepthSnapshot(row.depthSnapshot,row.symbol,row.depthSnapshot.receivedAt)};}catch{}
  }
  return unavailable('invalid');
 }
}

// Only the already validated scanner projection is accepted; this model grants no order authority.
export function marketResearchObservation(row,now=Date.now()/1000){
 const asset=assets.get(row?.symbol);
 if(!asset)return null;
 const unavailable=state=>({state,source:asset.source,timezone:asset.timezone,unit:asset.unit,period:'1D',methodVersion:METHOD});
 if(!finite(now)||now<0)return unavailable('invalid');
 if(row.state!=='ready')return unavailable(Object.hasOwn(stateText,row.state)?row.state:'invalid');
 if(typeof row.paused!=='boolean'||row.source!==asset.source||row.timezone!==asset.timezone||row.unit!==asset.unit||row.period!=='1D'||row.methodVersion!==METHOD||!['snapshot','live'].includes(row.feedState))return unavailable('invalid');
 if(!['price','x','y','change','sampleAt','closedAt','validUntil'].every(key=>finite(row[key]))||row.price<=0||row.y<0||row.y>100||!Number.isSafeInteger(row.bars)||row.bars<250||row.bars>500||row.sampleAt<0||row.sampleAt>=row.closedAt||row.closedAt>now||row.validUntil<=row.closedAt||!signals.has(row.signal))return unavailable('invalid');
 if(asset.domain==='Crypto'&&(row.sampleAt%86400!==0||row.closedAt!==row.sampleAt+86400||row.validUntil!==row.sampleAt+172800))return unavailable('invalid');
 if(now>row.validUntil||asset.domain==='Crypto'&&row.sampleAt!==Math.floor(now/86400)*86400-86400)return unavailable('stale');
 if(row.paused)return unavailable('paused');
 return {state:'ready',symbol:row.symbol,source:asset.source,timezone:asset.timezone,unit:asset.unit,period:'1D',methodVersion:METHOD,price:row.price,trend:row.x,rsi:row.y,change:row.change,signal:row.signal,bars:row.bars,sampleAt:row.sampleAt,closedAt:row.closedAt,validUntil:row.validUntil};
}

export class MarketResearch{
 constructor({now=()=>Date.now()/1000}={}){
  this.now=now;this.mode=MODE;this.time=0;this.sequence=0;this.events=[];this.core=null;this.scope='all';
  this.background=Object.fromEntries(RESEARCH_BACKGROUND_RESOURCES.map(resource=>[resource,{state:'missing',snapshot:null,version:1}]));this._sharedRefresh=null;
  this.publicFeeds={news:[],social:[]};this.publicExpiry=Infinity;this.publicReceived={news:0,social:0};
  this._shared=[['macro','宏观事件','Macro events'],['social','舆情来源','Sentiment sources'],['chain','链上证据','On-chain evidence']].map(([id,zh,en])=>({id,name:L(zh,en),summary:L(...missingText[id]),assets:[...assets.values()].filter(asset=>id==='macro'||asset.domain==='Crypto').map(asset=>asset.symbol),version:1,at:0,decision:'missing'}));
  this.groups=RESEARCH_GROUPS.map((group,station)=>({...copy(group),station,task:null}));
  this._tasks=[...assets.values()].map(asset=>({symbol:asset.symbol,name:asset.name,domain:asset.domain,id:'market-research-'+asset.symbol,version:1,group:RESEARCH_GROUPS.findIndex(group=>group.assets.includes(asset.symbol)),phase:'collect',started:0,completed:null,progress:0,outcome:'missing',reason:'',title:'',thesis:'',next:'',evidence:[],history:[],observation:marketResearchObservation({symbol:asset.symbol,state:'loading'},this.now()),depthObservation:marketDepthObservation({symbol:asset.symbol,depthState:'loading',paused:false},this.now()),mode:MODE}));
  for(const task of this._tasks){task.publicFacts=[];task.publicVersion=0;task.backgroundRevision=this._backgroundKey(task);}
  this.localize();this._assign();
 }
 get tasks(){this._expire();this.localize();return this._tasks;}
 get shared(){this._expire();this._describeShared();return this._shared;}
 _assign(){for(const group of this.groups)group.task=this._tasks.find(task=>task.group===group.station&&this.accepts(task)&&task.phase!=='complete')?.symbol||null;}
 _backgroundKey(task){return task.publicVersion+'|'+JSON.stringify(RESEARCH_BACKGROUND_RESOURCES.filter(resource=>backgroundAssets[resource].includes(task.symbol)).map(resource=>[resource,this.background[resource].version]));}
 _describe(task){
  const locale=getLocale();if(task._descriptionLocale===locale&&task._descriptionVersion===task.version)return;
  task._descriptionLocale=locale;task._descriptionVersion=task.version;
  const o=task.observation,d=task.depthObservation,ready=o.state==='ready',depthReady=d.state==='ready',revision=this.revision(task);
  const status=ready?'':L(...stateText[o.state]);
  task.title=ready?L('行情已核对 · 等待交叉核验','Market checked · cross-checks pending'):o.state==='error'?task.symbol+' · '+status:status;
  task.thesis=ready?`${o.source} · EMA20 ${o.trend>=0?'+':''}${format(o.trend)} ATR14 · RSI14 ${format(o.rsi)}`:o.state==='error'?o.source+' · '+status:status;
  task.reason=ready?L('已收盘日线技术观察','Closed daily-bar observation'):task.thesis;
  task.next=L('补齐独立资料与执行保护，技术观察不会自动批准交易。','Complete independent evidence and execution checks. Technical observations do not approve trading.');
  task.evidence=DIMENSIONS.map(([key,name])=>{
   const resource=backgroundResource[key],background=this.background[resource],supplement=key==='social'?publicResearchSummary(task.publicFacts):'';
   if(background&&backgroundAssets[resource].includes(task.symbol)&&background.state==='ready'){
    const snapshot=background.snapshot,text=backgroundText(resource,snapshot,task.symbol);
    if(text)return {id:`${revision}:${key}`,key,name,sourceId:`background:${resource}:${snapshot.asOf??snapshot.receivedAt}:v${background.version}`,source:snapshot.provider,text:supplement?text+' / '+supplement:text,status:'context',sharedVersion:background.version,asOf:snapshot.asOf,receivedAt:snapshot.receivedAt,validUntil:snapshot.validUntil,timeUnit:'ms',timeBasis:snapshot.asOf===null?'retrieval-time':'daily-source-time',methodVersion:'public-background-context-v1'};
   }
   if(supplement)return {id:revision+':social',key,name,sourceId:'public-context:'+task.symbol+':'+task.publicVersion,source:[...new Set(task.publicFacts.map(fact=>fact.kind==='news'?'BlockBeats':'LunarCrush'))].join(' / '),text:supplement,status:'context',sharedVersion:null,timeUnit:'ms',methodVersion:'public-asset-context-v1'};
   if(key==='depth')return {id:`${revision}:${key}`,key,name,sourceId:depthReady?`${task.symbol}:depth:${d.lastUpdateId}:${d.requestStartedAt}:${d.receivedAt}:${d.methodVersion}`:null,source:depthReady?d.source:L('尚无来源','No source'),text:depthReady?L(`中价 ±1% · 买盘 ${d.bidCoverageComplete?'':'≥'}${depthAmount(d.bidNotional,d.bidCoverageComplete)} USDT · 卖盘 ${d.askCoverageComplete?'':'≥'}${depthAmount(d.askNotional,d.askCoverageComplete)} USDT · 价差 ${format(d.spreadBps)} bps。时间为请求观察窗口，非交易所事件时间。`,`Mid ±1% · bid ${d.bidCoverageComplete?'':'≥'}${depthAmount(d.bidNotional,d.bidCoverageComplete)} USDT · ask ${d.askCoverageComplete?'':'≥'}${depthAmount(d.askNotional,d.askCoverageComplete)} USDT · spread ${format(d.spreadBps)} bps. Times are the request observation window, not exchange event timestamps.`):L(...depthText[d.state]),status:depthReady?'retain':'missing',sharedVersion:null,...(depthReady?{methodVersion:d.methodVersion,unit:d.unit,lastUpdateId:d.lastUpdateId,requestStartedAt:d.requestStartedAt,receivedAt:d.receivedAt,validUntil:d.validUntil,timeUnit:'ms',timeBasis:'request-observation-window'}:{})};
   const na=key==='chain'&&task.domain==='TradFi',observed=key==='trend'&&ready;
   const backgroundState=background&&backgroundAssets[resource].includes(task.symbol)?background.state:null;
   const unavailable=backgroundState==='stale'?L('背景资料已过期','Background data expired'):backgroundState==='paused'?L('背景观察已暂停','Background observation paused'):['error','invalid'].includes(backgroundState)?L('背景来源暂不可用','Background source unavailable'):null;
   return {id:`${revision}:${key}`,key,name,sourceId:observed?`${task.symbol}:1D:${o.sampleAt}:${o.closedAt}:${METHOD}`:null,source:observed?o.source:L('尚无来源','No source'),text:na?L('该资产不适用链上资金证据','On-chain flow evidence does not apply to this asset'):key==='trend'?task.thesis:unavailable||L(...missingText[key]),status:na?'na':observed?'retain':'missing',sharedVersion:null,...(observed?{period:o.period,closedAt:o.closedAt,validUntil:o.validUntil,methodVersion:o.methodVersion,timezone:o.timezone,unit:o.unit}:{} )};
  });
 }
 _replace(task,observation=task.observation,depthObservation=task.depthObservation){
  const technicalChanged=JSON.stringify(task.observation)!==JSON.stringify(observation),depthChanged=JSON.stringify(task.depthObservation)!==JSON.stringify(depthObservation),backgroundRevision=this._backgroundKey(task),backgroundChanged=task.backgroundRevision!==backgroundRevision;
  if(!technicalChanged&&!depthChanged&&!backgroundChanged)return false;
  task.history.unshift({version:task.version,phase:task.phase,title:task.title,at:this.time,observation:copy(task.observation),depthObservation:copy(task.depthObservation),evidence:copy(task.evidence)});task.history.length=Math.min(task.history.length,5);
  task.version++;task.observation=observation;task.depthObservation=depthObservation;task.backgroundRevision=backgroundRevision;
  if(technicalChanged){task.phase=observation.state==='ready'?'complete':'collect';task.progress=observation.state==='ready'?100:0;task.completed=observation.state==='ready'?this.time:null;task.started=this.time;}task.outcome='missing';
  this._describe(task);this.log(task,technicalChanged?task.title:backgroundChanged?L('共享背景资料已更新','Shared background updated'):L(...depthText[depthObservation.state]||['盘口快照已更新','Spot-depth snapshot updated']));return true;
 }
 _expire(){
  const now=this.now();let changed=false;
  if(Math.round(now*1000)>=this.publicExpiry)this._syncPublic(Math.round(now*1000));
  for(const background of Object.values(this.background))if(background.state==='ready')try{validateResearchBackground(background.snapshot,background.snapshot.resource,Math.round(now*1000));}catch(error){background.state=error.code==='BACKGROUND_STALE'?'stale':'invalid';background.version++;}
  for(const task of this._tasks){
   let observation=task.observation,depthObservation=task.depthObservation;
   if(observation.state==='ready'&&(!finite(now)||now<observation.closedAt||now>observation.validUntil||task.domain==='Crypto'&&now>=observation.validUntil))observation={...observation,state:finite(now)&&now>=observation.closedAt?'stale':'invalid'};
   if(depthObservation.state==='ready'&&(!finite(now)||depthObservation.receivedAt-Math.round(now*1000)>SPOT_DEPTH_CLOCK_SKEW_MS||Math.round(now*1000)>=depthObservation.validUntil))depthObservation={...depthObservation,state:finite(now)&&Math.round(now*1000)>=depthObservation.validUntil?'stale':'invalid'};
   changed=this._replace(task,observation,depthObservation)||changed;
  }
  this._assign();return changed;
 }
 _describeShared(){
  for(const source of this._shared){const resource=backgroundResource[source.id],background=this.background[resource];source.name=L(...backgroundName[source.id]);source.assets=backgroundAssets[resource].filter(symbol=>resource!=='chains'||background.state!=='ready'||background.snapshot.data.some(row=>row.name===(symbol==='SOL'?'Solana':'Ethereum')));source.version=background.version;source.decision=background.state==='ready'?'context':'missing';source.state=background.state;source.at=background.snapshot?.asOf??background.snapshot?.receivedAt??0;source.snapshot=copy(background.snapshot);source.summary=background.state==='ready'?backgroundText(resource,background.snapshot,source.assets[0])||L(...missingText[source.id]):L(...missingText[source.id]);}
 }
 localize(){
  this._describeShared();
  for(const task of this._tasks)this._describe(task);
 }
 ingestPublic(resource,snapshot){
  if(!Object.hasOwn(this.publicFeeds,resource))return false;
  const now=Math.round(this.now()*1000);
  if(snapshot&&Number.isSafeInteger(snapshot.requested_at_ms)&&snapshot.requested_at_ms<this.publicReceived[resource])return false;
  const facts=publicResearchFacts(resource,snapshot,now);
  if(snapshot?.mode==='live_readonly'&&Number.isSafeInteger(snapshot.requested_at_ms)&&snapshot.requested_at_ms<=now+1000)this.publicReceived[resource]=snapshot.requested_at_ms;
  this.publicFeeds[resource]=facts;
  this._syncPublic(now);return this._expire();
 }
 _syncPublic(now){
  const current=Object.values(this.publicFeeds).flat().filter(fact=>fact.expires>now);
  this.publicExpiry=Math.min(Infinity,...current.map(fact=>fact.expires));
  for(const task of this._tasks){
   const facts=current.filter(fact=>fact.symbol===task.symbol);
   if(JSON.stringify(facts)!==JSON.stringify(task.publicFacts)){task.publicFacts=facts;task.publicVersion++;}
  }
 }
 ingestMarket(rows){
  if(!Array.isArray(rows))return false;
  let changed=false;const counts=new Map();
  for(const row of rows)if(assets.has(row?.symbol))counts.set(row.symbol,(counts.get(row.symbol)||0)+1);
  for(const [symbol,count]of counts){
   const task=this._tasks.find(task=>task.symbol===symbol),row=rows.find(row=>row?.symbol===symbol);
   // Each source has its own watermark; a late daily bar cannot hide a fresh book.
   const oldTechnical=finite(row.sampleAt)&&finite(task.lastSampleAt)&&(row.sampleAt<task.lastSampleAt||row.sampleAt===task.lastSampleAt&&finite(row.closedAt)&&row.closedAt<task.lastClosedAt);
   let observation=task.observation,depthObservation=task.depthObservation;
   if(count!==1)observation=marketResearchObservation({symbol,state:'invalid'},this.now());
   else if(Object.hasOwn(row,'state')&&(!oldTechnical||row.paused===true))observation=marketResearchObservation(row,this.now());
   if(count!==1)depthObservation=marketDepthObservation({symbol,depthState:'invalid',paused:false},this.now());
   else if(Object.hasOwn(row,'depthState')||row.paused===true){
    const candidate=marketDepthObservation(row,this.now()),d=['ready','stale'].includes(candidate.state)?candidate:null,oldDepth=d&&finite(task.lastDepthStartedAt)&&(d.requestStartedAt<task.lastDepthStartedAt||d.receivedAt<task.lastDepthReceivedAt||d.lastUpdateId<task.lastDepthUpdateId);
    if(!oldDepth||row.paused===true)depthObservation=candidate;
   }
   if(observation.state==='ready'){task.lastSampleAt=observation.sampleAt;task.lastClosedAt=observation.closedAt;}
   if(depthObservation.state==='ready'){task.lastDepthStartedAt=depthObservation.requestStartedAt;task.lastDepthReceivedAt=depthObservation.receivedAt;task.lastDepthUpdateId=depthObservation.lastUpdateId;}
   changed=this._replace(task,observation,depthObservation)||changed;
  }
  return this._expire()||changed;
 }
 log(task,text){this.events.unshift({id:++this.sequence,at:this.time,symbol:task?.symbol||'共享',text,mode:MODE});this.events.length=Math.min(this.events.length,32);}
 task(symbol){this._expire();const task=this._tasks.find(task=>task.symbol===symbol?.split('/')[0]);if(task)this._describe(task);return task;}
 revision(task){return `${task.id}:v${task.version}`;}
 accepts(task){return Boolean(task&&(!this.scope||this.scope==='all'||task.domain.toLowerCase()===this.scope));}
 setScope(scope){this.scope=['all','crypto','tradfi'].includes(scope)?scope:'all';this._expire();}
 advance(dt,{busyRoles=[]}={}){if(!finite(dt)||dt<=0)return;this.time+=dt;this._expire();for(const task of this._tasks)task.executionWaiting=RESEARCH_GROUPS[task.group].roles.some(id=>busyRoles.includes(id));}
 ingest(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>3||new Set(rows.map(row=>row?.resource)).size!==rows.length||rows.some(row=>!RESEARCH_BACKGROUND_RESOURCES.includes(row?.resource)||!['ready','loading','paused','error','stale'].includes(row.state)))return false;
  let changed=false;
  for(const row of rows){
   const old=this.background[row.resource];let state=row.state,snapshot=old.snapshot;
   if(state==='ready')try{snapshot=validateResearchBackground(row.snapshot,row.resource,Math.round(this.now()*1000));}catch(error){state=error.code==='BACKGROUND_STALE'?'stale':'invalid';snapshot=old.snapshot;}
   if(state==='ready'&&old.snapshot){
    if(snapshot.receivedAt<old.snapshot.receivedAt||snapshot.asOf!==null&&snapshot.asOf<old.snapshot.asOf)continue;
    if(old.state==='ready'&&snapshot.asOf!==null&&snapshot.asOf===old.snapshot.asOf&&JSON.stringify(snapshot.data)===JSON.stringify(old.snapshot.data))continue;
   }
   if(old.state===state&&JSON.stringify(old.snapshot)===JSON.stringify(snapshot))continue;
   this.background[row.resource]={state,snapshot,version:old.version+1};changed=true;
  }
  for(const task of this._tasks)changed=this._replace(task)||changed;
  this.localize();return this._expire()||changed;
 }
 recheck(symbol){const task=this.task(symbol);if(!task)return false;return this._replace(task,marketResearchObservation({symbol:task.symbol,state:'loading'},this.now()));}
 setSharedRefresh(callback){this._sharedRefresh=typeof callback==='function'?callback:null;}
 refreshShared(id){this._expire();this._sharedRefresh?.(backgroundResource[id]||id);return [];}
 context(symbol){const task=this.task(symbol),ready=task?.observation.state==='ready';return {market:task?.domain==='Crypto'?task.symbol+'/USDT':task?.symbol||'',price:ready?task.observation.price:0,revision:task?this.revision(task):'',ready:false,conflict:0,missing:task?.evidence.filter(item=>item.status==='missing').length||0,mode:MODE};}
 handoff(){this._expire();return null;}
 jobs(){this._expire();return this.groups.map(group=>{const task=this.task(group.task),subject=task?.symbol||group.assets.join(' / ');return {id:task?this.revision(task):`market-monitor-${group.station}`,taskId:task?.id||null,symbol:subject,revision:task?this.revision(task):null,roles:group.roles,station:group.station,groupLabel:group.label,groupColor:group.color,researchPhase:task?.phase||'monitor',discovered:false,title:task?.title||L('持续观察已接入行情','Watching connected markets'),source:group.source,sourceAnchor:group.source==='trend'?'market':null,mode:'field',progress:0,trigger:task?.reason||L('等待新证据','Waiting for new evidence'),taskType:'monitor'};});}
 findings(){return this.tasks.filter(task=>this.accepts(task)&&task.phase==='complete');}
 summary(){const tasks=this.tasks.filter(task=>this.accepts(task)),complete=tasks.filter(task=>task.phase==='complete');return {total:tasks.length,working:tasks.filter(task=>task.phase==='collect').length,waiting:0,complete:complete.length,candidates:0,blocked:complete.length};}
 process(){const summary=this.summary();return {history:[],items:[],counts:{retain:summary.complete,context:0,conflict:0,missing:summary.total},expected:summary.total,arrived:summary.complete,resolved:0,ready:false,phase:summary.complete?2:0,title:L('真实行情观察','Live market observation'),detail:L(`${summary.complete} 项行情已核对，独立证据待补`,`${summary.complete} market observations checked; independent evidence pending`),revision:this._tasks.filter(task=>this.accepts(task)).map(task=>this.revision(task)).join('|'),resultProgress:summary.complete?1/6:0};}
 snapshot(){this._expire();this.localize();return copy({mode:MODE,time:this.time,scope:this.scope,sequence:this.sequence,core:this.core,shared:this.shared,background:this.background,tasks:this._tasks,groups:this.groups,events:this.events});}
}
