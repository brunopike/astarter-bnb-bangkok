import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bindCardEdges} from './product-composition.mjs';
import {statementDay,statementScope,statementRecords,projectStatements} from './statements-data.mjs';
import {marketScatterPosition,marketScatterLabels,marketScatterHit,WorkbenchScanMotion,capitalPnlMarkup,pnlLedSeries,pnlMatrixLevel,pnlMatrixTarget} from './workbench-charts.mjs';

test('overlapping 44px targets resolve to the closest observation regardless of SVG paint order',()=>{
 const rows=[{symbol:'BTC',state:'ready',x:-1,y:46},{symbol:'ETH',state:'ready',x:-.85,y:47},{symbol:'US10Y',state:'ready',x:-1.1,y:45}];
 for(const width of [240,400,700])for(const row of rows){
  const point=marketScatterPosition(row.x,row.y,width);
  assert.equal(marketScatterHit(rows,width,point.x,point.y),row.symbol);
  assert.equal(marketScatterHit([...rows].reverse(),width,point.x,point.y),row.symbol);
 }
 assert.equal(marketScatterHit(rows,400,370,31),null);
 const point=marketScatterPosition(1,60,400);
 assert.equal(marketScatterHit([{symbol:'FAILED',state:'stale',x:1,y:60}],400,point.x,point.y),null);
});

test('scanner feedback follows fresh feed events and confirmed position changes only',()=>{
 const motion=new WorkbenchScanMotion(),row={symbol:'BTC',state:'ready',x:1,y:60,activityAt:100,freshAt:100,paused:false};
 assert.deepEqual(motion.read([row],true,100).get('BTC'),{from:null,pulse:true});
 assert.equal(motion.read([row],true,100.5).size,0,'rendering the same observation must not replay arrival');
 assert.deepEqual(motion.read([{...row,activityAt:101}],true,101).get('BTC'),{from:null,pulse:true},'a live quote pulses without moving daily coordinates');
 const changed=motion.read([{...row,x:1.4,y:62,activityAt:102}],true,102).get('BTC');
 assert.equal(changed.from.x,1);assert.equal(changed.from.y,60);assert.equal(changed.pulse,true);
 assert.equal(motion.read([{...row,state:'error',activityAt:103}],true,103).size,0,'failed sources never look live');
 assert.equal(motion.read([{...row,activityAt:105}],true,110).size,0,'old arrivals are not replayed');
});
test('scanner consumes updates silently while paused, hidden or reduced, then waits for a new event',()=>{
 const motion=new WorkbenchScanMotion(),row={symbol:'ETH',state:'ready',x:-1,y:45,activityAt:10};
 motion.read([row],true,10);
 const next={...row,x:-.8,activityAt:11};assert.equal(motion.read([next],false,11).size,0);
 assert.equal(motion.read([next],true,11.5).size,0);
 assert.equal(motion.read([{...next,paused:true,activityAt:12}],true,12).size,0);
 assert.equal(motion.read([{...next,activityAt:12}],true,12.5).size,0);
 assert.equal(motion.read([{...next,activityAt:13}],true,13).get('ETH').pulse,true);
 motion.read([],true,14);assert.equal(motion.previous.size,0);
});

test('market map axes stay fixed as assets arrive, with explicit edge handling for outliers',()=>{
 assert.deepEqual(marketScatterPosition(0,50,400),{x:201,y:102,clipped:false});
 assert.deepEqual(marketScatterPosition(-3,20,400),{x:32,y:173,clipped:false});
 assert.deepEqual(marketScatterPosition(3,80,400),{x:370,y:31,clipped:false});
 assert.deepEqual(marketScatterPosition(7,92,400),{x:370,y:31,clipped:true});
 assert.deepEqual(marketScatterPosition(-7,8,400),{x:32,y:173,clipped:true});
 assert.equal(marketScatterPosition(0,50,320).y,102);assert.equal(marketScatterPosition(0,50,320).clipped,false);
});
test('all eight market labels avoid each other across the quadrant boundary without moving observations',()=>{
 const rows=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'].map((symbol,i)=>({symbol,x:i%2?.05:-.05,y:49+i*.1})),before=structuredClone(rows);
 for(const width of [240,320,700])for(const level of [20,50,80])for(const edge of [-3,0,3])for(const spread of [false,true]){
  const sample=rows.map((row,i)=>({...row,x:row.x+edge,y:spread?20+i*8.5:level+row.y-50})),labels=marketScatterLabels(sample,width);
  assert.equal(labels.size,8);
  const boxes=sample.map(row=>{const point=marketScatterPosition(row.x,row.y,width),label=labels.get(row.symbol),textWidth=row.symbol.length*7.2,end=point.x+label.dx+(label.anchor==='start'?textWidth:0);return {start:end-textWidth,end,y:point.y+label.dy,pointY:point.y};});
  for(const [i,box]of boxes.entries()){
   assert.ok(box.start>=38-1e-8&&box.end<=width-36+1e-8,'labels stay inside the plot');
   assert.ok(box.y>=56-1e-8&&box.y<=154+1e-8,'quadrant captions keep their own space');
   for(const other of boxes.slice(i+1)){
    const separate=box.end+5<=other.start+1e-8||other.end+5<=box.start+1e-8;
    assert.ok(separate||Math.abs(box.y-other.y)>=14-1e-8,'label rectangles cannot overlap');
    if(!separate)assert.ok((box.pointY-other.pointY)*(box.y-other.y)>=0,'nearby labels preserve vertical order instead of crossing');
   }
  }
  assert.deepEqual(labels,marketScatterLabels([...sample].reverse(),width),'feed order does not shuffle labels');
 }
 assert.deepEqual(rows,before);assert.equal(marketScatterLabels([],320).size,0);
});
test('separated assets keep nearby labels rather than joining one vertical stack',()=>{
 const rows=[{symbol:'BTC',x:-2,y:50},{symbol:'ETH',x:2,y:50}],labels=marketScatterLabels(rows,700);
 assert.equal(labels.get('BTC').dy,labels.get('ETH').dy);
 assert.equal(labels.get('BTC').dx,-12);assert.equal(labels.get('ETH').dx,12);
 assert.ok(Math.abs(labels.get('BTC').dy-4)<=7);
});
test('nearby asset labels clear neighbouring point rings as well as each other',()=>{
 const rows=[['BTC',-1.34,38],['ETH',-.94,39.6],['SOL',-1.66,30.5],['SPX',-2.41,35.1],['NDX',-2.91,31.4],['XAU',.31,49.9],['DXY',.91,59],['US10Y',-1.67,36.9]].map(([symbol,x,y])=>({symbol,x,y}));
 for(const width of [300,640]){
  const labels=marketScatterLabels(rows,width);
  for(const row of rows){
   const p=marketScatterPosition(row.x,row.y,width),label=labels.get(row.symbol),w=row.symbol.length*7.2,start=p.x+label.dx-(label.anchor==='end'?w:0),baseline=p.y+label.dy;
   for(const other of rows){const point=marketScatterPosition(other.x,other.y,width);assert.ok(point.x+7.5<=start||point.x-7.5>=start+w||point.y+7.5<=baseline-12||point.y-7.5>=baseline+4,`${row.symbol} must not cover ${other.symbol}`);}
  }
 }
});
import {workbenchMarketSample,workbenchMarketData,WorkbenchChartHistory,WorkbenchEvidenceMotion,createWorkbenchCharts,workbenchTimeLabel,workbenchEvidenceStatus} from './workbench-charts.mjs';
import {createMarketScanner,marketScatterSample} from './workbench-market-analysis.mjs';
import {normalizeSpotDepth} from './spot-depth-data.mjs';

test('chart labels are relative to the displayed window, not long-lived research uptime',()=>{
 assert.match(workbenchTimeLabel(161280,161280),/现在|Now/);
 assert.match(workbenchTimeLabel(161268,161280),/12秒前|12s ago/);
 assert.match(workbenchTimeLabel(161190,161280),/1分30秒前|1m 30s ago/);
 assert.equal(workbenchTimeLabel(NaN,161280),'—');
 assert.match(workbenchTimeLabel(161282,161280),/现在|Now/);
});

test('unsupported on-chain sources remain explicit, while crypto waits for actual evidence',()=>{
 assert.equal(workbenchEvidenceStatus({symbol:'XAU',evidence:[]},'chain'),'na');
 assert.equal(workbenchEvidenceStatus({symbol:'ETH',evidence:[]},'chain'),'pending');
 assert.equal(workbenchEvidenceStatus({symbol:'ETH',evidence:[{key:'chain',status:'conflict'}]},'chain'),'conflict');
 const history=new WorkbenchChartHistory();history.record({symbol:'XAU',version:769,evidence:[]},{cash:10000},161280);
 assert.equal(history.timeline[0].values[4],'na');
 assert.equal(history.timeline[0].values[0],'pending');
});

test('market samples are deterministic, correctly bounded and do not mix assets',()=>{
 const a=workbenchMarketSample('BTC',42,120),b=workbenchMarketSample('BTC',42,120),eth=workbenchMarketSample('ETH',42,120);
 assert.deepEqual(a,b);assert.notEqual(a.price,eth.price);assert.equal(workbenchMarketSample('UNKNOWN',42),null);
 assert.equal(a.bars.length,80);assert.equal(a.bars.at(-1).at,42);
 assert.ok(Number.isFinite(workbenchMarketSample('BTC',NaN,-1).price));
 for(const bar of a.bars){assert.ok(bar.low<=bar.open&&bar.low<=bar.close);assert.ok(bar.high>=bar.open&&bar.high>=bar.close);assert.ok(bar.volume>0);}
 assert.equal(workbenchMarketSample('US10Y',42).unit,'%');assert.equal(workbenchMarketSample('US10Y',42).changeUnit,'bp');assert.equal(a.changeUnit,'%');
 assert.equal(a.distribution.reduce((v,bin)=>v+bin.count,0),80);
 for(const level of a.book){assert.ok(level.bid<a.price&&level.ask>a.price);assert.ok(level.bidSize>0&&level.askSize>0);}
 for(let i=1;i<a.book.length;i++){assert.ok(a.book[i].bid<a.book[i-1].bid);assert.ok(a.book[i].ask>a.book[i-1].ask);}
});

test('observation windows change the sample, not the most recent quote',()=>{
 const a=workbenchMarketSample('SOL',73.2,60),b=workbenchMarketSample('SOL',73.2,300);
 assert.equal(a.price,b.price);assert.notEqual(a.bars[0].at,b.bars[0].at);
});

test('evidence records observed states only and clears at the research version boundary',()=>{
 const history=new WorkbenchChartHistory(),task={symbol:'ETH',version:1,evidence:[{key:'depth',status:'collected'},{key:'chain',status:'retain'}]},trade={time:7,cash:10000};
 history.record(task,trade,4);assert.equal(history.evidence.length,1);assert.equal(history.evidence[0].values[1],'collected');assert.equal(history.evidence[0].values[4],'retain');
 history.record(task,trade,5);assert.equal(history.evidence.length,1);
 history.record(task,trade,8,true);assert.equal(history.evidence.length,1);
 history.record({...task,version:2},trade,10);assert.equal(history.evidence.length,1);assert.equal(history.evidence[0].at,10);
 assert.deepEqual(history.timeline.map(point=>point.version),[1,2]);
 history.record({...task,symbol:'BTC'},trade,12);history.record({...task,version:2},trade,12);assert.equal(history.timeline[0].version,1);assert.equal(history.evidence[0].version,2);
 for(let i=0;i<100;i++)history.record(task,{time:i,cash:10000},i*2);
 assert.equal(history.evidence.length,32);
});

test('account chart never fabricates history or rewrites trading state',()=>{
 const history=new WorkbenchChartHistory(),task={symbol:'BTC',version:1,evidence:[]},trade={time:500,cash:9800,totalFees:1,orders:[]},before=structuredClone(trade);
 history.record(task,trade,20);assert.deepEqual(history.account,[{at:500,value:9800}]);
 history.record(task,trade,22);assert.equal(history.account.length,1);
 history.record(task,{...trade,time:502,cash:9750},24);assert.deepEqual(history.account[1],{at:502,value:9750});
 history.record(task,{...trade,time:504,cash:9700},26,true);assert.deepEqual(history.account.at(-1),{at:504,value:9700});
 history.record(task,{...trade,time:0,cash:10000},30);assert.deepEqual(history.account,[{at:0,value:10000}]);
 assert.deepEqual(trade,before);
});


test('lazy chart controller can initialize and switch asset units before the renderer loads',()=>{
 const names=['document','window','matchMedia','IntersectionObserver','ResizeObserver','MutationObserver'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const node=()=>({innerHTML:'',dataset:{},children:new Map(),setAttribute(){},append(){},remove(){this.removed=true;},addEventListener(){},querySelector(selector){if(!this.children.has(selector))this.children.set(selector,node());return this.children.get(selector);},querySelectorAll(){return [];}});
 const Observer=class{observe(){}disconnect(){}};
 const fonts=new EventTarget(),page=new EventTarget();
 const doc={createElement:node,addEventListener(){},fonts,body:{dataset:{page:'workbench'}},documentElement:{lang:'zh',dataset:{theme:'light'}}};
 const mocks={document:doc,window:page,matchMedia:()=>({matches:false}),IntersectionObserver:Observer,ResizeObserver:Observer,MutationObserver:Observer};
 for(const [key,value]of Object.entries(mocks))Object.defineProperty(globalThis,key,{configurable:true,value});
 try{
  const ui=createWorkbenchCharts(node()),trade={time:0,cash:10000},task={symbol:'US10Y',version:1,evidence:[]};
  assert.doesNotThrow(()=>ui.update({task,trade,time:0,paused:false}));
  assert.match(ui.host.querySelector('.terminal-distribution-chart h3').innerHTML,/收益率|Yield/);
  assert.doesNotThrow(()=>ui.update({task:{...task,symbol:'ETH'},trade,time:1,paused:false}));
  assert.match(ui.host.querySelector('.terminal-distribution-chart h3').innerHTML,/价格|Price/);
  assert.doesNotThrow(()=>fonts.dispatchEvent(new Event('loadingdone')));
  page.dispatchEvent(new Event('pagehide'));
  assert.equal(ui.host.querySelector('.insight-market-switch').removed,true);
  assert.doesNotThrow(()=>fonts.dispatchEvent(new Event('loadingdone')));
 }finally{for(const key of names){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});


test('an idle account can show observed flat equity without advancing its trading clock',()=>{
 const history=new WorkbenchChartHistory(),task={symbol:'ETH',version:1,evidence:[]},trade={time:500,cash:10000};
 history.record(task,trade,40,false,0);history.record(task,trade,42,false,2);
 assert.deepEqual(history.account,[{at:0,value:10000},{at:2,value:10000}]);assert.equal(trade.time,500);
});


test('evidence motion distinguishes new observations from changed decisions',()=>{
 const motion=new WorkbenchEvidenceMotion(),first={at:0,version:1,values:['pending','retain','na']};
 assert.deepEqual(motion.read('ETH',[first]),{sample:false,rows:[]});
 const next={...first,at:2};assert.deepEqual(motion.read('ETH',[first,next]),{sample:true,rows:[]});
 const changed={...next,values:['collected','conflict','na']};const copy=structuredClone(changed);
 assert.deepEqual(motion.read('ETH',[first,changed]),{sample:false,rows:[0,1]});assert.deepEqual(changed,copy);
 assert.deepEqual(motion.read('ETH',[changed]),{sample:false,rows:[]});
});

test('evidence motion never replays old changes after pause, offscreen or asset switch',()=>{
 const motion=new WorkbenchEvidenceMotion(),point={at:0,version:1,values:['pending','pending']};motion.read('BTC',[point]);
 const next={at:4,version:2,values:['retain','context']};
 assert.deepEqual(motion.read('BTC',[next],false),{sample:false,rows:[]});
 assert.deepEqual(motion.read('BTC',[next]),{sample:false,rows:[]});
 assert.deepEqual(motion.read('ETH',[next]),{sample:false,rows:[]});
 motion.reset();assert.deepEqual(motion.read('ETH',[{...next,at:12}]),{sample:false,rows:[]});
 assert.deepEqual(motion.read('ETH',[{...next,at:14,version:3}]),{sample:true,rows:[0,1]});
 assert.deepEqual(motion.read('ETH',[]),{sample:false,rows:[]});
});

test('chart scheduling skips offscreen DOM work and sizes the scatter only from ResizeObserver',async()=>{
 const names=['document','window','location','matchMedia','IntersectionObserver','ResizeObserver','MutationObserver'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const intersections=[],resizes=[],nodes=[];
 const node=()=>{
  let html='';const children=new Map();
  const classes=new Set(),n={dataset:{},style:{},writes:0,hidden:false,listeners:new Map(),classList:{toggle(k,on){on?classes.add(k):classes.delete(k);},add(k){classes.add(k);}},setAttribute(){},removeAttribute(){},append(){},remove(){},replaceWith(){},addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);},contains(){return false;},querySelector(selector){if(!children.has(selector))children.set(selector,node());return children.get(selector);},querySelectorAll(){return [];}};
  Object.defineProperties(n,{innerHTML:{get(){return html;},set(value){html=value;n.writes++;}},clientWidth:{get(){throw new Error('Drawing must not synchronously measure width');}},clientHeight:{get(){throw new Error('Drawing must not synchronously measure height');}}});nodes.push(n);return n;
 };
 const page=new EventTarget(),fonts=new EventTarget();
 const doc={hidden:false,activeElement:null,createElement:node,addEventListener(){},fonts,body:{dataset:{page:'workbench',workbenchView:'photonic'}},documentElement:{lang:'zh',dataset:{theme:'dark'}}};
 const observer=list=>class{constructor(callback){list.push(callback);}observe(){}disconnect(){}};
 const mocks={document:doc,window:page,location:{search:'?page=workbench',hostname:'localhost'},matchMedia:()=>({matches:false}),IntersectionObserver:observer(intersections),ResizeObserver:observer(resizes),MutationObserver:observer([])};
 for(const [key,value]of Object.entries(mocks))Object.defineProperty(globalThis,key,{configurable:true,value});
 const settle=()=>new Promise(resolve=>setTimeout(resolve,5)),writes=()=>nodes.reduce((sum,n)=>sum+n.writes,0);
 try{
  const ui=createWorkbenchCharts(node()),task={symbol:'UNKNOWN',version:1,phase:'queued',evidence:[]},context={task,trade:{time:0,cash:10000},time:0,paused:true};
  const scatter=ui.host.querySelector('.terminal-insight-scatter'),initial=writes();
  ui.update(context);await settle();assert.equal(writes(),initial,'offscreen charts retain data without drawing');
  resizes[0]([{target:ui.host,contentRect:{width:800,height:500}},{target:scatter,contentRect:{width:464,height:280}}]);
  assert.equal(ui.host.dataset.chartLayout,undefined,'writing a grid inside observer delivery creates a WebKit resize loop');
  intersections[0]([{isIntersecting:true}]);await settle();
  assert.equal(ui.host.dataset.chartLayout,'wide');
  assert.match(scatter.innerHTML,/viewBox="0 0 464 207"/);
  assert.match(scatter.innerHTML,/role="tooltip" popover="manual" hidden/);
  assert.doesNotMatch(scatter.innerHTML,/class="scan-method"/,'calculation notes must not take default panel space');
  const originalTrade=structuredClone(context.trade);
  for(const period of ['day','week','month','all']){
   const button={dataset:{pnlPeriod:period}},event={target:{closest:selector=>selector==='button'?button:null}};
   for(const handle of ui.host.listeners.get('click'))handle(event);await settle();
   assert.match(ui.host.querySelector('.insight-capital-body').innerHTML,new RegExp('data-pnl-period="'+period+'" aria-selected="true"'),'the real controller passes the selected period into its renderer');
  }
  assert.deepEqual(context.trade,originalTrade,'period selection does not edit the account fixture');
  const rendered=writes();ui.update(context);ui.update(context);await settle();assert.equal(writes(),rendered,'unchanged data must not replace chart DOM');
  resizes[0]([{target:ui.host,contentRect:{width:390,height:500}},{target:scatter,contentRect:{width:360,height:280}}]);
  assert.equal(ui.host.dataset.chartLayout,'wide');await settle();assert.equal(ui.host.dataset.chartLayout,'stacked');assert.match(scatter.innerHTML,/viewBox="0 0 360 207"/);
  doc.hidden=true;const hidden=writes();ui.update({...context,time:30});await settle();assert.equal(writes(),hidden,'hidden document must not draw');
  intersections[0]([{isIntersecting:false}]);doc.hidden=false;ui.update({...context,time:31});await settle();assert.equal(writes(),hidden);
  intersections[0]([{isIntersecting:true}]);await settle();assert.ok(writes()>hidden,'returning to the chart renders the latest state');
  page.dispatchEvent(new Event('pagehide'));
 }finally{page.dispatchEvent(new Event('pagehide'));for(const key of names){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

async function chartLifecycleFixture(check,options={}){
 const names=['document','window','location','matchMedia','IntersectionObserver','ResizeObserver','MutationObserver','getComputedStyle'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const nodes=[],intersections=[],resizes=[],mutations=[],scans=[];
 const node=()=>{let html='';const children=new Map(),classes=new Set(),n={dataset:{},style:{setProperty(){}},writes:0,hidden:false,classList:{toggle(k,on){on?classes.add(k):classes.delete(k);},add(k){classes.add(k);}},setAttribute(){},removeAttribute(){},append(){},remove(){this.removed=true;},replaceWith(){},addEventListener(){},contains(){return false;},querySelector(selector){if(!children.has(selector))children.set(selector,node());return children.get(selector);},querySelectorAll(){return [];}};Object.defineProperty(n,'innerHTML',{get(){return html;},set(value){html=value;n.writes++;}});nodes.push(n);return n;};
 const page=new EventTarget(),doc=Object.assign(new EventTarget(),{hidden:false,activeElement:null,createElement:node,fonts:new EventTarget(),body:{dataset:{page:'workbench',workbenchView:'photonic'}},documentElement:{lang:'zh',dataset:{theme:'dark'}}});
 const observer=list=>class{constructor(callback){this.callback=callback;this.disconnected=0;list.push(this);}observe(){}disconnect(){this.disconnected++;}};
 const mocks={document:doc,window:page,location:{search:'?page=workbench',hostname:'localhost'},matchMedia:()=>({matches:false}),IntersectionObserver:observer(intersections),ResizeObserver:observer(resizes),MutationObserver:observer(mutations),getComputedStyle:()=>({fontFamily:'sans-serif',getPropertyValue:()=>'#555555'})};
 for(const [key,value]of Object.entries(mocks))Object.defineProperty(globalThis,key,{configurable:true,value});
 const event=(type,persisted)=>{const e=new Event(type);Object.defineProperty(e,'persisted',{value:persisted});page.dispatchEvent(e);};
 const settle=()=>new Promise(resolve=>setTimeout(resolve,5)),writes=()=>nodes.reduce((sum,n)=>sum+n.writes,0);
 try{
  const ui=createWorkbenchCharts(node(),{onMarketScan:rows=>scans.push(structuredClone(rows)),...options}),task={symbol:'UNKNOWN',domain:'TradFi',version:1,phase:'queued',evidence:[]},context={task,tasks:[task],trade:{time:0,cash:10000},time:0,paused:false},scatter=ui.host.querySelector('.terminal-insight-scatter');
  resizes[0].callback([{target:ui.host,contentRect:{width:800,height:500}},{target:scatter,contentRect:{width:464,height:280}}]);intersections[0].callback([{isIntersecting:true}]);ui.update(context);await settle();
  await check({ui,doc,event,settle,writes,scans,context,scatter,observers:[...intersections,...resizes,...mutations],resize:resizes[0],mutations});
 }finally{event('pagehide',false);for(const key of names){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
}

test('bfcache suspends scanner and rendering until persisted pageshow, then resumes the same chart controller',async()=>{
 await chartLifecycleFixture(async({ui,doc,event,settle,writes,scans,context,scatter,observers,resize,mutations})=>{
  assert.equal(ui.scanRows()[0].paused,false);const originalHost=ui.host;
  ui.update({...context,time:10});event('pagehide',true);const suspendedWrites=writes(),stoppedScans=scans.length;
  assert.equal(scans.at(-1)[0].paused,true);assert.equal(ui.host.dataset.chartMotion,'false');assert.ok(observers.every(observer=>observer.disconnected===0));
  doc.dispatchEvent(new Event('visibilitychange'));mutations[0].callback();ui.update({...context,time:20});await settle();
  assert.equal(scans.length,stoppedScans,'visibility and queued renders cannot restart a cached page');assert.equal(writes(),suspendedWrites);assert.equal(ui.scanRows()[0].paused,true);
  event('pageshow',false);await settle();assert.equal(scans.length,stoppedScans,'an unrelated pageshow cannot resume cached work');
  event('pageshow',true);await settle();assert.equal(ui.host,originalHost);assert.equal(ui.scanRows()[0].paused,false);assert.equal(scans.at(-1)[0].paused,false);assert.ok(observers.every(observer=>observer.disconnected===0));
  const restored=writes();resize.callback([{target:scatter,contentRect:{width:360,height:280}}]);await settle();assert.ok(writes()>restored);assert.match(scatter.innerHTML,/viewBox="0 0 360 207"/);
 });
});

test('a nonpersisted pagehide fully disposes charts and cannot be revived by visibility or persisted pageshow',async()=>{
 await chartLifecycleFixture(async({ui,doc,event,settle,writes,scans,context,observers})=>{
  event('pagehide',false);const stoppedWrites=writes(),stoppedScans=scans.length;
  assert.equal(ui.scanRows().length,0);assert.ok(observers.every(observer=>observer.disconnected===1));
  doc.dispatchEvent(new Event('visibilitychange'));event('pageshow',true);ui.update({...context,time:30});await settle();
  assert.equal(ui.scanRows().length,0);assert.equal(scans.length,stoppedScans);assert.equal(writes(),stoppedWrites);assert.ok(observers.every(observer=>observer.disconnected===1));
 });
});


test('shared surface light keeps chart pointer batching without a second chart listener',()=>{
 const names=['document','window','matchMedia','IntersectionObserver','ResizeObserver','MutationObserver','requestAnimationFrame','cancelAnimationFrame','getComputedStyle'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const frames=new Map();let frameId=0,reduced=false;
 const node=()=>{const classes=new Set(),n={isConnected:true,innerHTML:'',dataset:{},classList:{toggle(k,on){on?classes.add(k):classes.delete(k);},add(k){classes.add(k);}},listeners:new Map(),children:new Map(),values:new Map(),setAttribute(k,v){this.values.set(k,v);},removeAttribute(k){this.values.delete(k);},append(){},remove(){},replaceWith(){},addEventListener(k,fn){this.listeners.set(k,fn);},querySelector(k){if(!this.children.has(k))this.children.set(k,node());return this.children.get(k);},querySelectorAll(){return [];},getBoundingClientRect(){return {left:10,top:20,width:200,height:100};}};n.style={setProperty(k,v){n.values.set(k,v);}};return n;};
 const Observer=class{observe(){}disconnect(){}};const page=new EventTarget(),fonts=new EventTarget();
 const mocks={document:{...node(),createElement:node,fonts,body:{dataset:{page:'workbench',workbenchView:'photonic'}},documentElement:{lang:'zh',dataset:{theme:'dark'}}},window:page,matchMedia:()=>({get matches(){return reduced;},addEventListener(){}}),IntersectionObserver:Observer,ResizeObserver:Observer,MutationObserver:Observer,requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id),getComputedStyle:()=>({borderTopWidth:'1px'})};
 for(const [key,value]of Object.entries(mocks))Object.defineProperty(globalThis,key,{configurable:true,value});
 try{
  const ui=createWorkbenchCharts(node()),card=node();bindCardEdges();const move=document.listeners.get('pointermove'),leave=document.listeners.get('pointerleave');
  const event={pointerType:'mouse',clientX:50,clientY:60,target:{closest:()=>card}};
  ui.host.listeners.get('pointermove')(event);assert.equal(frames.size,0,'chart scanner must not schedule another edge draw');
  move(event);move({...event,clientX:70});assert.equal(frames.size,1);assert.equal(card.values.has('--surface-x'),false);
  const [[id,draw]]=frames;frames.delete(id);draw();assert.equal(card.values.get('--surface-x'),'60px');assert.equal(card.values.get('--surface-y'),'40px');
  move(event);leave();assert.equal(frames.size,0);assert.equal(card.values.has('data-pointer'),false);
  reduced=true;move(event);assert.equal(frames.size,0);reduced=false;move({...event,pointerType:'touch'});assert.equal(frames.size,0);
  move(event);page.dispatchEvent(new Event('pagehide'));assert.equal(frames.size,0);
 }finally{for(const key of names){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('account history includes BOT equity and resets across account scopes and missing observations',()=>{
 const h=new WorkbenchChartHistory(),task={symbol:'BTC',version:1,evidence:[]};
 h.record(task,{cash:9000,botSummary:{cash:1000,equity:1000,inventoryValue:0}},1,false,1);
 assert.deepEqual(h.account,[{at:1,value:10000}]);
 h.record(task,{cash:9000,botSummary:{cash:800,equity:1100,inventoryValue:300}},2,false,2);assert.equal(h.account.at(-1).value,10100);
 h.record(task,{cash:5000,accountId:'OTHER'},3,false,3);assert.deepEqual(h.account,[{at:3,value:5000}]);
 h.record(task,{cash:NaN},4,false,4);assert.deepEqual(h.account,[]);
 h.record(task,{cash:10000},5,false,5);assert.deepEqual(h.account,[{at:5,value:10000}]);
});
const pnlNow=Date.parse('2026-11-09T12:00:00Z'),pnlOptions={now:pnlNow,timeZone:'Asia/Shanghai'};
function pnlFixture(rows=[],patch={}){
 const orders=rows.map((row,i)=>({id:'O'+i,runId:'R'+i,accountId:row.accountId||'A',environment:row.environment||'DEMO',tradeOwner:row.owner===undefined?'AI_SPECTRUM':row.owner,market:'ETH/USDT',currency:row.currency||'USDT',marketType:'SPOT',side:'sell',price:110,qty:1,filled:1,status:'filled',recordedAt:row.at}));
 const fills=rows.map((row,i)=>({id:'F'+i,venueFillId:'V'+i,orderId:'O'+i,accountId:orders[i].accountId,marketType:'SPOT',side:'sell',quantity:'1',price:'110',notional:'110',currency:orders[i].currency,realizedPnlGross:row.gross===null?undefined:String(row.gross??0),feeState:row.pending?'PENDING':'CONFIRMED',recordedAt:row.at}));
 const ledger=rows.flatMap((row,i)=>row.fee===undefined?[]:[{id:'L'+i,economicEventId:'E'+i,accountId:orders[i].accountId,orderId:'O'+i,fillId:'F'+i,type:'FEE',amount:String(-row.fee),currency:row.feeCurrency||orders[i].currency,recordedAt:row.feeAt===undefined?row.at:row.feeAt,revision:1}]);
 return {cash:10120,totalFees:1.2345,time:95000,orders,flow:{fills,ledger},accountSummary:{accountId:'A',environment:'DEMO',unit:'USDT'},...patch};
}
const pnlCapital={known:true,accountId:'A',environment:'DEMO',unit:'USD eq.',pnl:120,equity:10120,fees:1.2345,realized:100,unrealized:20};
const pnlAt=day=>Date.parse('2026-11-'+day+'T04:00:00Z');

const pnlCellAt=(model,at)=>model.cells.find(cell=>(cell.segments||[cell]).some(part=>part.start<=at&&part.end>at));

test('time matrix has one independent point per interval and a matching receipt total',()=>{
 const trade=pnlFixture([{at:pnlAt('07'),gross:3},{at:pnlAt('08'),gross:-2},{at:pnlAt('09'),gross:0}]),before=structuredClone(trade),model=pnlLedSeries(trade,pnlOptions);
 assert.equal(model.columns.length,3);assert.equal(model.rows,6);assert.equal(model.cells.length,18);assert.equal(model.from,'2026-11-07');assert.equal(model.to,'2026-11-09');assert.equal(model.total,1);assert.equal(model.fills,3);
 assert.deepEqual(['07','08','09'].map(day=>{const cell=pnlCellAt(model,pnlAt(day));return [cell.day,cell.value,cell.state];}),[['2026-11-07',3,'gain'],['2026-11-08',-2,'loss'],['2026-11-09',0,'flat']]);
 assert.equal(model.cells.filter(cell=>Number.isFinite(cell.value)).length,3,'one receipt must not light multiple amount-height dots');assert.deepEqual(trade,before);
 const html=capitalPnlMarkup(pnlCapital,model),points=[...html.matchAll(/<button type="button" class="lms-cell"[\s\S]*?<\/button>/g)].map(x=>x[0]);
 assert.match(html,/data-pnl-text="\+1.00"/);assert.equal(points.length,18);assert.equal(new Set([...html.matchAll(/data-pnl-key="([^"]+)"/g)].map(m=>m[1])).size,18);
 assert.match(html,/<time datetime="2026-11-07"/);assert.match(html,/<time datetime="2026-11-09"/);assert.match(html,/>1.2345<\/dd>/);assert.doesNotMatch(html,/lms-zero|lms-guide|<circle|lms-lit/);
 const recorded=points.find(point=>point.includes('data-pnl-amount="+3.00"'));assert.match(recorded,/data-pnl-fills="1"/);assert.match(recorded,/data-pnl-records="true"/);assert.doesNotMatch(recorded,/data-statements=/,'selecting a point shows its value before the explicit day-records action');
 assert.match(recorded,/data-statement-from="2026-11-07" data-statement-to="2026-11-09" data-statement-day="2026-11-07" data-statement-zone="Asia\/Shanghai"/);
 const key=recorded.match(/data-pnl-key="([^"]+)"/)[1];assert.match(capitalPnlMarkup(pnlCapital,model,{selected:key}),new RegExp('tabindex="0" data-pnl-key="'+key+'"'));
 const ids=[...html.matchAll(/class="lms-cell" id="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,points.length);assert.ok(ids.includes('pnl-point-'+key));assert.deepEqual([...capitalPnlMarkup(pnlCapital,model).matchAll(/class="lms-cell" id="([^"]+)"/g)].map(m=>m[1]),ids,'receipt identities survive a fresh render for statement returns');
});

test('interval P&L follows corrections and fee time without counting snapshots or principal',()=>{
 const trade=pnlFixture([{at:pnlAt('08'),gross:10,fee:.1},{at:pnlAt('08'),gross:5,fee:.2}]);
 trade.flow.ledger.push({...trade.flow.ledger[0],revision:2,amount:'-0.3'});trade.flow.fills.push({...trade.flow.fills[0],id:'REPLAY',revision:0});
 trade.flow.ledger.push({id:'PRINCIPAL',economicEventId:'P',accountId:'A',orderId:'O0',fillId:'F0',type:'CASH_CREDIT',amount:'1000000',currency:'USDT',recordedAt:pnlAt('08')});
 const model=pnlLedSeries(trade,pnlOptions);assert.equal(model.total,14.5);assert.equal(pnlCellAt(model,pnlAt('08')).value,14.5);assert.equal(model.fills,2);
 const later=Date.parse('2026-11-08T10:00:00Z'),separate=pnlLedSeries(pnlFixture([{at:pnlAt('08'),gross:10,fee:.1,feeAt:later}]),pnlOptions);
 assert.equal(pnlCellAt(separate,pnlAt('08')).value,10);assert.equal(pnlCellAt(separate,later).value,-.1);assert.equal(pnlCellAt(separate,later).fills,0);assert.equal(separate.total,9.9);
 const late=pnlLedSeries(pnlFixture([{at:pnlAt('08'),gross:10,fee:.1,feeAt:pnlAt('09')}]),pnlOptions);
 assert.equal(pnlCellAt(late,pnlAt('08')).value,10);assert.equal(pnlCellAt(late,pnlAt('09')).value,-.1);assert.equal(late.total,9.9);
});

test('missing intervals, true zero, future slots and incomplete settlement remain distinct',()=>{
 const empty=pnlLedSeries(pnlFixture(),pnlOptions);assert.equal(empty.total,null);assert.ok(empty.cells.every(c=>['empty','future'].includes(c.state)&&c.value===null));
 const zero=pnlLedSeries(pnlFixture([{at:pnlAt('09'),gross:0}]),pnlOptions);assert.equal(zero.total,0);assert.equal(pnlCellAt(zero,pnlAt('09')).state,'flat');
 const future=pnlLedSeries(pnlFixture([{at:pnlAt('09'),gross:2},{at:pnlAt('10'),gross:1000}]),{...pnlOptions,period:'month'});
 assert.equal(future.total,2);assert.equal(pnlCellAt(future,pnlAt('10')).state,'future');assert.equal(pnlCellAt(future,pnlAt('10')).value,null);assert.equal(pnlCellAt(future,pnlAt('08')).state,'empty');
 for(const row of [{gross:1,pending:true},{gross:null},{gross:1,fee:1,feeCurrency:'BNB'}]){
  const model=pnlLedSeries(pnlFixture([{at:pnlAt('09'),...row}]),pnlOptions);assert.equal(model.total,null);assert.equal(pnlCellAt(model,pnlAt('09')).state,'unknown');assert.ok(model.issues>0);assert.match(capitalPnlMarkup(pnlCapital,model),/data-pnl-text="—"/);
 }
 const unknown=pnlLedSeries(pnlFixture([],{cash:NaN}),pnlOptions);assert.deepEqual(unknown.cells,[]);assert.equal(unknown.total,null);assert.doesNotMatch(capitalPnlMarkup({...pnlCapital,known:false},zero),/data-pnl-key/);
});

test('ownership and currency stay isolated, and undated history is never assigned fictional hours',()=>{
 const rows=[{at:pnlAt('09'),gross:2},{at:pnlAt('09'),gross:100,owner:'STRATEGY_AGENT'},{at:pnlAt('09'),gross:100,accountId:'B'},{at:pnlAt('09'),gross:100,environment:'LIVE'},{at:pnlAt('09'),gross:100,currency:'EUR'}];
 assert.equal(pnlLedSeries(pnlFixture(rows),pnlOptions).total,2);
 const old=pnlLedSeries(pnlFixture([{at:pnlAt('09'),gross:2,owner:null}]),{...pnlOptions,period:'month'});assert.equal(old.unclassified,1);assert.equal(old.total,null);assert.equal(pnlCellAt(old,pnlAt('09')).state,'unknown');assert.equal(pnlCellAt(old,pnlAt('08')).state,'empty');
 const undated=pnlLedSeries(pnlFixture([{at:95000,gross:2}]),pnlOptions);assert.ok(undated.undated>0);assert.equal(undated.total,null);assert.ok(undated.cells.every(c=>c.value===null));
 for(const feeCurrency of ['USDT','BNB']){const fee=pnlLedSeries(pnlFixture([{at:pnlAt('09'),gross:2,fee:.1,feeAt:null,feeCurrency}]),pnlOptions);assert.equal(fee.total,null);assert.equal(pnlCellAt(fee,pnlAt('09')).state,'unknown');}
 assert.doesNotMatch(capitalPnlMarkup(pnlCapital,undated),/1970|95000|NaN|Infinity/);
});

test('a timestamped unclassified receipt does not erase known or empty intervals on its day',()=>{
 const known=Date.parse('2026-11-09T01:05:00Z'),unclassified=Date.parse('2026-11-09T08:05:00Z'),empty=Date.parse('2026-11-08T16:05:00Z');
 const trade=pnlFixture([{at:known,gross:2},{at:unclassified,gross:100,owner:null}]);
 for(const period of ['day','week','month','all']){
  const model=pnlLedSeries(trade,{timeZone:'Asia/Shanghai',now:Date.parse('2026-11-09T12:00:00Z'),period});
  assert.equal(model.total,null);assert.ok(model.unclassified>0&&model.issues>0);
  assert.equal(pnlCellAt(model,known).state,'gain',period+' keeps the confirmed receipt');assert.equal(pnlCellAt(model,known).value,2);
  assert.equal(pnlCellAt(model,unclassified).state,'unknown');assert.equal(pnlCellAt(model,unclassified).value,null);
  assert.equal(pnlCellAt(model,empty).state,'empty');assert.equal(model.cells.filter(c=>c.state==='unknown').length,1,period+' marks only the interval with the ambiguous receipt');
 }
});

test('daily, Monday-week, month and all filters aggregate their own local-calendar range',()=>{
 const trade=pnlFixture([{at:Date.parse('2026-11-08T15:59:59Z'),gross:100},{at:Date.parse('2026-11-08T16:00:00Z'),gross:2},{at:pnlAt('09'),gross:-1}]);
 for(const period of ['day','week','month','all']){
  const model=pnlLedSeries(trade,{...pnlOptions,period});assert.equal(model.period,period);assert.equal(model.to,'2026-11-09');
  const expected=period==='day'||period==='week'?1:101;assert.equal(model.total,expected);assert.equal(model.cells.reduce((sum,c)=>sum+(c.value||0),0),expected);
  assert.match(capitalPnlMarkup(pnlCapital,model),new RegExp('data-pnl-period="'+period+'" aria-selected="true"'));
 }
 const day=pnlLedSeries(trade,{...pnlOptions,period:'day'}),week=pnlLedSeries(trade,{...pnlOptions,period:'week'}),month=pnlLedSeries(trade,{...pnlOptions,period:'month'});
 assert.equal(day.columns.length,24);assert.equal(day.cells.length,144);assert.equal(day.grain,'ten-minute');assert.equal(week.from,'2026-11-09');assert.equal(week.plotTo,'2026-11-15');assert.equal(month.from,'2026-11-01');assert.equal(month.plotTo,'2026-11-30');
 assert.equal(week.cells.filter(c=>c.state==='future').length,6*6);assert.equal(pnlLedSeries(trade,{...pnlOptions,period:'bad'}).period,'all');
 const sunday=pnlLedSeries(trade,{...pnlOptions,period:'week',now:Date.parse('2026-11-08T15:59:59Z')});assert.equal(sunday.from,'2026-11-02');
});

test('receipt time and timezone determine the interval, including DST repeated and missing hours',()=>{
 const trade=pnlFixture([{at:Date.parse('2026-11-08T16:01:00Z'),gross:2}]);
 const sh=pnlLedSeries(trade,{...pnlOptions,period:'day'}),utc=pnlLedSeries(trade,{...pnlOptions,period:'day',timeZone:'UTC'});assert.equal(sh.total,2);assert.equal(utc.total,null);
 const repeated=[Date.parse('2026-11-01T05:10:00Z'),Date.parse('2026-11-01T06:10:00Z')],options={timeZone:'America/New_York',period:'day',now:Date.parse('2026-11-02T04:59:59Z')};
 const dst=pnlLedSeries(pnlFixture(repeated.map((at,i)=>({at,gross:i+2}))),options);assert.equal(dst.columns.length,25);assert.equal(dst.cells.length,150);assert.equal(dst.total,5);assert.notEqual(pnlCellAt(dst,repeated[0]).id,pnlCellAt(dst,repeated[1]).id);assert.deepEqual(repeated.map(at=>pnlCellAt(dst,at).value),[2,3]);
 const spring=pnlLedSeries(pnlFixture(),{...options,now:Date.parse('2026-03-09T03:59:59Z')});assert.equal(spring.columns.length,23);assert.equal(spring.cells.length,138);
 const month=pnlLedSeries(pnlFixture(repeated.map(at=>({at,gross:1}))),{...options,period:'month'});assert.equal(month.rows,7);const tail=month.cells.filter(c=>c.day==='2026-11-01').at(-1);assert.equal(tail.end-tail.start,3600000,'a 25-hour day keeps its final hour instead of truncating it');
 const range=pnlLedSeries(pnlFixture([{at:Date.parse('2026-10-10T04:00:00Z'),gross:100},{at:pnlAt('09'),gross:2},{at:pnlAt('10'),gross:100}]),{...pnlOptions,period:'month'});assert.equal(range.total,2);
 assert.deepEqual(pnlLedSeries(trade,{now:95000}).cells,[]);assert.equal(pnlLedSeries(trade,{...pnlOptions,timeZone:'Bad/Zone'}).timeZone,'UTC');
});

test('midnight rollback keeps both first-hour receipts on their local day in every period',()=>{
 const first=Date.parse('2021-10-28T21:10:00Z'),second=Date.parse('2021-10-28T22:10:00Z'),trade=pnlFixture([{at:first,gross:2},{at:second,gross:3}]);
 const options={timeZone:'Asia/Amman',now:Date.parse('2021-10-29T21:59:59Z')};
 for(const period of ['day','week','month','all']){
  const model=pnlLedSeries(trade,{...options,period});assert.equal(model.total,5);assert.equal(model.issues,0);
  assert.equal(model.cells.reduce((sum,c)=>sum+(c.value||0),0),model.total,period+' points conserve the period total');
  for(const at of [first,second])assert.equal(pnlCellAt(model,at)?.day,'2021-10-29',period+' keeps the receipt on its actual local date');
  if(period==='day'){assert.equal(model.columns.length,25);assert.equal(model.cells.length,150);assert.deepEqual([first,second].map(at=>pnlCellAt(model,at).value),[2,3]);}
 }
 const long=pnlLedSeries(pnlFixture([{at:Date.parse('2021-06-01T12:00:00Z'),gross:0},{at:first,gross:2},{at:second,gross:3}]),{...options,period:'all'});
 assert.equal(long.grain,'day');assert.equal(pnlCellAt(long,first).day,'2021-10-29');assert.equal(pnlCellAt(long,second).value,5);assert.equal(long.cells.reduce((sum,c)=>sum+(c.value||0),0),long.total);
});

test('midnight gaps and half-hour zones preserve their actual day duration and receipts',()=>{
 const cases=[
  {zone:'America/Sao_Paulo',day:'2018-11-04',first:'2018-11-04T03:10:00Z',second:'2018-11-05T01:10:00Z',now:'2018-11-05T01:59:59Z',columns:23,points:138},
  {zone:'Australia/Lord_Howe',day:'2026-04-05',first:'2026-04-04T14:40:00Z',second:'2026-04-04T15:10:00Z',now:'2026-04-05T13:29:59Z',columns:25,points:147},
  {zone:'Asia/Kolkata',day:'2026-11-09',first:'2026-11-08T18:40:00Z',second:'2026-11-09T18:20:00Z',now:'2026-11-09T18:29:59Z',columns:24,points:144}
 ];
 for(const item of cases)for(const period of ['day','week','month','all']){
  const times=[item.first,item.second].map(Date.parse),model=pnlLedSeries(pnlFixture(times.map((at,i)=>({at,gross:i+2}))),{timeZone:item.zone,now:Date.parse(item.now),period});
  assert.equal(model.total,5);assert.equal(model.cells.reduce((sum,c)=>sum+(c.value||0),0),model.total,item.zone+' '+period);
  for(const at of times)assert.equal(pnlCellAt(model,at)?.day,item.day);
  if(period==='day'){assert.equal(model.columns.length,item.columns);assert.equal(model.cells.length,item.points);assert.deepEqual(times.map(at=>pnlCellAt(model,at).value),[2,3]);}
 }
});

test('a local date that resumes after midnight rollback matches the shared daily ledger',()=>{
 const zone='America/St_Johns',times=['2009-11-01T02:30:30Z','2009-11-01T02:40:00Z','2009-11-01T03:40:00Z'].map(Date.parse),trade=pnlFixture(times.map((at,i)=>({at,gross:i+2})));
 const single=pnlLedSeries(pnlFixture([{at:times[1],gross:3}]),{timeZone:zone,now:Date.parse('2026-11-12T00:00:00Z'),period:'all'});
 assert.equal(single.total,3);assert.equal(single.issues,0);assert.equal(pnlCellAt(single,times[1])?.day,'2009-10-31');
 const recorded=[...capitalPnlMarkup(pnlCapital,single).matchAll(/<button type="button" class="lms-cell"[\s\S]*?<\/button>/g)].map(m=>m[0]).find(point=>point.includes('data-pnl-amount="+3.00"'));
 assert.match(recorded,/data-statement-day="2009-10-31"/,'opening the point uses the same date as its receipt');
 for(const [period,now]of [['day','2009-11-02T03:29:59Z'],['week','2009-11-02T03:29:59Z'],['month','2009-11-02T03:29:59Z'],['all','2009-11-02T03:29:59Z'],['all','2026-11-12T00:00:00Z']]){
  const model=pnlLedSeries(trade,{timeZone:zone,period,now:Date.parse(now)}),scope=statementScope('',{owner:'AI_SPECTRUM',accountId:'A',environment:'DEMO',currency:'USDT',timeZone:zone,from:model.from,to:model.to});
  const ledger=projectStatements(statementRecords(trade,scope),scope),byDay=new Map();
  for(const cell of model.cells)if(cell.value!==null)byDay.set(cell.day,(byDay.get(cell.day)||0)+cell.value);
  assert.equal(model.total,Number(ledger.net));assert.equal(model.cells.reduce((sum,c)=>sum+(c.value||0),0),model.total);
  assert.deepEqual([...byDay],ledger.days.map(row=>[row.day,Number(row.net)]),period+' day totals match the shared statement projection');
  for(const at of times){const day=statementDay(at,zone);if(day<model.from||day>model.to)continue;assert.equal(pnlCellAt(model,at)?.day,day);}
  for(const cell of model.cells.filter(c=>['2009-10-31','2009-11-01'].includes(c.day)))for(const part of cell.segments||[cell]){
   for(const at of [part.start,Math.floor((part.start+part.end)/2),part.end-1])assert.equal(statementDay(at,zone),cell.day,'each real interval remains inside its stated local date');
  }
 }
});

test('during a date rollback, each period keeps occurred receipts without admitting future or outside-period records',()=>{
 const cases=[
  {zone:'America/St_Johns',times:['2009-11-01T02:30:30Z','2009-11-01T02:40:00Z','2009-11-01T03:40:00Z'],now:'2009-11-01T02:45:00Z',outside:'2009-09-30T12:00:00Z',month:3},
  {zone:'Antarctica/Casey',times:['2010-03-04T14:30:00Z','2010-03-04T15:30:00Z','2010-03-04T16:30:00Z'],now:'2010-03-04T15:45:00Z',outside:'2010-02-28T00:00:00Z',month:5}
 ];
 for(const item of cases){
  const times=item.times.map(Date.parse),trade=pnlFixture([...times.map((at,i)=>({at,gross:i+2})),{at:Date.parse(item.outside),gross:11}]);
  for(const period of ['day','week','month','all']){
   const model=pnlLedSeries(trade,{timeZone:item.zone,now:Date.parse(item.now),period}),expected={day:3,week:5,month:item.month,all:16}[period];
   assert.equal(model.total,expected,item.zone+' '+period);assert.equal(model.cells.reduce((sum,c)=>sum+(c.value||0),0),expected);
   assert.equal(pnlCellAt(model,times[1]).value,3);
   if(expected===3)assert.equal(pnlCellAt(model,times[0]),undefined,'an occurred receipt outside this natural period stays excluded');
   else{assert.equal(pnlCellAt(model,times[0]).value,2);assert.equal(model.to,statementDay(times[0],item.zone),'a temporary date retreat cannot shorten the observed range');}
   const future=pnlCellAt(model,times[2]);if(future){assert.equal(future.state,'future');assert.equal(future.value,null);}
   if(period!=='all')assert.equal(pnlCellAt(model,Date.parse(item.outside)),undefined,'older periods do not enter this period');
  }
 }
});

test('all history switches to natural-day points after 90 days without dropping either end',()=>{
 for(const days of [90,91,800]){
  const first=pnlNow-(days-1)*86400000,model=pnlLedSeries(pnlFixture([{at:first,gross:3},{at:pnlNow,gross:-2}]),pnlOptions);
  assert.equal(model.grain,days<=90?'four-hour':'day');assert.equal(model.total,1);assert.equal(pnlCellAt(model,first).value,3);assert.equal(pnlCellAt(model,pnlNow).value,-2);assert.equal(model.cells.reduce((sum,c)=>sum+(c.value||0),0),1);
  assert.ok(model.cells[0].start<=first&&model.cells.at(-1).end>pnlNow);if(days>90)assert.equal(model.rows,7);if(days>365)assert.match(capitalPnlMarkup(pnlCapital,model),/2024/,'long history keeps the year in its time axis');
 }
});

test('positive and negative time points share four absolute-amount levels and two-dimensional navigation',()=>{
 for(const [value,level]of [[.01,1],[2.5,1],[2.5001,2],[5,2],[5.0001,3],[7.5,3],[7.5001,4],[10,4]]){assert.equal(pnlMatrixLevel(value,10),level);assert.equal(pnlMatrixLevel(-value,10),level);}
 for(const [value,max]of [[0,10],[NaN,10],[1,0],[1,NaN]])assert.equal(pnlMatrixLevel(value,max),0);
 const cells=Array.from({length:12},(_,i)=>({column:Math.floor(i/6),row:i%6}));
 assert.equal(pnlMatrixTarget(cells,3,'ArrowRight'),9);assert.equal(pnlMatrixTarget(cells,3,'ArrowDown'),4);assert.equal(pnlMatrixTarget(cells,3,'ArrowUp'),2);assert.equal(pnlMatrixTarget(cells,3,'ArrowLeft'),3);assert.equal(pnlMatrixTarget(cells,3,'Home'),0);assert.equal(pnlMatrixTarget(cells,3,'End'),11);
 const uneven=[...Array.from({length:7},(_,row)=>({column:0,row})),...Array.from({length:6},(_,row)=>({column:1,row}))];assert.equal(pnlMatrixTarget(uneven,6,'ArrowRight'),12);assert.equal(pnlMatrixTarget(uneven,0,'ArrowUp'),0);
});

test('P&L legend has four losses, one zero and four gains in signed amount order',()=>{
 const model=pnlLedSeries(pnlFixture([{at:pnlAt('08'),gross:-10},{at:pnlAt('09'),gross:10}]),pnlOptions),html=capitalPnlMarkup(pnlCapital,model);
 const legend=html.slice(html.indexOf('<span class="lms-scale"'),html.indexOf('<span class="lms-statuses"'));
 assert.equal([...legend.matchAll(/class="lms-dot"|class="lms-scale-zero"/g)].length,9,'one visual position per signed level, including zero');
 assert.equal([...legend.matchAll(/class="lms-dot"/g)].length,8,'zero must not add another white dot');
 assert.match(legend,/<span class="lms-scale-zero"[^>]*>0<\/span>/);
 const ramp=tone=>legend.match(new RegExp('data-pnl-scale="'+tone+'">([\\s\\S]*?)<\\/span>'))[1];
 assert.deepEqual([...ramp('loss').matchAll(/var\(--pnl-loss-(\d)\)/g)].map(m=>Number(m[1])),[4,3,2,1]);
 assert.deepEqual([...ramp('gain').matchAll(/var\(--pnl-gain-(\d)\)/g)].map(m=>Number(m[1])),[1,2,3,4]);
 assert.deepEqual([...ramp('loss').matchAll(/title="([^"]+)"/g)].map(m=>m[1]),['-10.00 – -7.50 USDT','-7.50 – -5.00 USDT','-5.00 – -2.50 USDT','-2.50 – 0.00 USDT']);
 assert.deepEqual([...ramp('gain').matchAll(/title="([^"]+)"/g)].map(m=>m[1]),['0.00 – 2.50 USDT','2.50 – 5.00 USDT','5.00 – 7.50 USDT','7.50 – 10.00 USDT']);
});

test('matrix markup remains stable between receipt changes, preserves tiny amounts and escapes units',()=>{
 const trade=pnlFixture([{at:pnlAt('09'),gross:.00000012}]),model=pnlLedSeries(trade,pnlOptions),html=capitalPnlMarkup(pnlCapital,model);
 assert.match(html,/data-pnl-amount="\+0.00000012"/);assert.equal(capitalPnlMarkup(pnlCapital,pnlLedSeries(trade,{...pnlOptions,now:pnlNow+10000})),html);
 assert.ok(!capitalPnlMarkup({...pnlCapital,unit:'<script>'},{...model,currency:'<script>'}).includes('<script>'));
 assert.match(capitalPnlMarkup(pnlCapital,pnlLedSeries(pnlFixture([{at:pnlAt('09'),gross:2.55952615}]),pnlOptions)),/data-pnl-amount="\+2.56"/);
});

test('LED amount updates retain existing digit strips instead of replaying the roll on every observation',()=>{
 const source=readFileSync(new URL('./workbench-charts.mjs',import.meta.url),'utf8'),body=source.match(/function updatePnlRolling\(node,text\)\{([\s\S]*?)\n\}/)[1];
 const update=Function('pnlRollingMarkup','document','return function(node,text){'+body+'}');
 let replacements=0,created=0;const slots=[...'+2.56'].map(ch=>({textContent:ch,dataset:{digit:ch},classList:{contains:key=>key===(/\d/.test(ch)?'lms-roll':'lms-static')},strip:{style:{transform:/\d/.test(ch)?`translateY(-${ch}em)`:''}},querySelector(){return this.strip;}}));
 const ink={children:slots,replaceChildren(){replacements++;}},spoken={textContent:'+2.56'},node={dataset:{pnlText:'+2.56'},querySelector:key=>key==='.lms-number'?ink:spoken,setAttribute(){}};
 const patch=update(()=>{throw new Error('existing digits must be retained');},{createElement(){created++;throw new Error('no new digit nodes');}});
 patch(node,'+2.57');assert.equal(node.dataset.pnlText,'+2.57');assert.equal(slots.at(-1).strip.style.transform,'translateY(-7em)');assert.equal(spoken.textContent,'+2.57');assert.equal(replacements,0);assert.equal(created,0);
 patch(node,'+2.57');assert.equal(replacements,0);assert.equal(created,0);
});


test('local empty P&L offers a labeled read-only example without replacing current account metrics',async()=>{
 const {workbenchPnlSeries}=await import('./workbench-charts.mjs');
 const {workbenchAccount}=await import('./workbench-insights.mjs');
 const trade={cash:10002.56,totalFees:1.104,orders:[],flow:{fills:[],ledger:[]},accountSummary:{accountId:'SIM-01',environment:'DEMO'}},before=structuredClone(trade);
 const sync={state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}},options={...pnlOptions,hostname:'127.0.0.1'};
 const model=workbenchPnlSeries(trade,sync,options),capital=workbenchAccount(trade),html=capitalPnlMarkup(capital,model);
 assert.equal(model.example,'spectrum-20261109');assert.equal(model.fills,54);assert.equal(model.total,124.40940454);assert.equal(model.from,'2026-10-14');assert.equal(model.to,'2026-11-09');assert.equal(model.timeZone,'Asia/Shanghai');
 assert.equal(model.cells.filter(c=>c.state==='gain').length,21);assert.equal(model.cells.filter(c=>c.state==='loss').length,33);assert.equal(model.cells.filter(c=>c.state==='empty').length,108);
 assert.match(html,/<span class="lms-title">AI 交易盈亏 · 参考数据<\/span>/);assert.match(html,/data-statement-example="spectrum-20261109"/);assert.match(html,/10,002.56/);assert.doesNotMatch(html,/10,315.81/);assert.deepEqual(trade,before);
 for(const status of [undefined,{...sync,state:'DISCONNECTED'},{...sync,scope:{accountId:'SIM-01',environment:'LIVE'}}])assert.equal(workbenchPnlSeries(trade,status,options).example,undefined);
 const actual=pnlFixture([{at:pnlAt('09'),gross:2}]);assert.equal(workbenchPnlSeries(actual,sync,options).example,undefined);assert.equal(workbenchPnlSeries(actual,sync,options).total,2);
});

test('explicit P&L review retains unresolved account history and stops outside its healthy account context',async()=>{
 const {workbenchPnlSeries}=await import('./workbench-charts.mjs');
 const {workbenchAccount}=await import('./workbench-insights.mjs');
 const trade=pnlFixture([{at:pnlAt('09'),gross:2,accountId:'SIM-01',owner:null}],{cash:10002.56,accountSummary:{accountId:'SIM-01',environment:'DEMO',unit:'USDT'}}),before=structuredClone(trade);
 const sync={state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}},options={...pnlOptions,hostname:'localhost'};
 const actual=workbenchPnlSeries(trade,sync,options);assert.equal(actual.example,undefined);assert.equal(actual.unclassified,1);assert.equal(actual.total,null);
 const model=workbenchPnlSeries(trade,sync,{...options,example:'spectrum-20261109'}),html=capitalPnlMarkup(workbenchAccount(trade),model);
 assert.equal(model.fills,54);assert.equal(model.accountUnclassified,1);assert.equal(model.total,124.40940454);
 assert.match(html,/<span class="lms-title">AI 交易盈亏 · 参考数据<\/span>/);assert.match(html,/历史盈亏待核对/);assert.match(html,/10,002.56/);assert.doesNotMatch(html,/10,315.81/);
 assert.deepEqual(workbenchPnlSeries(trade,sync,{...options,accountOnly:true}),actual);
 for(const status of [{...sync,state:'DISCONNECTED'},{...sync,scope:{accountId:'OTHER',environment:'LIVE'}}])assert.equal(workbenchPnlSeries(trade,status,{...options,example:'spectrum-20261109'}).example,undefined);
 assert.equal(workbenchPnlSeries(trade,sync,{...options,example:'invalid'}).example,undefined);assert.deepEqual(trade,before);
});

test('funding-only history and activity outside the selected day cannot become the reference scenario',async()=>{
 const {workbenchPnlSeries}=await import('./workbench-charts.mjs');
 const sync={state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}},options={...pnlOptions,hostname:'127.0.0.1',period:'day'};
 const trade={cash:10000,totalFees:0,orders:[],flow:{fills:[],ledger:[{id:'FUNDING',economicEventId:'FUNDING-1',type:'FUNDING',accountId:'SIM-01',environment:'DEMO',tradeOwner:'AI_SPECTRUM',currency:'USDT',amount:'2',recordedAt:pnlAt('09')}]},accountSummary:{accountId:'SIM-01',environment:'DEMO'}};
 const today=workbenchPnlSeries(trade,sync,options);assert.equal(today.example,undefined);assert.equal(today.total,2);assert.equal(today.fills,0);
 trade.flow.ledger[0].recordedAt=pnlAt('08');const emptyDay=workbenchPnlSeries(trade,sync,options);assert.equal(emptyDay.example,undefined);assert.equal(emptyDay.total,null);assert.equal(emptyDay.hasHistory,true);
});


import {createResearchBackgroundClient} from './market-hub-data.mjs';
import {MarketResearch} from './live-research.mjs';
test('actual chart background client connects once per source and suspends across pause, visibility and bfcache without renewing cached times',async()=>{
 const at=Date.UTC(2026,10,17,12),day=Date.UTC(2026,10,17),calls=[],research=new MarketResearch({now:()=>at/1000});
 const backgroundFactory=options=>createResearchBackgroundClient({...options,now:()=>at,fetchImpl:async(url,init)=>{
  calls.push({url,init});const resource=new URL(url,'https://example.test').searchParams.get('resource');
  const body=resource==='sentiment'?{data:[{timestamp:String(day/1000),value:'37'}]}:resource==='chains'?[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500}]:[{date:day/1000,totalCirculatingUSD:{peggedUSD:120}}];
  return new Response(JSON.stringify({schema:'public-market-relay-v1',resource,receivedAt:at,body}),{headers:{'Content-Type':'application/json'}});
 }});
 await chartLifecycleFixture(async({ui,context,doc,event,settle})=>{
  assert.equal(calls.length,0,'legacy/demo context never starts these readers');
  const live={...context,researchMode:'live_readonly',tasks:[{...context.task,domain:'Crypto'}]};ui.update(live);await settle();assert.equal(calls.length,3);assert.equal(research.task('BTC').evidence.find(row=>row.key==='social').status,'context');
  const original=structuredClone(research.background.sentiment.snapshot);ui.update({...live,task:{...context.task,symbol:'UNSUPPORTED'}});await settle();assert.equal(calls.length,3,'an asset switch does not refetch shared sources');
  ui.update({...live,paused:true});await settle();assert.equal(research.background.sentiment.state,'paused');assert.equal(research.task('BTC').evidence.find(row=>row.key==='social').status,'missing');
  ui.update(live);await settle();assert.deepEqual(research.background.sentiment.snapshot,original);assert.equal(calls.length,3);
  ui.update({...live,tasks:[context.task]});await settle();assert.equal(research.background.sentiment.state,'paused','a TradFi-only research scope does not poll crypto context');ui.update(live);await settle();assert.equal(calls.length,3);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(research.background.sentiment.state,'paused');doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(research.background.sentiment.state,'ready');
  event('pagehide',true);assert.equal(research.background.sentiment.state,'paused');doc.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(research.background.sentiment.state,'paused');
  event('pageshow',true);await settle();assert.equal(research.background.sentiment.state,'ready');assert.deepEqual(research.background.sentiment.snapshot,original);assert.equal(calls.length,3);
  event('pagehide',false);ui.update(live);event('pageshow',true);await settle();assert.equal(research.background.sentiment.state,'paused');assert.equal(calls.length,3);
 },{backgroundFactory,onSharedContext:rows=>research.ingest(rows)});
});

test('the actual legacy terminal never labels live research as a synthetic market',async()=>{
 await chartLifecycleFixture(async({ui,context,doc})=>{
  doc.body.dataset.workbenchView='terminal';
  const task={...context.task,symbol:'BTC',domain:'Crypto',mode:'live_readonly'};
  ui.update({...context,task,tasks:[task],researchMode:'live_readonly',paused:true});
  assert.doesNotMatch(ui.host.querySelector('.terminal-chart-title').innerHTML,/合成|Synthetic/);
  assert.match(ui.host.querySelector('.terminal-chart-title').innerHTML,/BTC/);
 });
});

test('an explicit App demo still uses the legacy sample without starting real legacy readers',async()=>{
 let reads=0,mounts=0;
 const scannerFactory=onChange=>createMarketScanner(onChange,{subscribe:()=>{reads++;return ()=>{};}});
 await chartLifecycleFixture(async({ui,context,doc,settle})=>{
  doc.body.dataset.workbenchView='terminal';doc.body.dataset.researchMode='demo';
  const task={...context.task,symbol:'BTC',domain:'Crypto'};ui.update({...context,task,tasks:[task]});await settle();
  assert.match(ui.host.querySelector('.terminal-chart-title').innerHTML,/Synthetic|合成/);assert.equal(reads,0);assert.equal(mounts,0);
 },{scannerFactory,mountMarketCharts:()=>{mounts++;return ()=>{};}});
});

const LIVE_MARKET_AT=Date.UTC(2026,10,17,12),LIVE_MARKET_DAY=Math.floor(LIVE_MARKET_AT/86400000)*86400;
function observedBars(offset=0){
 return Array.from({length:300},(_,index)=>({time:LIVE_MARKET_DAY-(300-index)*86400,open:100+index*.5+offset,high:102+index*.5+offset,low:99+index*.5+offset,close:100.5+index*.5+offset,volume:20+index}));
}
function observedRow(symbol='BTC',at=LIVE_MARKET_AT){
 return {symbol,source:'Binance Spot',unit:'USDT',timezone:'UTC',feedState:'snapshot',paused:false,...marketScatterSample(observedBars(),at/1000),depthState:'ready',depthSnapshot:normalizeSpotDepth({lastUpdateId:17,bids:[['249','2'],['247','4']],asks:[['251','3'],['253','5']]},symbol,{requestStartedAt:at-100,receivedAt:at})};
}
const liveContext=symbol=>({researchMode:'live_readonly',task:{symbol,domain:['BTC','ETH','SOL'].includes(symbol)?'Crypto':'TradFi',mode:'live_readonly',version:1,phase:'collect',evidence:[]},time:42,paused:false});

test('live terminal statistics use actual scanner closes and a verified raw book without inventing OHLC bars',()=>{
 const row=observedRow(),before=structuredClone(row),data=workbenchMarketData(liveContext('BTC'),[row],120,LIVE_MARKET_AT);
 assert.equal(data.mode,'live_readonly');assert.equal(data.state,'ready');assert.equal(data.price,250);assert.equal(data.closedAt,LIVE_MARKET_DAY);
 assert.deepEqual(data.bars,[],'a scanner price series is not fabricated into OHLC candles');assert.deepEqual(data.book,[]);
 assert.deepEqual(data.closes,observedBars().slice(-18).map(bar=>bar.close));assert.equal(data.mean,245.75);assert.ok(Math.abs(data.deviation-.5*Math.sqrt((18**2-1)/12))<1e-10);
 assert.equal(data.distribution.reduce((sum,bin)=>sum+bin.count,0),18);assert.deepEqual(data.depth.bids,[['249','2'],['247','4']]);assert.deepEqual(data.depth.asks,[['251','3'],['253','5']]);
 assert.equal(data.depth.requestStartedAt,LIVE_MARKET_AT-100);assert.equal(data.depth.validUntil,LIVE_MARKET_AT-100+30000);assert.deepEqual(row,before);
});

test('live terminal never falls back to samples for unavailable, paused, wrong-source or wrong-asset observations',()=>{
 const row=observedRow();
 for(const patch of [{state:'loading'},{state:'error'},{state:'stale'},{paused:true},{source:'Demo'},{methodVersion:'fixture'},{closedAt:LIVE_MARKET_AT/1000+1},{unit:'USD'},{feedState:'reconnecting'}]){
  const data=workbenchMarketData(liveContext('BTC'),[{...row,...patch}],300,LIVE_MARKET_AT);
  assert.notEqual(data.state,'ready',JSON.stringify(patch));assert.equal(data.price,null);assert.deepEqual(data.bars,[]);assert.deepEqual(data.distribution,[]);
 }
 for(const rows of [[],[observedRow('ETH')]]){const data=workbenchMarketData(liveContext('BTC'),rows,120,LIVE_MARKET_AT);assert.equal(data.price,null);assert.equal(data.depth,null);assert.deepEqual(data.bars,[]);}
 const paused=workbenchMarketData({...liveContext('BTC'),paused:true},[row],120,LIVE_MARKET_AT);assert.equal(paused.depth,null);assert.equal(paused.state,'paused');
 const unknown=workbenchMarketData(liveContext('UNKNOWN'),[row],120,LIVE_MARKET_AT);assert.equal(unknown.state,'unsupported');assert.equal(unknown.price,null);
});

test('book expiry and derived-value tampering clear the book without changing the daily observation or source clocks',()=>{
 const row=observedRow(),expired=workbenchMarketData(liveContext('BTC'),[row],120,row.depthSnapshot.validUntil);
 assert.equal(expired.state,'ready');assert.equal(expired.price,250);assert.equal(expired.depth,null);assert.equal(expired.depthState,'stale');assert.equal(row.depthSnapshot.receivedAt,LIVE_MARKET_AT);
 const bad=structuredClone(row);bad.depthSnapshot.bestBid=250;
 assert.equal(workbenchMarketData(liveContext('BTC'),[bad],120,LIVE_MARKET_AT).depth,null);
 const daily=workbenchMarketData(liveContext('BTC'),[row],120,row.validUntil*1000);assert.equal(daily.state,'stale');assert.equal(daily.price,null);assert.equal(daily.distribution.length,0);
});

test('TradFi keeps its daily source and unavailable book; only explicit demo can generate a synthetic sample',()=>{
 const crypto=observedRow(),row={...crypto,symbol:'SPX',source:'Yahoo Finance · S&P 500',unit:'index',timezone:'America/New_York'};
 const data=workbenchMarketData(liveContext('SPX'),[row],120,LIVE_MARKET_AT);assert.equal(data.state,'ready');assert.equal(data.price,250);assert.equal(data.depth,null);assert.equal(data.depthState,'unsupported');assert.equal(data.unit,'index');
 assert.deepEqual(workbenchMarketData({...liveContext('BTC'),researchMode:'demo'},[],120,LIVE_MARKET_AT),workbenchMarketSample('BTC',42,120));
 const withoutMode={task:{symbol:'BTC'},time:42,paused:false};assert.equal(workbenchMarketData(withoutMode,[],120,LIVE_MARKET_AT).price,null);
 const invalidSeries=workbenchMarketData(liveContext('BTC'),[{...crypto,priceSeries:[250,NaN]}],120,LIVE_MARKET_AT);assert.equal(invalidSeries.price,250);assert.deepEqual(invalidSeries.distribution,[]);
});

test('the actual live legacy controller mounts the existing candle component and isolates books across assets and lifecycle',async t=>{
 t.mock.method(Date,'now',()=>LIVE_MARKET_AT);
 const mounts=[],stops=[],feeds=[],handlers=new Map();
 const scannerFactory=onChange=>createMarketScanner(onChange,{now:()=>LIVE_MARKET_AT/1000,subscribe:(request,callbacks)=>{
  feeds.push(request.market);handlers.set(request.market,callbacks);callbacks.onSnapshot(observedBars(request.market==='ETH/USDT'?500:0));callbacks.onStatus({state:'snapshot',asOf:LIVE_MARKET_AT});return ()=>stops.push(request.market);
 },subscribeDepth:(symbol,callbacks)=>{callbacks.onSnapshot(observedRow(symbol).depthSnapshot);return ()=>stops.push(symbol+':depth');}});
 const mountMarketCharts=host=>{mounts.push(host.innerHTML);return ()=>stops.push('chart');};
 const backgroundFactory=()=>({setActive(){},tick(){},dispose(){},refresh(){return false;}});
 await chartLifecycleFixture(async({ui,doc,context,event,settle})=>{
  doc.body.dataset.workbenchView='terminal';
  const current={...context,...liveContext('BTC'),tasks:[liveContext('BTC').task]};ui.update(current);await settle();
  assert.equal(mounts.length,1);assert.match(mounts[0],/data-trading-chart="workbench-live-BTC"/);assert.match(mounts[0],/BTC\/USDT/);assert.doesNotMatch(mounts[0],/paper|Synthetic market/);
  assert.match(ui.host.querySelector('.terminal-market-readout').innerHTML,/250\.00/);assert.match(ui.host.querySelector('.terminal-asks').innerHTML,/251\.00/);assert.match(ui.host.querySelector('.terminal-distribution-readout').innerHTML,/18/);assert.deepEqual(feeds,['BTC/USDT']);
  ui.host.querySelector('.terminal-chart-data').open=true;ui.update({...current,time:43});await settle();assert.match(ui.host.querySelector('.terminal-chart-data>div').innerHTML,/2026-11-17 00:00:00 UTC/);assert.doesNotMatch(ui.host.querySelector('.terminal-chart-data>div').innerHTML,/Synthetic|合成/);
  const other={...current,...liveContext('ETH'),tasks:[liveContext('ETH').task]};ui.update(other);await settle();assert.equal(mounts.length,2);assert.match(mounts[1],/ETH\/USDT/);assert.match(ui.host.querySelector('.terminal-market-readout').innerHTML,/750\.00/);assert.ok(stops.includes('BTC/USDT'));assert.ok(stops.includes('BTC:depth'));
  const before=ui.host.querySelector('.terminal-market-readout').innerHTML;handlers.get('BTC/USDT').onSnapshot(observedBars(9000));await settle();assert.equal(ui.host.querySelector('.terminal-market-readout').innerHTML,before,'a stopped asset cannot repaint the new asset');
  ui.update({...other,paused:true});await settle();assert.equal(ui.host.querySelector('.terminal-book-mid').innerHTML,'—');assert.match(ui.host.querySelector('.terminal-asks').innerHTML,/paused|暂停/);const pausedMounts=mounts.length;
  ui.update(other);await settle();assert.equal(mounts.length,pausedMounts+1);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(stops.at(-1),'ETH:depth');const hiddenMounts=mounts.length;ui.update(other);await settle();assert.equal(mounts.length,hiddenMounts);
  doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(mounts.length,hiddenMounts+1);
  event('pagehide',true);const cachedMounts=mounts.length;ui.update(other);await settle();assert.equal(mounts.length,cachedMounts);event('pageshow',true);await settle();assert.equal(mounts.length,cachedMounts+1);
 },{scannerFactory,mountMarketCharts,backgroundFactory});
});
