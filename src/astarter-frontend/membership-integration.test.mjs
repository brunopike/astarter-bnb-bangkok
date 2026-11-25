import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MembershipAccount,MEMBERSHIP_KEY} from './membership-account.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch} from './multi-research.mjs';
import {commerceFixture} from './commerce-test-fixture.mjs';
import {DAY} from './commerce-catalog.mjs';
test('P0.3 local archive remains untouched and is not imported as funds',async t=>{const values=new Map([[MEMBERSHIP_KEY,JSON.stringify({version:3,lots:[{remaining:99999}],orders:[],tasks:[]})]]),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},before=values.get(MEMBERSHIP_KEY);const {account}=await commerceFixture(t,{storage});assert.equal(account.available,600);assert.equal(account.legacy.lots[0].remaining,99999);assert.equal(values.get(MEMBERSHIP_KEY),before);});
test('server purchases, workspace research and history share one actual-cost settlement',async t=>{const {account,workspace,advance,buy}=await commerceFixture(t);await buy();assert.equal(account.available,12600);assert.equal(workspace.quote(8),184);assert.equal(await workspace.requestResearch('ETH'),null);assert.equal(workspace.reserved,184);await advance(1001);workspace.tick(.1);assert.equal(workspace.spent,81);assert.equal(workspace.reserved,0);assert.equal(account.available,12519);assert.equal(workspace.s.usage[0].settled,81);assert.match(account.s.tasks[0].artifact.title,/ETH/);});
test('rule checks and protection stay free at zero credits and zero automatic budget',async t=>{const {account,workspace,store}=await commerceFixture(t);store.run('UPDATE lots SET remaining=0');await account.refresh();assert.equal(workspace.quote(20),0);assert.equal(workspace.quote(4),0);assert.equal(workspace.quote(16),0);assert.throws(()=>workspace.quote(999),/unsupported-workflow/);assert.equal(workspace.checkStart(workspace.draft()),null);const {run}=workspace.validate('D-S03');for(let i=0;i<30;i++)workspace.tick(.2);assert.equal(run.status,'passed');assert.equal(account.spent,0);});
test('browser reconstruction does not cancel a server task or release its hold',async t=>{const {account,workspace,advance}=await commerceFixture(t);await workspace.requestResearch('ETH');const raw=JSON.stringify(workspace.s),storage={getItem:k=>k==='hive.workspace.sim.v1'?raw:null,setItem(){}};const next=new WorkspaceSim({storage,research:new MultiResearch(),account});assert.equal(account.reserved,204);assert.equal(next.s.usage[0].status,'reserved');await advance(1001);next.tick(.1);assert.equal(next.s.usage[0].settled,90);});
test('a new explicit research request after completion creates a new quoted job',async t=>{const {account,workspace,advance}=await commerceFixture(t);await workspace.requestResearch('ETH');const first=workspace.s.usage[0];await advance(1001);workspace.tick(.1);await workspace.requestResearch('ETH');assert.notEqual(workspace.s.usage[0].membershipTaskId,first.membershipTaskId);assert.equal(account.reserved,204);assert.equal(account.spent,90);});
test('workbench and usage-page tasks share capacity and available funds',async t=>{const {account,workspace,store}=await commerceFixture(t);const job=await account.runTask({profile:'Q1'});assert.match(await workspace.requestResearch('ETH'),/任务处理中/);await account.cancel(job.id);store.run('UPDATE lots SET remaining=100');await account.refresh();assert.match(await workspace.requestResearch('ETH'),/不足/);assert.equal(account.reserved,0);});
test('BYOK resource selection replaces the old blanket discount',async t=>{const {account,workspace,advance}=await commerceFixture(t);account.getPayers=()=>({model:'own',data:'official'});workspace.getAIConfiguration=()=>({source:'custom',agentModels:{}});assert.equal(workspace.quote(8),29);const job=await account.runTask({profile:'R1',payers:account.getPayers()});await advance(1001);assert.equal(account.s.tasks.find(j=>j.id===job.id).settled,11);assert.equal(account.spent,11);});
test('manual research does not consume automatic budget',async t=>{const {account,workspace,advance,buy}=await commerceFixture(t);await buy();await account.setBudget({daily:20,single:20,enabled:true});const q=await account.command('quote',{profile:'A1',mode:'auto'});await account.command('job-start',{quote:q.id});await advance(1001);await workspace.requestResearch('ETH');await advance(1001);workspace.tick(.1);assert.equal(account.budget.spent,6);assert.equal(account.spent,87);});
test('topup shortcut cannot create credits and malformed legacy storage is preserved',async t=>{const {account,workspace}=await commerceFixture(t,{storage:{getItem:()=>'{invalid',setItem(){assert.fail('legacy must not be overwritten');}}});assert.match(workspace.topup(),/充值页/);assert.equal(account.available,600);assert.equal(account.legacyError,true);});
test('membership expiry preserves purchased credits and does not enable automatic work',async t=>{const {account,buy,advance}=await commerceFixture(t);await buy('starter');const o=await account.command('order-create',{kind:'topup',dollars:10});await account.command('order-pay',{id:o.id});await account.setBudget({daily:100,single:100,enabled:true});await advance(31*DAY);assert.equal(account.s.plan,'free');assert.equal(account.available,10000);assert.equal(account.s.preferences.autoEnabled,false);});
test('explicit cancellation releases the exact hold, late reads never settle it',async t=>{const {account,workspace,advance}=await commerceFixture(t);await workspace.requestResearch('ETH');await account.cancel(workspace.s.usage[0].membershipTaskId);await advance(10000);workspace.tick(.1);assert.equal(account.available,600);assert.equal(account.spent,0);assert.equal(workspace.s.usage[0].released,204);});
test('five billing routes use main shell and do not expose store or tests',()=>{const p=readFileSync(new URL('./product.js',import.meta.url),'utf8'),s=readFileSync(new URL('./public-assets.mjs',import.meta.url),'utf8');assert.match(p,/membership\.render\(page\)/);assert.ok(s.includes("'commerce-catalog.mjs'"));assert.ok(!s.includes("allowed.add('commerce-store.mjs')"));assert.ok(!s.includes("'commerce.test.mjs'"));});
test('tracking and saved strategies enforce one server quota across frontend callers',async t=>{const {account,workspace}=await commerceFixture(t);for(let i=0;i<10;i++)assert.equal(await workspace.toggleTracked('asset'+i),null);assert.match(await workspace.toggleTracked('overflow'),/上限/);assert.equal(account.s.resources.length,10);await workspace.toggleTracked('asset0');assert.equal(await workspace.toggleTracked('replacement'),null);assert.ok(await workspace.createManagedDraft('S03'));assert.ok(await workspace.createManagedDraft('S03'));assert.equal(await workspace.createManagedDraft('S03'),null);});
test('older GET response cannot overwrite a successful payment snapshot',async t=>{const {account,fetchImpl}=await commerceFixture(t);let release;account.fetch=async(path,init)=>{if(path.endsWith('/state')){const response=await fetchImpl(path,init);await new Promise(r=>release=r);return response;}return fetchImpl(path,init);};const stale=account.refresh();await new Promise(r=>setImmediate(r));const order=await account.command('order-create',{kind:'topup',dollars:10});await account.command('order-pay',{id:order.id});release();await stale;assert.equal(account.available,10600);});
test('an obsolete workspace selection cannot replace the account default ledger',async t=>{const fixture=await commerceFixture(t),storage={getItem:k=>k==='astarter.preview.workspace'?'stale-scope':null,removeItem(){assert.fail('old data must be preserved');}};const account=new MembershipAccount({storage,fetchImpl:fixture.fetchImpl});await account.ready;t.after(()=>account.destroy());assert.equal(account.available,600);assert.equal(account.scope,fixture.account.scope);});
test('same-asset double click opens only one quotation while confirmation is pending',async t=>{const {account,workspace}=await commerceFixture(t);let release,calls=0;account.runTask=async()=>{calls++;return new Promise(r=>release=r);};const first=workspace.requestResearch('ETH');assert.match(await workspace.requestResearch('ETH'),/待确认报价/);assert.equal(calls,1);release(null);assert.match(await first,/已取消/);assert.equal(workspace.pendingResearch.size,0);});
test('account entry preserves old team records while opening the default personal ledger',async t=>{const f=await commerceFixture(t),personal=f.account.scope,team=await f.account.command('team-create'),storage={getItem:k=>k===MEMBERSHIP_KEY?'{broken':k==='astarter.preview.workspace'?team.id:null};const account=new MembershipAccount({storage,fetchImpl:f.fetchImpl});await account.ready;t.after(()=>account.destroy());assert.equal(account.scope,personal);assert.equal(account.available,600);assert.equal(account.legacyError,true);assert.ok(account.s.scopes.some(scope=>scope.id===team.id));await account.switchScope(team.id);assert.equal(account.available,0);});


test('account tracking removes stored aliases and retains all unrelated resources',async t=>{
 const {account,workspace}=await commerceFixture(t),ca='ca:ethereum:0x'+'a'.repeat(40);
 for(const key of ['coin:bitcoin','BTC','coin:other-btc',ca,'ETH'])await account.resource('asset',key);
 await account.resource('strategy','saved-plan');const balance=account.available;
 assert.equal(await workspace.toggleTracked('BTC'),null);
 assert.deepEqual(workspace.s.aiSignalWatch.toSorted(),['coin:other-btc',ca,'ETH'].toSorted());
 await account.refresh();assert.deepEqual(workspace.s.aiSignalWatch.toSorted(),['coin:other-btc',ca,'ETH'].toSorted());
 assert.ok(account.s.resources.some(r=>r.kind==='strategy'&&r.key==='saved-plan'));
 assert.equal(account.available,balance);
});
test('a failed alias removal keeps the confirmed server state and can be retried',async t=>{
 const {account,workspace}=await commerceFixture(t);
 for(const key of ['coin:bitcoin','BTC','ETH'])await account.resource('asset',key);
 const resource=account.resource.bind(account);let removed=0;
 account.resource=async(kind,key,remove)=>{if(remove&&++removed===2)throw Error('resource unavailable');return resource(kind,key,remove);};
 assert.equal(await workspace.toggleTracked('BTC'),'resource unavailable');
 assert.equal(workspace.s.aiSignalWatch.filter(key=>['BTC','coin:bitcoin'].includes(key)).length,1);
 assert.ok(workspace.s.aiSignalWatch.includes('ETH'));
 account.resource=resource;assert.equal(await workspace.toggleTracked('BTC'),null);
 assert.deepEqual(workspace.s.aiSignalWatch,['ETH']);
});
test('switching accounts during alias removal never deletes a resource in the new account',async t=>{
 const {account,workspace}=await commerceFixture(t),personal=account.scope,team=await account.command('team-create');
 await account.switchScope(team.id);await account.resource('asset','BTC');await account.switchScope(personal);
 for(const key of ['coin:bitcoin','BTC'])await account.resource('asset',key);
 const resource=account.resource.bind(account);let removed=0;
 account.resource=async(kind,key,remove)=>{const result=await resource(kind,key,remove);if(remove&&++removed===1)await account.switchScope(team.id);return result;};
 assert.match(await workspace.toggleTracked('BTC'),/账户.*更新/);
 assert.equal(removed,1);assert.equal(account.scope,team.id);assert.deepEqual(workspace.s.aiSignalWatch,['BTC']);
 account.resource=resource;await account.switchScope(personal);assert.equal(workspace.s.aiSignalWatch.length,1);
});

function browserAccount(t,reply){
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const browser=new EventTarget(),doc={visibilityState:'visible'},reads=[];
 const priorWindow=globalThis.window,priorDocument=globalThis.document;
 globalThis.window=browser;globalThis.document=doc;
 const account=new MembershipAccount({fetchImpl:async(path,options)=>{
  assert.equal(path,'/api/commerce/state');
  const scope=options.headers['X-Workspace-Id']||'personal';reads.push(scope);
  return reply(scope);
 }});
 t.after(()=>{
  account.destroy();
  if(priorWindow===undefined)delete globalThis.window;else globalThis.window=priorWindow;
  if(priorDocument===undefined)delete globalThis.document;else globalThis.document=priorDocument;
 });
 const tick=async ms=>{t.mock.timers.tick(ms);await new Promise(resolve=>setImmediate(resolve));};
 return {account,reads,tick,browser,doc};
}
const unavailable=()=>Response.json({error:'service-unavailable'},{status:503});
const snapshot=(scope,tasks=[])=>Response.json({state:{scope,tasks}});

test('state polling backs off after 503, caps at one minute, and resets after recovery',async t=>{
 let healthy=false;
 const {account,reads,tick}=browserAccount(t,scope=>healthy?snapshot(scope):unavailable());
 assert.equal(await account.ready,null);
 for(const delay of [8000,16000,32000,60000,60000]){
  const count=reads.length;
  await tick(delay-1);assert.equal(reads.length,count);
  await tick(1);assert.equal(reads.length,count+1);
 }
 healthy=true;
 await account.refresh();assert.equal(reads.length,7);assert.equal(account.error,'');
 await tick(3999);assert.equal(reads.length,7);
 await tick(1);assert.equal(reads.length,8);
});

test('scope selection bypasses backoff while slow reads and hidden tabs avoid duplicate polls',async t=>{
 let next=()=>unavailable(),release;
 const {account,reads,tick,browser,doc}=browserAccount(t,scope=>next(scope));
 await account.ready;
 next=scope=>new Promise(resolve=>{release=()=>resolve(snapshot(scope,[{status:'reserved'}]));});
 const switching=account.switchScope('team');await tick(0);
 assert.deepEqual(reads,['personal','team']);
 doc.visibilityState='hidden';browser.dispatchEvent(new Event('focus'));
 await tick(20000);assert.equal(reads.length,2);
 release();await switching;
 next=scope=>snapshot(scope);
 await tick(4000);assert.deepEqual(reads,['personal','team','team']);
 await tick(4000);assert.equal(reads.length,3);
 doc.visibilityState='visible';
 next=scope=>new Promise(resolve=>{release=()=>resolve(snapshot(scope));});
 await tick(4000);assert.equal(reads.length,4);
 await tick(8000);assert.equal(reads.length,4);
 account.destroy();release();await tick(0);
 browser.dispatchEvent(new Event('focus'));await tick(60000);assert.equal(reads.length,4);
});

test('an old poll failure cannot put a newer workspace snapshot into backoff',async t=>{
 let reply=snapshot,finish;
 const {account,reads,tick}=browserAccount(t,scope=>reply(scope));
 await account.ready;
 reply=()=>new Promise(resolve=>{finish=resolve;});
 await tick(4000);
 reply=snapshot;
 await account.switchScope('team');assert.deepEqual(reads,['personal','personal','team']);
 finish(unavailable());await tick(0);
 assert.equal(account.error,'');assert.equal(account.s.scope,'team');
 await tick(4000);assert.deepEqual(reads,['personal','personal','team','team']);
});
