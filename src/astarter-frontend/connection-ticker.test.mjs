import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionTicker} from './connection-ticker.mjs';
import {createMarketHubClient,normalizeHubTicker,HUB_RESOURCES} from './market-hub-data.mjs';
import {PAGES} from './product-data.mjs';
import {pair} from './locale.mjs';
const at=Date.UTC(2026,10,12),quote=(symbol,last,open)=>({symbol:symbol+'USDT',lastPrice:String(last),openPrice:String(open),quoteVolume:'1000000',closeTime:at});
test('24-hour quotes preserve real gains and losses, rejecting missing baselines',()=>{
 assert.equal(normalizeHubTicker(quote('BTC',101,100),at).change>0,true);
 assert.equal(normalizeHubTicker(quote('ETH',98,100),at).change<0,true);
 assert.equal(normalizeHubTicker({...quote('BTC',100,100),openPrice:null},at),null);
});
test('ticker loads only public quotes, formats both signs, preserves delayed facts and pauses offscreen',async()=>{
 const old=globalThis.document;let now=at,calls=0;
 const viewport={innerHTML:'',setAttribute(){},addEventListener(){}},label={},source={querySelector:()=>label},bar={dataset:{},querySelector:s=>s==='.connection-ticker'?viewport:source};
 try{
  globalThis.document={hidden:false,body:{dataset:{page:'workbench'}}};
  const ticker=createConnectionTicker(bar,{now:()=>now,fetchImpl:async(url,init)=>{calls++;assert.equal(url,HUB_RESOURCES.tickers.url);assert.equal(init.credentials,'omit');return calls===1?new Response(JSON.stringify([quote('BTC',101,100),quote('ETH',98,100)])):new Response('{}',{status:503});}});
  ticker.refresh();await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls,1);assert.match(viewport.innerHTML,/data-up="true">\+1.00%/);assert.match(viewport.innerHTML,/data-up="false">-2.00%/);assert.match(source.title,/UTC/);
  ticker.refresh();assert.equal(calls,1);now+=31000;ticker.refresh();await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls,2);assert.equal(label.textContent,pair('延迟','Delayed'));assert.match(viewport.innerHTML,/data-ticker-symbol="BTC"/);
  document.hidden=true;now+=40000;ticker.refresh();assert.equal(calls,2);assert.equal(bar.dataset.tickerActive,'false');ticker.dispose();
 }finally{globalThis.document=old;}
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function productTicker(t,page,fetchImpl,now){
 const old=globalThis.document;
 globalThis.document={hidden:false,body:{dataset:{page}}};
 const viewport={innerHTML:'',setAttribute(){},addEventListener(){}},label={},source={querySelector:()=>label};
 const bar={dataset:{},querySelector:selector=>selector==='.connection-ticker'?viewport:source};
 const ticker=createConnectionTicker(bar,{fetchImpl,now});
 t.after(()=>{ticker.dispose();globalThis.document=old;});
 return {ticker,bar,viewport,label};
}
test('every product route shares the same visible footer and distinguishes a delayed instrument from fresh quotes',async t=>{
 let now=at,calls=0;const older=6*86400_000;
 const read=async()=>{calls++;return Response.json([quote('BTC',101,100),{...quote('ETH',98,100),closeTime:at-older}]);};
 const {ticker,bar,viewport,label}=productTicker(t,'social',read,()=>now);
 ticker.refresh();await settle();
 assert.equal(label.textContent,'Binance');assert.match(viewport.innerHTML,/data-ticker-symbol="ETH"[^>]+UTC[\s\S]*?class="ticker-delayed"/);
 assert.doesNotMatch(viewport.innerHTML.split('data-ticker-symbol="ETH"')[0],/ticker-delayed/);
 for(const [id] of PAGES){document.body.dataset.page=id;ticker.refresh();assert.equal(bar.dataset.tickerActive,'true',id);}
 assert.equal(calls,1);
 now+=31_000;ticker.refresh();await settle();assert.equal(label.textContent,pair('延迟','Delayed'));
 document.body.dataset.page='landing';ticker.refresh();assert.equal(bar.dataset.tickerActive,'false');
});

test('the market page shares in-flight footer reads, honors a 15s cadence and cannot wake a hidden or suspended footer',async t=>{
 let now=at;const calls=[];
 const read=(url,init)=>new Promise(resolve=>{calls.push({url,signal:init.signal,resolve:()=>resolve(Response.json([{...quote('BTC',100+calls.length,100),closeTime:now}]))});});
 const {ticker,viewport}=productTicker(t,'markets',read,()=>now);
 const market=createMarketHubClient({resources:['tickers'],refreshSeconds:15,fetchImpl:read,WebSocketImpl:null,storageImpl:null,now:()=>now});
 t.after(()=>market.dispose());
 market.setActive(true);ticker.refresh();market.tick();assert.equal(calls.length,1);calls[0].resolve();await settle();
 assert.equal(market.read('tickers').snapshot.data[0].price,101);assert.match(viewport.innerHTML,/101\.00/);
 now+=15_000;ticker.refresh();market.tick();assert.equal(calls.length,2);calls[1].resolve();await settle();
 assert.equal(market.read('tickers').snapshot.data[0].price,102);assert.match(viewport.innerHTML,/102\.00/);
 market.setActive(false);document.body.dataset.page='assistant';ticker.refresh();document.body.dataset.page='markets';market.setActive(true);ticker.refresh();
 assert.equal(calls.length,2);
 now+=31_000;document.hidden=true;ticker.pause();market.tick();await settle();assert.equal(calls.length,2);
 document.hidden=false;now+=16_000;market.tick();await settle();assert.equal(calls.length,2);
 ticker.resume();market.tick();assert.equal(calls.length,3);calls[2].resolve();await settle();
 assert.ok(calls.every(call=>call.url===HUB_RESOURCES.tickers.url));
});
