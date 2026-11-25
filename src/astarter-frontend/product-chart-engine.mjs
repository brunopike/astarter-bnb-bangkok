import {pair as L} from './locale.mjs';
import {loadTradingChartLibrary,tradingChartPalette} from './trading-chart.mjs';
import {chartLightStyle,preserveChartLightBounds,applyChartSeriesLight,attachChartSeriesLight} from './product-charts.mjs';

let library;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
export function validChartRecords(c){return c.data.length>0&&c.data.every(d=>(typeof d.time==='number'?finite(d.time)&&Math.abs(d.time)<=8.64e15:typeof d.time==='string'&&d.time.trim().length>0)&&(c.kind==='candle'?['open','close','low','high'].every(k=>finite(d[k]))&&d.low<=Math.min(d.open,d.close)&&d.high>=Math.max(d.open,d.close):finite(d.value)));}

export function chartEngineOptions(c,p,format){
 const volume=c.kind==='candle'&&c.data.some(d=>finite(d.volume)&&d.volume>=0),indices=c.data.map((_,i)=>i);
 const x={type:'category',data:indices,boundaryGap:c.kind!=='line',axisTick:{show:false},axisLine:{show:false},axisLabel:{color:p.muted,fontSize:11,hideOverlap:true,formatter:i=>format.label(c.data[i]?.time)},axisPointer:{show:true,snap:true,animation:false,label:{show:true,backgroundColor:p.panel,color:p.ink,borderColor:p.line,borderWidth:1,borderRadius:4,padding:[4,6],fontSize:11,formatter:point=>format.label(c.data[Math.round(point.value)]?.time)}}};
 const y={type:c.scale==='log'&&c.kind!=='candle'&&c.data.every(d=>d.value>0)?'log':'value',scale:c.kind!=='bar',position:'right',splitNumber:4,axisTick:{show:false},axisLine:{show:false},axisLabel:{color:p.muted,fontSize:11,formatter:v=>format.axis(v)},splitLine:{lineStyle:{color:p.line,type:'dashed',opacity:.65}},axisPointer:{show:c.kind==='candle',label:{show:c.kind==='candle',backgroundColor:p.ink,color:p.panel,fontSize:11,formatter:point=>format.value(point.value)}}};
 const series=c.kind==='candle'?[{name:c.title,type:'candlestick',data:c.data.map(d=>[d.open,d.close,d.low,d.high]),itemStyle:{color:p.up,color0:p.down,borderColor:p.up,borderColor0:p.down},barMaxWidth:12}]:[{name:c.title,type:c.kind==='bar'?'bar':'line',data:c.data.map(d=>c.kind==='bar'?{value:d.value,itemStyle:{color:d.value<0?p.down:p.accent,...chartLightStyle(d.value<0?p.down:p.accent,p.dark),borderColor:d.value<0?p.down:p.accent,borderWidth:.5}}:d.value),symbol:'circle',showSymbol:c.data.length===1,symbolSize:6,smooth:false,lineStyle:{width:2.3,color:p.accent,...chartLightStyle(p.accent,p.dark)},itemStyle:{color:p.accent,...chartLightStyle(p.accent,p.dark)},areaStyle:c.kind==='bar'?undefined:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:p.accent},{offset:1,color:'rgba(0,0,0,0)'}]},opacity:p.dark?.18:.08},barMaxWidth:24,emphasis:{disabled:c.kind==='line',focus:'series',lineStyle:{width:2.8},itemStyle:{shadowBlur:p.dark?4:1.5}}}];
 if(volume)series.push({name:L('成交量','Volume'),type:'bar',xAxisIndex:1,yAxisIndex:1,data:c.data.map(d=>({value:finite(d.volume)&&d.volume>=0?d.volume:null,itemStyle:{color:d.close>=d.open?p.up:p.down,opacity:.45}})),barMaxWidth:12});
 return {animation:false,textStyle:{fontFamily:p.font,color:p.ink},grid:volume?[{left:8,right:80,top:12,bottom:76},{left:8,right:80,bottom:27,height:35}]:{left:8,right:80,top:12,bottom:27},tooltip:{trigger:'axis',showContent:false,axisPointer:{type:c.kind==='candle'?'cross':'line',axis:c.kind==='candle'?'auto':'x',snap:true,animation:false,lineStyle:{color:p.muted,type:'dashed',opacity:.7},crossStyle:{color:p.muted,type:'dashed',opacity:.7},label:{backgroundColor:p.ink,color:p.panel}}},axisPointer:{link:[{xAxisIndex:'all'}]},xAxis:volume?[{...x,axisLabel:{show:false},axisPointer:{...x.axisPointer,label:{...x.axisPointer.label,show:false}}},{...x,gridIndex:1}]:x,yAxis:volume?[y,{...y,gridIndex:1,scale:false,axisLabel:{show:false},splitLine:{show:false},axisPointer:{label:{show:false}}}]:y,dataZoom:[{id:'window',type:'inside',xAxisIndex:volume?[0,1]:[0],filterMode:'filter',startValue:0,endValue:c.data.length-1,minValueSpan:Math.min(7,c.data.length-1),zoomOnMouseWheel:'ctrl',moveOnMouseWheel:false,moveOnMouseMove:true,preventDefaultMouseMove:false,throttle:32}],series};
}

export function createChartEngine(canvas,{config:c,format,onRange,onInspect,onReady}){
 if(c.kind==='candle')return createSnapshotCandleEngine(canvas,{config:c,format,onRange,onInspect,onReady});
 let api,chart,disposed=false,failed=false,applying=false,current=null,skin='',observer,lightColors=[];const events=new AbortController();
 const controller={ready:false,update(range){
  current=range;if(!chart){if(api&&!failed&&!disposed)init();return;}
  const style=getComputedStyle(canvas),get=k=>style.getPropertyValue(k).trim(),theme=document.documentElement.dataset.theme;
  const key=[theme,canvas.clientWidth,get('--text'),get('--chart-accent')].join('|');
  applying=true;
  try{
   if(key!==skin){
    const color=c.color.match(/^var\((--[^,)]+)/)?.[1],palette={ink:get('--text')||get('--b-ink'),muted:get('--muted')||get('--b-muted'),panel:get('--surface')||get('--b-panel'),line:get('--line')||get('--b-line'),up:get('--signal-up')||get('--ok'),down:get('--signal-down')||get('--error'),accent:color?get(color):c.color,font:style.fontFamily,dark:theme==='dark'};
    lightColors=[palette.accent,palette.up,palette.down];
    chart.setOption(chartEngineOptions(c,palette,format),{notMerge:true,silent:true});skin=key;
   }
   const visible=c.data.slice(range.start,range.start+range.count),values=visible.flatMap(d=>c.kind==='candle'?[d.low,d.high]:[d.value]),step=(Math.max(...values)-Math.min(...values))/4;
   chart.setOption({dataZoom:[{id:'window',startValue:range.start,endValue:range.start+range.count-1}],yAxis:[{axisLabel:{formatter:v=>format.axis(v,step)}}]},{silent:true});chart.resize({width:canvas.clientWidth,height:c.height,silent:true});
  }finally{applying=false;}
 },inspect(index){if(chart)chart.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:index});},clear(){chart?.dispatchAction({type:'hideTip'});chart?.dispatchAction({type:'updateAxisPointer',currTrigger:'leave'});},dispose(){disposed=true;events.abort();canvas.classList.remove('is-dragging');observer?.disconnect();chart?.dispose();chart=null;controller.ready=false;}};
 function init(){
  if(disposed||failed||chart||!api||!canvas.isConnected||!canvas.clientWidth)return;
  canvas.innerHTML='';chart=api.init(canvas,null,{renderer:'svg'});chart.on('rendered',()=>{preserveChartLightBounds(canvas);applyChartSeriesLight(canvas,lightColors);});controller.ready=true;canvas.dataset.engine='echarts';canvas.style.touchAction='pan-y';
  canvas.addEventListener('pointerdown',()=>canvas.classList.add('is-dragging'),{signal:events.signal});
  for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>canvas.classList.remove('is-dragging'),{signal:events.signal});
  chart.on('datazoom',()=>{
   if(applying||!current)return;const zoom=chart.getOption().dataZoom[0],last=c.data.length-1;
   const start=Math.round((zoom.start??0)/100*last),end=Math.round((zoom.end??100)/100*last);
   onRange(start,end-start+1);
  });
  chart.on('updateAxisPointer',event=>{if(applying)return;const point=event.axesInfo?.find(a=>a.axisDim==='x');if(point&&finite(Number(point.value)))onInspect(Math.round(Number(point.value)));});
  observer=new MutationObserver(()=>{skin='';if(current)controller.update(current);});observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  onReady();
 }
 library??=import('./node_modules/echarts/dist/echarts.esm.min.mjs');library.then(module=>{api=module;init();}).catch(()=>{library=null;failed=true;observer?.disconnect();chart?.dispose();chart=null;controller.ready=false;if(!disposed){canvas.dataset.engine='svg-fallback';onReady();}});
 return controller;
}

export function snapshotCandleData(records){
 const data=records.map(record=>{
  const at=typeof record.time==='number'?record.time:Date.parse(record.time);
  if(!Number.isFinite(at)||Math.abs(at)>8.64e15)throw Error('INVALID_CANDLE_TIME');
  return {time:at/1000,open:record.open,high:record.high,low:record.low,close:record.close};
 });
 if(data.some((bar,i)=>i&&bar.time<=data[i-1].time))throw Error('UNSORTED_CANDLES');
 return data;
}
export function candleWindow(logical,length){
 if(!logical||!length||![logical.from,logical.to].every(Number.isFinite))return null;
 const start=Math.max(0,Math.min(length-1,Math.round(logical.from))),end=Math.max(start,Math.min(length-1,Math.round(logical.to)));
 return {start,count:end-start+1};
}
function createSnapshotCandleEngine(canvas,{config:c,format,onRange,onInspect,onReady}){
 const stopLights=[];
 let chart,series,volume,api,data,current=null,applying=false,disposed=false,observer;const events=new AbortController();
 const controller={ready:false,update(range){
  current=range;if(!chart){if(api&&!disposed)init();return;}
  applying=true;try{chart.timeScale().setVisibleLogicalRange({from:range.start,to:range.start+range.count-1});}finally{applying=false;}
 },inspect(index){const bar=data?.[index];if(chart&&bar)chart.setCrosshairPosition(bar.close,bar.time,series);},clear(){chart?.clearCrosshairPosition();},dispose(){disposed=true;events.abort();observer?.disconnect();stopLights.splice(0).forEach(stop=>stop());chart?.remove();chart=null;controller.ready=false;canvas.classList.remove('is-dragging');}};
 function skin(){
  if(!chart)return;const p=tradingChartPalette(canvas),style=getComputedStyle(canvas);
  chart.applyOptions({layout:{background:{type:api.ColorType.Solid,color:'transparent'},textColor:p.muted,fontSize:12,fontFamily:style.fontFamily,attributionLogo:true,panes:{separatorColor:p.line,separatorHoverColor:p.accent}},grid:{vertLines:{visible:false},horzLines:{color:p.line,style:api.LineStyle.Dotted}},rightPriceScale:{borderVisible:false,scaleMargins:{top:.08,bottom:.08}},timeScale:{borderVisible:false,timeVisible:true,tickMarkFormatter:time=>format.label(Number(time)*1000)},localization:{priceFormatter:format.value,timeFormatter:time=>format.label(Number(time)*1000)},crosshair:{vertLine:{color:p.muted,labelBackgroundColor:p.accent},horzLine:{color:p.muted,labelBackgroundColor:p.accent}}});
  series.applyOptions({upColor:p.up,downColor:p.down,wickUpColor:p.up,wickDownColor:p.down,borderVisible:true,borderUpColor:p.upCore||p.up,borderDownColor:p.downCore||p.down});
  volume?.setData(c.data.flatMap((bar,i)=>finite(bar.volume)&&bar.volume>=0?[{time:data[i].time,value:bar.volume,color:(bar.close>=bar.open?p.up:p.down).replace(/^rgb\((.+)\)$/,'rgba($1, .35)')}]:[]));
 }
 function init(){
  if(chart||disposed||!canvas.isConnected||!canvas.clientWidth)return;
  canvas.innerHTML='';chart=api.createChart(canvas,{autoSize:true,handleScroll:{mouseWheel:false,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:false,pinch:true},crosshair:{mode:api.CrosshairMode.Magnet}});
  series=chart.addSeries(api.CandlestickSeries,{priceFormat:{type:'custom',formatter:format.value,minMove:.00000001}});series.setData(data);
  if(c.data.some(bar=>finite(bar.volume)&&bar.volume>=0)){volume=chart.addSeries(api.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},1);volume.priceScale().applyOptions({scaleMargins:{top:.12,bottom:0}});chart.panes()[0].setStretchFactor(4);chart.panes()[1].setStretchFactor(1);}
  for(const layer of [series,volume].filter(Boolean))stopLights.push(attachChartSeriesLight(layer,canvas));
  chart.timeScale().subscribeVisibleLogicalRangeChange(logical=>{if(applying||disposed)return;const next=candleWindow(logical,data.length);if(next&&(!current||next.start!==current.start||next.count!==current.count))onRange(next.start,next.count);});
  chart.subscribeCrosshairMove(event=>{if(applying||disposed||event.time===undefined)return;const index=data.findIndex(bar=>bar.time===event.time);if(index>=0)onInspect(index);});
  canvas.addEventListener('wheel',event=>{if(!current||!event.ctrlKey&&!event.shiftKey)return;event.preventDefault();const count=Math.max(8,Math.min(data.length,Math.round(current.count*(event.deltaY>0?1.2:.8))));onRange(Math.max(0,current.start+Math.round((current.count-count)/2)),count);},{passive:false,signal:events.signal});
  canvas.style.touchAction='pan-y';canvas.dataset.engine='lightweight-charts';controller.ready=true;skin();
  observer=new MutationObserver(skin);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});onReady();
 }
 try{data=snapshotCandleData(c.data);}catch{canvas.dataset.engine='svg-fallback';queueMicrotask(()=>{if(!disposed)onReady();});return controller;}
 loadTradingChartLibrary().then(module=>{api=module;init();}).catch(()=>{observer?.disconnect();stopLights.splice(0).forEach(stop=>stop());chart?.remove();chart=null;controller.ready=false;if(!disposed){canvas.dataset.engine='svg-fallback';onReady();}});
 return controller;
}
