import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketResearch,marketResearchObservation,marketDepthObservation} from './live-research.mjs';
import {marketScatterSample} from './workbench-market-analysis.mjs';
import {normalizeSpotDepth} from './spot-depth-data.mjs';

const day=86400,closedAt=300*day,NOW=closedAt+100;
const identity={source:'Binance Spot',timezone:'UTC',unit:'USDT'};
const sourceRow=(patch={})=>({symbol:'BTC',...identity,state:'ready',feedState:'snapshot',paused:false,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',price:100,x:0,y:50,change:0,bars:300,sampleAt:closedAt-day,closedAt,validUntil:closedAt+day,signal:'balanced',...patch});
const trend=task=>task.evidence.find(e=>e.key==='trend');
const depth=task=>task.evidence.find(e=>e.key==='depth');
const book=(symbol='BTC',options={})=>normalizeSpotDepth({lastUpdateId:options.lastUpdateId??10,bids:Array.from({length:options.levels??100},(_,i)=>[(99.9-i*.1).toFixed(1),'2']),asks:Array.from({length:options.levels??100},(_,i)=>[(100.1+i*.1).toFixed(1),'3'])},symbol,{requestStartedAt:options.requestStartedAt??NOW*1000-500,receivedAt:options.receivedAt??NOW*1000-100});
const depthRow=(symbol='BTC',snapshot=book(symbol),patch={})=>({symbol,paused:false,depthState:'ready',depthSnapshot:snapshot,...patch});

test('starts with eight assets and six independent teams, with no fixture conclusions or evidence',()=>{
 const r=new MarketResearch({now:()=>NOW});
 assert.equal(r.tasks.length,8);assert.equal(r.groups.length,6);assert.equal(new Set(r.jobs().flatMap(j=>j.roles)).size,18);
 assert.deepEqual(r.summary(),{total:8,working:8,waiting:0,complete:0,candidates:0,blocked:0});
 for(const task of r.tasks){assert.equal(task.mode,'live_readonly');assert.equal(task.outcome,'missing');assert.equal(task.evidence.length,6);assert.ok(task.evidence.every(item=>['missing','na'].includes(item.status)));assert.ok(task.evidence.every(item=>item.sourceId===null));assert.equal(r.handoff(task.symbol),null);}
 assert.equal(r.snapshot().mode,'live_readonly');assert.equal(r.shared.every(item=>item.decision==='missing'),true);
});

test('actual scanner calculation from a known flat closed market becomes only technical evidence',()=>{
 const bars=Array.from({length:300},(_,i)=>({time:i*day,open:100,high:101,low:99,close:100,volume:100}));
 const sample=marketScatterSample(bars,NOW);
 assert.equal(sample.state,'ready');assert.equal(sample.price,100);assert.equal(sample.x,0);assert.equal(sample.y,50);assert.equal(sample.change,0);assert.equal(sample.closedAt,closedAt);
 const row={symbol:'BTC',...identity,feedState:'snapshot',paused:false,...sample},before=structuredClone(row),r=new MarketResearch({now:()=>NOW});
 assert.equal(r.ingestMarket([row]),true);const task=r.task('BTC');
 assert.equal(trend(task).status,'retain');assert.equal(trend(task).source,'Binance Spot');assert.equal(trend(task).period,'1D');assert.equal(trend(task).closedAt,closedAt);assert.equal(trend(task).validUntil,closedAt+day);
 assert.equal(task.thesis.includes('EMA20 +0 ATR14 · RSI14 50'),true);assert.equal(task.evidence.filter(e=>e.status==='retain').length,1);assert.equal(task.evidence.filter(e=>e.status==='missing').length,5);
 assert.equal(r.context('BTC/USDT').price,100);assert.equal(r.context('BTC/USDT').ready,false);assert.equal(r.handoff('BTC'),null);assert.equal(r.process().ready,false);assert.equal(r.process().resolved,0);
 assert.deepEqual(row,before);assert.equal(r.summary().candidates,0);
});

test('valid technical movement is observed without manufacturing a buy recommendation',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow({x:2.15,y:68,price:123,signal:'breakout-up'})]);
 assert.equal(trend(r.task('BTC')).status,'retain');assert.equal(r.task('BTC').outcome,'missing');assert.equal(r.findings().length,1);assert.equal(r.context('BTC').ready,false);assert.equal(r.handoff('BTC'),null);
 assert.equal(r.task('ETH').phase,'collect');assert.equal(r.task('ETH').evidence.some(e=>e.status==='retain'),false);
});

test('wrong source, timezone, unit, period, method, feed identity and malformed observations fail closed',()=>{
 const invalid=[{source:'fixture'},{source:'Yahoo Finance · S&P 500'},{timezone:'America/New_York'},{unit:'USD'},{period:'1H'},{methodVersion:'unknown'},{feedState:'loading'},{paused:'false'},{price:0},{price:-1},{price:'100'},{price:Infinity},{x:NaN},{x:'1'},{y:-1},{y:101},{y:Infinity},{change:NaN},{bars:249},{bars:501},{bars:250.5},{sampleAt:closedAt},{closedAt:NOW+1},{validUntil:closedAt},{signal:'buy'},{sampleAt:closedAt-day+1},{closedAt:closedAt-1},{validUntil:closedAt+day+1}];
 for(const patch of invalid){const row=sourceRow(patch),r=new MarketResearch({now:()=>NOW});assert.equal(marketResearchObservation(row,NOW).state,'invalid',JSON.stringify(patch));r.ingestMarket([row]);assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(r.context('BTC').price,0);assert.equal(r.handoff('BTC'),null);}
 for(const now of [NaN,Infinity,-1])assert.equal(marketResearchObservation(sourceRow(),now).state,'invalid');
 assert.equal(marketResearchObservation(sourceRow({symbol:'UNKNOWN'}),NOW),null);
});

test('daily evidence expires at the next daily boundary without advancing the visual clock',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now});r.ingestMarket([sourceRow()]);const before=r.snapshot(),version=r.task('BTC').version;
 now=closedAt+day;assert.equal(r.task('BTC').observation.state,'stale');assert.equal(r.time,before.time);assert.equal(r.task('BTC').version,version+1);assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(r.context('BTC').price,0);
 const after=r.snapshot();assert.equal(after.tasks.find(t=>t.symbol==='BTC').observation.state,'stale');r.snapshot();r.handoff('BTC');assert.equal(r.task('BTC').version,version+1);
 assert.equal(marketResearchObservation(sourceRow(),now).state,'stale');
});

test('clock reversal cannot leave a now-future close marked reviewed',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now});r.ingestMarket([sourceRow()]);now=closedAt-1;
 assert.equal(r.task('BTC').observation.state,'invalid');assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(r.context('BTC').price,0);
});

test('empty scanner refresh reports expiry and keeps last source clocks in audit history',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now});r.ingestMarket([sourceRow()]);now=closedAt+day;
 assert.equal(r.ingestMarket([]),true);const task=r.task('BTC');assert.equal(task.observation.state,'stale');assert.equal(task.observation.closedAt,closedAt);assert.equal(task.observation.price,100);
 assert.equal(task.history[0].observation.state,'ready');assert.equal(task.history[0].observation.sampleAt,closedAt-day);assert.equal(task.history[0].evidence.find(e=>e.key==='trend').closedAt,closedAt);assert.equal(r.context('BTC').price,0);
 assert.equal(r.ingestMarket([]),false);
});

test('source errors, reconnecting, paused, warming and stale never reuse reviewed status',()=>{
 for(const state of ['loading','error','reconnecting','warmup','stale','unsupported']){
  const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow()]);const version=r.task('BTC').version;r.ingestMarket([sourceRow({state})]);
  assert.equal(r.task('BTC').observation.state,state);assert.equal(r.task('BTC').version,version+1);assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(r.context('BTC').price,0);
 }
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow({paused:true})]);assert.equal(r.task('BTC').observation.state,'paused');assert.equal(trend(r.task('BTC')).status,'missing');
 r.ingestMarket([sourceRow({paused:false})]);assert.equal(trend(r.task('BTC')).status,'retain');assert.equal(r.handoff('BTC'),null);
});

test('unchanged data and quote heartbeats do not invent new report versions or events',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow()]);const version=r.task('BTC').version,events=r.events.length;
 assert.equal(r.ingestMarket([sourceRow()]),false);assert.equal(r.ingestMarket([sourceRow({activityAt:NOW+1,freshAt:NOW+1,quoteAsOf:NOW+1,receivedAt:(NOW+1)*1000,feedState:'live'})]),false);
 r.advance(1);r.localize();r.snapshot();assert.equal(r.task('BTC').version,version);assert.equal(r.events.length,events);
});

test('changed same-close technical data creates a new source-bound version; stale snapshots cannot roll back newer bars',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now});r.ingestMarket([sourceRow()]);const v=r.task('BTC').version;
 r.ingestMarket([sourceRow({price:101,change:1,x:.5,y:52})]);assert.equal(r.task('BTC').version,v+1);assert.equal(r.context('BTC').price,101);
 now+=day;const newer=sourceRow({sampleAt:closedAt,closedAt:closedAt+day,validUntil:closedAt+2*day,price:102,x:1,y:55});r.ingestMarket([newer]);const next=r.task('BTC').version;
 assert.equal(r.ingestMarket([sourceRow()]),false);assert.equal(r.task('BTC').version,next);assert.equal(r.context('BTC').price,102);assert.equal(trend(r.task('BTC')).closedAt,closedAt+day);
});

test('duplicate asset rows fail closed while distinct assets keep independent versions',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow(),sourceRow({symbol:'ETH',price:200})]);const eth=r.task('ETH').version;
 r.ingestMarket([sourceRow(),sourceRow({price:999})]);assert.equal(r.task('BTC').observation.state,'invalid');assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(r.task('ETH').version,eth);assert.equal(r.context('ETH').price,200);
 assert.equal(r.ingestMarket(null),false);assert.equal(r.ingestMarket([{symbol:'UNKNOWN',state:'ready'}]),false);
});

test('TradFi observations retain exact provider units and session validity, and have no on-chain evidence',()=>{
 const sources={SPX:['Yahoo Finance · S&P 500','America/New_York','index'],NDX:['Yahoo Finance · Nasdaq 100','America/New_York','index'],XAU:['Dukascopy · XAU/USD BID','UTC','USD/oz'],DXY:['Yahoo Finance · ICE USD Index','America/New_York','index'],US10Y:['Yahoo Finance · US 10Y yield','America/Chicago','%']};
 for(const [symbol,[source,timezone,unit]]of Object.entries(sources)){
  let now=NOW;const r=new MarketResearch({now:()=>now});r.ingestMarket([sourceRow({symbol,source,timezone,unit,sampleAt:closedAt-23*3600,validUntil:closedAt+3*day,price:symbol==='US10Y'?4.2:100})]);
  const task=r.task(symbol);assert.equal(trend(task).status,'retain',symbol);assert.equal(trend(task).timezone,timezone);assert.equal(trend(task).unit,unit);assert.equal(task.evidence.find(e=>e.key==='chain').status,'na');assert.equal(r.context(symbol).market,symbol);assert.equal(r.context(symbol).ready,false);assert.equal(r.handoff(symbol),null);
  now=closedAt+3*day+1;assert.equal(trend(r.task(symbol)).status,'missing');assert.equal(r.task(symbol).observation.state,'stale');
 }
});

test('legacy intelligence injection and shared refresh cannot fabricate corroborating sources',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow()]);const before=r.snapshot();
 assert.equal(r.ingest('BTC',{source:'chain',decision:'retain',id:'fixture',title:'资金流已确认'}),false);assert.deepEqual(r.refreshShared('macro'),[]);assert.deepEqual(r.snapshot(),before);
 assert.equal(r.task('BTC').evidence.find(e=>e.key==='chain').status,'missing');assert.equal(r.context('BTC',r.revision(r.task('BTC'))).ready,false);
});

test('manual recheck invalidates visible technical status until source ingestion and keeps history bounded',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow()]);const v=r.task('BTC').version;
 assert.equal(r.recheck('BTC'),true);assert.equal(r.task('BTC').version,v+1);assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(r.task('BTC').phase,'collect');
 assert.equal(r.recheck('UNKNOWN'),false);
 for(let i=0;i<20;i++){r.ingestMarket([sourceRow({price:100+i})]);r.recheck('BTC');}
 assert.equal(r.task('BTC').history.length,5);assert.equal(r.events.length,32);assert.equal(r.handoff('BTC'),null);
});

test('scope and timing preserve 18 exclusive roles without timer-driven evidence completion',()=>{
 const r=new MarketResearch({now:()=>NOW}),before=r.snapshot();for(const dt of [0,-1,NaN,Infinity])r.advance(dt);assert.deepEqual(r.snapshot(),before);
 r.advance(100000,{busyRoles:[0]});assert.equal(r.summary().complete,0);assert.equal(r.task('BTC').executionWaiting,true);assert.equal(r.jobs().every(j=>j.progress===0),true);assert.equal(r.groups[0].task,'BTC');
 r.setScope('tradfi');assert.equal(r.summary().total,5);assert.equal(r.groups[0].task,null);assert.equal(r.accepts(r.task('BTC')),false);r.setScope('crypto');assert.equal(r.summary().total,3);assert.equal(r.groups[3].task,null);assert.equal(new Set(r.jobs().flatMap(j=>j.roles)).size,18);
 r.setScope('invalid');assert.equal(r.scope,'all');assert.equal(r.summary().total,8);
});

test('snapshots are detached, contain provenance, and never export an execution handoff',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow()]);const snapshot=r.snapshot();
 assert.equal(snapshot.mode,'live_readonly');assert.equal(snapshot.tasks[0].observation.source,'Binance Spot');assert.equal(snapshot.tasks[0].observation.closedAt,closedAt);assert.equal(snapshot.events[0].mode,'live_readonly');snapshot.tasks[0].evidence[0].status='retain';snapshot.tasks[0].observation.price=1;snapshot.groups[0].roles.push(99);
 assert.equal(r.context('BTC').price,100);assert.equal(r.jobs().flatMap(j=>j.roles).includes(99),false);assert.equal(r.handoff('BTC'),null);
});

test('verified 100-level spot depth becomes independent quote-notional evidence with request-window provenance',()=>{
 const snapshot=book(),row=depthRow('BTC',snapshot),before=structuredClone(row),r=new MarketResearch({now:()=>NOW});
 const observed=marketDepthObservation(row,NOW);assert.equal(observed.state,'ready');assert.equal(observed.bidLevels,100);assert.equal(observed.askLevels,100);assert.ok(Math.abs(observed.bidNotional-1989)<1e-8);assert.ok(Math.abs(observed.askNotional-3016.5)<1e-8);assert.ok(Math.abs(observed.spreadBps-20)<1e-8);
 assert.equal(r.ingestMarket([row]),true);const task=r.task('BTC'),e=depth(task);
 assert.equal(task.phase,'collect');assert.equal(task.progress,0);assert.equal(task.observation.state,'loading');assert.equal(trend(task).status,'missing');assert.equal(e.status,'retain');assert.equal(e.source,'Binance Spot');assert.equal(e.unit,'USDT');assert.equal(e.timeUnit,'ms');assert.equal(e.timeBasis,'request-observation-window');assert.equal(e.requestStartedAt,snapshot.requestStartedAt);assert.equal(e.receivedAt,snapshot.receivedAt);
 assert.equal(e.sourceId,`BTC:depth:10:${snapshot.requestStartedAt}:${snapshot.receivedAt}:spot-depth-100-v1`);assert.match(e.text,/±1%/);assert.match(e.text,/USDT/);assert.match(e.text,/bps/);assert.match(e.text,/请求观察窗口|request observation window/);assert.doesNotMatch(e.text,/OI|funding|持仓|费率|资金流/);
 assert.equal(r.context('BTC').ready,false);assert.equal(r.handoff('BTC'),null);assert.equal(r.summary().candidates,0);assert.deepEqual(row,before);
 snapshot.bids[0][1]='999';assert.equal(task.depthObservation.bids[0][1],'2','accepted depth is detached from the caller');
});

test('partial depth coverage is explicitly a lower bound and cannot manufacture a trading direction',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([depthRow('BTC',book('BTC',{levels:3}))]);const task=r.task('BTC'),e=depth(task);
 assert.equal(task.depthObservation.bidCoverageComplete,false);assert.equal(task.depthObservation.askCoverageComplete,false);assert.equal((e.text.match(/≥/g)||[]).length,2);assert.equal(task.outcome,'missing');assert.equal(r.handoff('BTC'),null);
});

test('depth validates source identity, every derived metric, asset and receipt clock rather than trusting DTO labels',()=>{
 const snapshot=book();
 for(const patch of [{source:'fixture'},{market:'ETH/USDT'},{symbol:'ETH'},{unit:'USD'},{methodVersion:'funding-rate'},{schema:'other'},{bidNotional:snapshot.bidNotional+1},{askNotional:snapshot.askNotional+1},{spreadBps:0},{mid:101},{bidLevels:99},{bidCoverageComplete:false},{receivedAt:NOW*1000+1001},{requestStartedAt:-1},{validUntil:snapshot.validUntil+1}]){
  const row=depthRow('BTC',{...snapshot,...patch}),r=new MarketResearch({now:()=>NOW});assert.equal(marketDepthObservation(row,NOW).state,'invalid',JSON.stringify(patch));r.ingestMarket([row]);assert.equal(depth(r.task('BTC')).status,'missing');assert.equal(r.handoff('BTC'),null);
 }
 for(const now of [NaN,Infinity,-1])assert.equal(marketDepthObservation(depthRow(),now).state,'invalid');
 for(const symbol of ['SPX','NDX','XAU','DXY','US10Y']){const o=marketDepthObservation(depthRow(symbol,snapshot),NOW);assert.deepEqual(o,{state:'unsupported'});assert.equal(Object.hasOwn(o,'source'),false);}
 assert.equal(marketDepthObservation(depthRow('UNKNOWN',snapshot),NOW),null);
 const fractional=1794830400.001;const row=depthRow('BTC',book('BTC',{requestStartedAt:1794830400000,receivedAt:1794830400001}));assert.equal(marketDepthObservation(row,fractional).state,'ready','seconds are rounded back to integer receipt milliseconds');
});

test('ingested depth survives bounded host skew and expires at its original source deadline',()=>{
 for(const skew of [1,238,1000]){
  let now=NOW;const snapshot=book('BTC',{requestStartedAt:NOW*1000,receivedAt:NOW*1000+skew}),row=depthRow('BTC',snapshot),before=structuredClone(row),r=new MarketResearch({now:()=>now});
  assert.equal(marketDepthObservation(row,now).state,'ready');r.ingestMarket([row]);
  const task=r.task('BTC'),version=task.version;assert.equal(task.depthObservation.state,'ready');assert.equal(depth(task).status,'retain');assert.equal(depth(task).receivedAt,snapshot.receivedAt);assert.equal(depth(task).validUntil,snapshot.validUntil);
  now=snapshot.receivedAt/1000;assert.equal(r.task('BTC').depthObservation.state,'ready');assert.equal(r.task('BTC').version,version);
  now=(snapshot.validUntil-1)/1000;assert.equal(depth(r.task('BTC')).status,'retain');
  now=snapshot.validUntil/1000;assert.equal(r.task('BTC').depthObservation.state,'stale');assert.equal(depth(r.task('BTC')).status,'missing');assert.equal(r.task('BTC').depthObservation.validUntil,snapshot.validUntil);assert.equal(r.handoff('BTC'),null);assert.deepEqual(row,before);
 }
 const row=depthRow('BTC',book('BTC',{requestStartedAt:NOW*1000,receivedAt:NOW*1000+1001})),r=new MarketResearch({now:()=>NOW});
 r.ingestMarket([row]);assert.equal(r.task('BTC').depthObservation.state,'invalid');assert.equal(depth(r.task('BTC')).status,'missing');assert.equal(r.handoff('BTC'),null);
});

test('spot-depth expiry and source pause remove only the corresponding evidence and do not replay events',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now}),snapshot=book();r.ingestMarket([{...sourceRow(),...depthRow('BTC',snapshot)}]);const v=r.task('BTC').version;
 now=snapshot.validUntil/1000;const expired=r.task('BTC');assert.equal(expired.depthObservation.state,'stale');assert.equal(depth(expired).status,'missing');assert.equal(trend(expired).status,'retain');assert.equal(expired.version,v+1);assert.equal(expired.history[0].depthObservation.state,'ready');
 const n=r.sequence;r.task('BTC');r.snapshot();r.ingestMarket([depthRow('BTC',snapshot)]);assert.equal(r.sequence,n);assert.equal(marketDepthObservation(depthRow('BTC',snapshot),now).state,'stale');
 now=NOW;const fresh=new MarketResearch({now:()=>now});fresh.ingestMarket([{...sourceRow(),...depthRow()}]);fresh.ingestMarket([{...sourceRow(),...depthRow('BTC',book(),{paused:true})}]);assert.equal(fresh.task('BTC').depthObservation.state,'paused');assert.equal(depth(fresh.task('BTC')).status,'missing');assert.equal(trend(fresh.task('BTC')).status,'missing');
 fresh.ingestMarket([{...sourceRow(),depthState:'loading'}]);assert.equal(depth(fresh.task('BTC')).status,'missing');assert.equal(trend(fresh.task('BTC')).status,'retain');
});

test('daily expiry, errors and manual recheck cannot erase a still-valid independent book',()=>{
 let now=closedAt+day-1;const snapshot=book('BTC',{requestStartedAt:now*1000-500,receivedAt:now*1000-100}),r=new MarketResearch({now:()=>now});r.ingestMarket([{...sourceRow(),...depthRow('BTC',snapshot)}]);
 now+=2;assert.equal(r.task('BTC').observation.state,'stale');assert.equal(trend(r.task('BTC')).status,'missing');assert.equal(depth(r.task('BTC')).status,'retain');assert.equal(r.task('BTC').phase,'collect');
 r.recheck('BTC');assert.equal(depth(r.task('BTC')).status,'retain');r.ingestMarket([sourceRow({state:'error'})]);assert.equal(depth(r.task('BTC')).status,'retain');assert.equal(r.context('BTC').ready,false);assert.equal(r.handoff('BTC'),null);
});

test('new daily and book snapshots have independent watermarks, so late input cannot roll either source back',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now}),first=book();r.ingestMarket([{...sourceRow(),...depthRow('BTC',first)}]);now+=day;
 const second=book('BTC',{lastUpdateId:11,requestStartedAt:now*1000-500,receivedAt:now*1000-100}),nextDay=sourceRow({sampleAt:closedAt,closedAt:closedAt+day,validUntil:closedAt+2*day,price:102});r.ingestMarket([{...nextDay,...depthRow('BTC',second)}]);
 const third=book('BTC',{lastUpdateId:12,requestStartedAt:now*1000-400,receivedAt:now*1000-50});r.ingestMarket([{...sourceRow(),...depthRow('BTC',third)}]);assert.equal(r.context('BTC').price,102);assert.equal(r.task('BTC').depthObservation.lastUpdateId,12);
 const v=r.task('BTC').version,n=r.sequence;r.ingestMarket([depthRow('BTC',second)]);assert.equal(r.task('BTC').depthObservation.lastUpdateId,12);assert.equal(r.task('BTC').version,v);assert.equal(r.sequence,n);
 const newerDay={...nextDay,price:103};r.ingestMarket([{...newerDay,...depthRow('BTC',second)}]);assert.equal(r.context('BTC').price,103);assert.equal(r.task('BTC').depthObservation.lastUpdateId,12);
 r.ingestMarket([depthRow('BTC',book('BTC',{lastUpdateId:9,requestStartedAt:now*1000-200,receivedAt:now*1000-10}))]);assert.equal(r.task('BTC').depthObservation.lastUpdateId,12);
});

test('depth assets, repeated snapshots and histories remain isolated and bounded without simulated handoffs',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now});r.ingestMarket([depthRow('BTC'),depthRow('ETH')]);const eth=r.task('ETH').version,v=r.task('BTC').version,n=r.sequence;
 assert.equal(r.ingestMarket([depthRow('BTC')]),false);assert.equal(r.task('BTC').version,v);assert.equal(r.sequence,n);assert.equal(depth(r.task('SOL')).status,'missing');
 for(let i=0;i<40;i++){now=NOW+i/10;r.ingestMarket([depthRow('BTC',book('BTC',{lastUpdateId:20+i,requestStartedAt:Math.round(now*1000)-50,receivedAt:Math.round(now*1000)-10}))]);}
 assert.equal(r.task('ETH').version,eth);assert.equal(r.task('BTC').history.length,5);assert.equal(r.events.length,32);assert.equal(r.task('BTC').phase,'collect');assert.equal(r.context('BTC').ready,false);assert.equal(r.handoff('BTC'),null);
 const exported=r.snapshot();exported.tasks.find(t=>t.symbol==='BTC').depthObservation.bids[0][1]='999';assert.equal(r.task('BTC').depthObservation.bids[0][1],'2');
});

import {normalizeResearchBackground} from './market-hub-data.mjs';
function contextRow(resource,{at=NOW*1000,asOf=Math.floor(NOW/86400)*86400000}={}){
 const body=resource==='sentiment'?{data:[{timestamp:String(asOf/1000),value:'37'}]}:resource==='chains'?[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500}]:[{date:asOf/1000,totalCirculatingUSD:{peggedUSD:100,peggedEUR:20}}];
 return {resource,state:'ready',snapshot:normalizeResearchBackground({schema:'public-market-relay-v1',resource,receivedAt:at,body},resource,at)};
}
const evidence=(r,symbol,key)=>r.task(symbol).evidence.find(row=>row.key===key);
test('real public background has exact asset scope, remains context, and grants no new execution authority',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([sourceRow()]);const phase=r.task('BTC').phase,version=r.task('BTC').version;
 assert.equal(r.ingest(['sentiment','chains','stablecoins'].map(resource=>contextRow(resource))),true);
 assert.equal(r.task('BTC').version,version+1,'one batch changes each task only once');assert.equal(r.task('BTC').phase,phase);
 for(const symbol of ['BTC','ETH','SOL']){assert.equal(evidence(r,symbol,'macro').status,'context');assert.equal(evidence(r,symbol,'risk').status,'missing');assert.equal(r.context(symbol).ready,false);assert.equal(r.handoff(symbol),null);}
 assert.equal(evidence(r,'BTC','social').status,'context');assert.match(evidence(r,'BTC','social').text,/37\/100/);assert.equal(evidence(r,'ETH','social').status,'missing');assert.equal(evidence(r,'SOL','social').status,'missing');
 for(const symbol of ['ETH','SOL']){assert.equal(evidence(r,symbol,'chain').status,'context');assert.equal(evidence(r,symbol,'chain').asOf,null);assert.equal(evidence(r,symbol,'chain').timeBasis,'retrieval-time');}
 assert.equal(evidence(r,'BTC','chain').status,'missing');for(const symbol of ['SPX','NDX','DXY','US10Y','XAU']){assert.equal(evidence(r,symbol,'macro').status,'missing');assert.equal(evidence(r,symbol,'social').status,'missing');assert.equal(evidence(r,symbol,'chain').status,'na');}
 assert.ok(r.shared.every(source=>source.decision==='context'));assert.equal(r.process().ready,false);assert.equal(r.summary().candidates,0);
});
test('background expiry is independent of the visual clock, receipt refresh and other sources',()=>{
 let now=NOW;const r=new MarketResearch({now:()=>now});r.ingest(['sentiment','chains','stablecoins'].map(resource=>contextRow(resource)));const before=r.task('ETH').version;
 now+=900;assert.equal(r.shared.find(row=>row.id==='chain').decision,'missing');assert.equal(evidence(r,'ETH','chain').status,'missing');assert.equal(evidence(r,'ETH','macro').status,'context');assert.equal(evidence(r,'BTC','social').status,'context');assert.equal(r.time,0);assert.equal(r.task('ETH').version,before+1);
 const sequence=r.sequence;r.snapshot();r.task('ETH');assert.equal(r.sequence,sequence);
 now=Math.floor(NOW/86400)*86400+129600;assert.equal(evidence(r,'BTC','social').status,'missing');assert.equal(evidence(r,'BTC','macro').status,'missing');
 const old=contextRow('sentiment');old.snapshot.receivedAt=now*1000;assert.equal(r.ingest([old]),false,'an unchanged old source expiry cannot be renewed by a new receipt time');assert.equal(r.background.sentiment.snapshot.asOf,Math.floor(NOW/86400)*86400000);
});
test('background duplicates, daily heartbeats and older observations do not replay versions or roll back evidence',()=>{
 const r=new MarketResearch({now:()=>NOW}),row=contextRow('sentiment');r.ingest([row]);const before=r.snapshot(),heartbeat=structuredClone(row);heartbeat.snapshot.receivedAt+=1;
 assert.equal(r.ingest([row]),false);assert.equal(r.ingest([heartbeat]),false);assert.equal(r.ingest([contextRow('sentiment',{asOf:row.snapshot.asOf-86400000})]),false);assert.deepEqual(r.snapshot(),before);
 assert.equal(r.ingest([row,row]),false);assert.equal(r.ingest('BTC',{source:'social',decision:'retain'}),false);
});
test('paused and failed background removes only its context and never erases technical or depth observations',()=>{
 const r=new MarketResearch({now:()=>NOW});r.ingestMarket([{...sourceRow(),...depthRow()}]);r.ingest(['sentiment','chains','stablecoins'].map(resource=>contextRow(resource)));const original=r.task('BTC').observation;
 r.ingest([{resource:'sentiment',state:'paused',snapshot:null}]);assert.equal(evidence(r,'BTC','social').status,'missing');assert.equal(evidence(r,'BTC','macro').status,'context');assert.equal(trend(r.task('BTC')).status,'retain');assert.equal(depth(r.task('BTC')).status,'retain');assert.deepEqual(r.task('BTC').observation,original);
 const bad=contextRow('stablecoins');bad.snapshot.provider='Fixture';r.ingest([bad]);assert.equal(evidence(r,'BTC','macro').status,'missing');assert.equal(evidence(r,'ETH','chain').status,'context');
 const sequence=r.sequence;r.ingest([bad]);assert.equal(r.sequence,sequence);r.ingest([contextRow('sentiment')]);assert.equal(evidence(r,'BTC','social').status,'context');
});
test('shared refresh only requests its existing resource and keeps snapshots detached and source-bound',()=>{
 const requested=[],r=new MarketResearch({now:()=>NOW});r.setSharedRefresh(resource=>requested.push(resource));r.ingest([contextRow('chains')]);const before=r.snapshot();
 assert.deepEqual(r.refreshShared('chain'),[]);r.refreshShared('social');r.refreshShared('macro');assert.deepEqual(requested,['chains','sentiment','stablecoins']);assert.deepEqual(r.snapshot(),before);
 const exported=r.snapshot();exported.background.chains.snapshot.data[0].tvl=1;exported.shared[2].snapshot.data[0].tvl=2;assert.equal(r.background.chains.snapshot.data[0].tvl,1000);
});

import {researchPublicDetail} from './research-board.js';
import {photonicChannels} from './photonic-workbench.mjs';
import {createLicensedFeeds} from './licensed-feeds.mjs';

async function licensedEvidence(resource,at){
 const curation={minFollowers:50000,maxTopicRank:100,minCreatorInteractions24h:1000,minDistinctPosts:2,maxPostsPerAuthor:1,checkedTopics:['BTC','ETH','SOL'],failedTopics:[],rankedCreators:9,qualifiedCreators:1};
 const handler=createLicensedFeeds({now:()=>at,coindesk:async()=>[],blockbeats:async()=>[
  {id:'42',title:'BTC & <ETH> flash',url:'https://m.theblockbeats.info/flash/42',publishedAt:at-60_000,symbols:['BTC','ETH'],revision:null},
  {id:'43',title:'General',url:'https://m.theblockbeats.info/flash/43',publishedAt:at-60_000,symbols:[],revision:null}
 ],lunarcrush:async()=>({observedAt:at,errors:[],curation,topics:[{symbol:'ETH',topic:'ethereum',asOf:null,posts24h:0,contributors24h:null,interactions24h:120,sentimentByNetwork:{X:0,Reddit:82}}],
 posts:[{network:'X',id:'42',title:'UNTRUSTED POST BODY',url:'https://x.com/example/status/42',author:'<KOL>',symbols:['BTC','SOL'],publishedAt:at-120000,interactions24h:50,creatorId:'twitter::42',followers:56000,profileUrl:null,topicRank:14,creatorInteractions24h:1300,qualifyingPostCount:2,evidenceSymbol:'BTC'}]})});
 let result;await handler({url:'/api/market-hub?resource='+resource+'&limit=50',method:'GET'},{writeHead(code){assert.equal(code,200);},end(body){result=JSON.parse(body);}});return result;
}
test('licensed research citations use matching assets, platform scores, real zeroes and linked originals without granting trading or trusting social text',async()=>{
 const at=Date.UTC(2026,10,18,3);let clock=at;
 const research=new MarketResearch({now:()=>clock/1000}),news=await licensedEvidence('news',at),social=await licensedEvidence('social',at);
 research.ingestPublic('news',news);research.ingestPublic('social',social);
 const btc=research.task('BTC'),eth=research.task('ETH'),sol=research.task('SOL');
 assert.deepEqual(btc.publicFacts.map(f=>f.kind),['news','kol']);assert.deepEqual(eth.publicFacts.map(f=>f.kind),['news','topic']);assert.deepEqual(sol.publicFacts,[]);assert.deepEqual(research.task('SPX').publicFacts,[]);
 assert.equal(btc.evidence.find(e=>e.key==='social').status,'context');assert.equal(research.context('BTC').ready,false);assert.equal(research.handoff('ETH'),null);
 assert.doesNotMatch(JSON.stringify(research.snapshot()),/UNTRUSTED POST BODY/);
 const ethDetail=researchPublicDetail(eth),btcDetail=researchPublicDetail(btc);
 assert.match(researchPublicDetail({symbol:'ETH'}),/metric=exchange-asset-flows&amp;asset=ETH/);
 assert.match(researchPublicDetail({symbol:'BTC'}),/view=venue-liquidations&amp;asset=BTC/);
 assert.match(ethDetail,/asset=eth&amp;view=flows/);assert.doesNotMatch(btcDetail,/asset=eth&amp;view=flows/);
 assert.match(ethDetail,/m\.theblockbeats\.info\/flash\/42/);assert.match(ethDetail,/&lt;ETH&gt;/);assert.match(ethDetail,/X 0\/100.*Reddit 82\/100/);assert.doesNotMatch(ethDetail,/General/);
 assert.match(btcDetail,/https:\/\/x\.com\/example\/status\/42/);assert.match(btcDetail,/&lt;KOL&gt;/);
 const channels=photonicChannels(eth,research);assert.equal(channels.find(c=>c.id==='news').provider,'BlockBeats');assert.equal(channels.find(c=>c.id==='posts').text,'0');assert.equal(channels.find(c=>c.id==='posts').provider,'LunarCrush');
 const version=eth.version;research.ingestPublic('news',news);assert.equal(research.task('ETH').version,version);
 clock=at+3600000;assert.deepEqual(research.task('ETH').publicFacts.map(f=>f.kind),['news']);assert.deepEqual(research.task('BTC').publicFacts.map(f=>f.kind),['news']);
 clock=at+86400000;assert.deepEqual(research.task('BTC').publicFacts,[]);assert.equal(research.task('BTC').evidence.find(e=>e.key==='social').status,'missing');
});
test('invalid, unavailable, expired, demo, or unmatched reads cannot supply an asset research citation',async()=>{
 const at=Date.UTC(2026,10,18,3);const research=new MarketResearch({now:()=>at/1000}),news=await licensedEvidence('news',at),social=await licensedEvidence('social',at);
 for(const change of [
  body=>body.mode='offline_fixture',body=>body.quality='stale',body=>body.sources[0].status='UNAVAILABLE',
  body=>body.items[0].data.url='javascript:alert(1)',body=>body.items[0].data.url='https://unknown.example/flash/42'
 ]){
  research.ingestPublic('news',news);const broken=structuredClone(news);change(broken);research.ingestPublic('news',broken);assert.deepEqual(research.task('ETH').publicFacts,[]);
 }
 research.ingestPublic('social',social);
 const older=structuredClone(social);older.requested_at_ms-=1000;older.quality='stale';research.ingestPublic('social',older);
 assert.equal(research.task('ETH').publicFacts.length,1);
 const partial=structuredClone(social);partial.quality='partial';partial.coverage.errors=[{symbol:'ETH',resource:'topic',code:'UPSTREAM'}];
 research.ingestPublic('social',partial);assert.deepEqual(research.task('ETH').publicFacts,[]);assert.equal(research.task('BTC').publicFacts[0].kind,'kol');
 research.ingestPublic('social',null);assert.deepEqual(research.task('BTC').publicFacts,[]);
});
