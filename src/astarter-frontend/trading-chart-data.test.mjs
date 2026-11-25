import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as chartCoverage from './trading-chart-data.mjs';
import {candleRequest,normalizeKlines,normalizeStreamCandle,mergeCandle,movingAverage,paperChartData,subscribeCandles,gridChartLevels,orderChartLevels,chartDraftConfig,chartWindowRestore} from './trading-chart-data.mjs';

const at=1_800_000_000_000;
const raw=(time=at,close='102')=>[time,'100','105','98',close,'12.5',time+59_999,'0',4,'0','0','0'];
test('analysis captures the visible closed candles with immutable market provenance',()=>{
 const bars=normalizeKlines(Array.from({length:10},(_,i)=>raw(at+i*60_000)),candleRequest({period:'1m'}));
 const now=at+599_999,status={state:'live',asOf:now},result=chartCoverage.captureMarketWindow({market:'BTC/USDT',period:'1m',venueId:'binance',profileId:'cex-spot'},bars,{from:1,to:9},status,now);
 assert.equal(result.bars.length,8);assert.equal(result.bars[0].time,at+60_000);assert.equal(result.bars.at(-1).time,at+480_000);
 assert.equal(result.period,'1m');assert.equal(result.market,'BTC/USDT');assert.equal(result.clockKind,'wall');assert.equal(result.provider,'Binance Spot');assert.equal(result.asOf,now);
 bars[1].close=104;status.asOf=0;assert.equal(result.bars[0].close,102);assert.equal(result.asOf,now);
});
test('analysis refuses stale, loading and unsupported market data rather than falling back to fixtures',()=>{
 const bars=normalizeKlines([raw()],candleRequest({period:'1m'})),config={market:'BTC/USDT',period:'1m'},now=at+120_000;
 for(const status of [{state:'loading',asOf:now},{state:'stale',asOf:now},{state:'live',asOf:now-31_000}])assert.throws(()=>chartCoverage.captureMarketWindow(config,bars,{from:0,to:1},status,now),/MARKET_NOT_READY/);
 assert.throws(()=>chartCoverage.captureMarketWindow({...config,venueId:'okx'},bars,{from:0,to:1},{state:'live',asOf:now},now),/MARKET_NOT_READY/);
});
test('recorded plan chart keeps recorded prices as a line and separates planned prices from fills',()=>{
 const input={id:'signal-1',version:'2',market:'BTC/USDT',clockKind:'historical',provider:'Astarter example',points:[{time:at/1000,value:100},{time:at/1000+60,value:102}],levels:[{kind:'planned-entry',price:101},{kind:'stop',price:95},{kind:'target',price:115}]};
 const result=chartCoverage.recordedChartSnapshot(input,'BTC/USDT');
 assert.equal(result.kind,'line');assert.deepEqual(result.data,[{time:at/1000,close:100},{time:at/1000+60,close:102}]);assert.deepEqual(result.levels.map(l=>[l.kind,l.state]),[['planned-entry','plan'],['stop','plan'],['target','plan']]);
 input.levels[0].price=999;assert.equal(result.levels[0].price,101);
 assert.throws(()=>chartCoverage.recordedChartSnapshot(input,'ETH/USDT'),/INVALID_CHART_SNAPSHOT/);
 assert.throws(()=>chartCoverage.recordedChartSnapshot({...input,points:[input.points[0],input.points[0]]},input.market),/INVALID_CHART_SNAPSHOT/);
 assert.throws(()=>chartCoverage.recordedChartSnapshot({...input,levels:[{kind:'buy-order',price:100}]},input.market),/INVALID_CHART_SNAPSHOT/);
});
test('chart windows preserve empty margins on the same candles and actual dates after the feed rolls forward',()=>{
 const bars=[{time:100},{time:200},{time:300}],saved={from:100,to:300,logical:{from:-5,to:4},first:100,last:300};
 assert.deepEqual(chartWindowRestore(saved,bars),{kind:'logical',range:{from:-5,to:4}});
 assert.deepEqual(chartWindowRestore(saved,[{time:200},{time:300},{time:400}]),{kind:'time',range:{from:100,to:300}});
 assert.equal(chartWindowRestore({...saved,from:NaN},bars),null);assert.equal(chartWindowRestore(saved,[]),null);
});
test('hidden chart resizes cannot replace the saved window and showing it preserves user zoom',()=>{
 const source=readFileSync(new URL('./trading-chart.mjs',import.meta.url),'utf8');
 const windowCode=source.slice(source.indexOf(' const windowKey='),source.indexOf(' try{if(config.gridPlan)'));
 const labelCode=source.slice(source.indexOf(' function queueLabels(){'),source.indexOf(' const format=formatTradingPrice;'));
 const visibleCode=source.slice(source.indexOf(' function setVisible('),source.indexOf(' function skin(){'));
 const resizeCode=source.slice(source.indexOf(' const sizeObserver='),source.indexOf(' const cleanup=()=>{rememberWindow();'));
 const bars=[{time:100},{time:200},{time:300}],saved={from:100,to:300,logical:{from:-5,to:4},first:100,last:300};
 const preferences=new Map([['test',{windows:{'market:1H':saved}}]]),stage={clientWidth:0,clientHeight:0};
 let frame,resize,logical={from:-900,to:4},restores=0;
 const timeScale={getVisibleRange:()=>({from:100,to:300}),getVisibleLogicalRange:()=>logical,width:()=>stage.clientWidth,setVisibleLogicalRange(range){logical={...range};restores++;}};
 const context={stage,preferences,config:{preferenceKey:'test'},mode:'market',displayedPeriod:'1H',stopped:false,chart:{timeScale:()=>timeScale},bars,chartWindowRestore,
  remember:patch=>preferences.set('test',{...preferences.get('test'),...patch}),labelFrame:0,requestAnimationFrame:callback=>{frame=callback;return 1;},drawAnalysis(){},levels:()=>[],labelLayer:{style:{},replaceChildren(){}},ResizeObserver:class{constructor(callback){resize=callback;}observe(){}}};
 runInNewContext(windowCode+labelCode+visibleCode+resizeCode+';globalThis.save=rememberWindow;',context);
 context.save();assert.equal(preferences.get('test').windows['market:1H'],saved);
 resize();frame();assert.equal(restores,0,'zero-size panes must not restore a distorted range');
 stage.clientWidth=320;stage.clientHeight=300;resize();context.save();assert.equal(preferences.get('test').windows['market:1H'],saved);frame();assert.deepEqual(logical,saved.logical);
 logical={from:-2,to:2};context.save();
 stage.clientWidth=0;stage.clientHeight=0;resize();logical={from:-900,to:2};context.save();frame();
 stage.clientWidth=1182;stage.clientHeight=500;resize();frame();assert.deepEqual(logical,{from:-2,to:2});
 const before=restores;stage.clientWidth=600;resize();frame();assert.equal(restores,before,'normal visible resizing must not reset user zoom');
});
test('candle identity rejects unsupported venues, instrument types and invalid inputs',()=>{
 assert.equal(candleRequest({market:'BTC/USDT',period:'1H'}).symbol,'BTCUSDT');
 assert.equal(candleRequest({market:'SOL/USDT',period:'15m'}).seconds,900);
 for(const input of [{venueId:'okx'},{profileId:'cex-perp'},{profileId:'dex-spot'},{market:'WETH/USDC'},{market:'BTC/USDT?x=1'},{period:'1M'}])assert.equal(candleRequest(input),null);
 const pancake=candleRequest({market:'BTC/USDT',period:'1H',profileId:'dex-spot',venueId:'pancakeswap'});
 assert.equal(pancake.symbol,'BTCUSDT');assert.equal(pancake.venueId,'pancakeswap');assert.equal(pancake.profileId,'dex-spot');assert.equal(pancake.reference,true);
 assert.equal(candleRequest({market:'ETH/USDT',period:'15m',profileId:'dex-spot',venueId:'pancakeswap'}).symbol,'ETHUSDT');
 assert.equal(candleRequest({market:'SOL/USDT',profileId:'dex-spot',venueId:'pancakeswap'}),null);
 assert.equal(candleRequest({market:'BTC/USDT',profileId:'cex-spot',venueId:'pancakeswap'}).profileId,'dex-spot');
});
test('public daily markets use the local feed and never become Binance capture or websocket requests',async()=>{
 const config={market:'US10Y',period:'1D',profileId:'public-market',venueId:'yahoo'},request=candleRequest(config);
 assert.equal(request.unit,'%');assert.equal(request.sessionBased,true);
 assert.equal(candleRequest({...config,period:'1H'}),null);assert.equal(candleRequest({...config,venueId:'binance'}),null);
 const bars=[{time:at/1000-86400,open:4.8,high:4.9,low:4.7,close:4.85,volume:null,closedAt:at/1000}];
 assert.throws(()=>chartCoverage.captureMarketWindow(config,bars,{from:0,to:1},{state:'snapshot',asOf:at},at),/MARKET_NOT_READY/);
 let requested,signal,finish;const states=[];
 const stop=subscribeCandles(request,{onStatus:s=>states.push(s.state)}, {
  fetchImpl:(url,options)=>{requested=url;signal=options.signal;return new Promise(resolve=>{finish=resolve;});},
  WebSocketImpl:class{constructor(){assert.fail('public-market cannot open a Binance stream');}},setTimer:()=>0,clearTimer:()=>{}
 });
 assert.equal(requested,'/api/market-hub?resource=cross-candles&symbol=US10Y');stop();assert.equal(signal.aborted,true);
 finish({ok:false});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(states,['loading']);
});
test('OHLCV retains source prices and seconds and refuses malformed, duplicate or incomplete bars',()=>{
 const req=candleRequest({period:'1m'}),bars=normalizeKlines([raw(),raw(at+60_000)],req);
 assert.deepEqual(bars[0],{time:at/1000,open:100,high:105,low:98,close:102,volume:12.5});
 for(const body of [[],[raw(),raw()],[raw(at+60_000),raw()],[raw(at+1)],[raw(at,'106')],[[at,'','105','98','102','12.5',at+59_999]]])assert.throws(()=>normalizeKlines(body,req));
 const negativeVolume=raw();negativeVolume[5]='-1';assert.throws(()=>normalizeKlines([negativeVolume],req));
 for(const invalid of [true,[],{},'   ']){const row=raw();row[1]=invalid;assert.throws(()=>normalizeKlines([row],req));}
});
test('stream updates respect source identity, candle boundaries and history continuity',()=>{
 const req=candleRequest({period:'1m'}),bar=normalizeKlines([raw()],req)[0];
 const event={e:'kline',E:at+10_000,s:'BTCUSDT',k:{s:'BTCUSDT',i:'1m',t:at,T:at+59_999,o:'100',h:'105',l:'98',c:'103',v:'13'}};
 assert.equal(normalizeStreamCandle(event,req).bar.close,103);
 assert.throws(()=>normalizeStreamCandle({...event,s:'ETHUSDT'},req));
 assert.throws(()=>normalizeStreamCandle({...event,k:{...event.k,i:'5m'}},req));
 assert.equal(mergeCandle([bar],{...bar,close:104},60)[0].close,104);
 assert.equal(mergeCandle([bar],{...bar,time:bar.time+60},60).length,2);
 assert.throws(()=>mergeCandle([bar],{...bar,time:bar.time+120},60));
 assert.equal(mergeCandle([bar],{...bar,time:bar.time-60},60)[0].time,bar.time);
});
test('moving averages wait for a full period and use close prices only',()=>{
 assert.deepEqual(movingAverage([{time:1,close:10},{time:2,close:20},{time:3,close:30}],2),[{time:2,value:15},{time:3,value:25}]);
 assert.deepEqual(movingAverage([{time:1,close:10}],20),[]);
});
test('paper playback uses deduplicated fills in this run and simulated time, never order status or wall time',()=>{
 const trade={session:{id:'r',market:'BTC/USDT',ticket:{stopLoss:90,takeProfit:120}},position:{runId:'r',market:'BTC/USDT',price:101},orders:[{id:'o',runId:'r',market:'BTC/USDT'},{id:'old',runId:'old',market:'BTC/USDT'},{id:'eth',runId:'r',market:'ETH/USDT'},{id:'unknown',runId:'r',market:'BTC/USDT',status:'unknown',price:999}],flow:{fills:[
  {id:'f1',orderId:'o',quantity:'0.2',price:'100',side:'buy',executedAt:4.2,recordedAt:Date.now()},
  {id:'f1',orderId:'o',quantity:'0.2',price:'100',side:'buy',executedAt:4.2},
  {id:'f2',orderId:'o',quantity:'0.1',price:'102',side:'buy',executedAt:4.8},
  {id:'f3',orderId:'o',quantity:'0.3',price:'110',side:'sell',executedAt:20},
  {id:'old',orderId:'old',quantity:'1',price:'900',side:'buy',executedAt:5},
  {id:'eth',orderId:'eth',quantity:'1',price:'900',side:'buy',executedAt:5},
  {id:'bad',orderId:'o',quantity:'-1',price:'100',side:'buy',executedAt:6}
 ]}};
 const before=JSON.stringify(trade),data=paperChartData(trade);
 assert.equal(data.fills.length,3);assert.equal(data.bars.length,2);
 assert.deepEqual(data.bars[0],{time:4,open:100,high:102,low:100,close:102,volume:.30000000000000004});
 assert.equal(data.bars[1].time,20);assert.deepEqual(data.levels.map(x=>x.kind),['entry','stop','target']);
 assert.equal(JSON.stringify(trade),before);
 assert.equal(paperChartData({...trade,session:{id:'other',market:'BTC/USDT'}}).fills.length,0);
});

class Socket{
 static all=[];
 constructor(url){this.url=url;this.listeners={};this.closed=false;Socket.all.push(this);}
 addEventListener(name,handler){this.listeners[name]=handler;}
 emit(name,data){this.listeners[name]?.(data);}
 close(){this.closed=true;}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function candleTimers(){
 const timers=new Map();let id=0;
 return {timers,setTimer:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimer:key=>timers.delete(key),run(delay){const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,`expected ${delay}ms timer`);timers.delete(entry[0]);entry[1].fn();}};
}
for(const hang of ['fetch','body'])test(`candle ${hang} deadline leaves loading and retries without accepting the late attempt`,async t=>{
 const clock=candleTimers(),states=[],snapshots=[],signals=[];let finish,requests=0,lateBodyReads=0;
 const response=()=>({ok:true,json:async()=>({body:[raw()],receivedAt:at+10_000})});
 const stop=subscribeCandles(candleRequest({period:'1m'}),{onSnapshot:b=>snapshots.push(b),onStatus:s=>states.push(s.state)},
  {...clock,now:()=>at+12_000,WebSocketImpl:null,fetchImpl:(_,options)=>{signals.push(options.signal);requests++;if(requests>1)return Promise.resolve(response());return hang==='fetch'?new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>{lateBodyReads++;return {body:[raw(at-60_000)],receivedAt:at};}});}):Promise.resolve({ok:true,json:()=>new Promise(resolve=>{finish=()=>resolve({body:[raw(at-60_000)],receivedAt:at});})});}});
 t.after(stop);await settle();assert.equal(states.at(-1),'loading');
 clock.run(8000);await settle();assert.equal(signals[0].aborted,true);assert.equal(states.at(-1),'error');assert.equal(snapshots.length,0);
 clock.run(3000);await settle();assert.equal(requests,2);assert.equal(states.at(-1),'snapshot');assert.equal(snapshots.length,1);assert.equal(snapshots[0][0].time,at/1000);
 const before=states.length;finish();await settle();assert.equal(snapshots.length,1);assert.equal(states.length,before);assert.equal(lateBodyReads,0,'timed-out fetch must not start reading its late body');
 stop();assert.equal(clock.timers.size,0);
});
test('candle body cancellation releases deadlines and a resumed asset owns its own snapshot',async t=>{
 const oldClock=candleTimers(),newClock=candleTimers(),states=[],snapshots=[];let finish,signal;
 const stop=subscribeCandles(candleRequest({period:'1m'}),{onSnapshot:b=>snapshots.push(['BTC',b]),onStatus:s=>states.push(['BTC',s.state])},
  {...oldClock,now:()=>at+12_000,WebSocketImpl:null,fetchImpl:(_,options)=>{signal=options.signal;return Promise.resolve({ok:true,json:()=>new Promise(resolve=>{finish=resolve;})});}});
 t.after(stop);await settle();stop();assert.equal(signal.aborted,true);assert.equal(oldClock.timers.size,0);
 const resumed=subscribeCandles(candleRequest({market:'ETH/USDT',period:'1m'}),{onSnapshot:b=>snapshots.push(['ETH',b]),onStatus:s=>states.push(['ETH',s.state])},
  {...newClock,now:()=>at+12_000,WebSocketImpl:null,fetchImpl:async()=>({ok:true,json:async()=>({body:[raw()],receivedAt:at+10_000})})});
 t.after(resumed);await settle();const before=states.length;finish({body:[raw()],receivedAt:at});await settle();
 assert.deepEqual(snapshots.map(([symbol])=>symbol),['ETH']);assert.equal(states.length,before);resumed();assert.equal(newClock.timers.size,0);
});
test('candle refresh timeout marks retained history stale and keeps bounded recovery backoff',async t=>{
 const clock=candleTimers(),states=[],snapshots=[];let calls=0;
 const stop=subscribeCandles(candleRequest({period:'1m'}),{onSnapshot:b=>snapshots.push(b),onStatus:s=>states.push(s.state)},
  {...clock,now:()=>at+12_000,WebSocketImpl:null,fetchImpl:()=>++calls===1?Promise.resolve({ok:true,json:async()=>({body:[raw()],receivedAt:at+10_000})}):new Promise(()=>{})});
 t.after(stop);await settle();clock.run(10000);clock.run(8000);await settle();assert.equal(states.at(-1),'stale');assert.equal(snapshots.length,1);
 clock.run(3000);clock.run(8000);await settle();assert.equal(states.at(-1),'stale');assert.ok([...clock.timers.values()].some(timer=>timer.delay===6000));
 stop();assert.equal(clock.timers.size,0);
});
test('stopping candles from a refresh status cannot dispatch another request',async t=>{
 const clock=candleTimers();let calls=0,stop;
 stop=subscribeCandles(candleRequest({period:'1m'}),{onStatus:s=>{if(s.state==='reconnecting')stop();}},
  {...clock,now:()=>at+12_000,WebSocketImpl:null,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({body:[raw()],receivedAt:at+10_000})};}});
 t.after(stop);await settle();clock.run(10000);await settle();assert.equal(calls,1);assert.equal(clock.timers.size,0);
});
test('grid price overlays reproduce the stated range and spacing without creating orders',()=>{
 const input={lower:70000,upper:77000,count:15,referencePrice:75875.05},before=JSON.stringify(input),levels=gridChartLevels(input);
 assert.equal(levels.length,16);assert.equal(levels[0].price,70000);assert.equal(levels.at(-1).price,77000);
 assert.equal(levels.find(x=>Math.abs(x.price-75600)<.001).kind,'grid-buy');
 assert.equal(levels.find(x=>Math.abs(x.price-76533.333333)<.001).kind,'grid-sell');
 assert.ok(levels.every(x=>x.state==='plan'));assert.equal(JSON.stringify(input),before);
 const geometric=gridChartLevels({lower:100,upper:400,count:2,referencePrice:220,mode:'geometric'});assert.equal(geometric[1].price,200);
 for(const input of [{lower:0,upper:100,count:15},{lower:200,upper:100,count:15},{lower:100,upper:200,count:1},{lower:100,upper:200,count:101},{lower:100,upper:200,count:3.2},{lower:100,upper:200,count:10,mode:'martingale'}])assert.throws(()=>gridChartLevels({referencePrice:150,...input}));
});
test('pending order overlays retain unknown status and remaining quantity, scoped to the current run',()=>{
 const trade={session:{id:'run',market:'BTC/USDT'},orders:[{id:'buy',runId:'run',market:'BTC/USDT',side:'buy',price:100,qty:2,filled:.25,status:'partial'},{id:'unknown',runId:'run',market:'BTC/USDT',side:'sell',price:105,qty:1,filled:0,status:'unknown'},{id:'old',runId:'old',market:'BTC/USDT',side:'buy',price:99,qty:2,filled:0,status:'submitted'},{id:'done',runId:'run',market:'BTC/USDT',side:'buy',price:99,qty:2,filled:1,status:'filled'}]};
 const result=orderChartLevels(trade);assert.equal(result.length,2);assert.equal(result[0].quantity,1.5);assert.equal(result[1].state,'unknown');assert.equal(orderChartLevels({...trade,session:null}).length,0);
});
test('subscription emits validated history, uses incremental bars, and releases requests, timers and socket',async()=>{
 Socket.all=[];const snapshots=[],updates=[],states=[];let requests=0;
 const req=candleRequest({period:'1m'});
 const stop=subscribeCandles(req,{onSnapshot:x=>snapshots.push(x),onBar:x=>updates.push(x),onStatus:x=>states.push(x)},{now:()=>at+12_000,fetchImpl:async()=>{requests++;return {ok:true,json:async()=>({body:[raw()],receivedAt:at+10_000})};},WebSocketImpl:Socket});
 await settle();assert.equal(snapshots.length,1);const ws=Socket.all[0];
 ws.emit('message',{data:JSON.stringify({e:'kline',E:at+12_000,s:'BTCUSDT',k:{s:'BTCUSDT',i:'1m',t:at,T:at+59_999,o:'100',h:'105',l:'98',c:'103',v:'13'}})});
 assert.equal(updates.length,1);assert.equal(updates[0].close,103);assert.equal(requests,1);assert.equal(states.at(-1).state,'live');
 stop();assert.equal(ws.closed,true);
 ws.emit('message',{data:JSON.stringify({})});assert.equal(updates.length,1);
});
test('unmounted or switched subscriptions cannot publish late responses',async()=>{
 let finish,signal;const seen=[];
 const stop=subscribeCandles(candleRequest({period:'1m'}),{onSnapshot:x=>seen.push(x),onStatus:()=>{}},{fetchImpl:(_,opts)=>{signal=opts.signal;return new Promise(resolve=>finish=resolve);},WebSocketImpl:Socket});
 stop();finish({ok:true,json:async()=>({body:[raw()],receivedAt:at})});await settle();assert.equal(signal.aborted,true);assert.deepEqual(seen,[]);
});
test('read failures remain unavailable and may be retried without placing trades',async()=>{
 const states=[],delays=[];let retry;
 const stop=subscribeCandles(candleRequest({period:'1m'}),{onStatus:x=>states.push(x)},{fetchImpl:async()=>({ok:false,status:429,headers:{get:()=> '12'}}),WebSocketImpl:Socket,setTimer:(fn,delay)=>{delays.push(delay);retry=fn;return 1;},clearTimer:()=>{}});
 await settle();assert.equal(states.at(-1).state,'error');assert.equal(typeof retry,'function');assert.ok(delays.at(-1)>=12_000);stop();
});

test('a stream gap closes the old socket and refetches contiguous history before becoming live',async()=>{
 Socket.all=[];let calls=0,id=0,clock=at+130_000;const timers=new Map(),snapshots=[],updates=[],states=[];
 const stop=subscribeCandles(candleRequest({period:'1m'}),{onSnapshot:b=>snapshots.push(b),onBar:b=>updates.push(b),onStatus:s=>states.push(s.state)},
  {now:()=>clock,fetchImpl:async()=>({ok:true,json:async()=>({body:++calls===1?[raw(at+60_000)]:[raw(at+60_000),raw(at+120_000),raw(at+180_000)],receivedAt:clock})}),WebSocketImpl:Socket,setTimer:(fn,delay)=>{const key=++id;timers.set(key,{fn:()=>{timers.delete(key);fn();},delay});return key;},clearTimer:key=>timers.delete(key)});
 await settle();const ws=Socket.all[0];
 ws.emit('message',{data:JSON.stringify({e:'kline',E:at+180_001,s:'BTCUSDT',k:{s:'BTCUSDT',i:'1m',t:at+180_000,T:at+239_999,o:'100',h:'105',l:'98',c:'103',v:'13'}})});
 assert.equal(ws.closed,true);assert.equal(updates.length,0);assert.equal(states.at(-1),'reconnecting');
 const retry=[...timers.values()].find(t=>t.delay===2000);assert.ok(retry);retry.fn();await settle();
 // The deliberately future response cannot be relabelled as a fresh snapshot.
 assert.equal(snapshots.length,1);assert.equal(states.at(-1),'stale');
 clock=at+200_000;[...timers.values()][0].fn();await settle();assert.equal(snapshots.length,2);assert.equal(Socket.all.length,2);stop();assert.equal(timers.size,0);
});


test('draft overlays require a complete market and plan identity without editing the caller draft',()=>{
 const input={identity:{accountId:'SIM-01',connectionId:'C1',venueId:'binance',profileId:'cex-spot',marketType:'SPOT',environment:'DEMO',market:'BTC/USDT',instrumentId:'binance:SPOT:BTC/USDT',clockKind:'market'},planRef:{id:'D1',version:2},period:'1H',gridPlan:{lower:'70000',upper:'77000',count:'15',mode:'arithmetic'}},before=JSON.stringify(input),config=chartDraftConfig(input);
 assert.equal(config.gridPlan.count,15);assert.equal(config.gridPlan.lower,70000);assert.equal(config.planRef.version,2);assert.equal(JSON.stringify(input),before);
 for(const invalid of [{...input,identity:{...input.identity,accountId:''}},{...input,identity:{...input.identity,market:'ETH/USDT'}},{...input,identity:{...input.identity,clockKind:'elapsed'}},{...input,identity:{...input.identity,marketType:'PERPETUAL'}},{...input,planRef:{id:'D1',version:NaN}},{...input,gridPlan:{...input.gridPlan,lower:true}},{...input,gridPlan:{...input.gridPlan,lower:80000}}])assert.throws(()=>chartDraftConfig(invalid));
 const other=chartDraftConfig({...input,identity:{...input.identity,venueId:'okx',instrumentId:'okx:SPOT:BTC/USDT'}});assert.equal(candleRequest(other),null);
});
test('chart layers reject another account or instrument even when run IDs and asset symbols collide',()=>{
 const order={id:'O1',runId:'R1',accountId:'SIM-01',environment:'DEMO',market:'BTC/USDT',instrumentId:'binance:SPOT:BTC/USDT',venueId:'binance',marketType:'SPOT',status:'partial',side:'buy',price:100,qty:1,filled:.5};
 const trade={session:{id:'R1',accountId:'SIM-01',market:'BTC/USDT',ticket:{stopLoss:90,takeProfit:120}},orders:[order,{...order,id:'O2',accountId:'SIM-02'}],flow:{fills:[{id:'F1',orderId:'O1',accountId:'SIM-01',instrumentId:order.instrumentId,side:'buy',price:100,quantity:.5,executedAt:1},{id:'F2',orderId:'O2',accountId:'SIM-02',instrumentId:order.instrumentId,side:'buy',price:100,quantity:.5,executedAt:1}]}};
 const scope={runId:'R1',accountId:'SIM-01',environment:'DEMO',instrumentId:order.instrumentId,venueId:'binance',marketType:'SPOT'};
 assert.equal(orderChartLevels(trade,scope).length,1);assert.equal(paperChartData(trade,scope).fills.length,1);assert.equal(paperChartData(trade,{...scope,accountId:'SIM-03'}).fills.length,0);assert.equal(paperChartData(trade,{...scope,accountId:'SIM-03'}).levels.length,0);assert.equal(orderChartLevels(trade,{...scope,instrumentId:'okx:SPOT:BTC/USDT'}).length,0);
});
test('a chart cannot retain fills, pending lines or protection from another connection or environment',()=>{
 const identity={runId:'R1',accountId:'SIM-01',environment:'DEMO',market:'BTC/USDT',instrumentId:'binance:SPOT:BTC/USDT',venueId:'binance',marketType:'SPOT',profileId:'cex-spot',connectionId:'C1'};
 const order={...identity,id:'O1',status:'partial',side:'buy',price:100,qty:1,filled:.5};
 const trade={session:{...identity,id:'R1',ticket:{...identity,stopLoss:90,takeProfit:120}},orders:[order],flow:{fills:[{id:'F1',orderId:'O1',accountId:'SIM-01',instrumentId:identity.instrumentId,side:'buy',price:100,quantity:.5,executedAt:1}]}},before=JSON.stringify(trade);
 assert.equal(orderChartLevels(trade,identity).length,1);assert.equal(paperChartData(trade,identity).fills.length,1);assert.equal(paperChartData(trade,identity).levels.length,2);
 for(const patch of [{connectionId:'C2'},{environment:'LIVE'},{instrumentId:'okx:SPOT:BTC/USDT',venueId:'okx'}]){
  const scope={...identity,...patch},paper=paperChartData(trade,scope);
  assert.deepEqual(orderChartLevels(trade,scope),[]);assert.deepEqual(paper.fills,[]);assert.deepEqual(paper.bars,[]);assert.deepEqual(paper.levels,[]);
 }
 assert.equal(JSON.stringify(trade),before);
});


test('technical study derives weighted mean and range from closed OHLCV, ignoring the live candle',()=>{
 const bars=Array.from({length:24},(_,i)=>({time:i*60,open:100+i,high:102+i,low:99+i,close:101+i,volume:i+1})),before=structuredClone(bars),study=chartCoverage.candleTechnicalStudy(bars,{seconds:60,now:23*60});
 const tail=bars.slice(3,23),expected=tail.reduce((sum,b)=>sum+(b.high+b.low+b.close)/3*b.volume,0)/tail.reduce((sum,b)=>sum+b.volume,0);
 assert.equal(study.bars.length,23);assert.ok(Math.abs(study.lines.find(line=>line.key==='vwap').points.at(-1).value-expected)<1e-10);
 const low=study.lines.find(line=>line.key==='range-low');assert.deepEqual(low.points,[{time:180,value:102},{time:1320,value:102}]);
 assert.ok(!study.lines.find(line=>line.key==='range-high'),'a latest-bar extreme has no fabricated horizontal extension');
 bars[23].high=99999;assert.deepEqual(chartCoverage.candleTechnicalStudy(bars,{seconds:60,now:1380}),study);bars[23]=before[23];assert.deepEqual(bars,before);
});
test('swing lines require two actual confirmed pivots and never project past them',()=>{
 const closes=[10,11,15,12,10,8,10,12,17,13,10,7,10,11],bars=closes.map((v,i)=>({time:i*60,open:v,high:v+1,low:v-1,close:v,volume:10}));
 const study=chartCoverage.candleTechnicalStudy(bars,{seconds:60,now:840});
 assert.deepEqual(study.pivots.high.map(p=>[p.time,p.value,p.confirmedAt]),[[120,16,300],[480,18,660]]);
 assert.deepEqual(study.lines.find(line=>line.key==='swing-high').points,study.pivots.high);
 assert.equal(study.lines.find(line=>line.key==='swing-low').points.at(-1).time,660);
 assert.ok(!chartCoverage.candleTechnicalStudy(bars,{seconds:60,now:600}).lines.some(line=>line.key==='swing-high'));
});
test('technical layers omit missing, invalid, insufficient or zero-volume calculations',()=>{
 const bars=Array.from({length:24},(_,i)=>({time:i*60,open:100,high:102,low:98,close:101,volume:0})),run=data=>chartCoverage.candleTechnicalStudy(data,{seconds:60,now:1440});
 assert.ok(!run(bars).lines.some(line=>line.key==='vwap'));assert.equal(run(bars.slice(0,2)).lines.length,0);
 assert.equal(run(bars.filter((_,i)=>i!==7)).lines.length,0);
 assert.equal(run(bars.map((bar,i)=>i===10?{...bar,low:110}:bar)).lines.length,0);
 assert.equal(run([...bars].reverse()).lines.length,0);
 assert.equal(chartCoverage.candleTechnicalStudy(bars,{seconds:0}).lines.length,0);
});


test('analysis layer is opt-in and removed on same-host disposal and remount',async()=>{
 const {tradingChartPanel,mountTradingCharts}=await import('./trading-chart.mjs');
 assert.ok(!tradingChartPanel('default-layer').includes('trading-analysis-key'));
 assert.ok(tradingChartPanel('opt-layer',{analysisLayers:true}).includes('trading-analysis-key'));
 const previous={document:globalThis.document,MutationObserver:globalThis.MutationObserver,ResizeObserver:globalThis.ResizeObserver,cancelAnimationFrame:globalThis.cancelAnimationFrame},layers=new Set();
 const node={hidden:true,addEventListener(){},setAttribute(){},textContent:'',after(layer){layers.add(layer);}},host={dataset:{tradingChart:'opt-layer'},parentElement:null,isConnected:false,clientWidth:600,clientHeight:300,addEventListener(){},setAttribute(){},querySelector(){return node;}},root={querySelectorAll:()=>[host]};
 let cleanup;
 try{
  globalThis.document={documentElement:{},addEventListener(){},createElementNS(){const layer={classList:{add(){}},setAttribute(){},remove(){layers.delete(layer);}};return layer;}};
  globalThis.MutationObserver=class{observe(){}disconnect(){}};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.cancelAnimationFrame=()=>{};
  cleanup=mountTradingCharts(root);assert.equal(layers.size,1);cleanup();assert.equal(layers.size,0);
  cleanup=mountTradingCharts(root);assert.equal(layers.size,1);cleanup();cleanup=null;assert.equal(layers.size,0);
 }finally{cleanup?.();for(const[key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('a failed candle read cancels its unread body, even when cancelling fails, and keeps the Retry-After delay',async t=>{
 for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  const clock=candleTimers(),states=[];let cancels=0;
  const stop=subscribeCandles(candleRequest({period:'1m'}),{onStatus:s=>states.push(s.state)},
   {...clock,now:()=>at+12_000,WebSocketImpl:null,fetchImpl:async()=>({ok:false,status:503,headers:{get:key=>key==='Retry-After'?'12':null},body:{cancel(){cancels++;return cancel();}},json:async()=>{throw Error('must not parse error');}})});
  t.after(stop);await settle();
  assert.equal(cancels,1);assert.equal(states.at(-1),'error');assert.deepEqual([...clock.timers.values()].map(timer=>timer.delay),[12_000]);
  stop();await settle();assert.equal(clock.timers.size,0);
 }
});

import {ORDER_MARKETS,marketLabel} from './order-markets.mjs';
import {executionRunIdentity} from './execution-stream.mjs';
import {hostedChartSymbol} from './tradingview-widget.mjs';
import {tradingChartPanel} from './trading-chart.mjs';
import {hubCandleIdentity} from './market-hub.mjs';
import {HUB_ASSET_IDS} from './market-hub-data.mjs';
import {validateDerivativeBody} from './public-market-extended.mjs';
// U3 mapping pins: one base asset as a spot and as a perpetual market, read through the order profile, the run identity, the chart and the data center.
const u3Identity=(profileId,marketType,instrumentId,patch={})=>({accountId:'SIM-01',connectionId:'C1',venueId:'binance',profileId,marketType,environment:'DEMO',market:'BTC/USDT',instrumentId,clockKind:'market',...patch});
const u3Draft=identity=>({identity,planRef:{id:'U3-PLAN',version:1},period:'1H'});
const u3Market=({market,profileId,venueId,period='1H'})=>({market,profileId,venueId,period});
const u3Label=html=>html.match(/<strong>[^<]*<\/strong><span>([^<]*)<\/span>/)?.[1];
test('U3: one base asset as spot and as perpetual keeps one market type, instrument and venue across the order profile, the run identity and the chart draft, and only the spot market gets candles or a hosted chart',()=>{
 const spot=u3Identity('cex-spot','SPOT','binance:SPOT:BTC/USDT'),perp=u3Identity('cex-perp','PERPETUAL','binance:PERPETUAL:BTC/USDT');
 assert.deepEqual([ORDER_MARKETS['cex-spot'].venueId,ORDER_MARKETS['cex-spot'].marketType,marketLabel(ORDER_MARKETS['cex-spot'])],['binance','SPOT','Binance · CEX SPOT']);
 assert.deepEqual([ORDER_MARKETS['cex-perp'].venueId,ORDER_MARKETS['cex-perp'].marketType,marketLabel(ORDER_MARKETS['cex-perp'])],['binance','PERPETUAL','Binance · CEX PERP']);
 const configs={};
 for(const identity of [spot,perp]){
  const profile=ORDER_MARKETS[identity.profileId],run=executionRunIdentity({session:{id:'U3-'+identity.profileId,market:'BTC/USDT',ticket:{profileId:identity.profileId,venueId:identity.venueId}}});
  assert.deepEqual([run.profileId,run.venueId,run.marketType,run.market],[identity.profileId,profile.venueId,profile.marketType,'BTC/USDT']);
  const config=configs[identity.profileId]=chartDraftConfig(u3Draft(identity));
  assert.deepEqual([config.profileId,config.venueId,config.market,config.identity.marketType,config.identity.instrumentId],[identity.profileId,profile.venueId,'BTC/USDT',profile.marketType,identity.instrumentId]);
 }
 // A spot profile never carries a perpetual type or instrument, and the reverse.
 for(const crossed of [{...spot,marketType:'PERPETUAL'},{...spot,instrumentId:perp.instrumentId},{...spot,profileId:'cex-perp'},{...perp,marketType:'SPOT'},{...perp,instrumentId:spot.instrumentId},{...perp,profileId:'cex-spot'}])
  assert.throws(()=>chartDraftConfig(u3Draft(crossed)),{code:'IDENTITY_MISMATCH'},JSON.stringify(crossed));
 // Only the spot market has a candle feed and a hosted chart; the perpetual one never borrows the spot symbol or the spot label.
 const feed=candleRequest(u3Market(configs['cex-spot']));
 assert.deepEqual([feed.market,feed.symbol,feed.venueId,feed.profileId],['BTC/USDT','BTCUSDT','binance','cex-spot']);
 assert.equal(candleRequest(u3Market(configs['cex-perp'])),null);
 assert.equal(hostedChartSymbol({...u3Market(configs['cex-spot']),hostedMarket:true}),'BINANCE:BTCUSDT');
 assert.equal(hostedChartSymbol({...u3Market(configs['cex-perp']),hostedMarket:true}),null);
 const spotPanel=tradingChartPanel('u3-spot',u3Market(configs['cex-spot'])),hostedPanel=tradingChartPanel('u3-spot-hosted',{...u3Market(configs['cex-spot']),hostedMarket:true}),perpPanel=tradingChartPanel('u3-perp',{...u3Market(configs['cex-perp']),hostedMarket:true});
 assert.match(u3Label(spotPanel),/^Binance · (?:现货|Spot)$/);
 assert.match(u3Label(hostedPanel),/^Binance · (?:现货|Spot) · /);assert.match(hostedPanel,/symbol=BINANCE%3ABTCUSDT/);
 assert.doesNotMatch(perpPanel,/trading-chart-hosted|BINANCE%3A|BINANCE:/);
 assert.doesNotMatch(u3Label(perpPanel),/现货|Spot/);assert.match(u3Label(perpPanel),/^binance\b/i);
});
test('U3: a chart draft or hosted chart with an unknown or unstated market type, and a candle feed with an unknown type, an empty venue or no quote currency, is refused, never read as Binance spot',()=>{
 const spot=u3Identity('cex-spot','SPOT','binance:SPOT:BTC/USDT');
 for(const [patch,code] of [[{profileId:'cex-option'},'IDENTITY_MISMATCH'],[{profileId:undefined},'IDENTITY_MISMATCH'],[{marketType:undefined},'IDENTITY_MISMATCH'],[{marketType:'FUTURES',instrumentId:'binance:FUTURES:BTC/USDT'},'IDENTITY_MISMATCH'],[{instrumentId:'binance:BTC/USDT'},'IDENTITY_MISMATCH'],[{venueId:''},'INVALID_IDENTITY'],[{venueId:undefined},'INVALID_IDENTITY'],[{market:'',instrumentId:'binance:SPOT:'},'INVALID_IDENTITY']])
  assert.throws(()=>chartDraftConfig(u3Draft({...spot,...patch})),{code},JSON.stringify(patch));
 const market={market:'BTC/USDT',period:'1H',profileId:'cex-spot',venueId:'binance'};
 for(const patch of [{profileId:'cex-option'},{profileId:'dex-perp',venueId:'hyperliquid'},{venueId:''},{venueId:null},{market:'BTC'},{market:'BTC/'},{market:'BTCUSDT'},{market:'BTC-USDT-SWAP'}]){
  assert.equal(candleRequest({...market,...patch}),null,JSON.stringify(patch));
  assert.equal(hostedChartSymbol({...market,...patch,hostedMarket:true}),null,JSON.stringify(patch));
 }
 for(const key of ['market','profileId','venueId']){const unstated={...market,hostedMarket:true};delete unstated[key];assert.equal(hostedChartSymbol(unstated),null,key);}
 const unknown=tradingChartPanel('u3-unknown-type',{...market,profileId:'cex-option',hostedMarket:true});
 assert.doesNotMatch(unknown,/trading-chart-hosted|BINANCE%3A/);assert.doesNotMatch(u3Label(unknown),/现货|Spot/);
});
test('U3: the data center keeps the BTC perpetual on its OKX swap instrument and every Markets chart on a Binance spot USDT pair, and the swap never reaches a chart',()=>{
 for(const [symbol,id] of Object.entries(HUB_ASSET_IDS)){
  const identity=hubCandleIdentity({id,symbol});
  assert.deepEqual(identity,{market:symbol+'/USDT',venueId:'binance',profileId:'cex-spot'},symbol);
  assert.equal(ORDER_MARKETS[identity.profileId].marketType,'SPOT');
  assert.equal(hostedChartSymbol({...identity,hostedMarket:true}),'BINANCE:'+symbol+'USDT');
 }
 const spot=hubCandleIdentity({id:'bitcoin',symbol:'BTC'});
 const body=instrument=>({source:'OKX',symbol:'BTC',view:'funding',instrument,rows:[{at:at-1000,value:0.0001}],current:null});
 assert.equal(validateDerivativeBody(body('BTC-USDT-SWAP'),'funding','BTC',at),true);
 for(const instrument of ['BTC-USDT',spot.market,'BTCUSDT',hostedChartSymbol({...spot,hostedMarket:true}),'ETH-USDT-SWAP',null])
  assert.equal(validateDerivativeBody(body(instrument),'funding','BTC',at),false,String(instrument));
 for(const config of [{...spot,market:'BTC-USDT-SWAP'},{...spot,profileId:'cex-perp'},{...spot,venueId:'okx'},{market:'BTC-USDT-SWAP',venueId:'okx',profileId:'cex-perp'}]){
  assert.equal(candleRequest({...config,period:'1H'}),null,JSON.stringify(config));
  assert.equal(hostedChartSymbol({...config,hostedMarket:true}),null,JSON.stringify(config));
 }
});
