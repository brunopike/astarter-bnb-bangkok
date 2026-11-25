import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPrivateDraftClient,PRIVATE_RESEARCH_CONTRACT} from './private-service-client.mjs';

const shared=JSON.parse(readFileSync(new URL('./private-draft-contract-fixtures.json',import.meta.url))),ORIGIN='https://offline-draft-transport.example',TOKEN='offline_draft_transport_credential_01234567890123456789',DIGEST='a'.repeat(64),ID='draft-original-0001';
const binding={leaseId:'draft-test-lease',targetId:'draft-test-target',audience:'astarter-research'};
const payloads={inspectLease:binding,resolveSession:{...binding,tokenDigest:DIGEST,now:shared.source.createdAt+1000},draftsPreview:{...binding,...shared.previewGrid},draftsGet:{...binding,draftId:shared.previewGrid.draftId},draftsAdopt:{...binding,...shared.previewGrid,requestId:ID,expectedRevision:0,workspaceRevision:2,proposalRevision:'b'.repeat(64)},draftsRequest:{...binding,requestId:ID}};
const paths=['lease','session/resolve','drafts/preview','drafts/get','drafts/adopt','drafts/request'];
const wire=(result={},options={})=>new Response(JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,result}),{headers:{'Content-Type':'application/json'},...options});
const client=(fetchImpl,options={})=>createPrivateDraftClient({origin:ORIGIN,token:TOKEN,sessionDigest:DIGEST,fetchImpl,...options});
const remote=(code,status)=>new Response(JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,code}),{status,headers:{'Content-Type':'application/json'}});
function sanitized(issue,unknown=false){assert.equal(issue.outcomeUnknown,unknown);assert.doesNotMatch(issue.stack,/offline_draft_transport_credential|offline-draft-transport\.example|driver-secret|password|raw-cookie/);return true;}

test('draft client is construction-inert and exposes exactly the reviewed four RPCs plus session and lease reads',async()=>{
 const calls=[],c=client(async(url,init)=>{calls.push({url,init});return wire({offline:true});});
 assert.equal(c.configured,true);assert.equal(c.contract,PRIVATE_RESEARCH_CONTRACT);assert.equal(calls.length,0);
 assert.deepEqual(Object.keys(c).sort(),['configured','contract',...Object.keys(payloads)].sort());
 for(const method of Object.keys(payloads))assert.deepEqual(await c[method](payloads[method]),{offline:true});
 assert.deepEqual(calls.map(row=>row.url),paths.map(path=>ORIGIN+'/internal/private/v1/'+path));
 for(const [index,{init}]of calls.entries()){
  assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers,{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json','X-Astarter-Private-Session-Digest':DIGEST});assert.deepEqual(JSON.parse(init.body),Object.values(payloads)[index]);assert.ok(!init.body.includes(TOKEN));
 }
 for(const name of ['claim','finish','get','issueSession','issueChallenge','workspaceSave','notificationsCommand','fetch','post'])assert.equal(c[name],undefined);
});

test('unconfigured endpoints and missing or substituted session digests perform no transport',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return wire();};
 for(const options of [{origin:'http://offline-draft-transport.example'},{origin:ORIGIN+'/path'},{origin:ORIGIN+'?redirect=1'},{origin:'https://user:password@offline-draft-transport.example'},{origin:ORIGIN+':443'},{origin:ORIGIN+':8443'},{token:'short'}]){
  const c=client(fetchImpl,options);assert.equal(c.configured,false);await assert.rejects(()=>c.draftsPreview(payloads.draftsPreview),{code:'PRIVATE_RPC_UNCONFIGURED',outcomeUnknown:false});
 }
 for(const sessionDigest of [undefined,'','bad','a'.repeat(63),'A'.repeat(64)])for(const method of Object.keys(payloads))await assert.rejects(()=>client(fetchImpl,{sessionDigest})[method](payloads[method]),{code:'AUTH_REQUIRED',status:401,outcomeUnknown:false});
 await assert.rejects(()=>client(fetchImpl).resolveSession({...payloads.resolveSession,tokenDigest:'b'.repeat(64)}),{code:'AUTH_REQUIRED',status:401,outcomeUnknown:false});assert.equal(calls,0);
});

test('strict server field maps reject owner/header/price overrides, prototypes, getters and credentials before dispatch',async()=>{
 let calls=0,got=0;const c=client(async()=>{calls++;return wire();});
 for(const method of ['draftsPreview','draftsGet','draftsAdopt','draftsRequest']){
  for(const patch of [{ownerRef:'wallet:56:other'},{subjectId:'other'},{tenantId:'other'},{scopeId:'other'},{cookie:'raw-cookie'},{url:'https://wrong.example'},{maxPrice:1},{'X-Astarter-Private-Session-Digest':'b'.repeat(64)}])await assert.rejects(()=>c[method]({...payloads[method],...patch}),{code:'PRIVATE_RPC_INVALID_REQUEST',outcomeUnknown:false});
  const inherited=Object.assign(Object.create({inherited:true}),payloads[method]);await assert.rejects(()=>c[method](inherited),{code:'PRIVATE_RPC_INVALID_REQUEST'});
  const getter={...payloads[method]};Object.defineProperty(getter,method==='draftsRequest'?'requestId':'draftId',{enumerable:true,get(){got++;return 'draft-01';}});await assert.rejects(()=>c[method](getter),{code:'PRIVATE_RPC_INVALID_REQUEST'});
 }
 const credential=structuredClone(payloads.draftsPreview);credential.fields.name='sk-or-v1-'+'x'.repeat(24);await assert.rejects(()=>c.draftsPreview(credential),{code:'PRIVATE_RPC_INVALID_REQUEST'});
 assert.equal(got,0);assert.equal(calls,0);
});

test('nullable reads remain null and only adopt dispatch creates an unknown mutation outcome',async()=>{
 for(const method of ['draftsGet','draftsRequest','resolveSession'])assert.equal(await client(async()=>wire(null))[method](payloads[method]),null);
 for(const method of ['draftsPreview','draftsAdopt'])await assert.rejects(()=>client(async()=>wire(null))[method](payloads[method]),issue=>{assert.equal(issue.code,method==='draftsAdopt'?'PRIVATE_RPC_OUTCOME_UNKNOWN':'PRIVATE_RPC_PROTOCOL');return sanitized(issue,method==='draftsAdopt');});
 for(const method of ['draftsPreview','draftsGet','draftsAdopt','draftsRequest']){
  let calls=0;await assert.rejects(()=>client(async()=>{calls++;throw Error('driver-secret '+TOKEN);})[method](payloads[method]),issue=>{assert.equal(issue.code,method==='draftsAdopt'?'PRIVATE_RPC_OUTCOME_UNKNOWN':'PRIVATE_RPC_UNAVAILABLE');return sanitized(issue,method==='draftsAdopt');});assert.equal(calls,1);
 }
});

test('known Core rejections preserve their code and definite rejection while unknown adopt remains uncertain',async()=>{
 for(const [code,status,unknown]of [['PRIVATE_AUTH_REQUIRED',401,false],['PRIVATE_FORBIDDEN',403,false],['PRIVATE_TARGET_MISMATCH',403,false],['PRIVATE_REQUEST_INVALID',400,false],['PRIVATE_CONFLICT',409,false],['BUDGET_EXCEEDED',409,false],['PRIVATE_COMMIT_UNKNOWN',409,true],['PRIVATE_UNAVAILABLE',503,true]]){
  let calls=0;await assert.rejects(()=>client(async()=>{calls++;return remote(code,status);}).draftsAdopt(payloads.draftsAdopt),issue=>{assert.equal(issue.code,code);assert.equal(issue.status,status);return sanitized(issue,unknown);});assert.equal(calls,1);
 }
});

test('invalid JSON, wrong envelope, redirect and credential-bearing responses are sanitized and never retried',async()=>{
 const replies=[
  [()=>new Response('{driver-secret',{headers:{'Content-Type':'application/json'}}),'PRIVATE_RPC_UNAVAILABLE'],
  [()=>new Response(JSON.stringify({contract:'PUBLIC',result:{}}),{headers:{'Content-Type':'application/json'}}),'PRIVATE_RPC_PROTOCOL'],
  [()=>wire({secret:'driver-secret'}),'PRIVATE_RPC_PROTOCOL'],[()=>wire({text:'postgres://user:password@database/db'}),'PRIVATE_RPC_PROTOCOL'],[()=>wire({text:TOKEN}),'PRIVATE_RPC_PROTOCOL'],
  [()=>wire({}, {status:302,headers:{'Content-Type':'application/json',Location:'https://wrong.example'}}),'PRIVATE_RPC_PROTOCOL'],
  [()=>new Response('driver-secret',{headers:{'Content-Type':'text/html'}}),'PRIVATE_RPC_PROTOCOL'],
  [()=>{const value=wire();Object.defineProperty(value,'url',{value:'https://wrong.example/'});return value;},'PRIVATE_RPC_PROTOCOL']
 ];
 for(const method of ['draftsPreview','draftsAdopt'])for(const [make,readCode]of replies){let calls=0;await assert.rejects(()=>client(async()=>{calls++;return make();})[method](payloads[method]),issue=>{assert.equal(issue.code,method==='draftsAdopt'?'PRIVATE_RPC_OUTCOME_UNKNOWN':readCode);return sanitized(issue,method==='draftsAdopt');});assert.equal(calls,1);}
});

test('the RPC deadline includes a stalled fetch and its late completion cannot redispatch or change the unknown original',async()=>{
 for(const method of ['draftsPreview','draftsAdopt']){
  let calls=0,aborts=0,resolve;const c=client(async(_url,{signal})=>{calls++;signal.addEventListener('abort',()=>aborts++);return new Promise(done=>{resolve=done;});},{timeoutMs:50});
  await assert.rejects(()=>c[method](payloads[method]),issue=>{assert.equal(issue.code,method==='draftsAdopt'?'PRIVATE_RPC_OUTCOME_UNKNOWN':'PRIVATE_RPC_UNAVAILABLE');return sanitized(issue,method==='draftsAdopt');});
  assert.equal(calls,1);assert.equal(aborts,1);resolve(wire({late:true}));await new Promise(done=>setImmediate(done));assert.equal(calls,1);
 }
});

test('the same deadline bounds response streaming and cancels a hanging body after successful headers',async()=>{
 for(const method of ['draftsGet','draftsAdopt']){
  let cancelled=0,calls=0;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"contract":'));},cancel(){cancelled++;}});
  await assert.rejects(()=>client(async()=>{calls++;return new Response(stream,{headers:{'Content-Type':'application/json'}});},{timeoutMs:50})[method](payloads[method]),issue=>{assert.equal(issue.code,method==='draftsAdopt'?'PRIVATE_RPC_OUTCOME_UNKNOWN':'PRIVATE_RPC_UNAVAILABLE');return sanitized(issue,method==='draftsAdopt');});assert.equal(cancelled,1);assert.equal(calls,1);
 }
});

test('lost adopt response retains the original ID and only an explicit request query uses it again without replaying the mutation',async()=>{
 const calls=[],c=client(async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});if(url.endsWith('/adopt'))throw Error('driver-secret lost response');return wire(null);});
 await assert.rejects(()=>c.draftsAdopt(payloads.draftsAdopt),issue=>sanitized(issue,true));assert.equal(calls.length,1);
 assert.equal(await c.draftsRequest(payloads.draftsRequest),null,'absence of a record is returned as unknown to the caller, never proof of a failed write');assert.equal(calls.length,2);
 assert.ok(calls.every(value=>value.body.requestId===ID));assert.equal(calls.filter(value=>value.url.endsWith('/adopt')).length,1);assert.ok(calls.at(-1).url.endsWith('/drafts/request'));
});
