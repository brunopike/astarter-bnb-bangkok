import test from 'node:test';
import assert from 'node:assert/strict';
import {watchlistEntries} from './watchlist-view.mjs';

test('known coin aliases display once and retain every persisted key for removal',()=>{
 const keys=['BTC','coin:bitcoin','SPX'],tasks=[{symbol:'BTC',name:'Bitcoin'},{symbol:'SPX',name:'S&P 500'}];
 const rows=watchlistEntries(keys,[],tasks);
 assert.equal(rows.length,2);assert.deepEqual(rows[0].keys,['BTC','coin:bitcoin']);
 assert.equal(rows[0].task,tasks[0]);assert.equal(rows[1].asset.symbol,'SPX');
 assert.deepEqual(keys,['BTC','coin:bitcoin','SPX']);
});
test('same-symbol coins and same-address tokens on different chains remain separate',()=>{
 const address='0x'+'1'.repeat(40),assets=[
  {id:'bitcoin',symbol:'BTC',name:'Bitcoin'},
  {id:'other-btc',symbol:'BTC',name:'Another BTC'},
  {id:'ca:ethereum:'+address,chain:'ethereum',address,symbol:'BTC',name:'Token'},
  {id:'ca:base:'+address,chain:'base',address,symbol:'BTC',name:'Token'},
 ];
 const keys=['BTC','coin:other-btc',assets[2].id,assets[3].id];
 const rows=watchlistEntries(keys,assets,[{symbol:'BTC'}]);
 assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.key),keys);
 assert.equal(rows.filter(row=>row.task).length,1);
 assert.equal(rows[1].asset.id,'other-btc');assert.equal(rows[2].asset.chain,'ethereum');assert.equal(rows[3].asset.chain,'base');
});
test('missing metadata remains removable without claiming a quote or a research task',()=>{
 const key='ca:base:0x'+'2'.repeat(40),rows=watchlistEntries([key,'coin:missing-coin','ODD']);
 assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.keys[0]),[key,'coin:missing-coin','ODD']);
 assert.ok(rows.every(row=>row.task===null&&row.asset.price===null));
 assert.ok(rows.every(row=>!row.known));assert.equal(rows[1].asset.name,'missing-coin');
});

import {watchlistRoute} from './product-data.mjs';
import {WorkspaceSim,WORKBENCH_TARGETS_KEY} from './workspace-sim.mjs';
import {workbenchTracking} from './workbench-targets.mjs';
import {MultiResearch} from './multi-research.mjs';

test('legacy watchlist routes retain unrelated context and return to a base page',()=>{
 assert.equal(watchlistRoute('?page=watchlist&motion=reduced'),'?page=workbench&motion=reduced');
 assert.equal(watchlistRoute('?page=markets&view=watchlist&coin=bitcoin'),'?page=markets&coin=bitcoin');
 assert.equal(watchlistRoute('?page=markets&view=ranking'),null);
 assert.equal(watchlistRoute('?page=signals'),null);
});
test('offline market favorites and research targets share updates without losing unknown identities',()=>{
 const data=new Map([['hive.dc.assets',JSON.stringify(['coin:other-btc'])]]);
 const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const workspace=new WorkspaceSim({storage});
 assert.deepEqual(workspace.s.aiSignalWatch,['coin:other-btc']);
 workspace.s.aiSignalWatch=[...workspace.s.aiSignalWatch,'BTC'];
 assert.deepEqual(JSON.parse(data.get('hive.dc.assets')),['coin:other-btc','BTC']);
 workspace.s.workbenchFilter='scan';
 workspace.s.aiSignalWatch=workspace.s.aiSignalWatch.filter(key=>key!=='BTC');
 const restored=new WorkspaceSim({storage});assert.deepEqual(restored.s.aiSignalWatch,['coin:other-btc']);
 assert.equal(JSON.parse(data.get(WORKBENCH_TARGETS_KEY)).filter,'scan');
});
test('research resolves registered coin aliases without treating a same-symbol coin as BTC',()=>{
 const research=new MultiResearch();
 assert.deepEqual(workbenchTracking(research,['coin:bitcoin'],'tracked').map(row=>row.symbol),['BTC']);
 assert.deepEqual(workbenchTracking(research,['coin:other-btc'],'tracked'),[]);
});

import {createWatchlist} from './watchlist-view.mjs';
import {createMarketHub,hubCandleIdentity} from './market-hub.mjs';
import {normalizeHubResource,normalizeHubTicker} from './market-hub-data.mjs';
import {normalizeDexAssets} from './market-watchlist.mjs';
import {candleRequest} from './trading-chart-data.mjs';
import {hostedChartSymbol} from './tradingview-widget.mjs';
import {workbenchInsights} from './workbench-insights.mjs';
import {ORDER_MARKETS} from './order-markets.mjs';
// U3 mapping pins: a Markets row, the watchlist row saved from it, and the market each one opens.
// The dialog below is a minimal stand-in for the browser: it keeps the markup the picker writes and hands back the buttons named in it.
const U3_NOW=Date.UTC(2026,10,4,12),U3_CA='0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const u3Coin=(id,symbol,name)=>({id,symbol,name,current_price:100,market_cap:1000,total_volume:200,price_change_percentage_24h:2,price_change_percentage_7d_in_currency:4,last_updated:new Date(U3_NOW).toISOString(),sparkline_in_7d:{price:[98,99,100]}});
const u3Pair=(patch={})=>({chainId:'ethereum',dexId:'uniswap',baseToken:{address:U3_CA,name:'Pepe',symbol:'PEPE'},priceUsd:'0.00001',priceChange:{h24:-4},liquidity:{usd:100000},volume:{h24:1000},marketCap:4200000000,...patch});
const u3Params=href=>Object.fromEntries(new URLSearchParams(String(href).replace(/^[^?]*\?/,'')));
const u3Pattern=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const u3RowHref=(html,id)=>html.match(new RegExp(`data-hub-watch="${u3Pattern(id)}"[\\s\\S]*?class="hub-asset"[^>]*href="([^"]+)"`))?.[1];
const u3CardHref=(html,id)=>html.match(new RegExp(`data-hub-card="${u3Pattern(id)}">[\\s\\S]*?class="hub-asset"[^>]*href="([^"]+)"`))?.[1];
const u3HostedChart=html=>html.match(/<section class="trading-chart trading-chart-hosted"[\s\S]*?<\/section>/)?.[0];
class U3Node{
 constructor(dataset={}){this.dataset=dataset;this.attributes={};this.listeners={};this.markup='';this.found={};this.textContent='';this.value='';}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(type,listener){(this.listeners[type]??=[]).push(listener);}
 focus(){}
 set innerHTML(value){this.markup=String(value);this.found={};}
 get innerHTML(){return this.markup;}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 querySelectorAll(selector){
  if(this.parts)return this.parts[selector]??[];
  const name=/^\[data-([a-z]+)\]$/.exec(selector)?.[1];if(!name)return [];
  return this.found[name]??=[...this.markup.matchAll(new RegExp(`data-${name}="([^"]*)"`,'g'))].map(match=>new U3Node({[name]:match[1]}));
 }
}
function u3Dialog(){
 const dialog=new U3Node(),list=new U3Node();dialog.list=list;dialog.open=false;
 dialog.parts={'input':[new U3Node()],'.hub-watch-results':[list],'[role=status]':[new U3Node()],'[type=submit]':[new U3Node()],'form':[new U3Node()],'.p-dialog-close':[new U3Node()],'[data-watch-tab]':[new U3Node({watchTab:'saved'}),new U3Node({watchTab:'search'})]};
 dialog.showModal=()=>{dialog.open=true;};
 dialog.close=()=>{if(!dialog.open)return;dialog.open=false;for(const listener of dialog.listeners.close||[])listener();};
 dialog.remove=()=>{};
 return dialog;
}
function u3Setup(t){
 const names=['location','document','localStorage','requestAnimationFrame','CustomEvent','fetch','WebSocket'],prior=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),hubs=[];
 t.after(()=>{for(const hub of hubs)hub.client.dispose();for(const [name,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
 const define=(name,value)=>Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
 const values=new Map(),events=[],navigations=[];let fetches=0;
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,String(value));},removeItem:key=>{values.delete(key);}};
 define('document',{hidden:true,activeElement:null,body:{dataset:{},append(){},contains:()=>false},addEventListener(){},dispatchEvent(event){events.push(event);return true;},createElement:()=>u3Dialog()});
 define('localStorage',{getItem:()=>null});define('requestAnimationFrame',callback=>callback());define('CustomEvent',class{constructor(type,options){this.type=type;this.detail=options?.detail;}});
 define('fetch',async()=>{fetches++;throw Error('no network in this test');});define('WebSocket',undefined);define('location',new URL('http://localhost/?page=markets'));
 const rows=normalizeHubResource('assets',[u3Coin('bitcoin','btc','Bitcoin'),u3Coin('dogecoin','doge','Dogecoin'),u3Coin('other-btc','btc','Another BTC')],U3_NOW).data;
 const research=new MultiResearch();
 // The app saves a Markets star through this same watchlist (product.js passes it to the data center as onSaveWatch).
 const watch=createWatchlist({workspace:{storage,s:{aiSignalWatch:[]},touch(){}},research,go:(page,options)=>navigations.push({page,search:options?.search??null}),refresh(){},notify(){}});
 function hubAt(href){
  globalThis.location=new URL(href,'http://localhost/');
  // The data center hands the Markets page the saved keys from the shared list.
  const hub=createMarketHub({root:{},rerender(){},notify(){},saved:{assets:JSON.parse(storage.getItem('hive.dc.assets')||'[]')},storage});hubs.push(hub);
  hub.client.read=key=>({quality:'fresh',snapshot:{asOf:U3_NOW,receivedAt:U3_NOW,data:key==='assets'?rows:null}});
  return {hub,html:hub.render('markets')};
 }
 function openFromWatchlist(label){
  const dialog=watch.open(),before=navigations.length,firstEvent=events.length;
  const article=[...dialog.list.markup.matchAll(/<article class="hub-watch-result">([\s\S]*?)<\/article>/g)].map(match=>match[1]).find(body=>body.includes('<small>'+label));
  assert.ok(article,'the watchlist shows the saved row '+label);
  const index=article.match(/data-open="(\d+)"/)?.[1];
  if(index===undefined){dialog.close();return {openable:false,navigations:navigations.slice(before)};}
  dialog.list.querySelectorAll('[data-open]').find(button=>button.dataset.open===index).onclick();
  return {openable:true,...navigations.at(-1),navigations:navigations.slice(before),focus:events.slice(firstEvent).filter(event=>event.type==='hive:workbench-focus').map(event=>event.detail)};
 }
 return {storage,rows,research,watch,hubAt,openFromWatchlist,fetches:()=>fetches};
}
test('U3: a watchlist row saved from a Markets row opens that same asset page, which shows it saved and draws the same Binance spot chart',async t=>{
 const u3=u3Setup(t),doge=u3.rows.find(row=>row.id==='dogecoin');
 const href=u3RowHref(u3.hubAt('?page=markets&view=ranking').html,'dogecoin');
 assert.deepEqual(u3Params(href),{page:'markets',asset:'DOGE',coin:'dogecoin'});
 const chart=u3HostedChart(u3.hubAt(href).html);
 assert.ok(chart,'the Markets row opens a page with a hosted chart');
 assert.match(chart,/<strong>DOGE\/USDT<\/strong><span>Binance · (?:现货|Spot) · /);assert.match(chart,/symbol=BINANCE%3ADOGEUSDT/);
 assert.equal(hostedChartSymbol({...hubCandleIdentity(doge),hostedMarket:true}),'BINANCE:DOGEUSDT');
 await u3.watch.save(doge,false);
 const opened=u3.openFromWatchlist('Dogecoin');
 assert.equal(opened.page,'markets');assert.deepEqual(u3Params(opened.search),u3Params(href));
 const page=u3.hubAt(opened.search);
 assert.equal(u3HostedChart(page.html),chart);
 // The excerpt names the chart market only while the price itself comes from that venue.
 assert.ok(page.hub.sourceSnapshot().text.startsWith('DOGE: 100 USD; assetId=dogecoin; market=aggregate; quote=USD;'));
 const identity=hubCandleIdentity(doge),live=normalizeHubTicker({symbol:'DOGEUSDT',lastPrice:'0.2',openPrice:'0.19',quoteVolume:'5',closeTime:U3_NOW},U3_NOW),quote=page.hub.client.quote;
 page.hub.client.quote=asset=>asset.id==='dogecoin'?live:quote(asset);
 assert.ok(page.hub.sourceSnapshot().text.includes(`market=${identity.market}; venue=${identity.venueId}; type=${ORDER_MARKETS[identity.profileId].marketType}; 24h`));
 assert.match(u3.hubAt('?page=markets&view=ranking').html,/data-hub-watch="dogecoin" aria-label="[^"]*" aria-pressed="true"/);
 assert.equal(u3.fetches(),0);
});
test('U3: a watchlist row for a research asset opens the workbench on the same Binance spot market the Markets row charts',async t=>{
 const u3=u3Setup(t),btc=u3.rows.find(row=>row.id==='bitcoin');
 const href=u3RowHref(u3.hubAt('?page=markets&view=ranking').html,'bitcoin');
 assert.deepEqual(u3Params(href),{page:'markets',asset:'BTC',coin:'bitcoin'});
 assert.match(u3HostedChart(u3.hubAt(href).html),/<strong>BTC\/USDT<\/strong>/);
 await u3.watch.save(btc,false);
 const opened=u3.openFromWatchlist('Bitcoin');
 assert.deepEqual(opened.navigations,[{page:'workbench',search:null}]);assert.deepEqual(opened.focus,['BTC']);
 const workbench=workbenchInsights({task:u3.research.task(opened.focus[0])}).marketConfig,markets=hubCandleIdentity(btc);
 assert.deepEqual(candleRequest(workbench),candleRequest({...markets,period:workbench.period}));
 assert.equal(candleRequest(workbench).symbol,'BTCUSDT');
 assert.equal(u3.fetches(),0);
});
test('U3: a contract watchlist row and its Markets card open the same contract page, which names the saved chain, contract and venue, keeps an unnamed venue unknown and draws no candle chart',async t=>{
 const u3=u3Setup(t),[pepe]=normalizeDexAssets([u3Pair()],U3_CA,U3_NOW);
 await u3.watch.save(pepe,false);
 const href=u3CardHref(u3.hubAt('?page=markets&view=watchlist').html,pepe.id);
 assert.deepEqual(u3Params(href),{page:'markets',asset:'PEPE',coin:pepe.id});
 const opened=u3.openFromWatchlist('Pepe');
 assert.equal(opened.page,'markets');assert.deepEqual(u3Params(opened.search),u3Params(href));
 const {hub,html}=u3.hubAt(opened.search);
 assert.match(html,new RegExp(`class="hub-contract"><b>Ethereum</b><code>${U3_CA}</code>`));
 assert.match(html,/<span>(?:交易平台|Trading venue)<\/span><strong>uniswap<\/strong>/);
 assert.doesNotMatch(html,/data-trading-chart=/);assert.equal(hubCandleIdentity(pepe),null);
 assert.ok(hub.sourceSnapshot().text.startsWith(`PEPE: 0.00001 USD; chain=ethereum; contract=${U3_CA}; venue=uniswap;`));
 const [unnamed]=normalizeDexAssets([u3Pair({dexId:undefined})],U3_CA,U3_NOW);
 await u3.watch.save(unnamed,false);
 const excerpt=u3.hubAt(opened.search).hub.sourceSnapshot().text;
 assert.ok(excerpt.startsWith(`PEPE: 0.00001 USD; chain=ethereum; contract=${U3_CA}; venue=${String.fromCharCode(0x2014)};`),excerpt);
 assert.equal(u3.fetches(),0);
});
test('U3: a same-symbol coin or a saved key without asset details never opens the Binance chart or research workbench of another asset',async t=>{
 const u3=u3Setup(t),impostor=u3.rows.find(row=>row.id==='other-btc');
 const href=u3RowHref(u3.hubAt('?page=markets&view=ranking').html,'other-btc');
 assert.deepEqual(u3Params(href),{page:'markets',asset:'BTC',coin:'other-btc'});
 assert.equal(hubCandleIdentity(impostor),null);assert.doesNotMatch(u3.hubAt(href).html,/data-trading-chart=/);
 await u3.watch.save(impostor,false);
 const opened=u3.openFromWatchlist('Another BTC');
 assert.equal(opened.page,'markets');assert.deepEqual(u3Params(opened.search),u3Params(href));assert.deepEqual(opened.focus,[]);
 assert.doesNotMatch(u3.hubAt(opened.search).html,/data-trading-chart=/);
 u3.storage.setItem('hive.dc.assets',JSON.stringify([...JSON.parse(u3.storage.getItem('hive.dc.assets')),'coin:missing-coin']));
 const missing=u3.openFromWatchlist('missing-coin');
 assert.equal(missing.openable,false);assert.deepEqual(missing.navigations,[]);
 assert.equal(u3.fetches(),0);
});
