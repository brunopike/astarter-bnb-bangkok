import test from 'node:test';
import assert from 'node:assert/strict';
import * as notificationDecoders from './private-ui-data.mjs';
import {
 validatePrivateWorkspaceState,validatePrivateNotificationState,validatePrivateUICommandResult,
 validatePrivateUIWorkspaceInput,validatePrivateUINotificationCommand,
} from './private-ui-data.mjs';

const NOW=Date.UTC(2026,10,16,14),OWNER='wallet:56:0x'+'a'.repeat(40),OTHER='wallet:56:0x'+'b'.repeat(40),ID='private-command-0001';
const clone=value=>structuredClone(value);
const fail=(run,code)=>assert.throws(run,error=>error.code===code);
function fields(){return {preferences:{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC','coin:ethereum','ca:bsc:0x'+'a'.repeat(40)]},drafts:[{id:'draft-1',strategyId:'S03',name:'My strategy draft'}],selectedDraftId:'draft-1'};}
function workspaceInput(){return {requestId:ID,baseRevision:0,...fields()};}
function workspaceState(){return {schema:'private-workspace-v1',scope:OWNER,revision:1,updatedAt:NOW,...fields(),executionAuthority:'NONE'};}
function notificationInput(){return {requestId:ID,baseRevision:0,action:'save',payload:{events:['orders','risk','research'],enabled:{telegram:false,email:false},inapp:true}};}
function notificationState(){return {schema:'private-notifications-v1',scope:OWNER,revision:1,updatedAt:NOW,inapp:true,events:['orders','risk','research'],services:{telegram:{available:false,error:'CHANNEL_DISABLED'},email:{available:false,error:'CHANNEL_DISABLED'}},channels:{telegram:{channel:'telegram',label:'',enabled:0,verified:0},email:{channel:'email',label:'',enabled:0,verified:0}},deliveries:[],inbox:[{id:'notice-0001',type:'research',title:'Completed source-bound research',body:'Read the report',source:'server-research',requestId:'research-original-0001',createdAt:NOW-1000,readAt:null,executionAuthority:'NONE'}],unreadCount:1,nextCursor:null,mode:'server-research-only'};}
function receipt(domain='workspace'){return {request:{schema:'private-ui-command-v1',domain,requestId:ID,status:'applied',baseRevision:0,revision:1,appliedAt:NOW},state:domain==='workspace'?workspaceState():notificationState()};}

test('notification v2 is explicit, owner-bound and adds a global reminder count without changing v1 receipts',()=>{
 const v1=notificationState(),v2={...clone(v1),schema:'private-notifications-v2',reminderUnreadCount:1};
 assert.deepEqual(notificationDecoders.validatePrivateNotificationStateV2(v2,OWNER),v2);
 fail(()=>validatePrivateNotificationState(v2,OWNER),'PRIVATE_UI_PROTOCOL');
 fail(()=>notificationDecoders.validatePrivateNotificationStateV2(v1,OWNER),'PRIVATE_UI_PROTOCOL');
 fail(()=>notificationDecoders.validatePrivateNotificationStateV2(v2,OTHER),'PRIVATE_UI_PROTOCOL');
 const old=receipt('notifications');assert.deepEqual(validatePrivateUICommandResult(old,'notifications',ID,OWNER),old);
 fail(()=>validatePrivateUICommandResult({...old,state:v2},'notifications',ID,OWNER),'PRIVATE_UI_PROTOCOL');
 const partial={...v2,events:['risk'],unreadCount:10,reminderUnreadCount:7,nextCursor:'older_page'};
 assert.equal(notificationDecoders.validatePrivateNotificationStateV2(partial,OWNER).reminderUnreadCount,7,'the server count covers unread rows beyond this page');
 const muted={...partial,inapp:false,reminderUnreadCount:0};assert.equal(notificationDecoders.validatePrivateNotificationStateV2(muted,OWNER).inbox.length,1,'muting preserves history');
 for(const count of [-1,1.5,'1',11,Number.MAX_SAFE_INTEGER+1])fail(()=>notificationDecoders.validatePrivateNotificationStateV2({...partial,reminderUnreadCount:count},OWNER),'PRIVATE_UI_PROTOCOL');
 fail(()=>notificationDecoders.validatePrivateNotificationStateV2({...muted,reminderUnreadCount:1},OWNER),'PRIVATE_UI_PROTOCOL');
 fail(()=>notificationDecoders.validatePrivateNotificationStateV2({...partial,events:['orders'],reminderUnreadCount:1},OWNER),'PRIVATE_UI_PROTOCOL');
 fail(()=>notificationDecoders.validatePrivateNotificationStateV2({...v2,unreadCount:5,reminderUnreadCount:1,nextCursor:'older_page'},OWNER),'PRIVATE_UI_PROTOCOL');
});

test('workspace accepts only metadata and existing watch-key formats, returning an independent copy',()=>{
 const input=workspaceInput(),result=validatePrivateUIWorkspaceInput(input);assert.deepEqual(result,input);result.preferences.watchedAssets.push('SOL');result.drafts[0].name='Changed returned copy';
 assert.equal(input.preferences.watchedAssets.length,3);assert.equal(input.drafts[0].name,'My strategy draft');
 for(const key of ['SOL','coin:bitcoin','ca:ethereum:0x'+'c'.repeat(40),'ca:sui:0x'+'d'.repeat(64),'ca:solana:'+'1'.repeat(32)]){
  const value=workspaceInput();value.preferences.watchedAssets=[key];assert.equal(validatePrivateUIWorkspaceInput(value).preferences.watchedAssets[0],key);
 }
});

test('workspace rejects additional funds, credential and caller-owner fields at every allowed record level',()=>{
 for(const [key,value] of [['amount',100],['risk',{cap:1000}],['ledger',{cash:10000}],['executionAuthority','LIVE'],['authorization',true],['token','private'],['apiKey','private'],['ownerRef',OTHER],['scope',OTHER],['subjectId','other']]){
  const input=workspaceInput();input[key]=value;fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
 for(const container of ['preferences','draft'])for(const [key,value] of [['amount',100],['ownerRef',OTHER],['credentials',{token:'private'}]]){
  const input=workspaceInput();(container==='preferences'?input.preferences:input.drafts[0])[key]=value;fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
});

test('accessors, prototypes, hidden object fields, symbols and sparse lists are not valid workspace DTOs',()=>{
 let called=0;const accessor=workspaceInput();Object.defineProperty(accessor,'baseRevision',{enumerable:true,get(){called++;return 0;}});fail(()=>validatePrivateUIWorkspaceInput(accessor),'PRIVATE_REQUEST_INVALID');assert.equal(called,0);
 const nested=workspaceInput();Object.defineProperty(nested.preferences,'workbenchFilter',{enumerable:true,get(){called++;return 'tracked';}});fail(()=>validatePrivateUIWorkspaceInput(nested),'PRIVATE_REQUEST_INVALID');assert.equal(called,0);
 for(const alter of [
  input=>Object.setPrototypeOf(input,{inherited:true}),
  input=>Object.setPrototypeOf(input.preferences,null),
  input=>Object.defineProperty(input,'hidden',{value:'private',enumerable:false}),
  input=>Object.defineProperty(input,Symbol('private'),{value:1}),
  input=>{input.drafts=new Array(1);},
  input=>{input.preferences.watchedAssets=new Array(1);},
  input=>{input.drafts.extra='private';},
  input=>Object.defineProperty(input.drafts,'0',{get(){called++;return {id:'draft-1',strategyId:'S03',name:'Accessor'};},enumerable:true}),
 ]){const input=workspaceInput();alter(input);fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');}
 assert.equal(called,0);
});

test('workspace rejects invalid watch keys, duplicate keys, unknown strategies and missing selected drafts',()=>{
 for(const keys of [['BTC','BTC'],['coin:'],['coin:UPPERCASE'],['ca:bsc:0x123'],['ca:unknown chain:0x'+'a'.repeat(40)],['https://evil.example'],['\u0000']]){
  const input=workspaceInput();input.preferences.watchedAssets=keys;fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
 for(const alter of [input=>{input.drafts[0].strategyId='S-UNKNOWN';},input=>{input.drafts.push(clone(input.drafts[0]));},input=>{input.selectedDraftId='missing';},input=>{input.preferences.workbenchFocusAsset='lowercase';},input=>{input.preferences.workbenchFilter='private';}]){
  const input=workspaceInput();alter(input);fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
});

test('workspace bounds revisions, collection sizes and draft text without admitting execution fields',()=>{
 for(const revision of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])fail(()=>validatePrivateUIWorkspaceInput({...workspaceInput(),baseRevision:revision}),'PRIVATE_REQUEST_INVALID');
 for(const alter of [input=>{input.drafts=Array.from({length:51},(_,index)=>({id:'draft-'+index,strategyId:'S03',name:'Draft'}));input.selectedDraftId=null;},input=>{input.preferences.watchedAssets=Array.from({length:201},(_,index)=>'asset-'+index);},input=>{input.drafts[0].name='x'.repeat(121);},input=>{input.drafts[0].name='  ';},input=>{input.drafts[0].name='bad\nlabel';}]){
  const input=workspaceInput();alter(input);fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
});

test('notification commands canonicalize known event order while external channels remain disabled',()=>{
 const input=notificationInput();input.payload.events=['research','orders'];const result=validatePrivateUINotificationCommand(input);assert.deepEqual(result.payload.events,['orders','research']);assert.deepEqual(input.payload.events,['research','orders']);
 for(const alter of [value=>{value.payload.events=['risk','risk'];},value=>{value.payload.events=['transfers'];},value=>{value.payload.enabled.telegram=true;},value=>{value.payload.enabled.email=true;},value=>{value.payload.inapp=1;},value=>{value.action='event';},value=>{value.payload.recipient='private@example.test';},value=>{value.ownerRef=OTHER;}]){
  const input=notificationInput();alter(input);fail(()=>validatePrivateUINotificationCommand(input),'PRIVATE_REQUEST_INVALID');
 }
});

test('mark-read commands contain only a bounded unique nonempty list of notice identifiers',()=>{
 const value={requestId:ID,baseRevision:0,action:'mark-read',payload:{ids:['notice-0001','notice-0002']}};assert.deepEqual(validatePrivateUINotificationCommand(value),value);
 for(const ids of [[],['notice-0001','notice-0001'],['bad id'],Array.from({length:51},(_,index)=>'notice-'+index),new Array(1)])fail(()=>validatePrivateUINotificationCommand({...value,payload:{ids}}),'PRIVATE_REQUEST_INVALID');
 fail(()=>validatePrivateUINotificationCommand({...value,payload:{ids:['notice-0001'],source:'client'}}),'PRIVATE_REQUEST_INVALID');
});

test('workspace state scope is a compared label when supplied, never an authentication credential',()=>{
 assert.deepEqual(validatePrivateWorkspaceState(workspaceState(),OWNER),workspaceState());
 // Omitting the expected owner validates shape only. The server runtime must bind it.
 assert.equal(validatePrivateWorkspaceState({...workspaceState(),scope:OTHER}).scope,OTHER);
 fail(()=>validatePrivateWorkspaceState(workspaceState(),OTHER),'PRIVATE_UI_PROTOCOL');
 for(const alter of [value=>{value.executionAuthority='LIVE';},value=>{value.schema='local-sim-workspace';},value=>{value.updatedAt=-1;},value=>{value.scope=' ';},value=>{value.ownerRef=OWNER;}]){
  const value=workspaceState();alter(value);fail(()=>validatePrivateWorkspaceState(value,OWNER),'PRIVATE_UI_PROTOCOL');
 }
});

test('notification states require canonical unique events and a matching expected owner',()=>{
 assert.deepEqual(validatePrivateNotificationState(notificationState(),OWNER),notificationState());
 fail(()=>validatePrivateNotificationState(notificationState(),OTHER),'PRIVATE_UI_PROTOCOL');
 for(const events of [['research','orders'],['orders','orders'],['orders','unknown']])fail(()=>validatePrivateNotificationState({...notificationState(),events},OWNER),'PRIVATE_UI_PROTOCOL');
});

test('only server research inbox DTOs with NONE authority and consistent unread counts are admitted',()=>{
 for(const alter of [
  value=>{value.inbox[0].source='browser-simulation';},value=>{value.mode='simulation-only';},value=>{value.inbox[0].executionAuthority='LIVE';},
  value=>{value.inbox[0].requestId='short';},value=>{value.inbox[0].type='order';},value=>{value.inbox[0].readAt=NOW-2000;},
  value=>{value.unreadCount=0;},value=>{value.inbox.push(clone(value.inbox[0]));},value=>{value.inbox[0].ownerRef=OTHER;},
  value=>{value.channels.email.enabled=1;},value=>{value.deliveries=[{id:'notice-1',channel:'email',title:'Fixture',status:'invented',error:'',created:NOW,updated:NOW}];},
 ]){const value=notificationState();alter(value);fail(()=>validatePrivateNotificationState(value,OWNER),'PRIVATE_UI_PROTOCOL');}
});

test('applied command receipts bind domain, request ID, owner, revision and state time',()=>{
 for(const domain of ['workspace','notifications'])assert.deepEqual(validatePrivateUICommandResult(receipt(domain),domain,ID,OWNER),receipt(domain));
 for(const alter of [
  value=>{value.request.requestId='different-request';},value=>{value.request.domain='notifications';},value=>{value.request.status='pending';},
  value=>{value.request.revision=2;},value=>{value.request.baseRevision=2;},value=>{value.state.scope=OTHER;},value=>{value.state.updatedAt=NOW+1;},
  value=>{value.request.executionAuthority='LIVE';},value=>{value.state.ledger={cash:10000};},value=>{value.extra='private';},
 ]){const value=receipt();alter(value);fail(()=>validatePrivateUICommandResult(value,'workspace',ID,OWNER),'PRIVATE_UI_PROTOCOL');}
});

test('public input and output text rejects artificial credential shapes without using any real secret',()=>{
 const artificial=['Bearer offline_fixture_not_a_real_token_0001','sk-offline_fixture_not_a_real_key_0001','sk-proj-offline_fixture_not_a_real_key_0001','https://offline_user:offline_password@fixture.example/path','postgresql://offline_user:offline_password@fixture.example/test','0x'+'d'.repeat(64)];
 for(const secret of artificial){
  const input=workspaceInput();input.drafts[0].name=secret;fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
  const state=workspaceState();state.drafts[0].name=secret;fail(()=>validatePrivateWorkspaceState(state,OWNER),'PRIVATE_UI_PROTOCOL');
  for(const field of ['title','body']){
   const notice=notificationState();notice.inbox[0][field]=secret;fail(()=>validatePrivateNotificationState(notice,OWNER),'PRIVATE_UI_PROTOCOL');
  }
 }
});

test('validated ca watch keys keep legal 64-hex addresses while bare credential-shaped hex does not enter metadata',()=>{
 const legal='ca:sui:0x'+'e'.repeat(64),input=workspaceInput();input.preferences.watchedAssets=[legal];assert.deepEqual(validatePrivateUIWorkspaceInput(input).preferences.watchedAssets,[legal]);
 const state=workspaceState();state.preferences.watchedAssets=[legal];assert.deepEqual(validatePrivateWorkspaceState(state,OWNER).preferences.watchedAssets,[legal]);
 const bare=workspaceInput();bare.preferences.watchedAssets=['0x'+'e'.repeat(64)];fail(()=>validatePrivateUIWorkspaceInput(bare),'PRIVATE_REQUEST_INVALID');
});

test('focus supports arbitrary uppercase symbols up to 32 characters without assuming the initial eight assets',()=>{
 for(const focus of ['AAVE','ARB','PEPE','WBTC','ABC-USD','A'.repeat(32)]){
  const input=workspaceInput();input.preferences.workbenchFocusAsset=focus;assert.equal(validatePrivateUIWorkspaceInput(input).preferences.workbenchFocusAsset,focus);
  const state=workspaceState();state.preferences.workbenchFocusAsset=focus;assert.equal(validatePrivateWorkspaceState(state,OWNER).preferences.workbenchFocusAsset,focus);
 }
 for(const focus of ['', 'btc','A B','A'.repeat(33)]){
  const input=workspaceInput();input.preferences.workbenchFocusAsset=focus;fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
});

test('draft IDs use the shared 96-character metadata alphabet and selected IDs still bind exactly',()=>{
 for(const id of ['D','draft:S03_1-abc','D'.repeat(96)]){
  const input=workspaceInput();input.drafts[0].id=id;input.selectedDraftId=id;assert.equal(validatePrivateUIWorkspaceInput(input).selectedDraftId,id);
 }
 for(const id of ['draft.with.dot','draft@owner','D'.repeat(97),'bad id']){
  const input=workspaceInput();input.drafts[0].id=id;input.selectedDraftId=id;fail(()=>validatePrivateUIWorkspaceInput(input),'PRIVATE_REQUEST_INVALID');
 }
});

test('notice IDs use the shared 128-character alphabet and mark-read IDs are canonical sorted',()=>{
 const value={requestId:ID,baseRevision:0,action:'mark-read',payload:{ids:['z:0001','a.0001','M-0001']}};
 assert.deepEqual(validatePrivateUINotificationCommand(value).payload.ids,['M-0001','a.0001','z:0001']);assert.deepEqual(value.payload.ids,['z:0001','a.0001','M-0001']);
 for(const id of ['n','event:._-1','N'.repeat(128)]){
  const input={requestId:ID,baseRevision:0,action:'mark-read',payload:{ids:[id]}};assert.deepEqual(validatePrivateUINotificationCommand(input).payload.ids,[id]);
  const state=notificationState();state.inbox[0].id=id;assert.equal(validatePrivateNotificationState(state,OWNER).inbox[0].id,id);
 }
 for(const id of ['event@owner','N'.repeat(129),'bad id']){
  const input={requestId:ID,baseRevision:0,action:'mark-read',payload:{ids:[id]}};fail(()=>validatePrivateUINotificationCommand(input),'PRIVATE_REQUEST_INVALID');
  const state=notificationState();state.inbox[0].id=id;fail(()=>validatePrivateNotificationState(state,OWNER),'PRIVATE_UI_PROTOCOL');
 }
});

test('server inbox bodies are nonempty and bounded while opaque pagination cursors are URL-safe up to 512',()=>{
 for(const body of ['x','x'.repeat(1200)]){
  const state=notificationState();state.inbox[0].body=body;assert.equal(validatePrivateNotificationState(state,OWNER).inbox[0].body,body);
 }
 for(const body of ['', '   ','x'.repeat(1201)]){
  const state=notificationState();state.inbox[0].body=body;fail(()=>validatePrivateNotificationState(state,OWNER),'PRIVATE_UI_PROTOCOL');
 }
 for(const nextCursor of ['abc_123-XYZ','A'.repeat(512)])assert.equal(validatePrivateNotificationState({...notificationState(),nextCursor},OWNER).nextCursor,nextCursor);
 for(const nextCursor of ['', 'a:b','a.b','a+b','a/b','a=b','A'.repeat(513)])fail(()=>validatePrivateNotificationState({...notificationState(),nextCursor},OWNER),'PRIVATE_UI_PROTOCOL');
});
