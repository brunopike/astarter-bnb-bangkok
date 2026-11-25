import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSim} from './workspace-sim.mjs';
import {botParameters} from './bot-runtime.mjs';
import {protectionConfig} from './strategy-protection.mjs';
import {setupFingerprint,DEFAULT_CONTEXT} from './platform-context.mjs';

const route={profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'legacy-exchange',chainId:''};
function plan(w,strategy='S01'){
 const d=w.createDraft(strategy);
 const values={amount:100,cap:500,mode:'auto',planVariant:strategy+'-SIM',market:'BTC/USDT',executionRoute:route,protection:protectionConfig('original'),botParameters:botParameters(strategy)};
 assert.equal(w.saveDraft(d.id,values),null);return d;
}
test('explicit paper versions check for free and keep every approved parameter',()=>{
 const w=new WorkspaceSim(),d=plan(w),credits=w.s.credits;
 const result=w.validateSetup();assert.equal(result.error,undefined);assert.equal(result.run.kind,'bot-configuration');
 assert.ok(w.setupReady);assert.equal(w.checkStart(structuredClone(d)),null);
 assert.equal(w.s.credits,credits);assert.equal(w.s.usage.length,0);assert.equal(d.botParameters.count,4);
});
test('parameter edits invalidate approval and old snapshots cannot start',()=>{
 const w=new WorkspaceSim(),d=plan(w);w.validateSetup();const old=structuredClone(d),version=d.version;
 assert.equal(w.saveDraft(d.id,{...d,botParameters:{...d.botParameters,count:3}}),null);
 assert.equal(d.version,version+1);assert.equal(w.setupReady,null);assert.ok(w.checkStart(old));
});
test('saving a second draft does not change the identity of an already checked plan',()=>{
 const w=new WorkspaceSim(),a=plan(w);w.validateSetup();const approved=structuredClone(a);plan(w,'S02');
 assert.equal(w.checkStart(approved),null);
 assert.ok(w.checkStart({...approved,botParameters:{...approved.botParameters,count:3}}));
});
test('native validation rejects insufficient full-plan funding without creating a run',()=>{
 const w=new WorkspaceSim(),d=plan(w),before=structuredClone(d);
 assert.match(w.saveDraft(d.id,{...d,botParameters:{...d.botParameters,count:10}}),/额度/);
 assert.deepEqual(d,before);assert.equal(w.s.trade,null);
});
test('fee-negative grid edits and restored draft prechecks cannot advance approval',()=>{
 const w=new WorkspaceSim(),d=plan(w);assert.ok(w.validateSetup().run);
 const before=structuredClone(d),credits=w.s.credits,parameters={lower:100000,upper:100010,count:2,spacing:'arithmetic'};
 assert.match(w.saveDraft(d.id,{...d,botParameters:parameters}),/手续费/);assert.deepEqual(d,before);
 d.botParameters=parameters;
 assert.match(w.validateSetup().error,/手续费/);assert.match(w.checkStart(structuredClone(d)),/手续费/);
 assert.equal(w.s.trade,null);assert.equal(w.s.credits,credits);
});
test('a connected BSC wallet grid is saved on that wallet and cannot start a paper run',()=>{
 const w=new WorkspaceSim(),d=w.createDraft('S01');
 const address='0x1111111111111111111111111111111111111111';
 const executionRoute={accountId:address,connectionId:'wallet-bsc',venueId:'pancakeswap',profileId:'dex-spot',chainId:'56'};
 const before=structuredClone(w.s.trade);
 assert.equal(w.saveDraft(d.id,{amount:25,cap:120,mode:'auto',market:'BTC/USDT',executionRoute,planVariant:'S01-SIM',protection:protectionConfig('original'),botParameters:botParameters('S01',60000)}),null);
 assert.equal(d.executionRoute.connectionId,'wallet-bsc');assert.equal(d.executionRoute.accountId,address);assert.equal(d.executionRoute.chainId,'56');
 assert.match(w.validateSetup().error,/SIM-01/);assert.match(w.checkStart(structuredClone(d)),/尚未适配执行|SIM-01/);
 assert.deepEqual(w.s.trade,before);
});
test('frozen research baselines remain research only',()=>{
 const w=new WorkspaceSim(),d=w.createDraft('S01');
 assert.equal(w.saveDraft(d.id,{...d,market:'BTC/USDT',executionRoute:route,protection:protectionConfig('original')}),null);
 assert.ok(w.validateSetup().error);assert.notEqual(d.planVariant,'S01-SIM');
});
test('changed access and expired configuration block paper approval',()=>{
 const w=new WorkspaceSim(),d=plan(w);w.setTradingAccess(()=>({ready:true}),'one');w.validateSetup();
 const approved=structuredClone(d);w.setTradingAccess(()=>({ready:true}),'two');assert.ok(w.checkStart(approved));
 w.validateSetup();w.s.clock+=301;assert.ok(w.checkStart(structuredClone(d)));
});
test('a saved-strategy quota failure preserves drafts and returns the actual reason',async()=>{
 const account={s:{resources:[]},resource:async()=>{throw Error('Saved strategy limit reached');}};
 const w=new WorkspaceSim({account}),before=structuredClone(w.s.drafts);
 assert.equal(await w.createManagedDraft('S02'),null);
 assert.equal(w.draftSaveError,'Saved strategy limit reached');assert.deepEqual(w.s.drafts,before);
});

test('simulation references save with exact precision, restore unchanged and reject mismatched routes or time order',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)},w=new WorkspaceSim({storage}),d=plan(w,'S02');
 const reference={market:d.market,profileId:route.profileId,venueId:route.venueId,period:'1H',closedPrice:75747.987654,closedAt:1000,asOf:2000},expected=structuredClone(reference);
 assert.equal(w.saveDraft(d.id,{...d,simulationReference:reference}),null);reference.closedPrice=1;assert.deepEqual(d.simulationReference,expected);
 const before=JSON.stringify(d);
 for(const patch of [{market:'ETH/USDT'},{venueId:'okx'},{profileId:'dex-spot'},{period:'bogus'},{closedPrice:'75747.987654'},{closedPrice:Infinity},{closedAt:2001},{asOf:NaN},{state:'live'}]){
  assert.ok(w.saveDraft(d.id,{...d,simulationReference:{...expected,...patch}}));assert.equal(JSON.stringify(d),before);
 }
 assert.ok(w.saveDraft(d.id,{...d,executionRoute:{...route,accountId:'SIM-02'}}));assert.equal(JSON.stringify(d),before);
 w.persist();const restored=new WorkspaceSim({storage});assert.deepEqual(restored.draft(d.id).simulationReference,expected);assert.equal(JSON.stringify(restored.draft(d.id)),before);
 assert.equal(restored.validateSetup().error,undefined);assert.equal(restored.checkStart(structuredClone(restored.draft(d.id))),null);
});

test('reference edits invalidate approval even without a version edit, while legacy configuration hashes stay identical',()=>{
 const w=new WorkspaceSim(),d=plan(w,'S02'),s=w.s;
 const legacy=JSON.stringify([s.setupContext||DEFAULT_CONTEXT,s.scope,d.id,d.version,s.risk.version,s.budget.daily,s.budget.byok,d.protection||null,s.accessRevision||null,d.market||null,d.planVariant||'baseline',d.executionRoute||null,d.botParameters||null]);
 assert.equal(setupFingerprint(s),legacy);assert.equal(Object.hasOwn(d,'simulationReference'),false);
 const reference={market:d.market,profileId:route.profileId,venueId:route.venueId,period:'1H',closedPrice:75747.987654,closedAt:1000,asOf:2000};
 assert.equal(w.saveDraft(d.id,{...d,simulationReference:reference}),null);w.validateSetup();const approved=structuredClone(d),version=d.version;
 assert.ok(w.checkStart({...approved,simulationReference:{...reference,closedPrice:reference.closedPrice+1}}));
 assert.equal(w.saveDraft(d.id,{...d,simulationReference:{...reference,asOf:2001}}),null);assert.equal(d.version,version+1);assert.equal(w.setupReady,null);assert.ok(w.checkStart(approved));
 w.validateSetup();d.simulationReference.closedPrice+=1;assert.equal(w.setupReady,null);assert.ok(w.checkStart(structuredClone(d)));
});

test('changing a draft instrument can explicitly clear its old reference without changing legacy serialization',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)},w=new WorkspaceSim({storage}),d=plan(w,'S02');
 const legacy=JSON.stringify(d);w.persist();assert.equal(JSON.stringify(new WorkspaceSim({storage}).draft(d.id)),legacy);
 assert.equal(w.saveDraft(d.id,{...d,simulationReference:{market:d.market,profileId:route.profileId,venueId:route.venueId,period:'1H',closedPrice:75747.987654,closedAt:1000,asOf:2000}}),null);w.validateSetup();
 assert.equal(w.saveDraft(d.id,{...d,market:'ETH/USDT',simulationReference:undefined}),null);assert.equal(Object.hasOwn(d,'simulationReference'),false);assert.equal(w.setupReady,null);assert.equal(d.market,'ETH/USDT');
});
