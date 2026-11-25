import {MARKET,NEWS,EXCHANGES,EXCHANGE_SHARES,exchangeSplit,fundingRate,wave} from './data-center-fixtures.mjs';
import {makeBars} from './product-chart-ui.mjs';
import {L} from './execution-views.mjs';

// Values shared with the market table are in millions of USD. All additional
// breakdowns are deterministic local scenarios, not exchange/API observations.
const END=Date.UTC(2026,9,24,6);
const WINDOWS=[['4小时',4],['24小时',24],['7天',168],['30天',720],['90天',2160],['180天',4320],['年初至今',7128],['1年',8760],['全部样本',8784]];
const times=(count,hours=24)=>Array.from({length:count},(_,i)=>END-(count-1-i)*hours*3600000);
const amount=(value,compact)=>value==null?'—':'$'+compact(value);
const splitAmong=(total,weights)=>{const sum=weights.reduce((s,v)=>s+v,0);let used=0;return weights.map((v,i)=>{const part=i===weights.length-1?total-used:total*v/sum;used+=part;return part;});};

export function createAssetView(ctx){
 const {state,saved,param,stamp,research,link,info,section,empty,table,tabs,chip,quote,coin,assetLink,star,num,pct,compact,esc,chartPanel,miniChart}=ctx;
 const money=v=>amount(v,compact);
 const cell=(name,value,sub='')=>`<div class="da-stat"><span>${name}</span><strong>${value}</strong>${sub?`<small>${sub}</small>`:''}</div>`;
 const route=(a,view,label,selected=false)=>link(label,'markets',{asset:a.symbol,view},selected?'selected':'');
 const percent=v=>Number.isFinite(v)?pct(v):'—';

 return function assetDetail(a){
  const crypto=a.domain==='Crypto',requested=param('view'),view=crypto&&['futures','spot'].includes(requested)?requested:'overview';
  const seed=MARKET.indexOf(a)+39,daily=wave(a.price,seed,367,.2);
  // The short windows share the same series as the market table; longer
  // windows are an explicitly simulated extension ending at the same quote.
  const performance=hours=>hours===4?a.change4h:hours===24?a.change:hours===168?(a.price/a.series[0]-1)*100:(a.price/daily[Math.max(0,daily.length-1-Math.round(hours/24))]-1)*100;
  const priceDelta=a.price-a.series.at(-25);
  const formatChange=v=>a.symbol==='US10Y'?`<span class="dc-${v>=0?'up':'down'}">${v>0?'+':''}${num(v,2)} bp</span>`:pct(v);
  const spotVolume=crypto?a.volume*.075:null;
  const longShare=crypto?a.long/100:0;
  // Liquidation direction is independent of open-position direction.
  const liquidationLong=.46+(MARKET.indexOf(a)%5)*.065;
  const volumeHistory=crypto?wave(a.volume,seed+8,30,.5):[];
  const spotHistory=volumeHistory.map(v=>v*.075);
  const nav=`<nav class="da-tabs" aria-label="${esc(a.symbol)} 数据">${route(a,'overview','总览',view==='overview')}${crypto?route(a,'futures','合约数据',view==='futures')+route(a,'spot','现货数据',view==='spot'):''}</nav>`;
  const header=`<div class="da-breadcrumb">${link('市场行情','markets')}<span>/</span><span>${esc(a.name)}</span><span class="da-sample">模拟数据</span></div><header class="da-summary"><div class="da-identity">${coin(a)}<div><h1>${esc(a.symbol)}</h1><span>${esc(a.name)}</span></div></div><div class="da-price"><strong>${quote(a)}</strong><span>${esc(a.unit)}</span><div>${a.symbol==='US10Y'?formatChange(priceDelta*100):percent(a.change)}<small>24h</small></div></div><div class="da-summary-metrics">${crypto?cell('合约成交额 · 24h',money(a.volume))+cell('现货成交额 · 24h',money(spotVolume))+cell('市值',money(a.marketCap))+cell('合约持仓',money(a.oi)):cell('24h 变化',formatChange(a.symbol==='US10Y'?priceDelta*100:a.change))+cell('7d 变化',a.symbol==='US10Y'?formatChange((a.price-a.series[0])*100):percent(performance(168)))}</div><div class="da-follow">${star('assets',a.symbol,saved.assets.includes(a.symbol))}</div></header><div class="da-subbar">${nav}${stamp()}</div>`;

  function mainPrice(){
   const range=['1D','7D','30D','90D','1Y'].includes(state.assetRange)?state.assetRange:'7D';
   const rangeHours={'1D':24,'7D':168,'30D':720,'90D':2160,'1Y':8760}[range];
   const period=rangeHours<=168?'1H':'1D';
   const values=rangeHours<=168?a.series.slice(-(rangeHours+1)):daily.slice(-(Math.round(rangeHours/24)+1));
   const series=a.symbol==='US10Y'?{kind:'line',values,labels:times(values.length,period==='1D'?24:1)}:{bars:makeBars(values,period)};
   return section(a.symbol==='US10Y'?'收益率走势':'价格走势',chartPanel('dc-asset-price-'+a.symbol,{title:a.symbol,...series,unit:a.unit,period,height:338}),tabs(['1D','7D','30D','90D','1Y'],range,'assetRange',L('行情时间范围','Market time range')),'da-price-panel');
  }
  function performancePanel(){
   return section('价格表现',`<div class="da-performance">${WINDOWS.map(([name,hours])=>`<div><span>${name}</span><strong>${a.symbol==='US10Y'?formatChange((a.price-(hours<=168?a.series[Math.max(0,a.series.length-1-hours)]:daily[Math.max(0,daily.length-1-Math.round(hours/24))]))*100):percent(performance(hours))}</strong></div>`).join('')}</div>`,info('短周期取自同一行情样本；30天及更长区间为扩展模拟序列。全部样本为一年，不代表上市以来表现。'), 'da-performance-panel');
  }
  function longShort(){
   return section('多空持仓',`<div class="da-longshort"><div><span>多头</span><b class="dc-up">${num(a.long,1)}%</b><b class="dc-down">${num(100-a.long,1)}%</b><span>空头</span></div><div class="dc-ls-track"><i style="width:${a.long}%"></i></div><footer><span>多 / 空</span><strong>${num(longShare/(1-longShare),2)}</strong>${link('交易所对比 ↗','derivatives',{view:'多空比',asset:a.symbol})}</footer></div>`,info('模拟名义持仓比例，与账户人数比不是同一种统计。多头与空头合计为100%。'));
  }
  function liquidationPanel(){
   return section('分时清算',`<div class="da-liquidations">${[[1,.035],[4,.18],[12,.47],[24,1]].map(([h,factor])=>{const total=a.liquidation*factor,lo=total*liquidationLong;return `<div><div><b>${h}h 清算</b><strong>${money(total)}</strong></div><p><span>多头</span><b class="dc-down">${money(lo)}</b></p><p><span>空头</span><b class="dc-up">${money(total-lo)}</b></p></div>`;}).join('')}</div>`,info('窗口均截止快照时间；1h、4h、12h是24h内的累计子窗口，不能相加。多头加空头等于该窗口总额。'));
  }
  function exchangeTable(mode){
   const spot=mode==='现货',indices=spot?[0,1,2,4,5]:EXCHANGES.map((_,i)=>i),weights=indices.map(i=>EXCHANGE_SHARES[i]);
   const volumes=splitAmong(spot?spotVolume:a.volume,weights),oi=exchangeSplit(a.oi),liq=exchangeSplit(a.liquidation);
   const rows=indices.map((index,i)=>{const venue=EXCHANGES[index],spread=(index-2)*.000018,price=a.price*(1+spread);return `<tr><td>${i+1}</td><td><span class="da-venue-mark">${esc(venue.slice(0,1))}</span><b>${esc(venue)}</b></td><td>${esc(a.symbol)} / ${index===3?'USD':'USDT'}</td><td>${quote({...a,price})}</td><td>${percent(a.change)}</td><td>${money(volumes[i])}</td><td><div class="da-share"><i style="width:${num(weights[i]/weights.reduce((s,v)=>s+v,0)*100,2)}%"></i></div>${num(weights[i]/weights.reduce((s,v)=>s+v,0)*100,1)}%</td>${spot?`<td>${num(1.2+index*.35,1)} bps</td>`:`<td>${money(oi[index])}</td><td>${link(pct(fundingRate(a,index),4),'derivatives',{asset:a.symbol,view:'资金费率',exchange:venue})}</td><td>${money(liq[index]*liquidationLong)}</td><td>${money(liq[index]*(1-liquidationLong))}</td>`}</tr>`;});
   return section(a.symbol+' 交易市场',table(['#','交易所','交易对','价格','24h 涨跌','24h 成交额','份额',...(spot?['价差']:['持仓','费率 / 8h','多头清算','空头清算'])],rows),view==='overview'?tabs(['合约','现货'],mode,'assetMarket',L('市场类型','Market type')):chip(mode),'da-exchange-panel');
  }
  function flows(){
   // Flow totals are trade-direction classifications of spot turnover. They
   // are not blockchain transfers, and in+out reconciles to spot volume.
   const buyShare=.5+Math.max(-.12,Math.min(.12,a.change/100));
   const periods=[[1,1/24],[4,1/6],[12,.5],[24,1]];
   return section('现货主动买卖',table(['时间窗口','主动买入','主动卖出','买入 − 卖出','买入占比'],periods.map(([h,f])=>{const total=spotVolume*f,buy=total*buyShare,sell=total-buy;return `<tr><td>${h}h</td><td class="dc-up">${money(buy)}</td><td class="dc-down">${money(sell)}</td><td class="dc-${buy>=sell?'up':'down'}">${buy>=sell?'+':''}${money(buy-sell)}</td><td>${num(buyShare*100,1)}%</td></tr>`;})),info('按模拟主动成交方向归类，买入加卖出等于该窗口现货成交额；不是链上资金流入流出。'));
  }
  function derivativeChart(){
   const selected=['资金费率','持仓量','成交额','清算'].includes(state.assetView)?state.assetView:'资金费率';
   const base={'资金费率':a.funding,'持仓量':a.oi,'成交额':a.volume,'清算':a.liquidation}[selected];
   const points=wave(Math.abs(base)||.0001,seed+52,90,selected==='资金费率'?.6:.25).map(v=>base<0?-v:v);
   return section(a.symbol+' · '+selected,chartPanel('dc-asset-futures-'+a.symbol,{title:selected==='资金费率'?'持仓加权费率':selected,values:points,labels:times(90),unit:selected==='资金费率'?'%':'百万 USD',height:320,kind:['清算','成交额'].includes(selected)?'bar':'line'}),tabs(['资金费率','持仓量','成交额','清算'],selected,'assetView',L('资产详情分类','Asset detail section')),'da-futures-chart');
  }
  function orderbook(){
   const makeSide=ask=>{let cumulative=0;const rows=Array.from({length:6},(_,i)=>{const size=(.8+Math.abs(Math.sin(seed+i))*.8)*Math.max(.1,10000/a.price);cumulative+=size;return {price:a.price*(1+(ask?1:-1)*(i+1)*.00013),size,cumulative};});return (ask?rows.reverse():rows).map(r=>`<div class="dc-book ${ask?'ask':'bid'}" style="--depth:${r.cumulative/cumulative*100}%"><span>${quote({...a,price:r.price})}</span><span>${num(r.size,3)}</span><span>${num(r.cumulative,3)}</span></div>`).join('');};
   return section('现货盘口',`<div class="dc-order-head"><span>价格 · USD</span><span>数量 · ${esc(a.symbol)}</span><span>累计</span></div>${makeSide(true)}<div class="dc-book-mid">${quote(a)}<small>价差 2.6 bps</small></div>${makeSide(false)}`,chip('模拟'),'da-orderbook');
  }
  function lower(){
   const stories=NEWS.filter(n=>n.assets.includes(a.symbol)).slice(0,4);
   const next=crypto?'查看成交是否跟上价格，同时比较持仓与交易成本。':'对照美元、利率和重要事件，继续观察跨市场反应。';
   return `<div class="da-bottom-grid">${section('相关消息',stories.map(n=>`<div class="dc-news-compact"><time>${esc(n.time)}</time>${link(esc(n.title),'intelligence',{story:n.id})}</div>`).join('')||empty('这个样例资产暂无关联消息。'))}${section('AI 帮我看',`<div class="da-ai"><span class="da-ai-mark" aria-hidden="true">✦</span><div><h3>${a.change>=0?'价格上涨，资金跟上了吗？':'价格回落，先看哪里出现变化'}</h3><p>${next}</p>${research(a.symbol,a.symbol+' '+(view==='futures'?'合约数据':view==='spot'?'现货数据':'行情观察'))}</div></div>`,info('这里是预设观察提示。点击后进入平台的模拟研究流程，不代表模型已经完成分析。'))}</div>`;
  }
  let body='';
  if(view==='overview'){
   body=`<div class="da-overview-grid">${mainPrice()}<aside class="da-analysis-side">${performancePanel()}${crypto?longShort():section('跨市场观察',MARKET.filter(m=>m.domain==='TradFi'&&m.symbol!==a.symbol).slice(0,4).map(m=>`<div class="dc-rank">${assetLink(m)}<b>${quote(m)}</b></div>`).join(''))}</aside></div>${crypto?exchangeTable(state.assetMarket==='现货'?'现货':'合约')+`<div class="da-bottom-grid">${liquidationPanel()}${flows()}</div>`:''}`;
  }else if(view==='futures'){
   body=`<div class="da-futures-top">${section('合约概览',`<div class="da-futures-metrics">${cell('24h 合约成交额',money(a.volume),a.volumeChange==null?'':num(a.volumeChange)+'% · 较前一日')}${cell('合约持仓',money(a.oi),num(a.oiChange)+'% · 24h')}${cell('加权费率 / 8h',pct(a.funding,4))}${cell('成交额 / 持仓',num(a.volume/a.oi,2)+'×')}</div>`,info('持仓、成交与清算均与市场总览的同资产快照一致。费率统一换算为8小时口径。'))}${liquidationPanel()}</div><div class="da-futures-chart-grid">${derivativeChart()}<aside>${longShort()}${section('交易所持仓',`<div class="da-venue-bars">${EXCHANGES.map((name,i)=>`<div><span>${esc(name)}</span><div><i style="width:${EXCHANGE_SHARES[i]*100}%"></i></div><b>${money(exchangeSplit(a.oi)[i])}</b></div>`).join('')}</div>`)}</aside></div>${exchangeTable('合约')}`;
  }else{
   body=`<div class="da-spot-summary">${cell('现货成交额 · 24h',money(spotVolume))}${cell('成交额 / 市值',a.marketCap?num(spotVolume/a.marketCap*100,2)+'%':'—')}${cell('交易所覆盖','5 家')}${cell('样本报价',quote(a),a.unit)}</div><div class="da-spot-grid">${section('现货成交额',chartPanel('dc-asset-spot-volume-'+a.symbol,{title:'24h 现货成交额',values:spotHistory,labels:times(spotHistory.length),unit:'百万 USD',kind:'bar',height:310,color:'var(--ok)'}),chip('30 天'))}${orderbook()}</div>${flows()}${exchangeTable('现货')}`;
  }
  return `<div class="da-root" data-asset-view="${view}">${header}${body}${lower()}</div>`;
 };
}
