import {mountTradingCharts} from './trading-chart.mjs';
import {formatDataTime} from './product-help.mjs';
import {t,pair} from './locale.mjs';
const chartL=pair;
import {clampRange,adjustRange} from './vendor/mmdock/range-window.mjs';
import {candlestickChart,sparkline} from './product-charts.mjs';
import {createChartEngine,validChartRecords} from './product-chart-engine.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const formatNumber=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
export function chartGesture(dx,dy){
 const x=Math.abs(dx),y=Math.abs(dy);
 if(x>8&&x>y*1.2)return 'pan';
 if(y>8)return 'scroll';
 return 'pending';
}
export function windowRange(length,start=0,count=length){if(!length)return {start:0,count:0};const view=clampRange({min:Math.round(start),max:Math.round(start)+Math.round(count)},{min:0,max:length},Math.min(8,length));return {start:view.min,count:view.max-view.min};}
export function makeBars(values,period='1H'){
 const hours=period==='1D'?24:period==='4H'?4:1;
 return values.map((v,i)=>{const open=values[Math.max(0,i-1)],pad=Math.abs(v)*(.000025+Math.abs(Math.sin(i*1.7))*.00008);return {time:Date.UTC(2026,9,24,6)-(values.length-1-i)*hours*3600000,open,close:v,high:Math.max(open,v)+pad,low:Math.min(open,v)-pad,volume:Math.abs(v-open)*100+100};});
}
export function seriesDomain(values,zero=false){const valid=values.filter(Number.isFinite);if(!valid.length)return [0,1];let min=Math.min(...valid),max=Math.max(...valid);if(zero){min=Math.min(0,min);max=Math.max(0,max);}const pad=(max-min||Math.max(1,Math.abs(max)*.0001))*.12;return [min-pad,max+pad];}
export const chartLabel=(time)=>typeof time==='number'?new Date(time+8*3600000).toISOString().slice(5,16).replace('T',' '):String(time);
export function chartAxisTicks(labels,width,maximum=5){
 if(!labels.length)return [];
 for(let count=Math.min(labels.length,maximum);count>=1;count--){
  const ticks=Array.from({length:count},(_,i)=>{const index=count===1?labels.length-1:Math.round(i*(labels.length-1)/(count-1)),anchor=count===1||i===count-1?'end':i===0?'start':'middle';return {index,label:labels[index],x:labels.length===1?width/2:index*width/(labels.length-1),anchor};});
  let edge=-Infinity;
  if(ticks.every(t=>{const ink=String(t.label).length*6.6,start=t.x-(t.anchor==='end'?ink:t.anchor==='middle'?ink/2:0),clear=start>=edge+8;edge=start+ink;return clear;}))return ticks;
 }
 return [];
}
export function chartPresets(data){
 const n=data.length;if(n<9)return [];
 const times=data.map(d=>d.time),numeric=times.every(t=>typeof t==='number'&&Number.isFinite(t))&&times.every((t,i)=>!i||t>=times[i-1]);
 const choices=[];
 if(numeric){
  const end=times.at(-1),span=end-times[0];
  for(const [label,duration] of [['24H',86400000],['7D',604800000],['30D',2592000000],['90D',7776000000]]){
   const count=times.filter(t=>t>end-duration).length;
   if(duration<span&&count>=8&&count<n&&!choices.some(x=>x.count===count))choices.push({label,count});
  }
 }
 if(!choices.length&&n>24)choices.push({label:chartL('最近','Recent'),count:Math.min(24,n)});
 choices.push({label:chartL('全部','All'),count:n});return choices;
}
export function formatChartAxis(value,step=null){
 if(step>0&&step<Math.abs(value)*.002){const digits=Math.max(0,Math.min(8,-Math.floor(Math.log10(step))));return formatNumber(value,digits);}
 const size=Math.abs(value);
 if(size>=1e9)return formatNumber(value/1e9,2)+'B';
 if(size>=1e6)return formatNumber(value/1e6,2)+'M';
 if(size>=10000)return formatNumber(value/1000,2)+'K';
 if(size===0)return '0';
 if(size<.0000001)return value.toExponential(2);
 return formatNumber(value,size<1?Math.min(8,Math.ceil(-Math.log10(size))+2):size<10?3:2);
}
export function chartValueTicks(min,max,target=4){
 if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min)return [];
 const raw=(max-min)/Math.max(1,target),power=10**Math.floor(Math.log10(raw)),fraction=raw/power;
 const step=(fraction<=1?1:fraction<=2?2:fraction<=5?5:10)*power;
 const start=Math.ceil(min/step)*step,count=Math.floor((max-start)/step)+1;
 return Array.from({length:Math.max(0,Math.min(12,count))},(_,i)=>Number((start+i*step).toPrecision(12)));
}
const charts=new Map();
export function initialChartRange(length,{initialWindow=null,initialRange=null,mobileWindow=null}={},width=Infinity){
 const count=width<=600&&Number.isFinite(mobileWindow)&&mobileWindow>0?Math.min(length,mobileWindow):initialWindow==='all'?length:Math.min(length,40);
 return windowRange(length,initialRange?.start??Math.max(0,length-count),initialRange?.count??count);
}
export function chartPanel(key,{title,unit='',bars=null,values=null,labels=null,kind='line',color='var(--chart-accent)',period='1H',height=320,initialWindow=null,scale='linear',compact=false,initialRange=null,mobileWindow=null,showPresets=true}={}){
 const data=bars||values?.map((value,i)=>({value,time:labels?.[i]??`#${i+1}`}))||[];
 charts.set(key,{key,title,unit,data,kind:bars?'candle':kind,color,period,height,initialWindow,scale,initialRange,mobileWindow,showPresets});
 return `<div class="pro-chart ${compact?'chart-compact':''}" data-chart="${esc(key)}" data-chart-kind="${bars?'candle':kind}" data-chart-ui="terminal"><div class="chart-readout" aria-live="off"></div><div class="chart-canvas" tabindex="0" role="group" aria-label="${esc(title)} · ${chartL('左右方向键查看数据','Use arrow keys to explore')}"></div><div class="chart-navigation"><div class="chart-presets" role="group" aria-label="${chartL('图表时间范围','Chart range')}"></div><span class="chart-range-label"></span>${bars?`<span class="chart-attribution"><a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a><a href="/vendor/tradingview-NOTICE.txt" target="_blank" rel="noopener" aria-label="TradingView copyright">©</a></span>`:''}<div class="chart-tools"><button data-chart-action="back" aria-label="${chartL('向前查看','Previous window')}" title="${chartL('向前查看','Previous window')}">←</button><button data-chart-action="out" aria-label="${chartL('缩小图表','Zoom out')}" title="${chartL('缩小图表','Zoom out')}">−</button><button data-chart-action="fit" aria-label="${chartL('显示全部数据','Show all data')}" title="${chartL('显示全部数据','Show all data')}">${chartL('适配','Fit')}</button><button data-chart-action="in" aria-label="${chartL('放大图表','Zoom in')}" title="${chartL('放大图表','Zoom in')}">＋</button><button data-chart-action="forward" aria-label="${chartL('向后查看','Next window')}" title="${chartL('向后查看','Next window')}">→</button></div></div><details class="chart-range-details" ${data.length<25?'hidden':''}><summary>${chartL('调整观察窗口','Adjust chart window')}</summary><div class="range-overview"><div class="range-overview-plot"></div><div class="range-handles"><label>${chartL('起点','Start')}<input data-range-edge="start" type="range" min="0" step="1" aria-label="${esc(title)}${chartL('窗口起点',' window start')}"></label><label>${chartL('终点','End')}<input data-range-edge="end" type="range" min="0" step="1" aria-label="${esc(title)}${chartL('窗口终点',' window end')}"></label></div></div><label class="chart-range"><span>${chartL('时间窗口','Time window')}</span><input type="range" min="0" value="0" step="1" aria-label="${esc(title)} · ${chartL('时间窗口','Time window')}"><small>${chartL('拖动查看','Drag to explore')}</small></label></details></div>`;
}
function lineSVG(c,data,w,h){
 const log=c.scale==='log'&&data.every(d=>d.value>0),transform=v=>log?Math.log10(v):v;
 const left=8,right=w<450?70:86,top=22,bottom=30,pw=w-left-right,ph=h-top-bottom,[min,max]=seriesDomain(data.map(d=>transform(d.value)),c.kind==='bar');
 const x=i=>left+(data.length===1?.5:i/(data.length-1))*pw,y=v=>top+(max-transform(v))/(max-min)*ph;
 const uid='chart-fill-'+c.key.replace(/[^a-z0-9_-]/gi,'');
 let s=`<svg class="chart chart-interactive" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(c.title)}"><defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.color}" stop-opacity=".19"/><stop offset="1" stop-color="${c.color}" stop-opacity=".015"/></linearGradient>${[c.color,'var(--signal-down,var(--error))'].map((tone,i)=>`<linearGradient id="${uid}-bar-${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--plot-core,#fff)" stop-opacity=".8"/><stop offset=".12" stop-color="${tone}"/><stop offset="1" stop-color="${tone}" stop-opacity=".46"/></linearGradient>`).join('')}</defs><g fill="var(--muted)" font-size="12" font-family="var(--sans)">`;
 const axisStep=log?(10**max-10**min)/4:(max-min)/4;
 const ticks=log?Array.from({length:4},(_,i)=>min+(max-min)*i/3):chartValueTicks(min,max);
 for(const tick of ticks){const value=log?10**tick:tick,yy=y(value);s+=`<path d="M${left},${yy}H${w-right}" fill="none" stroke="var(--line)" stroke-opacity=".8" stroke-dasharray="2 5"/><text x="${w-right+10}" y="${yy+4}">${formatChartAxis(value,axisStep)}</text>`;}
 for(const tick of chartAxisTicks(data.map(d=>chartLabel(d.time)),pw,w<450?3:5))s+=`<text x="${left+tick.x}" y="${h-7}" text-anchor="${tick.anchor}">${esc(tick.label)}</text>`;s+='</g>';
 if(c.kind==='bar'){
  const bw=Math.max(2,Math.min(24,pw/data.length*.64));
  s+=`<path d="M${left},${y(0)}H${w-right}" stroke="var(--line)"/>`;
  s+=data.map((d,i)=>`<rect class="chart-value-bar ${d.value<0?'chart-negative':'chart-positive'}" style="--bar-light-fill:url(#${uid}-bar-${d.value<0?1:0});--bar-light-color:${d.value<0?'var(--signal-down,var(--error))':c.color}" x="${x(i)-bw/2}" y="${Math.min(y(d.value),y(0))}" width="${bw}" height="${Math.max(1,Math.abs(y(d.value)-y(0)))}" rx="2" fill="${d.value<0?'var(--signal-down,var(--error))':c.color}" opacity=".82"/>`).join('');
 }else{
  const line=data.map((d,i)=>`${i?'L':'M'}${x(i)},${y(d.value)}`).join(' ');
  s+=`<path d="${line} L${x(data.length-1)},${h-bottom} L${x(0)},${h-bottom}Z" fill="url(#${uid})"/><path class="chart-light-envelope" d="${line}" fill="none" stroke="${c.color}"/><path class="chart-light-line" d="${line}" fill="none" stroke="${c.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path class="chart-light-core" d="${line}" fill="none"/>`;
  const last=data.at(-1);s+=`<circle class="chart-light-point" cx="${x(data.length-1)}" cy="${y(last.value)}" r="3" fill="${c.color}" style="--point-light:${c.color}" stroke="var(--surface)" stroke-width="1"/>`;
 }
 return {svg:s+'</svg>',x,y,left,right,axisStep};
}
export function mountCharts(root){
 const cleanup=[mountTradingCharts(root)];
 root.querySelectorAll('[data-chart]').forEach(host=>{
  const c=charts.get(host.dataset.chart);if(!c)return;const full=c.data,valid=validChartRecords(c),canvas=host.querySelector('.chart-canvas'),readout=host.querySelector('.chart-readout'),slider=host.querySelector('.chart-range input');
  let range=initialChartRange(full.length,c,canvas.clientWidth),selected=null,w=0,coords=null,data=[],engine=null,readMarkup='';
  canvas.style.height=c.height+'px';canvas.setAttribute('aria-keyshortcuts','ArrowLeft ArrowRight Home End + - 0 Escape');
  const presets=host.querySelector('.chart-presets'),choices=c.showPresets?chartPresets(full):[];
  presets.innerHTML=(choices.length>1?choices:[]).map(p=>`<button type="button" data-chart-preset="${p.count}" aria-pressed="false">${p.label}</button>`).join('');
  presets.querySelectorAll('button').forEach(b=>b.onclick=()=>{const count=Number(b.dataset.chartPreset);range=windowRange(full.length,full.length-count,count);selected=null;draw();});
  function read(index,fromEngine=false){if(!valid||!data.length)return;selected=Math.max(0,Math.min(data.length-1,index));const d=data[selected],values=c.kind==='candle'?[['开',d.open],['高',d.high],['低',d.low],['收',d.close],['量',d.volume]]:[[c.title,d.value]];
   const markup=`<span>${esc(typeof d.time==='number'?formatDataTime(d.time):chartLabel(d.time))}${c.unit?`<small class="chart-readout-unit"> · ${esc(c.unit)}</small>`:''}</span><dl>${values.map(([l,v])=>`<div><dt>${esc(chartL(l,({开:'O',高:'H',低:'L',收:'C',量:'Vol'})[l]||l))}</dt><dd>${Number.isFinite(v)?formatNumber(v,v!==0&&Math.abs(v)<1?Math.min(8,Math.ceil(-Math.log10(Math.abs(v)))+3):2):'—'}${l==='量'?'':`<small>${esc(c.unit)}</small>`}</dd></div>`).join('')}</dl>`;
   if(markup!==readMarkup){readout.innerHTML=markup;readMarkup=markup;}
   host.dataset.inspecting='true';
   host.dataset.inspectedIndex=range.start+selected;host.dataset.inspectedTime=String(d.time);
   if(engine?.ready){if(!fromEngine)engine.inspect(range.start+selected);return;}
   const svg=canvas.querySelector('svg');if(!svg)return;const cursor=svg.querySelector('[data-crosshair]');if(cursor?.dataset.index===String(selected))return;cursor?.remove();const x=coords.x(selected),value=c.kind==='candle'?d.close:d.value,y=coords.y(value);const g=document.createElementNS('http://www.w3.org/2000/svg','g');g.dataset.crosshair='true';g.dataset.index=String(selected);g.innerHTML=`<path d="M${x},20V${c.height-28}${c.kind==='candle'?` M${coords.left},${y}H${w-coords.right}`:''}" fill="none" stroke="var(--muted)" stroke-width=".8" stroke-dasharray="3 4" opacity=".6"/><circle cx="${x}" cy="${y}" r="3.5" stroke="var(--surface)" stroke-width="2" fill="var(--accent)"/>`;const boxWidth=coords.right-5,boxY=Math.max(13,Math.min(c.height-42,y));
   if(c.kind==='candle')g.innerHTML+=`<rect x="${w-coords.right+3}" y="${boxY-11}" width="${boxWidth}" height="22" rx="4" fill="var(--text)"/><text x="${w-coords.right+3+boxWidth/2}" y="${boxY+4}" text-anchor="middle" fill="var(--surface)" font-size="11" font-family="var(--sans)">${c.kind==='candle'?formatNumber(value,Math.abs(value)<1?6:2):formatChartAxis(value,coords.axisStep)}</text>`;
   svg.append(g);
  }
  function draw(){w=Math.max(240,canvas.clientWidth);data=full.slice(range.start,range.start+range.count);host.dataset.visibleCount=data.length;host.dataset.rangeStart=range.start;
   for(const b of presets.querySelectorAll('button'))b.setAttribute('aria-pressed',String(range.start+range.count===full.length&&range.count===Number(b.dataset.chartPreset)));
   if(!valid||!data.length){host.dataset.visibleCount='0';host.dataset.chartState=full.length?'unavailable':'empty';canvas.innerHTML=`<div class="p-empty">${full.length?chartL('数据不完整，暂不绘图','Incomplete data. Chart unavailable.'):chartL('当前范围暂无记录','No records in this window')}</div>`;readout.textContent=chartL('暂无数据','No data');host.querySelector('.chart-range-label').textContent='—';host.querySelectorAll('input,button').forEach(el=>el.disabled=true);return;}
   if(engine?.ready){engine.update(range);}else if(c.kind==='candle'){
    canvas.innerHTML=candlestickChart(data,{width:w,height:c.height,period:c.period});
    const [min,max]=(()=>{const a=data.flatMap(d=>[d.low,d.high]),lo=Math.min(...a),hi=Math.max(...a),pad=(hi-lo||Math.abs(hi)*.02||1)*.08;return [lo-pad,hi+pad];})();
    const top=w<600?48:36,priceBottom=c.height-27-Math.max(30,c.height*.16)-18;coords={left:12,right:86,x:i=>12+(w-98)/data.length*(i+.5),y:v=>top+(max-v)/(max-min)*(priceBottom-top)};
   }else{const result=lineSVG(c,data,w,c.height);canvas.innerHTML=result.svg;coords=result;}
   slider.max=Math.max(0,full.length-range.count);slider.value=range.start;slider.disabled=range.count===full.length;
   host.querySelector('.chart-range-label').textContent=`${range.start+1}–${range.start+range.count} / ${full.length} ${c.kind==='candle'?chartL('根 K 线','candles'):chartL('个记录','records')}`;
   for(const b of host.querySelectorAll('[data-chart-action]')){const a=b.dataset.chartAction;b.disabled=a==='in'?range.count<=Math.min(8,full.length):a==='out'||a==='fit'?range.count===full.length:a==='back'?range.start===0:range.start+range.count>=full.length;}
   const overview=host.querySelector('.range-overview-plot');overview.innerHTML=miniChart(full.map(d=>c.kind==='candle'?d.close:d.value)).replace('<svg ', '<svg preserveAspectRatio="none" ')+`<div class="range-selection" style="left:${range.start/full.length*100}%;width:${range.count/full.length*100}%"></div>`;
   for(const edge of host.querySelectorAll('[data-range-edge]')){const start=edge.dataset.rangeEdge==='start';edge.min=0;edge.max=full.length;edge.value=start?range.start:range.start+range.count;edge.disabled=full.length<9;}
   const inspecting=selected!==null;read(inspecting?Math.min(selected,data.length-1):data.length-1,true);if(!inspecting){selected=null;host.dataset.inspecting='false';if(!engine?.ready)canvas.querySelector('[data-crosshair]')?.remove();}
   if(engine&&!engine.ready)engine.update(range);
  }
  const pointRead=e=>{if(!coords)return;const rect=canvas.getBoundingClientRect(),x=(e.clientX-rect.left)*w/rect.width;read(Math.round((x-coords.left)/(w-coords.left-coords.right)*(data.length-1)));};
  let dragging=null;
  canvas.addEventListener('pointermove',e=>{
   readout.setAttribute('aria-live','off');if(engine?.ready)return;
   if(!dragging){pointRead(e);return;}
   if(!dragging.active){const intent=chartGesture(e.clientX-dragging.x,e.clientY-dragging.y);if(intent==='scroll'){dragging=null;return;}if(intent==='pending')return;dragging.active=true;canvas.setPointerCapture(e.pointerId);canvas.classList.add('is-dragging');}
   const delta=Math.round((dragging.x-e.clientX)/Math.max(1,canvas.clientWidth)*range.count);range=windowRange(full.length,dragging.start+delta,range.count);selected=null;draw();
  });
  canvas.addEventListener('pointerleave',e=>{if(e.pointerType==='touch')return;if(!dragging){read(data.length-1,true);selected=null;host.dataset.inspecting='false';if(engine?.ready)engine.clear();else canvas.querySelector('[data-crosshair]')?.remove();}});
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0||engine?.ready)return;pointRead(e);if(range.count<full.length){dragging={x:e.clientX,y:e.clientY,start:range.start,active:e.pointerType!=='touch'};if(dragging.active){canvas.setPointerCapture(e.pointerId);canvas.classList.add('is-dragging');}}});
  const endDrag=()=>{dragging=null;canvas.classList.remove('is-dragging');};canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
  canvas.addEventListener('wheel',e=>{if(engine?.ready||!e.ctrlKey&&!e.shiftKey)return;e.preventDefault();const count=Math.round(range.count*(e.deltaY>0?1.2:.8));range=windowRange(full.length,range.start+Math.round((range.count-count)/2),count);selected=null;draw();},{passive:false});
  canvas.addEventListener('keydown',e=>{if(['+','=','-','0','PageUp','PageDown'].includes(e.key)){e.preventDefault();host.querySelector(`[data-chart-action="${e.key==='0'?'fit':e.key==='PageUp'?'back':e.key==='PageDown'?'forward':e.key==='-'?'out':'in'}"]`)?.click();return;}if(e.key==='Escape'){e.preventDefault();read(data.length-1,true);selected=null;engine?.clear();canvas.querySelector('[data-crosshair]')?.remove();host.dataset.inspecting='false';return;}if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();readout.setAttribute('aria-live','polite');read(e.key==='Home'?0:e.key==='End'?data.length-1:(selected??data.length-1)+(e.key==='ArrowLeft'?-1:1));});
  canvas.addEventListener('dblclick',()=>host.querySelector('[data-chart-action="fit"]')?.click());
  host.querySelectorAll('[data-chart-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.chartAction;let start=range.start,count=range.count;if(a==='in'||a==='out'){count=Math.round(count*(a==='in'?.66:1.5));start+=Math.round((range.count-count)/2);}else if(a==='fit'){count=full.length;start=0;}else start+=(a==='back'?-1:1)*Math.max(1,Math.round(count/4));range=windowRange(full.length,start,count);selected=null;draw();});
  host.querySelectorAll('[data-range-edge]').forEach(edge=>edge.oninput=()=>{const action=edge.dataset.rangeEdge,view={min:range.start,max:range.start+range.count},next=adjustRange(view,{min:0,max:full.length},Math.min(8,full.length),action,Number(edge.value)-view[action==='start'?'min':'max']);range={start:next.min,count:next.max-next.min};selected=null;draw();});
  slider.oninput=()=>{range=windowRange(full.length,Number(slider.value),range.count);draw();};
  let resizeFrame=0;
  const observer=new ResizeObserver(()=>{
   if(resizeFrame)return;
   resizeFrame=requestAnimationFrame(()=>{
    resizeFrame=0;
    const width=canvas.clientWidth;
    if(width>0 && Math.abs(Math.max(240,width)-w)>1)draw();
   });
  });
  observer.observe(canvas);draw();
  if(valid)engine=createChartEngine(canvas,{config:c,format:{label:chartLabel,axis:formatChartAxis,value:v=>formatNumber(v,v!==0&&Math.abs(v)<1?Math.min(8,Math.ceil(-Math.log10(Math.abs(v)))+3):2)},onRange(start,count){const next=windowRange(full.length,start,count);if(next.start!==range.start||next.count!==range.count){range=next;selected=null;draw();}},onInspect(index){if(index>=range.start&&index<range.start+range.count)read(index-range.start,true);},onReady:draw});
  cleanup.push(()=>{observer.disconnect();if(resizeFrame)cancelAnimationFrame(resizeFrame);engine?.dispose();});
 });const dispose=()=>cleanup.forEach(fn=>fn());dispose.updateDraft=cleanup[0].updateDraft;return dispose;
}
export function miniChart(values,color='var(--chart-accent)'){return sparkline(values,{width:150,height:38,color,fill:false});}
