import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPrivateUIRuntime} from './private-ui-runtime.mjs';
import {createPrivateApiRoute} from './private-api-route.mjs';

const shared=JSON.parse(readFileSync(new URL('./private-draft-contract-fixtures.json',import.meta.url)));
const NOW=shared.source.createdAt+1000,HOST='astarter.imstark.site',ORIGIN='https://'+HOST,CORE='https://offline-draft-runtime.example',CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1';
const SERVICE='offline_draft_runtime_credential_01234567890123456789',COOKIE_A='offline_draft_a_session_01234567890123456789',COOKIE_B='offline_draft_b_session_01234567890123456789';
const A='wallet:56:0x'+'a'.repeat(40),B='wallet:56:0x'+'b'.repeat(40),ID='draft-original-0001',TOKEN='b'.repeat(64);
const PERMISSIONS=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const GROUPS=['source',...Object.keys(shared.previewGrid.fields).map(key=>'fields.'+key)];
const lease={leaseId:'draft-test-lease',targetId:'draft-test-target',database:'private_draft_test',schema:'private_draft_test',runtimeRole:'private_draft_runtime',audience:'astarter-research',budgetId:'services-2026-11',model:'openai/gpt-4.1-mini',expiresAt:NOW+3600000};
const binding={leaseId:lease.leaseId,targetId:lease.targetId,audience:lease.audience},copy=value=>structuredClone(value),hash=value=>createHash('sha256').update(value).digest('hex');
const input=()=>copy(shared.previewGrid),adopt=()=>({...input(),requestId:ID,expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN});
const env=()=>({ASTARTER_PRIVATE_UI_ENABLED:'1',ASTARTER_PRIVATE_DRAFTS_ENABLED:'1',ASTARTER_PRIVATE_SERVICE_ORIGIN:CORE,ASTARTER_PRIVATE_RUNTIME_TOKEN:SERVICE,ASTARTER_RESEARCH_LEASE_JSON:JSON.stringify(lease),ASTARTER_RESEARCH_MODEL_ENABLED:'0'});
const wire=result=>new Response(JSON.stringify({contract:CONTRACT,result}),{headers:{'Content-Type':'application/json'}});
const denied=(code,status)=>new Response(JSON.stringify({contract:CONTRACT,code}),{status,headers:{'Content-Type':'application/json'}});
function draftContent(fields){
 const missing=Object.entries(fields).filter(([,value])=>value===null).map(([key])=>key);
 return {catalogVersion:'private-paper-draft-v1',templateVersion:fields.planVariant+'@paper-v1',parameterOrigin:'user-confirmed',source:copy(shared.source),fields:copy(fields),missingFields:missing.sort(),executionAuthority:'NONE'};
}

// This is an explicit offline Core protocol double. It exercises the actual
// Node runtime, fixed RPC client, public facade and route adapter, not PG/SIWE.
function fixture(options={}){
 const clock={value:NOW},calls=[],sessions=new Map([[hash(COOKIE_A),A],[hash(COOKIE_B),B]]),records=new Map(),documents=new Map(),workspaces=new Map([[A,2],[B,2]]);
 const principal=options.principal||{},allowed=new Set(['session/resolve','drafts/preview','drafts/get','drafts/adopt','drafts/request']);
 const fetchImpl=async(url,init)=>{
  assert.equal(new URL(url).origin,CORE);assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+SERVICE);
  assert.equal(Object.keys(init.headers).some(key=>key.toLowerCase()==='cookie'),false);
  const path=new URL(url).pathname.slice('/internal/private/v1/'.length),body=JSON.parse(init.body),digest=init.headers['X-Astarter-Private-Session-Digest'],owner=sessions.get(digest);
  assert.ok(allowed.has(path),'no lease-policy, research, issuer, model, claim or finish RPC is allowed');calls.push({path,body:copy(body),digest});
  assert.doesNotMatch(init.body,/offline_draft_[ab]_session|ownerRef|subjectId|tenantId|scopeId|reservedMicrousd|reservedTokens/);
  if(!owner)return denied('PRIVATE_AUTH_REQUIRED',401);
  assert.equal(body.leaseId,binding.leaseId);assert.equal(body.targetId,binding.targetId);assert.equal(body.audience,binding.audience);
  if(path==='session/resolve'){
   assert.deepEqual(body,{...binding,tokenDigest:digest,now:clock.value});
   if(options.coreReject)return denied('PRIVATE_TARGET_MISMATCH',403);
   const result={subjectId:owner,scopeId:owner,tenantId:owner,audience:lease.audience,notBefore:NOW-1000,expiresAt:NOW+1800000,revokedAt:null,authVersion:2,permissionProfile:'private-ui-v2',permissions:[...PERMISSIONS],...principal};
   if(options.afterResolve!==undefined)clock.value=options.afterResolve;
   return wire(result);
  }
  if(options.remoteError)return denied(options.remoteError.code,options.remoteError.status);
  const key=owner+':'+(body.requestId||body.draftId);let result;
  if(path==='drafts/get')result=documents.get(key)||null;
  else if(path==='drafts/request')result=records.get(key)?.result||null;
  else if(path==='drafts/preview'){
   const current=documents.get(owner+':'+body.draftId)||null;
   result={schema:'private-draft-preview-v1',scope:owner,draftId:body.draftId,expectedRevision:current?.revision||0,workspaceRevision:workspaces.get(owner),proposalRevision:TOKEN,listed:Boolean(current),current:copy(current),proposal:draftContent(body.fields),changedFields:[...GROUPS]};
  }else{
   if(records.has(key)){
    if(records.get(key).body!==JSON.stringify(body))return denied('PRIVATE_CONFLICT',409);
    result=records.get(key).result;
   }else{
    const current=documents.get(owner+':'+body.draftId);
    if(body.expectedRevision!==(current?.revision||0)||body.workspaceRevision!==workspaces.get(owner)||body.proposalRevision!==TOKEN)return denied('PRIVATE_CONFLICT',409);
    const doc={schema:'private-strategy-draft-v1',scope:owner,draftId:body.draftId,revision:body.expectedRevision+1,savedAt:clock.value,content:draftContent(body.fields)};
    result={schema:'private-draft-command-v1',scope:owner,request:{requestId:body.requestId,draftId:body.draftId,status:'applied',expectedRevision:body.expectedRevision,revision:doc.revision,workspaceBaseRevision:body.workspaceRevision,workspaceRevision:body.workspaceRevision+1,appliedAt:doc.savedAt},draft:doc};
    records.set(key,{body:JSON.stringify(body),result:copy(result)});documents.set(owner+':'+body.draftId,copy(doc));workspaces.set(owner,body.workspaceRevision+1);
   }
   if(options.lostAdopt)throw Error('offline lost response after fixture commit '+SERVICE);
  }
  result=copy(result);options.reply?.(path,result,body);return wire(result);
 };
 const runtime=createPrivateUIRuntime({env:options.env||env(),fetchImpl,now:()=>clock.value});
 return {runtime,clock,calls,principal,records,documents,count:path=>calls.filter(call=>call.path===path).length};
}
async function call(f,path,{method='GET',body,cookie=COOKIE_A,headers={},routed=false}={}){
 const req={url:path,method,headers:{host:HOST,origin:ORIGIN,...(cookie?{cookie:'__Host-astarter_session='+cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body})};
 const response={status:0,headers:null,body:undefined},res={writeHead(status,values){response.status=status;response.headers=values;},end(raw){response.body=JSON.parse(raw);}};
 const handler=routed?createPrivateApiRoute('strategy-drafts',f.runtime.handleDrafts):f.runtime.handleDrafts;
 response.handled=await handler(req,res);if(routed)assert.equal(req.url,path,'the route adapter restores the original URL');return response;
}
function error(value,status,code){assert.equal(value.status,status);assert.equal(value.body.error,code);assert.equal(value.body.executionAuthority,'NONE');assert.equal(value.headers['Cache-Control'],'no-store');assert.equal(value.headers['X-Content-Type-Options'],'nosniff');assert.doesNotMatch(JSON.stringify(value.body),/offline_draft_|wallet:56:|password|driver-secret/);}

test('draft runtime is construction-inert and defaults closed independently of the free UI feature flag',async()=>{
 for(const patch of [{ASTARTER_PRIVATE_DRAFTS_ENABLED:undefined},{ASTARTER_PRIVATE_DRAFTS_ENABLED:'true'},{ASTARTER_PRIVATE_UI_ENABLED:undefined},{ASTARTER_PRIVATE_SERVICE_ORIGIN:'http://offline-draft-runtime.example'},{ASTARTER_PRIVATE_ISSUER_TOKEN:SERVICE},{ASTARTER_RESEARCH_LEASE_JSON:JSON.stringify({...lease,schema:'public'})}]){
  const f=fixture({env:{...env(),...patch}});assert.equal(f.runtime.draftsConfigured,false);assert.equal(f.runtime.draftBackend,undefined);assert.equal(f.calls.length,0);
  error(await call(f,'/api/strategy-drafts/get?draftId=draft-01'),503,'PRIVATE_UNCONFIGURED');assert.equal(f.calls.length,0);
 }
});

test('actual four public operations map exactly to fixed RPC payloads with a fresh v2 owner resolution and digest each time',async()=>{
 const f=fixture();assert.equal(f.runtime.draftsConfigured,true);assert.equal(f.calls.length,0);
 const before=await call(f,'/api/strategy-drafts/get?draftId=draft-01');assert.equal(before.status,200);assert.equal(before.body,null);
 const p=await call(f,'/api/strategy-drafts/preview',{method:'POST',body:input()});assert.equal(p.status,200);assert.equal(p.body.scope,A);assert.equal(p.body.proposal.executionAuthority,'NONE');assert.equal(f.records.size,0);assert.equal(f.documents.size,0,'preview is not a mutation');
 const applied=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt()});assert.equal(applied.status,200);assert.equal(applied.body.request.requestId,ID);assert.equal(applied.body.draft.content.executionAuthority,'NONE');
 const original=await call(f,'/api/strategy-drafts/request?requestId='+ID);assert.deepEqual(original.body,applied.body);
 assert.deepEqual(f.calls.filter(row=>row.path!=='session/resolve').map(row=>[row.path,row.body]),[['drafts/get',{...binding,draftId:'draft-01'}],['drafts/preview',{...binding,...input()}],['drafts/adopt',{...binding,...adopt()}],['drafts/request',{...binding,requestId:ID}]]);
 assert.equal(f.count('session/resolve'),4);assert.ok(f.calls.every(row=>row.digest===hash(COOKIE_A)));assert.equal(f.records.size,1);
});

test('actual runtime preserves nullable and S02 paper fields without converting a saved draft into an execution grant',async()=>{
 for(const kind of ['previewEmpty','previewBasket']){
  const f=fixture(),value=copy(shared[kind]),p=await call(f,'/api/strategy-drafts/preview',{method:'POST',body:value});assert.equal(p.status,200);assert.deepEqual(p.body.proposal.fields,value.fields);
  const saved=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:{...value,requestId:ID,expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN}});assert.equal(saved.status,200);assert.deepEqual(saved.body.draft.content.fields,value.fields);assert.equal(saved.body.draft.content.executionAuthority,'NONE');assert.equal(Object.hasOwn(saved.body,'runnable'),false);assert.equal(Object.hasOwn(saved.body,'approved'),false);
  if(kind==='previewEmpty')assert.deepEqual(saved.body.draft.content.missingFields,['amount','botParameters','cap','executionRoute','protection','researchBudget']);
  assert.deepEqual(f.calls.filter(row=>row.path==='drafts/adopt')[0].body.fields,value.fields);
 }
});

test('native and rewrite route forms preserve exact query identity without accepting forged route or binding fields',async()=>{
 const f=fixture();assert.equal((await call(f,'/api/strategy-drafts?route=get&draftId=draft-01',{routed:true})).status,200);
 for(const path of ['/api/strategy-drafts?route=get&route=adopt&draftId=draft-01','/api/strategy-drafts/get?route=adopt&draftId=draft-01','/api/strategy-drafts/get?draftId=draft-01&draftId=draft-02','/api/strategy-drafts/get?draftId=draft-01&leaseId=forged','/api/strategy-drafts/request?requestId='+ID+'&ownerRef='+B])assert.equal((await call(f,path,{routed:true})).status,400);
 assert.equal(f.count('session/resolve'),1);assert.equal(f.count('drafts/get'),1);
});

test('missing, ambiguous, cross-site and caller-owned credentials fail before RPC while a spoofed digest never changes the actual cookie owner',async()=>{
 const f=fixture(),path='/api/strategy-drafts/get?draftId=draft-01';
 for(const options of [{cookie:null},{headers:{authorization:'Bearer '+COOKIE_B}},{headers:{cookie:'__Host-astarter_session='+COOKIE_A+'; __Host-astarter_session='+COOKIE_B}}])error(await call(f,path,options),401,'AUTH_REQUIRED');
 for(const header of ['x-workspace-id','x-user-id','x-owner-ref','x-tenant-id','x-scope-id','x-subject-id'])error(await call(f,path,{headers:{[header]:B}}),400,'PRIVATE_REQUEST_INVALID');
 error(await call(f,path,{headers:{origin:'https://wrong.example'}}),403,'ORIGIN_DENIED');error(await call(f,path,{headers:{'sec-fetch-site':'cross-site'}}),403,'ORIGIN_DENIED');assert.equal(f.calls.length,0);
 const good=await call(f,path,{headers:{'x-astarter-private-session-digest':hash(COOKIE_B),'x-astarter-auth-version':'2'}});assert.equal(good.status,200);assert.ok(f.calls.every(row=>row.digest===hash(COOKIE_A)));
});

test('v1, partial or extra permissions and incorrect owner mappings never reach any draft RPC',async()=>{
 const invalid=[
  [{authVersion:1,permissionProfile:'research-v1',permissions:['research:analyze']},403,'PRIVATE_FORBIDDEN'],[{permissions:PERMISSIONS.slice(0,-1)},403,'PRIVATE_FORBIDDEN'],[{permissions:[...PERMISSIONS].reverse()},403,'PRIVATE_FORBIDDEN'],[{permissions:[...PERMISSIONS,'trade:execute']},403,'PRIVATE_FORBIDDEN'],[{permissionProfile:'other-profile'},403,'PRIVATE_FORBIDDEN'],
  [{tenantId:B},401,'AUTH_REQUIRED'],[{scopeId:B},401,'AUTH_REQUIRED'],[{subjectId:'person-a'},401,'AUTH_REQUIRED'],[{audience:'other'},401,'AUTH_REQUIRED'],[{notBefore:NOW+5001},401,'AUTH_REQUIRED'],[{expiresAt:NOW},401,'AUTH_REQUIRED'],[{revokedAt:NOW},401,'AUTH_REQUIRED']
 ];
 for(const [principal,status,code]of invalid){const f=fixture({principal});error(await call(f,'/api/strategy-drafts/preview',{method:'POST',body:input()}),status,code);assert.deepEqual(f.calls.map(row=>row.path),['session/resolve']);}
});

test('a legacy research-only session is rejected independently on all four draft operations before storage RPCs',async()=>{
 const f=fixture({principal:{authVersion:1,permissionProfile:'research-v1',permissions:['research:analyze']}});
 for(const [path,options]of [['/api/strategy-drafts/preview',{method:'POST',body:input()}],['/api/strategy-drafts/get?draftId=draft-01',{}],['/api/strategy-drafts/adopt',{method:'POST',body:adopt()}],['/api/strategy-drafts/request?requestId='+ID,{}]])error(await call(f,path,options),403,'PRIVATE_FORBIDDEN');
 assert.equal(f.calls.length,4);assert.ok(f.calls.every(row=>row.path==='session/resolve'));assert.equal(f.records.size,0);assert.equal(f.documents.size,0);
});

test('lease, current session and revocation are rechecked per call and after the resolver returns',async()=>{
 const f=fixture();assert.equal((await call(f,'/api/strategy-drafts/get?draftId=draft-01')).status,200);f.principal.revokedAt=NOW;
 error(await call(f,'/api/strategy-drafts/get?draftId=draft-01'),401,'AUTH_REQUIRED');assert.equal(f.count('session/resolve'),2);assert.equal(f.count('drafts/get'),1);
 const expired=fixture();expired.clock.value=lease.expiresAt;error(await call(expired,'/api/strategy-drafts/get?draftId=draft-01'),503,'PRIVATE_UNCONFIGURED');assert.equal(expired.calls.length,0);
 for(const [options,status,code]of [[{afterResolve:lease.expiresAt},503,'PRIVATE_UNCONFIGURED'],[{afterResolve:NOW+1000,principal:{expiresAt:NOW+1000}},401,'AUTH_REQUIRED'],[{coreReject:true},403,'PRIVATE_TARGET_MISMATCH']]){const bad=fixture(options);error(await call(bad,'/api/strategy-drafts/get?draftId=draft-01'),status,code);assert.deepEqual(bad.calls.map(row=>row.path),['session/resolve']);}
});

test('strict browser inputs and internal GET references reject getters, prototypes and caller bindings before authorization',async()=>{
 const f=fixture(),req={headers:{cookie:'__Host-astarter_session='+COOKIE_A}};let called=0;
 for(const method of ['draftsGet','draftsRequest'])for(const modify of [value=>{value.ownerRef=B;},value=>{value.leaseId='other';},value=>Object.setPrototypeOf(value,{inherited:true}),value=>Object.defineProperty(value,method==='draftsGet'?'draftId':'requestId',{get(){called++;return ID;},enumerable:true})]){
  const value=method==='draftsGet'?{draftId:'draft-01'}:{requestId:ID};modify(value);await assert.rejects(async()=>f.runtime.draftBackend[method](req,value),{code:'PRIVATE_REQUEST_INVALID'});
 }
 for(const field of ['ownerRef','scope','leaseId','targetId','audience','source','executionAuthority','apiKey']){const value=adopt();value[field]=field==='source'?copy(shared.source):B;error(await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:value}),400,'PRIVATE_REQUEST_INVALID');}
 const getter=input();Object.defineProperty(getter.fields,'amount',{get(){called++;return 20;},enumerable:true});error(await call(f,'/api/strategy-drafts/preview',{method:'POST',body:getter}),400,'PRIVATE_REQUEST_INVALID');
 for(const raw of ['{','{"__proto__":{"scope":"other"}}',Buffer.from([0xc3,0x28])])error(await call(f,'/api/strategy-drafts/preview',{method:'POST',body:raw}),400,'PRIVATE_REQUEST_INVALID');
 assert.equal(called,0);assert.equal(f.calls.length,0);
});

test('opaque session owners isolate both draft storage and identical request IDs without granting execution or model budget',async()=>{
 const f=fixture(),a=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt()});assert.equal(a.body.scope,A);
 assert.equal((await call(f,'/api/strategy-drafts/request?requestId='+ID,{cookie:COOKIE_B})).body,null);
 const b=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt(),cookie:COOKIE_B});assert.equal(b.body.scope,B);assert.equal(f.records.size,2);
 assert.equal((await call(f,'/api/strategy-drafts/get?draftId=draft-01')).body.scope,A);assert.equal((await call(f,'/api/strategy-drafts/get?draftId=draft-01',{cookie:COOKIE_B})).body.scope,B);
 assert.ok(f.calls.every(row=>row.path==='session/resolve'||row.path.startsWith('drafts/')));assert.equal(f.count('session/resolve'),5);
});

test('wrong-owner read responses fail closed while an already dispatched malformed adopt remains unknown with its original ID',async()=>{
 for(const operation of ['preview','get']){
  const f=fixture({reply(path,value){if(path==='drafts/'+operation&&value){value.scope=B;}}});
  if(operation==='get')await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt()});
  const response=operation==='preview'?await call(f,'/api/strategy-drafts/preview',{method:'POST',body:input()}):await call(f,'/api/strategy-drafts/get?draftId=draft-01');error(response,503,'PRIVATE_UI_PROTOCOL');
 }
 for(const reply of [value=>{value.scope=B;value.draft.scope=B;},value=>{value.request.requestId='other-original-0001';},value=>{value.request.expectedRevision=1;},value=>{value.request.expectedRevision=1;value.request.revision=2;value.draft.revision=2;},value=>{value.request.workspaceBaseRevision=3;value.request.workspaceRevision=4;},value=>{value.draft.content.source.sourceRequestId='other-research-01';},value=>{value.draft.content.fields.name='Different fields';}]){
  const f=fixture({reply(path,value){if(path==='drafts/adopt')reply(value);}}),response=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt()});error(response,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(response.body.requestId,ID);assert.equal(response.body.queryOriginalRequest,true);assert.equal(f.count('drafts/adopt'),1);
 }
});

test('lost adopt response keeps the exact original ID, never retries and can only be resolved by an explicit same-ID read',async()=>{
 const f=fixture({lostAdopt:true}),response=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt()});error(response,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(response.body.requestId,ID);assert.equal(response.body.queryOriginalRequest,true);assert.equal(f.records.size,1);assert.equal(f.count('drafts/adopt'),1);
 const original=await call(f,'/api/strategy-drafts/request?requestId='+ID);assert.equal(original.status,200);assert.equal(original.body.request.requestId,ID);assert.equal(original.body.request.status,'applied');assert.equal(f.count('drafts/adopt'),1);assert.equal(f.count('drafts/request'),1);
});

test('known rejected CAS does not masquerade as an unknown commit and preview failures are never mutations',async()=>{
 const f=fixture({remoteError:{code:'PRIVATE_CONFLICT',status:409}}),response=await call(f,'/api/strategy-drafts/adopt',{method:'POST',body:adopt()});error(response,409,'PRIVATE_CONFLICT');assert.equal(Object.hasOwn(response.body,'queryOriginalRequest'),false);assert.equal(f.records.size,0);assert.equal(f.count('drafts/adopt'),1);
 const previewFailure=fixture({reply(path){if(path==='drafts/preview')throw Error('driver-secret '+SERVICE);}});error(await call(previewFailure,'/api/strategy-drafts/preview',{method:'POST',body:input()}),503,'PRIVATE_UNAVAILABLE');assert.equal(previewFailure.records.size,0);assert.equal(previewFailure.count('drafts/preview'),1);
});
