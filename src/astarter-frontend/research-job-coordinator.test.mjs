import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchJobCoordinator} from './research-job-coordinator.mjs';
import {validateResearchEvidence} from './research-analysis-service.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MarketResearch} from './live-research.mjs';

const NOW=Date.UTC(2026,10,16,12),DAY=86400,OWNER='wallet:56:0x'+'a'.repeat(40),OTHER='wallet:56:0x'+'b'.repeat(40);
const memory=()=>({items:new Map(),getItem(key){return this.items.get(key)??null;},setItem(key,value){this.items.set(key,value);}});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const failure=(error='UNCONFIGURED')=>response({ok:false,error,executionAuthority:'NONE'},503);
const pending=id=>response({requestId:id,state:'pending',createdAt:NOW,fresh:false},202);
function report(id,symbol){
 const closedAt=Math.floor(NOW/1000/DAY)*DAY;
 const sources=validateResearchEvidence([{symbol,source:'Binance Spot',timezone:'UTC',unit:'USDT',feedState:'snapshot',state:'ready',paused:false,x:1,y:55,price:100,change:1,closedAt,sampleAt:closedAt-DAY,validUntil:closedAt+DAY,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:299}],[symbol],NOW);
 return {requestId:id,state:'complete',createdAt:NOW,fresh:true,result:{method:'ai',model:'openai/gpt-4.1-mini',responseId:'offline-'+symbol,usage:{inputTokens:10,outputTokens:10,totalTokens:20},billing:null,output:{outcome:'watch',headline:symbol+' report',summary:'Offline protocol response.',claims:[{text:symbol+' market evidence.',evidenceIds:[sources[0].id]}]},sources,missingDimensions:['depth','macro','social','chain','risk'],createdAt:NOW,validUntil:sources[0].validUntil*1000,executionAuthority:'NONE',methodVersion:'closed-market-research-v1'}};
}
function create(t,options={}){
 const storage=options.storage||memory(),calls=[];
 const jobs=createResearchJobCoordinator({storage,now:()=>NOW,fetchImpl:async(url,init)=>{calls.push({url,method:init.method,body:init.body,signal:init.signal});return failure();},...options});
 jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});t.after(()=>jobs.destroy());return {jobs,storage,calls};
}

test('opening and rendering do not POST; explicit requests partition eight assets with the same owner',async t=>{
 const {jobs,storage,calls}=create(t);
 for(const symbol of ['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y']){
  jobs.render(symbol);await jobs.open(symbol);assert.equal(calls.length,storage.items.size);
  await jobs.start(symbol);const saved=JSON.parse([...storage.items.values()].at(-1));
  assert.equal(saved.ownerRef,OWNER);assert.deepEqual(saved.symbols,[symbol]);
 }
 assert.equal(calls.length,8);assert.equal(storage.items.size,8);
 assert.ok(calls.every(c=>c.method==='POST'&&Object.keys(JSON.parse(c.body)).sort().join(',')==='requestId,symbols'));
 assert.equal(new Set([...storage.items.values()].map(x=>JSON.parse(x).requestId)).size,8);
 for(const symbol of ['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'])assert.ok([...storage.items.keys()].some(key=>key.startsWith('astarter.research-asset.v1:'+symbol+':')));
});

test('separate reports remain on their own asset and never become a trade handoff or simulated credit usage',async t=>{
 const {jobs}=create(t,{fetchImpl:async(url,init)=>{const input=JSON.parse(init.body);return response(report(input.requestId,input.symbols[0]));}});
 const research=new MarketResearch(),workspace=new WorkspaceSim({research,researchJobs:jobs});
 const before=structuredClone({credits:workspace.s.credits,usage:workspace.s.usage,signals:workspace.s.signals,drafts:workspace.s.drafts});
 assert.equal(await workspace.requestResearch('BTC'),null);assert.equal(await workspace.requestPaidResearch('ETH'),null);
 assert.equal(jobs.snapshot('BTC').result.output.headline,'BTC report');assert.equal(jobs.snapshot('ETH').result.output.headline,'ETH report');
 assert.doesNotMatch(jobs.render('ETH'),/BTC report|BTC market evidence/);assert.match(jobs.render('ETH'),/ETH report/);
 assert.deepEqual({credits:workspace.s.credits,usage:workspace.s.usage,signals:workspace.s.signals,drafts:workspace.s.drafts},before);
 assert.equal(research.handoff('BTC'),null);assert.equal(research.handoff('ETH'),null);
});

test('resume restores the original ID with GET and leaves unknown results non-restartable',async t=>{
 const storage=memory(),first=create(t,{storage});await first.jobs.start('BTC');const id=first.jobs.snapshot('BTC').requestId;first.jobs.destroy();
 const calls=[],{jobs}=create(t,{storage,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return pending(id);}});
 assert.equal(calls.length,0);await jobs.open('BTC');assert.deepEqual(calls,[{url:'/api/research/requests/'+id,method:'GET'}]);
 await jobs.start('BTC');assert.equal(calls.length,1);assert.equal(jobs.snapshot('BTC').canStart,false);assert.equal(jobs.snapshot('BTC').requestId,id);
 jobs.leave('BTC');await jobs.open('BTC');assert.equal(calls[1].method,'GET');assert.equal(jobs.snapshot('BTC').requestId,id);
});

test('GET404 permits only explicit retry of the same request body, not a new ID',async t=>{
 const calls=[];let count=0;
 const {jobs}=create(t,{fetchImpl:async(url,init)=>{calls.push({url,method:init.method,body:init.body});if(init.method==='POST'){count++;throw Error('offline unknown');}return response({ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'},404);}});
 await jobs.start('BTC');const id=jobs.snapshot('BTC').requestId;await jobs.query('BTC');
 assert.equal(jobs.snapshot('BTC').canRetryOriginal,true);await jobs.start('BTC');assert.equal(count,1);
 assert.match(jobs.render('BTC'),/data-research-job-action="retry"/);await jobs.retry('BTC');
 assert.equal(count,2);assert.equal(calls[0].body,calls[2].body);assert.equal(jobs.snapshot('BTC').requestId,id);
});

test('an account switch while restoring cannot dispatch the old click against the new owner',async t=>{
 const storage=memory(),original=create(t,{storage});await original.jobs.start('BTC');original.jobs.destroy();
 let release,started;const seen=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{release=resolve;});const calls=[];
 const {jobs}=create(t,{storage,fetchImpl:async(url,init)=>{calls.push(init.method);started();await hold;return failure();}});
 const task=jobs.start('BTC');await seen;jobs.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});release();
 assert.equal((await task).status,'cancel-view');assert.deepEqual(calls,['GET']);assert.equal(jobs.snapshot('BTC').ownerRef,OTHER);assert.equal(jobs.snapshot('BTC').result,null);
});

test('leaving during POST aborts its view and ignores late results; reopening only queries',async t=>{
 let release,started;const hold=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{started=resolve;});const calls=[];
 const {jobs}=create(t,{fetchImpl:async(url,init)=>{calls.push({method:init.method,signal:init.signal});if(init.method==='GET')return failure();const input=JSON.parse(init.body);started();await hold;return response(report(input.requestId,'BTC'));}});
 const task=jobs.start('BTC');await seen;jobs.leave('BTC');assert.equal(calls[0].signal.aborted,true);release();await task;
 assert.equal(jobs.snapshot('BTC').result,null);assert.equal(jobs.snapshot('BTC').status,'cancel-view');await jobs.open('BTC');assert.equal(calls[1].method,'GET');
});

test('identity expiry and absent authentication cannot start a request',async t=>{
 let now=NOW;const {jobs,calls}=create(t,{now:()=>now});
 jobs.setIdentity(null);await jobs.start('BTC');assert.equal(calls.length,0);assert.equal(jobs.snapshot('BTC').status,'auth-required');
 jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+10});now+=11;await jobs.start('BTC');assert.equal(calls.length,0);assert.equal(jobs.snapshot('BTC').ownerRef,null);
});

test('a completed report emits its natural expiry without polling and disposes its timer with the owner',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const expires=report('expiry-report','BTC').result.validUntil;let now=expires-1000;const changes=[],calls=[];
 const {jobs}=create(t,{now:()=>now,onChange:(_symbol,value)=>changes.push(value.status),fetchImpl:async(_url,init)=>{calls.push(init.method);return response(report(JSON.parse(init.body).requestId,'BTC'));}});
 jobs.setIdentity({ownerRef:OWNER,expiresAt:now+60000});await jobs.start('BTC');assert.equal(changes.at(-1),'complete');
 now=expires;t.mock.timers.tick(1000);assert.equal(changes.at(-1),'expired');assert.deepEqual(calls,['POST']);
 jobs.setIdentity({ownerRef:OTHER,expiresAt:now+60000});const changed=changes.length;
 t.mock.timers.tick(1000);assert.equal(changes.length,changed);assert.equal(jobs.snapshot('BTC').result,null);
 jobs.destroy();t.mock.timers.tick(60000);assert.equal(changes.length,changed);assert.deepEqual(calls,['POST']);
});

test('copied BTC metadata cannot be queried or rendered as an ETH report',async t=>{
 const storage=memory(),first=create(t,{storage});await first.jobs.start('BTC');first.jobs.destroy();
 const [key,value]=[...storage.items.entries()][0];storage.setItem(key.replace(':BTC:',':ETH:'),value);
 const {jobs,calls}=create(t,{storage});await jobs.open('ETH');await jobs.start('ETH');await jobs.query('ETH');
 assert.equal(calls.length,0);assert.equal(jobs.snapshot('ETH').result,null);assert.equal(jobs.snapshot('ETH').canQuery,false);assert.equal(jobs.snapshot('ETH').canStart,false);
 assert.equal(jobs.snapshot('ETH').status,'service-unavailable');
});

test('locale changes repaint a visible job without new requests and remove the listener on destroy',async t=>{
 const {jobs,calls}=create(t),listeners=new Map();let paints=0;
 const slot={dataset:{liveResearch:'BTC'},ownerDocument:{activeElement:null},contains:()=>false,querySelector:()=>null,set innerHTML(value){assert.match(value,/research-job-card/);paints++;}};
 const root={querySelectorAll:()=>[slot],addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 jobs.bind(root);await jobs.open('BTC');jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000});
 const before=paints,state=jobs.snapshot('BTC');listeners.get('hive:locale')();
 assert.equal(paints,before+1);assert.deepEqual(jobs.snapshot('BTC'),state);assert.equal(calls.length,0);
 jobs.destroy();assert.equal(listeners.has('hive:locale'),false);
});

function walletView(jobs,{authenticate=()=>{},keepActive=()=>false}={}){
 const emitter=()=>{const listeners=new Map();return {addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key),emit:(key,event={})=>listeners.get(key)?.(event),listeners};};
 const view={...emitter(),location:{href:'https://astarter.imstark.site/?page=workbench'}},root={...emitter(),defaultView:view};
 let focuses=0,shows=0;
 const dialog={tagName:'DIALOG',dataset:{},open:true,isConnected:true,querySelectorAll:()=>[slot],querySelector:()=>slot,close(){this.open=false;root.emit('close',{target:this});},showModal(){this.open=true;shows++;}};
 const slot={dataset:{liveResearch:'ETH'},ownerDocument:{activeElement:null},contains:()=>false,querySelector:()=>null,focus(){focuses++;},closest:()=>dialog};
 const button={dataset:{researchJobAction:'authenticate'},closest:selector=>selector==='[data-research-job-action]'?button:slot};
 root.contains=()=>true;root.querySelectorAll=()=>[slot];root.querySelector=()=>null;
 jobs.bind(root,{authenticate,keepActive});
 return {root,view,dialog,slot,click:()=>root.emit('click',{target:button}),finish:error=>view.emit('astarter:wallet-flow-end',{detail:{error}}),shows:()=>shows,focuses:()=>focuses};
}

for(const retained of [false,true])test(`closing research retains its request only with a visible workbench consumer: ${retained}`,async t=>{
 let visible=retained,release,started,signal;const hold=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{started=resolve;}),calls=[];
 const {jobs}=create(t,{fetchImpl:async(url,init)=>{
  calls.push(init.method);
  if(init.method==='GET')return response(report(url.split('/').at(-1),'ETH'));
  const input=JSON.parse(init.body);signal=init.signal;started();await hold;return response(report(input.requestId,'ETH'));
 }});
 const ui=walletView(jobs,{keepActive:()=>visible}),request=jobs.start('ETH');await seen;
 const id=jobs.snapshot('ETH').requestId;ui.dialog.close();
 assert.equal(signal.aborted,!retained);assert.equal(jobs.snapshot('ETH').status,retained?'processing':'cancel-view');
 release();await request;assert.deepEqual(calls,['POST']);
 if(retained){
  assert.equal(jobs.snapshot('ETH').status,'complete');assert.equal(jobs.snapshot('ETH').result.output.headline,'ETH report');
  visible=false;ui.dialog.open=true;ui.dialog.close();assert.equal(jobs.snapshot('ETH').result,null);assert.equal(jobs.snapshot('ETH').status,'cancel-view');
  await jobs.open('ETH');assert.equal(jobs.snapshot('ETH').requestId,id);assert.equal(jobs.snapshot('ETH').status,'complete');assert.deepEqual(calls,['POST','GET']);
  jobs.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});assert.equal(jobs.snapshot('ETH').ownerRef,OTHER);assert.equal(jobs.snapshot('ETH').requestId,null);assert.equal(jobs.snapshot('ETH').result,null);
 }else assert.equal(jobs.snapshot('ETH').result,null);
});

test('wallet handoff releases the native modal and returns to the original ETH request using GET only',async t=>{
 const storage=memory(),original=create(t,{storage});await original.jobs.start('ETH');const id=original.jobs.snapshot('ETH').requestId;original.jobs.destroy();
 const {jobs,calls}=create(t,{storage});await jobs.open('ETH');calls.length=0;
 let opened=0;const ui=walletView(jobs,{authenticate(){opened++;assert.equal(ui.dialog.open,false);}});
 ui.click();assert.equal(opened,1);assert.equal(ui.dialog.open,false);assert.equal(calls.length,0);
 ui.finish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.dialog.open,true);assert.equal(ui.shows(),1);assert.equal(jobs.snapshot('ETH').requestId,id);
 assert.deepEqual(calls.map(c=>[c.method,c.url]),[['GET','/api/research/requests/'+id]]);
 ui.finish();assert.equal(ui.shows(),1);
});

test('wallet cancellation restores anonymous ETH without starting research or retaining lifecycle listeners',async t=>{
 const {jobs,calls}=create(t);jobs.setIdentity(null);const ui=walletView(jobs);await jobs.open('ETH');
 ui.click();assert.equal(ui.dialog.open,false);ui.finish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.dialog.open,true);assert.equal(ui.shows(),1);assert.equal(jobs.snapshot('ETH').status,'auth-required');assert.equal(calls.length,0);
 jobs.destroy();assert.equal(ui.view.listeners.has('astarter:wallet-flow-end'),false);assert.equal(ui.view.listeners.has('popstate'),false);
});

test('a departed route, another asset or an explicit leave prevents a late wallet close from reopening ETH',async t=>{
 for(const cancel of [(_,ui)=>{ui.view.location.href='https://astarter.imstark.site/?page=markets';},(_,ui)=>{ui.view.emit('popstate');},jobs=>jobs.open('BTC'),jobs=>jobs.leave(),(_,ui)=>{ui.dialog.isConnected=false;},(_,ui)=>{ui.root.querySelector=()=>({open:true});}]){
  const {jobs,calls}=create(t);const ui=walletView(jobs);await jobs.open('ETH');ui.click();
  await cancel(jobs,ui);
  ui.finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.dialog.open,false);assert.equal(ui.shows(),0);assert.equal(calls.length,0);
 }
});

test('a queued close event cannot cancel a study already restored after wallet completion',async t=>{
 const {jobs}=create(t),ui=walletView(jobs);await jobs.open('ETH');ui.click();ui.finish();
 ui.root.emit('close',{target:ui.dialog});assert.equal(ui.dialog.open,true);assert.notEqual(jobs.snapshot('ETH').status,'cancel-view');
});

test('failed sign-in returns a readable error to ETH while another account never queries the old request',async t=>{
 const {jobs,calls}=create(t);await jobs.start('ETH');const oldId=jobs.snapshot('ETH').requestId;const ui=walletView(jobs);
 ui.click();jobs.setIdentity(null);calls.length=0;ui.finish('service');
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(jobs.render('ETH'),/登录服务暂不可用|Sign-in is unavailable/);assert.equal(calls.length,0);
 ui.click();jobs.setIdentity({ownerRef:OTHER,expiresAt:NOW+60000});ui.finish();
 await new Promise(resolve=>setImmediate(resolve));
 assert.doesNotMatch(jobs.render('ETH'),/登录服务暂不可用|Sign-in is unavailable/);
 assert.equal(jobs.snapshot('ETH').ownerRef,OTHER);assert.notEqual(jobs.snapshot('ETH').requestId,oldId);assert.equal(calls.length,0);
});

test('an old flow end cannot consume the return context while a wallet portal is still open',async t=>{
 const {jobs,calls}=create(t),ui=walletView(jobs);await jobs.open('ETH');ui.click();
 let walletOpen=true;ui.root.querySelector=selector=>selector.includes('data-rk')&&walletOpen?{}:null;
 ui.finish('service');assert.equal(ui.dialog.open,false);assert.equal(ui.shows(),0);assert.equal(calls.length,0);
 walletOpen=false;ui.finish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.dialog.open,true);assert.equal(ui.shows(),1);assert.doesNotMatch(jobs.render('ETH'),/Sign-in is unavailable|登录服务暂不可用/);assert.equal(calls.length,0);
});

test('the mounted non-modal account popover does not block a completed wallet flow',async t=>{
 const {jobs,calls}=create(t),ui=walletView(jobs);await jobs.open('ETH');ui.click();
 ui.root.querySelector=selector=>selector.includes('data-rk')&&!selector.includes('aria-modal')?{popover:'auto'}:null;
 ui.finish();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.dialog.open,true);assert.equal(ui.shows(),1);assert.equal(calls.length,0);
});
