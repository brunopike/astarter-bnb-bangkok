import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchJobCoordinator} from './research-job-coordinator.mjs';
import {validateResearchEvidence} from './research-analysis-service.mjs';
import {candleRequest} from './trading-chart-data.mjs';
import {createPrivateUIController} from './private-ui-controller.mjs';

// Offline protocol fixtures and a minimal event DOM, following coordinator.test.
// No wallet, model, cloud service or draft adoption is invoked by this file.
const NOW=Date.UTC(2026,10,16,12),DAY=86400;
const OWNER='wallet:56:0x'+'a'.repeat(40),OTHER='wallet:56:0x'+'b'.repeat(40);
const identity=ownerRef=>({ownerRef,expiresAt:NOW+3*DAY*1000,authVersion:2,permissionProfile:'private-ui-v2'});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const memory=()=>({items:new Map(),getItem(key){return this.items.get(key)??null;},setItem(key,value){this.items.set(key,String(value));}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function emitter(){
 const listeners=new Map();
 return {addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type),emit:(type,event)=>listeners.get(type)?.(event)};
}
function report(requestId,symbol){
 const crypto=['BTC','ETH','SOL'].includes(symbol),query=candleRequest(crypto?{market:symbol+'/USDT',period:'1D'}:{market:symbol,period:'1D',profileId:'public-market',venueId:'yahoo'});
 const closedAt=Math.floor(NOW/1000/DAY)*DAY;
 const sources=validateResearchEvidence([{symbol,source:query.source||'Binance Spot',timezone:query.timezone||'UTC',unit:query.unit||'USDT',feedState:'snapshot',state:'ready',paused:false,x:1,y:55,price:100,change:1,closedAt,sampleAt:closedAt-DAY,validUntil:closedAt+DAY,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:299}],[symbol],NOW);
 return {requestId,state:'complete',createdAt:NOW,fresh:true,result:{method:'ai',model:'openai/gpt-4.1-mini',responseId:'offline-entry-'+symbol,usage:{inputTokens:10,outputTokens:10,totalTokens:20},billing:null,output:{outcome:'watch',headline:symbol+' report',summary:'Offline protocol fixture.',claims:[{text:symbol+' closed-market evidence.',evidenceIds:[sources[0].id]}]},sources,missingDimensions:['depth','macro','social','chain','risk'],createdAt:NOW,validUntil:sources[0].validUntil*1000,executionAuthority:'NONE',methodVersion:'closed-market-research-v1'}};
}
function researchDOM(jobs,symbol,onDraft){
 const events=[],view={...emitter(),location:{href:'https://astarter.imstark.site/?page=workbench'}},root={...emitter(),defaultView:view};
 const dialog={tagName:'DIALOG',dataset:{},open:true,isConnected:true,querySelectorAll:()=>[slot],querySelector:()=>slot,
  close(){events.push('close');this.open=false;root.emit('close',{target:this});events.push(jobs.snapshot(symbol).status);}};
 const slot={dataset:{liveResearch:symbol},ownerDocument:{activeElement:null},contains:()=>false,querySelector:()=>null,closest:()=>dialog,innerHTML:''};
 const button={dataset:{researchJobAction:'draft'},closest:selector=>selector==='[data-research-job-action]'?button:slot};
 root.contains=node=>node===slot||node===button;root.querySelectorAll=()=>[slot];root.querySelector=()=>null;
 jobs.bind(root,{onDraft:value=>{events.push('draft');onDraft(value);}});
 return {dialog,events,slot,click:()=>root.emit('click',{target:button})};
}
function researchFixture(t,{symbol='BTC',transform=value=>value,now=()=>NOW,fetchImpl}={}){
 const calls=[],opened=[];
 const jobs=createResearchJobCoordinator({storage:memory(),now,fetchImpl:async(url,init)=>{
  calls.push({url,method:init.method,body:init.body});
  if(fetchImpl)return fetchImpl(url,init);
  const input=JSON.parse(init.body);return response(transform(report(input.requestId,input.symbols[0])));
 }});
 t.after(()=>jobs.destroy());jobs.setIdentity(identity(OWNER));
 const ui=researchDOM(jobs,symbol,value=>opened.push(structuredClone(value)));
 return {jobs,calls,opened,ui};
}
const hasResearchDraft=html=>/<button\b[^>]*data-research-job-action="draft"/.test(html);

for(const symbol of ['BTC','ETH','SOL'])test('current complete '+symbol+' report captures its original draft source before closing leaves the research view',async t=>{
 const {jobs,calls,opened,ui}=researchFixture(t,{symbol});
 assert.equal(hasResearchDraft(jobs.render(symbol)),false);await jobs.start(symbol);
 const before=jobs.snapshot(symbol);assert.equal(before.status,'complete');assert.equal(before.result.executionAuthority,'NONE');
 assert.equal(hasResearchDraft(jobs.render(symbol)),true);assert.equal(hasResearchDraft(ui.slot.innerHTML),true);
 ui.click();
 assert.deepEqual(opened,[{draftId:before.requestId,sourceRequestId:before.requestId,symbol}]);
 assert.deepEqual(ui.events,['close','cancel-view','draft']);assert.equal(jobs.snapshot(symbol).result,null);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/research/analyze');assert.equal(calls[0].method,'POST');
 assert.deepEqual(JSON.parse(calls[0].body),{requestId:before.requestId,symbols:[symbol]});
});

for(const scenario of ['SPX','expired','unknown','incomplete'])test('research draft entry rejects '+scenario+' reports, including a stale draft-button click',async t=>{
 let at=NOW;const symbol=scenario==='SPX'?'SPX':'BTC';
 const options={symbol,now:()=>at};
 if(scenario==='unknown')options.fetchImpl=async()=>{throw Error('offline outcome unknown');};
 if(scenario==='incomplete')options.transform=value=>{delete value.result.usage;return value;};
 const {jobs,calls,opened,ui}=researchFixture(t,options);await jobs.start(symbol);
 if(scenario==='expired')at=jobs.snapshot(symbol).result.validUntil;
 assert.equal(jobs.snapshot(symbol).status,scenario==='SPX'?'complete':scenario==='expired'?'expired':'unknown');
 assert.equal(hasResearchDraft(jobs.render(symbol)),false);const count=calls.length;ui.click();
 assert.deepEqual(opened,[]);assert.deepEqual(ui.events,[]);assert.equal(calls.length,count);
});

test('another owner cannot open a completed or late old-owner research report from its old button',async t=>{
 const {jobs,calls,opened,ui}=researchFixture(t);await jobs.start('BTC');assert.equal(hasResearchDraft(jobs.render('BTC')),true);
 jobs.setIdentity(identity(OTHER));ui.click();assert.deepEqual(opened,[]);assert.equal(hasResearchDraft(jobs.render('BTC')),false);
 assert.equal(jobs.snapshot('BTC').result,null);assert.equal(calls.filter(call=>call.method==='POST').length,1);
 let release;const hold=new Promise(resolve=>{release=resolve;});
 const late=researchFixture(t,{fetchImpl:async(_url,init)=>{const input=JSON.parse(init.body);await hold;return response(report(input.requestId,'BTC'));}});
 const pending=late.jobs.start('BTC');await settle();late.jobs.setIdentity(identity(OTHER));release();await pending;late.ui.click();
 assert.deepEqual(late.opened,[]);assert.equal(late.jobs.snapshot('BTC').ownerRef,OTHER);assert.equal(late.jobs.snapshot('BTC').result,null);
 assert.equal(hasResearchDraft(late.jobs.render('BTC')),false);
});

const directory=(scope=OWNER,ids=['draft-a'])=>({schema:'private-workspace-v1',scope,revision:0,updatedAt:0,preferences:{workbenchFilter:'all',workbenchFocusAsset:null,watchedAssets:[]},drafts:ids.map(id=>({id,strategyId:'S01',name:'Offline '+id})),selectedDraftId:null,executionAuthority:'NONE'});
const notices=scope=>({schema:'private-notifications-v2',scope,revision:0,updatedAt:0,inapp:true,events:['risk','research'],services:Object.fromEntries(['telegram','email'].map(channel=>[channel,{available:false,error:'CHANNEL_DISABLED'}])),channels:Object.fromEntries(['telegram','email'].map(channel=>[channel,{channel,label:'',enabled:0,verified:0}])),deliveries:[],inbox:[],unreadCount:0,reminderUnreadCount:0,nextCursor:null,mode:'server-research-only'});
function controllerDOM(controller){
 const events=[],root={...emitter(),contains:()=>true,querySelector:()=>null};controller.bind(root);
 return {events,click(id){
  const dialog={close(){events.push('close');}},control={dataset:{privateAction:'draft-open',privateId:id},closest:selector=>selector==='[data-private-action]'?control:selector==='dialog'?dialog:null};
  root.emit('click',{target:control});
 }};
}
function accountFixture(t,{withCallback=true,fetchImpl}={}){
 const calls=[],opened=[];let scope=OWNER;
 const controller=createPrivateUIController({storage:memory(),now:()=>NOW,getWorkspaceInput:()=>{const {preferences,drafts,selectedDraftId}=directory(scope);return {preferences,drafts,selectedDraftId};},
  ...(withCallback?{onOpenDraft:id=>opened.push(id)}:{}),fetchImpl:async(url,init)=>{
   calls.push({url,method:init.method,body:init.body});
   if(fetchImpl)return fetchImpl(url,init,scope);
   return response(url.startsWith('/api/notifications/')?notices(scope):directory(scope));
  }});
 t.after(()=>controller.dispose());const ui=controllerDOM(controller);
 return {controller,calls,opened,ui,setOwner(ownerRef=OWNER,extra={}){scope=ownerRef;controller.setIdentity({...identity(ownerRef),...extra});}};
}

test('the v2 ready cloud directory opens only a currently listed draft without a draft API or write',async t=>{
 const {controller,calls,opened,ui,setOwner}=accountFixture(t);setOwner();await controller.loadWorkspace();
 assert.equal(controller.snapshot().identityStatus,'ready');assert.equal(controller.snapshot().workspace.status,'ready');
 assert.match(controller.renderWorkspace(),/data-private-action="draft-open" data-private-id="draft-a"/);
 ui.click('not-in-directory');assert.deepEqual(opened,[]);assert.deepEqual(ui.events,[]);
 const count=calls.length;ui.click('draft-a');assert.deepEqual(opened,['draft-a']);assert.deepEqual(ui.events,['close']);assert.equal(calls.length,count);
 assert.ok(calls.every(call=>call.method==='GET'));assert.equal(controller.snapshot().executionAuthority,'NONE');
});

test('the draft directory does not open for v1, future auth versions, a new owner or after leaving',async t=>{
 const {controller,opened,ui,setOwner}=accountFixture(t,{fetchImpl:async(url,_init,scope)=>response(url.startsWith('/api/notifications/')?notices(scope):directory(scope,[scope===OWNER?'draft-a':'draft-b']))});setOwner();await controller.loadWorkspace();
 for(const authVersion of [1,3]){
  setOwner(OWNER,{authVersion});ui.click('draft-a');assert.equal(controller.snapshot().identityStatus,'upgrade-required');assert.deepEqual(opened,[]);
 }
 setOwner();await controller.loadWorkspace();setOwner(OTHER);ui.click('draft-a');assert.equal(controller.snapshot().workspace.state,null);assert.deepEqual(opened,[]);
 await controller.loadWorkspace();assert.equal(controller.snapshot().workspace.status,'ready');assert.equal(controller.snapshot().workspace.state.scope,OTHER);assert.deepEqual(controller.snapshot().workspace.state.drafts.map(row=>row.id),['draft-b']);
 ui.click('draft-a');assert.deepEqual(opened,[]);
 controller.leave();ui.click('draft-a');assert.equal(controller.snapshot().identityStatus,'auth-required');assert.deepEqual(opened,[]);assert.deepEqual(ui.events,[]);
});

test('an unknown workspace save retains its directory but cannot open any draft or issue another request',async t=>{
 const {controller,calls,opened,ui,setOwner}=accountFixture(t,{fetchImpl:async(url,init,scope)=>{
  if(init.method==='POST')throw Error('offline commit outcome unknown');
  return response(url.startsWith('/api/notifications/')?notices(scope):directory(scope));
 }});
 setOwner();await controller.loadWorkspace();await controller.saveWorkspace();
 const value=controller.snapshot().workspace;assert.equal(value.status,'unknown');assert.ok(value.requestId);assert.equal(value.state.drafts[0].id,'draft-a');
 const count=calls.length;ui.click('draft-a');assert.deepEqual(opened,[]);assert.deepEqual(ui.events,[]);assert.equal(calls.length,count);
 assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(calls.at(-1).url,'/api/workspace/save');
});

test('without an injected open callback the existing cloud directory remains text with no draft-open button',async t=>{
 const {controller,calls,ui,setOwner}=accountFixture(t,{withCallback:false});setOwner();await controller.loadWorkspace();
 const html=controller.renderWorkspace();assert.match(html,/Offline draft-a/);assert.match(html,/S01/);assert.doesNotMatch(html,/data-private-action="draft-open"/);
 const count=calls.length;ui.click('draft-a');assert.deepEqual(ui.events,[]);assert.equal(calls.length,count);assert.equal(controller.snapshot().workspace.state.drafts.length,1);
});
