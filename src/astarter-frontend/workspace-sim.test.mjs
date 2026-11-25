import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSim,WORKSPACE_KEY,WORKBENCH_TARGETS_KEY,createPrivateWatchAccountAdapter} from './workspace-sim.mjs';
import {MultiResearch} from './multi-research.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
const advance=(w,n=5)=>{for(let t=0;t<n;t+=.1)w.tick(.1);};
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};};
test('watch terminal receipts persist on only their original draft and request',()=>{
 const saved=storage(),w=new WorkspaceSim({storage:saved}),d=w.draft();d.executionRoute={connectionId:'api-main',accountId:'SIM-01'};d.botLaunch={requestId:'request-1',status:'accepted'};
 const receipt={requestId:'request-1',draftId:d.id,version:d.version,connectionId:'api-main',accountId:'SIM-01',status:'stopped',armed:false};
 const tick=discovery=>w.tick(0,{orders:[],signalHistory:[],discovery});
 for(const patch of [{requestId:'request-2'},{version:d.version+1},{connectionId:'other'},{accountId:'SIM-02'},{status:'unknown'}]){tick({...receipt,...patch});assert.equal(d.botLaunch.receipt,undefined);}
 tick(receipt);w.persist();receipt.status='watching';assert.equal(d.botLaunch.receipt.status,'stopped');
 const restored=new WorkspaceSim({storage:saved});assert.equal(restored.draft(d.id).botLaunch.receipt.status,'stopped');assert.equal(w.s.usage.length,0);assert.equal(w.s.trade.orders.length,0);
});
test('a finished run keeps its exact result after another run replaces the current session',()=>{
 const saved=storage(),w=new WorkspaceSim({storage:saved}),d=w.draft();
 d.executionRoute={connectionId:'api-main',accountId:'SIM-01'};d.botLaunch={requestId:'request-1',status:'started'};
 const session={id:'SIM-OLD',requestId:'request-1',draftId:d.id,strategyVersion:d.version,connectionId:'api-main',accountId:'SIM-01'};
 const discovery={...session,version:d.version,status:'started',armed:false};
 const tick=patch=>w.tick(0,{orders:[],signalHistory:[],discovery,session,state:'stopped',...patch});
 tick({position:{qty:1}});assert.equal(d.botLaunch.receipt.status,'started');
 tick({pending:{status:'unknown'}});assert.equal(d.botLaunch.receipt.status,'started');
 tick({});assert.equal(d.botLaunch.receipt.status,'stopped');assert.equal(d.botLaunch.receipt.runId,'SIM-OLD');
 tick({session:{...session,id:'SIM-NEW',requestId:'request-2'},state:'running'});
 assert.equal(d.botLaunch.receipt.status,'stopped');assert.equal(d.botLaunch.receipt.runId,'SIM-OLD');
 w.persist();assert.equal(new WorkspaceSim({storage:saved}).draft(d.id).botLaunch.receipt.status,'stopped');
 assert.equal(w.s.usage.length,0);assert.equal(w.s.trade.orders.length,0);
});
test('credit reservation, settlement and cancellation reconcile without duplicate debit',()=>{const w=new WorkspaceSim(),u=w.reserve('策略流程演练',20,'D-1').usage;assert.equal(w.available,980);assert.equal(w.s.credits,1000);assert.equal(w.settle(u.id,16),true);assert.equal(w.available,984);assert.equal(u.released,4);assert.equal(w.settle(u.id,16),false);const q=w.reserve('x',8,'r').usage;w.cancelUsage(q.id);assert.equal(w.reserved,0);assert.equal(w.available,984);assert.equal(w.spent,16);});
test('insufficient balance and budget reject without creating tasks or charges',()=>{const w=new WorkspaceSim();w.setBudget({daily:0});assert.match(w.validate('D-S03').error,/预算/);assert.equal(w.s.validations.length,0);assert.equal(w.s.usage.length,0);w.setBudget({daily:200});w.s.credits=2;assert.match(w.checkStart(w.draft()),/积分/);assert.match(w.reserve('test',8,'x').error,/积分/);});
test('validation freezes exact strategy and risk versions, and changed drafts lose authority',()=>{const w=new WorkspaceSim(),d=w.createDraft('S03');assert.ok(w.checkStart(d));w.validate(d.id);assert.match(w.validate(d.id).error,/重复/);assert.match(w.saveDraft(d.id,{...d,amount:150}),/等待/);advance(w);assert.equal(d.status,'passed');assert.equal(w.checkStart(d),null);w.saveDraft(d.id,{...d,amount:150});assert.equal(d.version,2);assert.ok(w.checkStart(d));w.validate(d.id);advance(w);assert.equal(w.checkStart(d),null);w.setRisk({cap:800,dailyLoss:80});assert.ok(w.checkStart(d));});
test('missing-data and cancelled rehearsals release unspent reserves and cannot start',()=>{const w=new WorkspaceSim(),d=w.createDraft('S03');w.validate(d.id,'missing');advance(w);assert.equal(d.status,'blocked');assert.equal(w.spent,4);assert.equal(w.s.usage[0].released,16);const {run}=w.validate(d.id);w.cancelValidation(run.id);advance(w);assert.equal(w.available,996);assert.equal(d.status,'draft');assert.ok(w.checkStart(d));});
test('BYOK quote locks per task, and specialized strategy never gains spot execution authority',()=>{const w=new WorkspaceSim(),d=w.createDraft('S09-L');w.setBudget({daily:200,byok:true});const {run}=w.validate(d.id);assert.equal(w.s.usage[0].reserved,16);w.setBudget({daily:200,byok:false});advance(w);assert.equal(w.s.usage[0].settled,13);assert.match(w.checkStart(d),/专用执行/);assert.equal(run.status,'passed');});
test('research supersession releases the old paid task and scope gates unsupported assets',()=>{const r=new MultiResearch(),w=new WorkspaceSim({research:r});assert.equal(w.requestResearch('ETH'),null);assert.match(w.requestResearch('ETH'),/已有/);r.recheck('ETH');w.tick(.1);assert.equal(w.spent,0);assert.equal(w.reserved,0);w.setScope('crypto');assert.match(w.requestResearch('XAU'),/范围/);assert.equal(r.groups.filter(g=>g.task).length,3);r.advance(100);assert.equal(r.handoff('XAU'),null);});
test('persisted work restores documents and releases interrupted jobs without spending again',()=>{const s=storage(),r=new MultiResearch(),w=new WorkspaceSim({storage:s,research:r}),d=w.createDraft('RX01');w.validate(d.id);const copy=new WorkspaceSim({storage:s,research:new MultiResearch()});assert.equal(copy.available,1000);assert.equal(copy.draft().status,'draft');assert.equal(copy.s.validations[0].status,'cancelled');assert.equal(copy.research.tasks.length,8);});
test('one execution ledger carries strategy, signal, order and credit ids through partial fills and refresh',()=>{const w=new WorkspaceSim(),ctx={ready:true,market:'BTC/USDT',revision:'REGISTERED-S03-LEDGER',price:100},d={...w.draft(),market:ctx.market},e=new TradingDemo();assert.equal(w.checkStart(d),null);assert.equal(e.start(d,DEFAULT_CONNECTIONS,ctx),null);w.started(e.session);for(let i=0;i<50;i++)e.tick(.1,ctx);assert.ok(e.signal);w.tick(.1,{...e});const id=e.signal.id;assert.equal(e.submit(),null);assert.ok(e.submit());for(let i=0;i<14;i++)e.tick(.1,ctx);assert.equal(e.pending.status,'partial');assert.equal(e.orders[0].signalId,id);assert.equal(e.session.usageId,w.s.usage[0].id);const saved=JSON.parse(JSON.stringify(e)),restored=new TradingDemo();restored.restore(saved);assert.equal(restored.state,'paused');assert.equal(restored.cash,e.cash);assert.equal(restored.position.qty,e.position.qty);restored.cancel();assert.equal(restored.pending,null);assert.equal(restored.orders[0].status,'partial-cancelled');assert.equal(w.spent,4);w.s.credits=0;assert.equal(restored.closePosition(),null);for(let i=0;i<30;i++)restored.tick(.1,{ready:false});assert.equal(restored.position,null);assert.ok(Math.abs(restored.equity-(10000-restored.totalFees))<1e-6);});
test('signal-only notifications and stale signal expiry never fabricate an order',()=>{for(const mode of ['signal','confirm']){const e=new TradingDemo();e.start({market:'BTC/USDT',strategy:'S03',amount:100,cap:500,mode},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'v1'});for(let i=0;i<510;i++)e.tick(.1);assert.equal(e.orders.length,0);assert.equal(e.cash,10000);if(mode==='signal')assert.equal(e.signalHistory.length,3);else assert.equal(e.signal,null);}});
test('invalid settlement cannot create credit and an excluded research task releases its reserve',()=>{const r=new MultiResearch(),w=new WorkspaceSim({research:r});const u=w.reserve('x',20,'r').usage;assert.equal(w.settle(u.id,-3),false);assert.equal(w.settle(u.id,NaN),false);assert.equal(w.s.credits,1000);w.cancelUsage(u.id);w.requestResearch('ETH');w.setScope('tradfi');assert.equal(w.reserved,0);assert.equal(w.spent,0);assert.equal(r.summary().total,5);});
test('invalid saved draft selection falls back to a usable initial simulation',()=>{const s=storage();s.setItem(WORKSPACE_KEY,JSON.stringify({schema:1,credits:100,drafts:[],usage:[],validations:[],risk:{},budget:{}}));const w=new WorkspaceSim({storage:s});assert.equal(w.draft().strategy,'S03');assert.equal(w.available,1000);});
test('unknown execution receipt retains the intent until reconciliation and never fabricates zero fill',()=>{const e=new TradingDemo();e.orderScenario='unknown';e.start({market:'BTC/USDT',strategy:'S03',amount:100,cap:500,mode:'confirm'},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'v1'});for(let i=0;i<45;i++)e.tick(.1);e.submit();for(let i=0;i<30;i++)e.tick(.1);assert.equal(e.pending.status,'unknown');assert.equal(e.state,'blocked');assert.match(e.cancel(),/对账/);assert.match(e.stop(),/对账/);assert.equal(e.orders.length,1);assert.equal(e.cash,10000);assert.match(e.reconcile(),/仍待核对/);e.deliverReceipt();assert.equal(e.reconcile(),null);e.tick(.1);assert.equal(e.pending.status,'partial');e.cancel();assert.equal(e.orders[0].status,'partial-cancelled');assert.ok(e.position.qty>0);});
test('venue rejection is a distinct receipt, pauses fresh risk and changes no cash or inventory',()=>{const e=new TradingDemo();e.orderScenario='rejected';e.start({market:'BTC/USDT',strategy:'S03',amount:100,cap:500,mode:'auto'},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'v1'});for(let i=0;i<90;i++)e.tick(.1);assert.equal(e.orders[0].status,'rejected');assert.equal(e.pending,null);assert.equal(e.position,null);assert.equal(e.state,'paused');assert.equal(e.cash,10000);});

test('account or access change cancels a pending startup check and releases its exact reservation',()=>{
 const w=new WorkspaceSim(),before=w.available;let ready=true;
 const access=()=>({ready,code:ready?'ready':'read-only'});
 w.setTradingAccess(access,'access-1');const {run}=w.validateSetup();assert.ok(run);assert.equal(w.reserved,20);
 ready=false;w.setTradingAccess(access,'access-2');
 assert.equal(run.status,'cancelled');assert.equal(w.reserved,0);assert.equal(w.available,before);assert.equal(w.spent,0);assert.equal(w.setupReady,null);
 const count=w.s.usage.length;assert.ok(w.validateSetup().error);assert.equal(w.s.usage.length,count);assert.equal(w.available,before);
 assert.ok(w.checkStart(w.draft()));
 ready=true;w.setTradingAccess(access,'access-3');assert.equal(w.setupReady,null);assert.ok(w.validateSetup().run);
});

test('research locks per-agent model versions and invalid assignments cannot reserve credits',()=>{
 let ai={source:'custom',agents:{A01:{model:'user/market',version:'v2'},A13:{model:'user/decision',version:'v5'}}};
 const research=new MultiResearch(),w=new WorkspaceSim({research,getAIConfiguration:()=>ai});
 assert.equal(w.requestResearch('ETH'),null);const usage=w.s.usage[0],task=research.task('ETH');
 assert.equal(usage.modelPlan.assignments.A01.version,'v2');assert.equal(task.modelPlan.assignments.A13.version,'v5');assert.equal(task.modelPlanVersion,task.version);
 ai.agents.A01.version='v3';assert.equal(usage.modelPlan.assignments.A01.version,'v2');assert.equal(task.modelPlan.assignments.A01.version,'v2');
 w.cancelUsage(usage.id);const balance=w.available,entries=w.s.usage.length;ai.agents.A13.version='';assert.match(w.requestResearch('BTC'),/A13/);assert.equal(w.available,balance);assert.equal(w.s.usage.length,entries);
});

test('bound BOT checks use the saved connection and reject a replaced plan without spending',()=>{
 const w=new WorkspaceSim(),d=w.draft(),route={connectionId:'api-main',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''};
 assert.equal(w.saveDraft(d.id,{...d,market:'BTC/USDT',executionRoute:route}),null);
 assert.equal(d.executionRoute.connectionId,'api-main');
 const calls=[];w.setTradingAccess(options=>{calls.push(options);return {ready:true,code:'ready'};},'bound-1');
 assert.ok(w.validateSetup({connectionId:'api-other'}).run);advance(w);
 assert.equal(calls.at(-1).connectionId,'api-main');
 const approved=JSON.parse(JSON.stringify(d)),count=w.s.usage.length;
 assert.equal(w.checkStart(approved,{connectionId:'api-other'}),null);
 assert.deepEqual(calls.at(-1),{connectionId:'api-main',profileId:'cex-spot',operation:'entry'});
 for(const replacement of [{id:'another-draft'},{version:d.version+1},{market:'ETH/USDT'},{executionRoute:{...route,connectionId:'api-other'}}])assert.ok(w.checkStart({...approved,...replacement}));
 assert.equal(w.s.usage.length,count);
 assert.equal(w.saveDraft(d.id,{...d,executionRoute:{...route,connectionId:'api-other'}}),null);
 assert.equal(d.version,approved.version+1);assert.equal(d.validatedVersion,null);assert.equal(w.setupReady,null);assert.ok(w.checkStart(approved));
});

test('missing or expired bound access cannot borrow a caller connection or create validation charges',()=>{
 const w=new WorkspaceSim(),d=w.draft();Object.assign(d,{market:'BTC/USDT',executionRoute:{connectionId:'api-removed',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''}});
 w.setTradingAccess(options=>({ready:options.connectionId==='api-other',code:'connection-missing'}),'removed');
 const balance=w.available,uses=w.s.usage.length;
 assert.ok(w.validateSetup({connectionId:'api-other'}).error);assert.ok(w.checkStart(d,{connectionId:'api-other'}));
 assert.equal(w.available,balance);assert.equal(w.s.usage.length,uses);
 w.setTradingAccess(()=>({ready:false,code:'connection-expired'}),'expired');assert.ok(w.validateSetup().error);assert.equal(w.s.usage.length,uses);
});

test('a running strategy keeps its approved binding when the editor or selected draft changes',()=>{
 const w=new WorkspaceSim(),approved={...w.draft(),market:'BTC/USDT',executionRoute:{connectionId:'api-main',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''},botLaunch:{requestId:'D-S03:v1:1'}};
 const other=w.createDraft('S03');Object.assign(other,{executionRoute:{...approved.executionRoute,connectionId:'api-other'}});
 const session={id:'SIM-BINDING',market:approved.market};w.started(session,approved);
 assert.equal(session.draftId,approved.id);assert.equal(session.connectionId,'api-main');assert.equal(session.accountId,'SIM-01');assert.equal(session.requestId,'D-S03:v1:1');
 approved.executionRoute.connectionId='changed';assert.equal(session.executionRoute.connectionId,'api-main');
});


test('tracking toggles remove registered aliases without merging lookalike or contract assets',async()=>{
 const saved=storage(),w=new WorkspaceSim({storage:saved});
 const ca='ca:ethereum:0x'+'a'.repeat(40),other='ca:base:0x'+'a'.repeat(40);
 w.s.aiSignalWatch=['coin:bitcoin','BTC','coin:other-btc',ca,other,'ETH'];
 const before=JSON.stringify({drafts:w.s.drafts,trade:w.s.trade,usage:w.s.usage,credits:w.s.credits});
 assert.equal(await w.toggleTracked('BTC'),null);
 assert.deepEqual(w.s.aiSignalWatch,['coin:other-btc',ca,other,'ETH']);
 assert.deepEqual(new WorkspaceSim({storage:saved}).s.aiSignalWatch,w.s.aiSignalWatch);
 assert.equal(await w.toggleTracked(ca),null);
 assert.deepEqual(w.s.aiSignalWatch,['coin:other-btc',other,'ETH']);
 assert.equal(await w.toggleTracked('coin:bitcoin'),null);
 assert.equal(await w.toggleTracked('BTC'),null);
 assert.deepEqual(w.s.aiSignalWatch,['coin:other-btc',other,'ETH']);
 for(const key of ['',null,'coin:','ca:ethereum:bad'])assert.ok(await w.toggleTracked(key));
 assert.deepEqual(w.s.aiSignalWatch,['coin:other-btc',other,'ETH']);
 assert.equal(JSON.stringify({drafts:w.s.drafts,trade:w.s.trade,usage:w.s.usage,credits:w.s.credits}),before);
});
test('tracking storage failure restores saved keys and reports that the change was not saved',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},w=new WorkspaceSim({storage});
 w.s.aiSignalWatch=['coin:bitcoin','ETH'];w.touch();const before=new Map(values);
 storage.setItem=(key,value)=>{if(key==='hive.dc.assets'&&value==='["ETH"]')throw Error('storage blocked');values.set(key,value);};
 assert.match(await w.toggleTracked('BTC'),/保存/);
 assert.equal(values.get('hive.workbench.targets.v1'),before.get('hive.workbench.targets.v1'));
 assert.equal(values.get('hive.dc.assets'),before.get('hive.dc.assets'));
 assert.deepEqual(new WorkspaceSim({storage}).s.aiSignalWatch,['coin:bitcoin','ETH']);
});

test('explicit target focus survives older workspace snapshots and shares the independent target key',()=>{
 const saved=storage(),first=new WorkspaceSim({storage:saved}),second=new WorkspaceSim({storage:saved});
 const old=JSON.stringify(first.s);first.s.aiSignalWatch=['ETH'];
 assert.equal(first.setWorkbenchTargets({filter:'tracked',focusAsset:'ETH'}),null);
 assert.equal(second.s.workbenchFocusAsset,'ETH');assert.equal(second.s.workbenchFilter,'tracked');
 saved.setItem(WORKSPACE_KEY,old);
 const restored=new WorkspaceSim({storage:saved});
 assert.equal(restored.s.workbenchFocusAsset,'ETH');assert.deepEqual(restored.s.aiSignalWatch,['ETH']);
 second.s.workbenchFocusAsset=null;
 assert.equal(first.s.workbenchFocusAsset,null);assert.equal(new WorkspaceSim({storage:saved}).s.workbenchFocusAsset,null);
});

test('legacy target keys migrate to no explicit focus and account resources remain authoritative',()=>{
 const saved=storage(),legacy=JSON.parse(JSON.stringify(new WorkspaceSim().s));legacy.workbenchFocusAsset='BTC';
 saved.setItem(WORKSPACE_KEY,JSON.stringify(legacy));saved.setItem(WORKBENCH_TARGETS_KEY,JSON.stringify({watched:['BTC'],filter:'scan'}));
 assert.equal(new WorkspaceSim({storage:saved}).s.workbenchFocusAsset,null);
 for(const value of [{symbol:'BTC'},'coin:bitcoin','btc','<BTC>']){
  saved.setItem(WORKBENCH_TARGETS_KEY,JSON.stringify({watched:['BTC'],filter:'scan',focusAsset:value}));
  assert.equal(new WorkspaceSim({storage:saved}).s.workbenchFocusAsset,null);
 }
 saved.setItem(WORKBENCH_TARGETS_KEY,JSON.stringify({watched:['BTC'],filter:'tracked',focusAsset:'ETH'}));
 const account={s:{resources:[{kind:'asset',key:'ETH'},{kind:'strategy',key:'S01'}],preferences:{autoBudget:200,byok:false}},available:100,reserved:0};
 const before=JSON.stringify(account.s),w=new WorkspaceSim({storage:saved,account});
 assert.equal(w.s.workbenchFocusAsset,'ETH');assert.equal(w.s.workbenchFilter,'tracked');assert.deepEqual(w.s.aiSignalWatch,['ETH']);
 assert.equal(w.setWorkbenchTargets({focusAsset:null}),null);
 assert.equal(JSON.stringify(account.s),before);assert.deepEqual(w.s.aiSignalWatch,['ETH']);
 assert.equal(JSON.parse(saved.getItem(WORKBENCH_TARGETS_KEY)).focusAsset,null);
});

test('private UI targets are an owner-scoped preference overlay and never allocate membership resources',async()=>{
 let allocations=0;const account={scope:'local-member',s:{resources:[{kind:'asset',key:'ETH'}],preferences:{autoBudget:200,byok:false}},available:100,reserved:0,resource(){allocations++;throw Error('must not allocate');}};
 const w=new WorkspaceSim({account});w.persist();const before=JSON.stringify(account.s),ledger=JSON.stringify({risk:w.s.risk,trade:w.s.trade,drafts:w.s.drafts,credits:w.s.credits});
 w.setPrivateUIOwner('wallet:A');assert.deepEqual(w.s.aiSignalWatch,[]);
 assert.equal(w.applyPrivateUIPreferences('wallet:A',{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC']}),null);
 assert.equal(await w.toggleTracked('SOL'),null);assert.deepEqual(w.s.aiSignalWatch,['BTC','SOL']);assert.equal(allocations,0);assert.equal(JSON.stringify(account.s),before);
 assert.equal(JSON.stringify({risk:w.s.risk,trade:w.s.trade,drafts:w.s.drafts,credits:w.s.credits}),ledger);
});

test('changing or leaving a private owner cannot inherit the previous cloud target list',()=>{
 const w=new WorkspaceSim();w.s.aiSignalWatch=['ETH'];w.s.workbenchFilter='scan';
 w.setPrivateUIOwner('wallet:A');w.applyPrivateUIPreferences('wallet:A',{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC']});
 w.setPrivateUIOwner('wallet:B');assert.deepEqual(w.s.aiSignalWatch,[]);assert.equal(w.s.workbenchFilter,'all');assert.equal(w.s.workbenchFocusAsset,null);
 assert.ok(w.applyPrivateUIPreferences('wallet:A',{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC']}));assert.deepEqual(w.s.aiSignalWatch,[]);
 w.setPrivateUIOwner(null);assert.deepEqual(w.s.aiSignalWatch,['ETH']);assert.equal(w.s.workbenchFilter,'scan');
});

test('private preference mutations and full workspace persistence cannot leak into local target storage',async()=>{
 const saved=storage(),w=new WorkspaceSim({storage:saved});w.s.aiSignalWatch=['ETH'];w.s.workbenchFilter='scan';w.s.workbenchFocusAsset='ETH';w.persist();
 const targets=saved.getItem(WORKBENCH_TARGETS_KEY),assets=saved.getItem('hive.dc.assets'),originalWorkspace=saved.getItem(WORKSPACE_KEY),ledger=JSON.stringify({risk:w.s.risk,trade:w.s.trade,drafts:w.s.drafts});
 w.setPrivateUIOwner('wallet:A');w.applyPrivateUIPreferences('wallet:A',{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC']});await w.toggleTracked('SOL');w.persist();
 assert.equal(saved.getItem(WORKBENCH_TARGETS_KEY),targets);assert.equal(saved.getItem('hive.dc.assets'),assets);
 assert.equal(saved.getItem(WORKSPACE_KEY),originalWorkspace);
 const persisted=JSON.parse(saved.getItem(WORKSPACE_KEY));assert.deepEqual(persisted.aiSignalWatch,['ETH']);assert.equal(persisted.workbenchFilter,'scan');assert.equal(persisted.workbenchFocusAsset,'ETH');
 assert.equal(JSON.stringify({risk:w.s.risk,trade:w.s.trade,drafts:w.s.drafts}),ledger);
 w.setPrivateUIOwner(null);assert.deepEqual(w.s.aiSignalWatch,['ETH']);assert.deepEqual(new WorkspaceSim({storage:saved}).s.aiSignalWatch,['ETH']);
});
test('cross-page asset adapter reads private preferences but cannot allocate membership resources',()=>{
 let calls=0;const account={s:{resources:[{kind:'asset',key:'ETH'},{kind:'address',key:'original-address'}]},resource(){calls++;}};
 const w=new WorkspaceSim({account}),adapter=createPrivateWatchAccountAdapter(w),before=JSON.stringify(account.s);
 w.setPrivateUIOwner('wallet:A');w.applyPrivateUIPreferences('wallet:A',{workbenchFilter:'tracked',workbenchFocusAsset:'BTC',watchedAssets:['BTC']});
 assert.deepEqual(adapter.s.resources.filter(row=>row.kind==='asset').map(row=>row.key),['BTC']);assert.throws(()=>adapter.resource('asset','SOL'),/preferences/);assert.equal(calls,0);assert.equal(JSON.stringify(account.s),before);
 w.setPrivateUIOwner('wallet:B');assert.deepEqual(adapter.s.resources.filter(row=>row.kind==='asset'),[]);
 w.setPrivateUIOwner(null);assert.deepEqual(adapter.s.resources,account.s.resources);assert.equal(JSON.stringify(account.s),before);
});

test('failed target preference writes roll back focus, scope and watch resources together',()=>{
 const values=new Map(),saved={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const w=new WorkspaceSim({storage:saved});w.s.aiSignalWatch=['ETH'];w.setWorkbenchTargets({filter:'tracked',focusAsset:'ETH'});
 const before=new Map(values);
 saved.setItem=(key,value)=>{if(key==='hive.dc.assets')throw Error('blocked');values.set(key,value);};
 assert.match(w.setWorkbenchTargets({filter:'all',focusAsset:null}),/保存/);
 assert.equal(w.s.workbenchFilter,'tracked');assert.equal(w.s.workbenchFocusAsset,'ETH');assert.deepEqual(w.s.aiSignalWatch,['ETH']);
 assert.equal(values.get(WORKBENCH_TARGETS_KEY),before.get(WORKBENCH_TARGETS_KEY));
 assert.equal(values.get('hive.dc.assets'),before.get('hive.dc.assets'));
});
