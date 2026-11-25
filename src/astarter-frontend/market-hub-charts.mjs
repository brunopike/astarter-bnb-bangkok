import {L} from './execution-views.mjs';
import {chartLightStyle,preserveChartLightBounds,applyChartSeriesLight} from './product-charts.mjs';

const ASSETS=[['bitcoin','BTC'],['ethereum','ETH'],['solana','SOL']];
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const percent=v=>(v>0?'+':'')+v.toFixed(2)+'%';

export function applyHubGaugeLight(host,colors){
 for(const path of host.querySelectorAll('svg path')){
  const color=path.getAttribute('fill');
  if(colors.includes(color)&&path.getAttribute('d')?.includes('A')){
   path.classList.add('hub-gauge-band');path.style.setProperty('--gauge-color',color);
  }
 }
}

export function hubPerformanceSeries(assets,window='7d'){
 const rows=ASSETS.map(([id,symbol],color)=>({asset:assets?.find(a=>a.id===id),symbol,color})).filter(({asset})=>asset?.series?.length>1&&asset.series.every(v=>finite(v)&&v>0));
 if(!rows.length)return [];
 const count=Math.min(window==='24h'?25:168,...rows.map(({asset})=>asset.series.length));
 // Sparkline points have hourly spacing but no source timestamps; use sample offsets.
 return rows.map(({asset,symbol,color})=>{const values=asset.series.slice(-count),first=values[0];return {symbol,color,values:values.map((v,i)=>[i-count+1,(v/first-1)*100])};});
}

export function hubMarketShares(global){
 if(!finite(global?.btcShare)||global.btcShare<0||global.btcShare>100)return [];
 const rows=[{name:'BTC',value:global.btcShare}];
 if(global.ethShare!=null){if(!finite(global.ethShare)||global.ethShare<0||global.btcShare+global.ethShare>100)return [];rows.push({name:'ETH',value:global.ethShare});}
 return [...rows,{name:L('其它','Other'),value:100-rows.reduce((sum,r)=>sum+r.value,0)}];
}

export function hubChartOption(kind,model,p){
 const tooltip={confine:true,renderMode:'richText',backgroundColor:p.panel,borderColor:p.line,padding:12,textStyle:{color:p.ink,fontSize:13}};
 const base={animation:false,textStyle:{fontFamily:p.font,color:p.ink},color:p.series,tooltip};
 if(kind==='performance')return {...base,grid:{left:5,right:24,top:24,bottom:8,containLabel:true},tooltip:{...tooltip,renderMode:'html',trigger:'axis',transitionDuration:0,hideDelay:0,enterable:false,extraCssText:'pointer-events:none;min-width:132px;font-variant-numeric:tabular-nums',
  axisPointer:{type:'line',snap:true,animation:false,label:{show:false},lineStyle:{color:p.muted,type:'dashed'}},
  position:(point,_items,_element,_rect,size)=>[point[0]<size.viewSize[0]/2?Math.max(8,size.viewSize[0]-size.contentSize[0]-8):8,8],
  formatter:items=>{if(!items.length)return '';const offset=items[0].value[0],label=offset===0?L('最新样本','Latest sample'):Math.abs(offset)+'h '+L('前的样本','earlier sample');return '<div style="margin-bottom:6px">'+label+'</div>'+items.map(i=>'<div style="display:flex;justify-content:space-between;gap:18px"><span>'+(ASSETS.find(([,symbol])=>symbol===i.seriesName)?.[1]||'—')+'</span><b style="font-weight:500">'+percent(i.value[1])+'</b></div>').join('');}},xAxis:{type:'value',min:model.rows[0]?.values[0][0],max:0,minInterval:1,splitNumber:4,axisPointer:{label:{formatter:item=>Math.abs(Math.round(item.value))+'h'}},axisTick:{show:false},axisLine:{show:false},axisLabel:{color:p.muted,fontSize:12,hideOverlap:true,formatter:v=>v===0?L('最新','Latest'):Math.abs(Math.round(v))+'h'},splitLine:{show:false}},yAxis:{type:'value',scale:true,splitNumber:4,axisPointer:{label:{formatter:item=>percent(item.value)}},axisLine:{show:false},axisTick:{show:false},axisLabel:{color:p.muted,fontSize:12,formatter:v=>v+'%'},splitLine:{lineStyle:{color:p.line,type:'dashed'}}},dataZoom:[{id:'comparison',type:'inside',xAxisIndex:0,start:0,end:100,minValueSpan:Math.min(7,model.rows[0]?.values.length-1||0),zoomOnMouseWheel:'ctrl',moveOnMouseWheel:false,moveOnMouseMove:true,preventDefaultMouseMove:false,throttle:32}],series:model.rows.filter(r=>!model.hidden.has(r.symbol)).map(r=>({name:r.symbol,type:'line',data:r.values,symbol:'circle',showSymbol:false,symbolSize:6,smooth:false,lineStyle:{width:2.3,color:p.series[r.color],...chartLightStyle(p.series[r.color],p.dark)},itemStyle:{color:p.series[r.color],...chartLightStyle(p.series[r.color],p.dark)},emphasis:{disabled:true},markLine:r.symbol===model.rows.find(row=>!model.hidden.has(row.symbol))?.symbol?{silent:true,symbol:'none',label:{show:false},lineStyle:{color:p.muted,opacity:.45,type:'dashed'},data:[{yAxis:0}]}:undefined}))};
 if(kind==='shares')return {...base,tooltip:{...tooltip,trigger:'item',formatter:item=>item.name+'  '+item.value.toFixed(2)+'%'},series:[{type:'pie',radius:['62%','84%'],center:['50%','50%'],padAngle:2,stillShowZeroSum:false,label:{show:false},labelLine:{show:false},emphasis:{scaleSize:4},data:model.map((row,i)=>({...row,itemStyle:{color:p.series[i],...chartLightStyle(p.series[i],p.dark),borderColor:p.panel,borderWidth:1}}))}]};
 const rows=model.slice(-30),fear=rows.at(-1),bands=[.12,.25,.45,.55,.75,.88,1].map((end,i)=>[end,p.spectrum[i]]);
 return {...base,tooltip:{...tooltip,trigger:'item',formatter:item=>item.seriesType==='line'?new Date(item.value[0]).toISOString().slice(0,10)+'\n'+item.value[1]+' / 100':L('最新日度指数','Latest daily index')+'  '+item.value+' / 100'},grid:{left:2,right:2,top:'88%',bottom:2},xAxis:{type:'time',show:false},yAxis:{type:'value',min:0,max:100,show:false},series:[{type:'gauge',min:0,max:100,startAngle:180,endAngle:0,center:['50%','49%'],radius:'86%',splitNumber:4,axisLine:{lineStyle:{width:13,color:bands}},axisTick:{show:false},splitLine:{show:false},axisLabel:{distance:15,color:p.muted,fontSize:11,formatter:v=>v===0||v===100?String(v):''},pointer:{length:'65%',width:3,itemStyle:{color:p.ink,...chartLightStyle(p.ink,p.dark)}},anchor:{show:true,size:7,itemStyle:{color:p.panel,borderColor:p.ink,borderWidth:2}},title:{offsetCenter:[0,'56%'],fontSize:13,color:p.muted},detail:{valueAnimation:false,offsetCenter:[0,'24%'],fontSize:30,fontWeight:550,color:p.ink,formatter:'{value}'},data:[{value:fear.value,name:L(fear.value<25?'极度恐慌':fear.value<45?'恐慌':fear.value<56?'中性':fear.value<76?'贪婪':'极度贪婪',fear.value<25?'Extreme fear':fear.value<45?'Fear':fear.value<56?'Neutral':fear.value<76?'Greed':'Extreme greed')}]},{type:'line',data:rows.map(r=>[r.at,r.value]),symbol:'circle',showSymbol:false,symbolSize:6,lineStyle:{width:1.8,color:p.series[0],...chartLightStyle(p.series[0],p.dark)},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:p.series[0]},{offset:1,color:'rgba(0,0,0,0)'}]},opacity:p.dark?.18:.08}}]};
}

let library;
function createPlot(root,node,models,windows,load){
 const kind=node.dataset.hubPlot,events=new AbortController();
 let chart=null,observer=null,themeObserver=null,restore=()=>{};
 function dispose(){
  events.abort();observer?.disconnect();themeObserver?.disconnect();chart?.dispose();
 }
 async function mount(){
  try{
   const api=await load();if(events.signal.aborted||!node.isConnected)return;
   const signal=events.signal,key=models.performance?.window||'7d';
   let gaugeColors=[],lightColors=[],selected=null;
   chart=api.init(node,null,{renderer:'svg'});
   const count=kind==='performance'?models.performance.rows[0].values.length:kind==='sentiment'?Math.min(30,models.sentiment.length):models.shares.length;
   function sampleRange(zoom=kind==='performance'?windows.get(key):null){
    const span=count-1;
    return {first:Math.ceil(span*(zoom?.start??0)/100-1e-9),last:Math.floor(span*(zoom?.end??100)/100+1e-9)};
   }
   function visibleSample(index){const {first,last}=sampleRange();return Math.max(first,Math.min(last,index));}
   function describePerformance(index){
    const {rows,hidden}=models.performance,offset=rows[0].values[index][0];
    const sample=offset===0?L('最新样本','Latest sample'):L(Math.abs(offset)+' 小时前的样本','Sample '+Math.abs(offset)+'h earlier');
    return sample+' · '+rows.filter(row=>!hidden.has(row.symbol)).map(row=>row.symbol+' '+percent(row.values[index][1])).join(', ');
   }
   let legendIndex=-1;
   function legendAt(index){if(index===legendIndex)return;legendIndex=index;for(const row of models.performance.rows){const value=row.values[index]?.[1],label=root.querySelector('[data-hub-series="'+row.symbol+'"]>span');if(label&&finite(value)){label.textContent=percent(value);label.className=value>=0?'hub-up':'hub-down';}}}
   function zoomLabel(node,zoom){
    node.dataset.zoomStart=zoom.start;node.dataset.zoomEnd=zoom.end;
    const reset=root.querySelector('[data-hub-reset]');if(reset)reset.disabled=zoom.start<.01&&zoom.end>99.99;
    const {first,last}=sampleRange(zoom),points=models.performance.rows[0].values;
    const label=root.querySelector('[data-hub-window-label]');if(label)label.textContent=points[first][0]+'h — '+points[last][0]+'h';
    const out=root.querySelector('[data-hub-zoom="out"]'),inside=root.querySelector('[data-hub-zoom="in"]');if(out)out.disabled=reset.disabled;if(inside)inside.disabled=last-first<=Math.min(7,count-1);
    legendAt(last);
   }
   function paint(){
    const style=getComputedStyle(node),color=key=>style.getPropertyValue(key).trim();
    const palette={ink:color('--b-ink'),muted:color('--b-muted'),line:color('--b-line'),panel:color('--b-panel'),font:style.fontFamily,series:[1,2,3].map(i=>color('--chart-series-'+i)),up:color('--signal-up')||color('--ok'),down:color('--signal-down')||color('--error'),gold:color('--chart-series-4'),spectrum:Array.from({length:7},(_,i)=>color('--s'+(i+1))),dark:document.documentElement.dataset.theme==='dark'};
    gaugeColors=palette.spectrum;
    lightColors=[...palette.series,palette.up,palette.down,palette.gold,...palette.spectrum];
    const option=hubChartOption(kind,models[kind],palette);
    if(kind==='performance'){Object.assign(option.dataZoom[0],windows.get(key)||{});zoomLabel(node,option.dataZoom[0]);}
    chart.setOption(option,{notMerge:true,silent:true});node.dataset.chartReady='true';
   }
   chart.on('rendered',()=>{preserveChartLightBounds(node);applyChartSeriesLight(node,lightColors);if(kind==='sentiment')applyHubGaugeLight(node,gaugeColors);});
   const inspect=index=>{
    selected=visibleSample(index);node.dataset.inspectedIndex=selected;
    chart.dispatchAction({type:'showTip',seriesIndex:kind==='sentiment'?1:0,dataIndex:selected});
    if(kind==='performance')legendAt(selected);
    if(kind==='sentiment'){const row=models.sentiment.slice(-30)[selected],label=root.querySelector('[data-hub-sentiment-point]');if(label)label.textContent=new Date(row.at).toISOString().slice(5,10)+' · '+row.value+' / 100';}
    const announcement=root.querySelector('[data-hub-chart-announcement]');
    if(announcement)announcement.textContent=kind==='performance'?describePerformance(selected):kind==='sentiment'?new Date(models.sentiment.slice(-30)[selected].at).toISOString().slice(0,10)+' · '+models.sentiment.slice(-30)[selected].value+' / 100':models.shares[selected].name+' '+percent(models.shares[selected].value);
   };
   function dismissInspection(){
    chart.dispatchAction({type:'hideTip'});chart.dispatchAction({type:'updateAxisPointer',currTrigger:'leave'});
    selected=null;delete node.dataset.inspectedIndex;
    const announcement=root.querySelector('[data-hub-chart-announcement]');
    if(kind==='performance'){
     const {last}=sampleRange();legendAt(last);
     if(announcement)announcement.textContent=describePerformance(last);
    }else{
     if(announcement)announcement.textContent='';
     if(kind==='sentiment'){const label=root.querySelector('[data-hub-sentiment-point]');if(label)label.textContent=L('近 30 日情绪','30-day sentiment');}
    }
   }
   function changeZoom(action){const zoom=windows.get(key)||{start:0,end:100},span=action==='0'?100:Math.min(100,Math.max(7/(count-1)*100,(zoom.end-zoom.start)*(action==='-'?1.5:.66))),start=Math.max(0,Math.min(100-span,(zoom.start+zoom.end-span)/2));chart.dispatchAction({type:'dataZoom',dataZoomId:'comparison',start,end:start+span});}
   node.style.touchAction='pan-y';
   node.addEventListener('pointerdown',()=>node.dataset.interacting='true',{signal});
   for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>delete node.dataset.interacting,{signal});
   node.addEventListener('keydown',e=>{
    if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();inspect(e.key==='Home'?0:e.key==='End'?count-1:(selected??count-1)+(e.key==='ArrowLeft'?-1:1));}
    else if(e.key==='Escape'){e.preventDefault();dismissInspection();}
    else if(kind==='performance'&&['+','=','-','0'].includes(e.key)){
     e.preventDefault();changeZoom(e.key);
    }
    else if(kind==='shares'&&e.key==='Enter'){e.preventDefault();root.querySelector('[data-hub-share="'+models.shares[selected??0].name+'"]')?.click();}
   },{signal});
   if(kind==='performance'){
    chart.on('datazoom',()=>{const zoom=chart.getOption().dataZoom[0],value={start:zoom.start,end:zoom.end};windows.set(key,value);zoomLabel(node,value);});
    chart.on('updateAxisPointer',event=>{const axis=event.axesInfo?.find(a=>a.axisDim==='x');if(axis){selected=visibleSample(Math.round(count-1+axis.value));node.dataset.inspectedIndex=selected;legendAt(selected);}});
    node.addEventListener('pointerleave',()=>{
     if(document.activeElement!==node){selected=null;delete node.dataset.inspectedIndex;}
     legendAt(sampleRange().last);
    },{signal});
    root.addEventListener('click',event=>{
     const button=event.target.closest?.('[data-hub-reset],[data-hub-zoom]');
     if(button&&!button.disabled)changeZoom(button.hasAttribute('data-hub-reset')?'0':button.dataset.hubZoom==='in'?'+':'-');
    },{signal});
    restore=()=>{legendIndex=-1;zoomLabel(node,windows.get(key)||{start:0,end:100});if(selected!==null)legendAt(selected);};
    node.addEventListener('dblclick',()=>chart.dispatchAction({type:'dataZoom',dataZoomId:'comparison',start:0,end:100}),{signal});
   }
   if(kind==='shares')chart.on('click',item=>root.querySelector('[data-hub-share="'+item.name+'"]')?.click());
   if(kind==='sentiment'){
    chart.on('mouseover',item=>{if(item.seriesIndex===1)inspect(item.dataIndex);});
    restore=()=>{const row=selected===null?null:models.sentiment.slice(-30)[selected],label=root.querySelector('[data-hub-sentiment-point]');if(row&&label)label.textContent=new Date(row.at).toISOString().slice(5,10)+' · '+row.value+' / 100';};
   }
   paint();themeObserver=new MutationObserver(paint);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
   observer=new ResizeObserver(entries=>{
    const box=entries[0]?.contentRect;if(!box)return;
    const width=Math.round(box.width),height=Math.round(box.height);
    if(width>0&&height>0&&(width!==chart.getWidth()||height!==chart.getHeight()))chart.resize({width,height});
   });
   observer.observe(node);
  }catch{
   if(events.signal.aborted)return;
   dispose();if(node.isConnected){node.textContent=L('图表未载入，请刷新重试','Chart unavailable. Refresh to retry.');node.dataset.chartReady='error';}
  }
 }
 return {node,mount,dispose,restore:()=>restore()};
}

export function createHubCharts(load=()=>library??=import('./node_modules/echarts/dist/echarts.esm.min.mjs').catch(error=>{library=null;throw error;})){
 const plots=new Map(),windows=new Map();
 function dispose(){for(const plot of plots.values())plot.dispose();plots.clear();}
 function mount(root,models){
  const nodes=[...root.querySelectorAll('[data-hub-plot]')],retained=new Set(),mounts=[];
  for(const node of nodes){
   const kind=node.dataset.hubPlot,model=models[kind];
   const content=kind==='performance'?[model.rows,model.window,[...model.hidden].sort()]:kind==='sentiment'?model.slice(-30):model;
   const key=JSON.stringify([node.ownerDocument.documentElement.lang,node.getAttribute('aria-label'),content]);
   const previous=plots.get(kind);retained.add(kind);
   if(previous?.key===key&&previous.node.dataset.chartReady!=='error'){
    if(previous.node!==node){node.replaceWith(previous.node);previous.restore();}
    mounts.push(previous.ready);continue;
   }
   previous?.dispose();
   const plot=createPlot(root,node,models,windows,load);
   plot.key=key;
   plots.set(kind,plot);
   plot.ready=plot.mount();
   mounts.push(plot.ready);
  }
  for(const [kind,plot] of plots)if(!retained.has(kind)){plot.dispose();plots.delete(kind);}
  return Promise.all(mounts);
 }
 return {dispose,mount};
}
