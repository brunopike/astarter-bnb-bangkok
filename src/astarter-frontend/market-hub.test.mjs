import test from 'node:test';
import assert from 'node:assert/strict';
import {WATCH_ASSETS_KEY} from './market-watchlist.mjs';
import {HUB_RESOURCES,HUB_SYMBOLS,normalizeHubResource,normalizeHubTicker,hubSeriesChange,hubQuality,hubRetryDelay,createMarketHubClient} from './market-hub-data.mjs';
import {hubOwnsRoute,hubMoney,hubFeedRows,createMarketHub,hubCandleIdentity} from './market-hub.mjs';
import {hubPerformanceSeries,hubMarketShares,hubChartOption,applyHubGaugeLight} from './market-hub-charts.mjs';
import {approvedTokenImageURL,approvedVenueImageURL,venueIcon} from './brand-icons.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {getLocale,initLocale} from './locale.mjs';

const NOW=Date.UTC(2026,10,4,12);
// Selects the app language the way the language picker does (locale.mjs initLocale().set), on a throwaway page, so a view renders in that language.
async function selectAppLanguage(id){
 const keys=['document','MutationObserver','NodeFilter','localStorage'],prior=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
 const page=Object.assign(new EventTarget(),{body:{nodeType:1,querySelectorAll:()=>[]},documentElement:{dataset:{},style:{setProperty(){}}},createTreeWalker:()=>({nextNode:()=>null}),querySelector:()=>null,querySelectorAll:()=>[]});
 const values={document:page,MutationObserver:class{observe(){}disconnect(){}},NodeFilter:{SHOW_TEXT:4},localStorage:{getItem:()=>null,setItem(){}}};
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:values[key]});
 try{await initLocale().set(id);}finally{keys.forEach((key,i)=>prior[i]?Object.defineProperty(globalThis,key,prior[i]):delete globalThis[key]);}
 assert.equal(getLocale(),id);
}
test('market resource names in the source footer and the source hints use the selected language; DeFi TVL stays a proper name',async()=>{
 const names={global:'Global market',assets:'Asset snapshots',tickers:'Spot polling snapshot',categories:'Sectors',exchanges:'Trading venues',chains:'Chain TVL',stablecoins:'Stablecoins',tvl:'DeFi TVL',sentiment:'Market sentiment'};
 const old=globalThis.location,before=getLocale();let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets');
  const values=Object.fromEntries(Object.entries(fixtures).map(([key,raw])=>[key,normalizeHubResource(key,raw,NOW).data]));
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
  hub.client.read=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:values[key]}});
  assert.deepEqual(Object.keys(names),Object.keys(HUB_RESOURCES));
  for(const id of ['ja','ko','vi','es','fr','ru']){
   await selectAppLanguage(id);
   const pack=(await import(`./locales/${id}.mjs`)).default,html=hub.render('markets');
   const footer=html.match(/<footer class="hub-source-footer">[\s\S]*?<\/footer>/)?.[0];assert.ok(footer,id);
   // The footer lists every resource as "provider · name" (market-hub.mjs sourceDetails).
   assert.deepEqual([...footer.matchAll(/<section><b>([^<]*)<\/b>/g)].map(match=>match[1]),Object.entries(names).map(([key,en])=>HUB_RESOURCES[key].provider+' · '+(key==='tvl'?en:pack[en])),id);
   // The panel hints are labelled "name · Source and time" (market-hub.mjs source()).
   const hints=[...html.matchAll(/<details class="dc-info hub-source[^"]*"><summary aria-label="([^"]*)"/g)].map(match=>match[1]);
   assert.ok(hints.length>0,id);
   for(const hint of hints){
    assert.ok(hint.endsWith(' · '+pack['Source and time']),id+': '+hint);
    for(const [key,en]of Object.entries(names))if(key!=='tvl')assert.ok(!hint.includes(en),id+': '+hint);
   }
  }
 }finally{await selectAppLanguage(before);hub?.client.dispose();if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});
test('the browser reads the BTC daily sentiment index through the same-origin relay and preserves its original clock',async t=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
 t.after(()=>{if(old)Object.defineProperty(globalThis,'window',old);else delete globalThis.window;});
 const calls=[],sourceAt=NOW-12*3600000,receivedAt=NOW-1000;
 const client=createMarketHubClient({resources:['sentiment'],WebSocketImpl:null,storageImpl:null,now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>JSON.stringify({schema:'public-market-relay-v1',resource:'sentiment',receivedAt,body:{data:[{value:'12',timestamp:String(sourceAt/1000)}]}})};}});t.after(()=>client.dispose());
 client.setActive(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/market-hub?resource=sentiment');assert.equal(calls[0].options.credentials,'omit');
 assert.equal(client.read('sentiment').snapshot.asOf,sourceAt);assert.equal(client.read('sentiment').snapshot.receivedAt,receivedAt);assert.equal(client.read('sentiment').snapshot.data[0].value,12);
});
test('live candles require the canonical asset identity and never borrow a same-symbol token market',()=>{
 assert.deepEqual(hubCandleIdentity({id:'bitcoin',symbol:'BTC'}),{market:'BTC/USDT',venueId:'binance',profileId:'cex-spot'});
 for(const asset of [null,{id:'impostor',symbol:'BTC'},{id:'bitcoin',symbol:'BTC',address:'0x1234'},{id:'bitcoin',symbol:'btc'},{id:'gold',symbol:'XAU'},{id:'constructor',symbol:'constructor'}])assert.equal(hubCandleIdentity(asset),null);
});
const coin=(id='bitcoin',symbol='btc')=>({id,symbol,name:'Bitcoin',current_price:100,market_cap:1000,total_volume:200,price_change_percentage_24h:2,price_change_percentage_7d_in_currency:4,last_updated:new Date(NOW).toISOString(),sparkline_in_7d:{price:[98,99,100]}});
const ticker=(at=NOW,price='101')=>({symbol:'BTCUSDT',lastPrice:price,openPrice:'100',quoteVolume:'200',closeTime:at});
const fixtures={
 global:{data:{total_market_cap:{usd:1000},total_volume:{usd:200},market_cap_percentage:{btc:55},market_cap_change_percentage_24h_usd:2,updated_at:NOW/1000}},
 assets:[coin()],tickers:[ticker()],
 categories:[{id:'layer-1',name:'Layer 1',market_cap:1000,market_cap_change_24h:2,updated_at:new Date(NOW).toISOString()}],
 exchanges:[{id:'binance',name:'Binance',trade_volume_24h_btc:123,trust_score_rank:1}],
 chains:[{name:'Ethereum',tvl:500,tokenSymbol:'ETH'}],
 stablecoins:[{date:NOW/1000,totalCirculatingUSD:{peggedUSD:100,peggedEUR:20},totalCirculating:{peggedUSD:1,peggedEUR:1}}],
 tvl:[{date:NOW/1000,tvl:1000}],sentiment:{data:[{timestamp:String(NOW/1000),value:'51'}]}
};
const response=(body,status=200,retry=null)=>({ok:status===200,status,headers:{get:key=>key==='Retry-After'?retry:null},text:async()=>JSON.stringify(body)});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness({fetchImpl,websocket=true,storageImpl,startAt=NOW}={}){
 let at=startAt;const calls=[],sockets=[];
 class Socket{constructor(url){this.url=url;this.closed=false;sockets.push(this);}close(){this.closed=true;this.onclose?.();}send(price,stamp=at){this.onmessage?.({data:JSON.stringify({data:{s:'BTCUSDT',c:String(price),o:'100',q:'200',E:stamp}})});}}
 const client=createMarketHubClient({now:()=>at,storageImpl,WebSocketImpl:websocket?Socket:null,fetchImpl:async(url,options)=>{const key=Object.keys(HUB_RESOURCES).find(key=>HUB_RESOURCES[key].url===url);calls.push({key,options});return fetchImpl?fetchImpl(key,options):response(key==='tickers'?[ticker(at)]:fixtures[key]);}});
 return {client,calls,sockets,advance(ms){at+=ms;client.tick();},get now(){return at;}};
}

test('public resources validate their fields and preserve source time separately from retrieval time',()=>{
 for(const [key,value]of Object.entries(fixtures)){
  const s=normalizeHubResource(key,value,NOW+1000);assert.equal(s.receivedAt,NOW+1000);assert.equal(s.asOf,['chains','exchanges'].includes(key)?null:NOW);
 }
 assert.equal(normalizeHubResource('stablecoins',fixtures.stablecoins,NOW).data[0].value,120);
 assert.equal(normalizeHubResource('exchanges',fixtures.exchanges,NOW).data[0].volume,123);
 const categories=[...fixtures.categories,{id:'unused-old-sector',name:'Old sector',market_cap:1,market_cap_change_24h:2,updated_at:'2020-01-01T00:00:00Z'}];assert.equal(normalizeHubResource('categories',categories,NOW).asOf,NOW);
 assert.throws(()=>normalizeHubResource('global',{data:{total_market_cap:{usd:0}}},NOW),/INVALID_DATA/);
 assert.throws(()=>normalizeHubResource('assets',[{...coin(),symbol:'BTC" onclick="x'}],NOW),/INVALID_DATA/);
 assert.throws(()=>normalizeHubResource('assets',[coin(),coin()],NOW),/INVALID_DATA/);
 assert.throws(()=>normalizeHubResource('sentiment',{data:[{timestamp:NOW/1000,value:''}]},NOW),/INVALID_DATA/);
 assert.throws(()=>normalizeHubResource('tvl',[{date:NOW/1000,tvl:1},{date:NOW/1000,tvl:2}],NOW),/INVALID_DATA/);
});

test('series changes use the requested calendar interval and missing history stays missing',()=>{
 const rows=[{at:NOW-7*86400000,value:100},{at:NOW,value:120}];
 assert.deepEqual(hubSeriesChange(rows,7),{delta:20,percent:(120/100-1)*100});assert.equal(hubSeriesChange(rows,30),null);
 assert.equal(hubSeriesChange([{at:NOW-86400000,value:0},rows[1]],1),null);
 assert.equal(hubQuality({asOf:NOW-301000,receivedAt:NOW},HUB_RESOURCES.assets,NOW),'stale');
 assert.equal(hubQuality(null,HUB_RESOURCES.assets,NOW,'FETCH_FAILED'),'unavailable');
 assert.equal(hubQuality({asOf:NOW,receivedAt:NOW},HUB_RESOURCES.assets,NOW,'FETCH_FAILED'),'stale');
});

test('comparison rebases real hourly samples on one shared window without borrowing live prices or symbol impostors',()=>{
 const rows=hubPerformanceSeries([{id:'bitcoin',series:[50,100,110,120],price:999},{id:'ethereum',series:[200,180,210]},{id:'fake-solana',symbol:'SOL',series:[1,9]}]);
 assert.equal(rows.length,2);assert.deepEqual(rows[0].values,[[-2,0],[-1,(110/100-1)*100],[0,(120/100-1)*100]]);
 assert.equal(rows[1].values[0][1],0);assert.equal(rows[1].values.at(-1)[1],(210/200-1)*100);
 assert.equal(hubPerformanceSeries([{id:'solana',series:[1,NaN,3]}]).length,0);
 const long=[{id:'bitcoin',series:Array.from({length:168},(_,i)=>100+i)}];
 assert.equal(hubPerformanceSeries(long,'24h')[0].values.length,25);assert.equal(hubPerformanceSeries(long,'24h')[0].values[0][0],-24);
 assert.equal(hubPerformanceSeries(long,'7d')[0].values.length,168);assert.equal(hubPerformanceSeries([]).length,0);
});

test('an invalid hourly point never compresses time or shortens a different assets comparison window',()=>{
 const rows=normalizeHubResource('assets',[{...coin(),sparkline_in_7d:{price:[100,null,121]}},{...coin('ethereum','eth'),sparkline_in_7d:{price:[200,210,220]}}],NOW).data;
 assert.deepEqual(rows[0].series,[]);
 const comparison=hubPerformanceSeries(rows);assert.equal(comparison.length,1);assert.equal(comparison[0].symbol,'ETH');assert.equal(comparison[0].values[0][0],-2);assert.equal(comparison[0].values.at(-1)[1],(220/200-1)*100);
});

test('global share charts total 100%, reject impossible shares and do not invent missing ETH data',()=>{
 assert.deepEqual(hubMarketShares({btcShare:60,ethShare:12}).map(r=>r.value),[60,12,28]);
 assert.deepEqual(hubMarketShares({btcShare:60}).map(r=>r.value),[60,40]);
 assert.equal(hubMarketShares({btcShare:90,ethShare:20}).length,0);assert.equal(hubMarketShares({btcShare:-1}).length,0);assert.equal(hubMarketShares(null).length,0);
 const raw=structuredClone(fixtures.global);raw.data.market_cap_percentage.eth=12;
 assert.equal(normalizeHubResource('global',raw,NOW).data.ethShare,12);assert.equal(normalizeHubResource('global',fixtures.global,NOW).data.ethShare,null);
});

test('chart axes keep relative change and daily sentiment on their proper units and preserve hidden series',()=>{
 const p={ink:'#111',muted:'#888',line:'#ddd',panel:'#fff',font:'sans-serif',series:['#04f','#f80','#a5f'],up:'#0a7',down:'#d43',gold:'#fa3',spectrum:['#f43','#f82','#fd4','#4e7','#3cf','#46f','#a4f']};
 const rows=hubPerformanceSeries([{id:'bitcoin',series:[10,12]},{id:'ethereum',series:[10,9]}]);
 const option=hubChartOption('performance',{rows,hidden:new Set(['ETH'])},p);
 assert.equal(option.series.length,1);assert.equal(option.series[0].name,'BTC');assert.equal(option.xAxis.max,0);assert.equal(option.yAxis.axisLabel.formatter(5),'5%');assert.equal(option.animation,false);
 assert.equal(option.dataZoom[0].zoomOnMouseWheel,'ctrl');assert.equal(option.dataZoom[0].moveOnMouseWheel,false);assert.equal(option.xAxis.minInterval,1);assert.equal(option.tooltip.axisPointer.type,'line');
 const sentiment=hubChartOption('sentiment',[{at:NOW,value:34}],p);assert.equal(sentiment.series[0].data[0].value,34);assert.equal(sentiment.yAxis.min,0);assert.equal(sentiment.yAxis.max,100);assert.equal(sentiment.series[1].data[0][0],NOW);
 assert.match(sentiment.tooltip.formatter({seriesType:'line',value:[NOW,34]}),/34 \/ 100/);assert.equal(sentiment.series[1].silent,undefined);
});

test('comparison tooltip stays at one height and inside desktop and narrow charts while inspecting a sample',()=>{
 const p={ink:'#fff',muted:'#888',line:'#333',panel:'#111',font:'sans-serif',series:['#3df','#46f','#a4f']};
 const rows=hubPerformanceSeries([{id:'bitcoin',series:[10,12]}]),option=hubChartOption('performance',{rows,hidden:new Set()},p);
 assert.equal(typeof option.tooltip.position,'function','hover tooltip needs a stable position instead of following pointer height');
 for(const width of [288,560]){
  const size={viewSize:[width,214],contentSize:[156,112]},position=point=>option.tooltip.position(point,null,null,null,size);
  assert.deepEqual(position([60,30]),position([90,180]),'same side does not jump with pointer height');
  for(const point of [[1,5],[width-1,210]]){
   const [x,y]=position(point);assert.ok(x>=0&&x+156<=width);assert.ok(y>=0&&y+112<=214);
  }
 }
});

test('comparison hover reads sample percentages without a free cursor value or dimming other assets',()=>{
 const p={ink:'#fff',muted:'#888',line:'#333',panel:'#111',font:'sans-serif',series:['#3df','#46f','#a4f']};
 const rows=hubPerformanceSeries([{id:'bitcoin',series:[10,12]},{id:'ethereum',series:[10,9]}]),model={rows,hidden:new Set()},copy=structuredClone(rows),option=hubChartOption('performance',model,p);
 const text=option.tooltip.formatter([{seriesName:'BTC',value:[-134,-.63]},{seriesName:'ETH',value:[-134,.08]}]);
 assert.match(text,/134h/);assert.match(text,/BTC/);assert.match(text,/-0\.63%/);assert.match(text,/ETH/);assert.match(text,/\+0\.08%/);
 assert.equal(option.tooltip.axisPointer.type,'line','only the sample time is tracked');
 assert.ok(option.series.every(series=>series.emphasis.disabled),'crossing a line must not dim other comparison lines');
 assert.deepEqual(rows,copy);
});

test('spectrum light reaches all native gauge arcs without styling the needle, labels or changing the data series',async()=>{
 const {init}=await import('echarts');
 const p={ink:'#fff',muted:'#888',line:'#333',panel:'#111',font:'sans-serif',series:['#3df','#46f','#a4f'],up:'#4e7',down:'#f43',gold:'#fd4',dark:true,spectrum:['#ff4b3e','#ff9a2b','#ffd84d','#4dff7a','#3dd5ff','#4a6bff','#a24dff']};
 const rows=[{at:NOW-86400000,value:20},{at:NOW,value:34}],copy=structuredClone(rows),option=hubChartOption('sentiment',rows,p);
 assert.equal(option.series.length,2);assert.equal(option.series[0].data[0].value,34);assert.deepEqual(option.series[1].data,rows.map(r=>[r.at,r.value]));
 assert.deepEqual(option.series[0].axisLine.lineStyle.color.map(b=>b[1]),p.spectrum);
 assert.equal(option.animation,false);assert.equal(option.series[1].silent,undefined);
 const chart=init(null,null,{renderer:'svg',ssr:true,width:320,height:230});
 try{
  chart.setOption(option);const svg=chart.renderToSVGString();
  const paths=[...svg.matchAll(/<path\b[^>]*>/g)].map(([tag])=>({
   getAttribute:name=>tag.match(new RegExp('\\b'+name+'="([^"]*)"'))?.[1]??null,
   classes:new Set(),properties:new Map(),
   get classList(){return {add:name=>this.classes.add(name)};},get style(){return {setProperty:(name,value)=>this.properties.set(name,value)};},
  }));
  applyHubGaugeLight({querySelectorAll:()=>paths},p.spectrum);
  const arcs=paths.filter(path=>path.classes.has('hub-gauge-band'));
  assert.equal(arcs.length,7);assert.deepEqual(new Set(arcs.map(path=>path.properties.get('--gauge-color'))),new Set(p.spectrum));
  assert.ok(paths.some(path=>!path.classes.size));assert.deepEqual(rows,copy);
 }finally{chart.dispose();}
});

test('stream quotes only accept bounded known spot pairs, finite prices and source timestamps',()=>{
 assert.equal(normalizeHubTicker(ticker(),NOW).quote,'USDT');
 for(const bad of [{...ticker(),symbol:'BTCUSD'},{...ticker(),symbol:'UNKNOWNUSDT'},{...ticker(),lastPrice:'NaN'},{...ticker(),lastPrice:'0'},{...ticker(),closeTime:NOW+31000}])assert.equal(normalizeHubTicker(bad,NOW),null);
 assert.equal(HUB_SYMBOLS.length,20);
});

test('Retry-After accepts seconds or HTTP dates and bounds pathological delays',()=>{
 assert.equal(hubRetryDelay('120',NOW),120000);assert.equal(hubRetryDelay(new Date(NOW+60000).toUTCString(),NOW),60000);
 assert.equal(hubRetryDelay('99999999',NOW),86400000);assert.equal(hubRetryDelay('bad',NOW),0);assert.equal(hubRetryDelay(null,NOW),0);
});

test('client refreshes public snapshots without sending credentials, creating orders or fabricating change events',async()=>{
 const h=harness();try{h.client.setActive(true);await settle();assert.equal(h.calls.length,9);assert.equal(h.client.read('assets').quality,'fresh');assert.equal(h.client.events.length,0);assert.equal(h.sockets.length,1);assert.ok(h.sockets[0].url.includes('btcusdt@miniTicker'));
 for(const {options}of h.calls){assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.ok(options.signal);}
 h.advance(20000);await settle();assert.equal(h.client.events.length,0);
 }finally{h.client.dispose();}
});

test('same-symbol impostors never inherit venue prices; stale venue quotes fall back to USD',async()=>{
 const h=harness();try{h.client.setActive(true);await settle();const a=normalizeHubResource('assets',[coin()],NOW).data[0];
 assert.equal(h.client.quote(a).price,101);assert.equal(h.client.quote(a).quote,'USDT');
 assert.equal(h.client.quote({...a,id:'another-bitcoin'}).price,100);assert.equal(h.client.quote({...a,id:'another-bitcoin'}).quote,'USD');
 h.client.setActive(false);h.advance(31000);assert.equal(h.client.quote(a).quote,'USDT');h.client.setActive(true);assert.equal(h.client.quote(a).provider,'CoinGecko');assert.equal(h.client.quote(a).asOf,NOW);
 }finally{h.client.dispose();}
});

test('websocket updates and feed items come from changed source prices, ignoring older and duplicate frames',async()=>{
 const h=harness();try{h.client.setActive(true);await settle();const socket=h.sockets[0],a=normalizeHubResource('assets',[coin()],NOW).data[0];
 socket.send(102,NOW+1000);assert.equal(h.client.stream,'live');assert.equal(h.client.quote(a).price,102);assert.equal(h.client.events.length,1);
 socket.send(99,NOW-1000);socket.send(102,NOW+1000);assert.equal(h.client.quote(a).price,102);assert.equal(h.client.events.length,1);
 for(let n=0;n<20;n++)socket.send(103+n,NOW+1000+n);assert.equal(h.client.events.length,8);
 h.client.setActive(false);socket.send(999,NOW+2000);assert.notEqual(h.client.quote(a).price,999);assert.equal(socket.closed,true);
 }finally{h.client.dispose();}
});

test('leaving the page aborts pending requests and late responses cannot replace newer snapshots',async()=>{
 let finish;const h=harness({websocket:false,fetchImpl:(key,options)=>key==='assets'?new Promise(resolve=>{finish=()=>resolve(response([coin()]));}):response(fixtures[key])});
 try{h.client.setActive(true);await settle();const pending=h.calls.find(c=>c.key==='assets');h.client.setActive(false);assert.equal(pending.options.signal.aborted,true);finish();await settle();assert.equal(h.client.read('assets').snapshot,null);assert.equal(h.client.read('assets').pending,false);
 }finally{h.client.dispose();}
});

test('a late rate-limit response from the previous visit cannot alter a fresh visit retry deadline',async()=>{
 let finish,attempt=0;const h=harness({websocket:false,fetchImpl:key=>key==='assets'&&++attempt===1?new Promise(resolve=>{finish=()=>resolve(response({},429,'3600'));}):response(fixtures[key])});
 try{h.client.setActive(true);await settle();h.client.setActive(false);h.client.setActive(true);await settle();assert.equal(h.client.read('assets').quality,'fresh');finish();await settle();assert.equal(h.client.read('assets').retryIn,0);}
 finally{h.client.dispose();}
});

test('liquidity keeps a valid single point visible and uses one readout when history exists',()=>{
 const old=globalThis.location;let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets');
  const values=Object.fromEntries(Object.entries(fixtures).map(([key,raw])=>[key,normalizeHubResource(key,raw,NOW).data]));
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
  hub.client.read=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:values[key]}});
  const single=hub.render('markets');
  assert.ok(single.includes('<strong>'+hubMoney(120)+'</strong>'),'single stablecoin value remains visible');
  assert.ok(single.includes('<strong>'+hubMoney(1000)+'</strong>'),'single TVL value remains visible');
  values.stablecoins=[{at:NOW-86400000,value:100},{at:NOW,value:120}];
  values.tvl=[{at:NOW-86400000,value:900},{at:NOW,value:1000}];
  const withHistory=hub.render('markets');
  assert.ok(withHistory.includes('data-chart="hub-stable"'));assert.ok(withHistory.includes('data-chart="hub-tvl"'));
  assert.ok(!withHistory.includes('class="hub-chart-value"><strong>'),'historical chart owns the primary value');
 }finally{hub?.client.dispose();if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});

test('asset rendering passes the full identity to the shared dynamic icon resolver',async()=>{
 const oldLocation=globalThis.location,oldFetch=globalThis.fetch,oldSocket=globalThis.WebSocket;
 const logo='https://coin-images.coingecko.com/coins/images/999999/small/logo-proof.png';let hub;
 try{globalThis.location=new URL('http://localhost/?page=markets&asset=ZQA');globalThis.WebSocket=undefined;globalThis.fetch=async url=>{const key=Object.keys(HUB_RESOURCES).find(key=>HUB_RESOURCES[key].url===url);return response(key==='assets'?[{...coin('logo-proof','zqa'),image:logo}]:fixtures[key]);};
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});hub.client.setActive(true);await settle();assert.ok(hub.render('markets').includes(logo));assert.match(hub.sourceSnapshot().text,/ZQA: 100 USD/);
  globalThis.location=new URL('http://localhost/?page=markets&asset=UNKNOWN&coin=unknown');hub.render('markets');assert.equal(hub.sourceSnapshot().text,'');assert.match(hub.companionBrief().title,/UNKNOWN/);assert.ok(!hub.companionBrief().title.includes('100'));
 }finally{hub?.client.dispose();globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;if(oldLocation)globalThis.location=oldLocation;else delete globalThis.location;}
});

test('the source pane flags an old source timestamp even when its latest fetch succeeded',async t=>{
 const saved={location:globalThis.location,fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};let hub;
 t.mock.method(Date,'now',()=>NOW+60000);
 try{
  globalThis.location=new URL('http://localhost/?page=markets');globalThis.WebSocket=undefined;
  globalThis.fetch=async url=>response(fixtures[Object.keys(HUB_RESOURCES).find(key=>HUB_RESOURCES[key].url===url)]);
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});hub.client.setActive(true);await settle();
  assert.equal(hub.client.read('tickers').quality,'stale');assert.equal(hub.client.read('tickers').error,null);
  const section=hub.render('markets').match(/<section><b>Binance Spot[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);assert.match(section,/较早数据|Older data/);assert.doesNotMatch(section,/自动更新|Auto updates/);
 }finally{hub?.client.dispose();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('the compact source footer keeps visible attribution and full provider timestamps',()=>{
 const old=globalThis.location;let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets');
  const values=Object.fromEntries(Object.entries(fixtures).map(([key,raw])=>[key,normalizeHubResource(key,raw,NOW).data]));
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
  hub.client.read=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:values[key]}});
  const before=JSON.stringify(values),footer=hub.render('markets').match(/<footer class="hub-source-footer">[\s\S]*?<\/footer>/)?.[0];
  assert.ok(footer);assert.match(footer,/<summary>(?:数据来源|Data sources)<\/summary>/);
  assert.match(footer,/<\/details><a class="hub-credit" href="https:\/\/www.coingecko.com\/en\/api"[^>]*>Powered by CoinGecko API ↗<\/a>/);
  assert.match(footer,/Binance Spot/);assert.match(footer,/CoinGecko/);assert.match(footer,/2026-11-04 20:00:00 UTC\+8/);
  assert.equal(JSON.stringify(values),before);
 }finally{hub?.client.dispose();if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});

test('requests do not overlap; rate limits retain last good data and manual refresh cannot bypass backoff',async()=>{
 let fail=false;const h=harness({websocket:false,fetchImpl:key=>key==='assets'&&fail?response({},429,new Date(NOW+180000).toUTCString()):response(fixtures[key])});
 try{h.client.setActive(true);h.client.tick();await settle();assert.equal(h.calls.filter(c=>c.key==='assets').length,1);fail=true;h.advance(60000);await settle();
 assert.equal(h.client.read('assets').error,'RATE_LIMIT');assert.equal(h.client.read('assets').snapshot.data[0].price,100);assert.equal(h.client.read('assets').quality,'stale');
 const count=h.calls.filter(c=>c.key==='assets').length;h.client.refresh();await settle();assert.equal(h.calls.filter(c=>c.key==='assets').length,count);assert.equal(h.client.read('assets').retryIn,120);assert.ok(h.calls.every(c=>c.key!==undefined));
 }finally{h.client.dispose();}
});
test('a failed public read cancels its unread body, even when cancelling fails, and keeps the error and backoff',async()=>{
 for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  let cancels=0;const h=harness({websocket:false,storageImpl:null,fetchImpl:key=>key==='assets'?{...response({},503),body:{cancel(){cancels++;return cancel();}},text:async()=>{throw Error('must not read error');}}:response(fixtures[key])});
  try{h.client.setActive(true);await settle();const assets=h.client.read('assets');
   assert.equal(cancels,1);assert.equal(assets.error,'FETCH_FAILED');assert.equal(assets.detail,'HTTP 503');assert.equal(assets.snapshot,null);assert.equal(assets.retryIn,15);
  }finally{h.client.dispose();}
 }
});

test('a browser transport failure can use the fixed same-origin relay while retaining the upstream fetch time',async()=>{
 const calls=[],upstream={...fixtures.global,data:{...fixtures.global.data,updated_at:(NOW-60000)/1000}};
 const client=createMarketHubClient({now:()=>NOW,WebSocketImpl:null,storageImpl:null,fetchImpl:async(url,options)=>{
  calls.push({url,options});if(url===HUB_RESOURCES.global.url)throw new TypeError('Failed to fetch');
  if(url==='/api/market-hub?resource=global')return response({schema:'public-market-relay-v1',resource:'global',receivedAt:NOW-1000,body:upstream});
  return response(fixtures[Object.keys(HUB_RESOURCES).find(k=>HUB_RESOURCES[k].url===url)]);
 }});
 try{client.setActive(true);await settle();assert.equal(client.read('global').snapshot.data.cap,1000);assert.equal(client.read('global').snapshot.receivedAt,NOW-1000);assert.equal(client.read('global').snapshot.asOf,NOW-60000);assert.equal(calls.filter(c=>c.url.startsWith('/api/')).length,1);assert.equal(calls.find(c=>c.url.startsWith('/api/')).options.credentials,'omit');}
 finally{client.dispose();}
});

function browserWindow(t){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
}
test('browser tickers use the same-origin route and retain the relay cache time and fixed twenty-asset scope',async t=>{
 browserWindow(t);let at=NOW;const upstream=[],calls=[],rows=HUB_SYMBOLS.map(symbol=>({...ticker(NOW-1000),symbol:symbol+'USDT'}));
 const relay=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{upstream.push({url,options});return response(rows);}});
 const client=createMarketHubClient({resources:['tickers'],now:()=>at,WebSocketImpl:null,storageImpl:null,fetchImpl:async(url,options)=>{
  calls.push({url,options});assert.equal(url,'/api/market-hub?resource=tickers');const result={};
  assert.equal(await relay({url,method:'GET'},{writeHead(status,headers){result.status=status;result.headers=headers;},end(raw){result.body=JSON.parse(raw);}}),true);
  return response(result.body,result.status,result.headers['Retry-After']);
 }});t.after(()=>client.dispose());
 client.setActive(true);await settle();const first=client.read('tickers');
 assert.equal(first.error,null);assert.equal(first.snapshot.data.length,20);assert.equal(first.snapshot.asOf,NOW-1000);assert.equal(first.snapshot.receivedAt,NOW);
 assert.equal(client.quote({symbol:'BTC',id:'bitcoin'}).provider,'Binance Spot');assert.equal(client.quote({symbol:'BTC',id:'bitcoin'}).quote,'USDT');
 assert.equal(upstream.length,1);assert.equal(upstream[0].url,HUB_RESOURCES.tickers.url);
 assert.deepEqual(JSON.parse(new URL(upstream[0].url).searchParams.get('symbols')),HUB_SYMBOLS.map(symbol=>symbol+'USDT'));
 at+=1000;await client.refresh();assert.equal(calls.length,2);assert.equal(upstream.length,1);assert.equal(client.read('tickers').snapshot.receivedAt,NOW);assert.equal(client.read('tickers').snapshot.asOf,NOW-1000);
 for(const {options}of [...calls,...upstream]){assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{Accept:'application/json'});}
});

test('browser ticker rate limits keep the last source sample and cannot fall through to a direct request or bypass backoff',async t=>{
 browserWindow(t);let at=NOW;const calls=[];
 const client=createMarketHubClient({resources:['tickers'],now:()=>at,WebSocketImpl:null,storageImpl:null,fetchImpl:async url=>{
  calls.push(url);assert.equal(url,'/api/market-hub?resource=tickers');return calls.length===1?response({schema:'public-market-relay-v1',resource:'tickers',receivedAt:NOW,body:[ticker()]}):response({},429,'120');
 }});t.after(()=>client.dispose());
 client.setActive(true);await settle();assert.equal(client.read('tickers').snapshot.data[0].price,101);
 at+=31000;await client.refresh();assert.equal(client.read('tickers').error,'RATE_LIMIT');assert.equal(client.read('tickers').quality,'stale');assert.equal(client.read('tickers').snapshot.receivedAt,NOW);
 at+=16000;await client.refresh();assert.equal(calls.length,2);assert.equal(client.read('tickers').retryIn,104);assert.equal(client.read('tickers').snapshot.data[0].price,101);
});

test('Node ticker success and failure keep the existing fixed direct fetch without an implicit relative relay',async()=>{
 for(const broken of [false,true]){
  const calls=[],client=createMarketHubClient({resources:['tickers'],now:()=>NOW,WebSocketImpl:null,storageImpl:null,fetchImpl:async(url,options)=>{calls.push({url,options});if(broken)throw new TypeError('offline public source');return response([ticker()]);}});
  try{client.setActive(true);await settle();assert.deepEqual(calls.map(call=>call.url),[HUB_RESOURCES.tickers.url]);assert.equal(calls[0].options.credentials,'omit');assert.equal(client.read('tickers').error,broken?'FETCH_FAILED':null);assert.equal(client.read('tickers').snapshot?.data[0].price,broken?undefined:101);}
  finally{client.dispose();}
 }
});

test('a silent or broken stream falls back to public polling instead of retaining a live label',async()=>{
 const h=harness();try{h.client.setActive(true);await settle();h.sockets[0].send(102);assert.equal(h.client.stream,'live');h.advance(21000);await settle();assert.equal(h.client.stream,'polling');assert.equal(h.sockets[0].closed,true);
 }finally{h.client.dispose();}
});

test('an arriving old websocket frame cannot create a live label or a change event',async()=>{
 const h=harness();try{h.client.setActive(true);await settle();h.sockets[0].send(999,NOW-60000);assert.notEqual(h.client.stream,'live');assert.equal(h.client.events.length,0);}
 finally{h.client.dispose();}
});

test('cached public reads load immediately and keep the original source and retrieval times after a failed refresh',async()=>{
 const entries=new Map(),storage={getItem:key=>entries.get(key),setItem:(key,value)=>entries.set(key,value)};
 const first=harness({storageImpl:storage,websocket:false});first.client.setActive(true);await settle();first.client.dispose();assert.equal(entries.size,9);
 const next=harness({storageImpl:storage,startAt:NOW+600000,websocket:false,fetchImpl:async()=>{throw new TypeError('offline');}});
 try{const cached=next.client.read('assets');assert.equal(cached.snapshot.receivedAt,NOW);assert.equal(cached.snapshot.asOf,NOW);assert.equal(cached.fromCache,true);assert.equal(cached.quality,'stale');next.client.setActive(true);await settle();assert.equal(next.client.read('assets').snapshot.data[0].price,100);assert.equal(next.client.read('assets').snapshot.receivedAt,NOW);assert.equal(next.client.events.length,0);}
 finally{next.client.dispose();}
});

test('wrong-resource, expired or corrupt cache entries are ignored and full storage never blocks fresh reads',async()=>{
 for(const cached of [{schema:1,url:'https://evil.example',receivedAt:NOW,body:fixtures.assets},{schema:1,url:HUB_RESOURCES.assets.url,receivedAt:NOW-3*3600000,body:fixtures.assets},{schema:1,url:HUB_RESOURCES.assets.url,receivedAt:NOW,body:[{}]}]){
  const h=harness({websocket:false,storageImpl:{getItem:()=>JSON.stringify(cached),setItem(){throw new Error('quota');}}});try{assert.equal(h.client.read('assets').snapshot,null);h.client.setActive(true);await settle();assert.equal(h.client.read('assets').quality,'fresh');}finally{h.client.dispose();}
 }
});

test('malformed responses never turn missing data into a zero snapshot',async()=>{
 const h=harness({websocket:false,fetchImpl:()=>response({})});try{h.client.setActive(true);await settle();for(const key of Object.keys(HUB_RESOURCES)){assert.equal(h.client.read(key).snapshot,null);assert.equal(h.client.read(key).quality,'unavailable');}assert.equal(h.client.events.length,0);
 }finally{h.client.dispose();}
});

test('default public hub preserves explicitly selected demo/BFF and existing TradFi routes',()=>{
 assert.equal(hubOwnsRoute('markets','?page=markets'),true);assert.equal(hubOwnsRoute('tracking','?page=tracking'),false);
 for(const search of ['?data=demo','?data=live','?asset=XAU'])assert.equal(hubOwnsRoute('markets',search),false);
 assert.equal(hubMoney(undefined),'—');assert.equal(hubMoney(1e9),'$1B');assert.equal(hubMoney(-1e9),'-$1B');
});

test('venue logos use approved public image origins and reject unrelated or executable URLs',()=>{
 const image='https://coin-images.coingecko.com/markets/images/29/small/kraken.jpg?1706864265';assert.equal(approvedVenueImageURL(image),image);assert.ok(venueIcon({venue_id:'kraken',venue:'Kraken',image_url:image}).includes(image.replace('&','&amp;')));
 for(const url of ['javascript:alert(1)','https://evil.example/kraken.png','https://coin-images.coingecko.com/private/secret.png',image+'#x','https://user:secret@coin-images.coingecko.com/markets/images/29/small/kraken.jpg'])assert.equal(approvedVenueImageURL(url),null);
});

test('legitimate provider filenames with encoded parentheses retain logos without permitting encoded path escapes',()=>{
 const image='https://coin-images.coingecko.com/coins/images/486/large/Brandmark-Yellow_%281%29.png?1785810558';assert.equal(approvedTokenImageURL(image),image);
 assert.equal(approvedTokenImageURL(image.replace('Brandmark-Yellow_%281%29.png','%2e%2e%2fsecret.png')),null);
 assert.equal(approvedTokenImageURL(image.replace('Brandmark-Yellow_%281%29.png','bad%00.png')),null);
});

test('unavailable asset view keeps the requested identity and offers recovery without fixture prices',()=>{
 const old=globalThis.location;try{globalThis.location=new URL('http://localhost/?page=markets&asset=UNKNOWN');const hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});const html=hub.render('markets');assert.match(html,/UNKNOWN/);assert.match(html,/Back to market overview|返回市场总览/);assert.ok(!/NaN|undefined|Infinity/.test(html));assert.equal(hub.sourceSnapshot().text,'');assert.equal(hub.companionBrief().modeLabel,'公开数据');hub.client.dispose();}finally{if(old)globalThis.location=old;else delete globalThis.location;}
});

test('manual refresh coalesces pending work and returns a meaningful partial result',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const h=harness({websocket:false,fetchImpl:async(key)=>{await pending;return key==='assets'?response({},429,'120'):response(fixtures[key]);}});
 h.client.setActive(true);const a=h.client.refresh(),b=h.client.refresh();assert.equal(a,b);assert.equal(h.calls.length,Object.keys(HUB_RESOURCES).length);release();
 const result=await a;assert.equal(result.status,'partial');assert.equal(result.failed,1);assert.equal((await h.client.refresh()).status,'cooldown');h.client.dispose();
});
test('display interval defaults to sixty seconds and an explicit change affects the next poll',async()=>{
 const h=harness({websocket:false});assert.equal(h.client.refreshSeconds,60);h.client.setActive(true);await settle();const count=h.calls.length;
 h.advance(30000);await settle();assert.equal(h.calls.length,count);
 assert.equal(h.client.setRefreshSeconds(30),30);h.advance(29000);await settle();assert.equal(h.calls.length,count);h.advance(1000);await settle();assert.ok(h.calls.length>count);
 for(const value of [0,-1,NaN,1,16,100000])assert.throws(()=>h.client.setRefreshSeconds(value));h.client.dispose();
});
test('market breadth shares one signed scale and separates unchanged from missing values',async()=>{
 const {hubBreadth}=await import('./market-hub.mjs');const result=hubBreadth([{change:8},{change:-4},{change:0},{change:null}]);
 assert.deepEqual([result.up,result.down,result.flat,result.missing],[1,1,1,1]);assert.equal(result.limit,8);assert.equal(result.rows[0].height,46);assert.equal(result.rows[1].height,23);assert.equal(result.rows[2].height,0);assert.equal(hubBreadth([]).limit,1);
});

test('quote events group dates in UTC+8 and keep row times compact across midnight',()=>{
 const at=Date.UTC(2026,10,5,16,0,7),event={symbol:'BTC',price:76000,delta:.01};
 const html=hubFeedRows([{...event,at},{...event,at:at-5000},{...event,at:at-10000}]);
 assert.equal((html.match(/class="hub-feed-day"/g)||[]).length,2);
 assert.match(html,/>2026-11-06<\/time>/);assert.match(html,/>2026-11-05<\/time>/);
 assert.match(html,/>00:00:07<\/time>/);assert.match(html,/>23:59:57<\/time>/);
 assert.match(html,/datetime="2026-11-05T16:00:07.000Z"/);
 assert.match(html,/title="2026-11-06 00:00:07 UTC\+8"/);
 assert.doesNotMatch(html,/>24:|UTC\+8<\/time>/);
 const missing=hubFeedRows([{...event,symbol:'<BTC>',at:null}]);
 assert.doesNotMatch(missing,/Invalid Date|1970|<BTC>/);assert.match(missing,/&lt;BTC&gt;/);
 assert.match(hubFeedRows([]),/hub-feed-wait/);
});

test('breadth supports hover, keyboard dismissal and first-tap inspection without losing asset navigation',()=>{
 const previous={location:globalThis.location,document:globalThis.document,matchMedia:globalThis.matchMedia};
 const handlers={},attrs={},bar={dataset:{hubBreadth:'bitcoin'},addEventListener:(name,fn)=>{handlers[name]=fn;},setAttribute:(name,value)=>{attrs[name]=value;},removeAttribute:name=>{delete attrs[name];},getBoundingClientRect:()=>({left:285,width:6}),querySelector:()=>({getBoundingClientRect:()=>({top:80,bottom:120})})};
 const tip={hidden:true,style:{},offsetWidth:216,offsetHeight:90},readout={innerHTML:''},plot={getBoundingClientRect:()=>({left:0,top:0,width:300,height:190})};
 const root={querySelector:s=>({'.market-hub':{},'.hub-breadth-tooltip':tip,'.hub-breadth':plot,'[data-hub-breadth-point]':readout}[s]||null),querySelectorAll:s=>s==='[data-hub-breadth]'?[bar]:[]};
 let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets');globalThis.document={addEventListener(){},activeElement:null};globalThis.matchMedia=()=>({matches:true});
  hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:[]}});
  hub.client.read=()=>({snapshot:{data:[{id:'bitcoin',symbol:'BTC',price:76000,change:-2,asOf:NOW}]}});
  hub.bind();handlers.pointerenter();
  assert.equal(tip.hidden,false);assert.match(tip.innerHTML,/BTC/);assert.match(tip.innerHTML,/24h/);assert.match(tip.innerHTML,/76,000/);
  assert.equal(tip.style.left,'80px');assert.equal(attrs['aria-describedby'],'hub-breadth-tooltip');
  assert.match(readout.innerHTML,/asset=BTC&amp;coin=bitcoin|asset=BTC&coin=bitcoin/);
  handlers.pointerleave();assert.equal(tip.hidden,true);
  handlers.focus();assert.equal(tip.hidden,false);handlers.keydown({key:'Escape'});assert.equal(tip.hidden,true);
  let prevented=0;const click={preventDefault(){prevented++;},stopPropagation(){}};
  handlers.click(click);assert.equal(prevented,1);assert.equal(tip.hidden,false);
  handlers.click(click);assert.equal(prevented,1);handlers.blur();assert.equal(tip.hidden,true);
 }finally{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('asset sorting keeps missing values last in both directions without mutating the snapshot',async()=>{
 const {hubSortAssets,hubChangeTone}=await import('./market-hub.mjs');
 const rows=[{id:'missing',volume:null,change:null},{id:'down',volume:20,change:-2},{id:'flat',volume:0,change:0},{id:'up',volume:10,change:3}],before=JSON.stringify(rows);
 assert.deepEqual(hubSortAssets(rows,'volume',-1).map(r=>r.id),['down','up','flat','missing']);
 assert.deepEqual(hubSortAssets(rows,'volume',1).map(r=>r.id),['flat','up','down','missing']);
 assert.deepEqual(hubSortAssets(rows,'change',1).map(r=>r.id),['down','flat','up','missing']);
 assert.deepEqual(hubSortAssets(rows,'price',-1,a=>({price:a.volume})).map(r=>r.id),['down','up','flat','missing']);
 assert.equal(JSON.stringify(rows),before);
 assert.deepEqual([null,undefined,NaN,0,-1,1].map(hubChangeTone),['missing','missing','missing','flat','down','up']);
});

test('asset detail shows only quote changes for that asset, while overview retains the market feed',()=>{
 const old=globalThis.location;let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets&asset=BTC&coin=bitcoin');
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
  hub.client.read=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:key==='assets'?normalizeHubResource('assets',fixtures.assets,NOW).data:null}});
  Object.defineProperty(hub.client,'events',{value:[{id:2,symbol:'ETH',delta:1,price:2000,at:NOW},{id:1,symbol:'BTC',delta:-1,price:100,at:NOW}]});
  const detail=hub.render('markets');assert.match(detail,/hub-feed-event/);assert.match(detail,/<b>BTC<\/b>/);assert.doesNotMatch(detail,/<b>ETH<\/b>/);
  globalThis.location=new URL('http://localhost/?page=markets');assert.match(hub.render('markets'),/<b>ETH<\/b>/);
  globalThis.location=new URL('http://localhost/?page=markets&asset=BTC&coin=another-bitcoin');hub.client.read=()=>({snapshot:{asOf:NOW,receivedAt:NOW,data:[{...normalizeHubResource('assets',fixtures.assets,NOW).data[0],id:'another-bitcoin'}]}});assert.doesNotMatch(hub.render('markets'),/class="hub-feed-event"/);
 }finally{hub?.client.dispose();if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});

test('change labels use the same signs for tiny and ordinary returns while retaining zero and unknown',()=>{
 for(const [value,text,tone]of [[.00001,'+&lt;0.01%','hub-up'],[-.00001,'-&lt;0.01%','hub-down'],[.00499,'+&lt;0.01%','hub-up'],[-.00499,'-&lt;0.01%','hub-down'],[.005,'+0.01%','hub-up'],[-.005,'-0.01%','hub-down'],[.00501,'+0.01%','hub-up'],[-.00501,'-0.01%','hub-down'],[1.88,'+1.88%','hub-up'],[-2.42,'-2.42%','hub-down'],[0,'0%',''],[null,'—',''],[undefined,'—','']]){
  const row=hubFeedRows([{id:1,symbol:'BTC',delta:value,price:76000.12,at:NOW}]);
  assert.ok(row.endsWith(`<span class="${tone}">${text}</span></li>`),String(value));assert.doesNotMatch(row,/[↑↓]/);
 }
});

test('market feed shows cross-asset changes without an unrelated default quote and retains row units',()=>{
 const old=globalThis.location;let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets');
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
  hub.client.read=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:key==='assets'?normalizeHubResource('assets',fixtures.assets,NOW).data:null}});
  Object.defineProperty(hub.client,'events',{value:[{id:1,symbol:'ETH',delta:-.001,price:2000.12,at:NOW}]});
  const overview=hub.render('markets');
  const updates=overview.match(/<h2>行情变化<\/h2>[\s\S]*?<\/ol>/)?.[0];
  assert.ok(updates,'market update panel is present');
  assert.match(updates,/<b>ETH<\/b>/);
  assert.doesNotMatch(updates,/\bBTC\b|data-hub-price/, 'the default asset must not become the market feed subject');
  hub.client.events.push({id:2,symbol:'BTC',delta:.01,price:76000.12,at:NOW});
  const mixed=hub.render('markets').match(/<h2>行情变化<\/h2>[\s\S]*?<\/ol>/)?.[0];
  assert.match(mixed,/<b>BTC<\/b>/,'an actual BTC quote event still belongs in the market feed');
  assert.match(mixed,/<b>ETH<\/b>/);
  assert.match(overview,/<div class="hub-feed-head"[^>]*>[\s\S]*?价格 \/ USDT[\s\S]*?较前价<\/span><\/div>/);
  assert.doesNotMatch(overview,/class="hub-feed-meta"/);
  const row=hubFeedRows(hub.client.events);
  assert.match(row,/2,000\.12<span class="sr-only"> USDT<\/span>/);
  assert.match(row,/-&lt;0\.01%/);
  globalThis.location=new URL('http://localhost/?page=markets&asset=BTC&coin=bitcoin');
  const detail=hub.render('markets');
  assert.match(detail,/class="hub-feed-head"/);
  assert.match(detail,/class="hub-detail-price"/);
  assert.match(detail,/data-hub-price="bitcoin"/);
 }finally{hub?.client.dispose();if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});

test('contract excerpts retain the DEX source and retrieval time when no source timestamp exists',()=>{
 const old=globalThis.location;let hub;
 try{
  globalThis.location=new URL('http://localhost/?page=markets&asset=TKN&coin=contract-test');
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
  const asset={id:'contract-test',symbol:'TKN',name:'Contract token',price:1,cap:null,change:0,address:'0x'+'1'.repeat(40),chain:'ethereum',receivedAt:NOW,series:[]};
  hub.client.read=()=>({snapshot:{receivedAt:NOW,data:[asset]}});
  const excerpt=hub.sourceSnapshot();assert.match(excerpt.text,/TKN: 1 USD/);assert.match(excerpt.text,/DEX Screener/);assert.match(excerpt.text,/2026-11-04T12:00:00.000Z/);assert.doesNotMatch(excerpt.text,/CoinGecko|undefined|NaN/);
  for(const line of excerpt.text.split('\n')){assert.match(line,/(?:数据时间|Data time): —/);assert.match(line,/(?:获取时间|Retrieved at): 2026-11-04T12:00:00.000Z/);}
  const html=hub.render('markets');assert.match(html,/(?:数据时间|Data time) — · (?:获取时间|Retrieved at) 2026-11-04 20:00:00 UTC\+8/);
  assert.match(hub.companionBrief().timestamp,/(?:获取时间|Retrieved at) 2026-11-04 20:00:00 UTC\+8/);
  asset.asOf=NOW-60000;
  for(const line of hub.sourceSnapshot().text.split('\n')){assert.match(line,/(?:数据时间|Data time): 2026-11-04T11:59:00.000Z/);assert.match(line,/(?:获取时间|Retrieved at): 2026-11-04T12:00:00.000Z/);}
  assert.equal(asset.price,1);assert.equal(asset.receivedAt,NOW);assert.equal(asset.asOf,NOW-60000);
 }finally{hub?.client.dispose();if(old===undefined)delete globalThis.location;else globalThis.location=old;}
});

test('a manual-refresh rebuild preserves the search selection, direction and original input focus',()=>{
 const previous={location:globalThis.location,document:globalThis.document};let hub,input;
 const body={},handlers={},button={addEventListener:(name,fn)=>{handlers[name]=fn;}},makeInput=()=>({value:'BTC',selectionStart:0,selectionEnd:0,selectionDirection:'none',addEventListener(){},focus(){document.activeElement=this;},setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}});
 const current={dataset:{hubLayout:'?page=markets&view=ranking|30'},querySelector:s=>s==='[data-hub-search]'?input:null,querySelectorAll:()=>[]};
 const root={querySelector:s=>({'.market-hub':current,'[data-hub-search]':input,'[data-hub-refresh]':button}[s]||null),querySelectorAll:()=>[]};
 try{
  globalThis.location=new URL('http://localhost/?page=markets&view=ranking');globalThis.document={addEventListener(){},body,activeElement:body};input=makeInput();
  hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:[]}});hub.bind();
  input.focus();input.setSelectionRange(0,3,'backward');hub.capture();
  input=makeInput();document.activeElement=body;hub.bind();
  assert.equal(input.value,'BTC');assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],[0,3,'backward']);assert.equal(document.activeElement,input);
  let prevented=false;handlers.pointerdown?.({button:0,preventDefault(){prevented=true;}});assert.equal(prevented,true);
  document.activeElement=body;hub.capture();input=makeInput();hub.bind();assert.equal(document.activeElement,body);
  prevented=false;handlers.pointerdown?.({button:0,preventDefault(){prevented=true;}});assert.equal(prevented,false);
 }finally{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('manual refresh returns focus to its control unless the user has moved to another field',async()=>{
 const previous={location:globalThis.location,document:globalThis.document};let hub;
 const body={},other={},handlers={},button={addEventListener:(name,fn)=>{handlers[name]=fn;},querySelector:()=>null,setAttribute(){},focus(){document.activeElement=this;},set disabled(value){if(value&&document.activeElement===this)document.activeElement=body;}};
 const current={dataset:{hubLayout:'?page=markets&view=ranking|30'},querySelector:()=>null,querySelectorAll:()=>[]};
 const root={querySelector:s=>({'.market-hub':current,'[data-hub-refresh]':button}[s]||null),querySelectorAll:()=>[]};
 try{
  globalThis.location=new URL('http://localhost/?page=markets&view=ranking');globalThis.document={addEventListener(){},body,activeElement:body,hidden:true};
  hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:[]}});hub.render('markets');hub.client.refresh=async()=>({status:'complete'});hub.bind();
  button.focus();const first=handlers.click();assert.equal(document.activeElement,body);await first;assert.equal(document.activeElement,button);
  button.focus();const second=handlers.click();document.activeElement=other;await second;assert.equal(document.activeElement,other);
 }finally{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('market cards retain quote units, missing history and exact asset routes while the table stays available',t=>{
 const previous={location:globalThis.location,document:globalThis.document,localStorage:globalThis.localStorage,requestAnimationFrame:globalThis.requestAnimationFrame};let hub,flip,frames=0;
 t.after(()=>{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.location=new URL('http://localhost/?page=markets&view=watchlist');globalThis.document={addEventListener(){},hidden:true,body:{},activeElement:null};globalThis.localStorage={getItem:()=>null};globalThis.requestAnimationFrame=fn=>{frames++;fn();};
 const current={dataset:{hubLayout:'?page=markets&view=watchlist|30'},querySelector:()=>null,querySelectorAll:()=>[]},toggle={addEventListener(type,fn){if(type==='click')flip=fn;}},cards={dataset:{hubDisplay:'cards'}},tableButton={dataset:{hubDisplay:'table'}};
 const root={querySelector:s=>s==='.market-hub'?current:s==='[data-hub-full]'?toggle:null,querySelectorAll:s=>s==='[data-hub-display]'?[cards,tableButton]:[]};
 hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:['BTC']}});
 const rows=normalizeHubResource('assets',[{...coin(),high_24h:null,low_24h:0,sparkline_in_7d:{price:[]}},{...coin('ethereum','eth')}],NOW).data;
 hub.client.read=()=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:rows}});hub.client.quote=a=>({price:111,change:2,volume:null,quote:'USDT',provider:'Binance Spot',asOf:NOW});
 const html=hub.render('markets');assert.equal((html.match(/data-hub-card="/g)||[]).length,1);assert.match(html,/data-hub-card="bitcoin"/);assert.doesNotMatch(html,/data-hub-card="ethereum"/);const target=new URL(html.match(/class="hub-asset"[^>]*href="([^"]+)"/)[1],location);assert.equal(target.searchParams.get('asset'),'BTC');assert.equal(target.searchParams.get('coin'),'bitcoin');assert.match(html,/data-hub-unit="bitcoin">USDT/);assert.match(html,/data-hub-card-volume="bitcoin">—/);assert.match(html,/24h high.*?USD<\/dt><dd>—|24h 高点.*?USD<\/dt><dd>—/);assert.match(html,/History unavailable|暂无走势/);assert.doesNotMatch(html,/NaN|Infinity|undefined|<table/);
 assert.match(html,/role="group" aria-label="(?:显示方式|Display mode)"/);assert.match(html,/data-hub-display="cards" aria-pressed="true"/);assert.match(html,/data-hub-display="table" aria-pressed="false"/);assert.doesNotMatch(html,/data-hub-full/);
 hub.bind();const before=frames;cards.onclick();assert.equal(frames,before);tableButton.onclick();const table=hub.render('markets');assert.match(table,/<table class="hub-table">/);assert.doesNotMatch(table,/data-hub-card="/);assert.match(table,/data-hub-display="cards" aria-pressed="false"/);assert.match(table,/data-hub-display="table" aria-pressed="true"/);
 const label=(markup,mode)=>markup.match(new RegExp('data-hub-display="'+mode+'"[^>]*aria-label="([^"]+)"'))[1];for(const mode of ['cards','table'])assert.equal(label(table,mode),label(html,mode));
 const selected=frames;tableButton.onclick();assert.equal(frames,selected);cards.onclick();assert.match(hub.render('markets'),/data-hub-card="bitcoin"/);assert.deepEqual(hub.sourceSnapshot().text.match(/BTC:/g),['BTC:']);
 globalThis.location=new URL('http://localhost/?page=markets&view=ranking');const ranking=hub.render('markets');assert.match(ranking,/<table class="hub-table">/);assert.doesNotMatch(ranking,/data-hub-card="|data-hub-display/);hub.bind();flip();assert.match(hub.render('markets'),/data-full="true"/);
});

test('an unchanged price still refreshes card provider, time, volume and unit on a quote-source switch',t=>{
 const previous={location:globalThis.location,document:globalThis.document,localStorage:globalThis.localStorage,CSS:globalThis.CSS};let hub;
 t.after(()=>{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.location=new URL('http://localhost/?page=markets&view=watchlist');globalThis.document={addEventListener(){},hidden:true};globalThis.localStorage={getItem:()=>null};globalThis.CSS={escape:value=>value};
 const priceNode={dataset:{price:'100'},textContent:'100',title:'CoinGecko'},unit={textContent:'USD'},volume={textContent:'200'},volumeUnit={textContent:'USD'},source={textContent:'old'};
 const selectors={'[data-hub-price="bitcoin"]':priceNode,'[data-hub-unit="bitcoin"]':unit,'[data-hub-card-volume="bitcoin"]':volume,'[data-hub-card-volume-unit="bitcoin"]':volumeUnit,'[data-hub-card-quote-source="bitcoin"]':source};
 const root={querySelector:()=>null,querySelectorAll:s=>selectors[s]?[selectors[s]]:[]};hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:['BTC']}});
 const rows=normalizeHubResource('assets',[coin()],NOW).data;hub.client.read=()=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:rows}});hub.client.quote=()=>({price:100,change:0,volume:0,quote:'USDT',provider:'Binance Spot',asOf:NOW});hub.render('markets');hub.tick();
 assert.equal(priceNode.textContent,'100');assert.match(priceNode.title,/Binance Spot/);assert.equal(unit.textContent,'USDT');assert.equal(volume.textContent,'0');assert.equal(volumeUnit.textContent,'USDT');assert.match(source.textContent,/Binance Spot.*USDT/);assert.match(source.textContent,/2026-11-04 20:00:00 UTC\+8/);
});

test('compact asset scope and order preserve the selected dataset across display changes',t=>{
 const assertToolbarOrder=html=>{
  const header=html.slice(html.indexOf('hub-asset-panel')).match(/<header>([\s\S]*?)<\/header>/)[1];
  const positions=['data-hub-scope-select','class="dc-info','class="hub-table-tools"','data-hub-search','data-hub-add','data-hub-display="cards"','data-hub-sort-select'].map(token=>header.indexOf(token));
  assert.ok(positions.every((at,i)=>at>=0&&(!i||positions[i-1]<at)),'scope, info, search, add, view and sort must follow the same reading and keyboard order');
  assert.equal((header.match(/<details class="dc-info/g)||[]).length,1);
 };
 const previous={location:globalThis.location,document:globalThis.document,localStorage:globalThis.localStorage,requestAnimationFrame:globalThis.requestAnimationFrame};let hub;
 t.after(()=>{hub?.client.dispose();for(const [k,v]of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.location=new URL('http://localhost/?page=markets&view=watchlist');globalThis.document={addEventListener(){},hidden:true,body:{},activeElement:null};globalThis.localStorage={getItem:()=>null};globalThis.requestAnimationFrame=fn=>fn();
 const scope={value:'watch'},order={value:'cap'},direction={dataset:{hubSort:'price'}},cards={dataset:{hubDisplay:'cards'}},table={dataset:{hubDisplay:'table'}},current={dataset:{hubLayout:'?page=markets&view=watchlist|30'},querySelector:()=>null,querySelectorAll:()=>[]};
 const root={querySelector:s=>s==='.market-hub'?current:s==='[data-hub-scope-select]'?scope:s==='[data-hub-sort-select]'?order:null,querySelectorAll:s=>s==='[data-hub-sort]'?[direction]:s==='[data-hub-display]'?[cards,table]:[]};
 hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:['BTC']}});const rows=normalizeHubResource('assets',[{...coin(),current_price:20},{...coin('ethereum','eth'),current_price:10}],NOW).data;
 hub.client.read=()=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:rows}});hub.client.quote=a=>({price:a.price,change:0,volume:0,quote:'USD',provider:'CoinGecko',asOf:NOW});
 const initial=hub.render('markets');assertToolbarOrder(initial);assert.match(initial,/data-hub-scope-select/);assert.match(initial,/data-hub-sort-select/);hub.bind();scope.value='all';scope.onchange();order.value='price';order.onchange();
 const ids=html=>[...html.matchAll(/data-hub-card="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(ids(hub.render('markets')),['bitcoin','ethereum']);direction.onclick();assert.deepEqual(ids(hub.render('markets')),['ethereum','bitcoin']);
 table.onclick();const tableMarkup=hub.render('markets');assertToolbarOrder(tableMarkup);assert.match(tableMarkup,/<option value="price" selected>/);cards.onclick();assert.deepEqual(ids(hub.render('markets')),['ethereum','bitcoin']);
 scope.value='watch';scope.onchange();assert.deepEqual(ids(hub.render('markets')),['bitcoin']);
});


test('saved contract detail uses the same scoped metadata store as the shared watchlist',()=>{
 const previous=globalThis.location;let hub;
 const address='0x'+'1'.repeat(40),id='ca:ethereum:'+address,asset={id,address,chain:'ethereum',symbol:'WETH',name:'Wrapped Ether',price:2325,series:[],provider:'DEX Screener',receivedAt:NOW};
 try{
  globalThis.location=new URL('http://localhost/?page=markets&asset=WETH&coin='+encodeURIComponent(id));
  const storage={getItem:key=>key===WATCH_ASSETS_KEY?JSON.stringify([asset]):null};
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[id]},storage});
  const html=hub.render('markets');
  assert.match(html,/Wrapped Ether/);assert.match(html,new RegExp(address));assert.match(html,/2,325/);
  assert.doesNotMatch(html,/数据暂不可用|Data temporarily unavailable/);
 }finally{hub?.client.dispose();if(previous===undefined)delete globalThis.location;else globalThis.location=previous;}
});

import {normalizeResearchBackground,validateResearchBackground,createResearchBackgroundClient,RESEARCH_BACKGROUND_RESOURCES} from './market-hub-data.mjs';
const BG_NOW=Date.UTC(2026,10,17,12),BG_DAY=Date.UTC(2026,10,17);
function bgEnvelope(resource,receivedAt=BG_NOW,day=BG_DAY){
 const body=resource==='sentiment'?{data:[{timestamp:String(day/1000),value:'37'}]}:resource==='chains'?[{name:'Ethereum',tvl:1000,tokenSymbol:'ETH'},{name:'Solana',tvl:500,tokenSymbol:'SOL'},{name:'Other',tvl:1}]:[{date:day/1000,totalCirculatingUSD:{peggedUSD:100,peggedEUR:20}}];
 return {schema:'public-market-relay-v1',resource,receivedAt,body};
}
const bgResponse=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('background projection reuses the existing metrics with original source clocks and exact limited units',()=>{
 for(const resource of RESEARCH_BACKGROUND_RESOURCES){const input=bgEnvelope(resource),before=structuredClone(input),value=normalizeResearchBackground(input,resource,BG_NOW);assert.deepEqual(input,before);assert.equal(value.receivedAt,BG_NOW);assert.equal(value.provider,HUB_RESOURCES[resource].provider);assert.deepEqual(validateResearchBackground(value,resource,BG_NOW),value);assert.equal(value.validUntil,(resource==='chains'?BG_NOW:BG_DAY)+HUB_RESOURCES[resource].stale);}
 assert.deepEqual(normalizeResearchBackground(bgEnvelope('sentiment'),'sentiment',BG_NOW).data,{value:37});
 assert.deepEqual(normalizeResearchBackground(bgEnvelope('stablecoins'),'stablecoins',BG_NOW).data,{totalUsd:120});
 assert.deepEqual(normalizeResearchBackground(bgEnvelope('chains'),'chains',BG_NOW).data,[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500}]);
});
test('background identity, applicability, future clocks and original expiry fail closed',()=>{
 const source=normalizeResearchBackground(bgEnvelope('sentiment'),'sentiment',BG_NOW);
 for(const patch of [{provider:'Demo'},{resource:'chains'},{schema:'fixture'},{receivedAt:BG_NOW+1001},{asOf:BG_DAY+1},{validUntil:source.validUntil+1},{data:{value:101}},{data:{value:'37'}},{data:{value:37,authorization:true}}])assert.throws(()=>validateResearchBackground({...source,...patch},'sentiment',BG_NOW),{code:'BACKGROUND_INVALID'});
 assert.throws(()=>validateResearchBackground(source,'sentiment',source.validUntil),{code:'BACKGROUND_STALE'});
 assert.throws(()=>normalizeResearchBackground(bgEnvelope('sentiment',BG_NOW,BG_DAY+86400000),'sentiment',BG_NOW),{code:'BACKGROUND_INVALID'});
 assert.throws(()=>normalizeResearchBackground({...bgEnvelope('chains'),body:[{name:'Unmapped',tvl:10}]},'chains',BG_NOW),{code:'BACKGROUND_INVALID'});
 assert.throws(()=>normalizeResearchBackground({...bgEnvelope('chains'),body:[{name:'Ethereum',tvl:10},{name:'Ethereum',tvl:20}]},'chains',BG_NOW),{code:'BACKGROUND_INVALID'});
 assert.throws(()=>normalizeResearchBackground({...bgEnvelope('sentiment'),url:'https://evil.test'},'sentiment',BG_NOW),{code:'BACKGROUND_INVALID'});
});
test('one background client coalesces the three resources and keeps cached times through pause and asset-independent reads',async()=>{
 let at=BG_NOW;const calls=[],updates=[],client=createResearchBackgroundClient({now:()=>at,onChange:rows=>updates.push(rows),fetchImpl:async(url,options)=>{calls.push({url,options});return bgResponse(bgEnvelope(new URL(url,'https://example.test').searchParams.get('resource'),at));}});
 assert.equal(calls.length,0);client.setActive(true);await Promise.all([client.refresh(),client.refresh()]);assert.equal(calls.length,3);const first=client.rows();assert.ok(first.every(row=>row.state==='ready'));
 for(const call of calls){assert.match(call.url,/^\/api\/market-hub\?resource=(sentiment|chains|stablecoins)$/);assert.equal(call.options.method,'GET');assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');}
 for(let i=0;i<8;i++)client.tick();assert.equal(calls.length,3);
 at+=1000;client.setActive(false);assert.ok(client.rows().every(row=>row.state==='paused'));client.setActive(true);assert.deepEqual(client.rows(),first);assert.equal(calls.length,3);
 at=BG_DAY+129600000;assert.equal(client.rows().find(row=>row.resource==='sentiment').state,'stale');assert.equal(client.rows().find(row=>row.resource==='sentiment').snapshot.asOf,BG_DAY);client.dispose();
});
test('background fetch and body deadlines release pending and explicit retries cannot accept a late response',async()=>{
 for(const bodyHang of [false,true]){
  let blocked=true,calls=0,cancelled=0;const client=createResearchBackgroundClient({now:()=>BG_NOW,timeoutMs:15,fetchImpl:async url=>{calls++;if(blocked)return bodyHang?new Response(new ReadableStream({start(){},cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}):new Promise(()=>{});return bgResponse(bgEnvelope(new URL(url,'https://example.test').searchParams.get('resource')));}});
  client.setActive(true);await client.refresh();assert.equal(calls,3);assert.ok(client.rows().every(row=>row.state==='error'));if(bodyHang)assert.equal(cancelled,3);
  blocked=false;await client.refresh();assert.equal(calls,6);assert.ok(client.rows().every(row=>row.state==='ready'));client.dispose();
 }
 let release;const late=new Promise(resolve=>release=resolve),events=[],client=createResearchBackgroundClient({now:()=>BG_NOW,onChange:rows=>events.push(rows),fetchImpl:()=>late});
 client.setActive(true);const pending=client.refresh();await new Promise(setImmediate);client.setActive(false);await pending;const count=events.length;release(bgResponse(bgEnvelope('sentiment')));await new Promise(setImmediate);assert.equal(events.length,count);assert.ok(client.rows().every(row=>row.snapshot===null));client.dispose();
});
test('a failed background read cancels its unread body, even when cancelling fails, and shows no snapshot',async()=>{
 for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  let cancels=0;const client=createResearchBackgroundClient({now:()=>BG_NOW,fetchImpl:async()=>({ok:false,status:503,redirected:false,headers:{get:key=>key.toLowerCase()==='content-type'?'application/json':null},body:{cancel(){cancels++;return cancel();},getReader(){throw Error('must not read error');}}})});
  client.setActive(true);await client.refresh();
  assert.equal(cancels,3);assert.ok(client.rows().every(row=>row.state==='error'&&row.snapshot===null));client.dispose();
 }
});
test('background transport failures never reuse a stale or failed snapshot as available',async()=>{
 let at=BG_NOW,fail=false;const client=createResearchBackgroundClient({now:()=>at,fetchImpl:async url=>fail?new Response('{}',{status:503,headers:{'Content-Type':'application/json'}}):bgResponse(bgEnvelope(new URL(url,'https://example.test').searchParams.get('resource')))});
 client.setActive(true);await client.refresh();fail=true;await client.refresh();assert.ok(client.rows().every(row=>row.state==='error'));assert.ok(client.rows().every(row=>row.snapshot.receivedAt===BG_NOW));at+=129600000;assert.ok(client.rows().every(row=>row.state!=='ready'));client.dispose();
});
test('a synchronous pause during background startup prevents even a deferred transport dispatch',async()=>{
 let client,events=0,calls=0;client=createResearchBackgroundClient({now:()=>BG_NOW,onChange(){if(++events===2)client.setActive(false);},fetchImpl:async()=>{calls++;throw Error('must not dispatch after pause');}});
 client.setActive(true);await new Promise(setImmediate);assert.equal(calls,0);assert.ok(client.rows().every(row=>row.state==='paused'));client.dispose();
});
test('the ranking table shows a market rank only as a positive whole number and keeps every other rank unknown',t=>{
 const previous={location:globalThis.location,document:globalThis.document,localStorage:globalThis.localStorage,requestAnimationFrame:globalThis.requestAnimationFrame};let hub;
 t.after(()=>{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.location=new URL('http://localhost/?page=markets&view=ranking');globalThis.document={addEventListener(){},hidden:true,body:{},activeElement:null};globalThis.localStorage={getItem:()=>null};globalThis.requestAnimationFrame=fn=>fn();
 const ranks={ONE:1,LAST:250,TAG:'<em class="probe">3</em>',QUOTE:'4" data-probe="x',TEXT:'5',HALF:1.5,ZERO:0,NEG:-3,HUGE:2**53,INF:Infinity,NAN:NaN,NONE:null,GONE:undefined};
 const base=normalizeHubResource('assets',Object.keys(ranks).map(symbol=>coin(symbol.toLowerCase(),symbol)),NOW).data;
 const rows=base.map(row=>({...row,rank:ranks[row.symbol]}));
 hub=createMarketHub({root:{querySelector:()=>null,querySelectorAll:()=>[]},rerender(){},notify(){},saved:{assets:[]}});
 hub.client.read=()=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:rows}});hub.client.quote=()=>({price:100,change:2,volume:200,quote:'USD',provider:'CoinGecko',asOf:NOW});
 const html=hub.render('markets');assert.match(html,/<table class="hub-table">/);
 const cells=Object.fromEntries([...html.matchAll(/<tr data-hub-row="([^"]+)">[\s\S]*?<td class="hub-rank">([\s\S]*?)<\/td>/g)].map(m=>[m[1],m[2]]));
 const expected=Object.fromEntries(Object.keys(ranks).map(symbol=>[symbol,'\u2014']));expected.ONE='1';expected.LAST='250';
 assert.deepEqual(cells,expected);
 assert.doesNotMatch(html,/<em class="probe"|data-probe=/);assert.doesNotMatch(html,/NaN|Infinity|undefined/);
});
test('a contract quote hint is named for its source and time, keeps its body and escapes the token symbol',()=>{
 const previous={location:globalThis.location,fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};let hub,fetches=0;
 try{
  globalThis.WebSocket=undefined;globalThis.fetch=async()=>{fetches++;throw Error('no network in this test');};
  for(const [symbol,shown] of [['TKN','TKN'],['T"K<N','T&quot;K&lt;N']]){
   globalThis.location=new URL('http://localhost/?'+new URLSearchParams({page:'markets',asset:symbol,coin:'contract-test'}));
   hub?.client.dispose();hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});
   const asset={id:'contract-test',symbol,name:'Contract token',price:1,cap:null,change:0,address:'0x'+'1'.repeat(40),chain:'ethereum',receivedAt:NOW,series:[]};
   hub.client.read=()=>({snapshot:{receivedAt:NOW,data:[asset]}});
   const price=hub.render('markets').match(/<section class="hub-detail-price">([\s\S]*?)<\/section>/)?.[1];assert.ok(price);
   const hint=price.match(/<details class="dc-info"><summary aria-label="([^"]*)">i<\/summary><div>([^<]*)<\/div><\/details>/);assert.ok(hint,'the quote keeps one plain info hint');
   assert.match(hint[2],/^DEX Screener · (?:数据时间|Data time) \u2014 · (?:获取时间|Retrieved at) 2026-11-04 20:00:00 UTC\+8$/);
   assert.ok([shown+' · 数据来源与时间',shown+' · Source and time'].includes(hint[1]),hint[1]);
   assert.doesNotMatch(price,/T"K<N/);
  }
  assert.equal(fetches,0);
 }finally{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('the watchlist note reached through the Watchlist scope button is named About my tracking after the word that button shows, leaves the footer as the only Data sources disclosure and stays the only info control in the asset header',t=>{
 const previous={location:globalThis.location,document:globalThis.document,localStorage:globalThis.localStorage,requestAnimationFrame:globalThis.requestAnimationFrame,fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};let hub,fetches=0;
 t.after(()=>{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.location=new URL('http://localhost/?page=markets');globalThis.document={addEventListener(){},hidden:true,body:{},activeElement:null};globalThis.localStorage={getItem:()=>null};globalThis.requestAnimationFrame=fn=>fn();globalThis.WebSocket=undefined;globalThis.fetch=async()=>{fetches++;throw Error('no network in this test');};
 const values=Object.fromEntries(Object.entries(fixtures).map(([key,raw])=>[key,normalizeHubResource(key,raw,NOW).data]));
 const all={dataset:{hubScope:'all'}},watch={dataset:{hubScope:'watch'}},current={dataset:{hubLayout:'?page=markets|30'},querySelector:()=>null,querySelectorAll:()=>[]};
 const root={querySelector:s=>s==='.market-hub'?current:null,querySelectorAll:s=>s==='[data-hub-scope]'?[all,watch]:[]};
 hub=createMarketHub({root,rerender(){},notify(){},saved:{assets:['BTC']}});hub.client.read=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:values[key]}});
 const assetHeader=html=>html.slice(html.indexOf('hub-asset-panel')).match(/<header>([\s\S]*?)<\/header>/)[1],sourceHint=/<details class="dc-info hub-source [^"]*"><summary aria-label="[^"]+ · (?:数据来源与时间|Source and time)">/;
 const dataSources=html=>{const found=[...html.matchAll(/<details([^>]*)>\s*<summary([^>]*)>([\s\S]*?)<\/summary>/g)];assert.equal(found.length,(html.match(/<details[\s>]/g)||[]).length,'every disclosure is read');return found.filter(([,,attrs,text])=>/^(?:数据来源|Data sources)$/.test(attrs.match(/\saria-label="([^"]*)"/)?.[1]??text.replace(/<[^>]*>/g,'').trim())).map(([,details])=>details);};
 const watchNote=header=>{
  assert.match(header,/data-hub-scope="watch" aria-pressed="true"/);
  const hints=[...header.matchAll(/<details class="dc-info[^"]*"><summary aria-label="([^"]*)">i<\/summary><div>([^<]*)<\/div><\/details>/g)];
  assert.equal((header.match(/<details class="dc-info/g)||[]).length,1);assert.equal(hints.length,1);
  assert.match(hints[0][2],/^(?:自选报价来自 CoinGecko \/ Binance；合约资产来自 DEX Screener。点击卡片底部查看来源与时间。|Quotes use CoinGecko \/ Binance; contracts use DEX Screener\. Open a card\u2019s source row for details\.)$/);
  // The scope button renders L('自选','Watchlist') through the tracking vocabulary; the note's name uses the word the button shows.
  const button=header.match(/data-hub-scope="watch" aria-pressed="true">([^<]*?)\s*<b>/)?.[1]??'';assert.ok(button.trim(),'the pressed Watchlist scope button shows a word');
  assert.ok(hints[0][1].toLowerCase().includes(button.trim().toLowerCase()),hints[0][1]+' names '+button.trim());
  return hints[0][1];
 };
 const overview=hub.render('markets'),before=assetHeader(overview);assert.match(before,/data-hub-scope="all" aria-pressed="true"/);assert.match(before,sourceHint);
 assert.deepEqual(dataSources(overview),[' class="hub-sources"']);
 hub.bind();watch.onclick();
 const watchPage=hub.render('markets');
 assert.deepEqual(dataSources(watchPage),[' class="hub-sources"'],'the footer stays the only disclosure named Data sources in watch scope');
 assert.match(watchNote(assetHeader(watchPage)),/^(?:关于我的追踪|About my tracking)$/);
 all.onclick();assert.match(assetHeader(hub.render('markets')),sourceHint);
 globalThis.location=new URL('http://localhost/?page=markets&view=watchlist');
 const listPage=hub.render('markets');
 assert.deepEqual(dataSources(listPage),[' class="hub-sources"'],'the footer stays the only disclosure named Data sources on the Watchlist view');
 assert.match(watchNote(assetHeader(listPage)),/^(?:关于我的追踪|About my tracking)$/);
 assert.equal(fetches,0);
});
test('no Markets hint that shows a data or retrieval time keeps the metric help name',t=>{
 const previous={location:globalThis.location,fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};let hub,fetches=0;
 t.after(()=>{hub?.client.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.WebSocket=undefined;globalThis.fetch=async()=>{fetches++;throw Error('no network in this test');};
 const values=Object.fromEntries(Object.entries(fixtures).map(([key,raw])=>[key,normalizeHubResource(key,raw,NOW).data]));
 const contract={id:'contract-test',symbol:'TKN',name:'Contract token',price:1,cap:null,change:0,address:'0x'+'1'.repeat(40),chain:'ethereum',receivedAt:NOW,series:[]};
 const fresh=key=>({quality:'fresh',snapshot:{asOf:NOW,receivedAt:NOW,data:values[key]}});
 const pages=[['?page=markets',fresh,'hub-asset-panel'],['?page=markets&view=ranking',fresh,'<table class="hub-table">'],['?page=markets&asset=BTC&coin=bitcoin',fresh,'data-hub-watch="bitcoin"'],['?page=markets&asset=TKN&coin=contract-test',()=>({snapshot:{receivedAt:NOW,data:[contract]}}),'class="hub-contract"']];
 for(const [search,read,shown] of pages){
  globalThis.location=new URL('http://localhost/'+search);hub?.client.dispose();
  hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:[]}});hub.client.read=read;
  const html=hub.render('markets'),hints=[...html.matchAll(/<details class="dc-info[^"]*"><summary[^>]*? aria-label="([^"]*)"[^>]*>i<\/summary>([\s\S]*?)<\/details>/g)];
  assert.ok(html.includes(shown),search);assert.equal(hints.length,(html.match(/<details class="dc-info/g)||[]).length,search);
  const timed=hints.filter(([,,body])=>/数据时间|Data time|获取时间|Retrieved at/.test(body));assert.ok(timed.length>0,search);
  for(const [,label,body] of timed)assert.ok(!['查看指标说明','About this metric'].includes(label),search+' '+body);
 }
 assert.equal(fetches,0);
});
