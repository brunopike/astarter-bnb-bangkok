import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {publicQuery,publicDataURL,validatePublicEnvelope,currentPublicEnvelope,createPublicDataClient,publicRetryDelay} from './public-data-client.mjs';
import {handlePublicData} from './public-data-proxy.mjs';
import {createPublicDataViews,publicDataStatus,publicMarketRows,publicNewsRecords,publicCapabilityView,safePublicURL,publicEmptyNewsConfirmed} from './public-data-views.mjs';
import {localeReady,pair} from './locale.mjs';
await localeReady;
const fixture=JSON.parse(await readFile(new URL('./test-fixtures/public-data-v1.json',import.meta.url)));
const copy=v=>structuredClone(v);
const market=(key='market_fresh',version=7,ids=['bitcoin','ethereum','solana'])=>{const b=copy(fixture[key].body);b.selection_version=version;b.items=b.items.filter(i=>ids.includes(i.subject_id));b.coverage.requested_subjects=ids;b.coverage.returned_subjects=b.items.map(i=>i.subject_id);b.coverage.gaps=ids.filter(id=>!b.coverage.returned_subjects.includes(id));return b;};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('Retry-After accepts seconds and HTTP dates without exposing arbitrary upstream text',()=>{
 const now=Date.UTC(2026,10,2);
 assert.equal(publicRetryDelay('15',now),15000);
 assert.equal(publicRetryDelay(new Date(now+20000).toUTCString(),now),20000);
 assert.equal(publicRetryDelay('0',now),0);
 for(const value of [null,'','not-a-date','-5','9999999999999999999999999'])assert.equal(publicRetryDelay(value,now),null);
});

test('failed reads retain original facts and manual retries cannot bypass Retry-After',async()=>{
 let now=0,calls=0;
 const client=createPublicDataClient({now:()=>now,fetchImpl:async url=>{
  calls++;const u=new URL(url,'http://localhost'),v=Number(u.searchParams.get('selection_version'));
  if(calls===2)return new Response('{}',{status:503,headers:{'Retry-After':'12'}});
  return json(market('market_fresh',v,u.searchParams.get('asset_ids').split(',')));
 }});
 await client.load('markets',{selection_version:1});const asOf=client.read('markets').snapshot.as_of_ms;
 await client.load('markets',{selection_version:2});assert.equal(client.read('markets').retryIn,12);
 assert.equal(client.read('markets').snapshot.as_of_ms,asOf);assert.equal(client.read('markets').snapshot.quality,'stale');
 await client.load('markets',{selection_version:3});assert.equal(calls,2);
 now=12000;await client.load('markets',{selection_version:4});assert.equal(calls,3);assert.equal(client.read('markets').error,null);assert.equal(client.read('markets').retryIn,0);
});

test('failure backoff is bounded and does not block a different asset identity',async()=>{
 let now=0,calls=0;
 const client=createPublicDataClient({now:()=>now,fetchImpl:async()=>{calls++;throw new Error('synthetic upstream failure');}});
 await client.load('markets',{asset_ids:'bitcoin'});assert.equal(client.read('markets').retryIn,2);
 await client.load('markets',{asset_ids:'bitcoin'});assert.equal(calls,1);
 now=2000;await client.load('markets',{asset_ids:'bitcoin'});assert.equal(client.read('markets').retryIn,4);
 await client.load('markets',{asset_ids:'ethereum'});assert.equal(calls,3);assert.equal(client.read('markets').snapshot,null);assert.equal(client.read('markets').retryIn,2);
 for(const wait of [4,8,16,30,30]){now+=client.read('markets').retryIn*1000;await client.load('markets',{asset_ids:'ethereum'});assert.equal(client.read('markets').retryIn,wait);}
});

test('partial provider cooldown also limits manual refresh without dropping the last usable data',async()=>{
 let now=0,calls=0;const sample=market('market_partial',1);sample.sources[0].retry_after_seconds=9;
 const client=createPublicDataClient({now:()=>now,fetchImpl:async()=>{calls++;return json(sample);}});
 await client.load('markets',{selection_version:1});assert.equal(client.read('markets').error,null);assert.equal(client.read('markets').snapshot.items.length,2);assert.equal(client.read('markets').retryIn,9);
 await client.load('markets',{selection_version:1});assert.equal(calls,1);
 now=9000;await client.load('markets',{selection_version:1});assert.equal(calls,2);assert.equal(client.read('markets').snapshot.as_of_ms,sample.as_of_ms);
});

test('public query accepts only the frozen resources and exact filters',()=>{
 assert.equal(publicDataURL('news',{selection_version:7,limit:50}),'/api/market-hub?resource=news&selection_version=7&limit=50');
 assert.equal(publicQuery('markets').asset_ids,'bitcoin,ethereum,solana');
 assert.deepEqual(publicQuery('capabilities',{provider_id:'etherscan',chain_id:'56'}),{selection_version:0,provider_id:'etherscan',chain_id:'56'});
 for(const [r,q] of [['markets',{asset_ids:'bitcoin,bitcoin'}],['markets',{asset_ids:'WBTC'}],['markets',{account:'SIM-01'}],['news',{limit:0}],['news',{limit:51}],['news',{selection_version:2147483648}],['news',{selection_version:'1.0'}],['capabilities',{provider_id:'other'}],['capabilities',{provider_id:'etherscan',chain_id:'999'}]])assert.throws(()=>publicQuery(r,q),/INVALID_QUERY/);
 assert.throws(()=>publicQuery('markets',new URLSearchParams('asset_ids=bitcoin&asset_ids=ethereum')),/INVALID_QUERY/);
});

test('frozen success, partial, stale and unavailable keep distinct evidence',()=>{
 for(const key of ['market_fresh','market_partial','market_stale','market_unavailable']){
  const b=validatePublicEnvelope(market(key),'markets',{selection_version:7});
  assert.equal(b.quality,fixture[key].body.quality);assert.equal(b.mode,'offline_fixture');assert.equal(b.real_trading_connected,false);
 }
 assert.deepEqual(validatePublicEnvelope(market('market_unavailable'),'markets',{selection_version:7}).items,[]);
 assert.deepEqual(market('market_partial').coverage.gaps,['solana']);
});

test('public response rejects execution bindings, tenant changes, currency confusion and old selections',()=>{
 const variants=[b=>b.real_trading_connected=true,b=>b.execution_binding='PAPER',b=>b.tenant_scope='PRIVATE',b=>b.mode='demo',b=>b.projection_version='unknown',b=>b.selection_version=6,b=>b.items[0].data.instrument.quote_asset='USD',b=>b.items[0].data.instrument.market_kind='PERP',b=>b.items[0].subject_id='wrapped-bitcoin',b=>b.items[0].data.last_price=60000,b=>b.items[0].data.price_change_pct='NaN',b=>b.items.push(copy(b.items[0]))];
 for(const mutate of variants){const b=market();mutate(b);assert.throws(()=>validatePublicEnvelope(b,'markets',{selection_version:7}),/DATA_RESPONSE_INVALID/);}
});

test('expiry and read failure do not invent fresh timestamps or zero values',()=>{
 const b=market(),asOf=b.as_of_ms,until=b.items[0].valid_until_ms;
 const stale=currentPublicEnvelope(b,until+1);
 assert.equal(stale.quality,'stale');assert.equal(stale.as_of_ms,asOf);assert.equal(stale.items[0].data.price_change_pct,null);
 const failed=currentPublicEnvelope(b,0,true);assert.equal(failed.quality,'stale');assert.equal(failed.items[0].quality,'stale');
 assert.equal(b.quality,'fresh');assert.equal(b.items[0].quality,'fresh');
});

test('a successful empty news query becomes stale after failure or 60 seconds without inventing no-news evidence',()=>{
 const b=market();b.coverage={scope:'NEWS_FEED',limit:20};b.items=[];
 assert.equal(currentPublicEnvelope(b,b.as_of_ms+59000).quality,'fresh');
 assert.equal(currentPublicEnvelope(b,b.as_of_ms+60001).quality,'stale');
 assert.equal(currentPublicEnvelope(b,b.as_of_ms+1000,true).quality,'stale');
 assert.equal(currentPublicEnvelope(b,b.as_of_ms+60001).as_of_ms,b.as_of_ms);
 assert.equal(publicEmptyNewsConfirmed({snapshot:b}),true);
 assert.equal(publicEmptyNewsConfirmed({snapshot:currentPublicEnvelope(b,b.as_of_ms+60001)}),false);
 assert.equal(publicEmptyNewsConfirmed({snapshot:b,error:'DATA_SERVICE_UNAVAILABLE'}),false);
 assert.equal(publicEmptyNewsConfirmed({snapshot:{...b,as_of_ms:null}}),false);
 const missing={...b,quality:'unavailable',as_of_ms:null,sources:[]};assert.equal(currentPublicEnvelope(missing,b.as_of_ms+60001,true).quality,'unavailable');
});

test('the optional API image_url is accepted without changing the asset or its market identity',()=>{
 const b=market('market_fresh',1,['bitcoin']);b.items=[copy(fixture.asset_item)];b.items[0].data.image_url='https://coin-images.coingecko.com/coins/images/1/small/bitcoin.png?1696501400';
 assert.equal(validatePublicEnvelope(b,'assets',{asset_ids:'bitcoin',selection_version:1}).items[0].data.image_url,b.items[0].data.image_url);
 const bad=copy(b);bad.items[0].data.image_url='https://arbitrary.test/logo.png';assert.throws(()=>validatePublicEnvelope(bad,'assets',{asset_ids:'bitcoin',selection_version:1}),/DATA_RESPONSE_INVALID/);
 const html=publicMarketRows({snapshot:market('market_fresh',1,['bitcoin'])},{snapshot:b});assert.match(html,/coin-images\.coingecko\.com\/coins\/images\/1\/small\/bitcoin.png/);assert.match(html,/referrerpolicy="no-referrer"/);
});

test('default proxy and client deadlines leave room for the BFF six-second batch budget',async()=>{
 const native=globalThis.setTimeout,delays=[];globalThis.setTimeout=(_fn,ms)=>{delays.push(ms);return 0;};
 try{
  const res=responseRecorder();await handlePublicData(request('/api/v1/data/markets?selection_version=7'),res,{fetchImpl:async()=>json(market())});
  const client=createPublicDataClient({fetchImpl:async()=>json(market('market_fresh',0))});await client.load('markets');
  assert.deepEqual(delays,[7000,8000]);assert.equal(res.status,200);assert.equal(client.read('markets').error,null);
 }finally{globalThis.setTimeout=native;}
});

test('empty news followed by a 503 cannot retain a fresh empty-feed conclusion',async()=>{
 let calls=0;const b=market('market_fresh',1);b.coverage={scope:'NEWS_FEED',limit:20};b.items=[];
 const client=createPublicDataClient({fetchImpl:async()=>++calls===1?json(b):json(fixture.proxy_error.body,503),now:()=>b.as_of_ms+1000});
 await client.load('news',{selection_version:1});assert.equal(client.read('news').snapshot.quality,'fresh');
 await client.load('news',{selection_version:2});assert.equal(client.read('news').snapshot.quality,'stale');assert.equal(client.read('news').snapshot.as_of_ms,b.as_of_ms);
});

test('same in-flight public read is deduplicated and never sends credentials',async()=>{
 const d=deferred();let calls=0,seen;
 const client=createPublicDataClient({fetchImpl:(url,options)=>{calls++;seen={url,options};return d.promise;},now:()=>0});
 const p=client.load('markets',{selection_version:7}),p2=client.load('markets',{selection_version:7});
 assert.equal(p,p2);assert.equal(calls,1);assert.equal(seen.options.method,'GET');assert.equal(seen.options.credentials,'omit');
 assert.equal(new URL(seen.url,'http://localhost').pathname,'/api/v1/data/markets');
 d.resolve(json(market()));await p;assert.equal(client.read('markets').snapshot.items.length,3);assert.equal(client.read('markets').pending,false);
});

test('late success and late failure cannot overwrite a newer asset or clear its loading state',async()=>{
 const a=deferred(),b=deferred();let calls=0;
 const client=createPublicDataClient({fetchImpl:()=>++calls===1?a.promise:b.promise,now:()=>0});
 const first=client.load('markets',{asset_ids:'bitcoin',selection_version:1});
 const second=client.load('markets',{asset_ids:'ethereum',selection_version:2});
 a.resolve(json(market('market_fresh',1,['bitcoin'])));await first;
 assert.equal(client.read('markets').pending,true);assert.equal(client.read('markets').snapshot,null);
 b.resolve(json(market('market_fresh',2,['ethereum'])));await second;
 assert.equal(client.read('markets').snapshot.items[0].subject_id,'ethereum');
 const old=deferred(),newer=deferred();calls=0;
 const c=createPublicDataClient({fetchImpl:()=>++calls===1?old.promise:newer.promise,now:()=>0});
 const p=c.load('markets',{asset_ids:'bitcoin',selection_version:1}),p2=c.load('markets',{asset_ids:'solana',selection_version:2});
 newer.resolve(json(market('market_fresh',2,['solana'])));await p2;old.reject(new Error('untrusted raw exception'));await p;
 assert.equal(c.read('markets').snapshot.items[0].subject_id,'solana');assert.equal(c.read('markets').error,null);
});

test('refresh failure retains only the same asset and its original source time',async()=>{
 let calls=0;const client=createPublicDataClient({fetchImpl:async()=>++calls===1?json(market('market_fresh',1,['bitcoin'])):json(fixture.proxy_error.body,503),now:()=>0});
 await client.load('markets',{asset_ids:'bitcoin',selection_version:1});
 const sourceTime=client.read('markets').snapshot.as_of_ms;
 await client.load('markets',{asset_ids:'bitcoin',selection_version:2});
 const retained=client.read('markets');assert.equal(retained.error,'DATA_SERVICE_UNAVAILABLE');assert.equal(retained.snapshot.quality,'stale');assert.equal(retained.snapshot.as_of_ms,sourceTime);
 await client.load('markets',{asset_ids:'ethereum',selection_version:3});assert.equal(client.read('markets').snapshot,null);
});

test('empty, invalid JSON, foreign schema and offline service never fall back to fixtures',async()=>{
 for(const response of [json(fixture.proxy_error.body,503),new Response('<html>secret example</html>'),json({items:[]})]){
  const client=createPublicDataClient({fetchImpl:async()=>response});await client.load('markets');
  assert.equal(client.read('markets').snapshot,null);assert.ok(client.read('markets').error);assert.doesNotMatch(JSON.stringify(client.read('markets').error),/secret/);
 }
});

test('contract fixtures stay visibly offline; missing percent never becomes zero percent',()=>{
 const s={snapshot:market(),pending:false,error:null};
 assert.ok(publicDataStatus(s).includes(pair('离线测试样本','Offline test fixture')));assert.doesNotMatch(publicDataStatus(s),/实时只读|Live read-only/);
 const html=publicMarketRows(s,{snapshot:null});assert.match(html,/60,000/);assert.doesNotMatch(html,/0\.00%/);
 const offline=publicDataStatus({...s,offline:true});assert.match(offline,/网络已断开|Network offline/);assert.match(offline,/data-quality="unavailable"/);assert.equal(s.snapshot.quality,'fresh');
 assert.doesNotMatch(publicMarketRows({snapshot:market('market_unavailable')},{snapshot:null}),/60,000|81230/);
});

test('news escapes headlines, omits publisher body and accepts only credential-free HTTPS source links',()=>{
 const item=copy(fixture.news_item);item.data.title='<img src=x onerror=alert(1)>';item.data.summary='<script>bad()</script>';item.data.url='javascript:alert(1)';
 const html=publicNewsRecords([item]);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/bad\(\)|&lt;script|<img|<script|href="javascript:/);
 assert.equal(safePublicURL('https://name:password@example.com'),null);assert.equal(safePublicURL('http://example.com'),null);assert.equal(safePublicURL('https://example.com/news'),'https://example.com/news');
});

test('chain capability UI separates a paid block query from an available ABI on BSC',()=>{
 const rows=fixture.explorer_capability_items.filter(d=>d.chain_id==='56').map((data,i)=>({record_id:'cap-'+i,data}));
 const html=publicCapabilityView({snapshot:{mode:'offline_fixture',quality:'partial',as_of_ms:null,items:rows}},'56');
 assert.match(html,/需额外套餐|Additional plan required/);assert.match(html,/已测可用|Verified available/);assert.match(html,/BSC/);assert.doesNotMatch(html,/整链不支持|chain unsupported/i);
});

test('live explorer displays the observed block and distinguishes RPC fallback from a restricted Etherscan API',()=>{
 const rows=fixture.explorer_capability_items.filter(d=>d.chain_id==='56').map(d=>({data:{...d,...(d.capability_id==='contract.abi'?{abi_function_count:16}:{block_provider:'publicnode',block_height:12345678})}}));
 const html=publicCapabilityView({snapshot:{mode:'live_readonly',coverage:{scope:'LIVE_EXPLORER_CAPABILITIES'},items:rows}},'56');
 assert.match(html,/#12,345,678/);assert.match(html,/PublicNode/);assert.match(html,/Etherscan · (需额外套餐|Additional plan required)/);assert.match(html,/Multicall3 · 16/);
});

test('the actual read-side view and companion consume the same response without a fixed demo date',async()=>{
 const oldLocation=globalThis.location,oldDocument=globalThis.document;
 try{
  globalThis.location={search:'?page=markets&data=live&asset=BTC'};globalThis.document={activeElement:null,querySelector:()=>null};
  const root={contains:()=>false,querySelectorAll:()=>[],querySelector:()=>null};let requests=0;
  const view=createPublicDataViews({root,rerender:()=>{},now:()=>0,fetchImpl:async url=>{requests++;const u=new URL(url,'http://localhost'),b=market('market_fresh',Number(u.searchParams.get('selection_version')),['bitcoin']);return json(b);}});
  view.render('markets');await view.client.load('markets',{asset_ids:'bitcoin',selection_version:1});
  const html=view.render('markets'),brief=view.companionBrief(0);
  assert.match(html,/60,000/);assert.equal(brief.modeLabel,pair('离线测试样本','Offline fixture'));assert.notEqual(brief.timestamp,'2026-10-24 14:00');assert.match(brief.href,/data=live/);assert.doesNotMatch(brief.body,/81,230|合约持仓/);
  const beforeUnsupported=requests;globalThis.location.search='?page=markets&data=live&asset=WBTC';const unsupported=view.render('markets');view.bind();assert.match(unsupported,/尚未接入|not covered/);assert.equal(requests,beforeUnsupported);
  globalThis.location.search='?page=markets&data=demo';assert.equal(view.render('markets'),null);assert.equal(view.companionBrief(0),null);
 }finally{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});

const request=(url,options={})=>({url,method:'GET',headers:{host:'127.0.0.1:4188',...options.headers},...options});
function responseRecorder(){return {status:null,headers:{},body:'',writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body||'';}};}

test('proxy preserves valid retry guidance while keeping upstream failures sanitized',async()=>{
 for(const status of [429,503]){
  const res=responseRecorder();await handlePublicData(request('/api/v1/data/markets'),res,{fetchImpl:async()=>new Response('synthetic-private-upstream',{status,headers:{'Retry-After':'25'}})});
  assert.equal(res.status,503);assert.equal(res.headers['Retry-After'],'25');assert.doesNotMatch(res.body,/private-upstream/);
 }
 const bad=responseRecorder();await handlePublicData(request('/api/v1/data/markets'),bad,{fetchImpl:async()=>new Response('',{status:503,headers:{'Retry-After':'synthetic-secret'}})});
 assert.equal(bad.headers['Retry-After'],undefined);assert.doesNotMatch(bad.body,/synthetic-secret/);
});

test('the refresh control respects cooldown and hidden pages do not issue reads',async()=>{
 const oldLocation=globalThis.location,oldDocument=globalThis.document;
 try{
  globalThis.location={search:'?page=markets&data=live'};globalThis.document={activeElement:null,hidden:true,querySelector:()=>null};
  let now=0,requests=0,click;const button={addEventListener:(type,handler)=>{if(type==='click')click=handler;}};
  const root={contains:()=>false,querySelectorAll:()=>[],querySelector:selector=>selector==='[data-pd-refresh]'?button:null};
  const view=createPublicDataViews({root,now:()=>now,rerender(){},fetchImpl:async()=>{requests++;return new Response('{}',{status:503,headers:{'Retry-After':'30'}});}});
  view.render('markets');view.tick('markets',1);assert.equal(requests,0);
  globalThis.document.hidden=false;view.render('markets');await view.client.load('markets',{selection_version:1});
  const html=view.render('markets');assert.equal(requests,2);assert.match(html,/自动重试 · 30s|Auto retry · 30s/);assert.match(html,/aria-busy="false" disabled/);
  view.bind();click();assert.equal(requests,2);
  now=30000;click();assert.equal(requests,4);view.client.clear();
 }finally{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});

test('the displayed data quality updates on expiry even while the next read is still pending',async()=>{
 const oldLocation=globalThis.location,oldDocument=globalThis.document;
 try{
  const sample=market('market_fresh',1);let now=sample.as_of_ms,paints=0;
  globalThis.location={search:'?page=markets&data=live'};globalThis.document={activeElement:null,querySelector:()=>null};
  const root={contains:()=>false,querySelectorAll:()=>[],querySelector:()=>null};
  const view=createPublicDataViews({root,now:()=>now,rerender(){paints++;},fetchImpl:async url=>{const u=new URL(url,'http://localhost');return u.pathname.endsWith('/markets')?json(sample):new Response('{}',{status:503,headers:{'Retry-After':'300'}});}});
  view.render('markets');await view.client.load('markets',{selection_version:1});view.render('markets');const before=paints;
  now=Math.max(...sample.items.map(i=>i.valid_until_ms))+1;view.tick('markets',1);
  assert.ok(paints>before);assert.equal(view.client.read('markets').snapshot.quality,'stale');assert.equal(view.client.read('markets').snapshot.as_of_ms,sample.as_of_ms);view.client.clear();
 }finally{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});

test('proxy permits only four GET routes and rejects bad hosts, methods and query keys before fetching',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;throw new Error('must not fetch');};
 for(const [req,status] of [[request('/api/v1/data/markets?asset_ids=bitcoin,bitcoin'),400],[request('/api/v1/data/markets?url=https://evil.test'),400],[request('/api/v1/data/private'),404],[request('/api/v1/data/markets',{method:'POST'}),405],[request('/api/v1/data/markets',{headers:{host:'evil.test'}}),403],[request('/api/v1/data/markets',{headers:{host:'127.0.0.1:4188',origin:'https://evil.test'}}),403]]){
  const res=responseRecorder();await handlePublicData(req,res,{fetchImpl});assert.equal(res.status,status);
 }
 assert.equal(calls,0);
});

test('proxy pins loopback destination and Origin and strips all incoming private headers',async()=>{
 const res=responseRecorder();let target,options;
 await handlePublicData(request('/api/v1/data/markets?selection_version=7',{headers:{host:'localhost:4188',authorization:'Bearer synthetic-secret',cookie:'private=synthetic','x-forwarded-host':'evil.test','x-forwarded-proto':'https',forwarded:'host=evil.test'}}),res,{fetchImpl:async(u,o)=>{target=u;options=o;return json(market());}});
 assert.equal(res.status,200);assert.equal(target.origin,'http://127.0.0.1:8765');assert.equal(target.pathname,'/v1/data/markets');assert.equal(options.redirect,'manual');
 assert.deepEqual(options.headers,{Accept:'application/json',Origin:'http://127.0.0.1:4188'});assert.doesNotMatch(res.body,/synthetic-secret|private=|evil\.test/);
});

test('proxy sanitizes failures, refuses redirects and bounds response size',async()=>{
 for(const fetchImpl of [async()=>{throw new Error('synthetic-secret in an upstream URL');},async()=>new Response(null,{status:302,headers:{Location:'http://evil.test'}}),async()=>json({debug:'synthetic-secret'}),async()=>new Response('x'.repeat(500),{headers:{'Content-Type':'application/json'}})]){
  const res=responseRecorder();await handlePublicData(request('/api/v1/data/markets'),res,{fetchImpl,maxBytes:200});
  assert.ok([500,503].includes(res.status));assert.doesNotMatch(res.body,/synthetic-secret|evil\.test|xxxxxxxx/);assert.equal(JSON.parse(res.body).schema_version,'AstarterPublicDataError.v1');
 }
});

test('proxy and client abort reads at the deadline without exposing the underlying error',async()=>{
 const wait=(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('synthetic-sensitive-error')),{once:true}));
 const res=responseRecorder();await handlePublicData(request('/api/v1/data/markets'),res,{fetchImpl:wait,timeoutMs:5});assert.equal(res.status,503);
 const client=createPublicDataClient({fetchImpl:wait,timeoutMs:5});await client.load('markets');assert.equal(client.read('markets').error,'DATA_TIMEOUT');assert.equal(client.read('markets').pending,false);
});

test('first read-only render starts its requests and shows loading immediately',()=>{
 const oldLocation=globalThis.location,oldDocument=globalThis.document;
 try{
  globalThis.location={search:'?page=markets&data=live'};globalThis.document={activeElement:null,querySelector:()=>null};
  let requests=0;const never=(_url,{signal})=>{requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));};
  const root={contains:()=>false,querySelectorAll:()=>[],querySelector:()=>null};
  const view=createPublicDataViews({root,rerender(){},fetchImpl:never});
  const html=view.render('markets');assert.equal(requests,2);assert.match(html,/正在读取|Loading/);assert.match(html,/data-pd-refresh aria-busy="true" disabled/);
  view.client.clear();
 }finally{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});


test('public refresh shares the saved cadence, rolls back storage failures and preserves source and focus',async t=>{
 const prior=new Map(['document','location','window','CustomEvent','localStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 t.after(()=>{for(const [key,descriptor]of prior)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
 const start=fixture.market_fresh.body.requested_at_ms;
 let now=start,view,paints=0,holding=false;
 const requests=[],pending=[],asked=[],notices=[],events=new Map(),storageMap=new Map();
 const body={};
 globalThis.document={hidden:false,body,activeElement:body,querySelector:()=>null};
 globalThis.location={search:'?page=markets&data=live&asset=BTC'};
 globalThis.window={
  addEventListener(name,fn){if(!events.has(name))events.set(name,[]);events.get(name).push(fn);},
  dispatchEvent(event){for(const fn of events.get(event.type)||[])fn(event);return true;}
 };
 if(!globalThis.CustomEvent)globalThis.CustomEvent=class{constructor(type,{detail}={}){this.type=type;this.detail=detail;}};
 const storage={
  fail:false,getItem:key=>storageMap.get(key)??null,
  setItem(key,value){if(this.fail)throw Error('storage denied');storageMap.set(key,String(value));}
 };
 globalThis.localStorage=storage;
 const listeners=new Map();
 const button={disabled:false,matches:()=>false,addEventListener(type,fn){listeners.set('button:'+type,fn);},focus(){document.activeElement=this;}};
 const select={value:'60',matches:()=>false,addEventListener(type,fn){listeners.set('interval:'+type,fn);}};
 const ask={addEventListener(type,fn){listeners.set('ask:'+type,fn);}};
 const uiRoot={
  contains:el=>[button,select,ask].includes(el),querySelectorAll:()=>[],
  querySelector:selector=>selector==='[data-pd-refresh]'?button:selector==='[data-pd-refresh]:not(:disabled)'?!button.disabled?button:null:selector==='[data-pd-interval]'?select:selector==='[data-pd-ask]'?ask:null
 };
 const response=url=>{
  const data=structuredClone(fixture.market_fresh.body);
  data.selection_version=Number(url.searchParams.get('selection_version'));
  data.items=data.items.filter(item=>item.subject_id==='bitcoin');
  data.coverage.requested_subjects=['bitcoin'];data.coverage.returned_subjects=['bitcoin'];data.coverage.gaps=[];
  if(url.pathname.endsWith('/assets'))data.items=[structuredClone(fixture.asset_item)];
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
 };
 view=createPublicDataViews({
  root:uiRoot,now:()=>now,notify:text=>notices.push(text),onAskSource:source=>asked.push(source),
  rerender(){
   paints++;const html=view.render('markets');
   button.disabled=/data-pd-refresh[^>]*\bdisabled\b/.test(html);
   if(button.disabled&&document.activeElement===button)document.activeElement=body;
  },
  fetchImpl:input=>{
   const url=new URL(input,'http://localhost');requests.push(url);
   return holding?new Promise(resolve=>pending.push(()=>resolve(response(url)))):Promise.resolve(response(url));
  }
 });
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const marketRequests=()=>requests.filter(url=>url.pathname.endsWith('/markets')).length;
 view.render('markets');await settle();await settle();view.bind();
 const first=view.sourceSnapshot(),data=JSON.parse(first.text);
 assert.equal(data.as_of_ms,fixture.market_fresh.body.as_of_ms);
 assert.deepEqual(data.items,fixture.market_fresh.body.items.filter(item=>item.subject_id==='bitcoin'));
 assert.equal(data.offline,false);
 listeners.get('ask:click')();assert.equal(asked.length,1);assert.equal(asked[0].href,location.search);
 assert.equal(marketRequests(),1);
 now=start+59999;view.tick('markets',1);assert.equal(marketRequests(),1);
 now=start+60001;view.tick('markets',1);await settle();assert.equal(marketRequests(),2);
 select.value='30';listeners.get('interval:change')({target:select});
 assert.equal(storageMap.get('hive.market.refreshSeconds'),'30');
 assert.ok(view.render('markets').includes('value="30" selected'));
 now+=29999;view.tick('markets',1);assert.equal(marketRequests(),2);
 now+=2;view.tick('markets',1);await settle();assert.equal(marketRequests(),3);
 storage.fail=true;select.value='15';listeners.get('interval:change')({target:select});
 assert.equal(select.value,'30');assert.equal(storageMap.get('hive.market.refreshSeconds'),'30');storage.fail=false;
 holding=true;document.activeElement=button;const before=marketRequests();
 listeners.get('button:click')();assert.ok(button.disabled);assert.equal(document.activeElement,body);
 listeners.get('button:click')();assert.equal(marketRequests(),before+1);
 holding=false;for(const resolve of pending.splice(0))resolve();
 await settle();await settle();
 assert.equal(document.activeElement,button);assert.equal(button.disabled,false);
 assert.equal(JSON.parse(view.sourceSnapshot().text).as_of_ms,data.as_of_ms);
 view.sync('social');assert.equal(view.sourceSnapshot(),null);
 globalThis.location.search='?page=markets&data=live&asset=WBTC';
 assert.match(view.render('markets'),/data-pd-ask disabled/);assert.equal(view.sourceSnapshot(),null);
 view.client.clear();
});
