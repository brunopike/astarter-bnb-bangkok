import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createPrivateUIRuntime} from './private-ui-runtime.mjs';
import {createPrivateWorkspaceClient} from './private-workspace-client.mjs';
import {createPrivateResearchClient} from './private-service-client.mjs';
import {createResearchPrivateAdapters} from './research-private-store.mjs';

const NOW=Date.UTC(2026,10,16,14),HOST='astarter.imstark.site',ORIGIN='https://'+HOST;
const PRIVATE_ORIGIN='https://offline-private-ui.example',CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1';
const RUNTIME='offline_ui_runtime_credential_01234567890123456789';
const USER_A='offline_ui_a_session_01234567890123456789',USER_B='offline_ui_b_session_01234567890123456789';
const A='wallet:56:0x'+'a'.repeat(40),B='wallet:56:0x'+'b'.repeat(40);
const PERMISSIONS=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const lease={leaseId:'lease-ui-test',targetId:'target-ui-test',database:'private_ui_test',schema:'private_ui_fixture',runtimeRole:'private_ui_runtime',audience:'astarter-research',budgetId:'services-2026-11',model:'openai/gpt-4.1-mini',expiresAt:NOW+3600000};
const binding={leaseId:lease.leaseId,targetId:lease.targetId,audience:lease.audience};
const leaseKeys=Object.keys(lease);
const hash=value=>createHash('sha256').update(value).digest('hex'),copy=value=>structuredClone(value);
const wire=result=>new Response(JSON.stringify({contract:CONTRACT,result}),{headers:{'Content-Type':'application/json'}});
const rejected=(code,status)=>new Response(JSON.stringify({contract:CONTRACT,code}),{status,headers:{'Content-Type':'application/json'}});
const env=()=>({ASTARTER_PRIVATE_UI_ENABLED:'1',ASTARTER_PRIVATE_SERVICE_ORIGIN:PRIVATE_ORIGIN,ASTARTER_PRIVATE_RUNTIME_TOKEN:RUNTIME,ASTARTER_RESEARCH_LEASE_JSON:JSON.stringify(lease)});
function fields(name='Offline fixture draft'){return {preferences:{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC']},drafts:[{id:'draft-1',strategyId:'S03',name}],selectedDraftId:'draft-1'};}
const command=(requestId='ui-original-0001',name)=>({requestId,baseRevision:0,...fields(name)});
const workspace=(owner,revision=0)=>({schema:'private-workspace-v1',scope:owner,revision,updatedAt:NOW,...fields(),executionAuthority:'NONE'});
function notification(owner){return {schema:'private-notifications-v1',scope:owner,revision:0,updatedAt:NOW,inapp:true,events:['orders','risk','research'],services:{telegram:{available:false,error:'CHANNEL_DISABLED'},email:{available:false,error:'CHANNEL_DISABLED'}},channels:{telegram:{channel:'telegram',label:'',enabled:0,verified:0},email:{channel:'email',label:'',enabled:0,verified:0}},deliveries:[],inbox:[],unreadCount:0,nextCursor:null,mode:'server-research-only'};}
const receipt=(domain,input,state)=>({request:{schema:'private-ui-command-v1',domain,requestId:input.requestId,status:'applied',baseRevision:input.baseRevision,revision:state.revision,appliedAt:NOW},state:copy(state)});
const paths=new Set(['lease','session/resolve','notifications/state','notifications/command','notifications/request','workspace/state','workspace/save','workspace/request']);

// Explicit offline internal HTTPS protocol owner. The actual runtime, RPC
// serializer, outer HTTP facade and (where used) browser client are exercised.
// No PG, SIWE, live network, model, provider or external delivery is involved.
function fixture(options={}){
 const clock={value:NOW},calls=[],records=new Map(),states=new Map([[A,workspace(A)],[B,workspace(B)]]),notices=new Map([[A,notification(A)],[B,notification(B)]]);
 const sessions=new Map([[hash(USER_A),A],[hash(USER_B),B]]);
 const fetchImpl=async(url,init)=>{
  assert.equal(new URL(url).origin,PRIVATE_ORIGIN);assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+RUNTIME);
  assert.equal(Object.keys(init.headers).some(key=>key.toLowerCase()==='cookie'),false);assert.equal(init.headers['X-Workspace-Id'],undefined);
  const path=new URL(url).pathname.slice('/internal/private/v1/'.length);assert.equal(paths.has(path),true,'fixed internal RPC allowlist');
  const body=JSON.parse(init.body),digest=init.headers['X-Astarter-Private-Session-Digest'],owner=sessions.get(digest);calls.push({path,body:copy(body),digest});
  assert.doesNotMatch(init.body,/offline_ui_[ab]_session|ownerRef|subjectId|scopeId|tenantId/);
  if(!owner)return rejected('PRIVATE_AUTH_REQUIRED',401);
  if(path==='lease'){
   assert.deepEqual(body,binding);
   if(options.noResearchPolicy)return rejected('PRIVATE_UNAVAILABLE',503);
   return wire({contract:CONTRACT,kind:'PRIVATE',...lease,now:clock.value,...options.metadata});
  }
  if(path==='session/resolve'){
   assert.deepEqual(body,{...binding,tokenDigest:digest,now:clock.value});
   // Model the Core session owner's rejection contract. Free UI does not call
   // the research lease/policy endpoint; the real PG owner is verified separately.
   const actual={contract:CONTRACT,kind:'PRIVATE',...lease,now:clock.value,...options.metadata};
   if(actual.contract!==CONTRACT||actual.kind!=='PRIVATE'||leaseKeys.some(key=>actual[key]!==lease[key])||!Number.isSafeInteger(actual.now)||Math.abs(actual.now-clock.value)>5000||actual.expiresAt<=actual.now)return rejected('PRIVATE_TARGET_MISMATCH',403);
   if(options.afterResolveClock!==undefined)clock.value=options.afterResolveClock;
   return wire({subjectId:owner,scopeId:owner,tenantId:owner,audience:lease.audience,notBefore:NOW-1000,expiresAt:options.sessionExpires??NOW+1800000,revokedAt:null,authVersion:2,permissionProfile:'private-ui-v2',permissions:[...PERMISSIONS],...options.principal});
  }
  assert.equal(body.leaseId,lease.leaseId);assert.equal(body.targetId,lease.targetId);assert.equal(body.audience,lease.audience);
  if(path==='workspace/state')return wire(options.wrongReadOwner?workspace(owner===A?B:A):states.get(owner));
  if(path==='notifications/state'){
   const value=options.wrongReadOwner?notification(owner===A?B:A):notices.get(owner);
   return wire(body.responseVersion===2?{...value,schema:'private-notifications-v2',reminderUnreadCount:value.inapp?options.reminderUnreadCount??value.unreadCount:0}:value);
  }
  const domain=path.startsWith('workspace/')?'workspace':'notifications',key=domain+':'+digest+':'+body.requestId;
  if(path.endsWith('/request'))return wire(records.get(key)||null);
  if(records.has(key))return wire(records.get(key));
  const current=(domain==='workspace'?states:notices).get(owner);
  if(body.baseRevision!==current.revision)return rejected('PRIVATE_CONFLICT',409);
  const state=domain==='workspace'?{...current,preferences:copy(body.preferences),drafts:copy(body.drafts),selectedDraftId:body.selectedDraftId,revision:current.revision+1}:{...current,revision:current.revision+1,...(body.action==='save'?{inapp:body.payload.inapp,events:copy(body.payload.events)}:{})};
  (domain==='workspace'?states:notices).set(owner,state);const result=receipt(domain,body,state);records.set(key,copy(result));
  if(options.unknownWrite)throw Error('offline HTTP response lost after durable fixture commit');
  if(options.badReceipt)options.badReceipt(result);
  return wire(result);
 };
 const runtime=createPrivateUIRuntime({env:options.env||env(),fetchImpl,now:()=>clock.value});
 return {runtime,fetchImpl,calls,records,states,notices,clock,count:path=>calls.filter(call=>call.path===path).length};
}
async function server(t,runtime){
 const http=createServer((req,res)=>{void runtime.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end('{}');}}).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('{}');});});
 http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve);}));
 const endpoint='http://127.0.0.1:'+http.address().port;
 return (path,{method='GET',body,token=USER_A,headers={},signal}={})=>new Promise((resolve,reject)=>{
  const raw=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  const req=httpRequest(endpoint+path,{method,headers:{host:HOST,origin:ORIGIN,...(raw===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(raw)}),...(token?{cookie:'__Host-astarter_session='+token}:{}),...headers},signal},res=>{
   const chunks=[];res.on('error',reject);res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers});}catch(error){reject(error);}});
  });req.on('error',reject);req.end(raw);
 });
}
function errorResponse(response,status,code){assert.equal(response.status,status);assert.equal(response.body.error,code);assert.equal(response.body.executionAuthority,'NONE');assert.equal(response.headers['cache-control'],'no-store');assert.doesNotMatch(JSON.stringify(response.body),/offline_ui_|wallet:56:/);}

test('actual UI HTTP runtime negotiates strict v2 count reads while commands and original receipts stay v1',async t=>{
 const f=fixture({reminderUnreadCount:4}),call=await server(t,f.runtime),old=notification(A);
 const item={id:'offline-notice-1',type:'research',title:'Offline historical receipt',body:'No model was called.',source:'server-research',requestId:'offline-research-1',createdAt:NOW,readAt:null,executionAuthority:'NONE'};
 f.notices.set(A,{...old,events:['risk'],inbox:[item],unreadCount:8,nextCursor:'older_page'});
 const legacy=await call('/api/notifications/state');assert.equal(legacy.status,200);assert.equal(legacy.body.schema,'private-notifications-v1');assert.equal(Object.hasOwn(legacy.body,'reminderUnreadCount'),false);
 const fresh=await call('/api/notifications/state?responseVersion=2');assert.equal(fresh.status,200);assert.equal(fresh.body.reminderUnreadCount,4);assert.equal(fresh.body.inbox[0].type,'research');assert.equal(fresh.body.unreadCount,8);
 const stateRPCs=f.calls.filter(row=>row.path==='notifications/state');assert.deepEqual(stateRPCs[0].body,{...binding,cursor:null,limit:20});assert.deepEqual(stateRPCs[1].body,{...binding,cursor:null,limit:20,responseVersion:2});assert.ok(stateRPCs.every(row=>row.digest===hash(USER_A)));
 const input={requestId:'notification-optout-0001',baseRevision:0,action:'save',payload:{events:['risk'],enabled:{telegram:false,email:false},inapp:false}};
 const applied=await call('/api/notifications/command',{method:'POST',body:input});assert.equal(applied.status,200);assert.equal(applied.body.state.schema,'private-notifications-v1');assert.equal(Object.hasOwn(applied.body.state,'reminderUnreadCount'),false);
 const muted=await call('/api/notifications/state?responseVersion=2');assert.equal(muted.body.reminderUnreadCount,0);assert.equal(muted.body.inbox.length,1);assert.equal(muted.body.unreadCount,8);
 assert.deepEqual((await call('/api/notifications/request?requestId='+input.requestId)).body,applied.body);
 const before=f.calls.length;for(const path of ['/api/notifications/state?responseVersion=1','/api/notifications/state?responseVersion=2&responseVersion=2','/api/workspace/state?responseVersion=2'])errorResponse(await call(path),400,'PRIVATE_REQUEST_INVALID');assert.equal(f.calls.length,before);
 const wrong=fixture({wrongReadOwner:true}),wrongCall=await server(t,wrong.runtime);errorResponse(await wrongCall('/api/notifications/state?responseVersion=2'),503,'PRIVATE_UI_PROTOCOL');
});

test('private UI runtime is inert and requires the exact feature flag, private lease and distinct issuer credential',async t=>{
 for(const patch of [{ASTARTER_PRIVATE_UI_ENABLED:undefined},{ASTARTER_PRIVATE_UI_ENABLED:'true'},{ASTARTER_PRIVATE_SERVICE_ORIGIN:'http://offline-private-ui.example'},{ASTARTER_PRIVATE_ISSUER_TOKEN:RUNTIME},{ASTARTER_RESEARCH_LEASE_JSON:JSON.stringify({...lease,schema:'public'})}]){
  const f=fixture({env:{...env(),...patch}});assert.equal(f.runtime.configured,false);assert.equal(f.calls.length,0);const call=await server(t,f.runtime);errorResponse(await call('/api/workspace/state'),503,'PRIVATE_UNCONFIGURED');assert.equal(f.calls.length,0);
 }
 assert.equal(fixture().runtime.configured,true);
});

test('all six free UI operations avoid paid policy inspection while the existing research contract still requires its lease endpoint',async t=>{
 const f=fixture({noResearchPolicy:true}),call=await server(t,f.runtime);
 for(const [path,options] of [
  ['/api/workspace/state',{}],['/api/workspace/save',{method:'POST',body:command()}],['/api/workspace/request?requestId=ui-original-0001',{}],
  ['/api/notifications/state',{}],['/api/notifications/command',{method:'POST',body:{requestId:'notice-original-0001',baseRevision:0,action:'save',payload:{events:['risk','research'],enabled:{telegram:false,email:false},inapp:false}}}],['/api/notifications/request?requestId=notice-original-0001',{}],
 ])assert.equal((await call(path,options)).status,200,path);
 assert.equal(f.count('lease'),0);assert.equal(f.count('session/resolve'),6);assert.equal(f.records.size,2);
 // Reuse the actual research adapter, without altering its paid admission
 // contract or fabricating a policy. Its mandatory lease RPC still fails.
 const research=createPrivateResearchClient({origin:PRIVATE_ORIGIN,token:RUNTIME,sessionDigest:hash(USER_A),fetchImpl:f.fetchImpl});
 const adapters=createResearchPrivateAdapters({dal:research,lease,now:()=>NOW});assert.equal(adapters.configured,true);
 await assert.rejects(()=>adapters.authorize({headers:{cookie:'__Host-astarter_session='+USER_A}}),/PRIVATE_UNAVAILABLE/);assert.equal(f.count('lease'),1);
});

test('actual runtime rejects v1 research-only sessions on all six UI operations before any state RPC',async t=>{
 const f=fixture({principal:{authVersion:1,permissionProfile:'research-v1',permissions:['research:analyze']}}),call=await server(t,f.runtime);
 for(const [path,options] of [
  ['/api/workspace/state',{}],['/api/workspace/request?requestId=ui-original-0001',{}],['/api/workspace/save',{method:'POST',body:command()}],
  ['/api/notifications/state',{}],['/api/notifications/request?requestId=ui-original-0001',{}],['/api/notifications/command',{method:'POST',body:{requestId:'ui-original-0001',baseRevision:0,action:'mark-read',payload:{ids:['notice-1']}}}],
 ])errorResponse(await call(path,options),403,'PRIVATE_FORBIDDEN');
 assert.equal(f.calls.length,6);assert.equal(f.calls.every(call=>call.path==='session/resolve'),true);assert.equal(f.records.size,0);
});

test('v2 requires the reviewed profile and exact permissions, while invalid owner mapping never authorizes',async t=>{
 for(const [principal,status,code] of [
  [{authVersion:1},403,'PRIVATE_FORBIDDEN'],[{permissionProfile:'research-v1'},403,'PRIVATE_FORBIDDEN'],[{permissions:['research:analyze']},403,'PRIVATE_FORBIDDEN'],[{permissions:[...PERMISSIONS].reverse()},403,'PRIVATE_FORBIDDEN'],[{permissions:[...PERMISSIONS,'trade:execute']},403,'PRIVATE_FORBIDDEN'],
  [{subjectId:'person-a'},401,'AUTH_REQUIRED'],[{tenantId:B},401,'AUTH_REQUIRED'],[{scopeId:B},401,'AUTH_REQUIRED'],[{audience:'other-audience'},401,'AUTH_REQUIRED'],[{notBefore:NOW+5001},401,'AUTH_REQUIRED'],[{revokedAt:NOW},401,'AUTH_REQUIRED'],
 ]){
  const f=fixture({principal}),call=await server(t,f.runtime);errorResponse(await call('/api/workspace/state'),status,code);assert.deepEqual(f.calls.map(call=>call.path),['session/resolve']);
 }
});

test('two opaque session digests isolate actual runtime reads and identical request IDs without forwarding owner inputs',async t=>{
 const f=fixture(),call=await server(t,f.runtime);
 assert.equal((await call('/api/workspace/state')).body.scope,A);assert.equal((await call('/api/workspace/state',{token:USER_B})).body.scope,B);
 const first=await call('/api/workspace/save',{method:'POST',body:command('same-original-0001','A metadata')}),foreignBefore=await call('/api/workspace/request?requestId=same-original-0001',{token:USER_B});
 assert.equal(first.status,200);assert.equal(first.body.state.scope,A);assert.equal(foreignBefore.body,null);
 const second=await call('/api/workspace/save',{method:'POST',token:USER_B,body:command('same-original-0001','B metadata')});assert.equal(second.status,200);assert.equal(second.body.state.scope,B);
 const ownA=await call('/api/workspace/request?requestId=same-original-0001'),ownB=await call('/api/workspace/request?requestId=same-original-0001',{token:USER_B});
 assert.equal(ownA.body.state.drafts[0].name,'A metadata');assert.equal(ownB.body.state.drafts[0].name,'B metadata');assert.equal(f.records.size,2);
 assert.deepEqual(new Set(f.calls.map(call=>call.digest)),new Set([hash(USER_A),hash(USER_B)]));
 assert.equal(f.count('lease'),0);assert.equal(f.count('session/resolve'),7);
});

test('every operation rechecks the server auth gate, expiry and revocation instead of caching a successful session',async t=>{
 const f=fixture({sessionExpires:NOW+1000}),call=await server(t,f.runtime);
 assert.equal((await call('/api/workspace/state')).status,200);f.clock.value=NOW+1000;errorResponse(await call('/api/workspace/state'),401,'AUTH_REQUIRED');assert.equal(f.count('workspace/state'),1);assert.equal(f.count('session/resolve'),2);
 const expired=fixture(),expiredCall=await server(t,expired.runtime);expired.clock.value=lease.expiresAt;errorResponse(await expiredCall('/api/workspace/state'),503,'PRIVATE_UNCONFIGURED');assert.equal(expired.calls.length,0);
});

test('Core-approved canonical-clock notBefore tolerance is at most five seconds and local expiry has no grace',async t=>{
 for(const skew of [1,5000]){
  const f=fixture({metadata:{now:NOW+skew},principal:{notBefore:NOW+skew}}),call=await server(t,f.runtime);assert.equal((await call('/api/workspace/state')).status,200);assert.equal(f.count('workspace/state'),1);assert.equal(f.count('lease'),0);
 }
 const invalid=fixture({principal:{notBefore:NOW+5001}}),invalidCall=await server(t,invalid.runtime);errorResponse(await invalidCall('/api/workspace/state'),401,'AUTH_REQUIRED');assert.equal(invalid.count('workspace/state'),0);
 const expired=fixture({metadata:{now:NOW-5000},principal:{notBefore:NOW-10000},sessionExpires:NOW}),expiredCall=await server(t,expired.runtime);errorResponse(await expiredCall('/api/workspace/state'),401,'AUTH_REQUIRED');assert.equal(expired.count('workspace/state'),0);
});

test('local lease and session expiry are checked again after the session RPC returns',async t=>{
 const leaseExpired=fixture({afterResolveClock:lease.expiresAt}),leaseCall=await server(t,leaseExpired.runtime);errorResponse(await leaseCall('/api/workspace/state'),503,'PRIVATE_UNCONFIGURED');assert.deepEqual(leaseExpired.calls.map(call=>call.path),['session/resolve']);
 const sessionExpired=fixture({sessionExpires:NOW+1000,afterResolveClock:NOW+1000}),sessionCall=await server(t,sessionExpired.runtime);errorResponse(await sessionCall('/api/workspace/state'),401,'AUTH_REQUIRED');assert.deepEqual(sessionExpired.calls.map(call=>call.path),['session/resolve']);
});

test('Core session resolution rejects private metadata drift and excessive clock skew before any UI state access',async t=>{
 for(const metadata of [{kind:'PUBLIC'},{contract:'other-contract'},{schema:'other_schema'},{database:'other_database'},{runtimeRole:'other_role'},{budgetId:'other-budget'},{targetId:'other-target'},{now:NOW+5001},{expiresAt:NOW}]){
  const f=fixture({metadata}),call=await server(t,f.runtime);errorResponse(await call('/api/workspace/state'),403,'PRIVATE_TARGET_MISMATCH');assert.deepEqual(f.calls.map(call=>call.path),['session/resolve']);
 }
});

test('ambiguous credentials, CSRF and caller owner headers are refused before any internal RPC',async t=>{
 const f=fixture(),call=await server(t,f.runtime);
 errorResponse(await call('/api/workspace/state',{token:null}),401,'AUTH_REQUIRED');
 errorResponse(await call('/api/workspace/state',{headers:{authorization:'Bearer '+USER_B}}),401,'AUTH_REQUIRED');
 errorResponse(await call('/api/workspace/state',{headers:{cookie:'__Host-astarter_session='+USER_A+'; __Host-astarter_session='+USER_B}}),401,'AUTH_REQUIRED');
 errorResponse(await call('/api/workspace/state',{headers:{'x-workspace-id':B}}),400,'PRIVATE_REQUEST_INVALID');
 errorResponse(await call('/api/workspace/save',{method:'POST',body:command(),headers:{origin:'https://other.example'}}),403,'ORIGIN_DENIED');assert.equal(f.calls.length,0);
 // A single Bearer credential is accepted but is never forwarded to the private owner.
 assert.equal((await call('/api/workspace/state',{token:null,headers:{authorization:'Bearer '+USER_B}})).body.scope,B);
});

test('browser-supplied private digest, auth profile and forwarded headers cannot replace the opaque session owner',async t=>{
 const spoofed={'x-astarter-private-session-digest':hash(USER_B),'x-astarter-auth-version':'2','x-astarter-permission-profile':'private-ui-v2','x-forwarded-host':'other.example','x-forwarded-proto':'https'};
 const f=fixture(),call=await server(t,f.runtime);const response=await call('/api/workspace/state',{headers:spoofed});assert.equal(response.status,200);assert.equal(response.body.scope,A);assert.equal(f.calls.every(value=>value.digest===hash(USER_A)),true);
 const count=f.calls.length;errorResponse(await call('/api/workspace/state',{token:null,headers:spoofed}),401,'AUTH_REQUIRED');assert.equal(f.calls.length,count);
 errorResponse(await call('/api/workspace/state',{headers:{...spoofed,origin:'https://other.example','x-forwarded-host':HOST}}),403,'ORIGIN_DENIED');assert.equal(f.calls.length,count);
 const old=fixture({principal:{authVersion:1,permissionProfile:'research-v1',permissions:['research:analyze']}}),oldCall=await server(t,old.runtime);errorResponse(await oldCall('/api/workspace/state',{headers:spoofed}),403,'PRIVATE_FORBIDDEN');assert.deepEqual(old.calls.map(value=>value.path),['session/resolve']);
});

test('actual runtime rejects wrong-owner read replies and treats malformed committed receipts as unknown',async t=>{
 const badRead=fixture({wrongReadOwner:true}),read=await server(t,badRead.runtime);
 errorResponse(await read('/api/workspace/state'),503,'PRIVATE_UI_PROTOCOL');errorResponse(await read('/api/notifications/state'),503,'PRIVATE_UI_PROTOCOL');
 for(const badReceipt of [result=>{result.state.scope=B;},result=>{result.request.requestId='wrong-original-0001';},result=>{result.request.baseRevision=1;},result=>{result.request.revision=2;}]){
  const f=fixture({badReceipt}),call=await server(t,f.runtime),response=await call('/api/workspace/save',{method:'POST',body:command()});
  errorResponse(response,409,'PRIVATE_COMMIT_UNKNOWN');assert.equal(response.body.requestId,'ui-original-0001');assert.equal(response.body.queryOriginalRequest,true);assert.equal(f.count('workspace/save'),1);assert.equal(f.records.size,1);
 }
});

test('actual runtime and browser client preserve an unknown committed request and query it without repeating the write',async t=>{
 const f=fixture({unknownWrite:true}),call=await server(t,f.runtime),requests=[],storage=new Map();let ids=0;
 const client=createPrivateWorkspaceClient({now:()=>NOW,timeoutMs:1000,storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},makeRequestId:()=>{ids++;return 'runtime-original-0001';},fetchImpl:async(path,init)=>{
  assert.equal(init.credentials,'same-origin');requests.push({path,method:init.method,body:init.body});const response=await call(path,{method:init.method,body:init.body,signal:init.signal});return new Response(JSON.stringify(response.body),{status:response.status,headers:response.headers});
 }});t.after(()=>client.dispose());
 client.setIdentity({ownerRef:A,expiresAt:NOW+60000});await client.load();await client.save(fields('Keep this original draft'));
 assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().requestId,'runtime-original-0001');assert.equal(client.snapshot().canSave,false);assert.equal(f.count('workspace/save'),1);
 await assert.rejects(()=>client.save(fields('Do not send this')),/PRIVATE_ORIGINAL_REQUEST_PENDING/);await client.queryOriginal();
 assert.equal(client.snapshot().status,'ready');assert.equal(client.snapshot().state.drafts[0].name,'Keep this original draft');assert.equal(ids,1);assert.equal(f.count('workspace/save'),1);assert.equal(f.count('workspace/request'),1);assert.equal(f.records.size,1);
 assert.equal(requests.filter(request=>request.method==='POST').length,1);assert.equal(requests.at(-1).path,'/api/workspace/request?requestId=runtime-original-0001');
});
