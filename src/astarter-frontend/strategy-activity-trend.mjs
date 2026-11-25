// Adapted from Kedhareswer's Cell Column Trend: stacked cells, metric tabs and diagonal flip.
// https://21st.dev/@kedhareswer/components/cell-column-trend
import {pair as L} from './locale.mjs';
import {activityOrders} from './trade-activity-skyline.mjs';
import {tokenIcon} from './brand-icons.mjs';

const metrics=[['fills','已成交订单','Filled orders'],['turnover','成交额','Turnover'],['allocation','累计分配','Allocated capital'],['fees','交易费','Trading fees']];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nonnegative=value=>Number.isFinite(value)&&value>=0?value:null;
const total=values=>values.some(value=>value===null)?null:Math.round(values.reduce((sum,value)=>sum+value,0)*1e8)/1e8;
const metricKey=key=>metrics.some(([id])=>id===key)?key:'fills';
const label=key=>L(...metrics.find(([id])=>id===key).slice(1));
const unit=key=>key==='fills'?'':' USDT';
const format=(value,key)=>value===null?'—':value.toLocaleString('en-US',{maximumFractionDigits:key==='fills'?0:value>0&&value<1?6:2});
const scaleFormat=(value,key)=>value>0&&value<.01?value.toExponential(0):value>=10000?(value/1000).toLocaleString('en-US',{maximumFractionDigits:1})+'k':format(value,key);

export function strategyActivityModel(trade,{accountId='SIM-01',environment='DEMO'}={}){
 const book=trade?.botBook;
 if(!Array.isArray(book?.runs)||trade?.botSummary?.recoveryError||accountId!=='SIM-01'||environment!=='DEMO')return {state:'unavailable',rows:[],totals:Object.fromEntries(metrics.map(([key])=>[key,null]))};
 const seen=new Set(),runs=book.runs.filter(run=>{
  const route=run?.plan?.executionRoute;
  if(!run?.id||seen.has(run.id)||run.environment!==environment||route?.accountId!==accountId||(run.plan.environment??route.environment)!==environment||run.plan.environment!==undefined&&run.plan.environment!==environment||route.environment!==undefined&&route.environment!==environment||!['S01','S02'].includes(run.plan.strategy))return false;
  seen.add(run.id);return true;
 });
 const offset=Math.max(0,runs.length-30),rows=runs.slice(offset).map((run,index)=>{
  let fills=null,turnover=null;
  if(Array.isArray(run.orders)){
   const originals=new Map();for(const order of run.orders)if(order?.id&&!originals.has(order.id))originals.set(order.id,order);
   const orders=activityOrders(run.orders.map(item=>({kind:'trade',item:{...item,accountId,runId:run.id}})),run.orders.length).groups;
   const malformed=run.orders.some(order=>typeof order?.id!=='string'||!order.id||!Number.isFinite(order.qty)||order.qty<0||!Number.isFinite(order.filled)||order.filled<0||order.filled>1);
   const confirmed=orders.filter(order=>{
    const original=originals.get(order.id);
    return original?.qty*original?.filled>0;
   });
   fills=malformed?null:confirmed.length;
   turnover=malformed?null:total(confirmed.map(order=>order.currency==='USDT'?order.amount:null));
  }
  const usdt=String(run.plan.market||'').split('/').at(-1)==='USDT';
  return {id:String(run.id),market:String(run.plan.market||''),sequence:offset+index+1,values:{fills,turnover,allocation:usdt?nonnegative(run.initialAllocation):null,fees:usdt?nonnegative(run.fees):null}};
 });
 return {state:rows.length?'ready':'empty',rows,totals:Object.fromEntries(metrics.map(([key])=>[key,total(rows.map(row=>row.values[key]))]))};
}

function niceMax(max){
 if(!(max>0))return 1;
 const power=10**Math.floor(Math.log10(max));
 for(const multiple of [1,1.2,1.6,2,2.4,3,4,5,6,8,10])if(multiple*power>=max)return multiple*power;
 return 10*power;
}
function plot(model,key,animate=false){
 const values=model.rows.map(row=>row.values[key]),max=Math.max(0,...values.filter(value=>value!==null));
 const top=key==='fills'?Math.max(4,Math.ceil(max/4)*4):niceMax(max);
 const marks=[1,.75,.5,.25],ticks=[0,Math.floor((model.rows.length-1)/2),model.rows.length-1].filter((value,index,all)=>all.indexOf(value)===index);
 return `<div class="sat-axis" aria-hidden="true">${marks.map(f=>`<span style="top:${(1-f)*100}%">${scaleFormat(top*f,key)}</span>`).join('')}</div><div class="sat-plot" id="sat-plot" role="group" tabindex="0" aria-label="${esc(label(key)+' · '+L('左右方向键查看实例','Use left and right arrows to explore runs'))}">${marks.map(f=>`<i class="sat-grid" style="top:${(1-f)*100}%" aria-hidden="true"></i>`).join('')}${model.rows.map((row,c)=>{
  const value=values[c],level=value===null?0:value<=0?0:Math.min(10,Math.max(1,Math.round(value/top*10)));
  return `<div class="sat-column${value===null?' sat-unknown':''}" data-sat-column="${c}" style="--sat-column:${c}" aria-hidden="true">${Array.from({length:10},(_,r)=>`<i class="sat-cell${r<level?' sat-filled':''}${r===level-1?' sat-cap':''}${animate?' sat-flip':''}" style="--sat-row:${r}"></i>`).join('')}</div>`;
 }).join('')}</div><div class="sat-x" aria-hidden="true">${ticks.map(index=>`<span style="left:${(index+.5)/model.rows.length*100}%">${model.rows[index].sequence}</span>`).join('')}</div>`;
}
function readout(model,key,index){
 const row=model.rows[index];
 return row?`<div><span class="sat-instrument">${tokenIcon(row.market.split('/')[0],{size:22})}${row.sequence} · ${esc(row.market)} <span class="sat-run-id">· ${esc(row.id)}</span></span><strong>${format(row.values[key],key)}<small>${unit(key)}</small></strong></div><a href="?page=execution&amp;runId=${encodeURIComponent(row.id)}">${L('查看运行','View run')}<span aria-hidden="true"> →</span></a>`:'';
}

export function strategyActivityTrendView(model,selected='fills'){
 const key=metricKey(selected),ready=model.state==='ready';
 const payload=JSON.stringify(model).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 const content=ready?`<div id="sat-content" role="tabpanel" aria-labelledby="sat-tab-${key}"><div class="sat-chart">${plot(model,key)}</div><div class="sat-readout" aria-live="polite">${readout(model,key,model.rows.length-1)}</div></div>`:`<div class="sat-empty"><span aria-hidden="true">${Array.from({length:12},()=>'<i></i>').join('')}</span><p>${model.state==='unavailable'?L('等待账户数据','Waiting for account data'):L('暂无运行记录','No run history yet')}</p></div>`;
 const controls=ready?`<div class="sat-metrics" role="tablist" aria-label="${L('活动指标','Activity metrics')}">${metrics.map(([id,zh,en])=>`<button type="button" role="tab" id="sat-tab-${id}" data-sat-metric="${id}" aria-selected="${id===key}" tabindex="${id===key?'0':'-1'}" aria-controls="sat-content"><span>${L(zh,en)}</span><strong>${format(model.totals[id],id)}<small>${unit(id)}</small></strong></button>`).join('')}</div>`:'';
 return `<section class="sat-panel" data-strategy-activity-trend data-sat-state="${model.state}" data-sat-metric="${key}" data-localized-ui aria-labelledby="sat-title"><header class="sat-heading"><h2 id="sat-title">${L('运行活动','Run activity')}</h2>${ready?`<span>${L('最近 30 个实例','Latest 30 runs')}</span>`:''}</header>${content}${controls}<script type="application/json" data-sat-data>${payload}</script></section>`;
}

export function mountStrategyActivityTrend(root,{onMetric=()=>{},onViewRun=null}={}){
 const host=root.querySelector('[data-strategy-activity-trend]');if(!host)return;
 const model=JSON.parse(host.querySelector('[data-sat-data]').textContent),tabs=[...host.querySelectorAll('.sat-metrics button')];
 let key=metricKey(host.dataset.satMetric),active=model.rows.length-1;
 host.onclick=event=>{
  if(typeof onViewRun!=='function'||event.defaultPrevented||event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const link=event.target?.closest?.('.sat-readout a'),id=model.rows[active]?.id;
  if(!link||!host.contains(link)||!id)return;
  event.preventDefault();onViewRun(id);
 };
 const show=index=>{
  active=Math.max(0,Math.min(model.rows.length-1,index));
  const output=host.querySelector('.sat-readout');if(output)output.innerHTML=readout(model,key,active);
  host.querySelectorAll('[data-sat-column]').forEach(column=>column.toggleAttribute('data-active',Number(column.dataset.satColumn)===active));
 };
 const bindPlot=()=>{
  host.querySelectorAll('[data-sat-column]').forEach(column=>{
   column.onpointerenter=()=>show(Number(column.dataset.satColumn));
   column.onpointerdown=()=>show(Number(column.dataset.satColumn));
  });
  const chart=host.querySelector('.sat-plot');if(!chart)return;
  chart.onkeydown=event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();show(event.key==='Home'?0:event.key==='End'?model.rows.length-1:active+(event.key==='ArrowLeft'?-1:1));
  };
 };
 const select=next=>{
  key=metricKey(next);host.dataset.satMetric=key;host.querySelector('#sat-content').setAttribute('aria-labelledby','sat-tab-'+key);
  tabs.forEach(tab=>{const selected=tab.dataset.satMetric===key;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;});
  const chart=host.querySelector('.sat-chart');if(chart){chart.innerHTML=plot(model,key,true);bindPlot();show(active);}
  onMetric(key);
 };
 tabs.forEach((tab,index)=>{
  tab.onclick=()=>select(tab.dataset.satMetric);
  tab.onkeydown=event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowLeft'?tabs.length-1:1))%tabs.length;
   select(tabs[next].dataset.satMetric);tabs[next].focus({preventScroll:true});
  };
 });
 bindPlot();
}
