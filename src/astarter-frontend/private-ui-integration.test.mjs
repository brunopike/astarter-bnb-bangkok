import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createPrivateUIService} from './private-ui-service.mjs';
import {createPrivateWorkspaceClient} from './private-workspace-client.mjs';

const HOST='astarter.imstark.site',ORIGIN='https://'+HOST;
const NOW=Date.UTC(2026,10,16,14);
const TOKENS={'owner-a':'a'.repeat(64),'owner-b':'b'.repeat(64)};
const copy=value=>structuredClone(value);
const cookie=owner=>'__Host-astarter_session='+TOKENS[owner];
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function memoryStorage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}
function workspace(owner,revision=0){
 return {schema:'private-workspace-v1',scope:owner,revision,updatedAt:NOW,preferences:{workbenchFilter:'all',workbenchFocusAsset:'BTC',watchedAssets:[]},drafts:[{id:'draft-'+owner,strategyId:'S03',name:'Offline draft '+owner}],selectedDraftId:'draft-'+owner,executionAuthority:'NONE'};
}
const workspaceInput=(owner,name='Edited offline draft')=>({preferences:{workbenchFilter:'tracked',workbenchFocusAsset:'ETH',watchedAssets:[]},drafts:[{id:'draft-'+owner,strategyId:'S03',name}],selectedDraftId:'draft-'+owner});
function notifications(owner){
 return {schema:'private-notifications-v1',scope:owner,revision:0,updatedAt:NOW,inapp:true,events:['orders','risk','research'],services:{telegram:{available:false,error:'CHANNEL_DISABLED'},email:{available:false,error:'CHANNEL_DISABLED'}},channels:{telegram:{channel:'telegram',label:'',enabled:0,verified:0},email:{channel:'email',label:'',enabled:0,verified:0}},deliveries:[],inbox:[{id:'notice-'+owner,type:'research',title:'Offline research receipt '+owner,body:'Protocol fixture only',source:'server-research',requestId:'research-'+owner,createdAt:NOW,readAt:null,executionAuthority:'NONE'}],unreadCount:1,nextCursor:null,mode:'server-research-only'};
}
function receipt(domain,input,state){return {request:{schema:'private-ui-command-v1',domain,requestId:input.requestId,status:'applied',baseRevision:input.baseRevision,revision:state.revision,appliedAt:NOW},state:copy(state)};}
function protocolBackend(){
 const states=new Map(Object.keys(TOKENS).map(owner=>[owner,workspace(owner)]));
 const inboxes=new Map(Object.keys(TOKENS).map(owner=>[owner,notifications(owner)])),records=new Map(),calls=[];
 const hooks={};
 function ownerFor(req){
  const found=Object.keys(TOKENS).find(owner=>req.headers.cookie===cookie(owner));
  if(!found)throw Object.assign(Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED'});return found;
 }
 function original(domain,owner,id){return copy(records.get(domain+':'+owner+':'+id)||null);}
 async function invoke(name,req,input){
  const owner=ownerFor(req);calls.push({name,owner,input:copy(input??null)});
  if(hooks[name])return hooks[name]({req,input,owner,states,inboxes,records});
  if(name==='workspaceState')return copy(states.get(owner));
  if(name==='notificationsState')return copy(inboxes.get(owner));
  if(name.endsWith('Request'))return original(name.startsWith('workspace')?'workspace':'notifications',owner,input.requestId);
  const domain=name==='workspaceSave'?'workspace':'notifications',prior=original(domain,owner,input.requestId);if(prior)return prior;
  const collection=domain==='workspace'?states:inboxes,current=collection.get(owner);
  if(input.baseRevision!==current.revision)throw Object.assign(Error('PRIVATE_CONFLICT'),{code:'PRIVATE_CONFLICT'});
  const next=domain==='workspace'?{...current,...copy(input),revision:current.revision+1,updatedAt:NOW}:{...current,revision:current.revision+1,updatedAt:NOW};
  if(domain==='workspace'){delete next.requestId;delete next.baseRevision;}
  else if(input.action==='mark-read'){
   if(input.payload.ids.some(id=>!current.inbox.some(row=>row.id===id)))throw Object.assign(Error('PRIVATE_REQUEST_INVALID'),{code:'PRIVATE_REQUEST_INVALID'});
   next.inbox=current.inbox.map(row=>input.payload.ids.includes(row.id)?{...row,readAt:NOW}:row);next.unreadCount=next.inbox.filter(row=>row.readAt===null).length;
  }else Object.assign(next,{events:copy(input.payload.events),inapp:input.payload.inapp});
  collection.set(owner,next);const result=receipt(domain,input,next);records.set(domain+':'+owner+':'+input.requestId,result);return copy(result);
 }
 const backend=Object.fromEntries(['notificationsState','notificationsCommand','notificationsRequest','workspaceState','workspaceSave','workspaceRequest'].map(name=>[name,(req,input)=>invoke(name,req,input)]));
 return {backend,hooks,states,inboxes,records,calls};
}

// These tests use actual ephemeral localhost HTTP. The injected backend is an
// offline protocol double; it is not evidence of PG, SIWE or production access.
async function serve(t,backend){
 const handle=createPrivateUIService({backend,now:()=>NOW});
 const server=createServer((req,res)=>{void handle(req,res).then(handled=>{
  if(!handled){res.writeHead(404);res.end('{}');}
 }).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('{}');});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const endpoint='http://127.0.0.1:'+server.address().port;
 function call(path,{method='GET',body,headers={},signal}={}){
  const raw=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
   const request=httpRequest(endpoint+path,{method,headers:{host:HOST,origin:ORIGIN,...(raw===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(raw)}),...headers},signal},response=>{
    const parts=[];response.on('error',reject);response.on('data',part=>parts.push(part));response.on('end',()=>{
     try{const raw=Buffer.concat(parts).toString('utf8');resolve({status:response.statusCode,headers:response.headers,body:JSON.parse(raw)});}catch(error){reject(error);}
    });
   });request.on('error',reject);request.end(raw);
  });
 }
 return {call};
}
function browserTransport(http,getOwner,calls,{ignoreAbort=false}={}){
 return async(path,init)=>{
  assert.match(path,/^\/api\/(?:workspace|notifications)\//);assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
  const headers=Object.fromEntries(new Headers(init.headers));
  assert.deepEqual(Object.keys(headers).sort(),init.method==='POST'?['accept','content-type']:['accept']);
  const owner=getOwner();calls.push({path,method:init.method,owner,body:init.body?JSON.parse(init.body):null});
  const result=await http.call(path,{method:init.method,body:init.body,headers:{...headers,cookie:cookie(owner)},...(!ignoreAbort?{signal:init.signal}:{})});
  return new Response(JSON.stringify(result.body),{status:result.status,headers:result.headers});
 };
}
function client(t,http,getOwner,calls,options={}){
 const instance=createPrivateWorkspaceClient({fetchImpl:browserTransport(http,getOwner,calls,options),storage:options.storage||memoryStorage(),now:()=>NOW,timeoutMs:1000,makeRequestId:()=>options.requestId||'workspace-original-0001'});
 t.after(()=>instance.dispose());return instance;
}
function untouchedBackend(){
 const calls=[];
 const backend=Object.fromEntries(['notificationsState','notificationsCommand','notificationsRequest','workspaceState','workspaceSave','workspaceRequest'].map(name=>[name,async()=>{calls.push(name);throw Object.assign(Error('PRIVATE_UNAVAILABLE'),{code:'PRIVATE_UNAVAILABLE'});} ]));
 return {backend,calls};
}

test('notification controller recovers a lost real HTTP v1 receipt and reloads the v2 global reminder projection',async t=>{
 const f=protocolBackend(),calls=[],http=await serve(t,f.backend);
 f.inboxes.set('owner-a',{...notifications('owner-a'),events:['risk'],unreadCount:8,nextCursor:'older_page'});
 f.hooks.notificationsState=async({owner,input,inboxes})=>{const state=copy(inboxes.get(owner));return input.responseVersion===2?{...state,schema:'private-notifications-v2',reminderUnreadCount:state.inapp?(owner==='owner-a'?4:1):0}:state;};
 const original=f.backend.notificationsCommand;f.backend.notificationsCommand=async(req,input)=>{const result=await original(req,input);req.socket.destroy();return result;};
 const {createPrivateUIController}=await import('./private-ui-controller.mjs');const c=createPrivateUIController({fetchImpl:browserTransport(http,()=> 'owner-a',calls),storage:memoryStorage(),now:()=>NOW});t.after(()=>c.dispose());
 c.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000,authVersion:2,permissionProfile:'private-ui-v2'});await c.loadNotifications();assert.equal(c.snapshot().notifications.state.reminderUnreadCount,4,'global count includes eligible unread beyond this research-only page');
 await c.saveNotifications({inapp:false,events:['risk']});assert.equal(c.snapshot().notifications.status,'unknown');assert.equal(c.snapshot().notifications.state.reminderUnreadCount,4,'an uncertain save cannot optimistically silence reminders');
 const id=c.snapshot().notifications.requestId;await c.queryNotifications();assert.equal(c.snapshot().notifications.requestId,null);assert.equal(c.snapshot().notifications.status,'ready');assert.equal(c.snapshot().notifications.state.schema,'private-notifications-v2');assert.equal(c.snapshot().notifications.state.reminderUnreadCount,0);assert.equal(c.snapshot().notifications.state.unreadCount,8);assert.match(c.renderInbox(),/Offline research receipt owner-a/);
 assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.deepEqual(calls.map(call=>call.path),['/api/notifications/state?responseVersion=2','/api/notifications/command','/api/notifications/request?requestId='+id,'/api/notifications/state?responseVersion=2']);
 const record=f.records.get('notifications:owner-a:'+id);assert.equal(record.state.schema,'private-notifications-v1');assert.equal(Object.hasOwn(record.state,'reminderUnreadCount'),false);
 const b=await http.call('/api/notifications/state?responseVersion=2',{headers:{cookie:cookie('owner-b')}});assert.equal(b.body.reminderUnreadCount,1);assert.equal(b.body.inapp,true);
});

test('actual HTTP rejects CSRF, caller owner fields and ambiguous routes before the private backend',async t=>{
 const fixture=untouchedBackend(),http=await serve(t,fixture.backend);
 for(const [path,options,status] of [
  ['/api/workspace/state',{headers:{origin:'https://other.example'}},403],
  ['/api/workspace/state',{headers:{host:'other.example'}},403],
  ['/api/notifications/state',{headers:{'sec-fetch-site':'cross-site'}},403],
  ['/api/workspace/save',{method:'POST',body:{requestId:'request-0001'},headers:{origin:''}},403],
  ...['x-workspace-id','x-user-id','x-owner-ref','x-tenant-id','x-scope-id','x-subject-id'].map(header=>['/api/workspace/state',{headers:{[header]:'other-owner'}},400]),
  ['/api/workspace/save',{method:'POST',body:{requestId:'request-0001',ownerRef:'other-owner'}},400],
  ['/api/notifications/state?scopeId=other-owner',{},400],
  ['/api/workspace/request?requestId=request-0001&requestId=request-0002',{},400],
  ['/api/workspace/state?requestId=request-0001',{},400],
 ]){
  const response=await http.call(path,options);assert.equal(response.status,status,path+' '+JSON.stringify(options.headers||{}));
  assert.equal(response.body.executionAuthority,'NONE');assert.equal(response.headers['cache-control'],'no-store');
 }
 assert.deepEqual(fixture.calls,[]);
});

test('actual HTTP cannot create server inbox events or activate external send commands',async t=>{
 const fixture=untouchedBackend(),http=await serve(t,fixture.backend);
 for(const action of ['event','test','send','telegram-link','email-code','email-verify','disconnect']){
  const response=await http.call('/api/notifications/command',{method:'POST',body:{requestId:'request-'+action,action,payload:{mode:'simulation-only',title:'Browser rehearsal'}}});
  assert.equal(response.status,action==='event'?403:503);assert.equal(response.body.executionAuthority,'NONE');
 }
 assert.deepEqual(fixture.calls,[]);
});

test('actual HTTP fails closed when its backend returns an invalid or private state DTO',async t=>{
 const fixture=untouchedBackend();
 for(const method of ['workspaceState','notificationsState'])fixture.backend[method]=async()=>({ownerRef:'private-owner-must-not-leak',token:'private-token-must-not-leak',executionAuthority:'NONE'});
 const http=await serve(t,fixture.backend);
 for(const path of ['/api/workspace/state','/api/notifications/state']){
  const response=await http.call(path);assert.equal(response.status,503);
  assert.deepEqual(Object.keys(response.body).sort(),['error','executionAuthority']);assert.equal(response.body.executionAuthority,'NONE');
  assert.doesNotMatch(JSON.stringify(response.body),/private-owner|private-token/);
 }
});

test('real HTTP and browser client keep two fixture owners and their original request receipts isolated',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[];
 const a=client(t,http,()=> 'owner-a',calls),b=client(t,http,()=> 'owner-b',calls);
 assert.equal(calls.length,0);a.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});b.setIdentity({ownerRef:'owner-b',expiresAt:NOW+60000});assert.equal(calls.length,0);
 await Promise.all([a.load(),b.load()]);assert.equal(a.snapshot().state.scope,'owner-a');assert.equal(b.snapshot().state.scope,'owner-b');
 await a.save(workspaceInput('owner-a'));assert.equal(a.snapshot().status,'ready');assert.equal(a.snapshot().state.revision,1);
 assert.equal(b.snapshot().state.revision,0);assert.equal(fixture.states.get('owner-b').drafts[0].name,'Offline draft owner-b');
 const foreign=await http.call('/api/workspace/request?requestId=workspace-original-0001',{headers:{cookie:cookie('owner-b')}});assert.equal(foreign.status,200);assert.equal(foreign.body,null);
 const own=await http.call('/api/workspace/request?requestId=workspace-original-0001',{headers:{cookie:cookie('owner-a')}});assert.equal(own.status,200);assert.equal(own.body.state.scope,'owner-a');
 const aInbox=await http.call('/api/notifications/state',{headers:{cookie:cookie('owner-a')}}),bInbox=await http.call('/api/notifications/state',{headers:{cookie:cookie('owner-b')}});
 assert.equal(aInbox.body.inbox[0].id,'notice-owner-a');assert.equal(bInbox.body.inbox[0].id,'notice-owner-b');
 const foreignRead=await http.call('/api/notifications/command',{method:'POST',headers:{cookie:cookie('owner-b')},body:{requestId:'notice-foreign-0001',baseRevision:0,action:'mark-read',payload:{ids:['notice-owner-a']}}});
 assert.equal(foreignRead.status,400);assert.equal(fixture.inboxes.get('owner-a').unreadCount,1);assert.equal(fixture.inboxes.get('owner-b').unreadCount,1);
 assert.deepEqual(calls.find(call=>call.method==='POST').body,{requestId:'workspace-original-0001',baseRevision:0,...workspaceInput('owner-a')});
});

test('a committed save with a lost real HTTP response recovers by GET of the same ID without another write',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[],storage=memoryStorage();
 const original=fixture.backend.workspaceSave;let lost=false;
 fixture.backend.workspaceSave=async(req,input)=>{const result=await original(req,input);if(!lost){lost=true;req.socket.destroy();}return result;};
 const first=client(t,http,()=> 'owner-a',calls,{storage});first.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});await first.load();
 await first.save(workspaceInput('owner-a'));assert.equal(first.snapshot().status,'unknown');assert.equal(first.snapshot().requestId,'workspace-original-0001');assert.equal(first.snapshot().canSave,false);
 assert.equal(fixture.states.get('owner-a').revision,1);first.dispose();
 const restored=client(t,http,()=> 'owner-a',calls,{storage});restored.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});
 assert.equal(restored.snapshot().status,'unknown');assert.equal(restored.snapshot().state,null);assert.deepEqual(restored.snapshot().localInput,workspaceInput('owner-a'));
 await restored.queryOriginal();assert.equal(restored.snapshot().status,'ready');assert.equal(restored.snapshot().requestId,null);assert.equal(restored.snapshot().state.revision,1);
 assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(fixture.records.size,1);
 assert.equal(calls.at(-1).path,'/api/workspace/request?requestId=workspace-original-0001');
});

test('GET null after a disconnected save preserves the original intent, inputs and write prohibition',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[];
 fixture.hooks.workspaceSave=async({req})=>{req.socket.destroy();throw Error('offline transport disconnected before commit is known');};
 const instance=client(t,http,()=> 'owner-a',calls);instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});await instance.load();const input=workspaceInput('owner-a','Do not overwrite my draft');
 await instance.save(input);for(let i=0;i<2;i++)await instance.queryOriginal();
 const snapshot=instance.snapshot();assert.equal(snapshot.status,'unknown');assert.equal(snapshot.requestId,'workspace-original-0001');assert.equal(snapshot.canSave,false);assert.equal(snapshot.canQuery,true);assert.deepEqual(snapshot.localInput,input);
 await assert.rejects(()=>instance.save(workspaceInput('owner-a','new attempt')),/PRIVATE_ORIGINAL_REQUEST_PENDING/);
 assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.deepEqual(calls.filter(call=>call.path.includes('/request?')).map(call=>call.path),Array(2).fill('/api/workspace/request?requestId=workspace-original-0001'));
 assert.equal(fixture.states.get('owner-a').revision,0);
});

test('a late HTTP response from the previous owner cannot populate the current owner or restore after leave',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[],entered=deferred(),release=deferred();let owner='owner-a';
 fixture.hooks.workspaceState=async({owner:requested,states})=>{if(requested==='owner-a'){entered.resolve();await release.promise;}return copy(states.get(requested));};
 t.after(()=>release.resolve());const instance=client(t,http,()=>owner,calls,{ignoreAbort:true});
 instance.setIdentity({ownerRef:owner,expiresAt:NOW+60000});const old=instance.load();await entered.promise;
 owner='owner-b';instance.setIdentity({ownerRef:owner,expiresAt:NOW+60000});await instance.load();release.resolve();await old;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(instance.snapshot().ownerRef,'owner-b');assert.equal(instance.snapshot().state.scope,'owner-b');assert.equal(instance.snapshot().state.drafts[0].id,'draft-owner-b');
 instance.leave();assert.equal(instance.snapshot().state,null);assert.equal(instance.snapshot().canLoad,false);assert.equal(instance.snapshot().canSave,false);
 const count=calls.length;await instance.load();assert.equal(calls.length,count);
});

test('browser client rejects a valid-shaped HTTP state whose scope belongs to a different owner',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[];
 fixture.hooks.workspaceState=async()=>workspace('owner-b');
 const instance=client(t,http,()=> 'owner-a',calls);instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});await instance.load();
 assert.equal(instance.snapshot().status,'error');assert.equal(instance.snapshot().state,null);assert.equal(instance.snapshot().canSave,false);assert.equal(instance.snapshot().error,'PRIVATE_UI_PROTOCOL');assert.equal(fixture.records.size,0);
});

// Q1 acceptance baseline: anonymous and expired states. Same offline protocol
// double as above; a pass here is fixture evidence only, not live session proof.
function clockClient(t,http,calls,{clock,storage=memoryStorage(),requestId='workspace-original-0001'}){
 const instance=createPrivateWorkspaceClient({fetchImpl:browserTransport(http,()=> 'owner-a',calls),storage,now:()=>clock.now,timeoutMs:1000,makeRequestId:()=>requestId});
 t.after(()=>instance.dispose());return instance;
}

test('anonymous HTTP without a session cookie gets 401 before any owner state, and an anonymous client sends nothing',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend);
 for(const [path,options] of [
  ['/api/workspace/state',{}],
  ['/api/notifications/state?responseVersion=2',{}],
  ['/api/workspace/request?requestId=workspace-original-0001',{}],
  ['/api/workspace/save',{method:'POST',body:{requestId:'workspace-anonymous-0001',baseRevision:0,...workspaceInput('owner-a')}}],
 ]){
  const response=await http.call(path,options);assert.equal(response.status,401,path);
  assert.deepEqual(response.body,{error:'AUTH_REQUIRED',executionAuthority:'NONE'});assert.equal(response.headers['cache-control'],'no-store');
 }
 assert.deepEqual(fixture.calls,[]);assert.equal(fixture.records.size,0);assert.equal(fixture.states.get('owner-a').revision,0);
 const calls=[],instance=clockClient(t,http,calls,{clock:{now:NOW},requestId:'workspace-anonymous-0001'});
 let snapshot=instance.snapshot();assert.equal(snapshot.status,'auth-required');assert.equal(snapshot.ownerRef,null);assert.equal(snapshot.state,null);assert.equal(snapshot.canLoad,false);assert.equal(snapshot.canSave,false);assert.equal(snapshot.executionAuthority,'NONE');
 snapshot=instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW});assert.equal(snapshot.status,'auth-required','an identity already at expiry is treated as anonymous');assert.equal(snapshot.ownerRef,null);
 await instance.load();snapshot=await instance.save(workspaceInput('owner-a','Anonymous write'));
 assert.equal(snapshot.status,'auth-required');assert.equal(snapshot.state,null);assert.deepEqual(calls,[]);assert.equal(fixture.states.get('owner-a').revision,0);
});

test('an identity that expires on the client clock hides owner state and sends no further request',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[],clock={now:NOW};
 const instance=clockClient(t,http,calls,{clock,requestId:'workspace-expiry-0001'});
 instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});await instance.load();
 assert.equal(instance.snapshot().status,'ready');assert.equal(instance.snapshot().state.scope,'owner-a');assert.equal(instance.snapshot().canSave,true);
 clock.now=NOW+60000;
 const expired=instance.snapshot();assert.equal(expired.status,'auth-required');assert.equal(expired.error,'PRIVATE_AUTH_REQUIRED');assert.equal(expired.state,null);assert.equal(expired.localInput,null);
 assert.equal(expired.canLoad,false);assert.equal(expired.canSave,false);assert.equal(expired.canQuery,false);assert.equal(expired.executionAuthority,'NONE');
 const count=calls.length;await instance.load();const after=await instance.save(workspaceInput('owner-a','Written after expiry'));
 assert.equal(after.status,'auth-required');assert.equal(calls.length,count);assert.equal(calls.filter(call=>call.method==='POST').length,0);
 assert.equal(fixture.states.get('owner-a').revision,0);assert.equal(fixture.records.size,0);
});

test('a session the server reports as expired blocks the workspace until a fresh sign-in loads it again',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[];let sessionValid=true;
 fixture.hooks.workspaceState=async({owner,states})=>{if(!sessionValid)throw Object.assign(Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED'});return copy(states.get(owner));};
 const instance=client(t,http,()=> 'owner-a',calls);instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});await instance.load();assert.equal(instance.snapshot().status,'ready');
 sessionValid=false;await instance.load();
 const blocked=instance.snapshot();assert.equal(blocked.status,'auth-required');assert.equal(blocked.error,'PRIVATE_AUTH_REQUIRED');assert.equal(blocked.state,null);assert.equal(blocked.canLoad,false);assert.equal(blocked.canSave,false);
 const count=calls.length;await instance.load();assert.equal(calls.length,count,'a blocked client does not retry on its own');
 sessionValid=true;instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW+120000});await instance.load();
 assert.equal(instance.snapshot().status,'ready');assert.equal(instance.snapshot().state.scope,'owner-a');assert.equal(calls.filter(call=>call.method==='POST').length,0);
});

test('an unknown save outcome survives session expiry and is confirmed by GET of the same ID after a fresh sign-in',async t=>{
 const fixture=protocolBackend(),http=await serve(t,fixture.backend),calls=[],clock={now:NOW};
 const original=fixture.backend.workspaceSave;let lost=false;
 fixture.backend.workspaceSave=async(req,input)=>{const result=await original(req,input);if(!lost){lost=true;req.socket.destroy();}return result;};
 const instance=clockClient(t,http,calls,{clock});
 instance.setIdentity({ownerRef:'owner-a',expiresAt:NOW+60000});await instance.load();
 await instance.save(workspaceInput('owner-a'));assert.equal(instance.snapshot().status,'unknown');assert.equal(fixture.states.get('owner-a').revision,1);
 clock.now=NOW+60000;
 const expired=instance.snapshot();assert.equal(expired.status,'auth-required');assert.equal(expired.localInput,null);assert.equal(expired.canQuery,false);
 const count=calls.length;await instance.queryOriginal();assert.equal(calls.length,count);
 instance.setIdentity({ownerRef:'owner-a',expiresAt:clock.now+60000});
 const back=instance.snapshot();assert.equal(back.status,'unknown');assert.equal(back.requestId,'workspace-original-0001');assert.deepEqual(back.localInput,workspaceInput('owner-a'));
 assert.equal(back.canSave,false);assert.equal(back.canQuery,true);
 await instance.queryOriginal();assert.equal(instance.snapshot().status,'ready');assert.equal(instance.snapshot().requestId,null);assert.equal(instance.snapshot().state.revision,1);
 assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(fixture.records.size,1);assert.equal(calls.at(-1).path,'/api/workspace/request?requestId=workspace-original-0001');
});

// Card U1, step 1: sign-in, disconnect, a second wallet and expiry in one tab, in one sequence.
// The wallet service and the account read are offline doubles behind a fake fetch, the private
// backend is the protocol double above, and the signature is a fixed fixture string. A pass is
// fixture evidence only: no real wallet, signature, network or production session is involved.
const WALLETS={'owner-a':'0x'+'a'.repeat(40),'owner-b':'0x'+'b'.repeat(40)};
const walletRef=owner=>'wallet:56:'+WALLETS[owner];
function walletDouble(clock,jar,log){
 return async(url,init)=>{
  assert.match(String(url),/^\/api\/wallet\/(?:nonce|message|verify|session|logout)$/);assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');
  const route=String(url).slice('/api/wallet/'.length),body=init.body===undefined?undefined:JSON.parse(init.body);log.push({route,owner:jar.owner});
  const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  const live=()=>jar.owner&&jar.expires>clock.now?{address:WALLETS[jar.owner],chain:56,expires:jar.expires,authVersion:2,permissionProfile:'private-ui-v2'}:null;
  if(route==='nonce')return reply({nonce:'offline-nonce-'+log.length});
  if(route==='message')return reply({message:'Offline fixture sign-in '+body.address.toLowerCase()+' '+body.nonce});
  if(route==='verify'){
   assert.equal(body.signature,'offline-fixture-signature');const address=body.message.split(' ')[3];
   jar.owner=Object.keys(WALLETS).find(owner=>WALLETS[owner]===address)||null;jar.expires=clock.now+60000;return reply({session:live()});
  }
  if(route==='logout'){jar.owner=null;jar.expires=0;return reply({session:null});}
  return reply({session:live()});
 };
}

test('one tab signs in as A, disconnects, signs in as B and lets B expire, and no step shows or sends the other person\'s data',async t=>{
 const {createWalletSession}=await import('./wallet-session.mjs'),{walletAuthenticated}=await import('./wallet-entry.mjs');
 const {createSecurityFlow,securityView}=await import('./account-security.mjs'),{createPrivateUIController}=await import('./private-ui-controller.mjs');
 const clock={now:NOW},jar={owner:null,expires:0},walletCalls=[],accountCalls=[],calls=[],draft='?page=strategies&draft=existing-42';
 t.mock.method(Date,'now',()=>clock.now);t.mock.method(globalThis,'fetch',walletDouble(clock,jar,walletCalls));
 const f=protocolBackend(),http=await serve(t,f.backend);
 for(const owner of Object.keys(WALLETS))f.states.set(owner,{...workspace(owner),scope:walletRef(owner)});
 f.inboxes.set('owner-a',{...notifications('owner-a'),scope:walletRef('owner-a'),unreadCount:7});f.inboxes.set('owner-b',{...notifications('owner-b'),scope:walletRef('owner-b'),unreadCount:2});
 f.hooks.notificationsState=async({owner,input,inboxes})=>{assert.equal(input.responseVersion,2);const state=copy(inboxes.get(owner));return {...state,schema:'private-notifications-v2',reminderUnreadCount:state.unreadCount};};
 // The header (header-wallet.jsx L114, React, not rendered here) turns the wallet session into this identity event for app.js L49;
 // the next line fails if that header code changes, so this copy cannot drift from it.
 assert.ok(readFileSync(new URL('./header-wallet.jsx',import.meta.url),'utf8').includes("detail:{ownerRef:authenticated?'wallet:56:'+address.toLowerCase():null,expiresAt:authenticated?session.expires:null,authVersion:authenticated?session.authVersion||1:null,permissionProfile:authenticated?session.permissionProfile||null:null}"));
 const identityEvent=(session,address,status)=>{const authenticated=walletAuthenticated(session,address,56,status);return {ownerRef:authenticated?'wallet:56:'+address.toLowerCase():null,expiresAt:authenticated?session.expires:null,authVersion:authenticated?session.authVersion||1:null,permissionProfile:authenticated?session.permissionProfile||null:null};};
 let wallet={session:undefined};const auth=createWalletSession({update:value=>{wallet=value;},storage:memoryStorage(),referralStorage:memoryStorage(),referralSearch:''});
 const signIn=async owner=>{const nonce=await auth.adapter.getNonce(),message=await auth.adapter.createMessage({nonce,address:WALLETS[owner],chainId:56});assert.equal(await auth.adapter.verify({message,signature:'offline-fixture-signature'}),true);assert.equal(wallet.session.address,WALLETS[owner]);};
 const accountRequest=async(action,payload)=>{
  accountCalls.push({action,owner:jar.owner});const owner=jar.owner&&jar.expires>clock.now?jar.owner:null;
  if(action==='account/read')return {account:{signedIn:Boolean(owner),wallet:owner?WALLETS[owner]:null,email:null,totp:false,social:[],sessions:[]}};
  if(action==='email/start'&&owner)return {challenge:{id:'offline-email-'+owner,method:'email',purpose:payload.purpose,expiresAt:clock.now+300000,resendAt:clock.now+60000}};
  throw Error('unavailable');
 };
 const c=createPrivateUIController({fetchImpl:browserTransport(http,()=>jar.owner,calls),storage:memoryStorage(),now:()=>clock.now,timeoutMs:1000});t.after(()=>c.dispose());
 const flow=createSecurityFlow({request:accountRequest,now:()=>clock.now}),page=()=>securityView(flow.state,{locale:'en',now:clock.now});
 const views=()=>[c.renderWorkspace(),c.renderInbox(),c.renderNotificationSettings()];

 // 1. A signs in and sees A's workspace, inbox count, typed email and return address.
 await signIn('owner-a');
 const identityA=identityEvent(wallet.session,WALLETS['owner-a'],'connected');assert.deepEqual(identityA,{ownerRef:walletRef('owner-a'),expiresAt:NOW+60000,authVersion:2,permissionProfile:'private-ui-v2'});
 c.setIdentity(identityA);await c.loadWorkspace();await c.loadNotifications();
 let view=c.snapshot();assert.equal(view.identityStatus,'ready');assert.equal(view.workspace.state.scope,walletRef('owner-a'));assert.equal(view.notifications.state.unreadCount,7);
 assert.match(c.renderWorkspace(),/Offline draft owner-a/);assert.match(c.renderInbox(),/Offline research receipt owner-a/);assert.match(c.renderInbox(),/ · 7 /);
 flow.navigate('verify',{returnTo:draft});flow.navigate('email');assert.equal(await flow.refresh(),true);assert.equal(flow.state.snapshot.wallet,WALLETS['owner-a']);
 assert.equal(await flow.startEmail('first-owner@example.invalid'),true);flow.setCode('123');
 assert.ok(flow.state.challenge);assert.equal(flow.state.returnTo,draft);assert.match(page(),/first-owner@example\.invalid/);

 // 2. A disconnects: the header drops the identity and signs out; the page shows and sends nothing of A's.
 const sentBefore=calls.length;
 c.setIdentity(identityEvent(wallet.session,undefined,'disconnected'));assert.equal(await auth.adapter.signOut(),true);
 assert.equal(wallet.session,null);assert.equal(jar.owner,null);assert.deepEqual(walletCalls.at(-1),{route:'logout',owner:'owner-a'},'only the sign-out itself carries A\'s session, to revoke it');
 const afterLogout={wallet:walletCalls.length,private:calls.length,backend:f.calls.length,account:accountCalls.length};
 c.setIdentity(identityEvent(wallet.session,undefined,'disconnected'));
 view=c.snapshot();assert.equal(view.identityStatus,'auth-required');assert.equal(view.ownerRef,null);assert.equal(view.workspace.state,null);assert.equal(view.notifications.state,null);
 for(const html of views()){assert.match(html,/data-private-action="authenticate"/);assert.doesNotMatch(html,/owner-a| · 7 /);}
 await c.loadWorkspace();await c.loadNotifications();assert.equal(calls.length,sentBefore,'a signed-out page sends no private request');
 assert.equal(await flow.refresh(),true);assert.equal(flow.state.snapshot.signedIn,false);assert.equal(flow.state.email,'');assert.equal(flow.state.code,'');assert.equal(flow.state.challenge,null);
 assert.doesNotMatch(page(),/first-owner@example\.invalid|0xa{40}/i);

 // 3. B signs in on the same tab and sees only B's data.
 await signIn('owner-b');
 const identityB=identityEvent(wallet.session,WALLETS['owner-b'],'connected');assert.equal(identityB.ownerRef,walletRef('owner-b'));
 c.setIdentity(identityB);view=c.snapshot();assert.equal(view.workspace.state,null);assert.equal(view.notifications.state,null);for(const html of views())assert.doesNotMatch(html,/owner-a| · 7 /);await c.loadWorkspace();await c.loadNotifications();
 view=c.snapshot();assert.equal(view.identityStatus,'ready');assert.equal(view.workspace.state.scope,walletRef('owner-b'));assert.deepEqual(view.workspace.state.drafts.map(row=>row.id),['draft-owner-b']);
 assert.equal(view.notifications.state.unreadCount,2);assert.deepEqual(view.notifications.state.inbox.map(row=>row.id),['notice-owner-b']);
 assert.match(c.renderInbox(),/Offline research receipt owner-b/);assert.match(c.renderInbox(),/ · 2 /);assert.match(c.renderWorkspace(),/Offline draft owner-b/);
 for(const html of views())assert.doesNotMatch(html,/owner-a| · 7 /);
 assert.equal(await flow.refresh(),true);assert.equal(flow.state.snapshot.wallet,WALLETS['owner-b']);
 assert.equal(flow.state.email,'');assert.equal(flow.state.returnTo,'?page=security','B does not inherit A\'s return address');
 assert.equal(await flow.startEmail('second-owner@example.invalid'),true);assert.match(page(),/second-owner@example\.invalid/);assert.doesNotMatch(page(),/first-owner@example\.invalid/);
 assert.ok(walletCalls.slice(afterLogout.wallet).every(call=>call.owner!=='owner-a'),'no wallet request after the sign-out carries A\'s session');
 assert.deepEqual([...new Set(calls.slice(afterLogout.private).map(call=>call.owner))],['owner-b']);assert.deepEqual([...new Set(f.calls.slice(afterLogout.backend).map(call=>call.owner))],['owner-b']);
 assert.ok(accountCalls.slice(afterLogout.account).every(call=>call.owner!=='owner-a'),'no account read after the sign-out carries A\'s session');

 // 4. B's session reaches its expiry on the client clock: B's data goes and the page asks for a new sign-in.
 const beforeExpiry={private:calls.length,backend:f.calls.length};clock.now=jar.expires;
 assert.equal(walletAuthenticated(wallet.session,WALLETS['owner-b'],56,'connected'),false,'the header stops treating B as signed in at the same moment');
 view=c.snapshot();assert.equal(view.identityStatus,'auth-required');assert.equal(view.workspace.status,'auth-required');assert.equal(view.workspace.state,null);assert.equal(view.notifications.state,null);
 for(const html of views()){assert.match(html,/data-private-action="authenticate"/);assert.doesNotMatch(html,/owner-a|owner-b| · 2 | · 7 /);}
 await c.loadWorkspace();await c.loadNotifications();assert.equal(calls.length,beforeExpiry.private,'an expired page sends no private request');
 // The header's expiry timer (header-wallet.jsx L106) clears the wallet session; the server also reports none.
 auth.expire();assert.equal(wallet.session,null);c.setIdentity(identityEvent(wallet.session,WALLETS['owner-b'],'connected'));
 assert.equal(c.snapshot().ownerRef,null);for(const html of views())assert.match(html,/data-private-action="authenticate"/);
 assert.equal(await auth.refresh(),true);assert.equal(wallet.session,null);assert.deepEqual(walletCalls.at(-1),{route:'session',owner:'owner-b'});
 assert.equal(await flow.refresh(),true);assert.equal(flow.state.snapshot.signedIn,false);assert.equal(flow.state.email,'');assert.equal(flow.state.challenge,null);
 assert.doesNotMatch(page(),/second-owner@example\.invalid|0xb{40}/i);
 flow.navigate('security');assert.match(page(),/data-security-page="login">Sign in \/ Join</);assert.doesNotMatch(page(),/second-owner@example\.invalid|0xb{40}/i);
 const asked=accountCalls.length;flow.navigate('verify');assert.equal(await flow.beginChallenge(),false);assert.equal(flow.state.error,'sign-in-required');assert.equal(accountCalls.length,asked);
 assert.match(page(),/data-security-page="login">Sign in</);
 assert.equal(calls.length,beforeExpiry.private);assert.equal(f.calls.length,beforeExpiry.backend);assert.equal(jar.owner,'owner-b','the expired cookie stays in the jar, and the page still sends nothing with it');
});
