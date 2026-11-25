import test from 'node:test';
import assert from 'node:assert/strict';
import {MARKET,CRYPTO,METRICS,ETF,POSTS,TRADERS,DATA_PAGES,selectMarket,selectMetrics,wave,marketRows,exchangeSplit,fundingRate,ETH_ETF,ETH_FUNDS,FUND_META,ETH_FUND_META,EXCHANGES,EXCHANGE_SHARES,FUNDING} from './data-center-fixtures.mjs';
import {routePage} from './product-data.mjs';
test('a data repaint preserves the horizontal table position only for the same route and columns',t=>{
 const previous={location:globalThis.location,document:globalThis.document};
 t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
 globalThis.location=new URL('http://localhost/?page=etf&data=demo');
 globalThis.document={hidden:true,addEventListener(){},body:{},activeElement:null};
 const wrap=(columns,left=0)=>({scrollLeft:left,querySelector:()=>({textContent:columns})});
 let table=wrap('SessionFundTotal');
 const root={scrollTop:0,querySelector:()=>null,querySelectorAll:s=>s==='.dc-root .dc-table-wrap'?[table]:[]};
 const ui=createDataCenter({root,rerender(){},notify(){},onResearch(){}});
 assert.match(ui.render('etf'),/class="dc-table-wrap" tabindex="0" role="region"/);ui.bind();table.scrollLeft=170;
 ui.render('etf');table=wrap('SessionFundTotal');ui.bind();assert.equal(table.scrollLeft,170);
 ui.render('etf');table=wrap('FundManagerAUM');ui.bind();assert.equal(table.scrollLeft,0);
 table.scrollLeft=135;globalThis.location.search='?page=etf&fund=IBIT&data=demo';
 ui.render('etf');table=wrap('FundManagerAUM');ui.bind();assert.equal(table.scrollLeft,0);
});
test('social filters retain keyboard focus and reveal the selected item after repaint',t=>{
 const previous={location:globalThis.location,document:globalThis.document};
 t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
 globalThis.location=new URL('http://localhost/?page=social&data=demo');globalThis.document={hidden:true,addEventListener(){},body:{},activeElement:null};
 let focused=0,revealed=0;
 const button={dataset:{dcFilter:'social',value:'持仓变化'},focus(options){assert.equal(options.preventScroll,true);focused++;},scrollIntoView(options){assert.deepEqual(options,{block:'nearest',inline:'nearest'});revealed++;}};
 const root={scrollTop:0,querySelectorAll:s=>s==='[data-dc-filter]'?[button]:[],querySelector:s=>s==='[data-dc-filter="social"][data-value="持仓变化"]'?button:null};
 const ui=createDataCenter({root,rerender(){},notify(){},onResearch(){}});ui.render('social');ui.bind();button.onclick();
 assert.equal(focused,1);assert.equal(revealed,1);assert.match(ui.render('social'),/data-value="持仓变化" aria-pressed="true"/);
});

test('the sample feed and account history identify their source and link to the public feed',t=>{
 const before=globalThis.location;
 t.after(()=>{if(before===undefined)delete globalThis.location;else globalThis.location=before;});
 const ui=createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}});
 for(const view of ['','&trader=north&view=history','&view=排行榜']){
  globalThis.location=new URL('http://localhost/?page=social&data=demo'+view);
  const html=ui.render('social');
  assert.match(html,/data-social-demo-source>(Sample|示例数据)</);
  assert.match(html,/href="\?page=social&data=live">(?:Social trends|社媒动向) →<\/a>/);
  assert.doesNotMatch(html,/df-sim-inline|href="[^"]*data=live[^"]*trader=north|href="[^"]*trader=north[^"]*data=live/);
 }
});
import {DOMAINS} from './business-pages.js';
test('all data pages resolve inside the same global navigation domain',()=>{for(const id of DATA_PAGES){assert.equal(routePage('?page='+id),id);assert.equal(DOMAINS.find(d=>d.pages.includes(id))?.home,'markets');}});
test('market filters and ranking use real fixture fields without mutating source ordering',()=>{const before=MARKET.map(a=>a.symbol);assert.deepEqual(selectMarket({category:'自选',favorites:['ETH'],query:'eth'}).map(a=>a.symbol),['ETH']);assert.equal(selectMarket({category:'TradFi'}).length,5);assert.equal(selectMarket({query:'no-such-asset'}).length,0);assert.equal(selectMarket({sort:'oiChange'})[0].symbol,'AAVE');const sorted=selectMarket({sort:'oiChange'}).filter(a=>a.oiChange!=null);assert.ok(sorted.every((a,i)=>!i||sorted[i-1].oiChange>=a.oiChange));assert.deepEqual(MARKET.map(a=>a.symbol),before);});
test('24h change uses 24 hourly intervals and latest displayed quote agrees with history',()=>{for(const a of MARKET){assert.equal(a.series.at(-1),a.price);assert.equal(a.change,(a.price/a.series.at(-25)-1)*100);assert.ok(a.series.every(Number.isFinite));}for(const a of MARKET.filter(a=>a.domain==='TradFi'))assert.equal(a.funding,null);});
test('chain category and watch counts are calculated from matching metrics',()=>{assert.equal(selectMetrics({category:'交易所资金'}).length,6);assert.deepEqual(selectMetrics({category:'我的追踪',favorites:['mvrv'],query:'BTC'}).map(m=>m.id),['mvrv']);assert.equal(selectMetrics({query:'does not exist'}).length,0);for(const m of METRICS)assert.ok(Math.abs(m.series.at(-1)-m.value)<.000001);});
test('ETF daily totals match component fund flows within rounding precision',()=>{for(const r of ETF)assert.ok(Math.abs(r.flows.reduce((s,v)=>s+v,0)-r.total)<=.21);assert.equal(new Set(ETF.map(r=>r.date)).size,ETF.length);});
test('social activity links only to included assets and identified simulated accounts',()=>{for(const p of POSTS){assert.ok(TRADERS.some(t=>t.id===p.trader));assert.ok(CRYPTO.some(a=>a.symbol===p.asset));if(p.side){assert.ok(p.after>=0&&p.after<=100);assert.notEqual(p.before,p.after);}}assert.deepEqual(wave(100,9),wave(100,9));});
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch} from './multi-research.mjs';
test('data-center research keeps its source and uses the existing credit and duplicate-task rules',()=>{const research=new MultiResearch(),workspace=new WorkspaceSim({research});workspace.setBudget({daily:200,byok:true});const source={title:'持续增持账户持币量',href:'?page=tracking&metric=accumulation'};assert.equal(workspace.requestResearch('BTC',source),null);assert.equal(workspace.reserved,workspace.quote(8));assert.equal(workspace.s.usage[0].source.title,source.title);assert.equal(workspace.s.usage[0].source.mode,'simulation-only');assert.match(research.task('BTC').reason,/持续增持账户/);assert.match(workspace.requestResearch('BTC',source),/已有/);assert.equal(workspace.s.usage.length,1);});

test('expanded data covers complete market and chain category surfaces with distinct stable identities',()=>{assert.equal(MARKET.length,29);assert.equal(CRYPTO.length,24);assert.equal(METRICS.length,48);assert.equal(new Set(METRICS.map(m=>m.id)).size,48);for(const m of METRICS){assert.ok(m.description.length>10);assert.ok(m.unit);assert.ok(m.series.every(Number.isFinite));}assert.equal(new Set(METRICS.map(m=>m.category)).size,14);});
test('advanced asset filters, sort direction and sectors operate on the full universe',()=>{const up=marketRows({category:'DeFi',positiveOnly:true,minVolume:200,sort:'volume',direction:'asc'});assert.ok(up.length);for(const a of up){assert.equal(a.sector,'DeFi');assert.ok(a.change>0);assert.ok(a.volume>=200);}assert.ok(up.every((a,i)=>!i||up[i-1].volume<=a.volume));assert.deepEqual(marketRows({category:'自选',favorites:['BTC','XAU'],query:'xau'}).map(a=>a.symbol),['XAU']);});
test('exchange shares reconcile and funding intervals are explicitly consistent',()=>{for(const total of [1,100,50966])assert.ok(Math.abs(exchangeSplit(total).reduce((s,n)=>s+n,0)-total)<1e-8);for(const a of CRYPTO)for(let i=0;i<EXCHANGES.length;i++)assert.ok(Math.abs(fundingRate(a,i,'7日')-fundingRate(a,i)*21)<1e-10);});
test('BTC and ETH fund histories have separate fund identities and reconcile to totals',()=>{assert.equal(ETH_FUNDS.length,9);assert.equal(FUND_META.length,11);assert.equal(ETH_FUND_META.length,9);assert.ok(!ETH_FUNDS.includes('IBIT'));for(const row of ETH_ETF){assert.equal(row.flows.length,ETH_FUNDS.length);assert.ok(Math.abs(row.flows.reduce((s,v)=>s+v,0)-row.total)<1e-8);}});

import {createDataCenter} from './data-center.mjs';
import {createAssetView} from './data-asset-view.mjs';
import {chartPanel} from './product-chart-ui.mjs';
test('all data-center subroutes render meaningful bodies without invalid values',()=>{const old=globalThis.location;try{const ui=createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}});for(const path of ['markets','markets&view=ranking','markets&view=heatmap','markets&view=exchanges','markets&asset=BTC','markets&asset=PEPE','markets&asset=US10Y','tracking','tracking&metric=mvrv','tracking&metric=exchange-netflow','tracking&metric=hashrate','intelligence&data=demo','intelligence&story=n1&data=demo','social','social&view=发现交易员','social&view=排行榜','social&trader=orbit','derivatives&view=资金费率','derivatives&view=持仓量','derivatives&view=清算','derivatives&view=多空比','etf','etf&fund=IBIT']){globalThis.location=new URL('http://localhost/?page='+path+(path.includes('data=')?'':'&data=demo'));const html=ui.render(path.split('&')[0]);assert.ok(html.length>2000,path);assert.ok(!/NaN|undefined|Infinity/.test(html),path);assert.match(html,/dc-root/);}}finally{if(old)globalThis.location=old;else delete globalThis.location;}});
test('funding matrix reconciles to the headline OI-weighted rate',()=>{const weights=EXCHANGE_SHARES;for(const a of CRYPTO){const weighted=weights.reduce((sum,w,i)=>sum+w*fundingRate(a,i),0);assert.ok(Math.abs(weighted-a.funding)<1e-10);}});

test('metric search accepts the published metric identifier as well as its display name',()=>{assert.ok(selectMetrics({query:'MVRV'}).some(m=>m.id==='mvrv'));});


test('derivatives keep the selected six venues in matrix, allocation and history controls',()=>{
 assert.deepEqual(EXCHANGES,['Binance','OKX','Bybit','Hyperliquid','Bitget','Gate']);
 assert.equal(EXCHANGE_SHARES.length,EXCHANGES.length);
 assert.ok(Math.abs(EXCHANGE_SHARES.reduce((sum,w)=>sum+w,0)-1)<1e-12);
 assert.ok(FUNDING.every(row=>row.rates.length===EXCHANGES.length));
 const old=globalThis.location;try{
  const ui=createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}});
  for(const route of ['资金费率','持仓量','清算']){
   globalThis.location=new URL('http://localhost/?page=derivatives&data=demo&view='+route);
   const html=ui.render('derivatives');assert.doesNotMatch(html,/Deribit|BitMEX/);
   if(route==='资金费率'){assert.match(html,/\+0\.0081%/);assert.match(html,/-0\.0024%/);assert.match(html,/dc-history-filters/);}
   if(route==='持仓量'){assert.match(html,/var\(--chart-series-6\) [\d.]+% 100%/);assert.doesNotMatch(html,/--chart-series-[78]/);}
  }
 }finally{if(old)globalThis.location=old;else delete globalThis.location;}
});

test('funding comparison keeps every venue link and four decimal places without negative zero',()=>{
 const old=globalThis.location;
 try{
  globalThis.location=new URL('http://localhost/?page=derivatives&data=demo');
  const ui=createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}}),html=ui.render('derivatives');
  assert.doesNotMatch(html,/-0\.0000%|dc-heat /);
  for(const a of CRYPTO)for(const [i,venue]of EXCHANGES.entries()){
   const value=Number(fundingRate(a,i).toFixed(4)),text=(value>0?'+':'')+value.toFixed(4)+'%';
   const href=new URLSearchParams({page:'derivatives',view:'资金费率',asset:a.symbol,exchange:venue}).toString();
   assert.ok(html.includes('href="?'+href+'"'),a.symbol+' '+venue);
   assert.ok(html.includes('>'+text+'</span>'),a.symbol+' '+venue+' '+text);
  }
 }finally{if(old)globalThis.location=old;else delete globalThis.location;}
});

test('liquidation distribution is ranked by amount with proportional bars and the original history targets',()=>{
 const old=globalThis.location,before=JSON.stringify(CRYPTO);
 try{
  globalThis.location=new URL('http://localhost/?page=derivatives&data=demo&view=清算');
  const ui=createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}}),html=ui.render('derivatives');
  const rows=[...html.matchAll(/<a class="dc-liquidation-row"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
  const expected=[...CRYPTO].sort((a,b)=>b.liquidation-a.liquidation).slice(0,12);
  assert.equal(rows.length,12);
  for(const [i,row]of rows.entries()){
   const a=expected[i],route=new URL(row[1],'http://localhost');
   assert.equal(route.searchParams.get('asset'),a.symbol);assert.equal(route.searchParams.get('view'),'清算');
   const width=Number(row[2].match(/--amount-share:([\d.]+)%/)[1]);
   assert.ok(Math.abs(width-a.liquidation/expected[0].liquidation*100)<.01,a.symbol);
   assert.match(row[2],new RegExp('\\$'+a.liquidation.toFixed(1).replace('.','\\.')+'M'));
   assert.match(row[2],/多头|Longs/);assert.match(row[2],/空头|Shorts/);
  }
  assert.equal(JSON.stringify(CRYPTO),before);
 }finally{if(old)globalThis.location=old;else delete globalThis.location;}
});

test('US10Y yield windows keep the source values, percent unit and sample clock as a line without synthetic OHLC',()=>{
 const state={assetRange:'7D'},charts=[],asset=MARKET.find(a=>a.symbol==='US10Y'),before=JSON.stringify(asset);
 const render=createAssetView({state,saved:{assets:[]},param:()=>null,stamp:()=>'',research:()=>'',link:text=>text,info:text=>text,section:(title,body,action='')=>`<section><h2>${title}</h2>${action}${body}</section>`,empty:()=>'',table:()=>'',tabs:()=>'',chip:()=>'',quote:a=>String(a.price),coin:()=>'',assetLink:()=>'',star:()=>'',num:String,pct:String,compact:String,esc:String,miniChart:()=>'',chartPanel:(key,options)=>{charts.push(options);return chartPanel(key,options);}});
 for(const [range,count,hours]of [['1D',25,1],['7D',168,1],['30D',31,24],['90D',91,24],['1Y',366,24]]){
  state.assetRange=range;charts.length=0;const html=render(asset),options=charts[0];
  assert.match(html,/data-chart="dc-asset-price-US10Y" data-chart-kind="line"/);assert.match(html,/收益率走势|Yield chart/);
  assert.equal(options.kind,'line');assert.equal(options.bars,undefined);assert.equal(options.unit,'%');assert.equal(options.period,hours===1?'1H':'1D');
  assert.equal(options.values.length,count);assert.equal(options.values.at(-1),4.2);assert.ok(options.values.every(Number.isFinite));
  assert.equal(options.labels.length,count);assert.equal(options.labels.at(-1),Date.UTC(2026,9,24,6));assert.equal(options.labels[1]-options.labels[0],hours*3600000);
  if(hours===1)assert.deepEqual(options.values,asset.series.slice(-count));
  assert.match(html,/模拟数据/);assert.match(html,/短周期取自同一行情样本；30天及更长区间为扩展模拟序列/);
 }
 assert.equal(JSON.stringify(asset),before);
 for(const symbol of ['BTC','ETH']){
  charts.length=0;const html=render(MARKET.find(a=>a.symbol===symbol));
  assert.match(html,new RegExp('data-chart="dc-asset-price-'+symbol+'" data-chart-kind="candle"'));
  assert.equal(charts[0].bars.at(-1).close,symbol==='BTC'?81230:3180);assert.equal(charts[0].unit,'USDT');
 }
});

test('economic calendar keeps recorded dates, missing actuals and related assets across date changes',t=>{
 const previous={location:globalThis.location,document:globalThis.document};
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.location=new URL('http://localhost/?page=intelligence&data=demo');globalThis.document={addEventListener(){},hidden:true,body:{},activeElement:null};
 let focused=0;const day={dataset:{dcFilter:'day',value:'25'},focus(options){focused++;assert.equal(options.preventScroll,true);}},root={scrollTop:0,querySelector:s=>s==='[data-dc-filter="day"][data-value="'+day.dataset.value+'"]'?day:null,querySelectorAll:s=>s==='[data-dc-filter]'?[day]:[]};
 const ui=createDataCenter({root,rerender(){},notify(){},onResearch(){}}),calendar=html=>html.slice(html.indexOf('df-economic-calendar'),html.indexOf('df-news-tools'));
 let html=ui.render('intelligence'),part=calendar(html);assert.match(html,/固定历史样本|Fixed historical sample/);assert.doesNotMatch(html,/data-dc-refresh|data-dc-interval/);assert.ok(html.indexOf('df-economic-calendar')<html.indexOf('df-news-tools'));assert.equal((part.match(/data-dc-filter="day"/g)||[]).length,7);assert.equal((part.match(/aria-pressed="true"/g)||[]).length,1);assert.match(part,/10月24日|October 24/);assert.match(part,/2 项事件|2 events/);assert.match(part,/df-impact-bars/);assert.equal((part.match(/class="df-economic-event"/g)||[]).length,2);assert.match(part,/2026 年 10 月|October 2026/);assert.match(part,/2026-10-24T20:30:00\+08:00/);assert.match(part,/公布值<\/dt><dd>—|Actual<\/dt><dd>—/);assert.doesNotMatch(part,/Today|尚未公布|Pending|undefined|NaN/);
 ui.bind();day.onclick();assert.equal(focused,1);part=calendar(ui.render('intelligence'));assert.equal((part.match(/class="df-economic-event"/g)||[]).length,1);assert.match(part,/利率决议|Rate decision/);assert.match(part,/2026-10-25T02:00:00\+08:00/);assert.match(part,/asset=BTC/);assert.doesNotMatch(part,/消费者信心|Consumer confidence/);
 day.dataset.value='27';day.onclick();assert.equal(focused,2);part=calendar(ui.render('intelligence'));assert.match(part,/当前日期暂无事件记录|No event records for this date/);assert.doesNotMatch(part,/class="df-economic-event"/);assert.match(part,/data-value="27" aria-pressed="true"/);assert.match(calendar(ui.render('intelligence')),/data-value="27" aria-pressed="true"/);assert.equal(focused,2);
});
