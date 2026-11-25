// Card R1 (source coverage and news wiring): the read-only client keeps "no event" apart from "no data".
// Synthetic envelopes only, see test-fixtures/public-news-v1.json. No vendor content, no live read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {publicQuery,publicDataURL,validatePublicEnvelope,currentPublicEnvelope,createPublicDataClient} from './public-data-client.mjs';
import {createLicensedFeeds} from './licensed-feeds.mjs';
import {BLOCKBEATS_URL} from './public-blockbeats.mjs';
import {PUBLIC_NEWS_SOURCE} from './public-news.mjs';
import {publicEmptyNewsConfirmed} from './public-data-views.mjs';
const fixture=JSON.parse(await readFile(new URL('./test-fixtures/public-news-v1.json',import.meta.url)));
const states=Object.keys(fixture).filter(key=>key!=='notice');
const copy=v=>structuredClone(v);
const news=(key,version=7)=>{const b=copy(fixture[key].body);b.selection_version=version;return b;};
const valid=(key,version=7)=>validatePublicEnvelope(news(key,version),'news',{selection_version:version});
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const clocks=item=>[item.event_time_ms,item.received_at_ms,item.available_at_ms,item.valid_until_ms];
const selection=url=>Number(new URL(url,'http://localhost').searchParams.get('selection_version'));
const T=fixture.news_fresh.body.as_of_ms;

test('every pinned news state passes the client contract with its own evidence',()=>{
 assert.equal(states.length,8);
 for(const key of states){
  const b=valid(key);
  assert.equal(b.quality,fixture[key].body.quality,key);assert.equal(b.mode,'offline_fixture',key);assert.equal(b.real_trading_connected,false,key);
 }
});

test('a missing key, a missing snapshot and a refused key stay unavailable and never read as an empty feed',()=>{
 for(const key of ['news_unconfigured','news_no_snapshot','news_cold_failure']){
  const b=valid(key);
  assert.equal(b.as_of_ms,null,key);assert.deepEqual(b.items,[],key);assert.deepEqual(b.coverage.gaps,['news'],key);
  assert.equal(b.sources.some(s=>s.status==='OK'),false,key);
  for(const [now,failed] of [[T,false],[T+3600000,false],[T,true]]){
   const current=currentPublicEnvelope(b,now,failed);
   assert.equal(current.quality,'unavailable',key);assert.equal(current.as_of_ms,null,key);assert.deepEqual(current.sources,b.sources,key);
  }
 }
 assert.equal(valid('news_unconfigured').sources[0].status,'UNCONFIGURED');
 assert.equal(valid('news_no_snapshot').sources[0].reason_code,'SNAPSHOT_NOT_AVAILABLE');
});

test('a successful empty feed is a different answer from unavailable and ages without losing its time',()=>{
 const empty=valid('news_empty_success');
 assert.equal(empty.quality,'fresh');assert.equal(empty.as_of_ms,T);assert.deepEqual(empty.items,[]);assert.deepEqual(empty.coverage.gaps,[]);
 assert.equal(empty.sources.some(s=>s.status==='OK'&&s.last_success_at_ms===T),true);
 assert.equal(currentPublicEnvelope(empty,T+59000).quality,'fresh');
 const aged=currentPublicEnvelope(empty,T+60001);
 assert.equal(aged.quality,'stale');assert.equal(aged.as_of_ms,T);assert.deepEqual(aged.sources,empty.sources);
 assert.equal(currentPublicEnvelope(empty,T+1000,true).quality,'stale');
 const served=valid('news_empty_aged');
 assert.equal(served.quality,'stale');assert.equal(served.as_of_ms,T);
 assert.equal(currentPublicEnvelope(served,served.requested_at_ms).quality,'stale');
});

test('stale news keeps every original clock, whether the service or the client marks it',()=>{
 const fresh=valid('news_fresh'),retained=valid('news_stale_after_failure');
 assert.equal(retained.quality,'stale');assert.equal(retained.as_of_ms,fresh.as_of_ms);
 assert.deepEqual(retained.items.map(clocks),fresh.items.map(clocks));
 assert.deepEqual(retained.items.map(i=>i.data.published_at_ms),fresh.items.map(i=>i.data.published_at_ms));
 assert.equal(retained.items.every(i=>i.quality==='stale'),true);
 assert.equal(retained.sources[0].status,'RATE_LIMITED');assert.equal(retained.sources[0].last_success_at_ms,fresh.sources[0].last_success_at_ms);
 for(const current of [currentPublicEnvelope(fresh,fresh.items[0].valid_until_ms+1),currentPublicEnvelope(fresh,T+1000,true)]){
  assert.equal(current.quality,'stale');assert.equal(current.as_of_ms,T);assert.equal(current.requested_at_ms,fresh.requested_at_ms);
  assert.deepEqual(current.items.map(clocks),fresh.items.map(clocks));
  assert.equal(current.items.every(i=>i.quality==='stale'),true);
 }
 assert.equal(fresh.quality,'fresh');assert.equal(fresh.items.every(i=>i.quality==='fresh'),true);
 const kept=valid('news_empty_after_failure');
 assert.equal(kept.quality,'stale');assert.equal(kept.as_of_ms,T);assert.deepEqual(kept.items,[]);assert.equal(kept.sources[0].last_success_at_ms,T);
});

test('an empty feed kept after a failed read stays stale while the retry is pending',async()=>{
 const pending=deferred();let now=T+1000,calls=0;
 const client=createPublicDataClient({now:()=>now,fetchImpl:async url=>{
  calls++;
  if(calls===1)return json(news('news_empty_success',selection(url)));
  if(calls===2)return json({},503);
  return pending.promise;
 }});
 await client.load('news',{selection_version:1});
 assert.equal(client.read('news').snapshot.quality,'fresh');
 await client.load('news',{selection_version:2});
 assert.equal(client.read('news').error,'DATA_SERVICE_UNAVAILABLE');assert.equal(client.read('news').snapshot.quality,'stale');
 now+=client.read('news').retryIn*1000;
 const retry=client.load('news',{selection_version:3});
 const during=client.read('news');
 assert.equal(calls,3);assert.equal(during.pending,true);assert.equal(during.error,null);
 assert.equal(during.snapshot.quality,'stale');assert.equal(during.snapshot.as_of_ms,T);
 const next=news('news_empty_success',3);next.as_of_ms=now;next.requested_at_ms=now;next.sources[0].last_success_at_ms=now;
 pending.resolve(json(next));await retry;
 const after=client.read('news');
 assert.equal(after.pending,false);assert.equal(after.error,null);assert.equal(after.snapshot.quality,'fresh');assert.equal(after.snapshot.as_of_ms,now);
});

test('news rows kept after a failed read stay stale with their original clocks while the retry is pending',async()=>{
 const pending=deferred();let now=T+1000,calls=0;
 const client=createPublicDataClient({now:()=>now,fetchImpl:async url=>{
  calls++;
  if(calls===1)return json(news('news_fresh',selection(url)));
  if(calls===2)return json({},503,{'Retry-After':'5'});
  return pending.promise;
 }});
 await client.load('news',{selection_version:1});
 const first=client.read('news').snapshot;
 assert.equal(first.quality,'fresh');
 await client.load('news',{selection_version:2});
 assert.equal(client.read('news').retryIn,5);
 await client.load('news',{selection_version:3});assert.equal(calls,2);
 now+=5000;
 const retry=client.load('news',{selection_version:4});
 const during=client.read('news');
 assert.equal(calls,3);assert.equal(during.pending,true);
 assert.equal(during.snapshot.quality,'stale');assert.equal(during.snapshot.as_of_ms,first.as_of_ms);
 assert.deepEqual(during.snapshot.items.map(clocks),first.items.map(clocks));
 assert.equal(during.snapshot.items.every(i=>i.quality==='stale'),true);
 pending.resolve(json(news('news_fresh',4)));await retry;
 assert.equal(client.read('news').error,null);
 assert.equal(client.read('news').snapshot.items.every(i=>i.quality==='fresh'),true);
});

test('responses that blur an empty feed, an unavailable source or a missing clock are rejected',()=>{
 const variants=[
  ['news_unconfigured',b=>{b.as_of_ms=T;}],
  ['news_unconfigured',b=>{b.items=copy(fixture.news_fresh.body.items);}],
  ['news_empty_success',b=>{b.as_of_ms=null;}],
  ['news_empty_success',b=>{b.sources[0].status='TIMEOUT';}],
  ['news_empty_success',b=>{b.sources[0].last_success_at_ms=null;}],
  ['news_empty_success',b=>{b.coverage.scope='news';}],
  ['news_empty_aged',b=>{b.sources[0].last_success_at_ms=null;}],
  ['news_fresh',b=>{b.as_of_ms=null;}],
  ['news_fresh',b=>{b.items[0].valid_until_ms=null;}],
  ['news_fresh',b=>{b.items[0].received_at_ms=null;}],
  ['news_fresh',b=>{b.items[1].available_at_ms=null;}],
 ];
 for(const [key,mutate] of variants){const b=news(key);mutate(b);assert.throws(()=>validatePublicEnvelope(b,'news',{selection_version:7}),/DATA_RESPONSE_INVALID/,key);}
 const markets=news('news_empty_success');markets.coverage={requested_subjects:['bitcoin','ethereum','solana'],returned_subjects:[],gaps:[],scope:'NEWS_FEED'};
 assert.throws(()=>validatePublicEnvelope(markets,'markets',{selection_version:7}),/DATA_RESPONSE_INVALID/);
 const unknown=news('news_fresh');unknown.items[0].event_time_ms=null;
 assert.equal(validatePublicEnvelope(unknown,'news',{selection_version:7}).items[0].event_time_ms,null);
});

test('the client can only read: no query key asks the service to collect, and repeated refreshes share one read',async()=>{
 // The news read is on /api/market-hub?resource=news (main, as public-data.test.mjs pins); the old /api/v1/data/news route is not accepted.
 // The address is that path, then resource=news and the read's own pairs in this order, and nothing else.
 const forbidden=['refresh','force','collect','scope','request_id'],origin='http://localhost',route='/api/market-hub';
 const carries=(address,query)=>{
  const url=new URL(address,origin),pairs=[['resource','news'],...Object.entries(query).map(([key,value])=>[key,String(value)])];
  assert.equal(url.origin,origin);assert.equal(address,url.pathname+url.search);assert.equal(url.pathname,route,'news route '+url.pathname);
  for(const key of forbidden)assert.equal(url.searchParams.has(key),false,key);
  assert.deepEqual([...url.searchParams],pairs);assert.equal(url.search,'?'+new URLSearchParams(pairs));
 };
 for(const key of forbidden)assert.throws(()=>publicQuery('news',{[key]:'1'}),/INVALID_QUERY/,key);
 const built=publicDataURL('news',{limit:50,selection_version:3});carries(built,{selection_version:3,limit:50});
 const pending=deferred();let calls=0,seen;
 const client=createPublicDataClient({now:()=>T,fetchImpl:(url,options)=>{calls++;seen={url,options};return pending.promise;}});
 const loads=[1,2,3,4,5].map(()=>client.load('news',{selection_version:7}));
 assert.equal(calls,1);assert.equal(new Set(loads).size,1);
 assert.equal(seen.options.method,'GET');assert.equal(seen.options.credentials,'omit');assert.equal(seen.options.body,undefined);
 const sent=publicQuery('news',{selection_version:7});
 assert.equal(seen.url,publicDataURL('news',sent));carries(seen.url,{selection_version:7,limit:sent.limit});
 assert.equal(new URL(seen.url,origin).pathname,new URL(built,origin).pathname);
 pending.resolve(json(news('news_fresh')));await loads[0];
 assert.equal(client.read('news').snapshot.items.length,2);assert.equal(client.read('news').pending,false);
});

// The same card lines on the road main serves: /api/market-hub?resource=news is answered by the licensed feeds handler,
// which merges two fixed publishers. Synthetic headlines and fake publishers only; no real key, no outside call.
const H=Date.UTC(2026,0,6,2);
const story=(source,id,at)=>source==='blockbeats'?{id:'blockbeats:'+id,title:'Synthetic flash '+id+' on bitcoin',url:'https://www.theblockbeats.info/flash/'+id,publishedAt:at,symbols:['BTC'],revision:null}:{id:'https://www.coindesk.com/markets/'+id,title:'Synthetic story '+id+' on ethereum',url:'https://www.coindesk.com/markets/'+id,publishedAt:at,symbols:['ETH'],revision:id};
const publisher=(rows=[])=>{const p={calls:0,rows,fail:null,load:async()=>{p.calls++;if(p.fail)throw Error(p.fail);return structuredClone(p.rows);}};return p;};
const syntheticRSS=`<rss version="2.0"><channel><title>CoinDesk</title><item><title>Synthetic headline on bitcoin</title><link>https://www.coindesk.com/markets/synthetic-1</link><guid>synthetic-1</guid><pubDate>${new Date(H-120000).toUTCString()}</pubDate></item></channel></rss>`;
async function hub(handle,path,init={}){
 const out={};await handle({url:path,method:'GET',headers:{},...init},{writeHead(status,headers){out.status=status;out.headers=headers;},end(text){out.text=text;out.body=JSON.parse(text);}});return out;
}
// The page client's fetch goes straight to the handler, so one chain covers page, handler and publishers.
function licensed(clock,bb,cd){
 const handle=createLicensedFeeds({now:()=>clock.now,env:{},fetchImpl:async url=>assert.fail('outside call '+url),blockbeats:bb.load,coindesk:cd.load}),answers=[];
 return {handle,answers,fetchImpl:async(url,options)=>{const r=await hub(handle,url,{method:options.method});answers.push(r);return new Response(r.text,{status:r.status,headers:r.headers});}};
}

test('licensed news: an empty read of both publishers is a success the page shows as no news; with a publisher down it never reads that way',async()=>{
 const run=async(bbFails,cdFails)=>{
  const bb=publisher(),cd=publisher();bb.fail=bbFails?'BLOCKBEATS_UNAVAILABLE':null;cd.fail=cdFails?'PUBLISHER_UNAVAILABLE':null;
  const road=licensed({now:H},bb,cd),client=createPublicDataClient({now:()=>H,fetchImpl:road.fetchImpl});
  await client.load('news',{selection_version:1});return {answer:road.answers[0],state:client.read('news')};
 };
 const empty=await run(false,false),b=empty.state.snapshot;
 assert.equal(empty.answer.status,200);assert.equal(empty.state.error,null);
 assert.equal(b.quality,'fresh');assert.deepEqual(b.items,[]);assert.equal(b.as_of_ms,H);assert.equal(b.coverage.scope,'NEWS_FEED');
 assert.deepEqual(b.sources.map(s=>[s.provider_id,s.status,s.last_success_at_ms]),[['blockbeats-news-v1','OK',H],['coindesk-rss-v1','OK',H]]);
 assert.equal(publicEmptyNewsConfirmed(empty.state),true);
 for(const [bbFails,cdFails] of [[true,false],[false,true]]){
  const half=await run(bbFails,cdFails),down=half.state.snapshot.sources.filter(s=>s.status!=='OK');
  assert.equal(half.answer.status,200);assert.equal(half.state.error,null);assert.equal(half.state.snapshot.quality,'partial');assert.deepEqual(half.state.snapshot.items,[]);
  assert.deepEqual(down.map(s=>[s.provider_id,s.last_success_at_ms]),[[bbFails?'blockbeats-news-v1':'coindesk-rss-v1',null]]);assert.equal(half.state.snapshot.as_of_ms,H);
  assert.equal(publicEmptyNewsConfirmed(half.state),false);
 }
 const none=await run(true,true);
 assert.equal(none.answer.status,503);assert.deepEqual(none.answer.body,{error:'PUBLIC_SOURCE_UNAVAILABLE'});
 assert.equal(none.state.error,'DATA_SERVICE_UNAVAILABLE');assert.equal(none.state.snapshot,null);assert.equal(publicEmptyNewsConfirmed(none.state),false);
});

test('licensed news: stories older than a day pass the page contract as stale and keep the clocks of the read that fetched them',async()=>{
 const clock={now:H},old=H-PUBLIC_NEWS_SOURCE.stale-1000;
 const bb=publisher([story('blockbeats','701',old)]),cd=publisher([story('coindesk','day-old-a',old-5000)]),road=licensed(clock,bb,cd);
 const first=await hub(road.handle,'/api/market-hub?resource=news&selection_version=3');
 clock.now=H+120000;
 const again=await hub(road.handle,'/api/market-hub?resource=news&selection_version=4&limit=50');
 assert.equal(bb.calls,1);assert.equal(cd.calls,1);
 const expected=[['blockbeats-news-v1',old,H,H,old+PUBLIC_NEWS_SOURCE.stale],['coindesk-rss-v1',old-5000,H,H,old-5000+PUBLIC_NEWS_SOURCE.stale]];
 for(const [answer,input,requested] of [[first,{selection_version:3},H],[again,{selection_version:4,limit:50},H+120000]]){
  assert.equal(answer.status,200);
  const b=validatePublicEnvelope(answer.body,'news',input);
  assert.equal(b.quality,'stale');assert.equal(b.requested_at_ms,requested);assert.equal(b.as_of_ms,first.body.as_of_ms);assert.ok(b.as_of_ms<=H);
  assert.deepEqual(b.items.map(i=>[i.provider_id,...clocks(i)]),expected);
  assert.equal(b.items.every(i=>i.quality==='stale'&&i.data.published_at_ms===i.event_time_ms),true);
  const current=currentPublicEnvelope(b,requested);
  assert.equal(current.quality,'stale');assert.deepEqual(current.items.map(clocks),b.items.map(clocks));
 }
});

test('licensed news, today: after both publishers fail the page keeps its earlier stories stale with their original clocks, and the handler answers 503, never an empty success',async()=>{
 // Today: the page's own kept copy carries "stale data retains original times"; a reader with no kept copy sees unavailable.
 const clock={now:H},bb=publisher([story('blockbeats','801',H-60000)]),cd=publisher([story('coindesk','fresh-a',H-30000),story('coindesk','fresh-b',H-90000)]),road=licensed(clock,bb,cd);
 let fetches=0;
 const client=createPublicDataClient({now:()=>clock.now,fetchImpl:(url,options)=>{fetches++;return road.fetchImpl(url,options);}});
 await client.load('news',{selection_version:1});
 const first=client.read('news').snapshot;
 assert.equal(first.quality,'fresh');assert.equal(first.items.length,3);
 clock.now=H+300000;bb.fail='BLOCKBEATS_UNAVAILABLE';cd.fail='PUBLISHER_UNAVAILABLE';
 await client.load('news',{selection_version:2});
 const failed=road.answers.at(-1);
 assert.equal(failed.status,503);assert.deepEqual(failed.body,{error:'PUBLIC_SOURCE_UNAVAILABLE'});
 assert.equal(failed.headers['Retry-After'],'60');assert.equal(failed.headers['Cache-Control'],'no-store');
 assert.equal(bb.calls,2);assert.equal(cd.calls,2);
 const kept=client.read('news');
 assert.equal(kept.error,'DATA_SERVICE_UNAVAILABLE');assert.equal(kept.retryIn,60);assert.equal(publicEmptyNewsConfirmed(kept),false);
 assert.equal(kept.snapshot.quality,'stale');assert.equal(kept.snapshot.as_of_ms,first.as_of_ms);assert.equal(kept.snapshot.requested_at_ms,first.requested_at_ms);
 assert.deepEqual(kept.snapshot.items.map(i=>[i.record_id,...clocks(i)]),first.items.map(i=>[i.record_id,...clocks(i)]));
 assert.equal(kept.snapshot.items.every(i=>i.quality==='stale'),true);assert.deepEqual(kept.snapshot.sources,first.sources);
 // During the 60 s hold neither the page nor a new visitor reaches a publisher; the new visitor has no kept copy and gets unavailable.
 clock.now=H+359999;
 await client.load('news',{selection_version:3});assert.equal(fetches,2);
 const visitor=await hub(road.handle,'/api/market-hub?resource=news');
 assert.equal(visitor.status,503);assert.equal(visitor.body.items,undefined);assert.equal(bb.calls+cd.calls,4);
 // After the hold the publishers are read again; the stories keep their publication times and carry the new receipt time.
 clock.now=H+360000;bb.fail=null;cd.fail=null;
 await client.load('news',{selection_version:4});
 const back=client.read('news');
 assert.equal(fetches,3);assert.equal(bb.calls+cd.calls,6);assert.equal(back.error,null);assert.equal(back.snapshot.quality,'fresh');
 assert.deepEqual(back.snapshot.items.map(i=>i.event_time_ms),first.items.map(i=>i.event_time_ms));
 assert.equal(back.snapshot.items.every(i=>i.received_at_ms===H+360000&&i.available_at_ms===H+360000),true);
});

test('licensed feeds: without a usable key the keyed publishers are never called, and the keyless feed still answers',async()=>{
 const keyed=[new URL(BLOCKBEATS_URL).hostname,'lunarcrush.com'],keyless=new URL(PUBLIC_NEWS_SOURCE.url).hostname;
 for(const [env,withKey] of [[{},false],[{BLOCKBEATS_API_KEY:'',LUNARCRUSH_API_KEY:''},false],[{BLOCKBEATS_API_KEY:' \t',LUNARCRUSH_API_KEY:'  '},false],[{BLOCKBEATS_API_KEY:'synthetic\nkey',LUNARCRUSH_API_KEY:'synthetic\r\nkey'},false],[{BLOCKBEATS_API_KEY:'test-key-not-a-real-token'},true]]){
  const clock={now:H},hosts=[];
  const handle=createLicensedFeeds({now:()=>clock.now,env,fetchImpl:async url=>{hosts.push(new URL(url).hostname);return url===PUBLIC_NEWS_SOURCE.url?new Response(syntheticRSS):new Response('{}',{status:500});}});
  for(const at of [H,H+60000,H+300000]){
   clock.now=at;
   const answer=await hub(handle,'/api/market-hub?resource=news'),social=await hub(handle,'/api/market-hub?resource=social');
   assert.equal(answer.status,200,JSON.stringify(env));assert.equal(social.status,503);
   const b=validatePublicEnvelope(answer.body,'news');
   assert.equal(b.quality,'partial');assert.deepEqual(b.items.map(i=>i.provider_id),['coindesk-rss-v1']);
   const blockbeats=b.sources.find(s=>s.provider_id==='blockbeats-news-v1');assert.notEqual(blockbeats.status,'OK');assert.equal(blockbeats.last_success_at_ms,null);
  }
  assert.equal(hosts.includes(keyless),true);
  assert.equal(hosts.some(host=>keyed.includes(host)),withKey,JSON.stringify(env));
 }
});

test('licensed news: five first reads with different limits share one read of each publisher; answers are no-store and caller credentials never reach a publisher',async()=>{
 const key='test-key-not-a-real-token',calls=[],gate=deferred();
 const flash={status:0,data:{data:[{id:901,title:'Synthetic flash on ETH',link:'https://www.theblockbeats.info/flash/901',create_time:'2026-01-06 09:59:00'}]}};
 const handle=createLicensedFeeds({now:()=>H,env:{BLOCKBEATS_API_KEY:key},fetchImpl:async(url,options)=>{calls.push({url,options});await gate.promise;return url===BLOCKBEATS_URL?Response.json(flash):new Response(syntheticRSS);}});
 const caller={cookie:'session=private-caller',authorization:'Bearer private-caller'};
 const asks=[[1,1],[2,5],[3,20],[4,50],[5,50]];
 const reads=asks.map(([version,limit])=>hub(handle,`/api/market-hub?resource=news&selection_version=${version}&limit=${limit}`,{headers:caller}));
 await new Promise(done=>setImmediate(done));assert.equal(calls.length,2);
 gate.resolve();const answers=await Promise.all(reads);
 assert.deepEqual(calls.map(c=>c.url).sort(),[BLOCKBEATS_URL,PUBLIC_NEWS_SOURCE.url].sort());
 for(const {url,options} of calls){
  assert.deepEqual(options.headers,url===BLOCKBEATS_URL?{'api-key':key,Accept:'application/json'}:PUBLIC_NEWS_SOURCE.headers);
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(JSON.stringify(options).includes('private-caller'),false);
 }
 answers.forEach((answer,index)=>{
  const [version,limit]=asks[index],b=validatePublicEnvelope(answer.body,'news',{selection_version:version,limit});
  assert.equal(answer.status,200);assert.equal(answer.headers['Cache-Control'],'no-store');assert.equal(answer.text.includes(key),false);
  assert.equal(b.items.length,Math.min(limit,2));assert.equal(b.as_of_ms,answers[0].body.as_of_ms);assert.equal(b.requested_at_ms,H);
  assert.deepEqual(b.sources.map(s=>[s.provider_id,s.status,s.last_success_at_ms]),[['blockbeats-news-v1','OK',H],['coindesk-rss-v1','OK',H]]);
 });
 // A caller cannot ask for a fresh collection or another method; refused answers are no-store too and reach no publisher.
 for(const [path,method,status] of [['/api/market-hub?resource=news&refresh=1','GET',400],['/api/market-hub?resource=news&force=1','GET',400],['/api/market-hub?resource=news','POST',405]]){
  const refused=await hub(handle,path,{method,headers:caller});
  assert.equal(refused.status,status,path);assert.equal(refused.headers['Cache-Control'],'no-store');
 }
 assert.equal(calls.length,2);
});

test('a failed public read cancels its unread body, even when cancelling fails, and keeps its error and retry delay',async()=>{
 for(const [status,error] of [[503,'DATA_SERVICE_UNAVAILABLE'],[429,'DATA_SERVICE_UNAVAILABLE'],[400,'INVALID_QUERY'],[403,'DATA_ACCESS_DENIED'],[500,'DATA_REQUEST_FAILED']])for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  let cancels=0;const client=createPublicDataClient({now:()=>T,fetchImpl:async()=>({ok:false,status,headers:{get:key=>key==='Retry-After'?'5':null},body:{cancel(){cancels++;return cancel();}},text:async()=>{throw Error('must not read error');},json:async()=>{throw Error('must not parse error');}})});
  const result=await client.load('news',{selection_version:1});
  assert.equal(cancels,1,String(status));assert.equal(result.error,error,String(status));assert.equal(result.pending,false);assert.equal(result.snapshot,null);assert.equal(result.retryIn,5,String(status));
 }
});
