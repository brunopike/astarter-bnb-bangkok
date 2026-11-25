import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createResearchRuntime,RESEARCH_ORIGIN} from './research-runtime.mjs';
import {createPrivateApiRoute} from './private-api-route.mjs';
import {createResearchJobClient,renderResearchJob} from './research-job-client.mjs';
import {pair} from './locale.mjs';

const NOW=Date.UTC(2026,10,16,12),DAY=86400000,BOUNDARY=Math.floor(NOW/DAY)*DAY;
const CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1',PRIVATE_ORIGIN='https://offline-private.example';
const RUNTIME_TOKEN='offline_runtime_credential_01234567890123456789',ISSUER_TOKEN='offline_distinct_issuer_credential_01234567890123456789',MODEL_KEY='offline_provider_key_never_sent_to_a_network';
const USER_A='offline_user_a_session_01234567890123456789',USER_B='offline_user_b_session_01234567890123456789';
const hash=v=>createHash('sha256').update(v).digest('hex');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const wire=result=>json({contract:CONTRACT,result});
const rejected=(code,status)=>json({contract:CONTRACT,code},status);
const lease={leaseId:'lease-runtime-test',targetId:'private-target-test',database:'private_research',schema:'astarter_private_research',runtimeRole:'research_runtime',audience:'astarter-research',budgetId:'services-2026-11',model:'openai/gpt-4.1-mini',expiresAt:NOW+3600000};
const basePolicy={id:lease.budgetId,from:Date.UTC(2026,10),until:Date.UTC(2026,11),tokenLimit:1000000,requestLimit:100,model:lease.model,limitMicrousd:50000000,fixedServiceMicrousd:0,heldMicrousd:0,spentMicrousd:0,promptMicrousdPerMillion:400000,completionMicrousdPerMillion:1600000,blocked:false};
const env=()=>({ASTARTER_PRIVATE_SERVICE_ORIGIN:PRIVATE_ORIGIN,ASTARTER_PRIVATE_RUNTIME_TOKEN:RUNTIME_TOKEN,ASTARTER_PRIVATE_ISSUER_TOKEN:ISSUER_TOKEN,ASTARTER_RESEARCH_LEASE_JSON:JSON.stringify(lease),ASTARTER_RESEARCH_MODEL:lease.model,ASTARTER_RESEARCH_MODEL_ENABLED:'1',OPENROUTER_API_KEY:MODEL_KEY});
const dailyBars=()=>Array.from({length:300},(_,i)=>[BOUNDARY-(300-i)*DAY,'100','101','99','100','100',BOUNDARY-(299-i)*DAY-1]);

// Offline protocol owner. This verifies the real runtime/HTTP/model adapters,
// not PostgreSQL concurrency, production identity issuance or model quality.
function fixture(options={}){
 const calls=[],records=new Map(),claims=new Map(),sessions=new Map([[hash(USER_A),{subjectId:'person-a',tenantId:'tenant-a'}],[hash(USER_B),{subjectId:'person-b',tenantId:'tenant-b'}]]);
 let modelCalls=0,heldMicrousd=0;
 const key=v=>v.subjectId+':'+v.tenantId+':'+v.requestId;
 const fetchImpl=async(url,request)=>{
  const u=new URL(url),body=request.body?JSON.parse(request.body):null;calls.push({url,request,body});
  if(u.origin===PRIVATE_ORIGIN){
   assert.equal(request.headers.Authorization,'Bearer '+RUNTIME_TOKEN);assert.equal(request.headers.Cookie,undefined);
   const digest=request.headers['X-Astarter-Private-Session-Digest'],owner=sessions.get(digest);
   if(!owner)return rejected('PRIVATE_AUTH_REQUIRED',401);
   const path=u.pathname.slice('/internal/private/v1/'.length);
   if(options.privateUnavailable)return rejected('PRIVATE_UNAVAILABLE',503);
   if(path==='lease')return wire({contract:CONTRACT,kind:'PRIVATE',...lease,now:NOW,policy:{...basePolicy,...options.policyPatch,heldMicrousd}});
   if(path==='session/resolve'){
    assert.equal(body.tokenDigest,digest);return wire({...owner,audience:lease.audience,notBefore:NOW-1000,expiresAt:NOW+3600000,revokedAt:null,permissions:['research:analyze']});
   }
   assert.equal(body.subjectId,owner.subjectId);assert.equal(body.tenantId,owner.tenantId);assert.equal(body.scopeId,owner.tenantId);
   if(path==='research/get')return wire(records.get(key(body))||null);
   if(path==='research/claim'){
    const previous=records.get(key(body));if(previous)return wire({acquired:false,record:previous});
    if(options.claimCode)return rejected(options.claimCode,409);
    assert.equal(body.reservedTokens,13056);assert.equal(body.reservedMicrousd,20890);
    const record={...body,state:'pending'};records.set(key(body),record);const cas='offline_cas_'+hash(key(body));claims.set(key(body),cas);heldMicrousd+=body.reservedMicrousd;
    if(options.commitUnknown)return rejected('PRIVATE_COMMIT_UNKNOWN',409);
    return wire({acquired:true,claimToken:cas});
   }
   if(path==='research/finish'){
    assert.equal(body.claimToken,claims.get(key(body)));const record=records.get(key(body));assert.equal(record.state,'pending');
    const {claimToken,...patch}=body;Object.assign(record,patch);if(body.settledMicrousd===0)heldMicrousd-=record.reservedMicrousd;
    return wire(record);
   }
   assert.fail('Unrecognized private RPC path');
  }
  if(url==='https://openrouter.ai/api/v1/key')return json({data:{is_management_key:false,limit:50,limit_remaining:49,usage_monthly:1,limit_reset:'monthly',...(options.keyMetadata||{})}});
  if(u.hostname==='data-api.binance.vision'){
   assert.equal(request.method,'GET');assert.equal(request.headers.Authorization,undefined);assert.equal(request.redirect,'error');
   return options.sourceUnavailable?new Response('offline',{status:503}):json(dailyBars());
  }
  if(url==='https://openrouter.ai/api/v1/chat/completions'){
   modelCalls++;assert.equal(request.headers.Authorization,'Bearer '+MODEL_KEY);assert.equal(request.redirect,'error');
   assert.deepEqual(body.provider,{only:['openai'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:.4,completion:1.6}});assert.equal(body.max_completion_tokens,800);
   options.modelStarted?.();if(options.modelGate)await options.modelGate;
   if(options.modelUnavailable)throw Error('offline-private-provider-diagnostic '+MODEL_KEY);
   const evidence=JSON.parse(body.messages[1].content),sources=evidence.sources;
   assert.equal(sources[0].metrics.close,100);assert.equal(sources[0].metrics.rsi14,50);assert.equal(evidence.executionAuthority,'NONE');
   const output={outcome:'watch',headline:'Read the supplied daily technical evidence',summary:'Independent source groups remain missing.',claims:[{text:'The supplied RSI14 is 50.',evidenceIds:[sources[0].id]}]};
   return json({id:'offline-provider-receipt-'+modelCalls,model:lease.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,cost:.000104,is_byok:false}});
  }
  assert.fail('Unexpected outbound route');
 };
 const runtime=createResearchRuntime({env:options.env||env(),fetchImpl,now:()=>NOW});
 return {runtime,fetchImpl,calls,records,modelCalls:()=>modelCalls,heldMicrousd:()=>heldMicrousd,count:path=>calls.filter(call=>call.url.endsWith(path)).length};
}
async function server(t,runtime){
 const route=createPrivateApiRoute('research',runtime.handle),http=createServer((req,res)=>{void route(req,res).catch(()=>{res.writeHead(500);res.end('{}');});});http.listen(0,'127.0.0.1');await once(http,'listening');
 t.after(async()=>{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));});
 const origin='http://127.0.0.1:'+http.address().port;
 return async(path,{method='POST',body={requestId:'runtime-request-0001',symbols:['BTC']},token=USER_A,headers={}}={})=>{
  return new Promise((resolve,reject)=>{const payload=method==='POST'?JSON.stringify(body):'',request=httpRequest(origin+path,{method,headers:{host:new URL(RESEARCH_ORIGIN).host,origin:RESEARCH_ORIGIN,...(method==='POST'?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...(token?{cookie:'__Host-astarter_session='+token}:{}),...headers}},response=>{const parts=[];response.on('data',chunk=>parts.push(chunk));response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(parts).toString()),headers:response.headers});}catch(e){reject(e);}});});request.on('error',reject);request.end(payload);});
 };
}

test('unconfigured research runtime is inert and its actual HTTP route returns 503',async t=>{
 const f=fixture({env:{}});assert.equal(f.runtime.configured,false);assert.equal(f.calls.length,0);const call=await server(t,f.runtime),r=await call('/api/research/analyze');assert.equal(r.status,503);assert.equal(r.body.error,'UNCONFIGURED');assert.equal(f.calls.length,0);
});
test('missing or rejected session is 401, while a private service outage stays 503',async t=>{
 const f=fixture(),call=await server(t,f.runtime);assert.equal(f.runtime.configured,true);assert.equal(f.calls.length,0);
 const absent=await call('/api/research/analyze',{token:null});assert.equal(absent.status,401);assert.equal(absent.body.error,'AUTH_REQUIRED');assert.equal(f.calls.length,0);
 const unknown=await call('/api/research/analyze',{token:'offline_unknown_session_01234567890123456789'});assert.equal(unknown.status,401);assert.equal(unknown.body.error,'AUTH_REQUIRED');assert.equal(f.modelCalls(),0);
 const down=fixture({privateUnavailable:true}),downCall=await server(t,down.runtime),r=await downCall('/api/research/analyze');assert.equal(r.status,503);assert.equal(r.body.error,'SERVICE_UNAVAILABLE');assert.equal(down.modelCalls(),0);
});
test('model dispatch is off unless the runtime explicitly opts in, before provider checks, claims or source calls',async t=>{
 for(const enabled of [undefined,'0','false','true',true,1]){
  const f=fixture({env:{...env(),ASTARTER_RESEARCH_MODEL_ENABLED:enabled}}),call=await server(t,f.runtime);
  assert.equal(f.runtime.configured,true);
  const result=await call('/api/research/analyze');
  assert.equal(result.status,503);assert.equal(result.body.error,'MODEL_UNAVAILABLE');assert.equal(result.body.executionAuthority,'NONE');
  assert.ok(f.calls.every(c=>new URL(c.url).origin===PRIVATE_ORIGIN));assert.equal(f.count('/research/claim'),0);assert.equal(f.records.size,0);assert.equal(f.heldMicrousd(),0);assert.equal(f.modelCalls(),0);
 }
});
test('turning model dispatch off preserves authenticated reads of the original request',async t=>{
 const f=fixture(),enabledCall=await server(t,f.runtime),first=await enabledCall('/api/research/analyze');assert.equal(first.status,200);
 const disabled=createResearchRuntime({env:{...env(),ASTARTER_RESEARCH_MODEL_ENABLED:'0'},fetchImpl:f.fetchImpl,now:()=>NOW}),call=await server(t,disabled);
 const read=await call('/api/research/requests/runtime-request-0001',{method:'GET'});assert.equal(read.status,200);assert.deepEqual(read.body.result,first.body.result);
 const replay=await call('/api/research/analyze');assert.equal(replay.status,200);assert.deepEqual(replay.body,first.body);
 const rejected=await call('/api/research/analyze',{body:{requestId:'runtime-disabled-0002',symbols:['BTC']}});
 assert.equal(rejected.status,503);assert.equal(rejected.body.error,'MODEL_UNAVAILABLE');assert.equal(f.count('/api/v1/key'),1);assert.equal(f.count('/research/claim'),1);assert.equal(f.records.size,1);assert.equal(f.modelCalls(),1);assert.equal(f.heldMicrousd(),20890);
 const other=await call('/api/research/requests/runtime-request-0001',{method:'GET',token:USER_B});assert.equal(other.status,404);assert.equal(f.modelCalls(),1);
 const absent=await call('/api/research/analyze',{token:null});assert.equal(absent.status,401);assert.equal(absent.body.error,'AUTH_REQUIRED');
});
test('real factories traverse HTTP, private auth, hard-cap proof, source mathematics, model receipt and CAS finish',async t=>{
 const f=fixture(),call=await server(t,f.runtime),r=await call('/api/research?route=analyze');
 assert.equal(r.status,200);assert.equal(r.body.state,'complete');assert.equal(r.body.result.method,'ai');assert.equal(r.body.result.executionAuthority,'NONE');assert.equal(r.body.result.sources[0].source,'Binance Spot');assert.equal(r.body.result.sources[0].metrics.close,100);assert.equal(r.body.result.sources[0].metrics.rsi14,50);
 assert.deepEqual(r.body.result.billing,{provider:'openrouter',responseId:'offline-provider-receipt-1',model:lease.model,costMicrousd:104,isByok:false});assert.equal(r.body.result.sources.length,1);assert.equal(r.body.result.missingDimensions.length,5);
 assert.equal(r.body.subjectId,undefined);assert.equal(r.body.claimToken,undefined);assert.equal(f.modelCalls(),1);assert.equal(f.heldMicrousd(),20890,'completed data keeps its USD hold until cost-owner reconciliation');
 const paths=f.calls.map(c=>new URL(c.url).pathname);assert.ok(paths.indexOf('/api/v1/key')<paths.indexOf('/internal/private/v1/research/claim'));assert.ok(paths.indexOf('/internal/private/v1/research/claim')<paths.indexOf('/api/v3/klines'));assert.ok(paths.indexOf('/api/v3/klines')<paths.indexOf('/api/v1/chat/completions'));
 const finish=f.calls.find(c=>c.url.endsWith('/research/finish')).body;assert.equal(finish.settledTokens,140);assert.equal(finish.settledMicrousd,null);assert.equal(finish.providerReceipt.costMicrousd,104);
 assert.doesNotMatch(JSON.stringify(r.body),new RegExp([RUNTIME_TOKEN,ISSUER_TOKEN,MODEL_KEY,'person-a','tenant-a'].join('|')));
});
test('repeated POST and GET return the original receipt without another provider or source call',async t=>{
 const f=fixture(),call=await server(t,f.runtime),first=await call('/api/research/analyze'),replay=await call('/api/research/analyze'),read=await call('/api/research/requests/runtime-request-0001',{method:'GET'});
 assert.equal(first.status,200);assert.deepEqual(replay.body,first.body);const {ok,...record}=first.body;assert.equal(ok,true);assert.deepEqual(read.body,record);assert.equal(f.modelCalls(),1);assert.equal(f.count('/api/v1/key'),1);assert.equal(f.count('/research/claim'),1);
 const conflict=await call('/api/research/analyze',{body:{requestId:'runtime-request-0001',symbols:['ETH']}});assert.equal(conflict.status,409);assert.equal(conflict.body.error,'REQUEST_CONFLICT');assert.equal(f.modelCalls(),1);
});
test('request-scoped private clients isolate concurrent owners sharing a request ID',async t=>{
 const f=fixture(),call=await server(t,f.runtime);await call('/api/research/analyze');
 const denied=await call('/api/research/requests/runtime-request-0001',{method:'GET',token:USER_B});assert.equal(denied.status,404);
 const other=await call('/api/research/analyze',{token:USER_B});assert.equal(other.status,200);assert.equal(other.body.result.responseId,'offline-provider-receipt-2');assert.equal(f.records.size,2);assert.equal(f.modelCalls(),2);
 const [a,b]=await Promise.all([call('/api/research/requests/runtime-request-0001',{method:'GET'}),call('/api/research/requests/runtime-request-0001',{method:'GET',token:USER_B})]);assert.equal(a.body.result.responseId,'offline-provider-receipt-1');assert.equal(b.body.result.responseId,'offline-provider-receipt-2');
 const digests=f.calls.filter(c=>new URL(c.url).origin===PRIVATE_ORIGIN).map(c=>c.request.headers['X-Astarter-Private-Session-Digest']);assert.ok(digests.includes(hash(USER_A))&&digests.includes(hash(USER_B)));
});
test('a second identical HTTP POST sees the admitted pending request while the first provider call is in flight',async t=>{
 let release,started;const ready=new Promise(resolve=>started=resolve),modelGate=new Promise(resolve=>release=resolve),f=fixture({modelGate,modelStarted:started}),call=await server(t,f.runtime);
 const first=call('/api/research/analyze');await ready;
 try{const second=await call('/api/research/analyze');assert.equal(second.status,202);assert.equal(second.body.state,'pending');assert.equal(f.modelCalls(),1);assert.equal(f.count('/research/claim'),1);}finally{release();}
 assert.equal((await first).status,200);assert.equal((await call('/api/research/requests/runtime-request-0001',{method:'GET'})).body.state,'complete');assert.equal(f.modelCalls(),1);
});
test('uncapped or over-50USD provider keys fail admission before reservation, source or model IO',async t=>{
 for(const keyMetadata of [{limit:null},{limit:51,limit_remaining:50},{is_management_key:true},{limit_remaining:0},{limit_remaining:.020889}]){
  const f=fixture({keyMetadata}),call=await server(t,f.runtime),r=await call('/api/research/analyze');assert.equal(r.status,503);assert.equal(r.body.error,'BUDGET_UNAVAILABLE');assert.equal(f.count('/research/claim'),0);assert.equal(f.modelCalls(),0);assert.equal(f.calls.filter(c=>new URL(c.url).hostname==='data-api.binance.vision').length,0);assert.equal(f.records.size,0);
 }
});
test('explicitly deferring the provider cap preserves Core reservations, receipts and original-ID recovery',async t=>{
 const deferred={...env(),ASTARTER_RESEARCH_PROVIDER_CAP_REQUIRED:'0'},f=fixture({env:deferred,keyMetadata:{limit:null,limit_remaining:null}}),call=await server(t,f.runtime);
 const first=await call('/api/research/analyze');assert.equal(first.status,200);assert.equal(first.body.executionAuthority,undefined);assert.equal(first.body.result.executionAuthority,'NONE');assert.equal(f.count('/api/v1/key'),0);assert.equal(f.count('/research/claim'),1);assert.equal(f.modelCalls(),1);assert.equal(f.heldMicrousd(),20890);
 assert.deepEqual((await call('/api/research/analyze')).body,first.body);assert.equal(f.count('/research/claim'),1);assert.equal(f.modelCalls(),1);
 for(const options of [{policyPatch:{limitMicrousd:50000001}},{policyPatch:{fixedServiceMicrousd:50000001}},{policyPatch:{blocked:true}},{claimCode:'BUDGET_EXCEEDED'},{commitUnknown:true}]){
  const blocked=fixture({...options,env:deferred}),blockedCall=await server(t,blocked.runtime),r=await blockedCall('/api/research/analyze');
  assert.equal(r.status,options.claimCode?429:503);assert.equal(r.body.error,options.claimCode?'BUDGET_EXCEEDED':options.commitUnknown?'OUTCOME_UNKNOWN':'BUDGET_UNAVAILABLE');assert.equal(blocked.count('/api/v1/key'),0);assert.equal(blocked.modelCalls(),0);assert.equal(blocked.calls.filter(c=>new URL(c.url).hostname==='data-api.binance.vision').length,0);
  if(options.commitUnknown){assert.equal(blocked.heldMicrousd(),20890);assert.equal((await blockedCall('/api/research/analyze')).body.state,'pending');assert.equal(blocked.count('/research/claim'),1);}
 }
});
test('only the literal provider-cap deferral opts out, while the model switch remains independently off',async t=>{
 for(const setting of [undefined,'',false,0,'false','1',true]){
  const f=fixture({env:{...env(),ASTARTER_RESEARCH_PROVIDER_CAP_REQUIRED:setting},keyMetadata:{limit:null,limit_remaining:null}}),call=await server(t,f.runtime),r=await call('/api/research/analyze');
  assert.equal(r.status,503);assert.equal(r.body.error,'BUDGET_UNAVAILABLE');assert.equal(f.count('/research/claim'),0);assert.equal(f.modelCalls(),0);
 }
 const f=fixture({env:{...env(),ASTARTER_RESEARCH_PROVIDER_CAP_REQUIRED:'0',ASTARTER_RESEARCH_MODEL_ENABLED:'0'}}),call=await server(t,f.runtime),r=await call('/api/research/analyze');assert.equal(r.body.error,'MODEL_UNAVAILABLE');assert.equal(f.count('/api/v1/key'),0);assert.equal(f.count('/research/claim'),0);assert.equal(f.modelCalls(),0);
});
test('known quota/conflict rejection remains distinct from an uncertain committed claim',async t=>{
 for(const [claimCode,status,error] of [['BUDGET_EXCEEDED',429,'BUDGET_EXCEEDED'],['PRIVATE_CONFLICT',409,'REQUEST_CONFLICT']]){
  const f=fixture({claimCode}),call=await server(t,f.runtime),r=await call('/api/research/analyze');assert.equal(r.status,status);assert.equal(r.body.error,error);assert.equal(f.modelCalls(),0);assert.equal(f.records.size,0);
 }
 const f=fixture({commitUnknown:true}),call=await server(t,f.runtime),r=await call('/api/research/analyze');assert.equal(r.status,503);assert.equal(r.body.error,'OUTCOME_UNKNOWN');assert.equal(f.records.size,1);assert.equal(f.heldMicrousd(),20890);assert.equal(f.modelCalls(),0);
 const replay=await call('/api/research/analyze');assert.equal(replay.status,202);assert.equal(replay.body.state,'pending');assert.equal(f.count('/research/claim'),1);assert.equal(f.modelCalls(),0);
});
test('source failures release an unsent reservation; provider failure stays unknown and replays without dispatch',async t=>{
 const source=fixture({sourceUnavailable:true}),sourceCall=await server(t,source.runtime),bad=await sourceCall('/api/research/analyze');assert.equal(bad.status,503);assert.equal(bad.body.error,'EVIDENCE_UNAVAILABLE');assert.equal(bad.body.state,'failed');assert.equal(source.modelCalls(),0);assert.equal(source.heldMicrousd(),0);
 const model=fixture({modelUnavailable:true}),modelCall=await server(t,model.runtime),unknown=await modelCall('/api/research/analyze');assert.equal(unknown.status,202);assert.equal(unknown.body.state,'unknown');assert.equal(model.heldMicrousd(),20890);assert.equal(model.modelCalls(),1);
 assert.equal((await modelCall('/api/research/analyze')).body.state,'unknown');assert.equal(model.modelCalls(),1);assert.doesNotMatch(JSON.stringify(unknown.body),/offline-private-provider-diagnostic|offline_provider_key/);
});
test('route and body injection are rejected without model/source calls or arbitrary outbound endpoints',async t=>{
 const f=fixture(),call=await server(t,f.runtime);
 for(const path of ['/api/research?route=analyze&user_id=attacker','/api/research?route=..%2Fwallet%2Fnonce','/api/research/requests/runtime-request-0001?extra=1'])assert.equal((await call(path)).status,400);
 assert.equal(f.calls.length,0);const body=await call('/api/research/analyze',{body:{requestId:'runtime-request-0001',symbols:['BTC'],price:1,url:'https://evil.example'}});assert.equal(body.status,400);assert.equal(body.body.error,'REQUEST_INVALID');assert.equal(f.modelCalls(),0);assert.equal(f.count('/research/claim'),0);
});
// Page-side transport for the tests below: the research job client talks to the
// same HTTP route through the call helper, with the signed-in test session.
const pageFetch=call=>async(path,init)=>{const r=await call(path,{method:init.method,...(init.body?{body:JSON.parse(init.body)}:{})});return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':r.headers['content-type']}});};
const sourceCalls=f=>f.calls.filter(c=>new URL(c.url).hostname==='data-api.binance.vision').length;
const pageStorage=()=>{const entries=new Map();return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value))};};
test('reads of a stored record do not need the model provider key; a new analysis without it stays unconfigured with no outbound call',async t=>{
 const f=fixture(),first=await (await server(t,f.runtime))('/api/research/analyze');assert.equal(first.status,200);
 for(const key of [undefined,'']){
  const keyless=createResearchRuntime({env:{...env(),OPENROUTER_API_KEY:key},fetchImpl:f.fetchImpl,now:()=>NOW}),call=await server(t,keyless);assert.equal(keyless.configured,false);
  const read=await call('/api/research/requests/runtime-request-0001',{method:'GET'});assert.equal(read.status,200);const {ok,...record}=first.body;assert.equal(ok,true);assert.deepEqual(read.body,record);
  const other=await call('/api/research/requests/runtime-request-0001',{method:'GET',token:USER_B});assert.equal(other.status,404);assert.equal(other.body.error,'REQUEST_NOT_FOUND');
  const anonymous=await call('/api/research/requests/runtime-request-0001',{method:'GET',token:null});assert.equal(anonymous.status,401);assert.equal(anonymous.body.error,'AUTH_REQUIRED');
  const before=f.calls.length,fresh=await call('/api/research/analyze',{body:{requestId:'runtime-keyless-0002',symbols:['BTC']}});
  assert.equal(fresh.status,503);assert.equal(fresh.body.error,'UNCONFIGURED');assert.equal(fresh.body.executionAuthority,'NONE');assert.equal(f.calls.length,before);
  assert.equal(f.count('/api/v1/key'),1);assert.equal(f.count('/research/claim'),1);assert.equal(sourceCalls(f),1);assert.equal(f.modelCalls(),1);assert.equal(f.records.size,1);assert.equal(f.heldMicrousd(),20890);
  assert.doesNotMatch(JSON.stringify([read.body,other.body,fresh.body]),new RegExp([RUNTIME_TOKEN,ISSUER_TOKEN,MODEL_KEY,'person-a','tenant-a'].join('|')));
 }
});
test('today: a blocked research policy answers BUDGET_UNAVAILABLE before key, claim, source or model calls, and the page keeps the original request',async t=>{
 const f=fixture({policyPatch:{blocked:true}}),call=await server(t,f.runtime);
 const r=await call('/api/research/analyze',{body:{requestId:'runtime-blocked-0001',symbols:['BTC']}});
 assert.equal(r.status,503);assert.equal(r.body.error,'BUDGET_UNAVAILABLE');assert.equal(r.body.executionAuthority,'NONE');
 assert.equal(f.count('/api/v1/key'),0);assert.equal(f.count('/research/claim'),0);assert.equal(sourceCalls(f),0);assert.equal(f.modelCalls(),0);assert.equal(f.records.size,0);assert.equal(f.heldMicrousd(),0);
 const page=createResearchJobClient({fetchImpl:pageFetch(call),storage:pageStorage(),ownerRef:'offline-owner-a',symbols:['BTC'],now:()=>NOW,makeRequestId:()=>'runtime-blocked-0002'});
 await page.start();let snapshot=page.snapshot();
 assert.equal(snapshot.status,'service-unavailable');assert.equal(snapshot.error,'BUDGET_UNAVAILABLE');assert.equal(snapshot.result,null);assert.equal(snapshot.canQuery,true);assert.equal(snapshot.canRetryOriginal,false);
 let html=renderResearchJob(snapshot);assert.ok(html.includes(pair('研究额度尚未开通，原请求已保留。','Research allowance is not enabled. The original request is retained.')));
 assert.match(html,/data-research-job-action="query"/);assert.doesNotMatch(html,/data-research-job-action="retry"/);assert.doesNotMatch(html,/data-research-job-action="start"/);
 await page.query();snapshot=page.snapshot();
 assert.equal(snapshot.status,'unknown');assert.equal(snapshot.error,'REQUEST_NOT_FOUND');assert.equal(snapshot.canRetryOriginal,true);
 html=renderResearchJob(snapshot);assert.match(html,/data-research-job-action="retry"/);assert.ok(html.includes(pair('重试原请求','Retry original request')));
 assert.equal(f.count('/api/v1/key'),0);assert.equal(f.count('/research/claim'),0);assert.equal(sourceCalls(f),0);assert.equal(f.modelCalls(),0);assert.equal(f.records.size,0);page.destroy();
});
test('today: a lease outage while a stored record exists makes the read answer SERVICE_UNAVAILABLE without a record read or model call',async t=>{
 const f=fixture(),first=await (await server(t,f.runtime))('/api/research/analyze');assert.equal(first.status,200);
 const leaseDown=createResearchRuntime({env:env(),now:()=>NOW,fetchImpl:async(url,request)=>new URL(url).pathname.endsWith('/lease')?rejected('PRIVATE_UNAVAILABLE',503):f.fetchImpl(url,request)}),call=await server(t,leaseDown);
 const reads=f.count('/research/get'),read=await call('/api/research/requests/runtime-request-0001',{method:'GET'});
 assert.equal(read.status,503);assert.deepEqual(read.body,{ok:false,error:'SERVICE_UNAVAILABLE',executionAuthority:'NONE'});
 assert.equal(f.count('/research/get'),reads);assert.equal(f.modelCalls(),1);assert.equal(f.records.size,1);assert.equal(f.records.values().next().value.state,'complete');
});
// Stored research is read with the session cookie the page sends (same-origin
// credentials); a bare Bearer header is not a browser session credential here.
test('stored research reads refuse a bare Bearer session header from any client before any private call, with or without the model key',async t=>{
 const f=fixture(),first=await (await server(t,f.runtime))('/api/research/analyze');assert.equal(first.status,200);
 const readOnly=createResearchRuntime({env:{...env(),OPENROUTER_API_KEY:''},fetchImpl:f.fetchImpl,now:()=>NOW});assert.equal(readOnly.configured,false);
 for(const runtime of [readOnly,f.runtime]){
  const call=await server(t,runtime),before=f.calls.length;
  for(const headers of [{authorization:'Bearer '+USER_A},{authorization:'bearer '+USER_A},{authorization:'Bearer '+USER_A,'sec-fetch-site':'same-origin'},{authorization:'Bearer '+USER_B}]){
   const read=await call('/api/research/requests/runtime-request-0001',{method:'GET',token:null,headers});
   assert.equal(read.status,401);assert.deepEqual(read.body,{ok:false,error:'AUTH_REQUIRED',executionAuthority:'NONE'});
  }
  const both=await call('/api/research/requests/runtime-request-0001',{method:'GET',headers:{authorization:'Bearer '+USER_A}});assert.equal(both.status,401);assert.equal(both.body.error,'AUTH_REQUIRED');
  assert.equal(f.calls.length,before);
 }
 // A repeated POST returns the stored record too, so it takes the same credential.
 const call=await server(t,f.runtime),before=f.calls.length,replay=await call('/api/research/analyze',{token:null,headers:{authorization:'Bearer '+USER_A}});
 assert.equal(replay.status,401);assert.deepEqual(replay.body,{ok:false,error:'AUTH_REQUIRED',executionAuthority:'NONE'});assert.equal(f.calls.length,before);
 assert.equal(f.modelCalls(),1);assert.equal(f.count('/research/claim'),1);assert.equal(f.records.size,1);assert.equal(f.heldMicrousd(),20890);
});
test('the session cookie the page sends still reads only its own stored research, with or without the model key',async t=>{
 const f=fixture(),first=await (await server(t,f.runtime))('/api/research/analyze');assert.equal(first.status,200);const {ok,...record}=first.body;assert.equal(ok,true);
 const readOnly=createResearchRuntime({env:{...env(),OPENROUTER_API_KEY:''},fetchImpl:f.fetchImpl,now:()=>NOW});assert.equal(readOnly.configured,false);
 for(const runtime of [readOnly,f.runtime]){
  const call=await server(t,runtime);
  for(const options of [{},{token:null,headers:{cookie:'theme=dark; __Host-astarter_session='+USER_A+'; lang=en'}}]){
   const read=await call('/api/research/requests/runtime-request-0001',{method:'GET',...options});assert.equal(read.status,200);assert.deepEqual(read.body,record);
  }
  const other=await call('/api/research/requests/runtime-request-0001',{method:'GET',token:USER_B});assert.equal(other.status,404);assert.equal(other.body.error,'REQUEST_NOT_FOUND');
 }
 const replay=await (await server(t,f.runtime))('/api/research/analyze');assert.equal(replay.status,200);assert.deepEqual(replay.body,first.body);
 assert.equal(f.modelCalls(),1);assert.equal(f.count('/research/claim'),1);assert.equal(f.records.size,1);
});
