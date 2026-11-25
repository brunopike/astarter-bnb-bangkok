import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG} from './strategy-catalog.mjs';
import {strategyFlowAvailable} from './strategy-execution-data.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';

const context={ready:true,market:'BTC/USDT',revision:'test:1',price:100};
const draft={strategy:'S03',market:'BTC/USDT',mode:'confirm',amount:100,cap:500};
const advance=(trade,seconds)=>{for(let i=0;i<Math.round(seconds*10);i++)trade.tick(.1,context);};
const saved=trade=>{const {records,...state}=trade;return structuredClone({...state,flow:records.data});};

test('route-less unimplemented catalog drafts cannot validate or inherit a passed execution state',()=>{
 for(const strategy of CATALOG.filter(row=>row.id!=='S03')){
  const workspace=new WorkspaceSim(),plan=workspace.createDraft(strategy.id);
  assert.equal(strategyFlowAvailable(plan),false,strategy.id);
  assert.match(workspace.validateSetup().error,/尚未适配执行/,strategy.id);
  assert.equal(workspace.s.usage.length,0,strategy.id);
  Object.assign(plan,{status:'passed',validatedVersion:plan.version});
  assert.match(workspace.checkStart(plan),/尚未适配执行/,strategy.id);
 }
});

test('unimplemented S03 variants cannot borrow the legacy baseline adapter',()=>{
 for(const planVariant of ['E01','E02','unknown']){
  const workspace=new WorkspaceSim(),plan=workspace.draft();plan.planVariant=planVariant;
  assert.match(workspace.validateSetup().error,/尚未适配执行/);
  assert.match(workspace.checkStart(plan),/尚未适配执行/);
  assert.ok(new TradingDemo().start({...draft,planVariant},DEFAULT_CONNECTIONS,context));
 }
});

test('legacy route-less S03 baseline remains usable without enabling other baselines',()=>{
 const workspace=new WorkspaceSim(),plan=workspace.draft();
 assert.equal(strategyFlowAvailable(plan),true);assert.equal(workspace.checkStart(plan),null);
 const validation=workspace.validateSetup();assert.ok(validation.run);
 const trade=new TradingDemo();assert.equal(trade.start(draft,DEFAULT_CONNECTIONS,context),null);
 advance(trade,5);assert.ok(trade.signal);assert.equal(trade.submit(),null);
});

test('S03 markets without a registered adapter are rejected even without a route',()=>{
 for(const market of ['ETH/USDT','SOL/USDT']){
  const workspace=new WorkspaceSim(),plan=workspace.draft();plan.market=market;
  assert.match(workspace.validateSetup().error,/尚未适配执行/);assert.match(workspace.checkStart(plan),/尚未适配执行/);
  assert.ok(new TradingDemo().start({...draft,market},DEFAULT_CONNECTIONS,{...context,market}));
 }
});

test('a singleShot flag or copied ticket cannot manufacture entry authority',()=>{
 for(const strategy of ['S03','S04']){
  const trade=new TradingDemo(),ticket={profileId:'cex-spot',sourceId:'FORGED',revision:context.revision,quotePrice:100,quotedAt:0,maxGap:.5,stopLoss:98,takeProfit:104};
  assert.ok(trade.start({...draft,strategy,singleShot:true,ticket},DEFAULT_CONNECTIONS,context));
  assert.equal(trade.session,null);assert.equal(trade.orders.length,0);assert.equal(trade.cash,10000);
 }
});

test('the scripted trading engine rejects every catalog baseline without a registered adapter',()=>{
 for(const strategy of CATALOG.filter(row=>row.id!=='S03')){
  const trade=new TradingDemo();assert.ok(trade.start({...draft,strategy:strategy.id},DEFAULT_CONNECTIONS,context),strategy.id);
  assert.equal(trade.session,null);assert.equal(trade.orders.length,0);assert.equal(trade.cash,10000);
 }
});

test('restoring an unsupported legacy strategy preserves its ledger and permits only existing inventory exits',()=>{
 const original=new TradingDemo();original.start(draft,DEFAULT_CONNECTIONS,context);advance(original,5);original.submit();advance(original,3);
 const state=saved(original);state.session.strategy='S04';
 const trade=new TradingDemo();assert.equal(trade.restore(state),true);
 assert.equal(trade.cash,state.cash);assert.deepEqual(trade.orders,state.orders);assert.deepEqual(trade.flow,state.flow);assert.equal(trade.state,'paused');
 assert.ok(trade.resume(context));assert.equal(trade.state,'paused');
 trade.state='running';trade.signal={id:'UNSUPPORTED-BUY',side:'buy',at:trade.time};
 assert.ok(trade.submit());assert.equal(trade.orders.length,state.orders.length);
 advance(trade,6);assert.equal(trade.orders.length,state.orders.length);
 assert.equal(trade.closePosition(),null);advance(trade,3);
 assert.equal(trade.position,null);assert.equal(trade.orders.length,state.orders.length+1);assert.equal(trade.orders[0].side,'sell');
});

test('unsupported restored runs retain unknown orders and reconcile the original request without resuming strategy signals',()=>{
 const original=new TradingDemo();original.orderScenario='unknown';original.start(draft,DEFAULT_CONNECTIONS,context);advance(original,5);original.submit();advance(original,2);
 const state=saved(original);state.session.strategy='S08';
 const trade=new TradingDemo();assert.equal(trade.restore(state),true);
 const order=trade.pending;assert.equal(order.status,'unknown');assert.equal(trade.state,'blocked');
 const cash=trade.cash;assert.ok(trade.resume(context));assert.equal(trade.cash,cash);assert.equal(trade.orders.length,1);
 trade.deliverReceipt();assert.equal(trade.reconcile(),null);advance(trade,3);
 assert.equal(trade.orders.length,1);assert.ok(trade.position);assert.ok(trade.resume(context));
});

test('single-shot simulated orders keep their separate registered market adapter',()=>{
 const market='ETH/USDT',trade=new TradingDemo(),ticket={profileId:'cex-spot',sourceId:'MANUAL',revision:context.revision,quotePrice:100,quotedAt:0,maxGap:.5,stopLoss:98,takeProfit:104};
 assert.equal(trade.quickOrder({...draft,market},DEFAULT_CONNECTIONS,{...context,market},ticket),null);
 for(let i=0;i<30;i++)trade.tick(.1,{...context,market});assert.ok(trade.position);assert.equal(trade.orders.length,1);
});

test('legacy S03 holdings in an unregistered market stay recoverable without restoring strategy entry permission',()=>{
 const market='ETH/USDT',original=new TradingDemo(),ticket={profileId:'cex-spot',sourceId:'OLD',revision:context.revision,quotePrice:100,quotedAt:0,maxGap:.5,stopLoss:98,takeProfit:104};
 original.quickOrder({...draft,market},DEFAULT_CONNECTIONS,{...context,market},ticket);
 for(let i=0;i<30;i++)original.tick(.1,{...context,market});
 const state=saved(original);state.session.singleShot=false;delete state.session.ticket;
 const trade=new TradingDemo();assert.equal(trade.restore(state),true);assert.ok(trade.resume({...context,market}));
 assert.equal(trade.cash,state.cash);assert.deepEqual(trade.orders,state.orders);assert.deepEqual(trade.flow,state.flow);
 assert.equal(trade.closePosition(),null);for(let i=0;i<30;i++)trade.tick(.1,{...context,market});
 assert.equal(trade.position,null);assert.equal(trade.orders.length,2);
});
