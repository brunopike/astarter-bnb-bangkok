import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

import {BotBook,BOT_MARKETS,BOT_SIM_VERSION,botParameters,botPlanError,editorPlanError,botGridLevels,isBotSimulation} from './bot-runtime.mjs';
import {PROTECTION_RULES,PROTECTION_PARAMETER_KEYS,protectionConfig} from './strategy-protection.mjs';
const spec=test;

const original={id:'original',version:'strategy-original'};
const oldCostFixtures=JSON.parse(readFileSync(new URL('./bot-cost-legacy.fixture.json',import.meta.url),'utf8')).fixtures;
const oldDcaCostFixtures=JSON.parse(readFileSync(new URL('./bot-dca-cost-legacy.fixture.json',import.meta.url),'utf8')).fixtures;
function plan(strategy='S02',extra={}){
 return {id:'D-ONE',version:1,strategy,planVariant:strategy+'-SIM',market:'ETH/USDT',executionRoute:{accountId:'SIM-01',connectionId:'legacy-exchange',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:original,botParameters:strategy==='S01'?{lower:90,upper:110,count:4,spacing:'arithmetic',stopLossPrice:70,takeProfitPrice:130}:{deviationPct:2,sizeMultiplier:1.5,maxEntries:3,takeProfitPct:2,stopLossPct:8},...extra};
}
function account(cash=10000,state,canBuy){
 const owner={cash,debits:0,credits:0,allowCredit:true};
 owner.book=new BotBook({state,canBuy,debit(amount,route){assert.equal(route.accountId,'SIM-01');if(amount>owner.cash)return false;owner.cash-=amount;owner.debits++;return true;},credit(amount,route){assert.equal(route.accountId,'SIM-01');if(!owner.allowCredit)return false;owner.cash+=amount;owner.credits++;return true;}});
 return owner;
}
const view=(book,id)=>book.snapshot().runs.find(run=>run.id===id);
const step=(book,seconds,price=100)=>{for(let i=0;i<Math.round(seconds*10);i++){const result=book.tick(.1,{'ETH/USDT':price});assert.ok(!result.error,result.error);}};
const closeTo=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} differs from ${b}`);
function create(owner,p=plan(),requestId='APPROVAL-1'){
 const result=owner.book.create(p,{requestId});assert.ok(!result.error,result.error);return result.run.id;
}
const ownedQty=run=>run.lots.reduce((n,lot)=>n+lot.qty,0);
const marketReference=(extra={})=>({market:'ETH/USDT',profileId:'cex-spot',venueId:'binance',period:'1H',closedPrice:100,closedAt:1700000000000,asOf:1700000001000,...extra});

spec('a new paper run freezes only the approved closed-candle reference',()=>{
 const owner=account(),reference=marketReference(),p=plan('S01',{simulationReference:reference});
 const id=create(owner,p),saved=view(owner.book,id);
 assert.equal(saved.markPrice,100);assert.equal(saved.simulationStartedAt,0);assert.deepEqual(saved.plan.simulationReference,reference);
 assert.equal(saved.priceSource,'SYNTHETIC_PAPER_CLOCK');assert.equal(saved.clockKind,'synthetic');assert.equal(saved.environment,'DEMO');
 p.simulationReference.closedPrice=999;saved.plan.simulationReference.closedPrice=888;
 assert.equal(view(owner.book,id).plan.simulationReference.closedPrice,100);assert.equal(owner.cash,9500);assert.equal(owner.debits,1);
});

spec('malformed or mismatched reference data is rejected before reserving funds',()=>{
 const references=[null,[],100,{},marketReference({market:'BTC/USDT'}),marketReference({profileId:'cex-perp'}),marketReference({venueId:'okx'}),marketReference({period:'bad'}),marketReference({period:'__proto__'}),marketReference({closedPrice:0}),marketReference({closedPrice:-1}),marketReference({closedPrice:'100'}),marketReference({closedPrice:NaN}),marketReference({closedPrice:Infinity}),marketReference({closedAt:NaN}),marketReference({asOf:Infinity}),marketReference({closedAt:'1700000000000'}),marketReference({closedAt:1700000002000}),marketReference({price:101}),marketReference({state:'live'})];
 for(const [i,reference]of references.entries()){
  const owner=account(),before=owner.book.snapshot(),p=plan('S02',{simulationReference:reference});
  assert.ok(botPlanError(p),String(i));assert.ok(owner.book.create(p,{requestId:'BAD-REFERENCE-'+i}).error,String(i));
  assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,10000);assert.equal(owner.debits,0);
 }
});

spec('a second run starts its own price phase without rebasing an existing paper run',()=>{
 const owner=account(),legacy=create(owner,plan('S02',{botParameters:{...plan().botParameters,triggerPrice:1}}),'LEGACY');
 owner.book.tick(137);
 const current=create(owner,plan('S02',{id:'D-TWO',botParameters:{...plan().botParameters,triggerPrice:1},simulationReference:marketReference()}),'NEW');
 assert.equal(view(owner.book,current).simulationStartedAt,137);assert.equal(view(owner.book,current).markPrice,100);
 assert.ok(!Object.hasOwn(view(owner.book,legacy),'simulationStartedAt'));
 owner.book.tick(0);closeTo(view(owner.book,current).markPrice,100);
 owner.book.tick(.2);
 closeTo(view(owner.book,current).markPrice,100*(1+.045*Math.sin(.2/12)+.015*Math.sin(.2/5)));
 closeTo(view(owner.book,legacy).markPrice,BOT_MARKETS['ETH/USDT']*(1+.045*Math.sin(137.2/12)+.015*Math.sin(137.2/5)));
 assert.equal(owner.debits,2);assert.equal(owner.cash,9000);
});

spec('an imported creation timestamp cannot replace the new run clock epoch',()=>{
 const owner=account();owner.book.tick(137);
 const result=owner.book.create(plan('S02',{simulationReference:marketReference()}),{requestId:'IMPORTED-TIME',at:2});assert.ok(!result.error);
 assert.equal(result.run.createdAt,2);assert.equal(result.run.simulationStartedAt,137);
 owner.book.tick(0);assert.equal(view(owner.book,result.run.id).markPrice,100);
});

spec('the reference is part of request identity while legacy payload bytes stay unchanged',()=>{
 const legacy=account();create(legacy);
 const old=legacy.book.snapshot();assert.ok(!Object.hasOwn(old.runs[0].plan,'simulationReference'));assert.ok(!Object.hasOwn(old.runs[0],'simulationStartedAt'));
 assert.equal(createHash('sha256').update(old.requests[0].payload).digest('hex'),'ed84693dc7a0e4e05bc71eefb9a97d3a5a2d5ee2c7100d0206647541195e6d51');
 const owner=account(),p=plan('S02',{simulationReference:marketReference()}),id=create(owner,p);
 assert.equal(owner.book.create(p,{requestId:'APPROVAL-1'}).run.id,id);
 assert.equal(owner.book.create({...p,simulationReference:marketReference({closedPrice:101})},{requestId:'APPROVAL-1'}).code,'REQUEST_CONFLICT');
 assert.equal(owner.debits,1);assert.equal(owner.book.snapshot().runs.length,1);assert.equal(owner.cash,9500);
});

spec('restoring a reference clock preserves its phase without transfers or automatic execution',()=>{
 const owner=account();owner.book.tick(137);
 const id=create(owner,plan('S02',{botParameters:{...plan().botParameters,triggerPrice:1},simulationReference:marketReference()}));owner.book.tick(2);
 const snapshot=JSON.parse(JSON.stringify(owner.book.snapshot())),price=view(owner.book,id).markPrice,restored=account(owner.cash,snapshot);
 assert.equal(view(restored.book,id).status,'interrupted');assert.equal(view(restored.book,id).simulationStartedAt,137);
 assert.equal(restored.debits,0);assert.equal(restored.credits,0);assert.equal(restored.cash,9500);
 restored.book.tick(0);closeTo(view(restored.book,id).markPrice,price);
 assert.ok(!restored.book.action(id,'resume',{requestId:'RESUME-REFERENCE'}).error);
 owner.book.tick(.5);restored.book.tick(.5);closeTo(view(restored.book,id).markPrice,view(owner.book,id).markPrice);
 assert.equal(view(restored.book,id).orders.length,0);assert.equal(restored.debits,0);assert.equal(restored.credits,0);
});

spec('a damaged reference or clock cannot replace a restored financial book',()=>{
 const owner=account();owner.book.tick(137);create(owner,plan('S02',{simulationReference:marketReference()}));const before=owner.book.snapshot();
 for(const mutate of [state=>delete state.runs[0].simulationStartedAt,state=>state.runs[0].simulationStartedAt=NaN,state=>state.runs[0].simulationStartedAt=-1,state=>state.runs[0].simulationStartedAt=state.time+1,state=>state.runs[0].simulationStartedAt='137',state=>state.runs[0].simulationStartedAt=136,state=>state.runs[0].plan.simulationReference.market='BTC/USDT',state=>state.runs[0].plan.simulationReference.closedPrice=101]){
  const bad=structuredClone(before);mutate(bad);assert.equal(owner.book.restore(bad),false);assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,9500);
 }
});

spec('explicit paper test prices keep their own source tag and do not rebase the approved reference',()=>{
 const owner=account(),id=create(owner,plan('S02',{botParameters:{...plan().botParameters,triggerPrice:1},simulationReference:marketReference()}));
 owner.book.tick(1,{'ETH/USDT':90});assert.equal(view(owner.book,id).markPrice,90);assert.equal(view(owner.book,id).priceSource,'INJECTED_PAPER_PRICE');
 owner.book.tick(0);closeTo(view(owner.book,id).markPrice,100*(1+.045*Math.sin(1/12)+.015*Math.sin(1/5)));
 assert.equal(view(owner.book,id).priceSource,'SYNTHETIC_PAPER_CLOCK');assert.equal(view(owner.book,id).plan.simulationReference.closedPrice,100);assert.equal(view(owner.book,id).simulationStartedAt,0);
});

spec('baseline S01 and S02 stay frozen while explicit paper variants are recognized',()=>{
 for(const strategy of ['S01','S02']){
  assert.equal(isBotSimulation(plan(strategy)),true);
  const owner=account();assert.ok(owner.book.create(plan(strategy,{planVariant:'baseline'}),{requestId:strategy}).error);
  assert.equal(owner.cash,10000);assert.equal(owner.debits,0);assert.equal(owner.book.snapshot().runs.length,0);
 }
});
spec('a checked Binance spot account can be saved and cannot open a paper run',()=>{
 const route={accountId:'BINANCE-SPOT',connectionId:'binance-spot',venueId:'binance',profileId:'cex-spot',chainId:''};
 const p=plan('S01',{market:'BTC/USDT',amount:25,cap:120,executionRoute:route,botParameters:botParameters('S01',60000)});
 const owner=account(),before=owner.book.snapshot();
 assert.equal(editorPlanError(p),null);
 assert.match(botPlanError(p),/SIM-01/);
 assert.equal(owner.book.create(p,{requestId:'LIVE-HELD'}).code,'ROUTE_UNSUPPORTED');
 assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,10000);assert.equal(owner.debits,0);
 assert.match(editorPlanError({...p,executionRoute:{...route,connectionId:'other-spot'}}),/SIM-01/);
 const address='0x1111111111111111111111111111111111111111';
 const walletRoute={accountId:address,connectionId:'wallet-bsc',venueId:'pancakeswap',profileId:'dex-spot',chainId:'56',market:'BTC/USDT'};
 const walletPlan=plan('S01',{market:'BTC/USDT',amount:25,cap:120,executionRoute:walletRoute,botParameters:botParameters('S01',60000)});
 assert.equal(editorPlanError(walletPlan),null);
 assert.match(botPlanError(walletPlan),/SIM-01/);
 assert.equal(owner.book.create(walletPlan,{requestId:'WALLET-HELD'}).code,'ROUTE_UNSUPPORTED');
 assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,10000);assert.equal(owner.debits,0);
});
spec('recommended grid and finite DCA parameters fit the existing 100 per entry and 500 allocation',()=>{
 for(const strategy of ['S01','S02']){
  const p=plan(strategy,{botParameters:botParameters(strategy,BOT_MARKETS['ETH/USDT'])});
  assert.equal(botPlanError(p),null);assert.equal(botParameters(strategy+'-SIM',100).triggerPrice,undefined);
 }
 assert.deepEqual(botGridLevels({lower:90,upper:110,count:2,spacing:'arithmetic'}),[90,100,110]);
 const geometric=botGridLevels({lower:100,upper:400,count:2,spacing:'geometric'});assert.deepEqual(geometric,[100,200,400]);
});
spec('every grid pair must cover both paper fees before a new allocation',()=>{
 const ratio=1.001/.999;
 const cases=[
  {lower:100000,upper:100010,spacing:'arithmetic'},
  {lower:997,upper:1000.999,spacing:'arithmetic'},
  {lower:997,upper:1001,spacing:'arithmetic'},
  {lower:999,upper:999*ratio**2,spacing:'geometric'},
  {lower:999,upper:999*ratio**2*(1-1e-7),spacing:'geometric'}
 ];
 for(const parameters of cases){
  const owner=account(),p=plan('S01',{botParameters:{...parameters,count:2}}),before=owner.book.snapshot();
  assert.match(botPlanError(p),/手续费/);assert.equal(owner.book.create(p,{requestId:'COST-CHECK'}).code,'COST_INFEASIBLE');
  assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,10000);assert.equal(owner.debits,0);
 }
 for(const parameters of [{lower:997,upper:1001.001,spacing:'arithmetic'},{lower:999,upper:999*ratio**2*(1+1e-7),spacing:'geometric'}]){
  const owner=account(),p=plan('S01',{botParameters:{...parameters,count:2}});assert.equal(botPlanError(p),null);create(owner,p);assert.equal(owner.debits,1);
 }
});
spec('grid cost eligibility is invariant across low and high quote scales',()=>{
 const ratio=1.001/.999;
 for(const spacing of ['arithmetic','geometric'])for(const scale of [1e-10,1e-8,1,100000]){
  const positivePlan=plan('S01',{botParameters:{lower:scale,upper:scale*1.0040121365095286,count:2,spacing}});
  const levels=botGridLevels(positivePlan.botParameters);
  assert.ok(levels.slice(1).every((sell,i)=>sell*.999-levels[i]*1.001>0));
  assert.equal(botPlanError(positivePlan),null,`${spacing} positive margin at ${scale}`);
  const owner=account();create(owner,positivePlan);assert.equal(owner.debits,1);
  for(const margin of [0,-1e-7]){
   const upper=spacing==='geometric'?scale*ratio**2*(1+margin):scale*ratio/(2-ratio)*(1+margin);
   const p=plan('S01',{botParameters:{lower:scale,upper,count:2,spacing}}),blocked=account(),before=blocked.book.snapshot();
   assert.match(botPlanError(p),/手续费/,`${spacing} non-positive margin at ${scale}`);
   assert.equal(blocked.book.create(p,{requestId:'COST-SCALE'}).code,'COST_INFEASIBLE');
   assert.deepEqual(blocked.book.snapshot(),before);assert.equal(blocked.debits,0);
  }
 }
});
spec('legacy unprofitable grids retain restoration, exact receipts and legal exits',()=>{
 for(const fixture of oldCostFixtures){
  const owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id,before=owner.book.snapshot();
  assert.equal(view(owner.book,id).status,'interrupted');assert.deepEqual(view(owner.book,id).plan,fixture.state.runs[0].plan);
  assert.equal(owner.book.create(fixture.plan,{requestId:fixture.requestId}).duplicate,true);
  assert.equal(owner.book.create({...fixture.plan,amount:101},{requestId:fixture.requestId}).code,'REQUEST_CONFLICT');
  assert.equal(owner.book.create({...fixture.plan,executionRoute:{...fixture.plan.executionRoute,accountId:'SIM-02'}},{requestId:fixture.requestId}).code,'ROUTE_UNSUPPORTED');
  assert.equal(owner.book.create(fixture.plan,{requestId:'NEW-APPROVAL'}).code,'COST_INFEASIBLE');
  assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,fixture.cash);assert.equal(owner.debits,0);
  const unknown=view(owner.book,id).orders.find(order=>order.status==='unknown');
  if(unknown){
   const reservations=structuredClone(owner.book.flow.reservations);
   assert.ok(!owner.book.action(id,'query',{requestId:'OLD-QUERY',orderId:unknown.id}).error);assert.deepEqual(owner.book.flow.reservations,reservations);
   assert.ok(!owner.book.action(id,'reconcile',{requestId:'OLD-RECEIPT',orderId:unknown.id,outcome:'cancelled'}).error);
   assert.ok(!owner.book.action(id,'stop-close',{requestId:'OLD-EXIT'}).error);step(owner.book,4,100000);
  }else{
   assert.ok(!owner.book.action(id,'resume',{requestId:'OLD-RESUME'}).error);step(owner.book,4,98000);assert.equal(view(owner.book,id).endReason,'stop-loss');
  }
  assert.equal(view(owner.book,id).status,'stopped');assert.equal(ownedQty(view(owner.book,id)),0);assert.equal(owner.debits,0);assert.equal(owner.book.snapshot().runs.length,1);
 }
});
spec('resuming a legacy fee-negative grid pauses new buys at the final admission boundary without disturbing the old sell',()=>{
 const fixture=oldCostFixtures[0],owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id,before=owner.book.snapshot(),original=before.runs[0],sell=original.orders.find(order=>order.side==='sell');
 assert.match(botPlanError(original.plan),/手续费/);assert.ok(!owner.book.action(id,'resume',{requestId:'COST-RESUME-S01'}).error);
 assert.ok(!owner.book.tick(.1,{'ETH/USDT':100006}).error);let run=view(owner.book,id);
 assert.equal(run.orders.filter(order=>order.side==='buy').length,original.orders.filter(order=>order.side==='buy').length,'a restored approval must not bypass current new-buy cost checks');
 assert.equal(run.status,'paused');assert.match(run.pauseReason,/手续费/);assert.deepEqual(run.plan,original.plan);assert.deepEqual(run.lots,original.lots);
 assert.deepEqual(owner.book.flow.reservations,before.flow.reservations);assert.deepEqual(owner.book.s.requests,before.requests);assert.equal(owner.debits,0);assert.equal(owner.cash,fixture.cash);
 assert.equal(run.orders.find(order=>order.id===sell.id).status,'submitted');
 assert.ok(!owner.book.action(id,'query',{requestId:'COST-QUERY-S01',orderId:sell.id}).error);
 step(owner.book,4,100006);run=view(owner.book,id);
 assert.equal(run.orders.find(order=>order.id===sell.id).status,'filled','the already-approved sell remains executable');assert.equal(ownedQty(run),0);
 assert.equal(run.events.filter(event=>event.kind==='risk-paused').length,1,'paused ticks must not repeat the same cost event');assert.equal(run.orders.filter(order=>order.side==='buy').length,1);
 assert.ok(!owner.book.action(id,'stop-keep',{requestId:'COST-END-S01'}).error);run=view(owner.book,id);
 assert.equal(run.status,'stopped');closeTo(owner.cash,fixture.cash+run.returned);assert.equal(owner.debits,0);assert.deepEqual(run.plan,original.plan);
});
spec('a fee-paused legacy grid keeps cancellation and automatic stop-loss available for its original inventory',()=>{
 const fixture=oldCostFixtures[0],owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id,original=view(owner.book,id),sell=original.orders.find(order=>order.side==='sell');
 assert.ok(!owner.book.action(id,'resume',{requestId:'COST-STOP-RESUME'}).error);owner.book.tick(.1,{'ETH/USDT':100006});
 assert.equal(view(owner.book,id).status,'paused');assert.ok(!owner.book.action(id,'cancel',{requestId:'COST-CANCEL-SELL',orderId:sell.id}).error);
 assert.equal(view(owner.book,id).orders.find(order=>order.id===sell.id).status,'cancelled');closeTo(ownedQty(view(owner.book,id)),ownedQty(original));
 step(owner.book,4,98000);const run=view(owner.book,id);
 assert.equal(run.status,'stopped');assert.equal(run.endReason,'stop-loss');assert.equal(ownedQty(run),0);assert.equal(run.orders.filter(order=>order.side==='buy').length,1);
 assert.ok(run.orders.some(order=>order.side==='sell'&&order.intent==='close'&&order.status==='filled'));assert.equal(owner.debits,0);assert.deepEqual(run.plan,original.plan);
});
spec('S02 new risk needs a strictly positive margin after both fees at every quote scale',()=>{
 const breakEven=(1.001/.999-1)*100;
 for(const price of [1e-10,1,100000])for(const [target,allowed]of [[.05,false],[.2,false],[breakEven-1e-8,false],[breakEven,false],[breakEven+1e-8,true],[2,true]]){
  const p=plan('S02',{simulationReference:marketReference({closedPrice:price}),botParameters:{...plan().botParameters,takeProfitPct:target}}),owner=account(),before=owner.book.snapshot();
  if(allowed){assert.equal(botPlanError(p),null);create(owner,p);assert.equal(owner.debits,1);}
  else{
   assert.match(botPlanError(p),/手续费/,`${target}% at ${price}`);
   assert.equal(owner.book.create(p,{requestId:'DCA-COST'}).code,'COST_INFEASIBLE');
   assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,10000);assert.equal(owner.debits,0);
  }
 }
 assert.equal(botParameters('S02').takeProfitPct,2);
});
spec('S02 cost rejection preserves request conflicts and rejects a new revision before allocation',()=>{
 const owner=account(),p=plan(),id=create(owner,p),before=owner.book.snapshot(),low={...p,botParameters:{...p.botParameters,takeProfitPct:.05}};
 assert.equal(owner.book.create(p,{requestId:'APPROVAL-1'}).run.id,id);
 assert.equal(owner.book.create(low,{requestId:'APPROVAL-1'}).code,'REQUEST_CONFLICT');
 assert.equal(owner.book.create({...low,version:2},{requestId:'REVISION-2'}).code,'COST_INFEASIBLE');
 assert.equal(owner.book.create(low,{requestId:'NEW-APPROVAL'}).code,'COST_INFEASIBLE');
 assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,9500);assert.equal(owner.debits,1);
});
spec('legacy fee-negative S02 plans restore and replay exactly without new allocation',()=>{
 for(const fixture of oldDcaCostFixtures){
  const owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id,before=owner.book.snapshot(),prior=fixture.state.requests[0];
  assert.equal(view(owner.book,id).status,'interrupted');assert.deepEqual(view(owner.book,id).plan,fixture.state.runs[0].plan);
  assert.deepEqual(view(owner.book,id).orders,fixture.state.runs[0].orders);assert.deepEqual(view(owner.book,id).lots,fixture.state.runs[0].lots);
  assert.equal(botPlanError(fixture.plan,prior),null);assert.equal(owner.book.create(fixture.plan,{requestId:fixture.requestId}).duplicate,true);
  assert.match(botPlanError({...fixture.plan,amount:101},prior),/请求编号/);
  assert.equal(owner.book.create({...fixture.plan,amount:101},{requestId:fixture.requestId}).code,'REQUEST_CONFLICT');
  const wrongScope={...fixture.plan,executionRoute:{...fixture.plan.executionRoute,accountId:'SIM-02'}};
  assert.match(botPlanError(wrongScope,prior),/SIM-01/);assert.equal(owner.book.create(wrongScope,{requestId:fixture.requestId}).code,'ROUTE_UNSUPPORTED');
  assert.equal(owner.book.create(fixture.plan,{requestId:'NEW-APPROVAL'}).code,'COST_INFEASIBLE');
  assert.equal(owner.book.create({...fixture.plan,version:2},{requestId:'NEW-REVISION'}).code,'COST_INFEASIBLE');
  assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,fixture.cash);assert.equal(owner.debits,0);assert.equal(owner.credits,0);
 }
});
spec('legacy S02 blocks an unsubmitted replenishment but keeps inventory and automatic losing stop exit',()=>{
 const fixture=oldDcaCostFixtures.find(row=>row.label==='normal'),owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id;
 assert.ok(!owner.book.action(id,'resume',{requestId:'RESUME-OLD-DCA'}).error);
 owner.book.tick(.1,{'BTC/USDT':98000});let run=view(owner.book,id);
 assert.equal(run.status,'paused');assert.match(run.pauseReason,/手续费/);assert.equal(run.orders.length,1);assert.equal(run.entries,1);
 assert.deepEqual(run.plan,fixture.state.runs[0].plan);assert.deepEqual(run.lots,fixture.state.runs[0].lots);closeTo(run.cash,399.9);
 const events=run.events.length;owner.book.tick(.1,{'BTC/USDT':98000});assert.equal(view(owner.book,id).events.length,events);
 for(let i=0;i<40;i++)owner.book.tick(.1,{'BTC/USDT':90000});run=view(owner.book,id);
 assert.equal(run.status,'stopped');assert.equal(run.endReason,'stop-loss');assert.equal(ownedQty(run),0);assert.ok(run.realizedPnl<0);
 assert.equal(run.orders.filter(row=>row.side==='buy').length,1);assert.equal(owner.debits,0);
});
spec('legacy S02 original unknown order can query, finish or cancel before a legal losing close',()=>{
 const fixture=oldDcaCostFixtures.find(row=>row.label==='partial-unknown');
 for(const outcome of ['filled','accepted','cancelled']){
  const owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id,orderId=fixture.state.runs[0].orders[0].id,reservations=structuredClone(owner.book.flow.reservations);
  assert.ok(!owner.book.action(id,'query',{requestId:'QUERY-OLD-DCA',orderId}).error);assert.deepEqual(owner.book.flow.reservations,reservations);
  assert.ok(!owner.book.action(id,'reconcile',{requestId:'RECEIPT-OLD-DCA',orderId,outcome}).error);
  if(outcome==='accepted'){
   assert.ok(!owner.book.action(id,'resume',{requestId:'RESUME-RECEIPT'}).error);
   for(let i=0;i<30;i++)owner.book.tick(.1,{'BTC/USDT':100000});
  }
  const settled=view(owner.book,id);assert.equal(settled.orders.length,1);assert.equal(settled.orders[0].filled,outcome==='cancelled'?.5:1);
  closeTo(ownedQty(settled),outcome==='cancelled'?.0005:.001);closeTo(settled.cash,outcome==='cancelled'?449.95:399.9);
  owner.book.tick(0,{'BTC/USDT':90000});assert.ok(!owner.book.action(id,'stop-close',{requestId:'EXIT-OLD-DCA'}).error);
  for(let i=0;i<40;i++)owner.book.tick(.1,{'BTC/USDT':90000});const run=view(owner.book,id);
  assert.equal(run.status,'stopped');assert.equal(ownedQty(run),0);assert.ok(run.realizedPnl<0);assert.equal(run.orders.filter(row=>row.side==='buy').length,1);assert.equal(owner.debits,0);
 }
});
spec('legacy S02 keeps its gross target and original fee-negative take-profit exit',()=>{
 const fixture=oldDcaCostFixtures.find(row=>row.label==='normal'),owner=account(fixture.cash,fixture.state),id=fixture.state.runs[0].id;
 assert.ok(!owner.book.action(id,'resume',{requestId:'RESUME-OLD-TARGET'}).error);
 for(let i=0;i<40;i++)owner.book.tick(.1,{'BTC/USDT':100050});const run=view(owner.book,id);
 assert.equal(run.status,'stopped');assert.equal(run.endReason,'take-profit');assert.equal(run.plan.botParameters.takeProfitPct,.05);
 assert.equal(run.orders.find(row=>row.side==='sell').price,100050);closeTo(run.realizedPnl,-.15005);assert.equal(owner.debits,0);
});
spec('required capital includes all planned buy fees even when the selected cap is too small',async()=>{
 const {botRequiredCapital}=await import('./bot-runtime.mjs');assert.equal(typeof botRequiredCapital,'function');
 closeTo(botRequiredCapital(plan('S01')),400.4);closeTo(botRequiredCapital(plan('S02')),475.475);closeTo(botRequiredCapital(plan('S02',{cap:10})),475.475);
 closeTo(botRequiredCapital(plan('S02',{botParameters:{...plan().botParameters,maxEntries:2}})),250.25);
 for(const p of [null,plan('S02',{amount:NaN}),plan('S02',{botParameters:{...plan().botParameters,maxEntries:4}}),plan('S01',{botParameters:{...plan('S01').botParameters,count:1}})])assert.equal(Number.isNaN(botRequiredCapital(p)),true);
});
spec('creation reserves capital once and the approved payload cannot be changed by callers',()=>{
 const owner=account(),p=plan(),id=create(owner,p);p.botParameters.maxEntries=1;p.executionRoute.accountId='OTHER';
 const saved=view(owner.book,id);assert.equal(saved.plan.botParameters.maxEntries,3);assert.equal(saved.plan.executionRoute.accountId,'SIM-01');
 saved.plan.amount=999;assert.equal(view(owner.book,id).plan.amount,100);
 assert.equal(owner.cash,9500);assert.equal(owner.debits,1);assert.equal(owner.book.summary().allocated,500);assert.equal(owner.book.summary().equity,500);
 const duplicate=owner.book.create(plan(),{requestId:'APPROVAL-1'});assert.equal(duplicate.run.id,id);assert.equal(duplicate.duplicate,true);assert.equal(owner.debits,1);
 assert.equal(owner.book.create(plan('S02',{amount:90}),{requestId:'APPROVAL-1'}).code,'REQUEST_CONFLICT');assert.equal(owner.debits,1);
});
spec('invalid plans and insufficient balances are rejected before any debit or BOT identity is created',()=>{
 const cases=[
  plan('S02',{amount:NaN}),plan('S02',{amount:Infinity}),plan('S02',{amount:0}),plan('S02',{cap:10}),plan('S02',{cap:3001}),
  plan('S02',{mode:'review'}),plan('S02',{environment:'LIVE'}),plan('S02',{market:'DOGE/USDT'}),plan('S02',{version:0}),
  plan('S02',{executionRoute:{...plan().executionRoute,accountId:'SIM-02'}}),
  plan('S02',{executionRoute:{...plan().executionRoute,connectionId:''}}),
  plan('S02',{executionRoute:{...plan().executionRoute,venueId:'okx'}}),
  plan('S02',{executionRoute:{...plan().executionRoute,chainId:'1'}}),
  plan('S02',{executionRoute:{...plan().executionRoute,environment:'LIVE'}}),
  plan('S01',{botParameters:{lower:90,upper:110,count:101,spacing:'arithmetic'}}),
  plan('S01',{botParameters:{lower:90,upper:110,count:2.5,spacing:'arithmetic'}}),
  plan('S01',{botParameters:{lower:110,upper:90,count:2,spacing:'arithmetic'}}),
  plan('S01',{botParameters:{lower:90,upper:110,count:6,spacing:'arithmetic'}}),
  plan('S02',{botParameters:{...plan().botParameters,maxEntries:4}}),
  plan('S02',{botParameters:{...plan().botParameters,deviationPct:NaN}}),
  plan('S02',{botParameters:{...plan().botParameters,sizeMultiplier:10}})
 ];
 for(const [i,p]of cases.entries()){
  const owner=account();assert.ok(owner.book.create(p,{requestId:'BAD-'+i}).error,JSON.stringify(p));assert.equal(owner.debits,0);assert.equal(owner.book.snapshot().runs.length,0);
 }
 const owner=account(499);assert.equal(owner.book.create(plan(),{requestId:'POOR'}).code,'INSUFFICIENT_CASH');assert.equal(owner.cash,499);assert.equal(owner.book.snapshot().runs.length,0);
 const disconnected=new BotBook();assert.equal(disconnected.create(plan(),{requestId:'NO-OWNER'}).code,'CASH_OWNER_REQUIRED');
});
spec('a waiting BOT has a stable identity, allocation and history before its trigger',()=>{
 const owner=account(),id=create(owner,plan('S01',{botParameters:{...plan('S01').botParameters,triggerPrice:95}}));
 assert.equal(view(owner.book,id).status,'waiting');step(owner.book,3,100);assert.equal(view(owner.book,id).orders.length,0);
 const wait=view(owner.book,id);assert.equal(wait.id,id);assert.ok(owner.book.snapshot().history.some(row=>row.runId===id));
 step(owner.book,.1,94);assert.equal(view(owner.book,id).status,'running');
 const stopped=owner.book.action(id,'stop-keep',{requestId:'WAIT-END'});assert.ok(!stopped.error);assert.equal(stopped.run.status,'stopped');assert.equal(owner.cash,10000);assert.equal(owner.book.summary().allocated,0);
});
spec('finite DCA fills partially, obeys its three-entry limit and reports actual fees',()=>{
 const owner=account(),id=create(owner);step(owner.book,1.5,100);let run=view(owner.book,id);
 assert.equal(run.orders.length,1);closeTo(ownedQty(run),.5);closeTo(run.cash,449.95);closeTo(run.fees,.05);
 step(owner.book,1.5,100);step(owner.book,3,98);step(owner.book,3,96.04);run=view(owner.book,id);
 assert.equal(run.entries,3);assert.equal(run.orders.filter(order=>order.side==='buy').length,3);closeTo(run.fees,.475);closeTo(run.cash,24.525);
 step(owner.book,5,95);assert.equal(view(owner.book,id).orders.filter(order=>order.side==='buy').length,3);
 closeTo(owner.cash+owner.book.summary().equity,10000+owner.book.summary().realizedPnl+owner.book.summary().unrealizedPnl);
 const flow=owner.book.snapshot().flow;assert.equal(flow.fills.length,6);assert.ok(flow.fills.every(fill=>fill.feeState==='CONFIRMED'));
});
spec('grid sells only its own filled lot and reuses released capital within its approved cap',()=>{
 const owner=account(),id=create(owner,plan('S01',{cap:300,botParameters:{lower:90,upper:110,count:2,spacing:'arithmetic',stopLossPrice:70,takeProfitPrice:130}}));
 step(owner.book,3,100);let run=view(owner.book,id);assert.equal(run.orders.filter(order=>order.side==='sell').length,1);assert.ok(ownedQty(run)>0);
 step(owner.book,3,110);run=view(owner.book,id);closeTo(run.realizedPnl,9.79);closeTo(run.fees,.21);closeTo(ownedQty(run),0);
 for(const order of run.orders.filter(order=>order.side==='sell'))assert.ok(order.lotIds.length>0);
 assert.ok(run.cash>=0);assert.ok(owner.book.snapshot().flow.reservations.every(reservation=>Number(reservation.amount)>=0));
});
spec('ending and keeping a partially filled BOT cancels the remainder and preserves lot ownership',()=>{
 const owner=account(),id=create(owner);step(owner.book,1.5,100);
 const result=owner.book.action(id,'stop-keep',{requestId:'KEEP'});assert.ok(!result.error);assert.equal(result.run.status,'stopped');closeTo(ownedQty(result.run),.5);closeTo(owner.cash,9949.95);
 assert.equal(result.run.orders[0].status,'partial-cancelled');assert.equal(result.run.plan.botParameters.maxEntries,3);
 const counts=[owner.cash,owner.credits,result.run.orders.length];step(owner.book,20,80);const run=view(owner.book,id);closeTo(ownedQty(run),.5);assert.deepEqual([owner.cash,owner.credits,run.orders.length],counts);
 assert.equal(owner.book.action(id,'resume',{requestId:'INVALID-RESUME'}).code,'RUN_ENDED');
 owner.book.action(id,'close-position',{requestId:'OWNED-EXIT'});step(owner.book,3,100);
 assert.equal(ownedQty(view(owner.book,id)),0);assert.equal(view(owner.book,id).status,'stopped');closeTo(owner.cash,9989.91);closeTo(owner.book.summary().realizedPnl,-10.09);
});
spec('ending and closing returns money only after its independent exit has fully filled',()=>{
 const owner=account(),id=create(owner);step(owner.book,3,100);const result=owner.book.action(id,'stop-close',{requestId:'CLOSE'});assert.ok(!result.error);
 assert.equal(owner.credits,0);assert.equal(result.run.status,'stopping');const orders=result.run.orders.length;
 step(owner.book,1.5,100);assert.ok(ownedQty(view(owner.book,id))>0);assert.equal(owner.credits,0);
 assert.equal(owner.book.action(id,'stop-close',{requestId:'CLOSE'}).duplicate,true);assert.equal(view(owner.book,id).orders.length,orders);
 step(owner.book,1.5,100);assert.equal(view(owner.book,id).status,'stopped');closeTo(owner.cash,9999.8);assert.equal(owner.credits,1);assert.equal(owner.book.summary().allocated,0);assert.equal(owner.book.summary().equity,0);
});
spec('two BOTs share free cash but pause, stop, lots and orders stay scoped to runId',()=>{
 const owner=account(),one=create(owner,plan(),'ONE'),two=create(owner,plan('S02',{id:'D-TWO'}),'TWO');assert.notEqual(one,two);assert.equal(owner.cash,9000);
 owner.book.action(one,'pause',{requestId:'PAUSE-ONE'});step(owner.book,3,100);
 assert.equal(view(owner.book,one).orders.length,0);assert.equal(view(owner.book,two).orders.length,1);assert.equal(ownedQty(view(owner.book,one)),0);closeTo(ownedQty(view(owner.book,two)),1);
 const before=view(owner.book,two);owner.book.action(one,'stop-keep',{requestId:'END-ONE'});assert.deepEqual(view(owner.book,two),before);assert.equal(owner.cash,9500);
 assert.equal(owner.book.summary().activeCount,1);assert.equal(owner.book.summary().historyCount,1);
});
spec('stale account or connection actions cannot modify the target BOT or another BOT',()=>{
 const owner=account(),id=create(owner),before=owner.book.snapshot();
 for(const options of [{expectedAccountId:'SIM-02'},{expectedConnectionId:'other'},{expectedEnvironment:'LIVE'}]){
  const result=owner.book.action(id,'stop-close',{requestId:'WRONG-'+JSON.stringify(options),...options});assert.equal(result.code,'SCOPE_MISMATCH');assert.deepEqual(owner.book.snapshot(),before);
 }
 assert.equal(owner.book.action('MISSING','pause',{requestId:'MISSING'}).code,'RUN_NOT_FOUND');
});
spec('unknown receipts retain the original operation and reservation and never resend on query',()=>{
 const owner=account(),id=create(owner,plan('S02',{simulationScenario:'unknown'}));step(owner.book,3,100);let run=view(owner.book,id);assert.equal(run.status,'blocked');assert.equal(run.orders[0].status,'unknown');
 const order=run.orders[0],snapshot=owner.book.snapshot(),held=snapshot.flow.reservations.filter(row=>row.orderId===order.id).map(row=>row.amount);
 const query=owner.book.action(id,'query',{requestId:'QUERY',orderId:order.id});assert.equal(query.operation.id,order.operationId);assert.equal(query.operation.state,'UNKNOWN');assert.equal(view(owner.book,id).orders.length,1);
 assert.deepEqual(owner.book.snapshot().flow.reservations.filter(row=>row.orderId===order.id).map(row=>row.amount),held);
 owner.book.action(id,'stop-close',{requestId:'END-UNKNOWN'});assert.equal(owner.credits,0);assert.equal(view(owner.book,id).orders.length,1);
 const receipt=owner.book.action(id,'reconcile',{requestId:'RECEIPT',orderId:order.id,outcome:'filled'});assert.ok(!receipt.error);assert.equal(receipt.run.orders[0].id,order.id);assert.equal(receipt.run.orders[0].status,'filled');
 step(owner.book,3,100);run=view(owner.book,id);assert.equal(run.status,'stopped');assert.equal(run.orders.length,2);closeTo(owner.cash,9999.8);
 const before=owner.book.snapshot();assert.equal(owner.book.action(id,'reconcile',{requestId:'RECEIPT',orderId:order.id,outcome:'filled'}).duplicate,true);assert.deepEqual(owner.book.snapshot(),before);
});
spec('a partial unknown order keeps actual inventory and cancellation settles only the unfilled part',()=>{
 const owner=account(),id=create(owner,plan('S02',{simulationScenario:'partial-unknown'}));step(owner.book,3,100);const run=view(owner.book,id);assert.equal(run.orders[0].status,'unknown');closeTo(ownedQty(run),.5);
 owner.book.action(id,'stop-keep',{requestId:'KEEP-UNKNOWN'});assert.equal(owner.credits,0);
 const result=owner.book.action(id,'reconcile',{requestId:'CANCEL-ORIGINAL',orderId:run.orders[0].id,outcome:'cancelled'});assert.ok(!result.error);assert.equal(result.run.status,'stopped');closeTo(ownedQty(result.run),.5);closeTo(owner.cash,9949.95);
});
spec('rejected entries remain in history with their approved plan and no fabricated fills',()=>{
 const owner=account(),id=create(owner,plan('S02',{simulationScenario:'rejected'}));step(owner.book,1,100);const run=view(owner.book,id);
 assert.equal(run.status,'failed');assert.equal(run.orders[0].status,'rejected');assert.equal(owner.book.snapshot().flow.fills.length,0);assert.equal(owner.cash,10000);
 const history=owner.book.snapshot().history.find(row=>row.runId===id);assert.equal(history.status,'failed');assert.equal(history.plan.botParameters.maxEntries,3);assert.ok(history.endReason);
});
spec('a rejected exit cannot release owned inventory or auto retry an ended plan',()=>{
 const owner=account(),id=create(owner,plan('S02',{simulationScenario:'exit-rejected'}));step(owner.book,3,100);owner.book.action(id,'stop-close',{requestId:'FAILED-EXIT'});
 const run=view(owner.book,id);assert.equal(run.status,'blocked');closeTo(ownedQty(run),1);assert.equal(owner.credits,0);const count=run.orders.length;step(owner.book,10,100);assert.equal(view(owner.book,id).orders.length,count);
 owner.book.action(id,'stop-close',{requestId:'EXPLICIT-EXIT-RETRY'});step(owner.book,3,100);assert.equal(view(owner.book,id).status,'stopped');assert.equal(view(owner.book,id).orders.length,count+1);closeTo(owner.cash,9999.8);
});
spec('price gaps hit the common DCA stop before another entry can be submitted',()=>{
 const owner=account(),id=create(owner);step(owner.book,3,100);step(owner.book,3,80);const run=view(owner.book,id);
 assert.equal(run.status,'stopped');assert.equal(run.orders.filter(order=>order.side==='buy').length,1);assert.equal(run.endReason,'stop-loss');closeTo(run.realizedPnl,-20.18);closeTo(owner.cash,9979.82);
});
spec('take profit exits only actual DCA inventory and keeps realized versus unrealized results separate',()=>{
 const owner=account(),id=create(owner);step(owner.book,3,100);closeTo(owner.book.summary().unrealizedPnl,-.1);assert.equal(owner.book.summary().realizedPnl,0);
 step(owner.book,3,110);const run=view(owner.book,id);assert.equal(run.status,'stopped');assert.equal(run.endReason,'take-profit');closeTo(run.realizedPnl,9.79);closeTo(owner.book.summary().unrealizedPnl,0);closeTo(owner.cash,10009.79);
});
spec('restoring a JSON snapshot interrupts execution without another transfer or automatic fill',()=>{
 const originalOwner=account(),id=create(originalOwner);step(originalOwner.book,1.5,100);const data=JSON.parse(JSON.stringify(originalOwner.book.snapshot()));
 const restored=account(originalOwner.cash,data);assert.equal(restored.debits,0);assert.equal(restored.credits,0);assert.equal(view(restored.book,id).status,'interrupted');
 const count=view(restored.book,id).orders.length,qty=ownedQty(view(restored.book,id));step(restored.book,10,100);assert.equal(view(restored.book,id).orders.length,count);closeTo(ownedQty(view(restored.book,id)),qty);
 assert.equal(restored.book.create(plan(),{requestId:'APPROVAL-1'}).run.id,id);assert.equal(restored.debits,0);
 assert.ok(!restored.book.action(id,'resume',{requestId:'RESUME'}).error);step(restored.book,3,100);closeTo(ownedQty(view(restored.book,id)),1);assert.equal(view(restored.book,id).orders.length,count);
 assert.ok(restored.book.snapshot().history.find(row=>row.runId===id).events.some(event=>event.kind==='interrupted'));
});
spec('restore rejects damaged financial state without replacing the current book',()=>{
 const owner=account(),id=create(owner),before=owner.book.snapshot(),bad=structuredClone(before);bad.runs[0].cash=NaN;
 assert.equal(owner.book.restore(bad),false);assert.deepEqual(owner.book.snapshot(),before);assert.equal(view(owner.book,id).allocated,500);
 assert.throws(()=>new BotBook({state:{schema:1,runs:[]}}),/BOT_STATE_INVALID/);
});
spec('finite cash tampering and a regressed identity sequence cannot inflate a restored account',()=>{
 const owner=account();create(owner);const before=owner.book.snapshot();
 for(const mutation of [state=>state.runs[0].cash=50000,state=>state.seq=0,state=>state.runs[0].initialAllocation=50000,state=>state.runs[0].plan.environment='LIVE',state=>state.runs[0].environment='LIVE']){
  const bad=structuredClone(before);mutation(bad);assert.equal(owner.book.restore(bad),false);assert.deepEqual(owner.book.snapshot(),before);assert.equal(owner.cash,9500);
 }
});
spec('restore refuses damaged cash ledgers and missing original operation links',()=>{
 const owner=account();create(owner);step(owner.book,1.5,100);const before=owner.book.snapshot();
 for(const mutate of [state=>state.flow.ledger[0].amount='501',state=>state.flow.operations=[],state=>state.runs[0].orders[0].environment='LIVE']){
  const bad=structuredClone(before);mutate(bad);assert.equal(owner.book.restore(bad),false);assert.deepEqual(owner.book.snapshot(),before);
 }
});
spec('malformed restored rows fail safely without replacing valid funds',()=>{
 const owner=account();create(owner);const before=owner.book.snapshot();
 for(const mutate of [state=>state.runs=[null],state=>state.runs[0].orders=[null],state=>state.requests=[null],state=>state.actions=[null],state=>state.history=[null],state=>state.flow.ledger=[null]]){
  const bad=structuredClone(before);mutate(bad);assert.equal(owner.book.restore(bad),false);assert.deepEqual(owner.book.snapshot(),before);
 }
});
spec('action idempotency cannot be rebound to another run through extra option fields',()=>{
 const owner=account(),one=create(owner,plan(),'DEDUPE-ONE'),two=create(owner,plan('S02',{id:'D-TWO'}),'DEDUPE-TWO');
 assert.ok(!owner.book.action(one,'pause',{requestId:'EXACT-ACTION',runId:'ignored',kind:'ignored'}).error);
 assert.equal(owner.book.action(two,'pause',{requestId:'EXACT-ACTION',runId:'ignored',kind:'ignored'}).code,'REQUEST_CONFLICT');assert.equal(view(owner.book,two).status,'running');
});
spec('Astarter protection applies to the BOT allocation and cannot silently ignore its risk decision',()=>{
 const owner=account(),id=create(owner,plan('S02',{protection:{id:'astarter',version:'astarter-research-v0.1/sim-2',mode:'normal'}}));step(owner.book,3,100);const run=view(owner.book,id);
 assert.ok(run.protectionDecision);assert.ok(run.orders[0].qty<1);assert.ok(run.orders[0].qty>0);assert.equal(run.plan.amount,100);
 const invalid=plan('S01',{protection:{id:'astarter',version:'astarter-research-v0.1/sim-2',mode:'normal'},botParameters:{lower:90,upper:110,count:2,spacing:'arithmetic'}});assert.ok(botPlanError(invalid));
});
spec('Astarter protection counts existing lots and pending orders against one BOT basket risk budget',()=>{
 const owner=account(),id=create(owner,plan('S02',{protection:{id:'astarter',version:'astarter-research-v0.1/sim-2',mode:'normal'}}));step(owner.book,3,100);step(owner.book,3,98);const run=view(owner.book,id);
 const stop=92,loss=run.lots.reduce((n,lot)=>n+lot.costBasis-lot.qty*stop*.999,0);
 assert.ok(loss<=1.25+1e-7,`${loss} exceeds the 1.25 allocation episode budget`);
});
spec('invalid time or paper prices leave all cash, fills and clock state unchanged',()=>{
 const owner=account();create(owner);const before=owner.book.snapshot();
 for(const [dt,prices]of [[NaN,{}],[-1,{}],[1,{'ETH/USDT':NaN}],[1,{'ETH/USDT':0}],[1,{'DOGE/USDT':1}]]){
  assert.ok(owner.book.tick(dt,prices).error);assert.deepEqual(owner.book.snapshot(),before);
 }
});
spec('a failed cash return retains funds and only a new explicit action retries it',()=>{
 const owner=account(),id=create(owner);owner.allowCredit=false;
 assert.equal(owner.book.action(id,'stop-keep',{requestId:'FAILED-RETURN'}).code,'CREDIT_FAILED');assert.equal(owner.cash,9500);assert.equal(view(owner.book,id).cash,500);assert.equal(view(owner.book,id).allocated,500);
 owner.allowCredit=true;owner.book.action(id,'stop-keep',{requestId:'RETURN-RETRY'});assert.equal(owner.cash,10000);assert.equal(view(owner.book,id).cash,0);assert.equal(view(owner.book,id).allocated,0);assert.equal(owner.credits,1);
});
spec('paper-clock runs are reproducible and never identify themselves as market execution',t=>{
 t.mock.timers.enable({apis:['Date'],now:1794192000000});
 const one=account(),two=account(),a=create(one),b=create(two);for(let i=0;i<100;i++){one.book.tick(.1);two.book.tick(.1);}
 assert.deepEqual(view(one.book,a),view(two.book,b));assert.equal(view(one.book,a).priceSource,'SYNTHETIC_PAPER_CLOCK');assert.equal(view(one.book,a).environment,'DEMO');assert.equal(one.book.snapshot().version,BOT_SIM_VERSION);
});
spec('keeping an interrupted partial exit returns only confirmed sale cash and a later exit finishes the same lots',()=>{
 const owner=account(),id=create(owner);step(owner.book,3,100);owner.book.action(id,'stop-close',{requestId:'START-EXIT'});step(owner.book,1.5,100);
 const kept=owner.book.action(id,'stop-keep',{requestId:'KEEP-EXIT-REMAINDER'});assert.ok(!kept.error);assert.equal(kept.run.status,'stopped');closeTo(ownedQty(kept.run),.5);closeTo(owner.cash,9949.85);
 assert.equal(kept.run.orders.at(-1).status,'partial-cancelled');step(owner.book,.1,110);owner.book.action(id,'close-position',{requestId:'EXIT-OWNED-REMAINDER'});step(owner.book,3,110);
 assert.equal(view(owner.book,id).status,'stopped');closeTo(owner.cash,10004.795);closeTo(view(owner.book,id).realizedPnl,4.795);assert.equal(ownedQty(view(owner.book,id)),0);
});
spec('a kept holding survives JSON restore with zero transfers and stays independently closable',()=>{
 const owner=account(),id=create(owner);step(owner.book,1.5,100);owner.book.action(id,'stop-keep',{requestId:'KEEP-BEFORE-REFRESH'});
 const restored=account(owner.cash,JSON.parse(JSON.stringify(owner.book.snapshot())));assert.equal(restored.debits,0);assert.equal(restored.credits,0);assert.equal(view(restored.book,id).status,'stopped');closeTo(ownedQty(view(restored.book,id)),.5);
 restored.book.action(id,'close-position',{requestId:'EXIT-AFTER-REFRESH'});step(restored.book,3,100);closeTo(restored.cash,9999.9);assert.equal(view(restored.book,id).status,'stopped');assert.equal(restored.credits,1);
});
spec('refreshing an unknown partial order keeps its original request until an explicit receipt releases the remainder',()=>{
 const owner=account(),id=create(owner,plan('S02',{simulationScenario:'partial-unknown'}));step(owner.book,3,100);const original=view(owner.book,id).orders[0];
 const restored=account(owner.cash,JSON.parse(JSON.stringify(owner.book.snapshot())));step(restored.book,10,100);assert.equal(view(restored.book,id).orders[0].id,original.id);assert.equal(view(restored.book,id).orders[0].filled,.5);
 restored.book.action(id,'stop-close',{requestId:'END-RESTORED-UNKNOWN'});assert.equal(restored.credits,0);assert.equal(view(restored.book,id).orders.length,1);
 restored.book.action(id,'reconcile',{requestId:'RESTORED-RECEIPT',orderId:original.id,outcome:'cancelled'});step(restored.book,3,100);
 assert.equal(view(restored.book,id).status,'stopped');assert.equal(view(restored.book,id).orders.length,2);closeTo(restored.cash,9999.9);
});
spec('multiple BOTs conserve shared cash, lots and recorded ledger balances through price changes and exits',()=>{
 const owner=account(),ids=[create(owner,plan('S01'),'GRID-A'),create(owner,plan('S01',{id:'D-GRID-B'}),'GRID-B'),create(owner,plan('S02',{id:'D-DCA'}),'DCA')];
 let random=12345;
 for(let i=0;i<500;i++){
  random=(random*1664525+1013904223)>>>0;const price=90+random/4294967296*20;owner.book.tick(.1,{'ETH/USDT':price});
  if(i===100)owner.book.action(ids[0],'pause',{requestId:'FUZZ-PAUSE'});if(i===200)owner.book.action(ids[0],'resume',{requestId:'FUZZ-RESUME'});
  const sum=owner.book.summary();closeTo(owner.cash+sum.equity,10000+sum.realizedPnl+sum.unrealizedPnl);
  const state=owner.book.snapshot();closeTo(state.runs.reduce((n,run)=>n+run.cash,0),state.flow.ledger.reduce((n,row)=>n+Number(row.amount),0));
  assert.ok(state.runs.every(run=>run.cash>=0&&run.lots.every(lot=>lot.qty>=0&&lot.costBasis>=0)));
 }
 for(const [i,id]of ids.entries())owner.book.action(id,'stop-close',{requestId:'FUZZ-END-'+i});step(owner.book,3,100);
 const sum=owner.book.summary();assert.equal(sum.allocated,0);assert.equal(sum.equity,0);assert.equal(sum.historyCount,3);closeTo(owner.cash,10000+sum.realizedPnl);
});
spec('a synchronous shared buy guard pauses only new buys and keeps the approved risk version',()=>{
 let received;const owner=account(10000,undefined,run=>{received=run;return '共享账户检查已失效';}),id=create(owner,plan('S02',{riskVersion:7}));step(owner.book,.1,100);
 const run=view(owner.book,id);assert.equal(run.orders.length,0);assert.equal(run.status,'paused');assert.equal(run.pauseReason,'共享账户检查已失效');assert.equal(received.plan.riskVersion,7);closeTo(received.equity,500);assert.ok(Object.isFrozen(received.plan));assert.ok(run.events.some(event=>event.kind==='risk-paused'));
});
spec('a shared loss caused by an earlier BOT fill blocks a later BOT entry in that same tick',()=>{
 let owner;owner=account(10000,undefined,()=>owner.book.summary().realizedPnl < -15?'共享亏损线已触发':true);
 const one=create(owner,plan('S02'),'GUARD-ONE'),two=create(owner,plan('S02',{id:'D-GUARD-TWO',market:'BTC/USDT'}),'GUARD-TWO');
 for(let i=0;i<30;i++)owner.book.tick(.1,{'ETH/USDT':100,'BTC/USDT':100});
 owner.book.tick(.1,{'ETH/USDT':80,'BTC/USDT':100});
 for(let i=0;i<20&&view(owner.book,one).orders.at(-1).filled===0;i++)owner.book.tick(.1,{'ETH/USDT':80,'BTC/USDT':100});
 const closing=view(owner.book,one).orders.at(-1),remaining=closing.eligibleAt+2.5-owner.book.snapshot().time;
 owner.book.tick(remaining,{'ETH/USDT':80,'BTC/USDT':98});
 assert.equal(view(owner.book,one).status,'stopped');assert.ok(view(owner.book,one).realizedPnl < -15);assert.equal(view(owner.book,two).orders.filter(order=>order.side==='buy').length,1);assert.equal(view(owner.book,two).status,'paused');
});
spec('failed shared buy checks fail closed while existing inventory can still exit',()=>{
 for(const guard of [()=>false,()=>{throw Error('unavailable');}]){
  const owner=account(10000,undefined,guard),id=create(owner);step(owner.book,.1,100);assert.equal(view(owner.book,id).status,'paused');assert.equal(view(owner.book,id).orders.length,0);
 }
 let allowed=true;const owner=account(10000,undefined,()=>allowed),id=create(owner);step(owner.book,3,100);allowed=false;owner.book.action(id,'stop-close',{requestId:'GUARDED-EXIT'});step(owner.book,3,100);assert.equal(view(owner.book,id).status,'stopped');closeTo(owner.cash,9999.8);
});

const riskParameters=()=>Object.fromEntries(PROTECTION_PARAMETER_KEYS.map(key=>[key,PROTECTION_RULES[key]]));
spec('a custom risk snapshot sizes native orders and survives restore without rewriting its approved values',()=>{
 const input={...riskParameters(),episode:.0005},policy=protectionConfig('astarter','normal',input),owner=account();
 const id=create(owner,plan('S02',{cap:1000,protection:policy,botParameters:{...plan().botParameters,stopLossPct:2}}));
 step(owner.book,6,100);const run=view(owner.book,id),buy=run.orders.find(order=>order.side==='buy');
 assert.ok(buy);assert.ok(buy.price*buy.qty<=22.720001);assert.ok(buy.price*buy.qty>=20);assert.equal(owner.cash,9000);
 input.episode=.0025;policy.parameters.episode=.0025;
 assert.equal(view(owner.book,id).plan.protection.parameters.episode,.0005);
 assert.equal(Object.isFrozen(owner.book.s.runs[0].plan.protection.parameters),true);
 const restored=account(owner.cash,JSON.parse(JSON.stringify(owner.book.snapshot())));
 assert.equal(restored.debits,0);assert.equal(restored.credits,0);
 assert.deepEqual(view(restored.book,id).plan.protection,run.plan.protection);
});
spec('a custom risk budget below minimum notional retains funds without placing an order',()=>{
 const owner=account(),id=create(owner,plan('S02',{cap:1000,protection:protectionConfig('astarter','normal',{...riskParameters(),episode:.0001}),botParameters:{...plan().botParameters,stopLossPct:2}}));
 step(owner.book,6,100);const run=view(owner.book,id);
 assert.equal(run.orders.length,0);assert.equal(run.quantity,0);assert.equal(run.protectionDecision.reason,'budget');assert.equal(run.protectionDecision.amount,0);
 assert.equal(owner.cash,9000);assert.equal(run.cash,1000);
});
