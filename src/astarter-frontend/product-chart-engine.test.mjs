import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCandleData,candleWindow,chartEngineOptions} from './product-chart-engine.mjs';
import {hubChartOption} from './market-hub-charts.mjs';
import {assistantBars} from './trading-assistant.mjs';
import {MARKET} from './data-center-fixtures.mjs';
import {analyzeBars} from './assistant-analysis.mjs';
import {tradingChartPanel,chartTickLabel,mountTradingCharts} from './trading-chart.mjs';
import {mountCharts,chartPanel} from './product-chart-ui.mjs';
import {attachChartSeriesLight,preserveChartLightBounds,applyChartSeriesLight} from './product-charts.mjs';

test('market axis distinguishes calendar boundaries from intraday time in the displayed timezone',()=>{
 const time=Date.UTC(2026,10,7,0,15)/1000;
 assert.equal(chartTickLabel(time,2,'1H'),'11-07');
 assert.equal(chartTickLabel(time,3,'1H'),'08:15');
 assert.equal(chartTickLabel(time,4,'1m'),'08:15:00');
 assert.equal(chartTickLabel(time,0,'1D'),'2026');
 assert.equal(chartTickLabel(time,1,'1D'),'2026-11');
 assert.equal(chartTickLabel(time,3,'1D'),'11-07');
 assert.equal(chartTickLabel(NaN,2,'1H'),null);
});

test('nested chart consumers mount one engine and only its owner disposes it',()=>{
 const prior={document:globalThis.document,MutationObserver:globalThis.MutationObserver,ResizeObserver:globalThis.ResizeObserver,cancelAnimationFrame:globalThis.cancelAnimationFrame};
 let mounted=0,disconnected=0;
 const node={hidden:true,addEventListener(){},setAttribute(){},textContent:''},host={dataset:{tradingChart:'nested-owner'},parentElement:null,isConnected:false,addEventListener(){},setAttribute(){},querySelector(){return node;}};
 const root={querySelectorAll:()=>[host]};let first,second,third;
 try{
  globalThis.document={documentElement:{},addEventListener(){}};globalThis.MutationObserver=class{observe(){mounted++;}disconnect(){disconnected++;}};globalThis.ResizeObserver=class{observe(){}disconnect(){disconnected++;}};globalThis.cancelAnimationFrame=()=>{};
  tradingChartPanel('nested-owner',{market:'ETH/USDT'});
  first=mountTradingCharts(root);second=mountTradingCharts(root);assert.equal(mounted,1);
  second();assert.equal(disconnected,0);first();first=null;assert.equal(disconnected,2);
  third=mountTradingCharts(root);assert.equal(mounted,2);third();third=null;assert.equal(disconnected,4);
 }finally{first?.();second?.();third?.();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('TradingView snapshot conversion preserves OHLC and UTC milliseconds at the public boundary',()=>{
 const time=Date.UTC(2026,9,24,6),data=[{time,open:100,high:105,low:98,close:102,volume:12},{time:time+3600000,open:102,high:106,low:101,close:104,volume:15}];
 const before=JSON.stringify(data),result=snapshotCandleData(data);
 assert.deepEqual(result[0],{time:time/1000,open:100,high:105,low:98,close:102});assert.equal(result[1].time-result[0].time,3600);assert.equal(JSON.stringify(data),before);
 assert.equal(snapshotCandleData([{...data[0],time:'2026-10-24T06:00:00.000Z'}])[0].time,time/1000);
 for(const rows of [[data[1],data[0]],[data[0],data[0]],[{...data[0],time:'not-a-date'}]])assert.throws(()=>snapshotCandleData(rows));
});
test('native pan and zoom map to the same existing analysis window without off-by-one expansion',()=>{
 assert.deepEqual(candleWindow({from:20,to:35},60),{start:20,count:16});
 assert.deepEqual(candleWindow({from:20.2,to:35.2},60),{start:20,count:16});
 assert.deepEqual(candleWindow({from:-10,to:80},60),{start:0,count:60});
 assert.equal(candleWindow({from:0,to:1},0),null);assert.equal(candleWindow({from:NaN,to:1},60),null);
});
test('AI assistant keeps the selected candles and calculated findings after the renderer changes',()=>{
 for(const period of ['1H','4H']){
  const bars=assistantBars(MARKET[0],period),start=2,count=8,selected=bars.slice(start,start+count),before=analyzeBars(selected);
  const rendered=snapshotCandleData(bars);assert.equal(rendered[start].time*1000,selected[0].time);assert.equal(rendered[start+count-1].time*1000,selected.at(-1).time);
  assert.deepEqual(analyzeBars(selected),before);assert.equal(before.count,count);
 }
});
test('a closed chart accepts the same draft version, clears invalid layers and changes identity without starting a feed',()=>{
 const identity={accountId:'SIM-01',connectionId:'C1',venueId:'binance',profileId:'cex-spot',marketType:'SPOT',environment:'DEMO',market:'BTC/USDT',instrumentId:'binance:SPOT:BTC/USDT',clockKind:'market'};
 tradingChartPanel('draft-contract',{identity,planRef:{id:'D1',version:1},market:identity.market});
 const error={hidden:true,textContent:''},parent={tagName:'DETAILS',open:false,parentElement:null,addEventListener(){}},host={dataset:{tradingChart:'draft-contract',candleCount:'300'},parentElement:parent,innerHTML:'',setAttribute(){},querySelector:()=>error};
 const root={querySelectorAll:selector=>selector==='[data-trading-chart]'?[host]:[]},oldDocument=globalThis.document,oldFetch=globalThis.fetch;let requests=0;
 globalThis.document={createElement:()=>{const template={content:{firstElementChild:null}};Object.defineProperty(template,'innerHTML',{set:html=>{template.content.firstElementChild={innerHTML:html.slice(html.indexOf('>')+1,html.lastIndexOf('</section>')),getAttribute:()=>''};}});return template;}};
 globalThis.fetch=()=>{requests++;throw Error('CLOSED_CHART_REQUEST');};
 let dispose;
 try{
  dispose=mountCharts(root);const draft={identity,planRef:{id:'D1',version:2},gridPlan:{lower:70000,upper:77000,count:15}};
  assert.equal(dispose.updateDraft('draft-contract',draft).ok,true);assert.equal(host.dataset.chartPlanVersion,'2');assert.equal(host.dataset.gridState,'pending');
  assert.equal(dispose.updateDraft('draft-contract',{...draft,gridPlan:{lower:80000,upper:77000,count:15}}).code,'INVALID_GRID');assert.equal(host.dataset.gridState,'invalid');assert.equal(error.hidden,false);
  const other={...identity,accountId:'SIM-02',connectionId:'C2',venueId:'okx',market:'ETH/USDT',instrumentId:'okx:SPOT:ETH/USDT'};
  assert.equal(dispose.updateDraft('draft-contract',{...draft,identity:other}).ok,true);assert.equal(host.dataset.chartAccount,'SIM-02');assert.equal(host.dataset.candleCount,undefined);assert.ok(host.innerHTML.includes('ETH/USDT'));assert.equal(host.innerHTML.includes('BTC/USDT'),false);
  assert.equal(dispose.updateDraft('draft-contract',{...draft,identity:{...identity,accountId:''}}).ok,false);assert.equal(host.dataset.chartAccount,undefined);assert.equal(requests,0);
  dispose();assert.equal(dispose.updateDraft('draft-contract',draft).code,'CHART_NOT_MOUNTED');
 }finally{dispose?.();if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;globalThis.fetch=oldFetch;}
});


test('series light renders through the installed SVG engine without touching values, axes or interaction series',async()=>{
 const {init}=await import('echarts');
 const p={ink:'#edf4ff',muted:'#8a96a8',line:'#273241',panel:'#10141d',up:'#37d59b',down:'#ff657f',accent:'#9c91ff',series:['#8dafff','#cc94ef','#71dfc0'],gold:'#f4c86c',font:'sans-serif',dark:true};
 const source=[{time:'A',value:-2},{time:'B',value:8},{time:'C',value:4}],before=structuredClone(source),format={label:String,axis:String,value:String};
 const chart=init(null,null,{renderer:'svg',ssr:true,width:390,height:280});
 const line=chartEngineOptions({data:source,kind:'line',title:'Flow',scale:'linear'},p,format);
 const bars=chartEngineOptions({data:source,kind:'bar',title:'Flow',scale:'linear'},p,format);
 const shares=hubChartOption('shares',[{name:'BTC',value:60},{name:'ETH',value:40}],p);
 try{
  for(const option of [line,bars,shares]){
   chart.setOption(option,{notMerge:true});const svg=chart.renderToSVGString();
   assert.match(svg,/<filter/);assert.match(svg,/<feDropShadow/);assert.doesNotMatch(svg,/<text[^>]*filter=/);assert.doesNotMatch(svg,/NaN|undefined/);
   assert.equal(option.series.length,1);assert.equal(option.animation,false);
   assert.equal(option.textStyle.shadowBlur,undefined);
  }
  assert.deepEqual(line.series[0].data,source.map(row=>row.value));
  assert.deepEqual(bars.series[0].data.map(row=>row.value),source.map(row=>row.value));
  assert.equal(bars.series[0].data[0].itemStyle.color,p.down);
  assert.equal(bars.series[0].data[0].itemStyle.shadowColor,p.down);
  assert.equal(bars.series[0].data[1].itemStyle.shadowColor,p.accent);
  assert.equal(line.series[0].silent,undefined);assert.equal(line.xAxis.axisLabel.shadowBlur,undefined);
  assert.equal(line.tooltip.axisPointer.lineStyle.shadowBlur,undefined);
  assert.equal(line.series[0].emphasis.itemStyle.shadowBlur,line.series[0].lineStyle.shadowBlur);
  const light=chartEngineOptions({data:source,kind:'line',title:'Flow',scale:'linear'},{...p,dark:false},format);
  assert.ok(light.series[0].lineStyle.shadowBlur<line.series[0].lineStyle.shadowBlur);
  assert.deepEqual(source,before);
 }finally{chart.dispose();}
});

test('data chart inspection selects the same sample at either pointer height without showing a cursor Y value',async()=>{
 const {init}=await import('echarts'),p={ink:'#eee',muted:'#999',line:'#333',panel:'#111',accent:'#83f',up:'#4f8',down:'#f65',font:'sans-serif'};
 const data=[{time:'A',value:-2},{time:'B',value:8},{time:'C',value:4}],before=structuredClone(data);
 for(const kind of ['line','bar']){
  const chart=init(null,null,{renderer:'svg',ssr:true,width:420,height:260});
  try{
   chart.setOption(chartEngineOptions({kind,data,title:'Value',scale:'linear'},p,{label:String,axis:String,value:String}));
   for(const y of [50,180]){
    chart.dispatchAction({type:'updateAxisPointer',currTrigger:'mousemove',x:150,y});
    const option=chart.getOption();assert.equal(option.xAxis[0].axisPointer.value,1);assert.equal(option.xAxis[0].axisPointer.status,'show');
    assert.notEqual(option.yAxis[0].axisPointer.status,'show','hover height must not create a second unrelated value');
    assert.deepEqual(option.xAxis[0].axisPointer.seriesDataIndices.map(point=>point.dataIndex),[1]);
   }
  }finally{chart.dispose();}
 }
 assert.deepEqual(data,before);
});

test('SVG fallback uses a vertical data cursor and reuses the readout until the sample changes',()=>{
 const prior={document:globalThis.document,ResizeObserver:globalThis.ResizeObserver};
 try{
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  for(const kind of ['line','bar']){
   let cursor=null,writes=0,markup='';const handlers=new Map(),plain=()=>({innerHTML:'',textContent:'',querySelectorAll:()=>[]});
   const svg={querySelector:()=>cursor,append:node=>{cursor=node;}},canvas={style:{},classList:{remove(){}},clientWidth:420,isConnected:false,setAttribute(){},addEventListener:(type,fn)=>handlers.set(type,fn),querySelector:selector=>selector==='svg'?svg:cursor,getBoundingClientRect:()=>({left:0,width:420})};
   Object.defineProperty(canvas,'innerHTML',{set(){cursor=null;}});
   const readout={setAttribute(){},get innerHTML(){return markup;},set innerHTML(value){markup=value;writes++;}};
   const nodes={'.chart-canvas':canvas,'.chart-readout':readout,'.chart-range input':{},'.chart-presets':plain(),'.chart-range-label':plain(),'.range-overview-plot':plain()};
   const host={dataset:{chart:'vertical-fallback-'+kind},querySelector:selector=>nodes[selector],querySelectorAll:()=>[]},root={querySelectorAll:selector=>selector==='[data-chart]'?[host]:[]};
   globalThis.document={documentElement:{},createElementNS:()=>({dataset:{},innerHTML:'',remove(){cursor=null;}})};
   chartPanel(host.dataset.chart,{title:'Flow',kind,values:[2,8,4],labels:['A','B','C']});
   const dispose=mountCharts(root);
   try{
    handlers.get('pointermove')({clientX:150,clientY:50});const first=cursor,firstWrites=writes;
    assert.equal(host.dataset.inspectedTime,'B');assert.match(markup,/8\.00/);
    const path=cursor.innerHTML.match(/<path d="([^"]+)"/)[1];assert.match(path,/V/);assert.doesNotMatch(path,/H/,'only a vertical inspection line belongs on data charts');
    assert.doesNotMatch(cursor.innerHTML,/<rect/,'value is already in the fixed readout');
    handlers.get('pointermove')({clientX:150,clientY:180});assert.equal(cursor,first);assert.equal(writes,firstWrites);
    handlers.get('pointermove')({clientX:330,clientY:100});assert.equal(host.dataset.inspectedTime,'C');assert.match(markup,/4\.00/);assert.ok(writes>firstWrites);
   }finally{dispose();}
  }
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('native shadow regions remain valid for flat SVG paths without changing unrelated filters',()=>{
 const attributes=new Map([['x','-100%'],['width','300%']]);
 const shadow={querySelector:name=>name==='feDropShadow',setAttribute:(key,value)=>attributes.set(key,value)};
 const unrelated={querySelector:()=>null,setAttribute:()=>assert.fail('unrelated filter changed')};
 preserveChartLightBounds({querySelectorAll:()=>[shadow,unrelated]});
 assert.equal(attributes.get('filterUnits'),'userSpaceOnUse');assert.equal(attributes.get('x'),'-100%');assert.equal(attributes.get('width'),'300%');
});

function nativePathFixture(specs){
 const children=[],ownerDocument={createElementNS:()=>makePath({})};
 const parent={insertBefore(node,next){node.remove();const i=next?children.indexOf(next):children.length;children.splice(i,0,node);node.parentNode=parent;}};
 function makePath(attributes,box={width:20,height:10}){
  const attrs=new Map(Object.entries(attributes)),properties=new Map();
  const node={ownerDocument,parentNode:null,box,boundsReads:0,
   getAttribute:key=>attrs.get(key)??null,hasAttribute:key=>attrs.has(key),setAttribute:(key,value)=>attrs.set(key,String(value)),removeAttribute:key=>attrs.delete(key),
   style:{getPropertyValue:key=>properties.get(key)||'',setProperty:(key,value)=>properties.set(key,value),removeProperty:key=>properties.delete(key)},
   getBBox(){this.boundsReads++;return this.box;},
   remove(){const i=children.indexOf(this);if(i!==-1)children.splice(i,1);this.parentNode=null;},
   get nextSibling(){return children[children.indexOf(this)+1]||null;}};
  node.classList={contains:name=>(attrs.get('class')||'').split(/\s+/).includes(name),toggle(name,on){const values=new Set((attrs.get('class')||'').split(/\s+/).filter(Boolean));on?values.add(name):values.delete(name);attrs.set('class',[...values].join(' '));}};
  return node;
 }
 const sources=specs.map(spec=>{const node=makePath(spec.attributes||spec,spec.box);parent.insertBefore(node,null);return node;});
 const host={querySelectorAll:()=>[...children]};
 return {host,sources,children,cores:()=>children.filter(node=>node.hasAttribute('data-chart-light-core'))};
}

test('native SVG light reuses exact clipped geometry and remains idempotent through repaint and removal',()=>{
 const tone='#3dd5ff',geometry={d:'M0 0L10 0L20 0',transform:'translate(4 8)','clip-path':'url(#visible)','stroke-dasharray':'3 4','stroke-dashoffset':'2',opacity:'.6'};
 const f=nativePathFixture([
  {...geometry,fill:'none',stroke:tone,filter:'url(#series-shadow)'},
  {d:'M0 1L20 1',fill:'none',stroke:tone},
  {attributes:{d:'M0 0L10 0L10 10Z',fill:tone,filter:'url(#series-shadow)'},box:{width:10,height:10}},
  {attributes:{d:'M0 0L10 0Z',fill:tone,filter:'url(#series-shadow)'},box:{width:10,height:0}},
 ]);
 applyChartSeriesLight(f.host,[tone]);const [core]=f.cores();
 assert.equal(f.cores().length,1);assert.equal(f.sources[0].nextSibling,core);
 for(const [key,value]of Object.entries(geometry)){assert.equal(core.getAttribute(key),value);assert.equal(f.sources[0].getAttribute(key),value);}
 assert.equal(core.getAttribute('pointer-events'),'none');assert.equal(core.getAttribute('aria-hidden'),'true');assert.equal(core.getAttribute('filter'),null);
 assert.equal(f.sources[1].classList.contains('chart-native-line'),false);assert.equal(f.sources[2].classList.contains('chart-native-fill'),true);assert.equal(f.sources[3].classList.contains('chart-native-fill'),false);
 applyChartSeriesLight(f.host,[tone]);assert.deepEqual(f.cores(),[core]);assert.equal(f.sources[2].boundsReads,1);
 f.sources[0].setAttribute('d','M0 0L20 4');f.sources[0].removeAttribute('clip-path');applyChartSeriesLight(f.host,[tone]);
 assert.equal(core.getAttribute('d'),'M0 0L20 4');assert.equal(core.getAttribute('clip-path'),null);
 f.sources[3].box.height=5;applyChartSeriesLight(f.host,[tone]);assert.equal(f.sources[3].classList.contains('chart-native-fill'),true);
 f.sources[0].setAttribute('stroke','#abcdef');applyChartSeriesLight(f.host,[tone]);assert.equal(f.cores().length,0);assert.equal(f.sources[0].style.getPropertyValue('--native-light-tone'),'');
 f.sources[0].setAttribute('stroke',tone);applyChartSeriesLight(f.host,[tone]);assert.equal(f.cores().length,1);f.sources[0].remove();applyChartSeriesLight(f.host,[tone]);assert.equal(f.cores().length,0);
});

test('native SVG zero and constant line cores copy installed renderer paths without adding data or filters',async()=>{
 const {init}=await import('echarts'),p={ink:'#edf4ff',muted:'#8a96a8',line:'#273241',panel:'#10141d',up:'#4dff7a',down:'#ff4b3e',accent:'#3dd5ff',font:'sans-serif',dark:true};
 const chart=init(null,null,{renderer:'svg',ssr:true,width:390,height:280});
 try{
  for(const value of [0,7]){
   const data=Array.from({length:9},(_,time)=>({time,value})),option=chartEngineOptions({data,kind:'line',title:'constant',scale:'linear'},p,{label:String,axis:String,value:String});
   chart.setOption(option,{notMerge:true});const svg=chart.renderToSVGString();
   const attrs=[...svg.matchAll(/<path\b([^>]*)>/g)].map(match=>Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item=>[item[1],item[2]])));
   const f=nativePathFixture(attrs);applyChartSeriesLight(f.host,[p.accent,p.up,p.down]);
   assert.equal(f.cores().length,1);const source=f.sources.find(path=>path.classList.contains('chart-native-line'));
   assert.equal(f.cores()[0].getAttribute('d'),source.getAttribute('d'));assert.equal(f.cores()[0].getAttribute('filter'),null);
   assert.deepEqual(option.series[0].data,data.map(row=>row.value));assert.equal(option.series.length,1);assert.equal(f.children.length,f.sources.length+1);
  }
 }finally{chart.dispose();}
});

test('native series light follows price/time transforms and detaches cleanly before remount',()=>{
 const host={ownerDocument:{documentElement:{dataset:{theme:'dark'}}}},draws=[],listeners=new Set();
 let xScale=10,yScale=2,primitive,requests=0,kind='Candlestick';
 let rows=[{time:1,open:10,close:12,high:13,low:9},{time:2,open:12,close:11,high:14,low:10}],original=structuredClone(rows);
 const options={visible:true,upColor:'#00ff88',downColor:'#ff5577',color:'#aabbff',lineWidth:1,base:0};
 const chart={timeScale:()=>({width:()=>200,options:()=>({barSpacing:xScale}),timeToCoordinate:t=>t*xScale})};
 const series={data:()=>rows,options:()=>options,seriesType:()=>kind,priceToCoordinate:v=>100-v*yScale,
  subscribeDataChanged:fn=>listeners.add(fn),unsubscribeDataChanged:fn=>listeners.delete(fn),
  attachPrimitive:p=>{primitive=p;p.attached({chart,series,requestUpdate:()=>requests++});},detachPrimitive:p=>p.detached()};
 const ctx={save(){},restore(){},beginPath(){},moveTo(x,y){draws.push(['move',x,y]);},lineTo(x,y){draws.push(['line',x,y]);},stroke(){},fillRect(x,y,w,h){draws.push(['rect',x,y,w,h,this.fillStyle]);}};
 const render=(view=0)=>{draws.length=0;primitive.updateAllViews();primitive.paneViews()[view].renderer().draw({useBitmapCoordinateSpace:fn=>fn({context:ctx,horizontalPixelRatio:2,verticalPixelRatio:2})});};
 const stop=attachChartSeriesLight(series,host);assert.equal(listeners.size,1);assert.equal(requests,1);
 assert.equal(primitive.paneViews()[0].zOrder(),'bottom');assert.equal(primitive.autoscaleInfo,undefined);assert.equal(primitive.hitTest,undefined);
 assert.equal(primitive.paneViews()[1].zOrder(),'top');
 render();assert.deepEqual(draws.filter(row=>row[0]==='rect').map(row=>row.at(-1)),[options.upColor,options.downColor]);
 assert.deepEqual(draws[0],['move',20,148]);assert.deepEqual(rows,original);
 xScale=20;yScale=3;render();assert.deepEqual(draws[0],['move',40,122]);
 options.visible=false;render();assert.equal(draws.length,0);options.visible=true;
 kind='Line';rows=[{time:1,value:0},{time:2},{time:3,value:0}];for(const fn of listeners)fn();render();
 assert.deepEqual(draws,[['move',40,200],['line',120,200]]);
 render(1);assert.deepEqual(draws,[['move',40,200],['line',120,200]]);assert.equal(ctx.lineWidth,1.2);assert.equal(ctx.globalAlpha,.5);assert.equal(ctx.shadowBlur,0);
 host.ownerDocument.documentElement.dataset.theme='light';render(1);assert.equal(ctx.globalAlpha,.26);host.ownerDocument.documentElement.dataset.theme='dark';
 kind='Histogram';rows=[{time:1,value:4,color:'#123456'},{time:2,value:-2,color:'#abcdef'}];for(const fn of listeners)fn();render();
 assert.deepEqual(draws.map(row=>row.at(-1)),['#123456','#abcdef']);
 render(1);assert.deepEqual(draws,[['move',30.4,176],['line',49.6,176],['move',70.4,212],['line',89.6,212]]);assert.equal(ctx.strokeStyle,'#abcdef');
 rows=[{time:1,value:0},{time:2,value:0}];for(const fn of listeners)fn();render();assert.equal(draws.length,0);render(1);assert.equal(draws.length,0);
 rows=[{time:1,value:4,color:'rgba(61,213,255,.35)'},{time:2,value:-2,color:'#abcdef'}];for(const fn of listeners)fn();render();assert.equal(draws[0].at(-1),'rgba(61,213,255,.35)');
 stop();stop();assert.equal(listeners.size,0);render();assert.equal(draws.length,0);
 render(1);assert.equal(draws.length,0);
 const stopAgain=attachChartSeriesLight(series,host);assert.equal(listeners.size,1);render();assert.equal(draws.length,2);stopAgain();assert.equal(listeners.size,0);
});
