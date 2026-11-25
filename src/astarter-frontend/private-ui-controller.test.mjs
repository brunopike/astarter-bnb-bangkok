import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateNotificationsClient} from './private-workspace-client.mjs';
import {getLocale,initLocale,localeInfo} from './locale.mjs';

const NOW=1800000000000,OWNER='wallet:offline:56',identity={ownerRef:OWNER,expiresAt:NOW+60000,authVersion:2,permissionProfile:'private-ui-v2'};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const input=()=>({preferences:{workbenchFilter:'all',workbenchFocusAsset:null,watchedAssets:[]},drafts:[],selectedDraftId:null});
const workspace=()=>({schema:'private-workspace-v1',scope:OWNER,revision:0,updatedAt:0,...input(),executionAuthority:'NONE'});
const notices=()=>({schema:'private-notifications-v1',scope:OWNER,revision:0,updatedAt:0,inapp:true,events:['risk','research'],services:Object.fromEntries(['telegram','email'].map(channel=>[channel,{available:false,error:'CHANNEL_DISABLED'}])),channels:Object.fromEntries(['telegram','email'].map(channel=>[channel,{channel,label:'',enabled:0,verified:0}])),deliveries:[],inbox:[{id:'notice-1',type:'research',title:'Research ready',body:'Verified report is available.',source:'server-research',requestId:'research-request-1',createdAt:NOW,readAt:null,executionAuthority:'NONE'}],unreadCount:1,nextCursor:null,mode:'server-research-only'});
const noticesV2=(state=notices(),count)=>({...structuredClone(state),schema:'private-notifications-v2',reminderUnreadCount:count??(state.inapp?state.inbox.filter(row=>row.readAt===null&&state.events.includes(row.type)).length:0)});
function memory(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
const controller=async options=>(await import('./private-ui-controller.mjs')).createPrivateUIController({storage:memory(),now:()=>NOW,...options});
test('native sessionStorage restores an unknown notification intent without an automatic state read',async()=>{
 const {spawnSync}=await import('node:child_process');
 const script=[
  "import assert from 'node:assert/strict';",
  `import {createPrivateNotificationsClient} from ${JSON.stringify(new URL('./private-workspace-client.mjs',import.meta.url).href)};`,
  `import {createPrivateUIController} from ${JSON.stringify(new URL('./private-ui-controller.mjs',import.meta.url).href)};`,
  `const NOW=${NOW},identity=${JSON.stringify(identity)},original=${JSON.stringify(notices())};`,
  "const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}),v2=value=>({...value,schema:'private-notifications-v2',reminderUnreadCount:value.inapp?value.unreadCount:0});",
  "sessionStorage.clear();let receipt;const id='restored-notice-intent-0001';",
  "const first=createPrivateNotificationsClient({storage:sessionStorage,now:()=>NOW,makeRequestId:()=>id,fetchImpl:async(url,init)=>{if(init.method==='GET')return response(v2(original));const input=JSON.parse(init.body);receipt={request:{schema:'private-ui-command-v1',domain:'notifications',requestId:id,status:'applied',baseRevision:0,revision:1,appliedAt:NOW},state:{...original,revision:1,updatedAt:NOW,inapp:false}};throw Error('Offline committed response lost');}});",
  "first.setIdentity({ownerRef:identity.ownerRef,expiresAt:identity.expiresAt});await first.load();await first.save({action:'save',payload:{inapp:false,events:['risk','research'],enabled:{telegram:false,email:false}}});assert.equal(first.snapshot().status,'unknown');assert.equal(first.snapshot().requestId,id);first.dispose();",
  "const calls=[],restored=createPrivateUIController({storage:sessionStorage,now:()=>NOW,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});assert.equal(init.method,'GET','restoration must never replay a write');return response(url.includes('/request?')?receipt:v2(receipt.state));}});",
  "restored.setIdentity(identity);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[]);assert.equal(restored.snapshot().notifications.status,'unknown');assert.equal(restored.snapshot().notifications.requestId,id);",
  "await restored.queryNotifications();assert.deepEqual(calls,[{url:'/api/notifications/request?requestId='+id,method:'GET'},{url:'/api/notifications/state?responseVersion=2',method:'GET'}]);assert.equal(restored.snapshot().notifications.requestId,null);assert.equal(restored.snapshot().notifications.state.reminderUnreadCount,0);assert.equal(restored.snapshot().notifications.status,'ready');restored.dispose();sessionStorage.clear();",
 ].join('\n');
 const result=spawnSync(process.execPath,['--experimental-webstorage','--input-type=module'],{input:script,encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr||result.stdout);
});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function settingsHarness(c){
 const events={},form={inapp:true,events:['risk','research'],querySelector(){return {checked:this.inapp};},querySelectorAll(){return this.events.map(value=>({dataset:{privateNoticeEvent:value}}));}};
 const root={contains:()=>true,querySelector:()=>null,addEventListener(type,fn){events[type]=fn;},removeEventListener(){}};c.bind(root);
 return {edit(inapp,selected){form.inapp=inapp;form.events=selected;events.change({target:{closest:()=>form}});},refresh(){events.click({target:{closest:()=>({dataset:{privateAction:'notifications-load'}})}});},view(){const html=c.renderNotificationSettings();return {inapp:/data-private-inapp checked/.test(html),events:['risk','research'].filter(type=>html.includes('data-private-notice-event="'+type+'" checked'))};}};
}

test('pristine notification settings follow automatic reads after a same-owner session refresh',async t=>{
 let current=notices();const c=await controller({fetchImpl:async()=>response(noticesV2(current))});t.after(()=>c.dispose());c.setIdentity(identity);await c.loadNotifications();const h=settingsHarness(c);assert.deepEqual(h.view(),{inapp:true,events:['risk','research']});
 current={...current,revision:1,updatedAt:NOW,inapp:false,events:['risk']};c.setIdentity({...identity,expiresAt:NOW+120000});await c.loadNotifications();assert.equal(c.snapshot().notifications.state.inapp,false);assert.deepEqual(h.view(),{inapp:false,events:['risk']});
});
test('automatic notification reads preserve unsaved settings edits',async t=>{
 let current=notices();const c=await controller({fetchImpl:async()=>response(noticesV2(current))});t.after(()=>c.dispose());c.setIdentity(identity);await c.loadNotifications();const h=settingsHarness(c);h.view();h.edit(true,['risk']);
 current={...current,revision:1,updatedAt:NOW,inapp:false,events:['research']};await c.loadNotifications();assert.deepEqual(h.view(),{inapp:true,events:['risk']});assert.equal(c.snapshot().notifications.state.inapp,false);
});
test('explicit cloud reload replaces an unchanged local notification draft with current server preferences',async t=>{
 let current=notices();const c=await controller({fetchImpl:async()=>response(noticesV2(current))});t.after(()=>c.dispose());c.setIdentity(identity);await c.loadNotifications();const h=settingsHarness(c);h.view();h.edit(false,['risk']);
 current={...current,revision:1,updatedAt:NOW,inapp:false,events:['research']};h.refresh();await settle();assert.deepEqual(h.view(),{inapp:false,events:['research']});
});
test('new edits made while an explicit notification reload is pending are preserved',async t=>{
 for(const selected of [[],['risk','research']]){
  let release,current=notices(),hold=false;const c=await controller({fetchImpl:async()=>{if(hold)await new Promise(resolve=>{release=resolve;});return response(noticesV2(current));}});t.after(()=>c.dispose());c.setIdentity(identity);await c.loadNotifications();const h=settingsHarness(c);h.view();h.edit(false,['risk']);hold=true;
  current={...current,revision:1,updatedAt:NOW,inapp:false,events:['research']};h.refresh();await settle();h.edit(true,selected);release();await settle();assert.deepEqual(h.view(),{inapp:true,events:selected});assert.deepEqual(c.snapshot().notifications.state.events,['research']);
 }
});
test('identity changes and leaving clear notification settings drafts and their server base',async t=>{
 for(const action of ['other-owner','leave']){
  let scope=OWNER;const c=await controller({fetchImpl:async()=>response({...noticesV2(),scope})});t.after(()=>c.dispose());c.setIdentity(identity);await c.loadNotifications();const h=settingsHarness(c);h.view();h.edit(false,[]);
  if(action==='leave'){c.leave();c.setIdentity(identity);}else{scope='wallet:other:56';c.setIdentity({...identity,ownerRef:scope});}
  await settle();assert.deepEqual(h.view(),{inapp:true,events:['risk','research']});assert.equal(c.snapshot().notifications.state.scope,scope);
 }
});
test('new usable identities load notification counts once without opening the inbox and ignore late old-owner reads',async t=>{
 let calls=0,release;const other={...identity,ownerRef:'wallet:other:56'},c=await controller({fetchImpl:async()=>{calls++;if(calls===1){await new Promise(resolve=>{release=resolve;});return response(noticesV2());}return response({...noticesV2(),scope:other.ownerRef});}});t.after(()=>c.dispose());
 c.setIdentity(identity);await settle();assert.equal(calls,1);c.setIdentity(other);await settle();assert.equal(calls,2);assert.equal(c.snapshot().notifications.state.scope,other.ownerRef);release();await settle();assert.equal(c.snapshot().notifications.state.scope,other.ownerRef);
 c.setIdentity(other);await settle();assert.equal(calls,2,'duplicate identity events do not refetch');c.setIdentity({...other,expiresAt:NOW+120000});await settle();assert.equal(calls,3,'a renewed session refreshes its reminder count');
});
test('an unrelated workspace read cannot cancel the v2 refresh after a confirmed notification write',async t=>{
 let release,current=notices();const calls=[],c=await controller({fetchImpl:async(url,init)=>{calls.push({url,init});if(url.includes('/workspace/'))return response(workspace());if(init.method==='POST'){const input=JSON.parse(init.body);await new Promise(resolve=>{release=resolve;});current={...current,revision:1,updatedAt:NOW,inapp:false};return response({request:{schema:'private-ui-command-v1',domain:'notifications',requestId:input.requestId,status:'applied',baseRevision:0,revision:1,appliedAt:NOW},state:current});}return response(noticesV2(current));}});t.after(()=>c.dispose());
 c.setIdentity(identity);await c.loadNotifications();const saving=c.saveNotifications({inapp:false,events:['risk','research']});await settle();await c.loadWorkspace();release();await saving;assert.equal(c.snapshot().notifications.state.schema,'private-notifications-v2');assert.equal(c.snapshot().notifications.state.reminderUnreadCount,0);assert.equal(calls.filter(call=>call.url==='/api/notifications/state?responseVersion=2').length,2);
});

test('private UI controller is a browser factory with no implicit API request',async()=>{
 let calls=0;const c=await controller({fetchImpl:()=>{calls++;}});assert.equal(calls,0);assert.equal(c.snapshot().identityStatus,'auth-required');c.dispose();
});

test('v1 identity cannot read or save v2 account UI and requests an explicit login upgrade',async()=>{
 let calls=0,requested;const target=new EventTarget();target.addEventListener('astarter:authenticate-wallet',e=>requested=e.detail);
 const c=await controller({eventTarget:target,fetchImpl:()=>{calls++;}});c.setIdentity({...identity,authVersion:1,permissionProfile:'research-v1'});
 await c.loadWorkspace();await c.loadNotifications();assert.equal(calls,0);assert.equal(c.snapshot().identityStatus,'upgrade-required');assert.match(c.renderWorkspace(),/更新登录|Update sign-in/);
 c.requestAuthentication();assert.deepEqual(requested,{requiredProfile:'private-ui-v2'});c.dispose();
});
test('an unknown future auth version is never presented as a v2 ready session',async()=>{
 let calls=0;const c=await controller({fetchImpl:()=>{calls++;}});c.setIdentity({...identity,authVersion:3});await c.loadWorkspace();await c.loadNotifications();assert.equal(c.snapshot().identityStatus,'upgrade-required');assert.equal(calls,0);c.dispose();
});

test('reading cloud metadata cannot apply local changes; applying requires its own explicit action',async()=>{
 let applied=0,posted=0;const c=await controller({getWorkspaceInput:input,applyWorkspaceInput:value=>{applied++;assert.deepEqual(value.preferences,input().preferences);},fetchImpl:async(url,init)=>{if(init.method==='POST')posted++;return response(url.includes('/notifications/')?noticesV2():workspace());}});
 c.setIdentity(identity);await c.loadWorkspace();assert.equal(applied,0);assert.equal(posted,0);assert.equal(c.snapshot().workspace.state.revision,0);
 await c.applyWorkspace();assert.equal(applied,1);assert.equal(posted,0);c.dispose();
});

test('v2 server notifications have exact cookie commands and confirmed read state, with no outbound channels',async()=>{
 let state=notices();const calls=[];
 const n=createPrivateNotificationsClient({storage:memory(),now:()=>NOW,makeRequestId:()=>crypto.randomUUID(),fetchImpl:async(url,init)=>{
  calls.push({url,init});if(init.method==='GET')return response(noticesV2(state));
  const command=JSON.parse(init.body);state=structuredClone(state);state.revision++;state.updatedAt=NOW;
  if(command.action==='mark-read'){for(const row of state.inbox)if(command.payload.ids.includes(row.id))row.readAt=NOW;state.unreadCount=state.inbox.filter(x=>x.readAt===null).length;}
  else{state.events=command.payload.events;state.inapp=command.payload.inapp;}
  return response({request:{schema:'private-ui-command-v1',domain:'notifications',requestId:command.requestId,status:'applied',baseRevision:command.baseRevision,revision:state.revision,appliedAt:NOW},state});
 }});
 n.setIdentity({ownerRef:identity.ownerRef,expiresAt:identity.expiresAt});await n.load();assert.equal(n.snapshot().state.unreadCount,1);assert.equal(calls.length,1);
 await n.save({action:'mark-read',payload:{ids:['notice-1']}});assert.equal(n.snapshot().state.unreadCount,0);assert.equal(calls[1].url,'/api/notifications/command');assert.equal(calls[1].init.credentials,'same-origin');assert.equal(calls[1].init.headers.Origin,undefined);
 await n.save({action:'save',payload:{events:['research'],enabled:{telegram:false,email:false},inapp:false}});assert.equal(n.snapshot().state.inapp,false);
 await assert.rejects(()=>n.save({action:'save',payload:{events:['research'],enabled:{telegram:true,email:false},inapp:true}}),/PRIVATE_REQUEST_INVALID/);n.dispose();
});

test('unknown mark-read does not optimistically clear unread counts and null only queries the original ID',async()=>{
 const calls=[];const c=await controller({fetchImpl:async(url,init)=>{calls.push({url,init});if(init.method==='POST')throw Error('unconfirmed');return response(url.includes('/request?')?null:noticesV2());}});
 c.setIdentity(identity);await c.loadNotifications();await c.markNotificationsRead(['notice-1']);assert.equal(c.snapshot().notifications.status,'unknown');assert.equal(c.snapshot().notifications.state.unreadCount,1);
 await c.queryNotifications();await c.queryNotifications();assert.equal(calls.filter(x=>x.init.method==='POST').length,1);assert.ok(calls.slice(2).every(x=>x.url.includes('/api/notifications/request?requestId=')));assert.match(c.renderInbox(),/查询原请求|Check original request/);c.dispose();
});

test('cross-owner changes clear both visible private scopes together without borrowing a local cache proof',async()=>{
 const seen=[],c=await controller({fetchImpl:async url=>response(url.includes('/notifications/')?noticesV2():workspace())});c.setIdentity(identity);await c.loadWorkspace();await c.loadNotifications();
 c.subscribe(s=>seen.push(s));c.setIdentity({...identity,ownerRef:'wallet:other:56'});assert.equal(c.snapshot().workspace.state,null);assert.equal(c.snapshot().notifications.state,null);assert.ok(seen.every(s=>!s.workspace.state&&!s.notifications.state));c.dispose();
});
test('an old apply completion cannot publish success after an account change, leave, or disposal',async()=>{
 for(const transition of ['other-owner','same-owner-return','leave','dispose']){
  let release;const c=await controller({fetchImpl:async url=>response(url.includes('/notifications/')?noticesV2():workspace()),applyWorkspaceInput:()=>new Promise(resolve=>{release=resolve;})});
  c.setIdentity(identity);await c.loadWorkspace();const pending=c.applyWorkspace();
  if(transition==='leave')c.leave();else if(transition==='dispose')c.dispose();else{c.setIdentity({...identity,ownerRef:'wallet:other:56'});if(transition==='same-owner-return')c.setIdentity(identity);}
  release(null);await pending;assert.equal(c.snapshot().feedback,'');assert.equal(c.snapshot().workspace.state,null);assert.doesNotMatch(c.renderWorkspace(),/已应用到本机|Applied on this device/);c.dispose();
 }
});
test('a server auth denial clears both private views and offers explicit reauthentication',async()=>{
 let denied=false;const c=await controller({fetchImpl:async url=>denied?response({error:'PRIVATE_AUTH_REQUIRED'},401):response(url.includes('/notifications/')?noticesV2():workspace())});
 c.setIdentity(identity);await c.loadWorkspace();await c.loadNotifications();denied=true;await c.loadNotifications();
 assert.equal(c.snapshot().identityStatus,'auth-required');assert.equal(c.snapshot().workspace.state,null);assert.equal(c.snapshot().notifications.state,null);assert.match(c.renderInbox(),/更新登录|Update sign-in/);c.dispose();
});
test('a short notification page preserves an opaque cursor and does not claim all records are shown',async()=>{
 const page=noticesV2();page.nextCursor='c'.repeat(512);const c=await controller({fetchImpl:async()=>response(page)});c.setIdentity(identity);await c.loadNotifications();assert.equal(c.snapshot().notifications.state.nextCursor,page.nextCursor);assert.match(c.renderInbox(),/仅显示当前页|Showing the current page/);assert.match(c.renderInbox(),/本页标为已读|Mark this page read/);assert.doesNotMatch(c.renderNotificationSettings(),/data-private-notice-event="orders"/);c.dispose();
});

test('confirmed preference saves and mark-read refresh v2 global reminders while preserving v1 receipts and history',async()=>{
 let state=notices(),stored;const calls=[];
 const c=await controller({fetchImpl:async(url,init)=>{
  calls.push({url,init});if(init.method==='GET'){assert.equal(url,'/api/notifications/state?responseVersion=2');return response(noticesV2(state));}
  const command=JSON.parse(init.body);state={...structuredClone(state),revision:state.revision+1,updatedAt:NOW};
  if(command.action==='save')Object.assign(state,{inapp:command.payload.inapp,events:command.payload.events});else{state.inbox[0].readAt=NOW;state.unreadCount=0;}
  stored={request:{schema:'private-ui-command-v1',domain:'notifications',requestId:command.requestId,status:'applied',baseRevision:command.baseRevision,revision:state.revision,appliedAt:NOW},state:structuredClone(state)};return response(stored);
 }});
 c.setIdentity(identity);await c.loadNotifications();await c.saveNotifications({inapp:false,events:['research']});
 assert.deepEqual(calls.map(x=>x.init.method),['GET','POST','GET']);assert.equal(stored.state.schema,'private-notifications-v1');assert.equal(Object.hasOwn(stored.state,'reminderUnreadCount'),false);
 assert.equal(c.snapshot().notifications.state.schema,'private-notifications-v2');assert.equal(c.snapshot().notifications.state.reminderUnreadCount,0);assert.equal(c.snapshot().notifications.state.unreadCount,1);assert.match(c.renderInbox(),/Research ready/);
 await c.markNotificationsRead(['notice-1']);assert.deepEqual(calls.map(x=>x.init.method),['GET','POST','GET','POST','GET']);assert.equal(c.snapshot().notifications.state.unreadCount,0);c.dispose();
});
test('an unknown notification save only queries its original ID, then refreshes v2 after a confirmed receipt',async()=>{
 const calls=[];let stored,current=notices();
 const c=await controller({fetchImpl:async(url,init)=>{
  calls.push({url,init});if(init.method==='POST'){const command=JSON.parse(init.body);current={...current,inapp:false,revision:1,updatedAt:NOW};stored={request:{schema:'private-ui-command-v1',domain:'notifications',requestId:command.requestId,status:'applied',baseRevision:0,revision:1,appliedAt:NOW},state:structuredClone(current)};throw Error('Offline committed response lost');}
  if(url.includes('/request?'))return response(stored);return response(noticesV2(current));
 }});
 c.setIdentity(identity);await c.loadNotifications();await c.saveNotifications({inapp:false,events:['risk','research']});assert.equal(c.snapshot().notifications.status,'unknown');assert.equal(calls.length,2);
 const original=c.snapshot().notifications.requestId;await c.queryNotifications();assert.equal(calls[2].url,'/api/notifications/request?requestId='+original);assert.equal(calls[3].url,'/api/notifications/state?responseVersion=2');assert.equal(calls.filter(x=>x.init.method==='POST').length,1);assert.equal(c.snapshot().notifications.state.reminderUnreadCount,0);assert.equal(c.snapshot().notifications.requestId,null);c.dispose();
});

// Automatic inbox refresh. The mocked setTimeout also drives the client's 15 s request deadline,
// so every tick is followed by settle() and a held response is released before time moves on.
const LONG={...identity,expiresAt:NOW+3600000},STATE_URL='/api/notifications/state?responseVersion=2',ON_SCREEN={isConnected:true,getClientRects:()=>[{}]};
const inboxRoot=(inbox=ON_SCREEN)=>({inbox,contains:()=>true,addEventListener(){},removeEventListener(){},querySelector(selector){return selector==='[data-private-inbox]'?this.inbox:null;}});
const held=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
const stateReads=calls=>calls.filter(call=>call.url===STATE_URL&&call.method==='GET').length;
const receipt=(command,state)=>({request:{schema:'private-ui-command-v1',domain:'notifications',requestId:command.requestId,status:'applied',baseRevision:command.baseRevision,revision:state.revision,appliedAt:NOW},state});
const markRead=(state,ids)=>{const next={...structuredClone(state),revision:state.revision+1,updatedAt:NOW};for(const row of next.inbox)if(ids.includes(row.id))row.readAt=NOW;next.unreadCount=next.inbox.filter(row=>row.readAt===null).length;return next;};
const listed=(selector,part)=>selector.split(',').some(item=>item.trim()===part);
const element=(tag,inside)=>({matches:selector=>listed(selector,tag),closest:selector=>inside&&listed(selector,inside)?{}:null});
async function bound(t,{root=inboxRoot(),...options}){const c=await controller(options);t.after(()=>c.dispose());c.bind(root);return {c,root};}
async function minutes(t,count=1){for(let i=0;i<count;i++){t.mock.timers.tick(60000);await settle();}}
function pageDocument(t){
 const page={visibilityState:'visible',activeElement:null,querySelector:()=>null,querySelectorAll(selector){const node=this.querySelector(selector);return node?[node]:[];}},before=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:page});t.after(()=>{if(before)Object.defineProperty(globalThis,'document',before);else delete globalThis.document;});return page;
}

test('the inbox reads notification state once every 60 seconds while it is on screen',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 c.setIdentity(LONG);await settle();assert.equal(calls.length,1);
 t.mock.timers.tick(59999);await settle();assert.equal(calls.length,1,'no read before 60 seconds');
 t.mock.timers.tick(1);await settle();assert.equal(calls.length,2,'one read at 60 seconds');assert.deepEqual(calls[1],{url:STATE_URL,method:'GET'});
 await minutes(t);assert.equal(calls.length,3,'one read in each further minute');
});
test('automatic inbox refresh only reads notification state',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{getWorkspaceInput:input,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(url.includes('/workspace/')?workspace():noticesV2());}});
 c.setIdentity(LONG);await settle();await minutes(t,5);
 assert.deepEqual(calls,Array.from({length:6},()=>({url:STATE_URL,method:'GET'})),'no workspace, research, order or write request');
});
test('a refresh during a running notification read or save sends no second request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let current=notices(),gate=null;const calls=[];
 const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});const wait=gate;gate=null;if(wait)await wait.promise;if(init.method==='POST'){const command=JSON.parse(init.body);current=markRead(current,command.payload.ids);return response(receipt(command,current));}return response(noticesV2(current));}});
 c.setIdentity(LONG);await settle();t.mock.timers.tick(59000);await settle();
 const post=held();gate=post;const marking=c.markNotificationsRead(['notice-1']);await settle();assert.equal(calls.at(-1).method,'POST');
 t.mock.timers.tick(1000);await settle();assert.equal(stateReads(calls),1,'no read while the mark-read runs');
 post.open();await marking;await settle();assert.equal(stateReads(calls),2,'only the read after the confirmed command');
 const read=held();gate=read;await minutes(t);assert.equal(stateReads(calls),3,'the next tick reads');
 const manual=c.loadNotifications();await settle();assert.equal(stateReads(calls),3,'a manual refresh shares the running read');
 read.open();await manual;assert.equal(stateReads(calls),3);assert.equal(c.snapshot().notifications.state.unreadCount,0);
});
test('automatic refresh waits while the page is hidden or the inbox has no box on screen',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c,root}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 const page=pageDocument(t);c.setIdentity(LONG);await settle();assert.equal(calls.length,1);
 const cases=[
  ['hidden page',()=>{page.visibilityState='hidden';},()=>{page.visibilityState='visible';}],
  ['no inbox in the page',()=>{root.inbox=null;},()=>{root.inbox=ON_SCREEN;}],
  ['inbox no longer connected',()=>{root.inbox={isConnected:false,getClientRects:()=>[{}]};},()=>{root.inbox=ON_SCREEN;}],
  ['inbox without a layout box',()=>{root.inbox={isConnected:true,getClientRects:()=>[]};},()=>{root.inbox=ON_SCREEN;}],
 ];
 for(const [name,hide,show] of cases){const before=calls.length;hide();await minutes(t,3);assert.equal(calls.length,before,name);show();await minutes(t);assert.equal(calls.length,before+1,name+', then shown');}
});
test('automatic refresh does not interrupt a focused or pressed control, a field in use or an open dialog',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 const page=pageDocument(t);c.setIdentity(LONG);await settle();
 const cases=[
  ['focused settings field',()=>{page.activeElement=element('input','[data-private-notification-settings]');}],
  ['focused inbox button',()=>{page.activeElement=element('button','[data-private-inbox]');}],
  ['open dialog',()=>{page.querySelector=selector=>listed(selector,'dialog[open]')?{}:null;}],
  ['pressed inbox button',()=>{page.querySelector=selector=>listed(selector,'[data-private-inbox] button:active')?{}:null;}],
 ];
 for(const [name,use] of cases){const before=calls.length;use();await minutes(t,2);assert.equal(calls.length,before,name);page.activeElement=null;page.querySelector=()=>null;await minutes(t);assert.equal(calls.length,before+1,name+', then released');}
 const before=calls.length;page.activeElement=element('input',null);await minutes(t);assert.equal(calls.length,before+1,'a focused field outside the inbox and settings does not pause the refresh');
});
test('automatic refresh keeps the shown feedback and a pending apply result',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let wait=null;const calls=[],applied=/账户偏好已应用|Account preferences applied/;
 const {c}=await bound(t,{getWorkspaceInput:input,applyWorkspaceInput:()=>wait?.promise??null,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(url.includes('/workspace/')?workspace():noticesV2());}});
 c.setIdentity(LONG);await settle();await c.loadWorkspace();await c.applyWorkspace();assert.match(c.snapshot().feedback,applied);
 const before=stateReads(calls);await minutes(t);assert.equal(stateReads(calls),before+1,'the tick read notification state');assert.match(c.snapshot().feedback,applied,'the shown feedback stays');
 wait=held();const pending=c.applyWorkspace();await settle();assert.equal(c.snapshot().feedback,'');
 await minutes(t);assert.equal(stateReads(calls),before+2,'the tick read while the apply waits');
 wait.open(null);await pending;assert.match(c.snapshot().feedback,applied,'the waiting apply still reports its result');
});
test('automatic refresh does not read while an original notification request is unconfirmed',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let current=notices(),stored=null;const calls=[],note=/自动刷新：60 秒|Auto refresh: 60 seconds/;
 const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});if(init.method==='POST'){const command=JSON.parse(init.body);current=markRead(current,command.payload.ids);stored=receipt(command,structuredClone(current));throw Error('Offline committed response lost');}return response(url.includes('/request?')?stored:noticesV2(current));}});
 c.setIdentity(LONG);await settle();await c.markNotificationsRead(['notice-1']);assert.equal(c.snapshot().notifications.status,'unknown');assert.doesNotMatch(c.renderInbox(),note,'no refresh note while the request is unconfirmed');
 await minutes(t,3);assert.equal(stateReads(calls),1,'no automatic read while unconfirmed');
 await c.queryNotifications();assert.equal(c.snapshot().notifications.requestId,null);assert.equal(stateReads(calls),2);assert.match(c.renderInbox(),note);
 await minutes(t);assert.equal(stateReads(calls),3,'automatic reads resume once the request is confirmed');
});
test('a session restored with an unconfirmed request starts automatic refresh once the request is confirmed',async t=>{
 const storage=memory(),id='restored-notice-intent-0002';let current=notices(),stored=null;
 const seed=createPrivateNotificationsClient({storage,now:()=>NOW,makeRequestId:()=>id,fetchImpl:async(url,init)=>{if(init.method==='GET')return response(noticesV2(current));const command=JSON.parse(init.body);current=markRead(current,command.payload.ids);stored=receipt(command,structuredClone(current));throw Error('Offline committed response lost');}});
 seed.setIdentity({ownerRef:OWNER,expiresAt:LONG.expiresAt});await seed.load();await seed.save({action:'mark-read',payload:{ids:['notice-1']}});assert.equal(seed.snapshot().requestId,id);seed.dispose();
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{storage,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(url.includes('/request?')?stored:noticesV2(current));}});
 c.setIdentity(LONG);await settle();assert.deepEqual(calls,[]);assert.equal(c.snapshot().notifications.requestId,id);
 await minutes(t);assert.deepEqual(calls,[],'no automatic read while the restored request is unconfirmed');
 await c.queryNotifications();assert.deepEqual(calls,[{url:'/api/notifications/request?requestId='+id,method:'GET'},{url:STATE_URL,method:'GET'}]);
 await minutes(t);assert.deepEqual(calls.slice(2),[{url:STATE_URL,method:'GET'}],'the timer started at sign-in reads once the request is confirmed');
});
test('no notification request is sent after leaving, a refused session or disposal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const end of ['leave','refused','dispose']){
  let refused=false;const calls=[];const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return refused?response({error:'PRIVATE_AUTH_REQUIRED'},401):response(noticesV2());}});
  c.setIdentity(LONG);await settle();
  if(end==='leave')c.leave();else if(end==='dispose')c.dispose();else{refused=true;await c.loadNotifications();assert.equal(c.snapshot().identityStatus,'auth-required');}
  const before=calls.length;await minutes(t,3);assert.equal(calls.length,before,end);
 }
});
test('after an owner change the automatic refresh shows only the new owner inbox and count',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const OTHER='wallet:other:56',row=notices().inbox[0];
 const ownerA={...notices(),inbox:[{...row,title:'Owner A report'}]},ownerB={...notices(),scope:OTHER,inbox:[1,2].map(n=>({...row,id:'notice-b'+n,title:'Owner B report '+n,requestId:'research-request-b'+n})),unreadCount:2};
 let serving='a',gate=null;const calls=[];
 const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});const wait=gate;gate=null;if(wait)await wait.promise;return serving==='a'?response(noticesV2(ownerA)):serving==='b'?response(noticesV2(ownerB)):response({error:'PRIVATE_SERVICE_UNAVAILABLE'},503);}});
 c.setIdentity(LONG);await settle();assert.match(c.renderInbox(),/Owner A report/);
 const late=held();gate=late;await minutes(t);assert.equal(calls.length,2,'the tick started a read for the first owner');
 serving='down';c.setIdentity({...LONG,ownerRef:OTHER});await settle();late.open();await settle();
 let html=c.renderInbox();assert.doesNotMatch(html,/Owner A report/);assert.match(html,/data-inbox-state="error"/);assert.doesNotMatch(html,/\u00b7 1 (?:未读|unread)/);
 serving='b';await minutes(t);assert.equal(c.snapshot().notifications.state.scope,OTHER);
 html=c.renderInbox();assert.match(html,/Owner B report 1/);assert.match(html,/\u00b7 2 (?:未读|unread)/);assert.doesNotMatch(html,/Owner A report/);
});
test('a manual refresh restarts the automatic refresh count',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 c.setIdentity(LONG);await settle();t.mock.timers.tick(30000);await settle();
 await c.loadNotifications({replaceDraft:true});assert.equal(calls.length,2);
 t.mock.timers.tick(30000);await settle();assert.equal(calls.length,2,'no automatic read 30 seconds after a manual one');
 t.mock.timers.tick(30000);await settle();assert.equal(calls.length,3,'the automatic read comes 60 seconds after the manual one');
});
test('the inbox marks loading, error, empty, list and an earlier list kept after a failed refresh',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const row=notices().inbox[0],empty={...notices(),revision:1,inbox:[],unreadCount:0},two={...notices(),revision:2,inbox:[row,{...row,id:'notice-2',title:'Research read',requestId:'research-request-2',readAt:NOW}],unreadCount:1};
 let reply=null,gate=null;
 const {c}=await bound(t,{fetchImpl:async()=>{const wait=gate;gate=null;if(wait)await wait.promise;return reply?response(noticesV2(reply)):response({error:'PRIVATE_SERVICE_UNAVAILABLE'},503);}});
 const mark=()=>c.renderInbox().match(/data-inbox-state="([a-z]+)"/)?.[1];
 const first=held();gate=first;c.setIdentity(LONG);await settle();
 assert.equal(mark(),'loading');assert.match(c.renderInbox(),/aria-busy="true"/);
 first.open();await settle();assert.equal(mark(),'error');assert.doesNotMatch(c.renderInbox(),/aria-busy/);
 reply=empty;await c.loadNotifications();assert.equal(mark(),'empty');assert.match(c.renderInbox(),/暂无账户通知|No account notices yet/);
 reply=two;await c.loadNotifications();assert.equal(mark(),'list');
 const html=c.renderInbox();assert.equal(html.match(/data-notice-state="unread"/g)?.length,1);assert.equal(html.match(/data-notice-state="read"/g)?.length,1);
 reply=null;await minutes(t);assert.equal(mark(),'stale');
 const stale=c.renderInbox();assert.match(stale,/Research ready/);assert.match(stale,/Research read/);assert.match(stale,/暂时无法更新|Unable to update/);
});
test('an automatic refresh keeps the status text while a manual refresh shows loading',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let down=false,gate=null;const calls=[];
 const {c}=await bound(t,{fetchImpl:async url=>{calls.push(url);const wait=gate;gate=null;if(wait)await wait.promise;return down?response({error:'PRIVATE_SERVICE_UNAVAILABLE'},503):response(noticesV2());}});
 const loading=/正在读取|Loading/,loaded=/已读取账户数据|Account data loaded/,stale=/暂时无法更新|Unable to update/,note=/自动刷新：60 秒|Auto refresh: 60 seconds/;
 c.setIdentity(LONG);await settle();
 let wait=held();gate=wait;await minutes(t);assert.equal(calls.length,2,'the tick started a read');
 let html=c.renderInbox();assert.doesNotMatch(html,loading);assert.match(html,loaded);assert.match(html,/aria-busy="true"/);assert.match(html,note);
 wait.open();await settle();
 wait=held();gate=wait;const manual=c.loadNotifications();await settle();assert.match(c.renderInbox(),loading,'a manual refresh shows loading');wait.open();await manual;
 down=true;await minutes(t);assert.match(c.renderInbox(),stale);
 down=false;wait=held();gate=wait;await minutes(t);assert.equal(calls.length,5);
 html=c.renderInbox();assert.match(html,stale,'a retry after a failed refresh keeps the failure visible');assert.doesNotMatch(html,loaded);assert.doesNotMatch(html,loading);
 wait.open();await settle();assert.match(c.renderInbox(),loaded);
});
test('automatic refresh waits while account workspace data is being saved',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let gate=null;const calls=[];
 const {c}=await bound(t,{getWorkspaceInput:input,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});const wait=gate;gate=null;if(wait){await wait.promise;throw Error('Offline save response lost');}return response(url.includes('/workspace/')?workspace():noticesV2());}});
 c.setIdentity(LONG);await settle();await c.loadWorkspace();t.mock.timers.tick(59000);await settle();
 const save=held();gate=save;const saving=c.saveWorkspace();await settle();assert.equal(c.snapshot().workspace.status,'saving');
 const before=stateReads(calls);t.mock.timers.tick(1000);await settle();assert.equal(stateReads(calls),before,'no notification read while the workspace save runs');
 save.open();await saving;assert.notEqual(c.snapshot().workspace.status,'saving');
 await minutes(t);assert.equal(stateReads(calls),before+1,'the next tick reads');
});
test('a confirmed in-app preference save still shows external delivery as not enabled',async t=>{
 let current=notices();const posts=[];
 const c=await controller({fetchImpl:async(url,init)=>{if(init.method!=='POST')return response(noticesV2(current));const command=JSON.parse(init.body);posts.push(command);current={...structuredClone(current),revision:current.revision+1,updatedAt:NOW,inapp:command.payload.inapp,events:command.payload.events};return response(receipt(command,current));}});t.after(()=>c.dispose());
 c.setIdentity(identity);await c.loadNotifications();await c.saveNotifications({inapp:true,events:['risk','research']});
 assert.equal(c.snapshot().notifications.status,'ready');assert.deepEqual(posts.map(command=>command.payload.enabled),[{telegram:false,email:false}]);
 const html=c.renderNotificationSettings()+c.renderInbox();assert.match(html,/尚未启用|Not enabled/);assert.doesNotMatch(html,/已送达|已发送|delivered|Delivered|Email sent|Telegram sent/);
});
test('inbox rows come from the server, so a new controller with fresh storage shows the same rows',async t=>{
 const server=async()=>response(noticesV2());
 const first=await controller({fetchImpl:server});first.setIdentity(identity);await first.loadNotifications();const before=first.renderInbox();first.dispose();
 const second=await controller({fetchImpl:server});t.after(()=>second.dispose());second.setIdentity(identity);await second.loadNotifications();
 assert.match(before,/Research ready/);assert.match(before,/\u00b7 1 (?:未读|unread)/);assert.equal(second.renderInbox(),before);
});
// A dialog can stay open inside a page that is hidden, for example the strategy editor in the product page while the workbench is shown.
test('an open dialog on a hidden page does not stop the automatic refresh, an open dialog on screen does',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 const page=pageDocument(t),leftOpen={isConnected:true,getClientRects:()=>[]};let dialogs=[];
 page.querySelector=selector=>listed(selector,'dialog[open]')&&dialogs[0]||null;page.querySelectorAll=selector=>listed(selector,'dialog[open]')?dialogs:[];
 c.setIdentity(LONG);await settle();assert.equal(calls.length,1);
 dialogs=[leftOpen];await minutes(t);assert.equal(calls.length,2,'an open dialog without a layout box does not stop the refresh');
 dialogs=[leftOpen,ON_SCREEN];await minutes(t,2);assert.equal(calls.length,2,'an open dialog on screen pauses the refresh');
 dialogs=[leftOpen];await minutes(t);assert.equal(calls.length,3,'the refresh resumes once the dialog on screen closes');
});
test('an open dialog on screen pauses the automatic refresh wherever it sits among the open dialogs',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 const page=pageDocument(t),leftOpen={isConnected:true,getClientRects:()=>[]};let dialogs=[];
 page.querySelector=selector=>listed(selector,'dialog[open]')&&dialogs[0]||null;page.querySelectorAll=selector=>listed(selector,'dialog[open]')?dialogs:[];
 c.setIdentity(LONG);await settle();assert.equal(calls.length,1);
 for(const [where,open] of [['first',[ON_SCREEN,leftOpen]],['between two hidden ones',[leftOpen,ON_SCREEN,leftOpen]],['last',[leftOpen,leftOpen,ON_SCREEN]]]){
  const before=calls.length;dialogs=open;await minutes(t,2);assert.equal(calls.length,before,'a dialog on screen '+where+' pauses the refresh');
  dialogs=[leftOpen];await minutes(t);assert.equal(calls.length,before+1,'the refresh resumes once the dialog on screen '+where+' closes');
 }
});
test('the inbox marks idle for a restored unconfirmed request with no list, and stale when an empty list cannot be updated',async t=>{
 const storage=memory(),id='restored-notice-intent-0003',current=notices();
 const seed=createPrivateNotificationsClient({storage,now:()=>NOW,makeRequestId:()=>id,fetchImpl:async(url,init)=>{if(init.method==='GET')return response(noticesV2(current));throw Error('Offline committed response lost');}});
 seed.setIdentity({ownerRef:OWNER,expiresAt:LONG.expiresAt});await seed.load();await seed.save({action:'mark-read',payload:{ids:['notice-1']}});assert.equal(seed.snapshot().requestId,id);seed.dispose();
 const reads=[],restored=await controller({storage,fetchImpl:async url=>{reads.push(url);return response(noticesV2(current));}});t.after(()=>restored.dispose());
 restored.setIdentity(LONG);await settle();assert.deepEqual(reads,[]);
 const idle=restored.renderInbox();assert.match(idle,/data-inbox-state="idle"/);assert.match(idle,/结果待确认|Unconfirmed/);assert.match(idle,/查询原请求|Check original request/);assert.doesNotMatch(idle,/aria-busy/);
 let reply={...notices(),revision:1,inbox:[],unreadCount:0};const c=await controller({fetchImpl:async()=>reply?response(noticesV2(reply)):response({error:'PRIVATE_SERVICE_UNAVAILABLE'},503)});t.after(()=>c.dispose());
 c.setIdentity(LONG);await settle();assert.match(c.renderInbox(),/data-inbox-state="empty"/);
 reply=null;await c.loadNotifications();const stale=c.renderInbox();
 assert.match(stale,/data-inbox-state="stale"/,'a failed read over an empty list is not shown as a fresh empty inbox');assert.match(stale,/暂时无法更新|Unable to update/);assert.match(stale,/暂无账户通知|No account notices yet/);
});
test('the read after a confirmed command restarts the automatic refresh count',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const action of ['mark-read','save']){
  let current=notices();const calls=[];
  const {c}=await bound(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method});if(init.method!=='POST')return response(noticesV2(current));const command=JSON.parse(init.body);current=command.action==='mark-read'?markRead(current,command.payload.ids):{...structuredClone(current),revision:current.revision+1,updatedAt:NOW,inapp:command.payload.inapp,events:command.payload.events};return response(receipt(command,current));}});
  c.setIdentity(LONG);await settle();t.mock.timers.tick(30000);await settle();
  await(action==='mark-read'?c.markNotificationsRead(['notice-1']):c.saveNotifications({inapp:true,events:['research']}));assert.deepEqual(calls.map(call=>call.method),['GET','POST','GET'],action);
  t.mock.timers.tick(30000);await settle();assert.equal(stateReads(calls),2,action+': no automatic read 30 seconds after the read that followed the confirmed command');
  t.mock.timers.tick(30000);await settle();assert.equal(stateReads(calls),3,action+': the automatic read comes 60 seconds after that read');
  c.dispose();
 }
});
// The element that holds the inbox (the notices panel of the console) is redrawn by each read.
test('automatic refresh waits while text is selected in the panel that holds the inbox',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const words={},elsewhere={},panel={contains:node=>node===words,querySelector:()=>null};
 const calls=[];const {c}=await bound(t,{root:inboxRoot({...ON_SCREEN,parentElement:panel}),fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 const page=pageDocument(t),range=(anchorNode,focusNode,isCollapsed=false)=>({anchorNode,focusNode,isCollapsed,rangeCount:1});let selection=null;page.getSelection=()=>selection;
 c.setIdentity(LONG);await settle();assert.equal(calls.length,1);
 for(const [name,selected] of [['text selected in the panel',range(words,words)],['a selection that ends in the panel',range(elsewhere,words)],['a selection that starts in the panel',range(words,elsewhere)]]){
  const before=calls.length;selection=selected;await minutes(t,2);assert.equal(calls.length,before,name+' pauses the refresh');
  selection=null;await minutes(t);assert.equal(calls.length,before+1,name+', then cleared');
 }
 for(const [name,selected] of [['a caret in the panel',range(words,words,true)],['text selected outside the panel',range(elsewhere,elsewhere)]]){const before=calls.length;selection=selected;await minutes(t);assert.equal(calls.length,before+1,name+' does not pause the refresh');}
});
test('automatic refresh waits while any button in the panel that holds the inbox is pressed',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let pressed=false;const panel={contains:()=>false,querySelector:selector=>pressed&&listed(selector,'button:active')?{}:null};
 const calls=[];const {c}=await bound(t,{root:inboxRoot({...ON_SCREEN,parentElement:panel}),fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return response(noticesV2());}});
 const page=pageDocument(t);c.setIdentity(LONG);await settle();
 let before=calls.length;pressed=true;await minutes(t,2);assert.equal(calls.length,before,'a pressed button next to the inbox, such as the panel settings button, pauses the refresh');
 pressed=false;await minutes(t);assert.equal(calls.length,before+1,'the refresh resumes once it is released');
 before=calls.length;page.querySelector=selector=>listed(selector,'button:active')?{}:null;await minutes(t);assert.equal(calls.length,before+1,'a pressed button outside that panel does not pause the refresh');
});
test('a Mark read refused before it is sent shows its result in the inbox until the next action',async t=>{
 let current=notices(),gate=null;const calls=[];
 const c=await controller({fetchImpl:async(url,init)=>{calls.push({url,method:init.method});const wait=gate;gate=null;if(wait)await wait.promise;if(init.method==='POST'){const command=JSON.parse(init.body);current=markRead(current,command.payload.ids);return response(receipt(command,current));}return response(noticesV2(current));}});t.after(()=>c.dispose());
 const refused=/操作未完成|Not completed/;
 c.setIdentity(identity);await settle();assert.doesNotMatch(c.renderInbox(),refused);
 const read=held();gate=read;const reading=c.loadNotifications();await settle();
 await c.markNotificationsRead(['notice-1']);assert.equal(calls.filter(call=>call.method==='POST').length,0,'the Mark read was refused before it was sent');
 assert.match(c.renderInbox(),refused,'the refusal is shown in the inbox');
 read.open();await reading;assert.match(c.renderInbox(),refused,'the result stays after the running read ends');
 await c.markNotificationsRead(['notice-1']);const html=c.renderInbox();assert.doesNotMatch(html,refused,'the next action replaces it');assert.match(html,/data-notice-state="read"/);
});

// Selects the app language the way the language picker does (locale.mjs initLocale().set), on a throwaway page, so a view renders in that language.
async function selectAppLanguage(id){
 const keys=['document','MutationObserver','NodeFilter','localStorage'],prior=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
 const page=Object.assign(new EventTarget(),{body:{nodeType:1,querySelectorAll:()=>[]},documentElement:{dataset:{},style:{setProperty(){}}},createTreeWalker:()=>({nextNode:()=>null}),querySelector:()=>null,querySelectorAll:()=>[]});
 const values={document:page,MutationObserver:class{observe(){}disconnect(){}},NodeFilter:{SHOW_TEXT:4},localStorage:{getItem:()=>null,setItem(){}}};
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:values[key]});
 try{await initLocale().set(id);}finally{keys.forEach((key,i)=>prior[i]?Object.defineProperty(globalThis,key,prior[i]):delete globalThis[key]);}
 assert.equal(getLocale(),id);
}
const visibleText=html=>html.replace(/<[^>]+>/g,'\n').replace(/&(amp|lt|gt|quot|#39);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));
test('the account inbox and notification settings use the selected language, and inbox row times use its format',async t=>{
 const rows=[{id:'notice-risk',type:'risk',title:'BTC · 1h',body:'BTC 1h',source:'server-research',requestId:'research-request-2',createdAt:NOW,readAt:null,executionAuthority:'NONE'},{id:'notice-research',type:'research',title:'ETH · 4h',body:'ETH 4h',source:'server-research',requestId:'research-request-3',createdAt:NOW-3600000,readAt:NOW,executionAuthority:'NONE'}];
 const state={...notices(),inbox:rows,unreadCount:1,nextCursor:'next-page'};
 const ready=await controller({fetchImpl:async()=>response(noticesV2(state))});
 const unconfirmed=await controller({fetchImpl:async(url,init)=>{if(init.method==='POST')throw Error('unconfirmed');return response(noticesV2(state));}});
 const signedOut=await controller({fetchImpl:async()=>assert.fail('no read while signed out')});
 const upgrade=await controller({fetchImpl:async()=>assert.fail('no read before the sign-in update')});
 t.after(()=>{for(const c of [ready,unconfirmed,signedOut,upgrade])c.dispose();});
 ready.setIdentity(identity);await ready.loadNotifications();assert.equal(ready.snapshot().notifications.status,'ready');
 unconfirmed.setIdentity(identity);await unconfirmed.loadNotifications();await unconfirmed.markNotificationsRead(['notice-risk']);assert.equal(unconfirmed.snapshot().notifications.status,'unknown');
 upgrade.setIdentity({...identity,authVersion:1,permissionProfile:'research-v1'});assert.equal(upgrade.snapshot().identityStatus,'upgrade-required');
 const english=['Account data loaded','Unconfirmed. Check the original request.','Sign in to load account preferences and research notices.','Update sign-in to use your account workspace and inbox.','Update sign-in','Account notifications','Account inbox','Reload cloud','In-app notices','Risk alerts','Save notification preferences','External delivery','Not enabled','Showing the current page','Risk alert','Research notice','Read','Mark read','Mark this page read'];
 const before=getLocale(),times=new Map();
 try{
  for(const id of ['zh','en','ja','ko','vi','es','fr','ru']){
   await selectAppLanguage(id);
   const inbox=ready.renderInbox(),stamps=[...inbox.matchAll(/<time>([^<]*)<\/time>/g)].map(match=>match[1]);
   // Row times follow the selected app language (the tag the page's lang attribute carries), not the browser's own locale.
   assert.deepEqual(stamps,rows.map(row=>new Date(row.createdAt).toLocaleString(localeInfo(id).tag)),id);
   times.set(id,stamps[0]);
   if(id==='zh'||id==='en')continue;
   const pack=(await import(`./locales/${id}.mjs`)).default;
   const text=visibleText([inbox,ready.renderNotificationSettings(),unconfirmed.renderInbox(),signedOut.renderInbox(),signedOut.renderNotificationSettings(),upgrade.renderInbox()].join('\n'));
   for(const en of english){
    assert.doesNotMatch(text,new RegExp('(?<![\\p{L}])'+en.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\p{L}])','u'),id+': '+en);
    assert.ok(text.includes(pack[en]),id+': '+pack[en]);
   }
  }
 }finally{await selectAppLanguage(before);}
 assert.match(times.get('ja'),/^2027\/1\/15 /);
 assert.match(times.get('en'),/^1\/15\/2027, /);
 for(const id of ['zh','ja','ko','vi','es','fr','ru'])assert.notEqual(times.get(id),times.get('en'),id);
});

test('the account workspace view uses the selected language',async t=>{
 const cloud={...workspace(),drafts:[{id:'draft-1',strategyId:'S03',name:'BTC 1'}],selectedDraftId:'draft-1'};
 const local=()=>({preferences:structuredClone(cloud.preferences),drafts:structuredClone(cloud.drafts),selectedDraftId:cloud.selectedDraftId});
 const receipt=command=>({request:{schema:'private-ui-command-v1',domain:'workspace',requestId:command.requestId,status:'applied',baseRevision:command.baseRevision,revision:command.baseRevision+1,appliedAt:NOW},state:{...cloud,revision:command.baseRevision+1,updatedAt:NOW,preferences:command.preferences,drafts:command.drafts,selectedDraftId:command.selectedDraftId}});
 const fetchImpl=async(url,init)=>response(url.includes('/notifications/')?noticesV2():init.method==='POST'?receipt(JSON.parse(init.body)):cloud);
 const applied=await controller({fetchImpl,getWorkspaceInput:local,applyWorkspaceInput:()=>null});
 const saved=await controller({fetchImpl,getWorkspaceInput:local});
 const signedOut=await controller({fetchImpl:async()=>assert.fail('no read while signed out')});
 t.after(()=>{for(const c of [applied,saved,signedOut])c.dispose();});
 applied.setIdentity(identity);await applied.loadWorkspace();assert.equal(applied.snapshot().workspace.status,'ready');
 saved.setIdentity(identity);await saved.loadWorkspace();await saved.saveWorkspace();assert.equal(saved.snapshot().workspace.status,'ready');assert.equal(saved.snapshot().workspace.state.revision,1);
 const english=['Account workspace','Saved to this account','Applied on this device','Load cloud','Apply preferences','Save current preferences','Cloud draft directory','Account preferences applied; drafts sync as a name directory.'];
 const before=getLocale();
 try{
  for(const id of ['ja','ko','vi','es','fr','ru']){
   await selectAppLanguage(id);
   // The apply feedback is written in the language that is selected when the preferences are applied.
   await applied.applyWorkspace();
   const pack=(await import(`./locales/${id}.mjs`)).default;
   const text=visibleText([applied.renderWorkspace(),saved.renderWorkspace(),signedOut.renderWorkspace()].join('\n'));
   for(const en of english){
    assert.doesNotMatch(text,new RegExp('(?<![\\p{L}])'+en.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\p{L}])','u'),id+': '+en);
    assert.ok(text.includes(pack[en]),id+': '+pack[en]);
   }
  }
 }finally{await selectAppLanguage(before);}
});
