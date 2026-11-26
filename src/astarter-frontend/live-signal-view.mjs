import {tokenIcon} from './brand-icons.mjs';
import {CROSS_MARKETS} from './cross-market-data.mjs';
import {getLocale,localeInfo,pair as L} from './locale.mjs';
import {sparkline} from './product-charts.mjs';
import {uiGlyph} from './product-composition.mjs';
import {escapeUI as esc} from './product-experience.mjs';

const signals={
 up:{tag:['上行','Upward'],title:['上行动量','Upward momentum'],thesis:['三项指标均满足上行条件。','All three indicators meet the upward rule.']},
 down:{tag:['下行','Downward'],title:['下行动量','Downward momentum'],thesis:['三项指标均满足下行条件。','All three indicators meet the downward rule.']},
 neutral:{tag:['中性','Neutral'],title:['中性观察','Neutral observation'],thesis:['三项指标尚未同时满足上行或下行条件。','Neither directional rule is fully met.']}
};

const formatters=new Map();
function number(value,{price=false,signed=false}={}){
 if(!Number.isFinite(value))return '—';
 const magnitude=Math.abs(value);
 const significant=price&&magnitude>0&&magnitude<0.1;
 const decimals=price?(magnitude>=100?2:magnitude>=1?4:6):2;
 const locale=localeInfo(getLocale()).tag;
 const key=[locale,significant?'significant':decimals,signed].join(':');
 if(!formatters.has(key))formatters.set(key,new Intl.NumberFormat(locale,{
  ...(significant?{maximumSignificantDigits:5}:{maximumFractionDigits:decimals}),
  signDisplay:signed?'exceptZero':'auto'
 }));
 return formatters.get(key).format(value);
}
export function signalClosePrice(value){
 return number(value,{price:true});
}
function timestamp(ms){
 if(!Number.isSafeInteger(ms)||ms<=0)return '';
 const date=new Date(ms);
 return Number.isFinite(date.getTime())?date.toISOString():'';
}
function publicText(text){return typeof text==='string'&&text.length>0&&text.length<=120&&!/[<>\r\n]/.test(text);}
function sourceURL({symbol,market,source}){
 if(source.startsWith('Binance')&&/^[A-Z0-9]+\/[A-Z0-9]+$/.test(market))return 'https://www.binance.com/en/trade/'+market.replace('/','_');
 const spec=CROSS_MARKETS[symbol];
 if(spec?.venueId==='yahoo'&&source.startsWith('Yahoo Finance'))return 'https://finance.yahoo.com/quote/'+encodeURIComponent(spec.id)+'/history/';
 if(spec?.venueId==='dukascopy'&&source.startsWith('Dukascopy'))return 'https://www.dukascopy.com/swiss/english/marketwatch/historical/';
 return '';
}
function instrument({symbol,market,source}){
 if(market!==symbol)return market;
 return source.split(' · ')[1]||market;
}
function quoteUnit({unit}){return unit==='index'?L('点','pts'):unit;}
function closeLabel({unit}){
 if(unit==='%')return L('收盘收益率','Closing yield');
 return unit==='index'?L('收盘点位','Closing level'):L('收盘价','Closing price');
}
function intervalStatus({period,session,freshness,refreshFailed}){
 if(period==='1m')return freshness==='prior-minute'||refreshFailed?L('上次分钟收盘','Last sampled minute'):L('1 分钟已收盘','1-minute close');
 if(session==='delayed')return L('延迟日线','Delayed daily data');
 return session==='last-close'?L('上一交易日收盘','Last session close'):L('交易日收盘','Session close');
}
function observationClock(o,precise=false){
 if(o.period==='1D')return {label:L('交易日','Trading date'),datetime:o.sessionDate,text:o.sessionDate};
 const stamp=timestamp(o.closedAt);
 return {label:L('收盘时间','Candle close time'),datetime:stamp,text:stamp.slice(0,10)+' '+stamp.slice(11,precise?19:16)+' UTC'};
}
function star(id,watched){
 const label=watched?L('取消关注','Unfollow'):L('关注','Follow');
 return `<button type="button" class="sig-watch" data-track-watch="${esc(id)}" aria-pressed="${watched}" aria-label="${esc(label+' '+id)}">${uiGlyph('star')}${watched?L('已关注','Following'):L('关注','Follow')}</button>`;
}
function metric(label,value){return `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;}
function miniChart(o){
 const values=o.priceSeries;
 if(!Array.isArray(values)||values.length<2||values.some(n=>!Number.isFinite(n)||n<=0)||values.at(-1)!==o.price)return '';
 const range=[values[0],o.price].map(n=>number(n,{price:true})).join(' → ');
 const label=[L('收盘走势','Closing trend'),o.period,range+' '+quoteUnit(o)].join(' · ');
 return `<figure class="sig-live-chart" role="img" aria-label="${esc(label)}">
  <div aria-hidden="true">${sparkline(values,{width:208,height:45,color:'var(--chart-accent)',fill:false})}</div></figure>`;
}
function prices(o){return `<div class="sig-stats-quote"><span>${esc(closeLabel(o))}</span>
 <strong class="dot-number">${esc(signalClosePrice(o.price))} <small>${esc(quoteUnit(o))}</small></strong></div>`;}
function readings(o){
 const facts=[
  [L('5 根涨跌幅','5-bar change'),number(o.momentumPct,{signed:true})+'%',o.momentumPct,'%'],
  ['EMA 20',number(o.ema20,{price:true})+' '+quoteUnit(o),o.ema20,quoteUnit(o)],
  ['RSI 14',number(o.rsi14),o.rsi14,'']
 ];
 if(Number.isFinite(o.volumeRatio))facts.push([L('成交量 / 前 20 根均量','Volume / prior 20-bar average'),number(o.volumeRatio)+'×',o.volumeRatio,'×']);
 return facts;
}

// A card stays selected across receipts. The observation id identifies the specific close in an excerpt.
export function liveSignalRow(observation){
 if(!observation||!Object.hasOwn(signals,observation.direction)||!['1m','1D'].includes(observation.period))return null;
 const {symbol,market,source,assetClass,period,price,closedAt,sessionDate,direction,unit}=observation;
 const stamp=timestamp(closedAt),daily=period==='1D';
 if(typeof symbol!=='string'||!/^[A-Z0-9][A-Z0-9.-]{0,24}$/.test(symbol)||![source,market,unit].every(publicText)||
    !Number.isFinite(price)||!stamp||daily&&!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate))return null;
 const date=daily?sessionDate:stamp.slice(0,10),id='signal-market-'+symbol+'-'+period;
 return {
  live:observation,id,symbol,date,time:daily?'':stamp.slice(11,16),price,
  minute:Math.floor((daily?Date.parse(date+'T00:00:00Z'):closedAt)/60000),
  track:{id:symbol,asset:{symbol,name:instrument(observation),domain:assetClass==='crypto'?'Crypto':'TradFi',unit},
   source:'market',title:signals[direction].title,thesis:signals[direction].thesis,events:[]}
 };
}

function liteCardSource(o,time) {
 const demo=o.mode==='practice',href=demo?'':sourceURL(o);
 const source=demo?L('本机演练','Local practice'):o.source;
 const attribution=href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-ls="source">${esc(source)} ↗</a>`:esc(source);
 return `<div class="sig-event-time lite-card-source"><span>${attribution}</span><time datetime="${esc(time.datetime)}">${esc(time.text)}</time></div>`;
}

export function liveSignalCard(row,{selected=false,watched=false,strategy=null,busy=false}={}){
 const o=row.live,id=esc(row.id),time=observationClock(o),facts=readings(o),active=selected===true||selected===row.id;
 const disabled=busy?' disabled':'';
 const title=strategy
  ? `<h3 class="sig-event-title">${esc(strategy.label)}</h3>`
  : `<button type="button" class="sig-event-title" data-track-open="${id}">${esc(L(...row.track.title))}</button>`;
 const state=strategy?uiGlyph('arrow')+esc(L(...signals[o.direction].tag)):esc(intervalStatus(o));
 const marker=active?'<span class="sig-current-marker" aria-hidden="true">✓</span>':'';
 const actions=strategy
  ? `<button type="button" data-ls="evidence" aria-label="${esc(o.symbol+' · '+L('查看依据','View evidence'))}"${disabled}>${L('查看依据','View evidence')}</button>
     <button type="button" data-ls="select" aria-controls="lite-controls" aria-label="${esc(o.symbol+' · '+strategy.label+' · '+(active?L('查看操作台','View ticket'):L('选择信号','Select signal')))}"${disabled}>${active?L('查看操作台','View ticket'):L('选择信号','Select signal')} ${uiGlyph('arrow')}</button>`
  : `<div class="sig-event-time"><time datetime="${esc(time.datetime)}">${esc(time.text)}</time></div>
     ${star(o.symbol,watched)}
     <button type="button" data-track-open="${id}" data-track-read>${esc(L('查看依据','View evidence'))} ${uiGlyph('arrow')}</button>`;
 return `<article class="sig-event sig-live-observation${active?' selected':''}" ${strategy?`data-side="${esc(strategy.side)}"`:`data-track-record="${id}"`} data-live-direction="${o.direction}" data-lite-asset="${esc(o.symbol)}" data-lite-id="${esc(o.id || '')}" aria-current="${active}">
  ${strategy?'':marker}
  <div class="sig-event-body"><header>
   <span class="sig-event-asset">${tokenIcon(o.symbol,{size:30,className:'sig-coin'})}
    <span><b>${esc(o.symbol)}</b><small>${esc(instrument(o))}</small></span>${strategy?marker:''}</span>
   ${title}<span class="sig-card-state">${state}</span></header>
   <div class="sig-live-market">${prices(o)}${miniChart(o)}</div>
   <dl class="sig-live-card-metrics">${metric(...facts[0])}${metric(...facts[2])}</dl>
   ${strategy?liteCardSource(o,time):''}<footer>${actions}</footer></div></article>`;
}

export function liveSignalDetail(row,{popup=false,watched=false,previousObservation=false}={}){
 const o=row.live,link=sourceURL(o),time=observationClock(o,true),hId=popup?'sig-dialog-title':'sig-detail-title',facts=readings(o);
 const source=link?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(o.source)} ↗</a>`:esc(o.source);
 const method=L('收盘价在 EMA20 上方、5 根涨跌幅为正、RSI14 高于 50 时判为上行。三项均反向时判为下行，其余为中性。','Up requires a close above EMA20, a positive 5-bar change and RSI14 above 50. All three reversed indicate down. Other readings are neutral.');
 const raw=[[closeLabel(o),null,o.price,quoteUnit(o)],...facts];
 return `<section class="sig-live-detail" data-live-direction="${o.direction}">
  <div class="sig-reading-tools"><h3 tabindex="-1" data-track-reading-heading aria-describedby="${hId}">${esc(L('行情依据','Market evidence'))}</h3>
   <div class="sig-record-actions"><button type="button" class="p-button" data-track-copy="${esc(row.id)}">${esc(L('复制信号','Copy signal'))}</button></div></div>
  <div class="sig-reading-hero"><div class="sig-detail-title sig-asset">
   ${tokenIcon(o.symbol,{size:36,className:'sig-coin'})}<div><h2 id="${hId}">${esc(o.symbol)}</h2><small>${esc(instrument(o))}</small></div>${star(o.symbol,watched)}</div>
   ${previousObservation?`<p class="sig-live-method">${esc(L('原信号已更新，以下是该标的最新观察。','A newer observation is available. This view shows the latest readings for this asset.'))}</p>`:''}
   <section class="sig-reading-lead"><h3>${esc(L(...row.track.title))}</h3><p class="sig-detail-thesis">${esc(L(...row.track.thesis))}</p></section>
   <div class="sig-live-detail-quote">${prices(o)}${miniChart(o)}</div></div>
  <dl class="sig-live-detail-metrics">${facts.map(([key,value])=>metric(key,value)).join('')}</dl><p class="sig-live-method">${esc(method)}</p>
  <details class="sig-live-exact"><summary>${esc(L('完整精度','Full precision'))}</summary><dl class="sig-live-detail-metrics">
   ${raw.map(([key,,value,unit])=>metric(key,Number.isFinite(value)?String(value)+(unit?' '+unit:''):'—')).join('')}</dl></details>
  <dl class="sig-live-provenance"><div><dt>${esc(L('数据来源','Data source'))}</dt><dd>${source}</dd></div>
   ${metric(L('周期','Timeframe'),intervalStatus(o))}
   <div><dt>${esc(time.label)}</dt><dd><time datetime="${esc(time.datetime)}">${esc(time.text)}</time></dd></div></dl></section>`;
}

export function liveSignalCopyText(row){
 const o=row.live,time=observationClock(o,true),lines=[
  [o.symbol,instrument(o),L(...row.track.title)].filter((item,index,array)=>array.indexOf(item)===index).join(' · '),
  [closeLabel(o),number(o.price,{price:true})+' '+quoteUnit(o)],...readings(o).map(([label,value])=>[label,value]),
  [L('数据来源','Data source'),o.source],[L('周期','Timeframe'),intervalStatus(o)],[time.label,time.text]
 ];
 return lines.map(line=>Array.isArray(line)?line.join(' · '):line).join('\n');
}

export function liveSignalExcerpt(row){
 const o=row.live;
 return JSON.stringify({
  kind:'public-market-observation',recordId:row.id,snapshotId:publicText(o.id)?o.id:null,symbol:o.symbol,market:o.market,
  assetClass:o.assetClass,period:o.period,direction:o.direction,source:o.source,unit:o.unit,price:o.price,
  momentumPct:o.momentumPct,ema20:o.ema20,rsi14:o.rsi14,volumeRatio:Number.isFinite(o.volumeRatio)?o.volumeRatio:null,
  closedAt:o.closedAt,closeTimeBasis:o.closeTimeBasis,sessionDate:o.sessionDate??null,session:o.session,timezone:o.timezone,
  receivedAt:o.receivedAt,validUntil:o.validUntil,currentUntil:o.currentUntil,freshness:o.freshness,refreshFailed:o.refreshFailed===true
 },null,2);
}
