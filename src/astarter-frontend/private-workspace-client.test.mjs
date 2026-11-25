import test from 'node:test';
import assert from 'node:assert/strict';

test('private workspace client exports its browser factory without starting a request',async()=>{
 const module=await import('./private-workspace-client.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {};
  throw error;
 });
 assert.equal(typeof module.createPrivateWorkspaceClient,'function');
});

// Offline HTTP protocol doubles; no cookie value, wallet signature or private API is used.
const NOW=Date.UTC(2026,10,16,14),OWNER='wallet:offline:56',OTHER='wallet:other:56',ID='workspace-request-0001';
const input=()=>({preferences:{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:[]},drafts:[{id:'draft-1',strategyId:'S03',name:'Local trend'}],selectedDraftId:'draft-1'});
const state=(revision=0,value=input(),scope=OWNER)=>({schema:'private-workspace-v1',scope,revision,updatedAt:revision?NOW:0,...structuredClone({preferences:value.preferences,drafts:value.drafts,selectedDraftId:value.selectedDraftId}),executionAuthority:'NONE'});
const applied=(body,patch={})=>({request:{schema:'private-ui-command-v1',domain:'workspace',requestId:body.requestId,status:'applied',baseRevision:body.baseRevision,revision:body.baseRevision+1,appliedAt:NOW},state:state(body.baseRevision+1,body),...patch});
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

const noticeRow=id=>({id,type:'research',title:'Offline report receipt',body:'Protocol fixture, no research performed.',source:'server-research',requestId:'research-'+id,createdAt:NOW,readAt:null,executionAuthority:'NONE'});
const notificationState=(rows=[],revision=0)=>({schema:'private-notifications-v1',scope:OWNER,revision,updatedAt:0,inapp:true,events:['risk','research'],services:Object.fromEntries(['telegram','email'].map(channel=>[channel,{available:false,error:'CHANNEL_DISABLED'}])),channels:Object.fromEntries(['telegram','email'].map(channel=>[channel,{channel,label:'',enabled:0,verified:0}])),deliveries:[],inbox:rows,unreadCount:rows.filter(row=>row.readAt===null).length,nextCursor:null,mode:'server-research-only'});
const notificationV2=value=>({...structuredClone(value),schema:'private-notifications-v2',reminderUnreadCount:value.inapp?value.inbox.filter(row=>row.readAt===null&&value.events.includes(row.type)).length:0});
test('notification authoritative v2 reads accept new inbox only with its producer revision',async()=>{
 const {createPrivateNotificationsClient}=await import('./private-workspace-client.mjs');let reads=0;
 const c=createPrivateNotificationsClient({storage:memory(),now:()=>NOW,fetchImpl:async url=>{assert.equal(url,'/api/notifications/state?responseVersion=2');reads++;return reply(notificationV2(notificationState(reads===1?[]:[noticeRow('new-1')],reads-1)));}});
 c.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await c.load();assert.equal(c.snapshot().status,'ready');await c.load();
 assert.equal(c.snapshot().status,'ready');assert.equal(c.snapshot().state.revision,1);assert.equal(c.snapshot().state.inbox[0].id,'new-1');assert.equal(c.snapshot().state.reminderUnreadCount,1);c.dispose();
});
test('an immutable v1 receipt clears the original intent without rolling back a fresher producer revision',async()=>{
 const {createPrivateNotificationsClient}=await import('./private-workspace-client.mjs');const calls=[];let saved,read=0;
 const c=createPrivateNotificationsClient({storage:memory(),now:()=>NOW,makeRequestId:()=>ID,fetchImpl:async(url,init)=>{
  calls.push({url,init});if(init.method==='POST'){const input=JSON.parse(init.body);saved={request:{schema:'private-ui-command-v1',domain:'notifications',requestId:input.requestId,status:'applied',baseRevision:0,revision:0,appliedAt:NOW},state:notificationState()};throw Error('Offline committed response lost');}
  if(url.includes('/request?'))return reply(saved);
  read++;return reply(notificationV2(notificationState(read===1?[]:[noticeRow('later-1')],read-1)));
 }});
 c.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await c.load();await c.save({action:'save',payload:{events:['risk','research'],enabled:{telegram:false,email:false},inapp:true}});assert.equal(c.snapshot().status,'unknown');
 await c.load();assert.equal(c.snapshot().state.inbox[0].id,'later-1');await c.queryOriginal();
 assert.equal(c.snapshot().status,'ready');assert.equal(c.snapshot().requestId,null);assert.equal(c.snapshot().state.schema,'private-notifications-v2');assert.equal(c.snapshot().state.inbox[0].id,'later-1');assert.equal(calls.filter(call=>call.init.method==='POST').length,1);c.dispose();
});
test('notification reads still reject same-revision inbox, preference and global-count mutations',async()=>{
 const {createPrivateNotificationsClient}=await import('./private-workspace-client.mjs');
 const initial={...notificationV2(notificationState([noticeRow('original-1')])),events:['research'],unreadCount:8,reminderUnreadCount:8,nextCursor:'older_page'};
 for(const alter of [value=>{value.inbox=[noticeRow('forged-1')];},value=>{value.unreadCount=9;},value=>{value.nextCursor='different_page';},value=>{value.inapp=false;value.reminderUnreadCount=0;},value=>{value.reminderUnreadCount=7;}]){
  let reads=0;const changed=structuredClone(initial);alter(changed);
  const c=createPrivateNotificationsClient({storage:memory(),now:()=>NOW,fetchImpl:async()=>reply(++reads===1?initial:changed)});c.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await c.load();await c.load();
  assert.equal(c.snapshot().status,'error');assert.equal(c.snapshot().error,'PRIVATE_UI_PROTOCOL');assert.deepEqual(c.snapshot().state,initial);c.dispose();
 }
});
test('a v1 command with identical canonical state cannot downgrade a verified same-revision v2 count',async()=>{
 const {createPrivateNotificationsClient}=await import('./private-workspace-client.mjs');const v1=notificationState([noticeRow('stable-1')]);
 const c=createPrivateNotificationsClient({storage:memory(),now:()=>NOW,makeRequestId:()=>ID,fetchImpl:async(_url,init)=>{
  if(init.method==='GET')return reply(notificationV2(v1));const input=JSON.parse(init.body);return reply({request:{schema:'private-ui-command-v1',domain:'notifications',requestId:input.requestId,status:'applied',baseRevision:0,revision:0,appliedAt:NOW},state:v1});
 }});c.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});await c.load();await c.save({action:'save',payload:{events:['risk','research'],enabled:{telegram:false,email:false},inapp:true}});
 assert.equal(c.snapshot().status,'ready');assert.equal(c.snapshot().requestId,null);assert.deepEqual(c.snapshot().state,notificationV2(v1));c.dispose();
});
function memory(){const entries=new Map();return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value)),removeItem:key=>entries.delete(key)};}
async function fixture(options={}){
 const {createPrivateWorkspaceClient}=await import('./private-workspace-client.mjs');
 const storage=options.storage??memory(),calls=[];let id=0;
 const client=createPrivateWorkspaceClient({storage,now:()=>NOW,makeRequestId:()=>ID+'-'+(++id),fetchImpl:async(url,init)=>{calls.push({url,init});return reply(init.method==='POST'?applied(JSON.parse(init.body)):state());},...options});
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});
 return {client,storage,calls};
}

test('only explicit save sends the exact metadata command after a verified read',async()=>{
 const {client,calls}=await fixture();
 assert.equal(client.snapshot().status,'idle');assert.equal(client.snapshot().state,null);assert.equal(client.snapshot().canSave,false);assert.equal(calls.length,0);
 await assert.rejects(()=>client.save(input()),/PRIVATE_WORKSPACE_NOT_READY/);assert.equal(calls.length,0);
 await client.load();assert.equal(calls[0].url,'/api/workspace/state');assert.equal(calls[0].init.method,'GET');assert.equal(client.snapshot().canSave,true);
 await client.save(input());const post=calls[1],body=JSON.parse(post.init.body);
 assert.equal(post.url,'/api/workspace/save');assert.equal(post.init.credentials,'same-origin');assert.equal(post.init.redirect,'error');assert.equal(post.init.cache,'no-store');
 assert.deepEqual(Object.keys(post.init.headers).sort(),['Accept','Content-Type']);
 assert.deepEqual(body,{requestId:ID+'-1',baseRevision:0,...input()});
 assert.equal(client.snapshot().status,'ready');assert.equal(client.snapshot().state.revision,1);assert.equal(client.snapshot().executionAuthority,'NONE');assert.equal(client.snapshot().requestId,null);
 const detached=client.snapshot();detached.state.preferences.workbenchFilter='all';assert.equal(client.snapshot().state.preferences.workbenchFilter,'tracked');client.dispose();
});

test('a lost POST response persists one owner-scoped intent and recovery only queries that ID',async()=>{
 const calls=[],storage=memory();let command,confirmed=false;
 const fetchImpl=async(url,init)=>{calls.push({url,init});if(init.method==='POST'){command=JSON.parse(init.body);throw Error('upstream secret must never be exposed');}return reply(url==='/api/workspace/state'?state():confirmed?applied(command):null);};
 const {client}=await fixture({storage,fetchImpl});await client.load();await client.save(input());
 assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().requestId,ID+'-1');assert.equal(client.snapshot().canQuery,true);assert.equal(client.snapshot().canSave,false);
 await assert.rejects(()=>client.save(input()),/PRIVATE_ORIGINAL_REQUEST_PENDING/);
 await client.queryOriginal();await client.queryOriginal();assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().requestId,ID+'-1');
 assert.equal(calls.filter(call=>call.init.method==='POST').length,1);assert.ok(calls.slice(2).every(call=>call.url==='/api/workspace/request?requestId='+ID+'-1'));
 assert.doesNotMatch(JSON.stringify(client.snapshot()),/upstream secret/);client.dispose();
 const restored=(await fixture({storage,fetchImpl,makeRequestId:()=>{throw Error('MUST_NOT_GENERATE_NEW_ID');}})).client;
 assert.equal(restored.snapshot().status,'unknown');assert.equal(restored.snapshot().state,null);assert.equal(restored.snapshot().requestId,ID+'-1');
 confirmed=true;await restored.queryOriginal();assert.equal(restored.snapshot().status,'ready');assert.equal(restored.snapshot().state.revision,1);assert.equal(restored.snapshot().requestId,null);restored.dispose();
});

test('only an explicit PRIVATE_CONFLICT ends a rejected save; local input survives reload and a cloud read',async()=>{
 const storage=memory();let revision=0,conflict=true;
 const {client}=await fixture({storage,fetchImpl:async(_url,init)=>init.method==='POST'?conflict?reply({error:'PRIVATE_CONFLICT'},409):reply(applied(JSON.parse(init.body))):reply(state(revision,{...input(),drafts:[],selectedDraftId:null}))});
 await client.load();await client.save(input());assert.equal(client.snapshot().status,'conflict');assert.equal(client.snapshot().requestId,null);assert.equal(client.snapshot().canSave,false);assert.deepEqual(client.snapshot().localInput,input());
 await assert.rejects(()=>client.save(input()),/PRIVATE_WORKSPACE_NOT_READY/);client.dispose();
 const restored=(await fixture({storage,makeRequestId:()=>ID+'-2',fetchImpl:async(_url,init)=>reply(init.method==='POST'?applied(JSON.parse(init.body)):state(3,{...input(),drafts:[],selectedDraftId:null}))})).client;
 assert.equal(restored.snapshot().state,null);assert.deepEqual(restored.snapshot().localInput,input());
 await restored.load();assert.equal(restored.snapshot().state.revision,3);assert.deepEqual(restored.snapshot().localInput,input());
 await restored.save(input());assert.equal(restored.snapshot().state.revision,4);assert.equal(restored.snapshot().status,'ready');restored.dispose();
});

test('unknown commit codes, unrecognized conflicts and absent original records retain the same intent',async()=>{
 for(const response of [()=>reply({error:'PRIVATE_COMMIT_UNKNOWN'},409),()=>reply({error:'OTHER_ERROR'},409),()=>new Response('not JSON',{status:409}),()=>reply(null,404)]){
  let posted=false;const {client}=await fixture({fetchImpl:async(url,init)=>{if(url==='/api/workspace/state')return reply(state());if(init.method==='POST'){posted=true;return response();}return reply(null);}});
  await client.load();await client.save(input());assert.equal(posted,true);assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().requestId,ID+'-1');
  await client.queryOriginal();assert.equal(client.snapshot().requestId,ID+'-1');assert.equal(client.snapshot().canSave,false);client.dispose();
 }
});

test('401 and forbidden responses hide verified state without losing an ambiguous original request',async()=>{
 for(const status of [401,403]){
  let denied=false;const {client}=await fixture({fetchImpl:async(url,init)=>url==='/api/workspace/state'?reply(state()):reply({error:status===401?'PRIVATE_AUTH_REQUIRED':'PRIVATE_FORBIDDEN'},status)});
  await client.load();await client.save(input());assert.equal(client.snapshot().status,status===401?'auth-required':'forbidden');assert.equal(client.snapshot().state,null);assert.equal(client.snapshot().requestId,ID+'-1');assert.equal(client.snapshot().canSave,false);assert.equal(client.snapshot().canLoad,false);
  client.setIdentity({ownerRef:OWNER,expiresAt:NOW+120000});await client.queryOriginal();assert.equal(client.snapshot().requestId,ID+'-1');client.dispose();
 }
});

test('applied responses must match the original owner, ID, base revision and exact input',async()=>{
 const corruptions=[r=>r.request.requestId='wrong-request-123',r=>{r.request.baseRevision=1;r.request.revision=2;r.state.revision=2;},r=>r.state.scope=OTHER,r=>r.state.preferences.workbenchFilter='all',r=>r.state.drafts[0].name='Other input',r=>r.state.executionAuthority='TRADE'];
 for(const corrupt of corruptions){
  const {client}=await fixture({fetchImpl:async(_url,init)=>{if(init.method!=='POST')return reply(state());const result=applied(JSON.parse(init.body));corrupt(result);return reply(result);}});
  await client.load();await client.save(input());assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().requestId,ID+'-1');assert.equal(client.snapshot().state.revision,0);assert.deepEqual(client.snapshot().localInput,input());client.dispose();
 }
});

test('equivalent JSON object key order does not turn a legitimate save into an unknown result',async()=>{
 const {client}=await fixture({fetchImpl:async(_url,init)=>{
  if(init.method!=='POST')return reply(state());
  const result=applied(JSON.parse(init.body)),p=result.state.preferences,d=result.state.drafts[0];
  result.state.preferences={watchedAssets:p.watchedAssets,workbenchFocusAsset:p.workbenchFocusAsset,workbenchFilter:p.workbenchFilter};
  result.state.drafts=[{name:d.name,id:d.id,strategyId:d.strategyId}];
  return reply(result);
 }});
 await client.load();await client.save(input());assert.equal(client.snapshot().status,'ready');assert.equal(client.snapshot().requestId,null);client.dispose();
});

test('identity switches and leave abort requests promptly and ignore late owner results',async()=>{
 for(const action of ['owner','leave','dispose']){
  let release,signal;const {client}=await fixture({fetchImpl:(_url,init)=>{signal=init.signal;return new Promise(resolve=>{release=()=>resolve(reply(state()));});}});
  const pending=client.load();await flush();
  if(action==='owner')client.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});else client[action]();
  assert.equal(signal.aborted,true);await pending;release();await flush();assert.equal(client.snapshot().state,null);assert.equal(client.snapshot().canSave,false);
  if(action==='owner')assert.equal(client.snapshot().ownerRef,OTHER);client.dispose();
 }
});

test('a queued POST cannot dispatch after switching identity and original IDs stay partitioned',async()=>{
 const storage=memory();const {client,calls}=await fixture({storage});await client.load();
 const pending=client.save(input());client.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});await pending;
 assert.equal(calls.filter(call=>call.init.method==='POST').length,0);assert.equal(client.snapshot().requestId,null);
 client.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});assert.equal(client.snapshot().requestId,ID+'-1');assert.equal(client.snapshot().status,'unknown');client.dispose();
});

test('both fetch and body share a hard deadline even when transport ignores abort; late failures are observed',async()=>{
 for(const hang of ['fetch','body']){
  let lateReject,cancelled=false;const errors=[],listener=error=>errors.push(error);process.on('unhandledRejection',listener);
  const {client}=await fixture({timeoutMs:8,fetchImpl:async(url,init)=>{
   if(url==='/api/workspace/state')return reply(state());
   if(hang==='fetch')return new Promise((_resolve,reject)=>{lateReject=reject;});
   return new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});
  }});
  try{await client.load();await client.save(input());assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().requestId,ID+'-1');assert.equal(client.snapshot().canQuery,true);lateReject?.(Error('late secret'));await flush();assert.deepEqual(errors,[]);if(hang==='body')assert.equal(cancelled,true);}
  finally{client.dispose();process.removeListener('unhandledRejection',listener);}
 }
});

test('body bounds, malformed JSON and redirect responses never become a verified saved state',async()=>{
 for(const bad of [()=>new Response('x'.repeat(65537),{headers:{'Content-Type':'application/json'}}),()=>new Response('{broken',{headers:{'Content-Type':'application/json'}}),()=>new Response('{}',{headers:{'Content-Type':'text/html'}}),()=>({redirected:true,headers:new Headers({'Content-Type':'application/json'}),body:new ReadableStream()})]){
  const {client}=await fixture({fetchImpl:async(url)=>url==='/api/workspace/state'?reply(state()):bad()});await client.load();await client.save(input());assert.equal(client.snapshot().status,'unknown');assert.equal(client.snapshot().state.revision,0);assert.equal(client.snapshot().requestId,ID+'-1');client.dispose();
 }
});

test('expired identity, invalid input and failed intent persistence cannot dispatch a save',async()=>{
 let clock=NOW;const {client,calls}=await fixture({now:()=>clock});await client.load();
 await assert.rejects(()=>client.save({...input(),balance:100}),/PRIVATE_REQUEST_INVALID/);assert.equal(calls.length,1);
 clock+=60000;assert.equal(client.snapshot().status,'auth-required');assert.equal(client.snapshot().state,null);await client.save(input());assert.equal(calls.length,1);client.dispose();
 const broken=memory();broken.setItem=()=>{throw Error('quota secret');};const next=await fixture({storage:broken});await next.client.load();await next.client.save(input());assert.equal(next.calls.length,1);assert.equal(next.client.snapshot().status,'error');assert.equal(next.client.snapshot().requestId,null);assert.doesNotMatch(JSON.stringify(next.client.snapshot()),/quota secret/);next.client.dispose();
});
