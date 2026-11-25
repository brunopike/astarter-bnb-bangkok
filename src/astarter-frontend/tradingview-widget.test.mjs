import test from 'node:test';
import assert from 'node:assert/strict';
import {hostedChartSymbol,hostedChartOptions,hostedChartPanel,mountHostedChart} from './tradingview-widget.mjs';
import {tradingChartPanel,chartSourceTime,chartTickLabel,chartStudyAvailable,chartQuoteSnapshot,readTradingChartQuote,formatTradingPrice,chartAnalysisTaskView} from './trading-chart.mjs';

const market={hostedMarket:true,market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',period:'15m'};
test('hosted charts require explicit public spot identity and exclude bound chart data',()=>{
 assert.equal(hostedChartSymbol(market),'BINANCE:BTCUSDT');
 for(const change of [{hostedMarket:false},{venueId:'okx'},{profileId:'cex-perp'},{market:'BTC/USD'},{market:'BTCUSDT"<script>'},{market:'SPX'},...['trade','paper','recorded','identity','planRef','gridPreview','gridPlan','analysisLayers','analysisTask','snapshotError'].map(key=>({[key]:{}}))])assert.equal(hostedChartSymbol({...market,...change}),null);
 assert.throws(()=>hostedChartOptions({...market,recorded:{}}),/PUBLIC_MARKET/);
});
test('native TradingView controls stay available without a forced indicator or symbol drift',()=>{
 const options=hostedChartOptions(market,{theme:'light',locale:'zh'});
 assert.equal(options.interval,'15');assert.equal(options.locale,'zh_CN');assert.equal(options.theme,'light');
 for(const key of ['hide_side_toolbar','hide_top_toolbar','hide_legend','hide_volume','allow_symbol_change'])assert.equal(options[key],false);
 assert.deepEqual(options.studies,[]);assert.equal(options.save_image,true);assert.equal(options.withdateranges,true);
 const html=hostedChartPanel('test',market);assert.match(html,/data-tv-retry[^>]*hidden[^>]*disabled/);assert.match(html,/data-tv-switch[^>]*hidden/);assert.match(html,/tradingview.com\/chart/);assert.doesNotMatch(html,/MA 20|data-tc-action="ma"|>当前市场行情<|>Current market data</);
 assert.doesNotMatch(tradingChartPanel('native'),/MA 20|data-tc-action="ma"/);
 assert.match(tradingChartPanel('study',{analysisLayers:true}),/trading-analysis-key/);
});
test('session dates use source timezone, including the UTC date boundary',()=>{
 const time=Date.parse('2026-11-07T01:30:00Z')/1000;
 assert.equal(chartSourceTime(time,'America/New_York'),'2026-11-06 20:30:00');
 assert.equal(chartTickLabel(time,2,'1D','America/New_York'),'11-06');
 assert.equal(chartSourceTime(time,'UTC'),'2026-11-07 01:30:00');
 assert.equal(chartSourceTime(undefined,'UTC'),'—');
});
test('only opted-in creation charts expose the instrument picker',()=>{
 const html=tradingChartPanel('create-picker',{market:'ETH/USDT',instrumentPicker:true,identity:{accountId:'SIM-01',instrumentId:'binance:SPOT:ETH/USDT'}});
 assert.match(html,/<button type="button" class="trading-chart-identity trading-chart-instrument" data-tc-action="choose-instrument" aria-haspopup="dialog"/);
 assert.match(html,/<strong>ETH\/USDT<\/strong>/);
 assert.doesNotMatch(tradingChartPanel('ordinary-read-only'),/data-tc-action="choose-instrument"/);
});
test('daily background refresh retains only the verified, unexpired study',()=>{
 const status={state:'refreshing',closedAt:100},bars=[{closedAt:100,validUntil:200},{closedAt:300,validUntil:400}];
 assert.equal(chartStudyAvailable(status,bars,150),true);
 assert.equal(chartStudyAvailable(status,bars,201),false);
 assert.equal(chartStudyAvailable({...status,closedAt:99},bars,150),false);
 assert.equal(chartStudyAvailable({state:'refreshing'},bars,150),false);
 assert.equal(chartStudyAvailable({state:'stale',closedAt:100},bars,150),false);
});
test('draft reference quotes use the full mounted feed and reject stale or unsupported sources',()=>{
 const config={...market,period:'1m'},bars=[{time:0,close:100},{time:60,close:103},{time:120,close:105}],now=121000,status={state:'live',asOf:now};
 assert.deepEqual(chartQuoteSnapshot(config,bars,status,now),{market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',period:'1m',price:105,closedPrice:103,closedAt:120000,asOf:now,state:'live'});
 assert.equal(chartQuoteSnapshot(config,bars,{...status,state:'snapshot'},now).closedPrice,103);
 assert.equal(chartQuoteSnapshot(config,bars,{state:'live',asOf:179000},181000).closedPrice,103);
 assert.equal(chartQuoteSnapshot(config,bars,{state:'live',asOf:180000},181000).closedPrice,105);
 for(const state of ['loading','reconnecting','refreshing','stale','error'])assert.throws(()=>chartQuoteSnapshot(config,bars,{...status,state},now),/MARKET_NOT_READY/);
 for(const asOf of [now-30001,now+30001,undefined])assert.throws(()=>chartQuoteSnapshot(config,bars,{...status,asOf},now),/MARKET_NOT_READY/);
 for(const invalid of [{venueId:'okx'},{profileId:'cex-perp'},{market:'SPX',profileId:'public-market',venueId:'yahoo',period:'1D'}])assert.throws(()=>chartQuoteSnapshot({...config,...invalid},bars,status,now),/MARKET_NOT_READY/);
 for(const data of [[],bars.slice(-1),bars.slice(0,1),[{time:180,close:105}],[...bars.slice(0,2),{time:120,close:NaN}]])assert.throws(()=>chartQuoteSnapshot(config,data,status,now),/MARKET_NOT_READY/);
 const result=chartQuoteSnapshot(config,bars,status,now);result.closedPrice=0;assert.equal(bars[1].close,103);
 assert.throws(()=>readTradingChartQuote(null),/MARKET_NOT_READY/);
});
test('shared price display keeps the renderer precision without altering source values',()=>{
 const value=75644.635;
 assert.equal(formatTradingPrice(value,'en'),'75,644.64');assert.equal(value,75644.635);
 assert.equal(formatTradingPrice(0.00000456789,'zh'),'0.00000457');assert.equal(formatTradingPrice(0.157567,'en'),'0.1576');
 assert.equal(formatTradingPrice(1234.5,'de'),'1.234,5');assert.equal(formatTradingPrice(0,'en'),'0');
 for(const invalid of [NaN,Infinity,-Infinity,undefined,null,'1.2'])assert.equal(formatTradingPrice(invalid,'en'),'—');
});
test('unavailable hosted transport shows an actionable error; disposal aborts a pending retry',async()=>{
 const previous={document:globalThis.document,MutationObserver:globalThis.MutationObserver,fetch:globalThis.fetch};let retry,requestSignal,disconnects=0,clears=0,fallbacks=0,disposedFallbacks=0;
 const slot={replaceChildren(){clears++;}},message={},stage={setAttribute(){}},basic={},switchButton={addEventListener(){}},button={addEventListener(type,fn){retry=fn;}},host={dataset:{},querySelector(selector){return {'.tradingview-widget-container':slot,'.trading-chart-hosted-message':message,'.trading-chart-hosted-stage':stage,'.trading-chart-hosted-fallback':basic,'[data-tv-switch]':switchButton,'[data-tv-retry]':button}[selector];}};
 let cleanup;
 try{
  globalThis.document={documentElement:{dataset:{theme:'dark'}}};globalThis.MutationObserver=class{observe(){}disconnect(){disconnects++;}};
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://www.tradingview-widget.com/embed-widget/advanced-chart/');assert.equal(options.credentials,'omit');throw Error('offline');};
  cleanup=mountHostedChart(host,market,{fallback(){fallbacks++;return ()=>{disposedFallbacks++;};}});assert.equal(button.hidden,true);assert.equal(button.disabled,true);assert.equal(switchButton.hidden,true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.dataset.chartState,'error');assert.equal(message.hidden,false);assert.match(message.textContent,/TradingView/);
  assert.equal(button.hidden,false);assert.equal(button.disabled,false);assert.equal(switchButton.hidden,true);
  assert.equal(fallbacks,1);assert.equal(host.dataset.chartView,'basic');assert.equal(basic.hidden,false);assert.equal(stage.inert,true);await retry();assert.equal(fallbacks,1);assert.equal(disposedFallbacks,0);
  let requests=0,focuses=0;const canvas={focus(options){assert.equal(options.preventScroll,true);focuses++;globalThis.document.activeElement=canvas;}};basic.querySelector=()=>canvas;globalThis.document.activeElement=button;
  globalThis.fetch=(url,{signal})=>{requests++;requestSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));};
  const pending=retry(),duplicate=retry();assert.equal(requests,1);assert.equal(button.hidden,true);assert.equal(button.disabled,true);assert.equal(focuses,1);cleanup();cleanup=null;await Promise.all([pending,duplicate]);
  assert.equal(requestSignal.aborted,true);assert.ok(disconnects>0);assert.ok(clears>=3);assert.equal(host.dataset.chartState,'loading');assert.equal(disposedFallbacks,1);
 }finally{cleanup?.();for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
test('an iframe load never replaces or destroys an available basic chart without the user switching',async()=>{
 const previous={document:globalThis.document,MutationObserver:globalThis.MutationObserver,fetch:globalThis.fetch};
 const node=()=>({style:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(){},removeAttribute(){},append(){}});
 const stage=node(),basic=node(),message=node(),toggle=node(),retry=node(),frame=node();let created=0,disposed=0;
 frame.contentDocument={querySelector:()=>({})};const slot={replaceChildren(){},append(){}};
 const host={dataset:{},querySelector:selector=>({'.tradingview-widget-container':slot,'.trading-chart-hosted-message':message,'.trading-chart-hosted-stage':stage,'.trading-chart-hosted-fallback':basic,'[data-tv-switch]':toggle,'[data-tv-retry]':retry}[selector])};
 let cleanup,remount;
 try{
  globalThis.document={documentElement:{dataset:{theme:'dark'}},createElement:()=>frame};
  globalThis.MutationObserver=class{constructor(callback){remount=callback;}observe(){}disconnect(){}};
  globalThis.fetch=async()=>{throw Error('offline');};
  cleanup=mountHostedChart(host,market,{fallback(){created++;return ()=>disposed++;}});await new Promise(resolve=>setImmediate(resolve));
  globalThis.fetch=async()=>({type:'opaque'});await retry.listeners.click();frame.listeners.load();
  assert.equal(host.dataset.chartState,'embedded');assert.equal(host.dataset.chartView,'basic');assert.equal(created,1);assert.equal(disposed,0);assert.equal(toggle.disabled,false);assert.equal(toggle.hidden,false);assert.equal(retry.hidden,true);
  toggle.listeners.click();assert.equal(host.dataset.chartView,'widget');assert.equal(basic.hidden,true);assert.equal(basic.inert,true);assert.equal(stage.inert,false);assert.equal(disposed,0);
  toggle.listeners.click();assert.equal(host.dataset.chartView,'basic');assert.equal(created,1);assert.equal(basic.hidden,false);assert.equal(stage.inert,true);
  toggle.listeners.click();assert.equal(host.dataset.chartView,'widget');await retry.listeners.click();assert.equal(host.dataset.chartView,'widget','a hidden retry cannot reset a healthy widget');const pending=remount();assert.equal(host.dataset.chartView,'basic');await pending;
  frame.contentDocument={querySelector:()=>null};frame.listeners.load();assert.equal(host.dataset.chartState,'error');assert.equal(host.dataset.chartView,'basic');
  cleanup();cleanup=null;assert.equal(disposed,1);
 }finally{cleanup?.();for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
test('one three-second budget covers transport and frame loading, and ignores a late frame',async()=>{
 const previous={document:globalThis.document,MutationObserver:globalThis.MutationObserver,fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
 const node=()=>({style:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(){}});
 const stage=node(),basic=node(),message=node(),toggle=node(),retry=node(),frame=node();let deadline,signal,created=0,deadlineCount=0;
 frame.contentDocument={querySelector:()=>({})};const slot={replaceChildren(){},append(){}};
 const host={dataset:{},querySelector:selector=>({'.tradingview-widget-container':slot,'.trading-chart-hosted-message':message,'.trading-chart-hosted-stage':stage,'.trading-chart-hosted-fallback':basic,'[data-tv-switch]':toggle,'[data-tv-retry]':retry}[selector])};
 let cleanup,releaseTransport;
 try{
  globalThis.document={documentElement:{dataset:{theme:'dark'}},createElement:tag=>{assert.equal(tag,'iframe');return frame;}};
  globalThis.MutationObserver=class{observe(){}disconnect(){}};
  globalThis.setTimeout=(fn,ms)=>{assert.equal(ms,3000);deadline=fn;deadlineCount++;return 1;};globalThis.clearTimeout=()=>{};
  globalThis.fetch=(url,options)=>{signal=options.signal;return new Promise(resolve=>releaseTransport=resolve);};
  cleanup=mountHostedChart(host,market,{fallback(){created++;return ()=>{};}});
  assert.equal(created,1);assert.equal(host.dataset.chartView,'basic');assert.equal(basic.hidden,false);assert.equal(host.dataset.chartState,'loading');
  releaseTransport({type:'opaque'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(deadlineCount,1);assert.equal(typeof frame.listeners.load,'function');
  deadline();assert.equal(host.dataset.chartState,'error');assert.equal(signal.aborted,true);assert.equal(basic.hidden,false);
  assert.match(frame.srcdoc,/s3.tradingview.com\/external-embedding\/embed-widget-advanced-chart.js/);
  frame.listeners.load();assert.equal(host.dataset.chartState,'error');assert.equal(toggle.disabled,true);assert.equal(created,1);
 }finally{cleanup?.();for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});


test('analysisTask zones retain source geometry, range and distinct confirmation metadata',()=>{
 const line={key:'gap',kind:'zone',zh:'缺口',en:'Gap',color:'#4dff7a',range:[101,104],confirmedAt:300,points:[{time:100,value:101},{time:100,value:104},{time:400,value:104},{time:400,value:101},{time:100,value:101}]},before=structuredClone(line);
 const view=chartAnalysisTaskView([line],{kind:'value',x:t=>t/10,y:v=>200-v,formatPrice:String,formatTime:t=>'T'+t});
 assert.match(view.geometry,/class="analysis-zone"/);assert.match(view.geometry,/M10.00,99.00 L10.00,96.00 L40.00,96.00 L40.00,99.00 L10.00,99.00 Z/);
 assert.match(view.geometry,/data-confirmed-at="300"/);assert.match(view.legend,/101 – 104/);assert.match(view.legend,/T300/);
 assert.doesNotMatch(view.geometry,/analysis-packet/);assert.deepEqual(line,before);
});
test('a missing chart coordinate never closes a false zone or bridges a broken line',()=>{
 const points=[{time:10,value:100},{time:20,value:103},{time:30,value:101}],options={kind:'structure',x:t=>t===20?null:t,y:v=>v,formatTime:String};
 const zone=chartAnalysisTaskView([{key:'gap',kind:'zone',zh:'区间',en:'Zone',range:[100,103],color:'#3dd5ff',points}],options);
 assert.equal(zone.geometry,'');assert.match(zone.legend,/100 – 103/);
 const line=chartAnalysisTaskView([{key:'swing-low-0',zh:'支撑',en:'Support',color:'#3dd5ff',points}],options);
 assert.match(line.geometry,/M10.00,100.00 M30.00,101.00/);assert.doesNotMatch(line.geometry,/NaN|Infinity/);
 assert.equal(chartAnalysisTaskView([{key:'invalid',points:[{time:10,value:NaN}]}],options).geometry,'');
});
test('shaded regions use chart-local paint IDs and stay behind price-derived lines',()=>{
 const zone={key:'atr-envelope',kind:'zone',surface:'cloud',zh:'波动带',en:'Envelope',color:'#3dd5ff',range:[99,102],points:[{time:10,value:99},{time:20,value:100},{time:20,value:102},{time:10,value:101}]};
 const line={key:'ema-fast',zh:'EMA',en:'EMA',points:[{time:10,value:100},{time:20,value:101}]},options={kind:'momentum',x:t=>t,y:v=>200-v};
 const a=chartAnalysisTaskView([line,zone],{...options,idPrefix:'chart-a'}),b=chartAnalysisTaskView([line,zone],{...options,idPrefix:'chart-b'});
 assert.ok(a.geometry.indexOf('data-analysis-kind="zone"')<a.geometry.indexOf('data-analysis-kind="line"'));
 assert.match(a.geometry,/data-analysis-surface="cloud"/);assert.match(a.geometry,/class="analysis-boundary"/);
 assert.match(a.geometry,/url\(#study-chart-a-atr-envelope\)/);assert.match(b.geometry,/url\(#study-chart-b-atr-envelope\)/);
 assert.doesNotMatch(b.geometry,/study-chart-a-/);assert.doesNotMatch(a.geometry,/NaN|Infinity|animation:|analysis-packet/);
});
test('anchor time, confirmation time and last sample remain separate; metadata is escaped',()=>{
 const line={key:'anchored-vwap',zh:'锚定 <VWAP>',en:'Anchored <VWAP>',color:'#ffd84d',anchorTime:0,confirmedAt:120,points:[{time:0,value:10},{time:180,value:12}]};
 const view=chartAnalysisTaskView([line],{kind:'value',x:t=>t,y:v=>v,formatTime:t=>'T'+t});
 assert.match(view.geometry,/data-anchor-time="0"/);assert.match(view.geometry,/data-confirmed-at="120"/);assert.match(view.geometry,/data-last-time="180"/);
 assert.match(view.legend,/T0/);assert.match(view.legend,/T120/);assert.match(view.legend,/&lt;VWAP&gt;/);assert.doesNotMatch(view.legend,/<VWAP>/);
 const swing=chartAnalysisTaskView([{...line,key:'swing-low-0',anchorTime:undefined,confirmedAt:undefined,points:[{time:0,value:10,confirmedAt:120},{time:180,value:12,confirmedAt:240}]}],{kind:'structure',x:t=>t,y:v=>v,formatTime:t=>'T'+t});
 assert.match(swing.geometry,/data-confirmed-at="240"/);assert.doesNotMatch(swing.geometry,/data-anchor-time/);
});
test('analysis emphasis keeps every level while distinguishing the current method',()=>{
 const lines=Array.from({length:13},(_,i)=>({key:i<2?'swing-'+(i?'low':'high')+'-0':'level-'+i,zh:'参考',en:'Reference',color:'#3dd5ff',points:[{time:0,value:100+i},{time:60,value:100+i}]}));
 const view=chartAnalysisTaskView(lines,{kind:'structure',x:t=>t,y:v=>v,formatTime:String});
 assert.equal((view.geometry.match(/<g /g)||[]).length,13);assert.equal((view.geometry.match(/data-emphasis="primary"/g)||[]).length,2);
 assert.equal((view.legend.match(/class="trading-analysis-item"/g)||[]).length,13);
});
test('analysis legends keep named measurements without teaching paragraphs',()=>{
 const lines=[{key:'ema-fast',zh:'EMA 20',en:'EMA 20',color:'#ffd84d',points:[{time:0,value:100},{time:60,value:101}]},{key:'anchored-vwap',zh:'锚定 VWAP',en:'Anchored VWAP',color:'#ffd84d',anchorTime:0,confirmedAt:60,points:[{time:0,value:100},{time:60,value:102}]}];
 const view=chartAnalysisTaskView(lines,{kind:'value',x:t=>t,y:v=>v,formatTime:t=>'T'+t});
 for(const value of ['EMA 20','VWAP','101','102','T0','T60'])assert.ok(view.legend.includes(value));
 assert.doesNotMatch(view.legend,/<p[ >]|递推|Wilder|未来目标|future targets/);
 assert.equal(Object.hasOwn(view,'note'),false);
});


test('current crypto and session-based analysis steps render without changing F1 studies',async()=>{
 const {computeMarketStudy,marketAnalysisPlan}=await import('./workbench-market-analysis.mjs');
 for(const sessionBased of [false,true]){
  const plan=marketAnalysisPlan({market:sessionBased?'SPX':'BTC/USDT',sessionBased});
  for(const step of plan.steps){
   const seconds=({'4H':14400,'1H':3600,'15m':900,'1D':86400})[step.period];
   const bars=Array.from({length:300},(_,i)=>{const value=100+Math.sin(i/7)*3+i/30;return {time:i*seconds,open:value,close:value+.2,high:value+1,low:value-1,volume:sessionBased?null:100+i,...sessionBased?{closedAt:(i+1)*seconds,validUntil:(i+2)*seconds}:{}};});
   const study=computeMarketStudy(bars,{...step,plan},300*seconds),before=structuredClone(study),indices=new Map(bars.map((bar,i)=>[bar.time,i]));
   assert.equal(study.state,'ready');const view=chartAnalysisTaskView(study.lines,{kind:step.kind,x:t=>indices.get(t)*6,y:v=>500-v,formatTime:String});
   assert.equal((view.geometry.match(/<g /g)||[]).length,study.lines.length);assert.doesNotMatch(view.geometry,/NaN|Infinity|analysis-packet/);assert.deepEqual(study,before);
   if(sessionBased)assert.doesNotMatch(view.legend,/anchored-vwap|锚定 VWAP/);
  }
 }
});


test('analysis step text has its own row and keeps one delegated resume control with the tools',()=>{
 const analysisTask={plan:{steps:[{period:'1H'}]}};
 const html=tradingChartPanel('study-toolbar',{analysisTask,analysisLayers:true});
 const periods=html.match(/<div class="trading-chart-periods"[^>]*>(.*?)<\/div>/s)[1];
 const controls=html.match(/<div class="trading-chart-tools">(.*?)<\/div>/s)[1];
 assert.match(periods,/trading-study-step/);assert.doesNotMatch(periods,/<button/);
 assert.equal((html.match(/data-tc-action="study-resume"/g)||[]).length,1);
 for(const action of ['study-resume','analysis','fit','refresh'])assert.ok(controls.includes(`data-tc-action="${action}"`));
 const native=tradingChartPanel('ordinary-toolbar');
 assert.match(native,/data-tc-period="1H"/);assert.doesNotMatch(native,/study-resume|trading-study-step/);
});



test('analysis labels and tested anchors remain attached to source geometry within the viewport',()=>{
 const zone={key:'pivot-zone-low',kind:'zone',label:'S <2>',zh:'支撑区',en:'Support zone',color:'#38d3c4',range:[100,101],confirmedAt:90,anchors:[{time:10,value:100},{time:50,value:101}],points:[{time:10,value:100},{time:10,value:101},{time:300,value:101},{time:300,value:100},{time:10,value:100}]};
 const view=chartAnalysisTaskView([zone],{kind:'structure',x:t=>t,y:v=>200-v,width:240,height:160,formatTime:String});
 assert.equal((view.geometry.match(/class="analysis-anchor"/g)||[]).length,2);
 assert.match(view.geometry,/class="analysis-label" x="228.00"/);assert.match(view.geometry,/S &lt;2&gt;/);assert.doesNotMatch(view.geometry,/>S <2>/);
 const outside=chartAnalysisTaskView([zone],{kind:'structure',x:t=>t,y:v=>-100,width:240,height:160});assert.doesNotMatch(outside.geometry,/analysis-label/);assert.match(outside.legend,/100 – 101/);
});


test('the hosted chart opens no message channel and leaves the research price beside it unchanged',async()=>{
 const previous={document:globalThis.document,MutationObserver:globalThis.MutationObserver,fetch:globalThis.fetch,window:globalThis.window,addEventListener:globalThis.addEventListener,onmessage:globalThis.onmessage};
 const added=[],listen=type=>{added.push(type);};
 const node=()=>({style:{},dataset:{},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;added.push(type);},setAttribute(){},removeAttribute(){},append(){}});
 const stage=node(),basic=node(),message=node(),toggle=node(),retry=node(),frame=node(),contentWindow={addEventListener:listen,postMessage(){}},win={addEventListener:listen,postMessage(){}};
 frame.contentWindow=contentWindow;frame.contentDocument={defaultView:contentWindow,querySelector:()=>({})};
 const price={dataset:{hubPrice:'bitcoin',price:'76000.12'},textContent:'76,000.12'},findPrice=selector=>String(selector).startsWith('[data-hub-price')?price:null,findPrices=selector=>findPrice(selector)?[price]:[];
 const parent={...node(),querySelector:findPrice,querySelectorAll:findPrices},slot={replaceChildren(){},append(){}};
 const host={...node(),parentElement:parent,closest:()=>parent,querySelector:selector=>({'.tradingview-widget-container':slot,'.trading-chart-hosted-message':message,'.trading-chart-hosted-stage':stage,'.trading-chart-hosted-fallback':basic,'[data-tv-switch]':toggle,'[data-tv-retry]':retry}[selector])};
 const handed=[];let cleanup,disposed=0;
 try{
  globalThis.window=win;globalThis.addEventListener=listen;
  globalThis.document={documentElement:{dataset:{theme:'dark'}},defaultView:win,addEventListener:listen,querySelector:findPrice,querySelectorAll:findPrices,createElement:tag=>{assert.equal(tag,'iframe');return frame;}};
  globalThis.MutationObserver=class{observe(){}disconnect(){}};
  globalThis.fetch=async()=>{throw Error('offline');};
  cleanup=mountHostedChart(host,market,{fallback(...args){handed.push(args);return ()=>{disposed++;};}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.dataset.chartState,'error');assert.equal(host.dataset.chartView,'basic');
  globalThis.fetch=async()=>({type:'opaque'});await retry.listeners.click();frame.listeners.load();
  assert.equal(host.dataset.chartState,'embedded');assert.equal(host.dataset.chartView,'basic');
  toggle.listeners.click();assert.equal(host.dataset.chartView,'widget');toggle.listeners.click();assert.equal(host.dataset.chartView,'basic');
  cleanup();cleanup=null;assert.equal(disposed,1);
  assert.equal(added.includes('message'),false,'no message listener on the page, the document or the chart frame');
  for(const target of [win,globalThis,contentWindow,frame])assert.equal(target.onmessage,undefined);
  assert.deepEqual(handed,[[]],'the basic chart is built once and handed nothing');
  assert.equal(price.textContent,'76,000.12');assert.equal(price.dataset.price,'76000.12');
  assert.deepEqual(Object.keys(host.dataset).filter(key=>/price|quote/i.test(key)),[]);
 }finally{cleanup?.();for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
