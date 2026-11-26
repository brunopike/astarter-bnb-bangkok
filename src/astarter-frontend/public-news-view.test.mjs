import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPublicDataViews,publicDataModebar,publicNewsRecords,publicSentimentCard,safePublicURL} from './public-data-views.mjs';
import {currentIntelligenceRoute} from './product-data.mjs';
import {safePublicURL as sharedSafePublicURL} from './public-data-client.mjs';

const fixture=JSON.parse(readFileSync(new URL('./test-fixtures/public-data-v1.json',import.meta.url),'utf8'));
const NOW=Date.UTC(2026,10,17,12),DAY=Date.UTC(2026,10,17),copy=value=>structuredClone(value);
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function newsEnvelope(selection=1){
 const body=copy(fixture.market_fresh.body),item=copy(fixture.news_item);
 Object.assign(item,{provider_id:'coindesk-rss-v1',quality:'fresh',event_time_ms:NOW-60000,received_at_ms:NOW,available_at_ms:NOW,valid_until_ms:NOW+60000});
 Object.assign(item.data,{title:'Ethereum and Solana market update',summary:'PRIVATE_TEST_SUMMARY_MUST_NOT_APPEAR',url:'https://www.coindesk.com/markets/2026/11/17/example',published_at_ms:NOW-60000,asset_ids:[],symbols:['ETH','SOL','SPX']});
 return {...body,selection_version:selection,mode:'live_readonly',quality:'fresh',as_of_ms:NOW-60000,requested_at_ms:NOW,coverage:{scope:'NEWS_FEED',limit:20},sources:[{provider_id:'coindesk-rss-v1',status:'OK',last_success_at_ms:NOW,reason_code:null,retry_after_seconds:null}],items:[item]};
}
function sentimentEnvelope(value='37',asOf=DAY,receivedAt=NOW){return {schema:'public-market-relay-v1',resource:'sentiment',receivedAt,body:{data:[{timestamp:String(asOf/1000),value}]}};}
const isSentiment=url=>url.searchParams.get('resource')==='sentiment';
function harness(t,{search='?page=intelligence',fetchImpl}={}){
 const names=['document','window','location','navigator','localStorage'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),events=new EventTarget(),body={},doc=Object.assign(new EventTarget(),{hidden:false,body,activeElement:body,querySelector:()=>null}),storage=new Map(),calls=[];
 let at=NOW,page='intelligence',html='',view;
 const globals={document:doc,window:events,location:{search},navigator:{onLine:true},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}};
 for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
 const root={contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]};
 view=createPublicDataViews({root,now:()=>at,rerender(){html=view.render(page);},fetchImpl:async(input,init)=>{const url=new URL(input,'https://astarter.imstark.site');calls.push({url,init});return fetchImpl?fetchImpl(url,init):json(isSentiment(url)?sentimentEnvelope():newsEnvelope(Number(url.searchParams.get('selection_version'))));}});
 t.after(()=>{view.dispose?.();view.client.clear();for(const key of names){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 return {view,doc,root,calls,render(value='intelligence'){page=value;html=view.render(page);return html;},get html(){return html;},setNow(value){at=value;}};
}

test('the actual news controller uses live reads by default and keeps markets opt-in',t=>{
 const h=harness(t);const html=h.render();assert.notEqual(html,null,'the default news page must not fall through to fixtures');
 assert.ok(h.calls.some(call=>call.url.searchParams.has('selection_version')),'a real public-news read is requested');
 assert.equal(publicDataModebar('intelligence','?page=intelligence'),'');
 assert.equal(currentIntelligenceRoute('?page=intelligence&data=demo'),'?page=intelligence');
 assert.equal(currentIntelligenceRoute('?page=intelligence&data=demo&view=calendar'),'?page=intelligence&view=calendar');
 assert.equal(currentIntelligenceRoute('?page=intelligence&story=n2&feed=social'),'?page=intelligence&feed=social');
 assert.equal(currentIntelligenceRoute('?page=intelligence&view=economic-data'),null);
 assert.equal(currentIntelligenceRoute('?page=markets&data=demo'),null);
 assert.equal(h.render('markets'),null,'existing market defaults remain unchanged');
});

test('returning to news immediately restores the exact feed, preserves its clocks and respects expiry',async t=>{
 const h=harness(t),newsCalls=()=>h.calls.filter(c=>c.url.searchParams.get('resource')==='news');
 h.render();await settle();await settle();
 assert.equal(h.calls[0].url.searchParams.get('resource'),'news');
 const original=h.view.client.read('news').snapshot;
 assert.equal(newsCalls().length,1);
 assert.equal(h.render('signals'),null);
 const warm=h.render();
 assert.match(warm,/Ethereum and Solana market update/);
 assert.deepEqual(h.view.client.read('news').snapshot,original);
 assert.equal(newsCalls().length,1);
 h.render('signals');h.setNow(NOW+61000);globalThis.navigator.onLine=false;
 const offline=h.render();
 assert.match(offline,/Ethereum and Solana market update/);
 assert.equal(h.view.client.read('news').snapshot.quality,'stale');
 assert.equal(h.view.client.read('news').snapshot.as_of_ms,original.as_of_ms);
 assert.equal(newsCalls().length,1);
 globalThis.navigator.onLine=true;h.view.tick('intelligence',1);await settle();
 assert.equal(newsCalls().length,2);
});

test('typing in the news filter keeps the source timestamp while connectivity changes',async t=>{
 const h=harness(t);h.render();await settle();
 const html=h.html,field={matches:()=>true},updates=[];
 const badge={set outerHTML(value){updates.push(value);}};
 h.root.querySelector=s=>s==='[data-pd-status="news"] .pd-quality'?badge:null;
 h.root.contains=el=>el===field;h.doc.activeElement=field;
 const reads=h.calls.filter(call=>call.url.searchParams.has('selection_version')).length;
 globalThis.navigator.onLine=false;h.view.tick('intelligence',1);h.view.tick('intelligence',1);
 assert.equal(updates.length,1);assert.match(updates[0],/data-quality="unavailable".*(断开|offline)/i);
 assert.equal(h.html,html);assert.equal(h.doc.activeElement,field);
 assert.equal(h.calls.filter(call=>call.url.searchParams.has('selection_version')).length,reads);
 globalThis.navigator.onLine=true;h.setNow(NOW+120000);h.view.tick('intelligence',1);await settle();
 assert.match(updates.at(-1),/data-quality="stale"/);assert.doesNotMatch(updates.at(-1),/<time>/);
});

test('an explicitly selected news demo never starts either public reader',t=>{
 const h=harness(t,{search:'?page=intelligence&data=demo'});assert.equal(h.render(),null);h.view.tick('intelligence',1);assert.equal(h.calls.length,0);assert.equal(h.view.sourceSnapshot(),null);
});

test('loaded news preserves its provider, original URL and multiple asset logos without exporting summaries',async t=>{
 const h=harness(t);h.render();await settle();await settle();const html=h.render();
 assert.match(html,/CoinDesk/);assert.doesNotMatch(html,/BlockBeats|PRIVATE_TEST_SUMMARY_MUST_NOT_APPEAR/);assert.match(html,/Ethereum and Solana market update/);
 assert.match(html,/data-fng-value>37<\/strong>/);assert.match(html,/https:\/\/alternative\.me\/crypto\/fear-and-greed-index\//);
 const article=publicNewsRecords(newsEnvelope().items);assert.match(article,/crypto-icons\/eth\.svg/);assert.match(article,/crypto-icons\/sol\.svg/);assert.match(article,/>SPX<\/span>/);assert.doesNotMatch(article,/crypto-icons\/btc\.svg/);
 assert.match(article,/2026-11-17 19:59:00<\/time>/);
 assert.match(html,/2026-11-17 19:59:00 UTC\+8/);
 const source=h.view.sourceSnapshot(),context=JSON.parse(source.text);assert.equal(context.mode,'live_readonly');assert.equal(context.items[0].provider,'CoinDesk');assert.deepEqual(context.items[0].symbols,['ETH','SOL','SPX']);assert.equal(context.items[0].published_at_ms,NOW-60000);assert.doesNotMatch(source.text,/summary|PRIVATE_TEST_SUMMARY/);
 const brief=h.view.companionBrief(0);assert.match(brief.source,/CoinDesk/);assert.equal(brief.href,newsEnvelope().items[0].data.url);assert.doesNotMatch(brief.body,/PRIVATE_TEST_SUMMARY/);
 assert.equal(h.calls.filter(call=>isSentiment(call.url)).length,1);const news=h.calls.find(call=>call.url.searchParams.get('resource')==='news');assert.ok(news);assert.equal(news.url.origin,'https://astarter.imstark.site');assert.equal(news.url.searchParams.get('selection_version'),'1');assert.equal(news.url.searchParams.get('limit'),'20');assert.ok(h.calls.every(call=>call.init.method===undefined||call.init.method==='GET'));
});

test('news escapes hostile titles and providers, filters tags and permits only safe HTTPS originals',()=>{
 const item=newsEnvelope().items[0];Object.assign(item,{provider_id:'<svg onload=alert(1)>'});Object.assign(item.data,{title:'<img src=x onerror=alert(1)>',summary:'<script>PRIVATE_TEST_SUMMARY</script>',url:'javascript:alert(1)',symbols:['ETH','SOL','ETH','<script>','UNKNOWN'],asset_ids:['solana']});
 const html=publicNewsRecords([item]);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/&lt;svg onload/);assert.doesNotMatch(html,/<script|<svg onload|<img src=x|href="javascript:|PRIVATE_TEST_SUMMARY|UNKNOWN|crypto-icons\/btc\.svg/);
 assert.equal((html.match(/crypto-icons\/sol\.svg/g)||[]).length,1);assert.equal(safePublicURL,sharedSafePublicURL);
 for(const url of ['http://example.test','javascript:alert(1)','https://name:password@example.test'])assert.equal(safePublicURL(url),null);
 const legacy=copy(fixture.news_item);legacy.provider_id='blockbeats-news-v1';legacy.data.asset_ids=['ethereum','solana'];delete legacy.data.symbols;
 const old=publicNewsRecords([legacy]);assert.match(old,/BlockBeats/);assert.match(old,/crypto-icons\/eth\.svg/);assert.match(old,/crypto-icons\/sol\.svg/);assert.doesNotMatch(old,/crypto-icons\/btc\.svg/);
});

test('BTC sentiment distinguishes a genuine zero, missing data and a stale unchanged observation',()=>{
 const state={quality:'fresh',snapshot:{asOf:DAY,receivedAt:NOW,data:[{at:DAY,value:0}]},pending:false,error:null};
 const zero=publicSentimentCard(state);assert.match(zero,/data-fng-value>0<\/strong>/);assert.match(zero,/data-quality="fresh"/);assert.match(zero,/Alternative\.me/);assert.match(zero,/2026-11-17T00:00:00\.000Z/);
 const stale=publicSentimentCard({...state,quality:'stale',pending:true});assert.match(stale,/data-quality="stale"/);assert.match(stale,/过期|Stale/);assert.match(stale,/data-fng-value>0<\/strong>/);assert.match(stale,/2026-11-17T00:00:00\.000Z/);
 const empty=publicSentimentCard({quality:'unavailable',snapshot:null,error:'FETCH_FAILED'});assert.match(empty,/data-fng-value>—<\/strong>/);assert.doesNotMatch(empty,/data-fng-value>0<\/strong>/);assert.match(empty,/指数暂不可用|Index unavailable/);
 for(const value of [null,NaN,-1,101,1.5,'37'])assert.match(publicSentimentCard({...state,snapshot:{...state.snapshot,data:[{at:DAY,value}]}}),/data-fng-value>—<\/strong>/);
});

test('source expiry stays visibly stale and does not renew the sentiment date when the page refreshes',async t=>{
 const h=harness(t);h.render();await settle();await settle();assert.match(h.render(),/data-fng-value>37<\/strong>/);
 h.setNow(DAY+129600001);h.view.tick('intelligence',1);await settle();await settle();const html=h.render();
 assert.match(html,/class="pd-sentiment" data-quality="stale"/);assert.match(html,/过期|Stale/);assert.match(html,/data-fng-value>37<\/strong>/);assert.match(html,/datetime="2026-11-17T00:00:00\.000Z"/);
});

test('an unavailable sentiment source does not erase the independently loaded news or invent a score',async t=>{
 const h=harness(t,{fetchImpl:async url=>isSentiment(url)?json({error:'TEST_DETAIL_MUST_NOT_LEAK'},503):json(newsEnvelope(Number(url.searchParams.get('selection_version'))))});
 h.render();await settle();await settle();const html=h.render();assert.match(html,/Ethereum and Solana market update/);assert.match(html,/CoinDesk/);assert.match(html,/data-fng-value>—<\/strong>/);assert.doesNotMatch(html,/TEST_DETAIL_MUST_NOT_LEAK/);assert.match(html,/Alternative\.me/);
});

test('hiding or leaving news cancels sentiment and ignores its late response without defaulting to demo',async t=>{
 let finish,signal,attempts=0;
 const h=harness(t,{fetchImpl:(url,init)=>{
  if(!isSentiment(url))return json(newsEnvelope(Number(url.searchParams.get('selection_version'))));
  attempts++;if(attempts>1)return json(sentimentEnvelope());signal=init.signal;return new Promise(resolve=>{finish=()=>resolve(json(sentimentEnvelope()));});
 }});
 h.render();await settle();assert.equal(attempts,1);assert.equal(signal.aborted,false);
 h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(signal.aborted,true);finish();await settle();await settle();
 const before=h.calls.length;h.view.tick('intelligence',1);const hidden=h.render();assert.equal(h.calls.length,before);assert.match(hidden,/data-fng-value>—<\/strong>/);
 h.doc.hidden=false;h.doc.dispatchEvent(new Event('visibilitychange'));await settle();await settle();assert.equal(attempts,2);assert.match(h.render(),/data-fng-value>37<\/strong>/);
 globalThis.location.search='?page=intelligence&data=demo';assert.equal(h.render(),null);assert.equal(h.view.sourceSnapshot(),null);assert.equal(h.view.companionBrief(),null);assert.equal(attempts,2);
});

test('bfcache suspension performs no reads until pageshow and terminal pagehide cannot revive readers',async t=>{
 const h=harness(t);h.render();await settle();await settle();
 const event=(type,persisted)=>{const value=new Event(type);Object.defineProperty(value,'persisted',{value:persisted});globalThis.window.dispatchEvent(value);};
 event('pagehide',true);const before=h.calls.length;h.setNow(NOW+120000);h.view.tick('intelligence',1);h.render();assert.equal(h.calls.length,before);
 event('pageshow',true);await settle();await settle();assert.equal(h.calls.filter(call=>isSentiment(call.url)).length,2);assert.match(h.render(),/datetime="2026-11-17T00:00:00\.000Z"/);
 event('pagehide',false);const stopped=h.calls.length;event('pageshow',true);h.view.tick('intelligence',1);assert.equal(h.render(),null);assert.equal(h.calls.length,stopped);
});
