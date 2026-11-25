import test from 'node:test';
import assert from 'node:assert/strict';
import {PUBLIC_SCHEMA,PUBLIC_PROJECTION,publicQuery,publicDataURL,validatePublicEnvelope,currentPublicEnvelope,createPublicDataClient} from './public-data-client.mjs';

// Offline HTTP/schema doubles only; these records are not observed Mastodon posts.
const NOW=Date.UTC(2026,10,17,14),DAY=86400000,VERSION=7,PROVIDER='mastodon-tag-v1';
const copy=value=>structuredClone(value);
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function social({version=VERSION,mode='live_readonly',published=NOW-60000,observed=NOW,edited=null,empty=false}={}){
 const data={metric_kind:'PUBLIC_SOCIAL_POST',platform:'Mastodon',instance:'mastodon.social',post_id:'offline-post-01',url:'https://mastodon.social/@offline/123',author:{acct:'offline@mastodon.social',display_name:'Offline fixture',url:'https://mastodon.social/@offline',bot:false},text:'Offline #Bitcoin sample, not a live post.',truncated:false,published_at_ms:published,edited_at_ms:edited,observed_at_ms:observed,symbols:['BTC'],likes:4,reposts:2,replies:1};
 return {schema_version:PUBLIC_SCHEMA,projection_version:PUBLIC_PROJECTION,tenant_scope:'PUBLIC',request_id:'offline-social-request',selection_version:version,mode,real_trading_connected:false,execution_binding:'NONE',quality:'fresh',as_of_ms:observed,requested_at_ms:observed,coverage:{scope:'SOCIAL_TAG_SAMPLES'},missing_capabilities:[],sources:[{provider_id:PROVIDER,status:'ready',last_success_at_ms:observed,reason_code:null,retry_after_seconds:null}],items:empty?[]:[{record_id:'offline-social-record',subject_id:'mastodon:offline-post-01',provider_id:PROVIDER,quality:'fresh',event_time_ms:published,received_at_ms:observed,available_at_ms:observed,valid_until_ms:Math.min(published+DAY,observed+300000),venue_or_chain:'mastodon.social',source_revision:null,data}]};
}
function rejectChange(change,label){
 const value=social();change(value,value.items[0].data,value.items[0]);
 assert.throws(()=>validatePublicEnvelope(value,'social',{selection_version:VERSION}),/DATA_RESPONSE_INVALID/,label);
}

test('social queries use only the bounded same-origin resource and exact public selection',()=>{
 assert.deepEqual(publicQuery('social'),{selection_version:0,limit:20});
 assert.deepEqual(publicQuery('social',{selection_version:VERSION,limit:50}),{selection_version:VERSION,limit:50});
 assert.equal(publicDataURL('social',{selection_version:VERSION,limit:50}),'/api/market-hub?resource=social&selection_version=7&limit=50');
 for(const limit of [0,51,-1,.5,'01','1.0',' 2',Infinity])assert.throws(()=>publicQuery('social',{limit}),/INVALID_QUERY/);
 for(const input of [{selection_version:2147483648},{asset_ids:'bitcoin'},{symbols:'BTC'},{tags:'bitcoin'},{instance:'evil.test'},{platform:'X'},{url:'https://evil.test'},{account:'SIM-01'},{access_token:'offline-canary'}])assert.throws(()=>publicQuery('social',input),/INVALID_QUERY/);
 assert.throws(()=>publicQuery('social',new URLSearchParams('limit=10&limit=20')),/INVALID_QUERY/);
});

test('the exact social envelope preserves observed publication, edit, counts and read-only authority without mutating data',()=>{
 const value=social({edited:NOW-30000}),before=JSON.stringify(value),validated=validatePublicEnvelope(value,'social',{selection_version:VERSION});
 assert.equal(validated.schema_version,'AstarterPublicData.v1');assert.equal(validated.tenant_scope,'PUBLIC');assert.equal(validated.mode,'live_readonly');
 assert.equal(validated.execution_binding,'NONE');assert.equal(validated.real_trading_connected,false);assert.equal(validated.coverage.scope,'SOCIAL_TAG_SAMPLES');
 const item=validated.items[0];assert.equal(item.provider_id,PROVIDER);assert.equal(item.event_time_ms,NOW-60000);assert.equal(item.received_at_ms,NOW);assert.equal(item.available_at_ms,NOW);assert.equal(item.valid_until_ms,NOW+300000);
 assert.deepEqual([item.data.likes,item.data.reposts,item.data.replies],[4,2,1]);assert.equal(item.data.edited_at_ms,NOW-30000);assert.equal(JSON.stringify(value),before);
 assert.equal(Object.isFrozen(validated),true);assert.equal(Object.isFrozen(item.data),true);
});

test('social counters accept only nonnegative safe integers, including explicit zero without fabricated popularity',()=>{
 for(const count of [0,Number.MAX_SAFE_INTEGER]){
  const value=social();for(const key of ['likes','reposts','replies'])value.items[0].data[key]=count;
  assert.equal(validatePublicEnvelope(value,'social',{selection_version:VERSION}).items[0].data.likes,count);
 }
 for(const key of ['likes','reposts','replies'])for(const value of [-1,.5,'1',null,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])rejectChange((_b,data)=>{data[key]=value;},key+' rejects '+String(value));
});

test('post and author source URLs reject executable, insecure and credential-bearing destinations',()=>{
 for(const field of ['post','author'])for(const url of ['javascript:alert(1)','data:text/html,offline','http://mastodon.social/@offline','https://offline:canary@mastodon.social/@offline','/relative'])rejectChange((_b,data)=>{if(field==='post')data.url=url;else data.author.url=url;},field+' '+url);
});

test('fixed provider, platform, instance and asset identities cannot be silently substituted',()=>{
 for(const [label,change]of [
  ['provider',value=>{value.items[0].provider_id='other-provider';}],
  ['unregistered source',value=>{value.sources[0].provider_id='other-provider';}],
  ['wrong coverage',value=>{value.coverage.scope='NEWS_FEED';}],
  ['wrong platform',(_value,data)=>{data.platform='X';}],
  ['wrong instance',(_value,data)=>{data.instance='other.social';}],
  ['wrong metric',(_value,data)=>{data.metric_kind='SOCIAL_SENTIMENT_SCORE';}],
  ['wrong symbol',(_value,data)=>{data.symbols=['SPX'];}],
  ['duplicate symbol',(_value,data)=>{data.symbols=['BTC','BTC'];}],
  ['lowercase symbol',(_value,data)=>{data.symbols=['btc'];}],
  ['excess symbols',(_value,data)=>{data.symbols=['BTC','ETH','SOL','BNB'];}]
 ])rejectChange(change,label);
 const value=social();value.items[0].data.symbols=['BTC','ETH','SOL'];assert.deepEqual(validatePublicEnvelope(value,'social',{selection_version:VERSION}).items[0].data.symbols,['BTC','ETH','SOL']);
});

test('post text, truncation and author metadata retain the documented types and size limits',()=>{
 for(const [label,change]of [
  ['empty text',(_b,data)=>{data.text='';}],['long text',(_b,data)=>{data.text='x'.repeat(601);}],
  ['truncated string',(_b,data)=>{data.truncated='false';}],['empty account',(_b,data)=>{data.author.acct='';}],
  ['invalid bot',(_b,data)=>{data.author.bot='false';}],['long display name',(_b,data)=>{data.author.display_name='x'.repeat(301);}]
 ])rejectChange(change,label);
 for(const bot of [null,false,true]){const value=social();value.items[0].data.author.bot=bot;assert.equal(validatePublicEnvelope(value,'social',{selection_version:VERSION}).items[0].data.author.bot,bot);}
});

test('zero and earlier edit times are rejected while a null or chronologically valid edit remains valid',()=>{
 for(const edited of [0,-1,NOW-60001,NOW+60001,'0',.5])rejectChange((_b,data)=>{data.edited_at_ms=edited;},'edited '+String(edited));
 for(const edited of [null,NOW-60000,NOW])assert.equal(validatePublicEnvelope(social({edited}),'social',{selection_version:VERSION}).items[0].data.edited_at_ms,edited);
});

test('future source times, clock mismatches and expiry extensions fail the exact social time contract',()=>{
 for(const [label,change]of [
  ['future publication',(_b,data)=>{data.published_at_ms=NOW+60001;}],
  ['future observation',(value,data,item)=>{data.observed_at_ms=NOW+1001;item.received_at_ms=item.available_at_ms=data.observed_at_ms;item.valid_until_ms=data.observed_at_ms+300000;}],
  ['wrong event time',(_b,_data,item)=>{item.event_time_ms++;}],
  ['wrong receipt time',(_b,_data,item)=>{item.received_at_ms++;}],
  ['wrong availability',(_b,_data,item)=>{item.available_at_ms++;}],
  ['extended expiry',(_b,_data,item)=>{item.valid_until_ms++;}],
  ['null request time',value=>{value.requested_at_ms=null;}]
 ])rejectChange(change,label);
 const old=social({published:NOW-DAY+10000});assert.equal(validatePublicEnvelope(old,'social',{selection_version:VERSION}).items[0].valid_until_ms,NOW+10000);
 const renewed=copy(old);renewed.requested_at_ms+=20000;renewed.items[0].data.observed_at_ms+=20000;renewed.items[0].received_at_ms+=20000;renewed.items[0].available_at_ms+=20000;renewed.items[0].valid_until_ms=renewed.items[0].data.observed_at_ms+300000;
 assert.throws(()=>validatePublicEnvelope(renewed,'social',{selection_version:VERSION}),/DATA_RESPONSE_INVALID/,'observing an old post again must not renew its 24h lifetime');
});

test('empty social success still requires the exact social scope, provider and request clock',()=>{
 assert.equal(validatePublicEnvelope(social({empty:true}),'social',{selection_version:VERSION}).items.length,0);
 for(const patch of [value=>{value.coverage.scope='NEWS_FEED';},value=>{value.requested_at_ms=null;},value=>{value.sources=[];}]){
  const value=social({empty:true});patch(value);assert.throws(()=>validatePublicEnvelope(value,'social',{selection_version:VERSION}),/DATA_RESPONSE_INVALID/);
 }
});

test('live and offline-fixture states stay distinct and neither can acquire execution authority',()=>{
 for(const mode of ['live_readonly','offline_fixture']){
  const value=validatePublicEnvelope(social({mode}),'social',{selection_version:VERSION});assert.equal(value.mode,mode);assert.equal(currentPublicEnvelope(value,NOW).mode,mode);
 }
 for(const patch of [value=>{value.mode='fixture';},value=>{value.execution_binding='APPROVED';},value=>{value.real_trading_connected=true;},value=>{value.tenant_scope='PRIVATE';},value=>{value.selection_version++;}])rejectChange(patch,'scope, selection or authority substitution');
});

test('source expiry and read failure never refresh the original publication or observation clocks',()=>{
 const value=validatePublicEnvelope(social(),'social',{selection_version:VERSION}),before=JSON.stringify(value);
 for(const at of [NOW+300001,NOW+DAY]){
  const stale=currentPublicEnvelope(value,at);assert.equal(stale.quality,'stale');assert.equal(stale.items[0].quality,'stale');assert.equal(stale.items[0].received_at_ms,NOW);assert.equal(stale.items[0].data.published_at_ms,NOW-60000);assert.equal(stale.items[0].valid_until_ms,NOW+300000);
 }
 assert.equal(currentPublicEnvelope(value,NOW,true).quality,'stale');assert.equal(JSON.stringify(value),before);
 const empty=validatePublicEnvelope(social({empty:true}),'social',{selection_version:VERSION});assert.equal(currentPublicEnvelope(empty,NOW+300001).quality,'stale');assert.equal(currentPublicEnvelope(empty,NOW,true).quality,'stale');
});

test('the browser social client reads only the same-origin GET with no session or provider credential',async t=>{
 const calls=[],client=createPublicDataClient({now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return json(social());}});t.after(()=>client.clear());
 assert.equal(calls.length,0);await client.load('social',{selection_version:VERSION,limit:50});
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/market-hub?resource=social&selection_version=7&limit=50');
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.cache,'no-store');assert.deepEqual(calls[0].options.headers,{Accept:'application/json'});
 assert.equal(client.read('social').snapshot.items[0].data.platform,'Mastodon');assert.equal(client.read('social').error,null);
 assert.throws(()=>client.load('social',{url:'https://evil.test'}),/INVALID_QUERY/);assert.equal(calls.length,1);
});

test('cancelled and superseded social requests cannot refill a slot or replace a newer selection after a late success',async t=>{
 const hold=deferred(),calls=[];const client=createPublicDataClient({now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?hold.promise:json(social({version:VERSION+1}));}});t.after(()=>client.clear());
 const first=client.load('social',{selection_version:VERSION});assert.equal(client.load('social',{selection_version:VERSION}),first);assert.equal(calls.length,1);
 client.cancel('social');assert.equal(calls[0].options.signal.aborted,true);assert.equal(client.read('social').snapshot,null);
 await client.load('social',{selection_version:VERSION+1});hold.resolve(json(social()));await first;
 assert.equal(calls.length,2);assert.equal(client.read('social').pending,false);assert.equal(client.read('social').error,null);assert.equal(client.read('social').snapshot.selection_version,VERSION+1);
 client.clear();assert.equal(client.read('social').snapshot,null);
});

test('cancel or clear without a replacement read leaves late social success uninstalled',async t=>{
 for(const action of ['cancel','clear']){
  const hold=deferred();let signal,calls=0;
  const client=createPublicDataClient({now:()=>NOW,fetchImpl:async(_url,options)=>{calls++;signal=options.signal;return hold.promise;}});t.after(()=>client.clear());
  const pending=client.load('social',{selection_version:VERSION});if(action==='cancel')client.cancel('social');else client.clear();
  assert.equal(signal.aborted,true);assert.equal(client.read('social').pending,false);hold.resolve(json(social()));await pending;
  const value=client.read('social');assert.equal(calls,1);assert.equal(value.snapshot,null);assert.equal(value.pending,false);assert.equal(value.error,null);assert.equal(value.retryIn,0);
 }
});

test('failed initial social reads are unavailable rather than fabricated empty success or fixtures',async t=>{
 for(const fetchImpl of [async()=>{throw Error('offline untrusted upstream detail');},async()=>json({},503),async()=>new Response('{invalid')]){
  const client=createPublicDataClient({now:()=>NOW,fetchImpl});t.after(()=>client.clear());await client.load('social',{selection_version:VERSION});
  const value=client.read('social');assert.equal(value.pending,false);assert.equal(value.snapshot,null);assert.ok(value.error);assert.ok(value.retryIn>0);assert.doesNotMatch(value.error,/untrusted|upstream detail/);
 }
});

test('a failed refresh preserves original social facts as stale and cannot bypass Retry-After',async t=>{
 let at=NOW,calls=0;const client=createPublicDataClient({now:()=>at,fetchImpl:async()=>++calls===1?json(social()):json({},503,{'Retry-After':'12'})});t.after(()=>client.clear());
 await client.load('social',{selection_version:VERSION});at+=1000;await client.load('social',{selection_version:VERSION});
 const value=client.read('social');assert.equal(value.error,'DATA_SERVICE_UNAVAILABLE');assert.equal(value.snapshot.quality,'stale');assert.equal(value.snapshot.items.length,1);assert.equal(value.snapshot.items[0].data.likes,4);assert.equal(value.snapshot.items[0].data.observed_at_ms,NOW);assert.equal(value.snapshot.items[0].valid_until_ms,NOW+300000);
 await client.load('social',{selection_version:VERSION+1});assert.equal(calls,2);assert.equal(client.read('social').retryIn,12);
});

test('empty social success followed by 503 cannot remain a fresh no-post conclusion',async t=>{
 let calls=0;const client=createPublicDataClient({now:()=>NOW,fetchImpl:async()=>++calls===1?json(social({empty:true})):json({},503)});t.after(()=>client.clear());
 await client.load('social',{selection_version:VERSION});assert.equal(client.read('social').snapshot.quality,'fresh');assert.equal(client.read('social').snapshot.items.length,0);
 await client.load('social',{selection_version:VERSION});const value=client.read('social');assert.equal(value.error,'DATA_SERVICE_UNAVAILABLE');assert.equal(value.snapshot.quality,'stale');assert.equal(value.snapshot.items.length,0);assert.equal(value.snapshot.as_of_ms,NOW);assert.equal(value.snapshot.mode,'live_readonly');
});
