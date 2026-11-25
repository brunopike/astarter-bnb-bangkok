import test from 'node:test';
import assert from 'node:assert/strict';
import {CROSS_MARKETS,crossMarketRequest,crossMarketPolicy,decodeDukascopy,normalizeCrossMarket,validateCrossSnapshot,subscribeCrossMarket,publicGoldSpotRequest,validateGoldSpot} from './cross-market-data.mjs';

test('gold spot uses the provider timestamp, one troy ounce in USD, and an independent refresh clock',()=>{
 const time=Date.parse('2026-11-18T19:32:25Z'),raw={name:'Gold',symbol:'XAU',currency:'USD',price:3724.83,updatedAt:'2026-11-18T19:32:23Z'};
 const spec=publicGoldSpotRequest(new URLSearchParams()),body=spec.decode([raw],time);
 assert.equal(spec.policy.url,'https://api.gold-api.com/price/XAU');
 assert.equal(spec.policy.interval,15000);
 assert.equal(body.asOf,time-2000);assert.equal(body.unit,'USD/troy oz');
 assert.equal(validateGoldSpot(body,time),true);
 for(const changed of [{symbol:'GC'},{currency:'EUR'},{price:0},{updatedAt:'2026-11-19T19:32:23Z'},{updatedAt:'unknown'}]){
  assert.throws(()=>spec.decode([{...raw,...changed}],time),/INVALID_GOLD_QUOTE/);
 }
 assert.equal(publicGoldSpotRequest(new URLSearchParams({asset:'BTC'})),null);
 assert.equal(new URL(crossMarketPolicy('XAU',time).urls[1]).searchParams.get('from'),String(Date.parse('2026-11-18T19:00:00Z')));
 assert.equal(spec.decode([raw],time+86400000).asOf,body.asOf);
});
const at=Date.parse('2026-11-07T12:00:00Z'),time=Date.parse('2026-11-06T14:30:00Z')/1000;
function yahoo(symbol='SPX'){
 const spec=CROSS_MARKETS[symbol];return {chart:{error:null,result:[{meta:{symbol:spec.id,instrumentType:'INDEX',exchangeTimezoneName:spec.timezone,regularMarketTime:time+23400,currentTradingPeriod:{regular:{start:time,end:time+23400}}},timestamp:[time],indicators:{quote:[{open:[4.874],high:[4.903],low:[4.814],close:[4.859],volume:[0]}]}}]}};
}
const gold={timestamp:Date.parse('2026-01-01T00:00:00Z'),shift:86400000,multiplier:.001,open:4323.698,high:4351.005,low:4323.198,close:4347.805,times:[0,1,2],opens:[0,24100,13077],highs:[0,30000,20000],lows:[0,24000,12000],closes:[0,8000,13000]};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function crossTimers(){
 const timers=new Map();let id=0;
 return {timers,setTimer:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimer:key=>timers.delete(key),run(delay){const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,`expected ${delay}ms timer`);timers.delete(entry[0]);entry[1].fn();}};
}
for(const hang of ['fetch','body'])test(`cross-market ${hang} deadline leaves loading and ignores the timed-out response after recovery`,async t=>{
 const request=crossMarketRequest({market:'SPX',period:'1D',profileId:'public-market',venueId:'yahoo'}),body=normalizeCrossMarket(yahoo(),'SPX',at),clock=crossTimers(),states=[],snapshots=[],signals=[];let finish,calls=0,lateBodyReads=0;
 const stop=subscribeCrossMarket(request,{onSnapshot:b=>snapshots.push(b),onStatus:s=>states.push(s.state)},
  {...clock,now:()=>at,fetchImpl:(_,options)=>{signals.push(options.signal);if(++calls>1)return Promise.resolve({ok:true,json:async()=>({body})});return hang==='fetch'?new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>{lateBodyReads++;return {body};}});}):Promise.resolve({ok:true,json:()=>new Promise(resolve=>{finish=()=>resolve({body});})});}});
 t.after(stop);await settle();clock.run(12000);await settle();assert.equal(signals[0].aborted,true);assert.equal(states.at(-1),'error');assert.equal(snapshots.length,0);
 clock.run(60000);await settle();assert.equal(calls,2);assert.equal(states.at(-1),'snapshot');assert.equal(snapshots.length,1);
 const before=states.length;finish();await settle();assert.equal(snapshots.length,1);assert.equal(states.length,before);assert.equal(lateBodyReads,0,'timed-out fetch must not read its late body');
 stop();assert.equal(clock.timers.size,0);
});
test('cross-market paused body cannot publish into a resumed asset subscription',async t=>{
 const clock=crossTimers(),resumedClock=crossTimers(),states=[],snapshots=[];let finish,signal;
 const request=symbol=>crossMarketRequest({market:symbol,period:'1D',profileId:'public-market',venueId:'yahoo'});
 const stop=subscribeCrossMarket(request('SPX'),{onSnapshot:b=>snapshots.push(['SPX',b]),onStatus:s=>states.push(['SPX',s.state])},
  {...clock,now:()=>at,fetchImpl:(_,options)=>{signal=options.signal;return Promise.resolve({ok:true,json:()=>new Promise(resolve=>{finish=resolve;})});}});
 t.after(stop);await settle();stop();assert.equal(signal.aborted,true);assert.equal(clock.timers.size,0);
 const resumed=subscribeCrossMarket(request('NDX'),{onSnapshot:b=>snapshots.push(['NDX',b]),onStatus:s=>states.push(['NDX',s.state])},
  {...resumedClock,now:()=>at,fetchImpl:async()=>({ok:true,json:async()=>({body:normalizeCrossMarket(yahoo('NDX'),'NDX',at)})})});
 t.after(resumed);await settle();const before=states.length;finish({body:normalizeCrossMarket(yahoo(),'SPX',at)});await settle();assert.deepEqual(snapshots.map(([symbol])=>symbol),['NDX']);assert.equal(states.length,before);resumed();assert.equal(resumedClock.timers.size,0);
});
test('cross-market refresh timeout preserves stale history and stops retries after cancellation',async t=>{
 const request=crossMarketRequest({market:'SPX',period:'1D',profileId:'public-market',venueId:'yahoo'}),clock=crossTimers(),states=[],snapshots=[];let calls=0;
 const stop=subscribeCrossMarket(request,{onSnapshot:b=>snapshots.push(b),onStatus:s=>states.push(s.state)},
  {...clock,now:()=>at,fetchImpl:()=>++calls===1?Promise.resolve({ok:true,json:async()=>({body:normalizeCrossMarket(yahoo(),'SPX',at)})}):new Promise(()=>{})});
 t.after(stop);await settle();clock.run(60000);clock.run(12000);await settle();assert.equal(states.at(-1),'stale');assert.equal(snapshots.length,1);assert.ok([...clock.timers.values()].some(timer=>timer.delay===60000));stop();assert.equal(clock.timers.size,0);
});
test('cross-market stops cleanly from refresh status and snapshot callbacks',async t=>{
 const request=crossMarketRequest({market:'SPX',period:'1D',profileId:'public-market',venueId:'yahoo'});
 for(const stopAt of ['refreshing','snapshot']){
  const clock=crossTimers(),states=[];let stop,calls=0;
  stop=subscribeCrossMarket(request,{onSnapshot:()=>{if(stopAt==='snapshot')stop();},onStatus:s=>{states.push(s.state);if(s.state===stopAt)stop();}},
   {...clock,now:()=>at,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({body:normalizeCrossMarket(yahoo(),'SPX',at)})};}});
  t.after(stop);await settle();if(stopAt==='refreshing'){clock.run(60000);await settle();assert.equal(calls,1);}else assert.deepEqual(states,['loading']);assert.equal(clock.timers.size,0);
 }
});
test('only exact market/profile/venue and daily source requests are enabled',()=>{
 for(const [symbol,spec] of Object.entries(CROSS_MARKETS))assert.equal(crossMarketRequest({market:symbol,period:'1D',profileId:'public-market',venueId:spec.venueId}).symbol,symbol);
 for(const bad of [{market:'SPY'},{period:'1H'},{profileId:'cex-spot'},{venueId:'binance'}])assert.equal(crossMarketRequest({market:'SPX',period:'1D',profileId:'public-market',venueId:'yahoo',...bad}),null);
 assert.equal(crossMarketPolicy('https://attacker'),null);assert.equal(crossMarketPolicy('__proto__'),null);
 assert.equal(crossMarketPolicy('XAU',at).urls.length,2);assert.ok(crossMarketPolicy('SPX',at).urls[0].includes('%5EGSPC'));
});
test('gold delta decoding preserves source dates and tick precision without filled weekends',()=>{
 const bars=decodeDukascopy(gold);assert.equal(bars.length,3);assert.equal(bars[1].open,4347.798);assert.equal(bars[2].open,4360.875);assert.equal(bars[2].time-bars[1].time,172800);assert.ok(bars.every(b=>b.volume===null));
 assert.throws(()=>decodeDukascopy({...gold,times:[0,1,0]}));assert.throws(()=>decodeDukascopy({...gold,opens:[0,1,NaN]}));assert.throws(()=>decodeDukascopy({...gold,highs:[0,-100000,0]}));
 assert.throws(()=>normalizeCrossMarket([gold,gold],'XAU',at),/OVERLAPPING/);
});
test('US10Y is already percentage yield and source volume never becomes comparable trading volume',()=>{
 const raw=yahoo('US10Y'),body=normalizeCrossMarket(raw,'US10Y',at);
 assert.equal(body.unit,'%');assert.equal(body.bars[0].close,4.859);assert.equal(body.bars[0].volume,null);assert.equal(body.volumeKind,'unavailable');assert.equal(body.session,'closed');
 const request=crossMarketRequest({market:'US10Y',period:'1D',profileId:'public-market',venueId:'yahoo'});
 assert.equal(validateCrossSnapshot(body,request,at),body);
 assert.throws(()=>validateCrossSnapshot({...body,unit:'USD'},request,at));assert.throws(()=>validateCrossSnapshot(body,request,at+120001));
 assert.throws(()=>normalizeCrossMarket(yahoo('SPX'),'NDX',at),/INVALID_INDEX/);
});
test('an unquoted current-session placeholder preserves actual closed history and source time',()=>{
 const raw=yahoo('US10Y'),r=raw.chart.result[0],start=Date.parse('2026-11-09T13:20:00Z')/1000;
 r.meta.currentTradingPeriod.regular={start,end:start+24000};r.timestamp.push(start);
 for(const k of ['open','high','low','close'])r.indicators.quote[0][k].push(null);
 const original=structuredClone(raw),now=(start-1800)*1000,body=normalizeCrossMarket(raw,'US10Y',now);
 assert.equal(body.bars.length,1);assert.equal(body.bars[0].close,4.859);assert.equal(body.quoteAsOf,r.meta.regularMarketTime);assert.equal(body.bars[0].time,time);assert.deepEqual(raw,original);
 assert.equal(validateCrossSnapshot(body,crossMarketRequest({market:'US10Y',period:'1D',profileId:'public-market',venueId:'yahoo'}),now),body);
 for(const mutate of [x=>{x.indicators.quote[0].open[1]=4.8;},x=>{x.timestamp[1]++;},x=>{x.meta.regularMarketTime=start;},x=>{for(const k of ['open','high','low','close'])x.indicators.quote[0][k][0]=null;},x=>{x.timestamp.push(start+60);for(const k of ['open','high','low','close'])x.indicators.quote[0][k].push(x.indicators.quote[0][k][0]);}]){
  const invalid=structuredClone(original);mutate(invalid.chart.result[0]);assert.throws(()=>normalizeCrossMarket(invalid,'US10Y',now),/INVALID_INDEX_PRICE/);
 }
 assert.throws(()=>normalizeCrossMarket(raw,'US10Y',(start+24000)*1000),/INVALID_INDEX_PRICE/);
});
test('DXY skips only known closed empty sessions; partial rows and unrecognized weekday holes fail',()=>{
 const raw=yahoo('DXY'),r=raw.chart.result[0],q=r.indicators.quote[0];
 r.timestamp=[Date.parse('2025-06-18T04:00:00Z')/1000,Date.parse('2025-06-19T04:00:00Z')/1000,Date.parse('2025-06-20T04:00:00Z')/1000];
 for(const k of ['open','high','low','close'])q[k]=[q[k][0],null,q[k][0]];
 assert.equal(normalizeCrossMarket(raw,'DXY',at).bars.length,2);
 q.open[1]=4.8;assert.throws(()=>normalizeCrossMarket(raw,'DXY',at));q.open[1]=null;
 r.timestamp=r.timestamp.map(t=>t+86400*7);assert.throws(()=>normalizeCrossMarket(raw,'DXY',at));
});
test('market close follows the source timezone through DST and preserves irregular sessions',()=>{
 const raw=yahoo(),r=raw.chart.result[0];r.timestamp=[Date.parse('2026-10-30T13:30:00Z')/1000,Date.parse('2026-11-02T14:30:00Z')/1000];
 for(const k of ['open','high','low','close'])r.indicators.quote[0][k]=[r.indicators.quote[0][k][0],r.indicators.quote[0][k][0]];
 const bars=normalizeCrossMarket(raw,'SPX',at).bars;
 assert.equal(bars[0].closedAt,bars[1].time);assert.equal(bars[0].closeTimeBasis,'next-session-open-bound');assert.equal(new Date(bars[1].closedAt*1000).toISOString(),'2026-11-03T05:00:00.000Z');assert.equal(bars[1].closeTimeBasis,'calendar-day-bound');
 r.timestamp[1]+=86400*7;assert.throws(()=>normalizeCrossMarket(raw,'SPX',at),/INVALID_MARKET_WINDOW/);
});
test('macro subscriptions refresh with provenance and cancellation ignores late responses',async()=>{
 const request=crossMarketRequest({market:'SPX',period:'1D',profileId:'public-market',venueId:'yahoo'}),body=normalizeCrossMarket(yahoo(),'SPX',at),states=[],snapshots=[],timers=new Map();let timerId=0,resolve;
 const stop=subscribeCrossMarket(request,{onSnapshot:b=>snapshots.push(b),onStatus:s=>states.push(s)},{now:()=>at,fetchImpl:async()=>({ok:true,json:async()=>({body})}),setTimer:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimer:id=>timers.delete(id)});
 await new Promise(r=>setImmediate(r));assert.equal(snapshots.length,1);assert.equal(states.at(-1).session,'closed');assert.equal(states.at(-1).source,request.source);assert.equal([...timers.values()][0].ms,60000);stop();assert.equal(timers.size,0);
 const cancel=subscribeCrossMarket(request,{onSnapshot:b=>snapshots.push(b)},{now:()=>at,fetchImpl:()=>new Promise(r=>{resolve=r;}),setTimer:()=>0,clearTimer:()=>{}});cancel();resolve({ok:true,json:async()=>({body})});await new Promise(r=>setImmediate(r));assert.equal(snapshots.length,1);
});
test('a failed macro read cancels its unread body, even when cancelling fails, and keeps the source retry delay',async t=>{
 for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  const request=crossMarketRequest({market:'SPX',period:'1D',profileId:'public-market',venueId:'yahoo'}),clock=crossTimers(),states=[];let cancels=0;
  const stop=subscribeCrossMarket(request,{onStatus:s=>states.push(s.state)},
   {...clock,now:()=>at,fetchImpl:async()=>({ok:false,status:503,headers:{get:()=>null},body:{cancel(){cancels++;return cancel();}},json:async()=>{throw Error('must not parse error');}})});
  t.after(stop);await settle();
  assert.equal(cancels,1);assert.equal(states.at(-1),'error');assert.deepEqual([...clock.timers.values()].map(timer=>timer.delay),[15000]);
  stop();await settle();assert.equal(clock.timers.size,0);
 }
});
