import test from 'node:test';
import assert from 'node:assert/strict';
import {marketAnalysisPlan,exponentialAverage,wilderSeries,computeMarketStudy,marketScatterSample,createMarketScanner} from './workbench-market-analysis.mjs';
import {regressionChannel,anchoredVolumeAverage,anchoredVolumeEnvelope,confirmedStructureBreaks,unfilledPriceGaps,confirmedPriceZones} from './workbench-market-analysis.mjs';
import {marketResearchObservation} from './live-research.mjs';

const bars=(n=300,seconds=3600)=>Array.from({length:n},(_,i)=>({time:i*seconds,open:100+i*.1,close:100+i*.1,high:101+i*.1,low:99+i*.1,volume:100}));
test('regression fits observed closes with residual deviation and no projected future prices',()=>{
 const input=bars(3).map((b,i)=>({...b,close:[1,2,4][i]})),before=structuredClone(input),fit=regressionChannel(input);
 assert.equal(fit.slope,1.5);assert.ok(Math.abs(fit.points[0].value-5/6)<1e-12);assert.ok(Math.abs(fit.deviation-Math.sqrt(1/18))<1e-12);
 assert.deepEqual(fit.points.map(p=>p.time),input.map(b=>b.time));assert.deepEqual(input,before);
 assert.equal(regressionChannel(input.slice(0,2)),null);
 const flat=regressionChannel(bars(65).map(b=>({...b,close:100})));assert.equal(flat.length,60);assert.equal(flat.deviation,0);assert.equal(flat.slope,0);
});
test('price zones need separated confirmed tests, use observed bounds, and retire on a closing break',()=>{
 const input=bars(20).map(b=>({...b,open:100,close:100,high:103,low:98}));
 const pivots={high:[{time:3600,value:103,confirmedAt:14400},{time:6*3600,value:103.4,confirmedAt:9*3600}],low:[]},before=structuredClone({input,pivots});
 const zones=confirmedPriceZones(input,pivots,2);assert.equal(zones.length,1);assert.deepEqual(zones[0].range,[103,103.4]);assert.equal(zones[0].confirmedAt,9*3600);assert.equal(zones[0].anchors.length,2);
 assert.deepEqual(confirmedPriceZones(input.slice(0,8),pivots,2),[]);
 assert.deepEqual(confirmedPriceZones(input,{high:pivots.high.slice(0,1),low:[]},2),[]);
 assert.deepEqual(confirmedPriceZones(input,{high:[pivots.high[0],{...pivots.high[1],time:2*3600}],low:[]},2),[]);
 assert.deepEqual(confirmedPriceZones(input,pivots,.2),[]);
 const wick=structuredClone(input);wick.at(-1).high=105;assert.equal(confirmedPriceZones(wick,pivots,2).length,1);
 wick.at(-1).close=104;assert.deepEqual(confirmedPriceZones(wick,pivots,2),[]);
 const inverse=input.map(b=>({...b,open:200-b.open,close:200-b.close,high:200-b.low,low:200-b.high}));
 const support=confirmedPriceZones(inverse,{high:[],low:pivots.high.map(p=>({...p,value:200-p.value}))},2)[0];assert.deepEqual(support.range,[96.6,97]);assert.equal(support.key,'pivot-zone-low');
 assert.deepEqual({input,pivots},before);
});
test('regression shading follows the fitted boundaries and stops at the latest closed bar',()=>{
 const input=bars().map((bar,i)=>({...bar,high:bar.high+Math.sin(i/5)+2,low:bar.low+Math.sin(i/5)-2,close:bar.close+Math.sin(i/5)}));
 const study=computeMarketStudy(input,{period:'1H',kind:'trend'},300*3600),band=study.lines.find(line=>line.key==='regression-band'),fit=regressionChannel(input);
 assert.equal(band.kind,'zone');assert.equal(band.points.length,121);assert.equal(band.points[0].value,fit.points[0].value-2*fit.deviation);
 assert.deepEqual(band.range,[fit.points.at(-1).value-2*fit.deviation,fit.points.at(-1).value+2*fit.deviation]);
 assert.ok(band.points.every(point=>point.time<=input.at(-1).time));assert.equal(band.confirmedAt,300*3600);
});
test('anchored VWAP waits for pivot confirmation and uses actual typical prices and volume',()=>{
 const input=bars(3).map((b,i)=>({...b,open:10*(i+1),close:10*(i+1),high:10*(i+1)+2,low:10*(i+1)-2,volume:i+1})),anchor={time:0,confirmedAt:7200};
 assert.deepEqual(anchoredVolumeAverage(input.slice(0,1),anchor),[]);
 const result=anchoredVolumeAverage(input,anchor);assert.equal(result[0].value,10);assert.equal(result.at(-1).value,140/6);
 assert.deepEqual(anchoredVolumeAverage(input.map(b=>({...b,volume:null})),anchor),[]);
 assert.deepEqual(anchoredVolumeAverage(input.map(b=>({...b,volume:0})),anchor),[]);
 assert.deepEqual(anchoredVolumeAverage(input,{...anchor,time:99}),[]);
 for(const confirmedAt of [undefined,NaN,0,-1])assert.deepEqual(anchoredVolumeAverage(input,{...anchor,confirmedAt}),[]);
});
test('anchored deviation is volume weighted, numerically stable, and requires observed volume',()=>{
 const input=[10,20].map((price,i)=>({time:i*3600,open:price,high:price,low:price,close:price,volume:[1,3][i]})),anchor={time:0,confirmedAt:7200};
 const envelope=anchoredVolumeEnvelope(input,anchor),last=envelope.at(-1);
 assert.equal(last.value,17.5);assert.equal(last.deviation,Math.sqrt(18.75));assert.equal(envelope[0].deviation,0);
 const shifted=input.map(bar=>({...bar,open:bar.open+1e9,high:bar.high+1e9,low:bar.low+1e9,close:bar.close+1e9}));
 assert.equal(anchoredVolumeEnvelope(shifted,anchor).at(-1).deviation,last.deviation);
 assert.deepEqual(anchoredVolumeEnvelope(input.map(bar=>({...bar,volume:null})),anchor),[]);
 assert.deepEqual(anchoredVolumeEnvelope(input.map(bar=>({...bar,volume:0})),anchor),[]);
 assert.deepEqual(anchoredVolumeEnvelope(input, {...anchor,confirmedAt:10800}),[]);
 const zero={...input.at(-1),time:7200,volume:0,high:100,low:100,close:100,open:100};
 assert.equal(anchoredVolumeEnvelope([...input,zero],anchor).at(-1).deviation,last.deviation);
});
test('cloud layers are measured envelopes, not price forecasts, and leave strategy overlays alone',()=>{
 const input=bars().map((b,i)=>{const price=100+Math.sin(i/6)*6+i*.03;return {...b,open:price,close:price+.2,high:price+1,low:price-1,volume:100+i};});
 for(const kind of ['trend','value','momentum']){
  const study=computeMarketStudy(input,{period:'1H',kind},300*3600),clouds=study.lines.filter(line=>line.surface==='cloud');
  assert.ok(clouds.length>0,kind);assert.ok(clouds.every(line=>line.points.every(point=>point.time<=input.at(-1).time)));
  if(kind==='trend')assert.ok(clouds.some(line=>line.key==='regression-inner'));
  if(kind==='value'){
   const outer=clouds.find(line=>line.key==='vwap-envelope-2'),inner=clouds.find(line=>line.key==='vwap-envelope-1');
   assert.ok(outer.range[0]<inner.range[0]&&outer.range[1]>inner.range[1]);
  }
  if(kind==='momentum'){
   const lower=study.lines.find(line=>line.key==='atr-band--1').points,upper=study.lines.find(line=>line.key==='atr-band-1').points;
   assert.deepEqual(clouds[0].points,[...lower,...upper.toReversed(),lower[0]]);
  }
  assert.equal(computeMarketStudy(input,{period:'1H',kind,plan:{id:'S03',parameters:{}}},300*3600).lines.some(line=>line.surface==='cloud'),false);
 }
});
test('retracement areas use confirmed swing ratios and retire with an invalidated swing',()=>{
 const input=bars().map(b=>({...b,open:100,close:100,high:101,low:99}));
 [100,104,110,104,100,94,90,94,97,99,98,99].forEach((price,i)=>Object.assign(input[288+i],{open:price,close:price,high:price+1,low:price-1}));
 const study=computeMarketStudy(input,{period:'1H',kind:'structure'},300*3600),anchor=study.lines.find(line=>line.key==='fib-anchor'),zones=study.lines.filter(line=>line.surface==='retracement');
 assert.equal(zones.length,3);const[first,end]=anchor.points;
 for(const zone of zones){assert.equal(zone.points[0].time,end.time);assert.ok(zone.confirmedAt<=300*3600);}
 const middle=zones.find(line=>line.key==='fib-area-0.382'),expected=[.382,.618].map(r=>end.value+(first.value-end.value)*r).sort((a,b)=>a-b);
 assert.deepEqual(middle.range,expected);
 input.at(-1).high=120;input.at(-1).close=120;
 assert.equal(computeMarketStudy(input,{period:'1H',kind:'structure'},300*3600).lines.some(line=>line.surface==='retracement'),false);
});
test('structure breaks require a known pivot and a closing cross, with reversal separate from continuation',()=>{
 const input=bars(9).map((b,i)=>{const close=[10,12,11,10,11,13,12,9,8][i];return {...b,open:close,close,high:close+.2,low:close-.2};});
 const pivots={high:[{time:3600,value:12,confirmedAt:14400}],low:[{time:10800,value:10,confirmedAt:21600}]},before=structuredClone({input,pivots});
 const result=confirmedStructureBreaks(input,pivots);assert.equal(result.length,2);assert.equal(result[0].en,'Break of structure');assert.equal(result[0].confirmedAt,21600);assert.equal(result[1].en,'Change of character');assert.equal(result[1].confirmedAt,28800);
 assert.deepEqual(confirmedStructureBreaks(input.slice(0,5),pivots),[]);
 const wick=structuredClone(input);wick[5].close=11;assert.equal(confirmedStructureBreaks(wick,pivots).some(e=>e.direction===1),false);
 assert.deepEqual(confirmedStructureBreaks(input,{high:[{...pivots.high[0],confirmedAt:36000}],low:[]}),[]);
 assert.deepEqual({input,pivots},before);
});
test('three-bar gaps form on confirmation, shrink after partial fills and disappear when filled',()=>{
 const input=[{open:100,close:100,high:101,low:99},{open:100,close:108,high:109,low:99},{open:108,close:108,high:110,low:106},{open:108,close:106,high:110,low:104},{open:106,close:101,high:107,low:100}].map((b,i)=>({...b,time:i*3600,volume:100}));
 const atr=input.map(b=>({time:b.time,value:2})),before=structuredClone(input);
 assert.deepEqual(unfilledPriceGaps(input.slice(0,2),atr),[]);
 const fresh=unfilledPriceGaps(input.slice(0,3),atr);assert.equal(fresh.length,1);assert.equal(fresh[0].confirmedAt,10800);assert.deepEqual(fresh[0].range,[101,106]);assert.equal(fresh[0].fillPercent,0);
 const partial=unfilledPriceGaps(input.slice(0,4),atr);assert.deepEqual(partial[0].range,[101,104]);assert.equal(partial[0].fillPercent,40);
 assert.deepEqual(unfilledPriceGaps(input,atr),[]);assert.deepEqual(input,before);
 const bearish=input.map(b=>({...b,open:220-b.open,close:220-b.close,high:220-b.low,low:220-b.high}));
 assert.equal(unfilledPriceGaps(bearish.slice(0,4),atr)[0].direction,-1);assert.deepEqual(unfilledPriceGaps(bearish.slice(0,4),atr)[0].range,[116,119]);assert.deepEqual(unfilledPriceGaps(bearish,atr),[]);
 assert.deepEqual(unfilledPriceGaps(input.slice(0,3),atr.map(p=>({...p,value:100}))),[]);
});
test('baseline rotates coherent drawing sets, while strategy jobs and as-of results remain unchanged',()=>{
 const plan=marketAnalysisPlan({market:'ETH/USDT'});assert.deepEqual(plan.steps.map(s=>s.kind),['trend','structure','value','momentum']);
 const input=bars(),now=300*3600,future={...input.at(-1),time:now,open:150,close:151,high:200,low:149};
 for(const kind of ['trend','structure','value','momentum']){
  const study=computeMarketStudy(input,{period:'1H',kind},now);
  assert.deepEqual(computeMarketStudy([...input,future],{period:'1H',kind},now),study);
  assert.ok(study.lines.every(line=>line.points.every(point=>point.time<now)&&(!line.confirmedAt||line.confirmedAt<=now)));
 }
 assert.ok(computeMarketStudy(input,{period:'1H',kind:'trend'},now).lines.some(l=>l.key.startsWith('regression')));
 assert.equal(computeMarketStudy(input,{period:'1H',kind:'trend',plan:{id:'S03',parameters:{}}},now).lines.some(l=>l.key.startsWith('regression')),false);
 const sessions=input.map(b=>({...b,time:b.time*24,volume:null,closedAt:b.time*24+86400,validUntil:b.time*24+172800}));
 const daily=computeMarketStudy(sessions,{period:'1D',kind:'value',plan:{...plan,sessionBased:true}},now*24);assert.equal(daily.state,'ready');assert.equal(daily.lines.some(l=>l.key==='anchored-vwap'),false);
});
test('daily scatter compares ATR-normalized trend and RSI without relying on unavailable volume',()=>{
 const input=bars(300,86400),now=300*86400,sample=marketScatterSample(input,now),before=structuredClone(input);
 assert.equal(sample.state,'ready');assert.equal(sample.y,100);assert.equal(sample.signal,'overbought');assert.equal(sample.closedAt,now);assert.ok(sample.x>0);assert.equal(sample.history.length,5);
 assert.equal(sample.change,(input.at(-1).close/input.at(-2).close-1)*100);assert.deepEqual(sample.priceSeries,input.slice(-18).map(bar=>bar.close));
 const open={...input.at(-1),time:now,close:999,high:1000,volume:1e9};
 assert.deepEqual(marketScatterSample([...input,open],now),sample);assert.deepEqual(input,before);
 assert.equal(marketScatterSample(input,now+86400).state,'stale');
 assert.equal(marketScatterSample(input.slice(0,20),20*86400).state,'warmup');
 assert.equal(marketScatterSample(input.filter((_,i)=>i!==100),now).state,'invalid');
 assert.equal(marketScatterSample(input.map(b=>({...b,close:100,high:100,low:100,open:100})),now).state,'no-range');
 assert.equal(marketScatterSample(input.map((b,i)=>i===4?{...b,high:b.low-1}:b),now).state,'invalid');
 const scaled=marketScatterSample(input.map(b=>({...b,open:b.open*2,close:b.close*2,high:b.high*2,low:b.low*2,volume:b.volume*5})),now);
 assert.ok(Math.abs(scaled.x-sample.x)<1e-10);assert.equal(scaled.y,sample.y);
 const noVolume=input.map(b=>({...b,volume:null,closedAt:b.time+86400,validUntil:b.time+172800}));assert.equal(marketScatterSample(noVolume,now,{sessionBased:true}).state,'ready');assert.equal(marketScatterSample(noVolume,now).state,'invalid');
});
test('EMA and Wilder calculations have known constant and one-direction results',()=>{
 const rising=bars(300),flat=rising.map(b=>({...b,open:100,close:100,high:101,low:99}));
 assert.equal(exponentialAverage(flat,20).at(-1).value,100);assert.equal(wilderSeries(flat).rsi.at(-1).value,50);
 assert.equal(wilderSeries(rising).rsi.at(-1).value,100);assert.equal(wilderSeries(flat).atr.at(-1).value,2);
 assert.equal(wilderSeries(rising.map((b,i)=>({...b,open:200-i*.1,close:200-i*.1,high:201-i*.1,low:199-i*.1}))).rsi.at(-1).value,0);
});
test('plans require exact instruments, preserve variants, and never default unrelated assets to S03',()=>{
 const draft={id:'d1',version:2,strategy:'S03',market:'BTC/USDT',executionRoute:{accountId:'SIM-01',connectionId:'binance-paper',environment:'DEMO',profileId:'cex-spot',venueId:'binance'}};
 const plan=marketAnalysisPlan({market:'BTC/USDT',draft});assert.equal(plan.id,'S03');assert.deepEqual(plan.steps.map(s=>s.period),['5m']);assert.equal(plan.minimumBars,250);
 assert.equal(marketAnalysisPlan({market:'ETH/USDT',draft}).id,'BASE');assert.equal(marketAnalysisPlan({market:'BTC/USDT',draft:{...draft,executionRoute:null}}).id,'BASE');
 assert.deepEqual(marketAnalysisPlan({market:'BTC/USDT',draft:{...draft,planVariant:'E01'}}).steps.map(s=>s.period),['1H','5m']);
 const simulation=marketAnalysisPlan({market:'BTC/USDT',draft:{...draft,strategy:'S01',planVariant:'S01-SIM'}});assert.equal(simulation.steps[0].kind,'plan');assert.deepEqual(simulation.parameters,{});
 assert.equal(marketAnalysisPlan({market:'BTC/USDT',draft:{...draft,planVariant:'unknown'}}).id,'BASE');
 assert.ok(marketAnalysisPlan({market:'BTC/USDT',draft:{...draft,strategy:'S00'}}).missing.includes('point-in-time-human-scores'));
});
test('an ended run yields to the selected draft, while retained positions and unknown orders keep their run plan',()=>{
 const route={accountId:'SIM-01',connectionId:'binance-paper',environment:'DEMO',profileId:'cex-spot',venueId:'binance',marketType:'SPOT',instrumentId:'binance:SPOT:BTC/USDT'};
 const draft={id:'new-draft',version:2,strategy:'S03',planVariant:'E01',market:'BTC/USDT',executionRoute:route};
 const trade={state:'stopped',session:{id:'old-run',version:1,strategy:'S03',planVariant:'baseline',market:draft.market,...route},position:null,pending:null};
 const resolve=trade=>marketAnalysisPlan({market:draft.market,trade,draft});
 assert.equal(resolve(trade).variant,'E01');assert.ok(resolve(trade).ref.startsWith('draft:'));
 assert.equal(resolve({...trade,position:{qty:1}}).variant,'baseline');
 assert.equal(resolve({...trade,pending:{status:'unknown',intent:'close'}}).variant,'baseline');
 for(const status of ['unknown','submitted'])assert.equal(resolve({...trade,pending:{status,intent:'open',side:'buy'}}).variant,'baseline');
});
test('studies use requested methods and preserve historical results when future bars arrive',()=>{
 const input=bars(),now=300*3600,job={period:'1H',kind:'momentum'},study=computeMarketStudy(input,job,now);
 assert.equal(study.state,'ready');assert.equal(study.oscillators[0].key,'rsi');assert.equal(study.lines.filter(line=>line.kind!=='zone').length,4);assert.deepEqual(study.lines.filter(line=>line.kind==='zone').map(line=>line.key),['atr-envelope']);
 assert.deepEqual(computeMarketStudy([...input,{...input.at(-1),time:now,high:5000}],job,now),study);
 assert.equal(computeMarketStudy(input.slice(-100),job,now).state,'warmup');
 const structure=computeMarketStudy(input,{period:'1H',kind:'structure'},now);
 assert.ok(structure.lines.every(line=>line.points.every(p=>p.time<now)));assert.equal(structure.oscillators.length,0);
 assert.equal(structure.lines.find(line=>line.key==='prior-high').points.at(-1).value,input.at(-2).high);
});
test('strategy timeframe checks stay distinct and simulation levels never become live indicators',()=>{
 const input=bars(300,300),now=300*300,plan={id:'S02',parameters:{atr_tf:'1h',rsi_cross:'30',rsi_ceiling:'45'},minimumBars:250};
 const study=computeMarketStudy(input,{period:'5m',kind:'momentum',plan},now);
 assert.equal(study.checks.some(check=>check.key==='atr'),false);
 assert.equal(study.checks.some(check=>check.key==='rsi-cross'),true);
 const sim=computeMarketStudy(bars(),{period:'1H',kind:'plan'},300*3600);
 assert.equal(sim.state,'simulation-plan');assert.deepEqual(sim.lines,[]);assert.deepEqual(sim.oscillators,[]);
 const original=computeMarketStudy(bars(),{period:'1H',kind:'trend',plan:{id:'S03',parameters:{},minimumBars:250}},300*3600);
 assert.equal(original.checks.some(check=>check.key==='volatility'),false);
});
test('S02 regime and S03 E01 preserve equality, while E01 rejects a declining slow EMA',()=>{
 const flat=bars().map(b=>({...b,open:100,close:100,high:101,low:99})),now=300*3600;
 const plan={id:'S02',parameters:{regime_tf:'1h'},minimumBars:250};
 assert.equal(computeMarketStudy(flat,{period:'1H',kind:'trend',plan},now).checks.find(c=>c.key==='trend').value,true);
 const e01={id:'S03',variant:'E01',parameters:{},minimumBars:250};
 const stable=computeMarketStudy(flat,{period:'1H',kind:'trend',plan:e01},now);
 assert.equal(stable.checks.find(c=>c.key==='trend').value,true);assert.equal(stable.checks.find(c=>c.key==='ema-slope').value,true);
 const down=flat.map((b,i)=>({...b,open:200-i*.1,close:200-i*.1,high:201-i*.1,low:199-i*.1}));
 assert.equal(computeMarketStudy(down,{period:'1H',kind:'trend',plan:e01},now).checks.find(c=>c.key==='ema-slope').value,false);
 const strict=computeMarketStudy(flat.map(b=>({...b,time:b.time/12})),{period:'5m',kind:'momentum',plan:{...e01,variant:'baseline'}},now/12);
 assert.equal(strict.checks.find(c=>c.key==='trend').value,false);assert.equal(strict.checks.some(c=>c.key==='ema-slope'),false);
});
test('scanner connects all eight markets concurrently, keeps failure states, and ignores removed or paused callbacks',()=>{
 const calls=[],changes=[];let now=300*86400;
 const scanner=createMarketScanner(()=>changes.push(1),{now:()=>now,subscribe:(request,callbacks)=>{const item={request,callbacks,stopped:false};calls.push(item);return ()=>{item.stopped=true;};}});
 const assets=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'].map(symbol=>({symbol,domain:['BTC','ETH','SOL'].includes(symbol)?'Crypto':'TradFi'}));
 scanner.update(assets,true);assert.equal(calls.length,8);assert.ok(calls.every(c=>c.request.period==='1D'));
 for(const call of calls){const input=bars(300,86400).map(b=>call.request.sessionBased?{...b,volume:null,closedAt:b.time+86400,validUntil:b.time+172800}:b);call.callbacks.onSnapshot(input);}
 assert.ok(scanner.rows().every(row=>row.state==='ready'));assert.equal(new Set(scanner.rows().map(row=>row.symbol)).size,8);
 const old=calls[0];scanner.update(assets.slice(1),true);assert.equal(old.stopped,true);const count=changes.length;old.callbacks.onSnapshot(bars(300,86400));assert.equal(changes.length,count);
 calls[1].callbacks.onStatus({state:'error'});assert.equal(scanner.rows().find(r=>r.symbol==='ETH').state,'error');
 scanner.update(assets.slice(1),false);assert.ok(calls.every(c=>c.stopped));calls[1].callbacks.onStatus({state:'snapshot'});assert.equal(scanner.rows().find(r=>r.symbol==='ETH').state,'error');
 now+=86401;assert.equal(scanner.rows().find(r=>r.symbol==='SOL').state,'stale');scanner.dispose();assert.deepEqual(scanner.rows(),[]);
});
test('an in-flight cross-market poll preserves only its own still-valid receipt',()=>{
 const day=86400,feeds=new Map();
 let now=300*day;
 const scanner=createMarketScanner(()=>{},{now:()=>now,subscribe:(request,callbacks)=>{feeds.set(request.symbol,callbacks);return ()=>{};}});
 scanner.update(['DXY','SPX','XAU'].map(symbol=>({symbol,domain:'TradFi'})),true);
 const feed=feeds.get('DXY'),row=symbol=>scanner.rows().find(entry=>entry.symbol===symbol);
 const read=symbol=>marketResearchObservation(row(symbol),now);
 const barsForDay=bars(300,day).map(bar=>({...bar,volume:null,closedAt:bar.time+day,validUntil:bar.time+2*day}));
 const snapshot={state:'snapshot',asOf:now*1000};
 feed.onSnapshot(barsForDay);feed.onStatus(snapshot);
 feeds.get('XAU').onStatus({state:'error'});
 const original=row('DXY');assert.equal(read('DXY').state,'ready');

 now+=60;
 for(const callbacks of feeds.values())callbacks.onStatus({state:'refreshing'});
 assert.deepEqual(row('DXY'),original);
 assert.equal(read('DXY').state,'ready');
 assert.equal(read('SPX').state,'loading');
 assert.equal(read('XAU').state,'error');

 feed.onStatus({state:'stale'});feed.onStatus({state:'refreshing'});
 assert.equal(read('DXY').state,'stale');
 feed.onSnapshot([{...barsForDay[0],high:0}]);feed.onStatus(snapshot);feed.onStatus({state:'refreshing'});
 assert.equal(read('DXY').state,'invalid');
 feed.onSnapshot(barsForDay);feed.onStatus({...snapshot,source:'Wrong source'});feed.onStatus({state:'refreshing'});
 assert.equal(read('DXY').state,'invalid');
 feed.onStatus({...snapshot,source:original.source});
 assert.equal(read('DXY').state,'ready');
 now=original.validUntil+1;feed.onStatus({state:'refreshing'});
 assert.equal(read('DXY').state,'stale');
 scanner.dispose();
});
test('scanner isolates depth by market and stops hidden, paused and removed subscriptions',()=>{
 let clock=100;const calls=[],candles=[],changes=[];
 const scanner=createMarketScanner(()=>changes.push(1),{now:()=>clock,subscribe:(request,callbacks)=>{const item={request,callbacks,stopped:false};candles.push(item);return ()=>{item.stopped=true;};},subscribeDepth:(symbol,callbacks)=>{const item={symbol,callbacks,stopped:false};calls.push(item);return ()=>{item.stopped=true;};}});
 const assets=[{symbol:'BTC',domain:'Crypto'},{symbol:'ETH',domain:'Crypto'},{symbol:'SPX',domain:'TradFi'}];
 scanner.update(assets,true);assert.deepEqual(calls.map(c=>c.symbol),['BTC','ETH']);assert.equal(scanner.rows()[2].depthState,'unsupported');
 calls[0].callbacks.onSnapshot({validUntil:130000,lastUpdateId:1});assert.equal(scanner.rows()[0].depthState,'ready');assert.equal(scanner.rows()[1].depthState,'loading');
 candles[0].callbacks.onStatus({state:'error'});assert.equal(scanner.rows()[0].depthState,'ready');
 clock=130;assert.equal(scanner.rows()[0].depthState,'stale');
 scanner.update(assets,false);assert.ok(calls.every(c=>c.stopped));assert.ok(candles.every(c=>c.stopped));assert.ok(scanner.rows().every(r=>r.paused));
 const count=changes.length;calls[0].callbacks.onSnapshot({validUntil:190000,lastUpdateId:2});assert.equal(changes.length,count);
 scanner.update(assets,true);assert.equal(scanner.rows()[0].depthState,'loading');assert.equal(calls.length,4);
 scanner.update(assets.slice(1),true);assert.equal(calls[2].stopped,true);assert.equal(scanner.rows().some(r=>r.symbol==='BTC'),false);
 const next=changes.length;calls[2].callbacks.onStatus({state:'ready'});assert.equal(changes.length,next);
 scanner.dispose();assert.equal(calls[3].stopped,true);assert.deepEqual(scanner.rows(),[]);
});
test('market-session studies do not invent volume and their warmup uses observed sessions',()=>{
 const now=300*86400,input=bars(300,86400).map(b=>({...b,volume:null,closedAt:b.time+86400,validUntil:b.time+172800})),plan=marketAnalysisPlan({market:'US10Y',sessionBased:true});
 assert.ok(plan.steps.every(step=>step.period==='1D'));assert.equal(plan.sessionBased,true);assert.equal(plan.id,'BASE');
 const study=computeMarketStudy(input,{period:'1D',kind:'structure',plan},now);assert.equal(study.state,'ready');assert.ok(study.lines.length);assert.equal(study.lines.some(l=>l.key==='vwap'),false);
 assert.equal(computeMarketStudy(input,{period:'1H',kind:'structure',plan},now).state,'invalid');
 assert.equal(computeMarketStudy(input.map(b=>({...b,validUntil:now-1})),{period:'1D',plan},now).state,'invalid');
});
test('retracements require a confirmed intact swing of at least two ATR and use its actual anchors',()=>{
 const input=bars(),tail=[210,208,205,200,198,195,190,192,196,200,207,215,225,235,245,250,248,244,240,235,230,225,220,222,228,235,242,240,238,237];
 tail.forEach((value,i)=>Object.assign(input[270+i],{open:value,close:value,high:value+1,low:value-1}));
 const result=computeMarketStudy(input,{period:'1H',kind:'structure'},300*3600),levels=result.lines.filter(line=>line.key.startsWith('fib-')&&line.kind!=='zone');
 assert.deepEqual(result.lines.filter(line=>line.key.startsWith('fib-')&&line.kind==='zone').map(line=>line.key),['fib-area-0','fib-area-0.382','fib-area-0.618']);
 assert.equal(levels.length,4);assert.deepEqual(levels[0].points.map(p=>p.value),[219,243]);assert.equal(levels.find(l=>l.key==='fib-0.5').points.at(-1).value,231);
 assert.ok(levels[0].points.every(p=>p.confirmedAt<=result.closedAt));
 const broken=structuredClone(input);broken.at(-1).low=210;
 assert.equal(computeMarketStudy(broken,{period:'1H',kind:'structure'},300*3600).lines.some(l=>l.key.startsWith('fib-')),false);
 assert.equal(computeMarketStudy(input,{period:'1H',kind:'structure',plan:{id:'S04',parameters:{},minimumBars:250}},300*3600).lines.some(l=>l.key.startsWith('fib-')),false);
});

test('session trend lines stay straight on the candle axis across weekends',()=>{
 const input=bars(),tail=[210,208,205,200,198,195,190,192,196,200,207,215,225,235,245,250,248,244,240,235,230,225,220,222,228,235,242,240,238,237];
 tail.forEach((value,i)=>Object.assign(input[270+i],{open:value,close:value,high:value+1,low:value-1}));
 let time=Date.UTC(2025,0,6)/1000;
 const sessions=input.map(b=>{while([0,6].includes(new Date(time*1000).getUTCDay()))time+=86400;const bar={...b,time,volume:null,closedAt:time+57600,validUntil:time+86400*4};time+=86400;return bar;});
 const plan=marketAnalysisPlan({market:'SPX',sessionBased:true}),study=computeMarketStudy(sessions,{period:'1D',kind:'structure',plan},sessions.at(-1).closedAt);
 assert.equal(study.state,'ready');
 const lines=study.lines.filter(line=>line.key.startsWith('swing-'));assert.ok(lines.length>0);
 const indexes=new Map(sessions.map((bar,i)=>[bar.time,i]));
 for(const line of lines){
  const [first,second,last]=line.points,x=indexes.get(first.time),slope=(second.value-first.value)/(indexes.get(second.time)-x);
  assert.ok(Math.abs(last.value-(first.value+slope*(indexes.get(last.time)-x)))<1e-8,'drawn trend must pass both confirmed anchors on the equally spaced candle axis');
  assert.ok(sessions.slice(x).every((bar,i)=>line.key.startsWith('swing-high')?bar.high<=first.value+slope*i+1e-8:bar.low>=first.value+slope*i-1e-8));
 }
});
