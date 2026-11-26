import {RESEARCH_GROUPS} from './multi-research.mjs';
import {ASSETS,observationSnapshot,observationPrice} from './product-data.mjs';
import { evidenceRoleState } from './evidence-process.mjs';
import { createResearchJournal } from './research-journal.js';
import { sourceValue, seriesValue } from './research-state.mjs';
import { ROLES } from './simulation.mjs';
import { reactorRoleColor } from './reactor.js';
import { L } from './execution-views.mjs';

// Deterministic synthetic series. They are presentation data, not market quotes.
const $=id=>document.getElementById(id);
const colors=[1,4,2,0,3].map(i=>RESEARCH_GROUPS[i].color);
const sourceColors=Object.fromEntries([['depth',0],['trend',3],['macro',5],['social',2],['chain',1],['risk',4]].map(([key,i])=>[key,RESEARCH_GROUPS[i].color]));
const value=seriesValue;
const fmt=n=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const curve=(points,w,h,min,max)=>points.map((y,i)=>`${i?'L':'M'}${(i/(points.length-1)*w).toFixed(1)},${(h-(y-min)/(max-min)*h).toFixed(1)}`).join(' ');
const panel=(title,content,classes='')=>`<section class="reactor-data-card ${classes}"><div class="reactor-card-head"><h3>${title}</h3><span>SIM</span></div>${content}</section>`;
const roleNames=['环境扫描','多周期趋势','价格结构','量价研究','盘口观察','波动检测','规则映射','做多论证','减仓论证','反证质询','等待条件','情景推演','决策整合','组合敞口','资本保护','执行审阅','运行诊断','交易复盘'];
const stateName={running:'处理中',queued:'待命',done:'已交接',idle:'未调用',cancelled:'已中止'};
export function createReactorPanels({onSelect,onOpen,onRole,onSource}){
  const monitor=document.createElement('section');monitor.className='reactor-monitor reactor-only';monitor.innerHTML='<div class="section-label"><h3>市场切片</h3><span>合成序列</span></div><div id="reactor-market-slices"></div>';
  document.querySelector('.status-panel .metrics').after(monitor);
  const stage=document.querySelector('.network-stage');
  const journal=createResearchJournal(stage);
  stage.querySelector('.scene-switch')?.remove();
  const record=document.createElement('button');record.type='button';record.className='research-open reactor-only';record.textContent='研究记录 ↗';record.onclick=()=>onOpen?onOpen():journal.open();stage.querySelector('.stage-controls').prepend(record);
  const roleRecord=document.createElement('button');roleRecord.type='button';roleRecord.className='role-record reactor-only';roleRecord.textContent='查看职责与输出 ↗';roleRecord.onclick=()=>onRole?onRole(Number(document.querySelector('#focus-role').value)):journal.open('roles',null,Number(document.querySelector('#focus-role').value));document.querySelector('.focused-agent').append(roleRecord);
  const strip=document.createElement('div');strip.className='reactor-market-strip reactor-only';strip.innerHTML='<div><span id="reactor-symbol">跨市场观察</span><strong id="reactor-price">8</strong><small id="reactor-price-change">观察资产 · SIM</small></div><dl><div><dt>聚焦核验</dt><dd id="reactor-spread">—</dd></div><div><dt>证据交接</dt><dd id="reactor-transfers">00</dd></div><div><dt>核验进度</dt><dd id="reactor-progress">00%</dd></div></dl>';
  const header=document.createElement('header');header.className='workbench-header';
  const heading=stage.querySelector('.stage-heading'),actions=heading.querySelector('.stage-controls');
  header.append(heading,strip,actions);stage.prepend(header);
  const sources=[['depth','盘口深度','指数',0],['trend','趋势结构','指数',4],['macro','宏观事件','项',1],['social','社交舆情','热度',2],['chain','链上异动','笔',3],['risk','风险条件','角色',5]];
  const dock=document.createElement('div');dock.className='reactor-source-dock reactor-only';dock.setAttribute('aria-label','Agent 采集的数据源');dock.innerHTML=sources.map(([key,name,unit,i])=>`<button type="button" aria-label="查看${name}来源与记录" class="reactor-source-chip" data-collector-source="${key}" style="--signal-color:${sourceColors[key]}"><div><span>${name}</span><em>SIM</em></div><strong data-source-value="${key}">—</strong><small>${unit}</small><svg viewBox="0 0 92 20" preserveAspectRatio="none" aria-hidden="true"></svg></button>`).join('');stage.append(dock);
  for(const b of dock.children)b.onclick=()=>onSource?onSource(b.dataset.collectorSource):journal.open('evidence',b.dataset.collectorSource);
  const rail=document.createElement('div');rail.className='reactor-signal-rail reactor-only';rail.innerHTML=panel('角色进度','<div id="reactor-evidence-bars"></div>');stage.append(rail);
  const ribbon=document.createElement('div');ribbon.className='reactor-agent-ribbon reactor-only';ribbon.setAttribute('aria-label','本轮 Agent 动向');ribbon.id='reactor-agent-ribbon';stage.append(ribbon);
  const bottom=document.createElement('div');bottom.className='reactor-bottom-grid reactor-only';bottom.innerHTML=panel('跨资产走势','<div class="reactor-chart-quote"><strong id="reactor-chart-price">—</strong><span id="observation-chart-unit">相对走势 · 起点 100</span></div><div class="reactor-chart-wrap"><svg id="reactor-price-chart" data-collector-zone="market" data-collector-source="trend" viewBox="0 0 500 126" preserveAspectRatio="none" role="img" aria-label="合成行情蜡烛图及成交量"></svg><div class="reactor-book" id="reactor-book" data-collector-zone="orderbook" data-collector-source="depth" aria-label="合成盘口深度"></div></div><div class="reactor-chart-footer"><span>−81s</span><span>−40s</span><span>现在</span></div>','reactor-market-card')+panel('本轮研究','<span class="research-result-label" id="research-result-label"></span><h3 id="research-result-title"></h3><p id="research-result-detail"></p><div id="research-evidence-counts"></div><button type="button" id="research-result-open">结论与下一步 ↗</button>','reactor-flow-card');stage.append(bottom);
  $('research-result-open').onclick=()=>journal.open('result');
  const picker=document.createElement('select');picker.id='observation-market';picker.setAttribute('aria-label','切换观察图表，不改变交易盘口');picker.innerHTML='<option value="overview">全部资产</option>'+ASSETS.map(a=>`<option value="${a[0]}">${a[0]} · ${a[1]}</option>`).join('');bottom.querySelector('.reactor-market-card .reactor-card-head').append(picker);
  const compareInfo=document.createElement('button');compareInfo.type='button';compareInfo.className='observation-info';compareInfo.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></svg>';compareInfo.setAttribute('aria-expanded','false');const compareNote=document.createElement('p');compareNote.className='observation-note';compareNote.hidden=true;bottom.querySelector('.reactor-market-card .reactor-card-head').append(compareInfo);bottom.querySelector('.reactor-market-card .reactor-card-head').after(compareNote);compareInfo.onclick=()=>{compareNote.hidden=!compareNote.hidden;compareInfo.setAttribute('aria-expanded',String(!compareNote.hidden));};
  let chartSubject='overview',lastContext=null;
  picker.onchange=()=>{chartSubject=picker.value;lastTick='';if(lastContext)update(...lastContext);};
  let lastTick='',lastActors='',chartWidth=500,chartHeight=126;
  const chart=$('reactor-price-chart');
  const chartResize=new ResizeObserver(([entry])=>{
    if(!entry)return;
    const width=Math.max(260,entry.contentRect.width),height=entry.contentRect.height||190;
    if(width!==chartWidth||height!==chartHeight){chartWidth=width;chartHeight=height;lastTick='';}
  });
  chartResize.observe(chart);
  function update(model,market,{stopped=false,selected=-1}={}){
    lastContext=[model,market,{stopped,selected}];
    const t=model.elapsed,tick=Math.floor(t*2),actors=model.config.actors;
    const report=journal.update(model,market,{stopped,selected});
    bottom.dataset.evidenceRevision=report.process.revision;bottom.dataset.evidenceReady=String(report.complete);$('research-evidence-counts').textContent=`保留 ${report.process.counts.retain} · 旁证 ${report.process.counts.context} · 分歧 ${report.process.counts.conflict} · 待补 ${report.process.counts.missing}`;
    bottom.querySelector('.reactor-flow-card .reactor-card-head h3').textContent='聚焦研究 · '+market.split('/')[0];
    $('research-result-label').textContent=report.interrupted?'已中止':report.complete?'当前核验 · SIM':'核验处理中 · SIM';$('research-result-title').textContent=report.result;$('research-result-detail').textContent=report.detail;
    if(lastActors!==model.key+actors.join()){lastActors=model.key+actors.join();ribbon.replaceChildren();for(const id of actors){const b=document.createElement('button');b.type='button';b.dataset.role=String(id);b.innerHTML=`<span class="reactor-mini-avatar" style="--agent-color:${reactorRoleColor(id)}">${ROLES[id].id.slice(1)}</span><span><strong>${roleNames[id]}</strong><small>待命</small></span><i></i>`;b.setAttribute('aria-label',`聚焦 ${ROLES[id].id} ${ROLES[id].name}`);b.onclick=()=>onSelect(id);ribbon.append(b);}}
    for(const b of ribbon.children){const id=Number(b.dataset.role),raw=evidenceRoleState(model,id),status=stopped&&['queued','running'].includes(raw)?'cancelled':raw;b.dataset.status=status;b.setAttribute('aria-pressed',String(id===selected));b.querySelector('small').textContent=stopped?'本轮结束':document.querySelector(`.agent-courier[data-agent-role="${id}"] small`)?.textContent||stateName[status];}
    $('reactor-transfers').textContent=String(model.handoffs).padStart(2,'0');$('reactor-progress').textContent=`${report.complete?100:Math.min(99,Math.floor(report.process.items.reduce((n,i)=>n+(i.stage+i.progress)/6,0)/report.process.expected*100))}%`;
    const signature=`${tick}:${market}:${chartSubject}:${model.key}:${model.epoch}:${chartWidth}:${chartHeight}`;
    if(signature!==lastTick){
      lastTick=signature;
      const overview=chartSubject==='overview',observations=observationSnapshot(t),asset=observations.find(a=>a.symbol===chartSubject)||observations[0];
      const mult=asset.price*.00022,price=n=>observationPrice(asset.symbol,n);
      const current=price(t*2),change=(current/price(0)-1)*100;
      $('reactor-symbol').textContent='跨市场观察';$('reactor-price').textContent=String(observations.length);$('reactor-price-change').textContent='观察资产 · Crypto / TradFi';$('reactor-spread').textContent=market.split('/')[0];
      $('reactor-chart-price').textContent=overview?L('区间变化','Window change'):fmt(current);$('observation-chart-unit').textContent=overview?L('最近 81 秒 · 合成序列','Last 81 seconds · synthetic series'):`${asset.symbol} · ${asset.unit} · ${L('合成序列','Synthetic series')}`;
      bottom.querySelector('.reactor-market-card .reactor-card-head h3').textContent=L('跨资产走势','Market trends');picker.options[0].textContent=L('全部资产','All assets');picker.setAttribute('aria-label',L('切换观察图表，不改变交易盘口','Choose a chart asset without changing the trading market'));bottom.dataset.observation=chartSubject;
      compareInfo.setAttribute('aria-label',L('走势比较说明','About this comparison'));compareNote.textContent=L('同一81秒窗口内，比较各资产数值相对起点的变化；0%为起点。国债比较的是收益率数值，不是投资收益。当前为合成序列。点击图例可单独查看。','Compares value changes from the same 81-second starting point. Treasury series compares yield values, not investment returns. Uses synthetic series. Choose a legend item to inspect one asset.');
      const sliceNames=['盘口深度','买卖价差','波动区间','量价关系','趋势结构'];
      for(const [key,name,unit,i]of sources){const el=dock.querySelector(`[data-collector-source="${key}"]`),points=Array.from({length:26},(_,k)=>Number(sourceValue(key,Math.max(0,t-(25-k)*1.5),actors)));el.querySelector('strong').textContent=sourceValue(key,t,actors);el.querySelector('svg').innerHTML=`<path d="${curve(points,92,18,Math.min(...points)-.1,Math.max(...points)+.1)}" fill="none" stroke="currentColor" stroke-width="1.1"/>`;}

      $('reactor-market-slices').innerHTML=sliceNames.map((name,i)=>{const points=Array.from({length:35},(_,k)=>value(t*.65-35+k,i));return `<div class="reactor-slice" data-collector-source="${['depth','spread','volatility','volume','trend'][i]}" style="--signal-color:${colors[i]}"><div><span>${name}</span><b>${sourceValue(['depth','spread','volatility','volume','trend'][i],t,actors)} <small>${i===1?'bps':i===2?'%':'指数'}</small></b></div><svg viewBox="0 0 192 25" preserveAspectRatio="none" aria-hidden="true"><path d="${curve(points,192,23,-2.8,2.8)}" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="${curve(points,192,23,-2.8,2.8)} L192,25 L0,25 Z" fill="currentColor" opacity=".07"/></svg></div>`;}).join('');
      const start=t*2-162,candles=Array.from({length:54},(_,i)=>{const n=start+i*3,o=price(n),c=price(n+3),hi=Math.max(o,c)+(value(n,6)+2)*mult*.18,lo=Math.min(o,c)-(value(n,9)+2)*mult*.18;return {o,c,hi,lo};});
      const width=chartWidth,height=chartHeight,right=width-72,plotWidth=right-10;
      chart.setAttribute('viewBox',`0 0 ${width} ${height}`);
      const low=Math.min(...candles.map(c=>c.lo))-mult*.3,high=Math.max(...candles.map(c=>c.hi))+mult*.3,Y=p=>12+(high-p)/(high-low)*(height-66),X=i=>10+i/53*plotWidth,barWidth=Math.max(1.5,plotWidth/54*.55);
      const paths=[high,(high+low)/2,low].map(v=>`<line x1="8" y1="${Y(v)}" x2="${right}" y2="${Y(v)}" class="chart-grid"/><text x="${right+8}" y="${Y(v)+3}" fill="var(--b-muted)" font-size="11">${fmt(v)}</text>`).join('');
      const candleSvg=candles.map((c,i)=>{const x=X(i),up=c.c>=c.o,volume=4+Math.abs(c.c-c.o)/mult*12;return `<g class="${up?'candle-up':'candle-down'}"><path d="M${x.toFixed(1)} ${Y(c.hi).toFixed(1)}V${Y(c.lo).toFixed(1)}" stroke="currentColor" stroke-width=".8"/><rect x="${(x-barWidth/2).toFixed(1)}" y="${Math.min(Y(c.o),Y(c.c)).toFixed(1)}" width="${barWidth}" height="${Math.max(1.2,Math.abs(Y(c.o)-Y(c.c))).toFixed(1)}" fill="currentColor"/><rect x="${(x-barWidth/2).toFixed(1)}" y="${height-26-volume}" width="${barWidth}" height="${volume}" fill="currentColor" opacity=".25"/></g>`;}).join('');
      const avg=candles.map((c,i)=>candles.slice(Math.max(0,i-6),i+1).reduce((sum,c)=>sum+c.c,0)/Math.min(7,i+1));
      const trend=avg.map((p,i)=>`${i?'L':'M'}${X(i)},${Y(p).toFixed(1)}`).join(' '),latest=Y(candles.at(-1).c).toFixed(1);
      chart.innerHTML=paths+`<g style="color:var(--chart-series-2)"><path class="observation-trail" d="${trend}"/><path class="observation-core" d="${trend}"/></g>`+candleSvg+`<line x1="8" y1="${latest}" x2="${right}" y2="${latest}" stroke="var(--ok)" stroke-dasharray="3 3" opacity=".5"/><text x="8" y="${height-8}" fill="var(--b-muted)" font-size="11">${L('81秒前','81s ago')}</text><text x="${right/2}" y="${height-8}" text-anchor="middle" fill="var(--b-muted)" font-size="11">${L('40秒前','40s ago')}</text><text x="${right}" y="${height-8}" text-anchor="end" fill="var(--b-muted)" font-size="11">${L('现在','Now')}</text>`;
      $('reactor-book').innerHTML=Array.from({length:8},(_,i)=>{const buy=i>=4,depth=22+(value(t*.35+i,4)+2)*21;return `<div class="${buy?'bid':'ask'}" style="--depth:${Math.min(98,depth)}%"><span>${fmt(current+(3.5-i)*current*Number(sourceValue('spread',t,actors))/10000)}</span><b>${(depth*.13).toFixed(2)}</b></div>`;}).join('');
      if(overview){
        const tones=[3,1,5,2,8,4,7,6].map(i=>`var(--chart-series-${i})`),width=chartWidth,height=chartHeight,right=width-52,plotWidth=right-10;
        $('reactor-price-chart').setAttribute('viewBox',`0 0 ${width} ${height}`);
        const all=observations.flatMap(a=>a.normalized.map(v=>v-100)),extent=Math.max(.025,...all.map(Math.abs))*1.15,lo=-extent,hi=extent,y=v=>12+(hi-v)/(hi-lo)*(height-48);
        const signed=v=>(v>0?'+':'')+v.toFixed(2)+'%';
        const grids=[lo,0,hi].map(v=>`<line x1="8" x2="${right}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/><text x="${right+8}" y="${y(v)+3}" fill="var(--b-muted)" font-size="11">${signed(v)}</text>`).join('');
        $('reactor-price-chart').innerHTML=grids+observations.map((a,i)=>{
          const path=a.normalized.map((v,j)=>`${j?'L':'M'}${10+j/53*plotWidth},${y(v-100).toFixed(2)}`).join(' ');
          return `<g style="color:${tones[i]}"><title>${a.symbol} · ${signed(a.change)}</title><path class="observation-trail" d="${path}"/><path class="observation-core" d="${path}"/><circle cx="${right}" cy="${y(a.change).toFixed(2)}" r="2.2" fill="currentColor"/></g>`;
        }).join('')+`<text x="8" y="${height-8}" fill="var(--b-muted)" font-size="11">${L('81秒前','81s ago')}</text><text x="${right/2}" y="${height-8}" text-anchor="middle" fill="var(--b-muted)" font-size="11">${L('40秒前','40s ago')}</text><text x="${right}" y="${height-8}" text-anchor="end" fill="var(--b-muted)" font-size="11">${L('现在','Now')}</text>`;
        $('reactor-book').innerHTML=observations.map((a,i)=>`<button type="button" data-observe="${a.symbol}" style="--observation-color:${tones[i]}" aria-label="${L('查看','View')} ${a.symbol}"><i aria-hidden="true"></i><span>${a.symbol}</span><b>${signed(a.change)}</b></button>`).join('');
        $('reactor-book').querySelectorAll('[data-observe]').forEach(b=>b.onclick=()=>{picker.value=b.dataset.observe;picker.onchange();});
      }else if(asset.domain==='TradFi'){$('reactor-book').innerHTML=`<div class="observation-context"><b>${asset.symbol}</b><span>${asset.unit}</span><small>TradFi 观察</small></div>`;}
      $('reactor-price-chart').setAttribute('aria-label',overview?L('各资产在最近81秒的数值变化，0%为同一窗口起点。国债显示收益率数值的相对变化，不是投资收益。图例可选择单个资产。','Relative changes over the last 81 seconds; 0% is the shared window start. Treasury values compare yields, not investment returns. Choose an asset in the legend.'): `${asset.symbol} ${L('合成行情','Synthetic market')}`);
      $('reactor-book').classList.toggle('observation-legend',overview);$('reactor-book').setAttribute('aria-label',overview?L('资产与区间变化','Assets and window changes'):L('合成盘口深度','Synthetic order book'));$('reactor-book').dataset.collectorSource=overview||asset.domain==='TradFi'?'trend':'depth';$('reactor-book').dataset.collectorZone=overview||asset.domain==='TradFi'?'market-overview':'orderbook';
      const bars=['市场','策略','风险','复盘'],groups=['market','research','risk','review'];$('reactor-evidence-bars').innerHTML=bars.map((label,i)=>{const members=actors.filter(id=>ROLES[id].group===groups[i]),done=members.filter(id=>evidenceRoleState(model,id)==='done').length;return `<div style="--signal-color:${colors[i]}"><span>${label}</span><i><b style="width:${members.length?done/members.length*100:0}%"></b></i><em>${members.length?done+'/'+members.length:'—'}</em></div>`;}).join('');

    }
  }
  return {update,openRole:id=>onRole?onRole(id):journal.open('roles',null,id),dispose(){chartResize.disconnect();journal.dispose();for(const el of [monitor,strip,dock,rail,ribbon,bottom,record,roleRecord])el.remove();}};
}
