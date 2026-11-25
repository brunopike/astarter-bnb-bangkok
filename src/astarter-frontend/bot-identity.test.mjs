import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSim} from './workspace-sim.mjs';
import {commerceFixture} from './commerce-test-fixture.mjs';
import {normalizeConnections} from './connections.mjs?v=20261120c';
import {TradingAccess} from './trading-access.mjs?v=20261120c';
import {protectionConfig} from './strategy-protection.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const route={connectionId:'api-main',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''};
const stream={state:'LIVE',generation:1,scope:{accountId:'SIM-01',environment:'DEMO'}};
function bindAccess(workspace){
 const connections=normalizeConnections({exchange:true,data:true,ai:true,preferences:{exchange:{service:'binance',market:'spot',access:'trade'}},tradingAccounts:['api-main','api-other'].map(id=>({id,kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'})),preferredTradingConnection:'api-main'});
 const access=new TradingAccess(connections);
 for(const connectionId of ['api-main','api-other'])access.configure(connections,{section:'exchange',operation:'verify',connectionId});
 workspace.setTradingAccess(options=>access.status(stream,options),'bot-identity');
 return {access,connections};
}
function checkDraft(workspace,draft){
 assert.equal(workspace.saveDraft(draft.id,{...draft,market:'BTC/USDT',executionRoute:route,protection:protectionConfig('astarter')}),null);
 assert.ok(workspace.validateSetup().run);
 for(let i=0;i<30;i++)workspace.tick(.2);
 assert.equal(draft.status,'passed');
 draft.botLaunch={requestId:draft.id+':approved',status:'accepted'};
 return clone(draft);
}
const state=(workspace,account)=>JSON.stringify({workspace:workspace.s,account:account?.s});

test('an approved A keeps its identity after another B is saved and selected',async t=>{
 const {workspace:w,account}=await commerceFixture(t);bindAccess(w);
 const a=await w.createManagedDraft('S03'),approved=checkDraft(w,a);
 assert.equal(w.checkStart(approved),null);
 const b=await w.createManagedDraft('S03');
 assert.equal(w.saveDraft(b.id,{...b,market:'BTC/USDT',mode:'signal',executionRoute:{...route,connectionId:'api-other'}}),null);
 assert.equal(w.s.selectedDraftId,b.id);
 const before=state(w,account);
 assert.equal(w.checkStart(approved,{connectionId:'api-other'}),null);
 assert.equal(state(w,account),before);
 assert.deepEqual(a,approved);
 // An unrelated unfinished or invalid editor must not replace A's protection.
 b.protection={id:'invalid'};
 const invalidEditor=state(w,account);
 assert.equal(w.checkStart(approved),null);
 assert.equal(state(w,account),invalidEditor);
 assert.equal(account.spent,0);assert.equal(account.reserved,0);assert.equal(account.s.orders.length,0);
 assert.equal(w.s.trade,null);
});

test('a submitted snapshot cannot replace A version, binding, market or protection',()=>{
 const w=new WorkspaceSim();bindAccess(w);const approved=checkDraft(w,w.draft());
 const before=state(w);
 for(const replacement of [{id:'missing-draft'},{version:approved.version+1},{market:'ETH/USDT'},{executionRoute:{...route,connectionId:'api-other'}},{protection:protectionConfig('original')},{protection:protectionConfig('astarter','conservative')}])assert.ok(w.checkStart({...approved,...replacement}));
 assert.equal(state(w),before);
});

test('changes to the original A still invalidate its approved snapshot after selecting B',async t=>{
 for(const [name,patch] of [['version',{amount:150}],['connection',{executionRoute:{...route,connectionId:'api-other'}}],['market',{market:'ETH/USDT'}],['protection',{protection:protectionConfig('original')}]] )await t.test(name,async t=>{
  const {workspace:w,account}=await commerceFixture(t);bindAccess(w);
  const a=await w.createManagedDraft('S03'),approved=checkDraft(w,a),b=await w.createManagedDraft('S03');
  assert.equal(w.saveDraft(a.id,{...a,...patch}),null);
  w.s.selectedDraftId=b.id;
  const before=state(w,account);
  assert.ok(w.checkStart(approved));assert.equal(state(w,account),before);
 });
});

test('A cannot borrow B access or entitlement when its original binding is unavailable',async t=>{
 const {workspace:w,account}=await commerceFixture(t),{access,connections}=bindAccess(w);
 const a=await w.createManagedDraft('S03'),approved=checkDraft(w,a),b=await w.createManagedDraft('S03');
 assert.equal(w.saveDraft(b.id,{...b,market:'BTC/USDT',mode:'signal',executionRoute:{...route,connectionId:'api-other'}}),null);
 for(const action of ['expire-connection','disconnect-api','deny-api']){
  access.configure(connections,{section:'exchange',operation:'verify',connectionId:'api-main'});
  access.change(action,'Arbitrum','api-main');
  const before=state(w,account);
  assert.ok(w.checkStart(approved,{connectionId:'api-other',operation:'observe'}));
  assert.equal(state(w,account),before);
 }
 access.configure({...connections,tradingAccounts:connections.tradingAccounts.filter(r=>r.id!=='api-main')},'exchange');
 assert.ok(w.checkStart(approved,{connectionId:'api-other'}));
 access.configure(connections,{section:'exchange',operation:'verify',connectionId:'api-main'});
 await account.resource('strategy',a.resourceKey,true);
 const before=state(w,account);
 assert.match(w.checkStart(approved),/当前工作区/);
 assert.equal(state(w,account),before);
 assert.ok(account.s.resources.some(r=>r.key===b.resourceKey));
});

test('account protection, risk versions and local credit budgets still block A without side effects',()=>{
 const w=new WorkspaceSim();bindAccess(w);const approved=checkDraft(w,w.draft()),b=w.createDraft('S03');
 assert.equal(w.saveDraft(b.id,{...b,market:'BTC/USDT',executionRoute:{...route,connectionId:'api-other'}}),null);
 for(const [patch,pattern] of [[()=>w.s.trade={capitalProtection:{locked:'daily'},orders:[]},/账户资金保护/],[()=>w.s.risk.cap=100,/账户上限/],[()=>w.s.risk.version++,/风险版本/],[()=>w.s.credits=0,/积分/],[()=>w.s.budget.daily=0,/预算/]]){
  const risk=clone(w.s.risk),credits=w.s.credits,budget=clone(w.s.budget);
  patch();const before=state(w);
  assert.match(w.checkStart(approved),pattern);assert.equal(state(w),before);
  w.s.trade=null;w.s.risk=risk;w.s.credits=credits;w.s.budget=budget;
 }
});

test('legacy no-id checks keep the current selected draft contract',()=>{
 const w=new WorkspaceSim(),a=w.draft(),legacy={...a};delete legacy.id;
 assert.equal(w.checkStart(legacy),null);
 const b=w.createDraft('S03');
 assert.ok(w.checkStart(legacy));
 assert.ok(w.validate(b.id).run);for(let i=0;i<30;i++)w.tick(.2);
 assert.equal(w.checkStart(legacy),null);
 assert.equal(w.s.selectedDraftId,b.id);
});
