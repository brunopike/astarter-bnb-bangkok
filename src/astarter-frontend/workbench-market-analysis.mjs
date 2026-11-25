import {CANDLE_PERIODS,candleRequest,subscribeCandles,mergeCandle,candleTechnicalStudy} from './trading-chart-data.mjs';
import {strategyPlan} from './strategy-execution-data.mjs';
import {executionRunIdentity,executionRunState} from './execution-stream.mjs';

const tf=value=>Object.keys(CANDLE_PERIODS).find(key=>key.toLowerCase()===String(value).toLowerCase());
const baseSteps=[{period:'4H',kind:'trend',zh:'趋势通道',en:'Trend channel'},{period:'1H',kind:'structure',zh:'市场结构',en:'Market structure'},{period:'1H',kind:'value',zh:'缺口与成本',en:'Gaps & VWAP'},{period:'15m',kind:'momentum',zh:'短期动量',en:'Momentum'}];
const matches=(identity,market)=>identity?.market===market&&identity.profileId==='cex-spot'&&identity.venueId==='binance'&&identity.marketType==='SPOT'&&identity.instrumentId===`binance:SPOT:${market}`&&identity.accountId&&identity.connectionId&&['DEMO','PAPER','LIVE'].includes(identity.environment);

export function marketAnalysisPlan({market,trade,draft,sessionBased=false}={}){
 const identity=executionRunIdentity(trade),run=matches(identity,market)&&(trade.pending||!['idle','ended'].includes(executionRunState(trade).state))?trade.session:null;
 const route=draft?.executionRoute,draftIdentity=route&&{...route,market:draft.market,marketType:route.marketType||'SPOT',instrumentId:route.instrumentId||`${route.venueId}:SPOT:${draft.market}`};
 const source=run||draft?.id&&draft.version&&matches(draftIdentity,market)&&draft;
 const variant=source?.planVariant||'baseline',plan=source?.strategy&&strategyPlan(source.strategy,variant);
 const baseline={id:'BASE',variant:'baseline',version:'market-observation-v3',ref:`BASE:${market}`,steps:baseSteps,parameters:{},minimumBars:250,zh:'市场技术观察',en:'Market observation',missing:[]};
 if(sessionBased)return {...baseline,ref:`DAILY:${market}`,sessionBased:true,steps:baseSteps.map(step=>({...step,period:'1D'}))};
 if(!plan||plan.variant!==variant)return baseline;
 const params=Object.fromEntries(Object.entries(plan.record.parameters).map(([key,item])=>[key,item.value]));
 const common={id:plan.id,variant,version:plan.record.version,ref:`${run?'run':'draft'}:${source.id}:${source.strategyVersion||source.version}:${variant}`,parameters:params,minimumBars:250,zh:`${plan.id} · ${run?'运行方案':'所选方案'}`,en:`${plan.id} · ${run?'Run plan':'Selected plan'}`,missing:[]};
 if(plan.candidate?.kind==='simulation')return {...common,steps:[{period:'1H',kind:'plan',zh:'核对模拟方案价位',en:'Simulation plan levels'}],missing:['simulation-levels'],levels:source.botParameters||source.parameters||null};
 const step=(period,kind,zh,en)=>({period:tf(period),kind,zh,en});
 const trend=period=>step(period,'trend','趋势与波动过滤','Trend & volatility');
 const structure=period=>step(period,'structure','确认摆点与区间','Confirmed pivots & range');
 let steps;
 if(plan.id==='S03')steps=[...(variant==='E01'?[trend('1H')]:[]),step('5m','momentum','EMA / RSI 收盘核验','EMA / RSI close validation')];
 else if(plan.id==='S00')steps=[trend('4H'),trend('1H'),structure('15m')];
 else if(plan.id==='S02')steps=[trend(params.regime_tf),step(params.signal_tf,'momentum','RSI 回升核验','RSI recovery validation')];
 else if(['S01','S07'].includes(plan.id))steps=[step(params.regime_tf||params.timeframe,'range','核对固定区间依据','Range evidence')];
 else if(['S04','S06'].includes(plan.id))steps=[structure(params.timeframe)];
 else if(plan.id==='S08')steps=[structure(params.setup_tf),step(params.signal_tf,'momentum','检查突破动量','Breakout momentum')];
 else return {...baseline,zh:`${plan.id} · 基础价格观察`,en:`${plan.id} · Price observation`,missing:['external-strategy-inputs']};
 return {...common,steps:steps.filter(item=>item.period),missing:plan.id==='S00'?['point-in-time-human-scores']:['S04','S06','S07','S08'].includes(plan.id)?['full-pattern-validation']:[]};
}

export function exponentialAverage(bars,length){
 let value;return bars.flatMap((bar,i)=>{value=i?bar.close*2/(length+1)+value*(1-2/(length+1)):bar.close;return i>=length-1?[{time:bar.time,value}]:[];});
}
export function wilderSeries(bars,length=14){
 const atr=[],rsi=[];let gain=0,loss=0,tr=0;
 for(let i=0;i<bars.length;i++){
  const b=bars[i],previous=bars[i-1],range=previous?Math.max(b.high-b.low,Math.abs(b.high-previous.close),Math.abs(b.low-previous.close)):b.high-b.low;
  tr=i<length?tr+range:tr*(length-1)/length+range/length;
  if(i===length-1)tr/=length;if(i>=length-1)atr.push({time:b.time,value:tr});
  if(!i)continue;const change=b.close-previous.close,g=Math.max(0,change),l=Math.max(0,-change);
  gain=i<=length?gain+g:gain*(length-1)/length+g/length;loss=i<=length?loss+l:loss*(length-1)/length+l/length;
  if(i===length){gain/=length;loss/=length;}
  if(i>=length)rsi.push({time:b.time,value:loss===0?gain===0?50:100:100-100/(1+gain/loss)});
 }
 return {atr,rsi};
}
function validatedBars(input,period,now,minimum,sessionBased=false){
 const seconds=CANDLE_PERIODS[period];
 if(!seconds||!Number.isFinite(now)||!Array.isArray(input)||sessionBased&&period!=='1D'||input.some((b,i)=>!['time','open','high','low','close'].every(k=>Number.isFinite(b[k]))||b.time<0||b.low<=0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||
  (sessionBased?b.volume!==null||!Number.isFinite(b.closedAt)||b.closedAt<=b.time||!Number.isFinite(b.validUntil)||b.validUntil<=b.closedAt||i&&(b.time<=input[i-1].time||b.time-input[i-1].time>86400*4+3600):!Number.isFinite(b.volume)||b.volume<0||b.time%seconds!==0||i&&b.time-input[i-1].time!==seconds)))return {state:'invalid',bars:[]};
 const bars=input.filter(b=>(sessionBased?b.closedAt:b.time+seconds)<=now),last=bars.at(-1),expected=Math.floor(now/seconds)*seconds-seconds;
 if(bars.length<minimum)return {state:'warmup',bars,needed:minimum-bars.length};
 if(sessionBased?last.validUntil<now:last.time!==expected)return {state:'stale',bars};
 return {state:'ready',bars,closedAt:sessionBased?last.closedAt:last.time+seconds,validUntil:sessionBased?last.validUntil:last.time+seconds*2,sampleAt:last.time};
}

// Current-window fit, not a historical trading signal or a projected price target.
export function regressionChannel(bars,length=60){
 const sample=bars.slice(-length),n=sample.length;if(n<3)return null;
 const center=(n-1)/2,mean=sample.reduce((sum,b)=>sum+b.close,0)/n;
 const variance=sample.reduce((sum,b,i)=>sum+(i-center)**2,0),slope=sample.reduce((sum,b,i)=>sum+(i-center)*(b.close-mean),0)/variance;
 const intercept=mean-slope*center,deviation=Math.sqrt(sample.reduce((sum,b,i)=>sum+(b.close-intercept-slope*i)**2,0)/n);
 return {length:n,slope,deviation,points:sample.map((b,i)=>({time:b.time,value:intercept+slope*i}))};
}

// Cluster confirmed, separated tests within half an ATR; bounds are observed pivot prices.
export function confirmedPriceZones(bars,pivots,atr,{seconds=3600,sessionBased=false}={}){
 if(!bars.length||!Number.isFinite(atr)||atr<=0)return [];
 const last=bars.at(-1),closedAt=sessionBased?last.closedAt:last.time+seconds,indexes=new Map(bars.map((bar,i)=>[bar.time,i])),zones=[];
 for(const side of ['high','low']){
  const recent=pivots[side].filter(p=>indexes.has(p.time)&&indexes.get(p.time)>=bars.length-120&&p.confirmedAt<=closedAt),candidates=[];
  for(const pivot of recent){
   const cluster=recent.filter(p=>Math.abs(p.value-pivot.value)<=atr*.5).sort((a,b)=>a.time-b.time),tests=[];
   for(const p of cluster)if(!tests.length||indexes.get(p.time)-indexes.get(tests.at(-1).time)>=4)tests.push(p);
   if(tests.length<2)continue;
   const low=Math.min(...tests.map(p=>p.value)),high=Math.max(...tests.map(p=>p.value));
   if(high-low>atr*.5||high===low)continue;
   const confirmedAt=Math.max(...tests.map(p=>p.confirmedAt));
   if(bars.some(b=>(sessionBased?b.closedAt:b.time+seconds)>=confirmedAt&&(side==='high'?b.close>high:b.close<low)))continue;
   candidates.push({tests,low,high,confirmedAt,distance:Math.abs((low+high)/2-last.close)});
  }
  const best=candidates.sort((a,b)=>a.distance-b.distance||b.tests.length-a.tests.length)[0];if(!best)continue;
  const {tests,low,high,confirmedAt}=best,start=tests[0].time;
  zones.push({key:`pivot-zone-${side}`,kind:'zone',zh:side==='high'?'反复测试阻力区':'反复测试支撑区',en:side==='high'?'Tested resistance zone':'Tested support zone',label:`${side==='high'?'R':'S'} ×${tests.length}`,color:side==='high'?'#ff9a2b':'#38d3c4',range:[low,high],confirmedAt,anchors:tests,points:[{time:start,value:low},{time:start,value:high},{time:last.time,value:high},{time:last.time,value:low},{time:start,value:low}]});
 }
 return zones;
}

export function anchoredVolumeEnvelope(bars,anchor,{seconds=3600,sessionBased=false}={}){
 if(!anchor||!Number.isFinite(anchor.time)||!Number.isFinite(anchor.confirmedAt)||anchor.confirmedAt<=anchor.time||!bars.length||anchor.confirmedAt>(sessionBased?bars.at(-1).closedAt:bars.at(-1).time+seconds)||bars.some(b=>!Number.isFinite(b.volume)||b.volume<0))return [];
 const start=bars.findIndex(b=>b.time===anchor.time);if(start<0)return [];
 let weighted=0,volume=0,mean=0,moment=0;const points=[];
 for(const b of bars.slice(start)){
  const price=(b.high+b.low+b.close)/3,delta=price-mean;
  volume+=b.volume;weighted+=price*b.volume;
  if(volume>0){mean+=delta*b.volume/volume;moment+=b.volume*delta*(price-mean);points.push({time:b.time,value:weighted/volume,deviation:Math.sqrt(Math.max(0,moment/volume))});}
 }
 return points;
}
export function anchoredVolumeAverage(bars,anchor,options){return anchoredVolumeEnvelope(bars,anchor,options).map(({time,value})=>({time,value}));}

// A break is known only at its closing bar; pivot timestamps never become signal timestamps.
export function confirmedStructureBreaks(bars,pivots,{seconds=3600,sessionBased=false}={}){
 const events=[],known={high:null,low:null},cursor={high:0,low:0},used=new Set();let bias=0;
 for(let i=1;i<bars.length;i++){
  const bar=bars[i],closedAt=sessionBased?bar.closedAt:bar.time+seconds;
  for(const side of ['high','low']){
   while(cursor[side]<pivots[side].length&&pivots[side][cursor[side]].confirmedAt<=closedAt)known[side]=pivots[side][cursor[side]++];
   const pivot=known[side],id=side+':'+pivot?.time,direction=side==='high'?1:-1;
   if(!pivot||used.has(id)||bar.time<=pivot.time)continue;
   if(direction===1?bar.close>pivot.value&&bars[i-1].close<=pivot.value:bar.close<pivot.value&&bars[i-1].close>=pivot.value){
    const reversal=bias!==0&&bias!==direction;
    events.push({key:`structure-break-${bar.time}`,zh:reversal?'反向结构突破 CHoCH':'结构突破 BOS',en:reversal?'Change of character':'Break of structure',label:reversal?'CHoCH':'BOS',color:direction===1?'#4dff7a':'#ff9a2b',direction,confirmedAt:closedAt,pivotConfirmedAt:pivot.confirmedAt,points:[{time:pivot.time,value:pivot.value},{time:bar.time,value:pivot.value}]});
    used.add(id);bias=direction;
   }
  }
 }
 return events;
}

// Three closed bars define the gap; subsequent wicks shrink its remaining, unfilled range.
export function unfilledPriceGaps(bars,atr,{seconds=3600,sessionBased=false}={}){
 const ranges=new Map(atr.map(row=>[row.time,row.value])),gaps=[];
 for(let i=2;i<bars.length;i++){
  const left=bars[i-2],middle=bars[i-1],right=bars[i],direction=middle.close>middle.open&&right.low>left.high?1:middle.close<middle.open&&right.high<left.low?-1:0;
  if(!direction)continue;
  const bottom=direction===1?left.high:right.high,top=direction===1?right.low:left.low;
  if(top-bottom<(ranges.get(right.time)||Infinity)*.1)continue;
  let remainingBottom=bottom,remainingTop=top;
  for(const bar of bars.slice(i+1)){
   if(direction===1)remainingTop=Math.min(remainingTop,bar.low);else remainingBottom=Math.max(remainingBottom,bar.high);
   if(remainingBottom>=remainingTop)break;
  }
  if(remainingBottom>=remainingTop)continue;
  const confirmedAt=sessionBased?right.closedAt:right.time+seconds;
  gaps.push({key:`fvg-${right.time}`,zh:'未回补价格缺口',en:'Unfilled three-bar price gap',label:'FVG',color:direction===1?'#4dff7a':'#ff9a2b',kind:'zone',direction,confirmedAt,range:[remainingBottom,remainingTop],fillPercent:100*(1-(remainingTop-remainingBottom)/(top-bottom)),points:[{time:middle.time,value:remainingBottom},{time:middle.time,value:remainingTop},{time:bars.at(-1).time,value:remainingTop},{time:bars.at(-1).time,value:remainingBottom},{time:middle.time,value:remainingBottom}]});
 }
 return gaps;
}

// Formula methods follow TradingView's EMA/RMA definitions; structure is independently implemented.
export function computeMarketStudy(input,{period='1H',kind='structure',plan={id:'BASE',parameters:{},minimumBars:250}}={},now=Date.now()/1000){
 const checked=validatedBars(input,period,now,plan.minimumBars||250,plan.sessionBased),empty={...checked,lines:[],oscillators:[],checks:[]};
 if(checked.state!=='ready')return empty;
 const {bars,closedAt}=checked,p=plan.parameters||{},seconds=CANDLE_PERIODS[period],last=bars.at(-1),base=candleTechnicalStudy(bars,{seconds,now,sessionBased:plan.sessionBased});
 const fast=Number(p.ema_fast)||20,slow=Number(p.ema_slow||p.ema_period)||50,rsiLength=Number(p.rsi_period)||14,atrLength=Number(p.atr_period)||14;
 const emaFast=exponentialAverage(bars,fast),emaSlow=exponentialAverage(bars,slow),{atr}=wilderSeries(bars,atrLength),{rsi}=wilderSeries(bars,rsiLength),lines=[],checks=[];
 const add=(key,zh,en,color,points)=>{if(points.length>1)lines.push({key,zh,en,color,points});};
 const horizontal=(key,zh,en,color,value,start)=>add(key,zh,en,color,[{time:start,value},{time:last.time,value}]);
 const band=(key,zh,en,color,lower,upper,metadata={})=>{
  if(lower.length<2||lower.length!==upper.length||lower.some((row,i)=>row.time!==upper[i].time||row.value<=0||!Number.isFinite(row.value)||!Number.isFinite(upper[i].value)||row.value>upper[i].value)||!lower.some((row,i)=>row.value<upper[i].value))return;
  lines.push({key,zh,en,color,kind:'zone',surface:'cloud',range:[lower.at(-1).value,upper.at(-1).value],confirmedAt:closedAt,points:[...lower,...upper.toReversed(),lower[0]],...metadata});
 };
 const a=atr.at(-1).value,r=rsi.at(-1).value,e=emaFast.at(-1).value,es=emaSlow.at(-1).value;
 if(kind==='plan')return {...empty,state:'simulation-plan',closedAt,checks:[]};
 if(kind!=='value'&&(kind!=='structure'||plan.id!=='BASE')){
  if(!['S01','S07'].includes(plan.id))add('ema-fast',`EMA ${fast}`,`EMA ${fast}`,'#ffd84d',emaFast);
  add('ema-slow',`EMA ${slow}`,`EMA ${slow}`,'#a24dff',emaSlow);
 }
 if(kind==='trend'&&plan.id==='BASE'){
  const channel=regressionChannel(bars);
  if(channel.deviation>1e-8&&channel.points.every(row=>row.value>2*channel.deviation)){
   const lower=channel.points.map(row=>({...row,value:row.value-2*channel.deviation})),upper=channel.points.map(row=>({...row,value:row.value+2*channel.deviation}));
   band('regression-band','回归通道 ±2σ','Regression envelope ±2σ','#a24dff',lower,upper,{label:'±2σ',window:channel.length});
   band('regression-inner','回归通道 ±1σ','Regression envelope ±1σ','#3dd5ff',channel.points.map(row=>({...row,value:row.value-channel.deviation})),channel.points.map(row=>({...row,value:row.value+channel.deviation})),{window:channel.length});
  }
  for(const offset of [-2,0,2]){
   if(offset&&channel.deviation<1e-8)continue;
   const points=channel.points.map(row=>({...row,value:row.value+offset*channel.deviation}));
   if(points.some(row=>row.value<=0))continue;
   lines.push({key:'regression-'+offset,zh:offset?`回归通道 ${offset>0?'+':'−'}2σ`:'60 根收盘回归中线',en:offset?`Regression channel ${offset>0?'+':'−'}2σ`:'60-close regression fit',color:offset<0?'#4a6bff':offset>0?'#a24dff':'#3dd5ff',points,confirmedAt:closedAt,window:channel.length});
  }
 }
 if(kind==='momentum'){
  const atrByTime=new Map(atr.map(row=>[row.time,row.value]));
  if(plan.id==='BASE'){
   const boundaries=[-1,1].map(sign=>emaFast.filter(row=>atrByTime.has(row.time)).map(row=>({time:row.time,value:row.value+sign*2*atrByTime.get(row.time)})));
   band('atr-envelope',`EMA ${fast} ±2 ATR 波动带`,`EMA ${fast} ±2 ATR envelope`,'#3dd5ff',...boundaries);
   for(const [i,sign]of [-1,1].entries())add('atr-band-'+sign,`EMA ${fast} ${sign>0?'+':'−'} 2 ATR`,`EMA ${fast} ${sign>0?'+':'−'} 2 ATR`,sign>0?'#ff9a2b':'#4dff7a',boundaries[i]);
  }
  checks.push({key:'rsi',zh:`RSI ${rsiLength} · Wilder`,en:`RSI ${rsiLength} · Wilder`,value:r});
  if(['S02','S03'].includes(plan.id)&&period==='5m'){
   const cross=Number(p.rsi_cross),ceiling=Number(p.rsi_ceiling);
   checks.push({key:'rsi-cross',zh:`RSI 上穿 ${cross} 且 ≤ ${ceiling}`,en:`RSI crosses ${cross}, ≤ ${ceiling}`,value:rsi.at(-2).value<=cross&&r>cross&&r<=ceiling});
  }
 }
 if(['structure','range','trend'].includes(kind)){
  const n=Number(p.range_lookback||p.breakout_lookback)||20,window=bars.slice(-n-1,-1);
  for(const [side,color]of [['high','#ff9a2b'],['low','#4dff7a']])horizontal('prior-'+side,`前 ${n} 根${side==='high'?'高点':'低点'}`,`Prior ${n}-bar ${side}`,color,side==='high'?Math.max(...window.map(b=>b.high)):Math.min(...window.map(b=>b.low)),window[0].time);
 }
 if(kind==='structure'){
  const indexes=new Map(bars.map((bar,i)=>[bar.time,i]));
  if(plan.id!=='BASE')for(const line of base.lines.filter(line=>line.key==='vwap'))lines.push(line);
  for(const [side,color]of [['high','#a24dff'],['low','#3dd5ff']]){
   const pivots=base.pivots[side].slice(-6),lastPairs=[];
   for(let j=pivots.length-1;j>0;j--)for(let i=j-1;i>=0;i--){
    const first=pivots[i],second=pivots[j],start=indexes.get(first.time),slope=(second.value-first.value)/(indexes.get(second.time)-start);
    if(side==='high'?slope>=0:slope<=0)continue;
    // The chart spaces observed candles equally, including across closed sessions.
    const crossed=bars.some((b,k)=>k>=start&&(side==='high'?b.high>first.value+slope*(k-start)+1e-8:b.low<first.value+slope*(k-start)-1e-8));
    if(!crossed)lastPairs.push([first,second,{time:last.time,value:first.value+slope*(bars.length-1-start),confirmedAt:second.confirmedAt}]);
   }
   lastPairs.slice(0,2).forEach((points,i)=>add(`swing-${side}-${i}`,side==='high'?'未破下降阻力':'未破上升支撑',side==='high'?'Unbroken falling resistance':'Unbroken rising support',color,points));
   const intact=pivots.filter(pivot=>bars.every(b=>b.time<=pivot.time||(side==='high'?b.high<=pivot.value:b.low>=pivot.value))).slice(-2);
   intact.forEach((pivot,i)=>horizontal(`level-${side}-${i}`,side==='high'?'确认阻力位':'确认支撑位',side==='high'?'Confirmed resistance':'Confirmed support',color,pivot.value,pivot.time));
  }
  if(plan.id==='BASE'){
   lines.push(...confirmedPriceZones(bars,base.pivots,a,{seconds,sessionBased:plan.sessionBased}));
   lines.push(...confirmedStructureBreaks(bars,base.pivots,{seconds,sessionBased:plan.sessionBased}).filter(line=>line.confirmedAt>bars[Math.max(0,bars.length-80)].time).slice(-2));
   const anchors=[base.pivots.high.at(-1),base.pivots.low.at(-1)].filter(Boolean).sort((a,b)=>a.time-b.time);
   if(anchors.length===2){
    const [first,end]=anchors,low=Math.min(first.value,end.value),high=Math.max(first.value,end.value),span=high-low;
    const intact=bars.every(b=>b.time<=end.time||b.low>=low&&b.high<=high);
    if(span>=2*a&&bars.findIndex(b=>b.time===end.time)-bars.findIndex(b=>b.time===first.time)>=3&&intact){
     add('fib-anchor','确认摆动锚点','Confirmed swing anchors','#a24dff',anchors);
     for(const [ratio,color]of [[.382,'#3dd5ff'],[.5,'#4a6bff'],[.618,'#a24dff']]){
      horizontal(`fib-${ratio}`,`摆动回撤 ${ratio}`,`Swing retracement ${ratio}`,color,end.value+(first.value-end.value)*ratio,end.time);
      lines.at(-1).label=String(ratio);
     }
     for(const [from,to,color]of [[0,.382,'#3dd5ff'],[.382,.618,'#4a6bff'],[.618,1,'#a24dff']]){
      const values=[from,to].map(ratio=>end.value+(first.value-end.value)*ratio).sort((a,b)=>a-b),times=[end.time,last.time];
      if(end.time<last.time)band(`fib-area-${from}`,`摆动回撤 ${from}–${to}`,`Swing retracement ${from}–${to}`,color,times.map(time=>({time,value:values[0]})),times.map(time=>({time,value:values[1]})),{surface:'retracement',confirmedAt:Math.max(...anchors.map(p=>p.confirmedAt))});
     }
    }
   }
  }
 }
 if(kind==='value'&&plan.id==='BASE'){
  const anchor=base.pivots[last.close>=e?'low':'high'].at(-1),envelope=anchoredVolumeEnvelope(bars,anchor,{seconds,sessionBased:plan.sessionBased}),points=envelope.map(({time,value})=>({time,value}));
  if(points.length>1){
   lines.push({key:'anchored-vwap',zh:'确认摆点锚定 VWAP',en:'Confirmed-pivot anchored VWAP',label:'aVWAP',color:'#ffd84d',points,anchorTime:anchor.time,confirmedAt:anchor.confirmedAt});
   for(const [sigma,color]of [[2,'#a24dff'],[1,'#3dd5ff']])band(`vwap-envelope-${sigma}`,`锚定 VWAP ±${sigma}σ`,`Anchored VWAP ±${sigma}σ`,color,envelope.map(row=>({time:row.time,value:row.value-sigma*row.deviation})),envelope.map(row=>({time:row.time,value:row.value+sigma*row.deviation})),{anchorTime:anchor.time,confirmedAt:anchor.confirmedAt});
  }
  const gaps=unfilledPriceGaps(bars,atr,{seconds,sessionBased:plan.sessionBased}).filter(line=>line.confirmedAt>bars[Math.max(0,bars.length-80)].time).slice(-2);
  lines.push(...gaps);checks.push({key:'open-gaps',zh:'近期未回补缺口',en:'Recent unfilled gaps',value:gaps.length});
 }
 const regime=plan.id==='S02'&&period===tf(p.regime_tf),hourFilter=plan.id==='S03'&&plan.variant==='E01'&&period==='1H';
 if(regime||hourFilter)checks.push({key:'trend',zh:`EMA ${fast} ≥ EMA ${slow}`,en:`EMA ${fast} ≥ EMA ${slow}`,value:e>=es});
 else if(plan.id!=='S02')checks.push({key:'trend',zh:`EMA ${fast} > EMA ${slow}`,en:`EMA ${fast} > EMA ${slow}`,value:e>es});
 if(hourFilter)checks.push({key:'ema-slope',zh:`EMA ${slow} ≥ 3 根前`,en:`EMA ${slow} ≥ 3 bars earlier`,value:es>=emaSlow.at(-4).value});
 if(!p.atr_tf||tf(p.atr_tf)===period)checks.push({key:'atr',zh:`${period} ATR ${atrLength} / 收盘价`,en:`${period} ATR ${atrLength} / close`,value:a/last.close*100,unit:'%'});
 if(plan.id==='S03'&&period==='5m')checks.push({key:'above-ema',zh:'收盘价在 EMA20 上方',en:'Close above EMA20',value:last.close>e},{key:'volatility',zh:'ATR 波动范围 0.1%–2%',en:'ATR range 0.1%–2%',value:a/last.close>=Number(p.volatility_min)&&a/last.close<=Number(p.volatility_max)});
 return {...checked,closedAt,lines,oscillators:kind==='momentum'?[{key:'rsi',zh:`RSI ${rsiLength}`,en:`RSI ${rsiLength}`,color:'#4a6bff',points:rsi}]:[],checks,metrics:{emaFast:e,emaSlow:es,atr:a,rsi:r},methodVersion:'closed-market-v3',planRef:plan.ref||'BASE',period};
}

export function marketScatterSample(input,now=Date.now()/1000,{sessionBased=false}={}){
 const checked=validatedBars(input,'1D',now,250,sessionBased);if(checked.state!=='ready')return {...checked,bars:checked.bars.length};
 const bars=checked.bars,last=bars.at(-1),ema=exponentialAverage(bars,20),{atr,rsi}=wilderSeries(bars,14),range=atr.at(-1).value;
 if(!Number.isFinite(range)||range<=0)return {state:'no-range',bars:bars.length};
 const e=new Map(ema.map(p=>[p.time,p.value])),a=new Map(atr.map(p=>[p.time,p.value])),r=new Map(rsi.map(p=>[p.time,p.value]));
 const history=bars.slice(-5).filter(b=>a.get(b.time)>0).map(b=>({time:b.time,x:(b.close-e.get(b.time))/a.get(b.time),y:r.get(b.time)}));
 const value=history.at(-1),prior=bars.slice(-21,-1),high=Math.max(...prior.map(b=>b.high)),low=Math.min(...prior.map(b=>b.low));
 const signal=last.close>high?'breakout-up':last.close<low?'breakout-down':value.y>=70?'overbought':value.y<=30?'oversold':'balanced';
 return {state:'ready',x:value.x,y:value.y,price:last.close,change:(last.close/bars.at(-2).close-1)*100,priceSeries:bars.slice(-18).map(bar=>bar.close),signal,history,closedAt:checked.closedAt,sampleAt:last.time,validUntil:checked.validUntil,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:bars.length};
}

export function createMarketScanner(onChange,{subscribe=subscribeCandles,subscribeDepth=null,now=()=>Date.now()/1000}={}){
 const entries=new Map();let enabled=false;
 function stop(entry){entry.stop?.();entry.depthStop?.();entry.stop=null;entry.depthStop=null;entry.token++;}
 return {
  update(assets,active){
   enabled=active;const symbols=new Set(assets.map(asset=>asset.symbol));
   for(const [symbol,entry]of entries)if(!symbols.has(symbol)){stop(entry);entries.delete(symbol);}
   for(const asset of assets){
    let entry=entries.get(asset.symbol);if(!entry){entry={symbol:asset.symbol,token:0,bars:[],sample:{state:'loading'},meta:{},stop:null};entries.set(asset.symbol,entry);}
    const request=candleRequest(asset.domain==='Crypto'?{market:asset.symbol+'/USDT',period:'1D'}:{market:asset.symbol,period:'1D',profileId:'public-market',venueId:asset.symbol==='XAU'?'dukascopy':'yahoo'});
    if(!request){entry.sample={state:'unsupported'};continue;}
    if(!active){if(entry.stop||entry.depthStop)stop(entry);continue;}if(entry.stop)continue;
    const token=++entry.token;entry.sample={...entry.sample,state:'loading'};entry.meta={...entry.meta,source:request.source||'Binance Spot',timezone:request.timezone||'UTC',unit:request.unit||'USDT'};
    if(subscribeDepth&&asset.domain==='Crypto'){
     entry.depthState='loading';
     entry.depthStop=subscribeDepth(asset.symbol,{onSnapshot:snapshot=>{if(token!==entry.token||!enabled)return;entry.depthSnapshot=snapshot;entry.depthState='ready';onChange();},onStatus:status=>{if(token!==entry.token||!enabled)return;entry.depthState=status.state;onChange();}});
    }
    const calculate=()=>{const sample=marketScatterSample(entry.bars,now(),request),fresh=sample.state==='ready'&&(sample.closedAt!==entry.sample.closedAt||sample.signal!==entry.sample.signal);entry.sample={...sample,freshAt:fresh?now():entry.sample.freshAt};onChange();};
    entry.stop=subscribe(request,{onSnapshot:bars=>{if(token!==entry.token||!enabled)return;entry.bars=bars;calculate();},onBar:bar=>{
     if(token!==entry.token||!enabled)return;entry.bars=mergeCandle(entry.bars,bar,request.seconds);
     if(entry.sample.state!=='ready'||entry.sample.closedAt!==Math.floor(now()/86400)*86400)calculate();
    },onStatus:status=>{
     if(token!==entry.token||!enabled)return;
     // Starting a poll supplies no new receipt. rows() still checks the previous sample's expiry.
     if(request.sessionBased&&status.state==='refreshing'){onChange();return;}
     const {state,...meta}=status;entry.meta={...entry.meta,...meta,feedState:state};
     if(state==='live')entry.meta.quoteAsOf=status.asOf/1000;
     if(['snapshot','live'].includes(state))entry.meta.activityAt=now();
     if(['error','stale','reconnecting'].includes(state))entry.sample={...entry.sample,state};onChange();
    }});
   }
  },
  rows(){return [...entries.values()].map(entry=>{const sample=entry.sample;return {symbol:entry.symbol,...entry.meta,...sample,state:sample.state==='ready'&&now()>sample.validUntil?'stale':sample.state,paused:!enabled,depthState:entry.depthState==='ready'&&now()*1000>=entry.depthSnapshot?.validUntil?'stale':entry.depthState||'unsupported',depthSnapshot:entry.depthSnapshot||null};});},
  dispose(){enabled=false;for(const entry of entries.values())stop(entry);entries.clear();}
 };
}
