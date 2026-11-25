import {pair as L,getLocale} from './locale.mjs';
import {formatDataTime} from './product-help.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {attachChartSeriesLight} from './product-charts.mjs';
import {hostedChartSymbol,hostedChartPanel,mountHostedChart} from './tradingview-widget.mjs';
import {CANDLE_PERIODS,candleRequest,mergeCandle,paperChartData,subscribeCandles,gridChartLevels,orderChartLevels,chartDraftConfig,chartWindowRestore,captureMarketWindow,recordedChartSnapshot,candleTechnicalStudy} from './trading-chart-data.mjs?v=20261123a';

const configs=new Map(),preferences=new Map(),mountedCharts=new WeakMap();let library;
export function captureTradingChart(host){const chart=host&&mountedCharts.get(host);if(!chart?.capture)throw Error('MARKET_NOT_READY');return chart.capture();}
export function readTradingChartQuote(host){const chart=host&&mountedCharts.get(host);if(!chart?.quote)throw Error('MARKET_NOT_READY');return chart.quote();}
export function formatTradingPrice(value,locale=getLocale()){
 if(!Number.isFinite(value))return '—';
 return value.toLocaleString(locale==='zh'?'zh-CN':locale,{maximumFractionDigits:value>0&&value<1?Math.min(8,Math.ceil(-Math.log10(value))+3):2});
}
export function chartQuoteSnapshot(config,bars,status,now=Date.now()){
 const request=candleRequest(config),last=bars.at(-1),closed=request&&bars.findLast(bar=>(bar.time+request.seconds)*1000<=Math.min(now,status?.asOf));
 if(!request||request.sessionBased||!['live','snapshot'].includes(status?.state)||!Number.isFinite(status.asOf)||now-status.asOf>30_000||status.asOf>now+30_000||!last||!closed||now-last.time*1000>request.seconds*1000+30_000||last.time*1000>now+30_000||![last.close,closed.close].every(value=>Number.isFinite(value)&&value>0))throw Error('MARKET_NOT_READY');
 return {market:request.market,profileId:request.profileId,venueId:request.venueId,period:request.period,price:last.close,closedPrice:closed.close,closedAt:(closed.time+request.seconds)*1000,asOf:status.asOf,state:status.state};
}
export function loadTradingChartLibrary(){return library??=import('./node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs').catch(error=>{library=null;throw error;});}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=path=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const expand=icon('M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5');
const refresh=icon('M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17');
const elapsed=time=>{const s=Math.max(0,Math.floor(Number(time)));return '+'+[Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(x=>String(x).padStart(2,'0')).join(':');};
export function chartSourceTime(time,timezone){
 if(!Number.isFinite(time))return '—';
 if(!timezone)return formatDataTime(time*1000);
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(time*1000).map(part=>[part.type,part.value]));
 return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
export function chartStudyAvailable(status,bars,now=Date.now()/1000){
 if(['snapshot','live'].includes(status.state))return true;
 return status.state==='refreshing'&&Number.isFinite(status.closedAt)&&bars.findLast(bar=>bar.closedAt===status.closedAt)?.validUntil>=now;
}
export function chartTickLabel(time,kind,period,timezone){
 const stamp=typeof time==='number'?chartSourceTime(time,timezone):'—';
 if(stamp==='—')return null;
 if(kind===0)return stamp.slice(0,4);
 if(kind===1)return stamp.slice(0,7);
 if(kind===2||period==='1D')return stamp.slice(5,10);
 return stamp.slice(11,kind===4?19:16);
}
export function chartAnalysisTaskView(lines,{kind,x,y,formatPrice=formatTradingPrice,formatTime=chartSourceTime,width=Infinity,height=Infinity,idPrefix='study'}){
 const primary={trend:/^(regression-0|ema-slow)$/,structure:/^(swing-(high|low)-0|structure-break-)/,value:/^anchored-vwap$/,momentum:/^ema-fast$/,range:/^prior-/}[kind];
 let geometry='',legend='';const labels=[];
 for(const line of [...lines].sort((a,b)=>Number(b.kind==='zone')-Number(a.kind==='zone'))){
  const points=line.points||[],zone=line.kind==='zone',range=line.range;
  if(!points.length||points.some(point=>!Number.isFinite(point.time)||point.time<0||!Number.isFinite(point.value)||point.value<=0))continue;
  if(zone&&(!Array.isArray(range)||range.length!==2||range.some(value=>!Number.isFinite(value)||value<=0)||range[0]>range[1]))continue;
  const last=points.at(-1),color=esc(line.color||'currentColor'),emphasis=primary?.test(line.key)?'primary':'context';
  const confirmations=points.map(point=>point.confirmedAt).filter(value=>Number.isFinite(value)&&value>=0);
  const confirmedAt=Number.isFinite(line.confirmedAt)&&line.confirmedAt>=0?line.confirmedAt:confirmations.length?Math.max(...confirmations):null;
  const anchorTime=Number.isFinite(line.anchorTime)&&line.anchorTime>=0?line.anchorTime:null;
  const metadata=[],attributes=[];
  if(anchorTime!==null){metadata.push(L('锚点','Anchor')+' '+formatTime(anchorTime));attributes.push(`data-anchor-time="${anchorTime}"`);}
  if(confirmedAt!==null){metadata.push(L('确认','Confirmed')+' '+formatTime(confirmedAt));attributes.push(`data-confirmed-at="${confirmedAt}"`);}
  const coordinates=points.map(point=>({x:x(point.time),y:y(point.value)}));let start=true,complete=true;
  const d=coordinates.map(point=>{if(!Number.isFinite(point.x)||!Number.isFinite(point.y)){start=true;complete=false;return '';}
   const command=start?'M':'L';start=false;return `${command}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).filter(Boolean).join(' ');
  if(d&&(!zone||complete)){
   const surface=['cloud','retracement'].includes(line.surface)?line.surface:'region';
   const paintId=('study-'+idPrefix+'-'+line.key).replace(/[^a-zA-Z0-9_-]/g,'-');
   const zonePaint=zone?`<defs><linearGradient id="${paintId}" x1="0" y1="0" x2="${surface==='cloud'?'0':'1'}" y2="${surface==='cloud'?'1':'0'}"><stop offset="0" stop-color="var(--analysis-stroke)" stop-opacity="${surface==='cloud'?'.2':'.06'}"/><stop offset=".5" stop-color="var(--analysis-stroke)" stop-opacity="${surface==='cloud'?'.06':'.15'}"/><stop offset="1" stop-color="var(--analysis-stroke)" stop-opacity=".24"/></linearGradient></defs><path class="analysis-zone" style="--analysis-fill:url(#${paintId})" d="${d} Z"/><path class="analysis-boundary" pathLength="1" d="${d} Z"/>`:'';
   const anchor=anchorTime===null?null:coordinates[points.findIndex(point=>point.time===anchorTime)];
   const dot=anchor&&Number.isFinite(anchor.x)&&Number.isFinite(anchor.y)?`<circle class="analysis-anchor" cx="${anchor.x.toFixed(2)}" cy="${anchor.y.toFixed(2)}" r="2.5"/>`:'';
   const anchors=(line.anchors||[]).flatMap(point=>{const px=x(point.time),py=y(point.value);return Number.isFinite(px)&&Number.isFinite(py)?[`<circle class="analysis-anchor" cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="2.5"/>`]:[]}).join('');
   const endX=Math.max(...coordinates.filter(p=>Number.isFinite(p.x)).map(p=>p.x)),labelX=Math.min(endX-6,width-12);
   let labelY=(zone?Math.min(...coordinates.map(p=>p.y)):coordinates.at(-1).y)-7;
   while(labels.some(p=>Math.abs(p.x-labelX)<100&&Math.abs(p.y-labelY)<15))labelY-=15;
   const label=line.label&&complete&&labelX>36&&labelY>14&&labelY<height-8?`<text class="analysis-label" x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="end">${esc(line.label)}</text>`:'';
   if(label)labels.push({x:labelX,y:labelY});
   geometry+=`<g style="--analysis-color:${color}" data-analysis-method="${esc(line.key)}" data-analysis-kind="${zone?'zone':'line'}" ${zone?`data-analysis-surface="${surface}"`:''} data-emphasis="${emphasis}" data-last-time="${Math.max(...points.map(point=>point.time))}" ${attributes.join(' ')}>${zone?zonePaint:`<path class="analysis-glow" d="${d}"/><path class="analysis-core" pathLength="1" d="${d}"/>`}${dot}${anchors}${label}</g>`;
  }
  const value=zone?`${formatPrice(range[0])} – ${formatPrice(range[1])}`:formatPrice(last.value);
  legend+=`<span class="trading-analysis-item" style="--analysis-color:${color}" data-emphasis="${emphasis}"><i></i><span>${esc(L(line.zh,line.en))}<b>${zone?L('范围','Range')+' ':''}${esc(value)}</b>${metadata.length?`<small>${metadata.map(esc).join(' · ')}</small>`:''}</span></span>`;
 }
 return {geometry,legend};
}
export function tradingChartPanel(key,{market='BTC/USDT',period='1H',profileId='cex-spot',venueId='binance',trade=null,gridPreview=false,gridPlan=null,identity=null,planRef=null,recorded=null,analysisLayers=false,analysisTask=null,hostedMarket=false,instrumentPicker=false}={}){
 // An incomplete overlay must not prevent the read-only market chart from loading.
 if(gridPlan){try{gridChartLevels({...gridPlan,referencePrice:gridPlan.referencePrice??gridPlan.lower});}catch{gridPlan=null;}}
 let snapshot=null,snapshotError=false;if(recorded){try{snapshot=recordedChartSnapshot(recorded,market);period=snapshot.period;}catch{snapshotError=true;}}
 const paper=trade?.session?paperChartData(trade,identity):null;
 const preferenceKey=[key,profileId,venueId,market,identity?.accountId||'',identity?.connectionId||'',identity?.instrumentId||'',identity?.runId||'',snapshot?.id||'',snapshot?.version||''].join(':');period=analysisTask?analysisTask.plan.steps[0].period:snapshot?period:preferences.get(preferenceKey)?.period||period;
 const request=candleRequest({market,period,profileId,venueId});
 const config={market,period:Object.hasOwn(CANDLE_PERIODS,period)?period:'1H',profileId,venueId,paper,preferenceKey,gridPreview,gridPlan,identity,planRef,analysisLayers,analysisTask,recorded:snapshot,snapshotError,orders:orderChartLevels(trade,identity),instrumentPicker,hostedMarket:hostedMarket&&!trade};configs.set(key,config);
 if(hostedChartSymbol(config))return hostedChartPanel(key,config);
 const identityContent=`${tokenIcon(market.split('/')[0],{size:24})}<strong>${esc(market||L('待检查交易标的','Review trading instrument'))}</strong><span>${snapshot?esc(snapshot.provider):request?.source?esc(request.source+(request.unit?' · '+request.unit:'')):request?.reference?L('币安现货参考价','Binance spot reference'):request?'Binance · '+L('现货','Spot'):esc(venueId)}</span>`;
 const instrument=instrumentPicker?`<button type="button" class="trading-chart-identity trading-chart-instrument" data-tc-action="choose-instrument" aria-haspopup="dialog" aria-label="${L('选择交易对象','Choose instrument')}">${identityContent}${icon('m6 9 6 6 6-6')}</button>`:`<span class="trading-chart-identity">${identityContent}</span>`;
 return `<section class="trading-chart" data-trading-chart="${esc(key)}" data-localized-ui aria-label="${esc(market)} ${L('行情与成交','Market & fills')}"><header class="trading-chart-head">${instrument}<div class="trading-chart-head-actions">${paper?`<div class="trading-chart-views" role="group" aria-label="${L('图表内容','Chart content')}"><button type="button" data-tc-view="market" aria-pressed="true">${L('市场 K 线','Market')}</button><button type="button" data-tc-view="paper" aria-pressed="false">${L('模拟成交','Paper fills')}<small>${paper.fills.length}</small></button></div>`:''}<button type="button" class="trading-chart-icon" data-tc-action="expand" title="${L('放大图表','Expand chart')}" aria-label="${L('放大图表','Expand chart')}">${expand}</button></div></header><div class="trading-chart-toolbar"><div class="trading-chart-periods" role="group" aria-label="${L('K 线周期','Candle interval')}">${analysisTask?`<span class="trading-study-step"></span>`:(request?.sessionBased?['1D']:Object.keys(CANDLE_PERIODS)).map(p=>`<button type="button" data-tc-period="${p}" aria-pressed="${p===period}">${p}</button>`).join('')}</div><span class="trading-chart-clock" hidden>${L('模拟时钟 · 仅本轮成交','Simulation clock · this run only')}</span><div class="trading-chart-tools">${analysisTask?`<button type="button" data-tc-action="study-resume" hidden>${L('自主分析','Auto analysis')}</button>`:''}${analysisLayers?`<button type="button" data-tc-action="analysis" aria-pressed="true" title="${L('显示技术绘图','Show analysis drawings')}" aria-label="${L('显示技术绘图','Show analysis drawings')}">${analysisTask?icon('M3 17 9 11l4 3 8-10M3 21h18'):L('技术结构','Structure')}</button>`:''}<button type="button" data-tc-action="fit" title="${L('显示全部','Fit all')}" aria-label="${L('显示全部','Fit all')}">${icon('M4 4v16m16-16v16M4 12h16m-4-4 4 4-4 4M8 8l-4 4 4 4')}</button><button type="button" data-tc-action="refresh" title="${L('刷新行情','Refresh market')}" aria-label="${L('刷新行情','Refresh market')}">${refresh}</button></div></div>${gridPreview?gridControls():''}<div class="trading-chart-draft-error" data-tc-draft-error role="alert" hidden></div><div class="trading-chart-readout" aria-live="off"></div><div class="trading-chart-stage"><div class="trading-chart-canvas" tabindex="0" role="group" aria-label="${L('价格与成交量，左右方向键查看数据，加减键缩放','Price and volume. Arrow keys inspect; plus and minus zoom.')}"></div><div class="trading-chart-levels" aria-hidden="true"></div><div class="trading-chart-message" role="status"></div></div><div class="trading-chart-fill" aria-live="polite" hidden></div>${analysisLayers?`<details class="trading-analysis-key"><summary>${L('等待已收盘 K 线','Awaiting closed candles')}</summary><div></div></details>`:''}<footer class="trading-chart-footer"><span class="trading-chart-status" role="status"><i></i><span>${L('加载行情','Loading market')}</span></span><time></time><span class="trading-chart-legal"><a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a><a href="/vendor/tradingview-NOTICE.txt" target="_blank" rel="noopener" aria-label="TradingView ${L('版权声明','copyright notice')}">©</a></span></footer></section>`;
}

export function tradingChartPalette(host){
 const probe=document.createElement('span');probe.hidden=true;host.append(probe);
 const color=(token,fallback)=>{probe.style.color=`var(${token},${fallback})`;return getComputedStyle(probe).color;};
 const p={text:color('--text','#292633'),muted:color('--muted','#777482'),line:color('--line','#e6e3ed'),accent:color('--chart-accent','#9c82ea'),up:color('--signal-up','var(--ok,#52e0ac)'),down:color('--signal-down','var(--error,#ff6492)'),upCore:color('--signal-up-core','#c4ffe8'),downCore:color('--signal-down-core','#ffcbdc')};probe.remove();return p;
}
export function chartLevelPresentation(level,p){
 const names={upper:L('价格上限','Upper limit'),lower:L('价格下限','Lower limit'),'grid-buy':L('计划买入','Planned buy'),'grid-sell':L('计划卖出','Planned sell'),'grid-mid':L('网格基准','Grid reference'),entry:L('平均成本','Avg entry'),'planned-entry':L('计划开仓','Planned entry'),stop:L('计划止损','Planned SL'),target:L('计划止盈','Planned TP'),'buy-order':L('买单','Buy order'),'sell-order':L('卖单','Sell order')};
 if(!names[level.kind]||!Number.isFinite(level.price)||level.price<=0)return null;
 const order=level.kind.endsWith('-order'),state=order?level.state==='unknown'?L('待确认','Unconfirmed'):level.state==='partial'?L('部分成交','Part filled'):L('处理中','Pending'):'';
 return {name:names[level.kind]+(state?' · '+state:''),color:level.kind==='stop'||level.kind==='grid-sell'||level.kind==='sell-order'?p.down:level.kind==='target'||level.kind==='grid-buy'||level.kind==='buy-order'?p.up:p.accent};
}
function gridControls(){return `<details class="trading-chart-grid"><summary>${L('网格图层','Grid overlay')}<small>${L('仅图表预览','Chart preview only')}</small><span class="trading-grid-summary"></span></summary><div class="trading-grid-fields"><label>${L('价格下限','Lower price')}<input type="number" step="any" min="0" data-tc-grid="lower" aria-label="${L('网格价格下限','Grid lower price')}"></label><label>${L('价格上限','Upper price')}<input type="number" step="any" min="0" data-tc-grid="upper" aria-label="${L('网格价格上限','Grid upper price')}"></label><label>${L('网格数量','Grid count')}<input type="number" min="2" max="100" step="1" value="4" data-tc-grid="count" aria-label="${L('网格数量','Grid count')}"></label><label>${L('间距','Spacing')}<select data-tc-grid="mode" aria-label="${L('网格间距','Grid spacing')}"><option value="arithmetic">${L('等差','Arithmetic')}</option><option value="geometric">${L('等比','Geometric')}</option></select></label><div class="trading-grid-actions"><button type="button" data-tc-action="grid-apply">${L('预览网格','Preview grid')}</button><button type="button" data-tc-action="grid-clear">${L('清除','Clear')}</button></div></div><p class="trading-grid-feedback" role="status"></p></details>`;}
function stampDraft(host,config){
 for(const [key,value]of Object.entries({chartAccount:config.identity?.accountId,chartConnection:config.identity?.connectionId,chartInstrument:config.identity?.instrumentId,chartPlanId:config.planRef?.id,chartPlanVersion:config.planRef?.version}))if(value==null)delete host.dataset[key];else host.dataset[key]=String(value);
 const error=host.querySelector('[data-tc-draft-error]');error.hidden=!config.draftError;error.textContent=config.draftError?L('检查账户、交易标的与网格参数','Check account, instrument and grid parameters'):'';
}
function mount(host,config){
 if(hostedChartSymbol(config)){
  const stopWidget=mountHostedChart(host,config,{fallback(){
   const slot=host.querySelector('.trading-chart-hosted-fallback'),template=document.createElement('template');
   template.innerHTML=tradingChartPanel(host.dataset.tradingChart+'-basic',{...config,hostedMarket:false});
   const native=template.content.firstElementChild;slot.replaceChildren(native);
   const stop=mount(native,{...config,hostedMarket:false});return ()=>{stop();slot.replaceChildren();};
  }});
  const cleanup=()=>{stopWidget();mountedCharts.delete(host);};mountedCharts.set(host,cleanup);return cleanup;
 }
 stampDraft(host,config);
 const stopLights=[];
 const events=new AbortController(),signal=events.signal,stage=host.querySelector('.trading-chart-canvas'),message=host.querySelector('.trading-chart-message'),readout=host.querySelector('.trading-chart-readout'),fillDetail=host.querySelector('.trading-chart-fill');
 let stopped=false,api=null,chart=null,priceSeries=null,volume=null,markerApi=null,priceLines=[],bars=[],stopFeed=()=>{},period=config.period,mode=config.recorded||config.snapshotError?'recorded':config.paper&&preferences.get(config.preferenceKey)?.mode==='paper'?'paper':'market',selected=-1,zoomDialog=null,placeholder=null,colors=null,gridLevels=[],labelFrame=0,fitLevels=false,lastStatus={state:'loading'};
 const line=config.recorded?.kind==='line',marketRequest=candleRequest(config),sessionBased=!!marketRequest?.sessionBased;
 let displayedPeriod=period;
 let studyIndex=0,studyTimer=0,studyPinned=false,studyDigest='',studyFinished=false,studyInView=false,oscillator=null,stopOscillatorLight=null;
 const analysis=config.analysisLayers?document.createElementNS('http://www.w3.org/2000/svg','svg'):null,analysisKey=host.querySelector('.trading-analysis-key');
 let showAnalysis=true,analysisGeometry='',drawnStudy='',study={bars:[],lines:[]};
 if(analysis){analysis.classList.add('trading-analysis-layer');analysis.setAttribute('aria-hidden','true');if(config.analysisTask)analysis.dataset.analysisTask='true';stage.after(analysis);}
 function studyRunnable(){return !stopped&&!studyPinned&&studyInView&&!document.hidden&&document.body.dataset.paused!=='true'&&document.body.dataset.researchHold!=='true'&&document.body.dataset.page==='workbench'&&chartStudyAvailable(lastStatus,bars);}
 function studyLabel(){
  if(!config.analysisTask)return;
  const job=config.analysisTask.plan.steps[studyIndex];
  host.dataset.studyState=studyPinned?'pinned':studyFinished?'complete':study.state||'loading';host.dataset.studyPeriod=period;
  host.querySelector('.trading-study-step').textContent=`${displayedPeriod} · ${L(job.zh,job.en)}`;
  const resume=host.querySelector('[data-tc-action="study-resume"]');resume.hidden=!studyPinned&&!studyFinished;resume.textContent=studyPinned?L('继续','Resume'):L('重新分析','Analyze again');
 }
 function scheduleStudy(){
  studyLabel();
  if(config.analysisTask){if(!studyRunnable())for(const animation of analysis?.getAnimations({subtree:true})||[])animation.cancel();else if(drawnStudy!==studyDigest)queueLabels();}
  if(!config.analysisTask||!studyRunnable()||study.state!=='ready'||studyFinished){clearTimeout(studyTimer);studyTimer=0;return;}
  if(studyTimer)return;
  // Reading dwell presents an already-computed result; it never creates an analysis event.
  studyTimer=setTimeout(()=>{
   studyTimer=0;if(!studyRunnable())return;
   if(studyIndex+1===config.analysisTask.plan.steps.length){studyFinished=true;studyLabel();config.analysisTask.onComplete?.({market:config.market,period,closedAt:study.closedAt});return;}
   rememberWindow();studyIndex++;period=config.analysisTask.plan.steps[studyIndex].period;studyDigest='';study={bars:[],lines:[]};start();
  },3500);
 }
 function pauseStudy(){if(!config.analysisTask||studyPinned||document.body.dataset.researchHold!==undefined)return;studyPinned=true;clearTimeout(studyTimer);studyTimer=0;for(const animation of analysis?.getAnimations({subtree:true})||[])animation.cancel();studyLabel();}
 function studyCandles(force=false){
  if(!analysis)return;
  if(!config.analysisTask){study=mode==='market'?candleTechnicalStudy(bars,{seconds:CANDLE_PERIODS[period],sessionBased}):{bars:[],lines:[]};return;}
  const lastClosed=bars.findLast(b=>(sessionBased?b.closedAt:b.time+CANDLE_PERIODS[period])<=Date.now()/1000),digest=`${studyIndex}:${lastClosed?.time}`;
  if(!force&&studyDigest===digest&&study.state==='ready')return;studyDigest=digest;
  const job=config.analysisTask.plan.steps[studyIndex];study=config.analysisTask.compute(bars,{...job,plan:config.analysisTask.plan});
  host.dataset.studyClosedAt=String(study.closedAt||'');host.dataset.studyPlan=config.analysisTask.plan.ref;
  const wave=study.oscillators?.[0];
  if(wave&&chart){
   if(!oscillator){const pane=volume?2:1;oscillator=chart.addSeries(api.LineSeries,{title:wave.en,color:wave.color,lineWidth:1.5,priceLineVisible:false,lastValueVisible:true,priceFormat:{type:'custom',formatter:value=>value.toFixed(1)},autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100}})},pane);stopOscillatorLight=attachChartSeriesLight(oscillator,host);for(const value of [30,50,70])oscillator.createPriceLine({price:value,color:colors.line,lineWidth:1,lineStyle:api.LineStyle.Dashed,axisLabelVisible:false,title:''});chart.panes()[pane].setStretchFactor(1.4);}
   oscillator.setData(wave.points);
  }else if(oscillator){stopOscillatorLight?.();stopOscillatorLight=null;chart.removeSeries(oscillator);oscillator=null;}
  scheduleStudy();
 }
 function drawAnalysis(){
  if(!analysis)return;
  const available=mode==='market'&&showAnalysis&&chartStudyAvailable(lastStatus,bars)&&(!config.analysisTask||study.state==='ready');
  analysis.hidden=!available;analysis.style.display=available?'':'none';analysisKey.hidden=!showAnalysis;
  const summary=analysisKey.querySelector('summary'),details=analysisKey.querySelector('div');
  summary.textContent=available?(config.analysisTask?L('分析依据','Analysis details'):`${L('技术结构','Technical structure')} · ${study.lines.length} ${L('条','lines')} · ${study.bars.length} ${L('根已收盘','closed bars')}`):L('技术结构 · 等待有效行情','Technical structure · awaiting valid market');
  if(!available){analysis.replaceChildren();analysisGeometry='';details.textContent='';if(config.analysisTask){const missing={warmup:L('预热 K 线不足','Insufficient warmup'),stale:L('等待最新收盘数据','Awaiting latest close'),invalid:L('数据不连续或格式异常','Invalid or discontinuous bars'),'simulation-plan':L('模拟方案价位请在运行图核对','Review simulation levels in the run chart')};summary.textContent=missing[study.state]||L('计算中 · 等待已收盘行情','Computing · awaiting closed candles');}return;}
  const width=chart.timeScale().width(),height=chart.panes()[0].getHeight();analysis.style.left=stage.offsetLeft+'px';analysis.style.top=stage.offsetTop+'px';analysis.setAttribute('width',width);analysis.setAttribute('height',height);analysis.style.setProperty('width',width+'px','important');analysis.style.setProperty('height',height+'px','important');analysis.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const taskView=config.analysisTask?chartAnalysisTaskView(study.lines,{kind:config.analysisTask.plan.steps[studyIndex].kind,x:time=>chart.timeScale().timeToCoordinate(time),y:value=>priceSeries.priceToCoordinate(value),formatPrice:format,formatTime:time=>date(time)+(sessionBased?' '+marketRequest.timezone:''),width,height,idPrefix:host.dataset.tradingChart}):null;
  const geometry=taskView?taskView.geometry:study.lines.map(line=>{
   let start=true;const d=line.points.map(point=>{const x=chart.timeScale().timeToCoordinate(point.time),y=priceSeries.priceToCoordinate(point.value);if(x===null||y===null){start=true;return '';}const command=start?'M':'L';start=false;return `${command}${x.toFixed(2)},${y.toFixed(2)}`;}).join(' '),last=line.points.at(-1);
   const nodes=line.key.startsWith('swing')?line.points:line.points.slice(-1);
   return `<g style="--analysis-color:${line.color}" data-analysis-method="${line.key}" data-anchor-time="${last.time}" data-anchor-price="${last.value}"><path class="analysis-glow" d="${d}"/><path class="analysis-core" d="${d}"/><path class="analysis-packet" pathLength="1" d="${d}"/>${nodes.map(point=>{const x=chart.timeScale().timeToCoordinate(point.time),y=priceSeries.priceToCoordinate(point.value);return x===null||y===null?'':`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.5"/>`;}).join('')}</g>`;
  }).join('');
  if(analysisGeometry!==geometry){analysis.innerHTML=geometry;analysisGeometry=geometry;}
  if(config.analysisTask&&drawnStudy!==studyDigest&&studyRunnable()){
   drawnStudy=studyDigest;
   if(!matchMedia('(prefers-reduced-motion:reduce)').matches&&document.documentElement.dataset.reducedMotion!=='true'){
    for(const [i,path]of [...analysis.querySelectorAll('.analysis-core,.analysis-boundary')].entries())path.animate([{strokeDasharray:'1',strokeDashoffset:1},{strokeDasharray:'1',strokeDashoffset:0}],{duration:900,delay:Math.min(i*45,180),fill:'backwards',easing:'cubic-bezier(.2,.7,.1,1)'});
    for(const [i,zone]of [...analysis.querySelectorAll('.analysis-zone')].entries())zone.animate([{clipPath:'inset(0 100% 0 0)',opacity:0},{clipPath:'inset(0 0% 0 0)',opacity:1}],{duration:1000,delay:100+Math.min(i*55,165),fill:'backwards',easing:'cubic-bezier(.2,.7,.1,1)'});
   }
  }
  const legend=taskView?'':study.lines.map(line=>`<span style="--analysis-color:${line.color}"><i></i>${L(line.zh,line.en)} <b>${format(line.points.at(-1).value)}</b></span>`).join('')+`<p>${L('仅用已收盘 K 线；摆点由左右各 2 根确认。加权均价使用近 20 根典型价格与成交量，非日内 VWAP。连线止于确认锚点。','Closed candles only. Pivots require 2 bars on each side. Weighted mean uses 20 bars of typical price and volume, not session VWAP. Swing lines stop at confirmed anchors.')}</p>`;
  const taskNote=config.analysisTask?`<p class="trading-study-basis">${esc(L(config.analysisTask.plan.zh,config.analysisTask.plan.en))} · ${esc(period)} · ${study.bars.length} ${L('根已收盘','closed bars')} · ${esc(sessionBased?L('交易日','Session')+' '+chartSourceTime(study.bars.at(-1)?.time,marketRequest.timezone).slice(0,10):formatDataTime(study.closedAt*1000))}</p>${(study.checks||[]).map(check=>`<span><i></i>${esc(L(check.zh,check.en))}<b>${typeof check.value==='boolean'?check.value?L('满足','Met'):L('未满足','Not met'):check.value===null?'—':format(check.value)+(check.unit||'')}</b></span>`).join('')}${config.analysisTask.plan.missing.length?`<p>${L('待补充数据','Additional data needed')}</p>`:''}`:'';
  const content=config.analysisTask?taskView.legend+taskNote:legend;
  if(details.innerHTML!==content)details.innerHTML=content;
 }

 if(config.recorded){host.dataset.snapshotId=config.recorded.id;host.dataset.snapshotVersion=config.recorded.version;host.dataset.clockKind=config.recorded.clockKind;}
 const remember=patch=>preferences.set(config.preferenceKey,{...preferences.get(config.preferenceKey),...patch});
 const windowKey=()=>mode+':'+displayedPeriod;let replacing=false,restoreAfterLayout=!stage.clientWidth||!stage.clientHeight;
 function currentWindow(){if(!stage.clientWidth||!stage.clientHeight)return null;const range=chart?.timeScale().getVisibleRange();return range&&bars.length?{...range,logical:chart.timeScale().getVisibleLogicalRange(),first:bars[0].time,last:bars.at(-1).time}:null;}
 function rememberWindow(){if(stopped||replacing||restoreAfterLayout)return;const saved=currentWindow();if(saved)remember({windows:{...preferences.get(config.preferenceKey)?.windows,[windowKey()]:saved}});}
 try{if(config.gridPlan)gridLevels=gridChartLevels(config.gridPlan);}catch{}
 const labelLayer=host.querySelector('.trading-chart-levels'),levels=()=>mode==='recorded'?config.recorded?.levels||[]:mode==='paper'?[...config.paper.levels,...config.orders]:gridLevels;
 function queueLabels(){
  if(labelFrame||!chart||stopped)return;labelFrame=requestAnimationFrame(()=>{
   labelFrame=0;if(stopped)return;if(restoreAfterLayout&&stage.clientWidth&&stage.clientHeight){restoreAfterLayout=false;setVisible();}drawAnalysis();labelLayer.style.width=Math.max(0,chart.timeScale().width())+'px';const all=levels(),reference=bars.at(-1)?.close||0;
   const nearest=new Set(all.filter(level=>level.kind.startsWith('grid-')).sort((a,b)=>Math.abs(a.price-reference)-Math.abs(b.price-reference)).slice(0,5).map(level=>level.id));
   const placed=[];labelLayer.replaceChildren();for(const level of [...all].sort((a,b)=>Number(a.kind.startsWith('grid-'))-Number(b.kind.startsWith('grid-'))||Math.abs(a.price-reference)-Math.abs(b.price-reference))){
    if(level.kind.startsWith('grid-')&&!nearest.has(level.id))continue;
    const y=priceSeries.priceToCoordinate(level.price),view=chartLevelPresentation(level,colors);if(y===null||y<4||y>chart.panes()[0].getHeight()-12||!view||placed.some(at=>Math.abs(at-y)<20))continue;placed.push(y);
    const label=document.createElement('span');label.className='trading-price-tag';label.style.top=y+'px';label.style.setProperty('--level-color',view.color);label.textContent=view.name;label.title=view.name+' · '+format(level.price)+(level.quantity?' · '+format(level.quantity):'');labelLayer.append(label);
   }
  });
 }
 const format=formatTradingPrice;
 const date=time=>mode==='paper'||mode==='recorded'&&config.recorded?.clockKind==='simulation'?elapsed(time):chartSourceTime(Number(time),sessionBased?marketRequest.timezone:null);
 function status(next){
  if(stopped)return;const {state}=next;host.dataset.chartState=state;lastStatus=sessionBased&&bars.length?{...lastStatus,...next}:next;
  const {asOf,quoteAsOf,session,sessionDate}=lastStatus;scheduleStudy();queueLabels();
  if(config.analysisTask)host.querySelector('[data-tc-action="refresh"]').hidden=!['error','stale','reconnecting','unsupported'].includes(state);
  const labels={loading:L('加载行情','Loading market'),snapshot:L('已同步 · 只读行情','Synced · read only'),live:L('实时 · 只读行情','Live · read only'),reconnecting:L('正在重新连接','Reconnecting'),stale:L('行情已中断 · 正在重试','Interrupted · retrying'),error:L('行情暂不可用','Market unavailable'),paper:L('模拟成交 · 非市场 K 线','Paper fills · not market candles'),unsupported:L('此市场行情源尚未接入','Market feed not connected')};
  labels.recorded=L('已固定的行情快照','Frozen market snapshot');labels['recorded-plan']=L('方案记录 · 参考价位','Plan record · reference levels');labels.invalid=L('图表记录无法读取','Chart record unavailable');
  labels.refreshing=L('行情更新中','Updating market');
  const sessionLabel={closed:L('休市','Closed'),delayed:L('延迟行情','Delayed'),'last-close':L('日线','Daily')};
  const switching=state==='loading'&&bars.length&&displayedPeriod!==period;
  host.querySelector('.trading-chart-status span').textContent=sessionBased&&sessionDate?`D1 · ${L('交易日','Session')} ${sessionDate} · ${sessionLabel[session]||L('日线','Daily')}${state==='stale'?' · '+L('数据待更新','Awaiting update'):state==='refreshing'?' · '+L('更新中','Updating'):''}`:switching?`${L('切换至','Switching to')} ${period} · ${L('图中','Displayed')} ${displayedPeriod}`:labels[state]||state;
  host.dispatchEvent(new CustomEvent('trading-chart:state',{detail:{state,market:config.market,period}}));
  const stamp=sessionBased?quoteAsOf*1000:asOf,time=host.querySelector('footer time');
  if(Number.isFinite(stamp)){time.textContent=sessionBased?`${lastStatus.asOfKind==='quote'?L('来源报价','Source quote'):L('日线截至','Daily through')} ${chartSourceTime(quoteAsOf,marketRequest.timezone)} · ${marketRequest.timezone}`:formatDataTime(stamp).slice(11);time.dateTime=new Date(stamp).toISOString();}
  else if(!bars.length){time.textContent='';time.removeAttribute('datetime');}
  if(!bars.length){message.textContent=labels[state]||'';message.hidden=false;}else message.hidden=true;
 }
 function inspect(bar){
  if(!bar)return;readout.innerHTML=`<span${config.analysisTask?` title="${esc(date(bar.time))}"`:''}>${esc(config.analysisTask?date(bar.time).slice(5,16):date(bar.time))}</span><dl>${(line?[[L('记录价','Recorded price'),bar.close]]:[['O',bar.open],['H',bar.high],['L',bar.low],['C',bar.close],...sessionBased?[]:[['V',bar.volume]]]).map(([name,value])=>`<div><dt>${name}</dt><dd>${esc(format(value))}</dd></div>`).join('')}</dl>`;
 }
 function setVisible(saved=preferences.get(config.preferenceKey)?.windows?.[windowKey()]){if(!chart||!bars.length)return;const restore=chartWindowRestore(saved,bars);if(restore){if(restore.kind==='logical')chart.timeScale().setVisibleLogicalRange(restore.range);else chart.timeScale().setVisibleRange(restore.range);return;}const count=stage.clientWidth<600?32:80;chart.timeScale().setVisibleLogicalRange({from:Math.max(-1,bars.length-count),to:bars.length+2});}
 function skin(){
  if(!chart)return;const p=colors=tradingChartPalette(host),paper=mode==='paper';
  chart.applyOptions({layout:{background:{type:api.ColorType.Solid,color:'transparent'},textColor:p.muted,fontFamily:getComputedStyle(host).fontFamily,fontSize:12,attributionLogo:true,panes:{separatorColor:p.line,separatorHoverColor:p.accent}},grid:{vertLines:{color:p.line,visible:false},horzLines:{color:p.line,style:api.LineStyle.Dotted}},rightPriceScale:{borderVisible:false,scaleMargins:{top:.08,bottom:.08}},timeScale:{borderVisible:false,timeVisible:true,secondsVisible:paper,tickMarkFormatter:(time,kind)=>paper?elapsed(time):chartTickLabel(time,kind,displayedPeriod,sessionBased?marketRequest.timezone:null)},localization:{locale:getLocale()==='zh'?'zh-CN':getLocale(),priceFormatter:format,timeFormatter:date},crosshair:{vertLine:{color:p.muted,labelBackgroundColor:p.accent},horzLine:{color:p.muted,labelBackgroundColor:p.accent}}});
  priceSeries.applyOptions({...line?{color:p.accent,lineWidth:2,pointMarkersVisible:true}:config.analysisTask?{upColor:p.text.replace(/^rgb\((.+)\)$/,'rgba($1, .65)'),downColor:'transparent',wickUpColor:p.muted,wickDownColor:p.muted,borderVisible:true,borderUpColor:p.muted,borderDownColor:p.muted}:{upColor:p.up,downColor:p.down,wickUpColor:p.up,wickDownColor:p.down,borderVisible:true,borderUpColor:p.upCore,borderDownColor:p.downCore},priceLineColor:p.accent,autoscaleInfoProvider:base=>{const range=base();if(range&&(paper||fitLevels))for(const level of levels()){range.priceRange.minValue=Math.min(range.priceRange.minValue,level.price);range.priceRange.maxValue=Math.max(range.priceRange.maxValue,level.price);}return range;}});
  priceLines.forEach(line=>priceSeries.removePriceLine(line));priceLines=[];
  const active=levels(),reference=bars.at(-1)?.close||0,nearest=new Set(active.filter(level=>level.kind.startsWith('grid-')).sort((a,b)=>Math.abs(a.price-reference)-Math.abs(b.price-reference)).slice(0,5).map(level=>level.id));
  for(const level of active){const view=chartLevelPresentation(level,p);if(view)priceLines.push(priceSeries.createPriceLine({price:level.price,title:'',color:view.color,lineWidth:1,lineStyle:level.state==='unknown'?api.LineStyle.Dotted:api.LineStyle.Dashed,axisLabelVisible:!level.kind.startsWith('grid-')||nearest.has(level.id)}));}
  host.dataset.priceLevelCount=String(priceLines.length);queueLabels();
  if(paper){
   markerApi.setMarkers(config.paper.fills.map(f=>({id:f.id,time:f.time,position:f.side==='buy'?'belowBar':'aboveBar',shape:f.side==='buy'?'arrowUp':'arrowDown',color:f.side==='buy'?p.up:p.down,text:f.side==='buy'?L('买','Buy'):L('卖','Sell')})));
  }else markerApi.setMarkers([]);
  volume?.setData(bars.map(b=>({time:b.time,value:b.volume,color:(config.analysisTask?p.muted:b.close>=b.open?p.up:p.down).replace(/^rgb\((.+)\)$/,config.analysisTask?'rgba($1, .25)':'rgba($1, .35)')})));
 }
 function replace(data){
  const restore=displayedPeriod===period?currentWindow():null;
  replacing=true;
  try{
   displayedPeriod=period;host.dataset.renderedPeriod=period;bars=data;studyCandles(true);selected=-1;host.dataset.candleCount=String(bars.length);
   if(config.gridPlan&&!gridLevels.length&&bars.length){config.gridPlan={...config.gridPlan,referencePrice:config.gridPlan.referencePrice||bars.at(-1).close};gridLevels=gridChartLevels(config.gridPlan);}
   priceSeries.setData(bars.map(({time,open,high,low,close})=>line?{time,value:close}:{time,open,high,low,close}));volume?.setData([]);skin();setVisible(restore||undefined);
  }
  finally{replacing=false;}
  rememberWindow();inspect(bars.at(-1));
 }
 function start(){
  clearTimeout(studyTimer);studyTimer=0;stopFeed();stopFeed=()=>{};if(!chart||stopped)return;studyLabel();fitLevels=mode==='recorded';priceSeries.priceScale().setAutoScale(true);
  host.dataset.chartSource=mode;host.dataset.markerCount=String(mode==='paper'?config.paper?.fills.length||0:0);fillDetail.hidden=true;
  for(const b of host.querySelectorAll('[data-tc-view]'))b.setAttribute('aria-pressed',String(b.dataset.tcView===mode));
  host.querySelector('.trading-chart-periods').hidden=mode!=='market';host.querySelector('.trading-chart-clock').hidden=mode!=='paper';
  host.querySelector('[data-tc-action="refresh"]').hidden=mode!=='market'||!!config.analysisTask;
  const gridControl=host.querySelector('.trading-chart-grid');if(gridControl)gridControl.hidden=mode==='paper';
  for(const b of host.querySelectorAll('[data-tc-period]'))b.setAttribute('aria-pressed',String(b.dataset.tcPeriod===period));
  if(mode==='recorded'){
   replace(config.recorded?.data||[]);status({state:config.snapshotError?'invalid':line?'recorded-plan':'recorded',asOf:config.recorded?.asOf});
   if(config.recorded){host.querySelector('footer time').textContent=`${config.recorded.id} · v${config.recorded.version}`;chart.timeScale().fitContent();}return;
  }
  if(mode==='paper'){
   replace(config.paper.bars);status({state:'paper'});host.querySelector('footer time').textContent=config.paper.runId||'';
   if(!bars.length){message.textContent=L('本轮尚无成交','No fills in this run');message.hidden=false;}return;
  }
  if(config.blocked){replace([]);readout.textContent='';status({state:'unsupported'});message.textContent=L('检查账户与交易标的后重试','Review the account and instrument');return;}
  const request=candleRequest({...config,period});
  if(!request){replace([]);readout.textContent='';status({state:'unsupported'});return;}
  status({state:'loading'});
  stopFeed=subscribeCandles(request,{onSnapshot:replace,onBar:bar=>{
   bars=mergeCandle(bars,bar,request.seconds);studyCandles();const {time,open,high,low,close,volume:quantity}=bar,p=colors;
   priceSeries.update({time,open,high,low,close});volume?.update({time:bar.time,value:quantity,color:(config.analysisTask?p.muted:bar.close>=bar.open?p.up:p.down).replace(/^rgb\((.+)\)$/,config.analysisTask?'rgba($1, .25)':'rgba($1, .35)')});
   host.dataset.candleCount=String(bars.length);if(selected<0)inspect(bar);
   queueLabels();
  },onStatus:status});
 }
 // This chart owns only read-only market requests; execution remains in the existing order flow.
 function closeZoom(){if(!zoomDialog)return;const dialog=zoomDialog;zoomDialog=null;placeholder?.replaceWith(host);placeholder=null;host.classList.remove('is-expanded');dialog.remove();const button=host.querySelector('[data-tc-action="expand"]');button.setAttribute('aria-label',L('放大图表','Expand chart'));button.title=L('放大图表','Expand chart');if(!stopped&&host.isConnected)button.focus();}
 function expandChart(){
  if(zoomDialog){closeZoom();return;}
  placeholder=document.createComment('trading chart');host.before(placeholder);zoomDialog=document.createElement('dialog');zoomDialog.className='trading-chart-zoom';document.body.append(zoomDialog);zoomDialog.append(host);host.classList.add('is-expanded');
  zoomDialog.addEventListener('close',closeZoom,{once:true});zoomDialog.showModal();const button=host.querySelector('[data-tc-action="expand"]');button.setAttribute('aria-label',L('返回页面','Return to page'));button.title=L('返回页面','Return to page');
 }
 host.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b||!host.contains(b))return;
  if(b.dataset.tcPeriod){if(period===b.dataset.tcPeriod)return;rememberWindow();period=b.dataset.tcPeriod;remember({period,mode});start();return;}
  if(b.dataset.tcView){if(mode===b.dataset.tcView)return;rememberWindow();mode=b.dataset.tcView;remember({period,mode});bars=[];priceSeries?.setData([]);volume?.setData([]);markerApi?.setMarkers([]);readout.textContent='';host.querySelector('footer time').textContent='';skin();start();return;}
  const action=b.dataset.tcAction;
  if(action==='choose-instrument'){host.dispatchEvent(new CustomEvent('trading-chart:choose-instrument',{bubbles:true}));return;}
  if(action==='study-resume'){studyPinned=false;if(studyFinished){studyFinished=false;studyIndex=0;period=config.analysisTask.plan.steps[0].period;studyDigest='';start();}else scheduleStudy();return;}
  if(action==='analysis'){showAnalysis=!showAnalysis;b.setAttribute('aria-pressed',String(showAnalysis));queueLabels();}
  if(action==='expand')expandChart();
  if(action==='fit'&&chart){fitLevels=true;priceSeries.priceScale().setAutoScale(true);skin();chart.timeScale().fitContent();}
  if(action==='refresh'){if(chart)start();else location.reload();}
  if(action==='grid-apply'){
   const feedback=host.querySelector('.trading-grid-feedback');
   try{if(mode!=='market'||!bars.length)throw Error('NO_MARKET');const values=Object.fromEntries([...host.querySelectorAll('[data-tc-grid]')].map(input=>[input.dataset.tcGrid,input.value]));const plan={...values,count:Number(values.count),referencePrice:bars.at(-1).close},next=gridChartLevels(plan);gridLevels=next;config.gridPlan=plan;fitLevels=false;priceSeries.priceScale().setAutoScale(true);host.dataset.gridState='preview';skin();chart.timeScale().setVisibleLogicalRange({from:Math.max(0,bars.length-48),to:bars.length+2});feedback.textContent=L('图层已显示 · 未创建挂单','Overlay shown · no orders created');host.querySelector('.trading-grid-summary').textContent=`${format(Number(plan.lower))} – ${format(Number(plan.upper))} · ${plan.count}`;host.querySelector('.trading-chart-grid').open=false;}
   catch{host.dataset.gridState='invalid';feedback.textContent=bars.length?L('检查上下限和网格数量（2–100）','Check price bounds and grid count (2–100)'):L('等待行情加载后再预览','Wait for market data before previewing');}
  }
  if(action==='grid-clear'){gridLevels=[];config.gridPlan=null;fitLevels=false;priceSeries?.priceScale().setAutoScale(true);host.dataset.gridState='empty';skin();host.querySelector('.trading-grid-feedback').textContent='';host.querySelector('.trading-grid-summary').textContent='';}
 },{signal});
 stage.addEventListener('keydown',event=>{
  if(!chart||!bars.length)return;
  if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
   event.preventDefault();if(selected<0)selected=bars.length-1;selected=event.key==='Home'?0:event.key==='End'?bars.length-1:Math.max(0,Math.min(bars.length-1,selected+(event.key==='ArrowRight'?1:-1)));
   const bar=bars[selected];chart.setCrosshairPosition(bar.close,bar.time,priceSeries);readout.setAttribute('aria-live','polite');inspect(bar);
  }else if(['+','=','-'].includes(event.key)){event.preventDefault();const range=chart.timeScale().getVisibleLogicalRange();if(range){const count=(range.to-range.from)*(event.key==='-'?1.4:.7);chart.timeScale().setVisibleLogicalRange({from:range.to-Math.max(8,count),to:range.to});}}
 },{signal});
 for(const type of ['pointermove','wheel','keydown'])stage.addEventListener(type,pauseStudy,{passive:true,signal});
 stage.addEventListener('pointerdown',()=>{host.dataset.interacting='true';},{passive:true,signal});
 for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>{delete host.dataset.interacting;},{passive:true,signal});
 const studyObserver=config.analysisTask?new MutationObserver(scheduleStudy):null;studyObserver?.observe(document.body,{attributes:true,attributeFilter:['data-paused','data-page','data-research-hold']});document.addEventListener('visibilitychange',scheduleStudy,{signal});
 const studyVisibility=config.analysisTask?new IntersectionObserver(entries=>{studyInView=entries.some(entry=>entry.isIntersecting);scheduleStudy();},{threshold:.05}):null;studyVisibility?.observe(host);
 const observer=new MutationObserver(skin);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
 loadTradingChartLibrary().then(module=>{
  if(stopped||!host.isConnected)return;api=module;
  chart=api.createChart(stage,{autoSize:true,handleScroll:{mouseWheel:false,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:false,pinch:true,axisPressedMouseMove:true},crosshair:{mode:api.CrosshairMode.Normal},timeScale:{rightOffset:3,barSpacing:7,lockVisibleTimeRangeOnResize:true,shiftVisibleRangeOnNewBar:true}});
  priceSeries=chart.addSeries(line?api.LineSeries:api.CandlestickSeries,{priceFormat:{type:'custom',formatter:format,minMove:.00000001}});
  chart.panes()[0].setStretchFactor(4);
  if(!line&&!sessionBased){volume=chart.addSeries(api.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},1);volume.priceScale().applyOptions({scaleMargins:{top:.12,bottom:0}});chart.panes()[1].setStretchFactor(1);}
  markerApi=api.createSeriesMarkers(priceSeries,[],{autoScale:false});
  for(const series of [priceSeries,volume].filter(Boolean))stopLights.push(attachChartSeriesLight(series,host));
  chart.timeScale().subscribeVisibleLogicalRangeChange(()=>{queueLabels();rememberWindow();});stage.addEventListener('pointermove',queueLabels,{passive:true,signal});
  chart.subscribeCrosshairMove(event=>{queueLabels();if(!event.time){inspect(bars.at(-1));return;}const bar=bars.find(b=>b.time===event.time);if(bar)inspect(bar);});
  chart.subscribeClick(event=>{if(mode!=='paper'||!event.time)return;const fills=config.paper.fills.filter(f=>f.time===event.time);fillDetail.hidden=!fills.length;fillDetail.textContent=fills.map(f=>`${elapsed(f.executedAt)} · ${f.side==='buy'?L('买入','Buy'):L('卖出','Sell')} ${format(f.quantity)} × ${format(f.price)} · ${f.orderId}`).join(' / ');});
  host.dataset.engine='lightweight-charts';skin();start();
 }).catch(()=>{library=null;stopLights.splice(0).forEach(stop=>stop());if(!stopped){status({state:'error'});message.textContent=L('图表加载失败，请刷新页面','Chart failed to load. Reload the page.');message.hidden=false;}});
 // Keep the feed available in hidden settings panes, but restore only after the chart has its real size.
 const sizeObserver=new ResizeObserver(()=>{if(!stage.clientWidth||!stage.clientHeight)restoreAfterLayout=true;queueLabels();});sizeObserver.observe(stage);
 const cleanup=()=>{rememberWindow();stopped=true;mountedCharts.delete(host);delete host.dataset.interacting;stopFeed();clearTimeout(studyTimer);studyObserver?.disconnect();studyVisibility?.disconnect();stopOscillatorLight?.();events.abort();observer.disconnect();sizeObserver.disconnect();cancelAnimationFrame(labelFrame);analysis?.remove();closeZoom();markerApi?.detach();stopLights.splice(0).forEach(stop=>stop());chart?.remove();};
 cleanup.capture=()=>{if(stopped||mode!=='market'||!chart)throw Error('MARKET_NOT_READY');return captureMarketWindow({...config,period},bars,chart.timeScale().getVisibleLogicalRange(),lastStatus);};
 cleanup.quote=()=>{if(stopped||mode!=='market'||!chart||config.blocked)throw Error('MARKET_NOT_READY');return chartQuoteSnapshot({...config,period:displayedPeriod},bars,lastStatus);};
 mountedCharts.set(host,cleanup);
 cleanup.updatePlan=()=>{gridLevels=[];fitLevels=false;if(config.gridPlan&&bars.length){config.gridPlan={...config.gridPlan,referencePrice:bars.at(-1).close};gridLevels=gridChartLevels(config.gridPlan);}host.dataset.gridState=config.draftError?'invalid':gridLevels.length?'preview':'empty';stampDraft(host,config);skin();};
 return cleanup;
}
export function mountTradingCharts(root){
 const entries=[];let closed=false;
 for(const host of root.querySelectorAll('[data-trading-chart]')){
  const config=configs.get(host.dataset.tradingChart);if(!config)continue;
  const parents=[];for(let parent=host.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parents.push(parent);
  const entry={host,config,dispose:null,events:new AbortController()};
  entry.sync=()=>{const open=!closed&&parents.every(parent=>parent.open);if(open&&!entry.dispose&&!mountedCharts.has(host))entry.dispose=mount(host,entry.config);else if(!open&&entry.dispose){entry.dispose();entry.dispose=null;}};
  parents.forEach(parent=>parent.addEventListener('toggle',entry.sync,{signal:entry.events.signal}));entry.sync();entries.push(entry);
 }
 const cleanup=()=>{closed=true;for(const entry of entries){entry.events.abort();entry.dispose?.();entry.dispose=null;}};
 cleanup.updateDraft=(key,input)=>{
  const entry=entries.find(item=>item.host.dataset.tradingChart===key);if(closed||!entry)return {ok:false,code:'CHART_NOT_MOUNTED'};
  let next,problem=null;
  try{next=chartDraftConfig({...input,gridPlan:null});try{next=chartDraftConfig(input);}catch(error){problem=error;}}
  catch(error){problem=error;next={market:'',profileId:'',venueId:'',period:'1H',gridPlan:null,identity:null,planRef:null,blocked:true};}
  next.draftError=problem?.code||null;
  const same=!entry.config.gridPreview&&JSON.stringify(entry.config.identity)===JSON.stringify(next.identity)&&entry.config.period===next.period;
  if(same){Object.assign(entry.config,next);stampDraft(entry.host,entry.config);if(entry.dispose)entry.dispose.updatePlan();else entry.host.dataset.gridState=problem?'invalid':next.gridPlan?'pending':'empty';}
  else{
   entry.dispose?.();entry.dispose=null;preferences.delete(entry.config.preferenceKey);
   const template=document.createElement('template');template.innerHTML=tradingChartPanel(key,{...next,gridPreview:false});
   entry.config=configs.get(key);Object.assign(entry.config,{draftError:next.draftError,blocked:next.blocked});
   entry.host.innerHTML=template.content.firstElementChild.innerHTML;entry.host.setAttribute('aria-label',template.content.firstElementChild.getAttribute('aria-label'));
   for(const name of ['engine','candleCount','priceLevelCount','markerCount','chartState','chartSource','gridState'])delete entry.host.dataset[name];
   stampDraft(entry.host,entry.config);entry.sync();
  }
  return problem?{ok:false,code:problem.code,field:problem.field}:{ok:true,planRef:{...next.planRef}};
 };
 return cleanup;
}
