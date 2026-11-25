import test from 'node:test';import assert from 'node:assert/strict';import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
const draft={market:'BTC/USDT',strategy:'S03',mode:'confirm',amount:250,cap:1000};const research={ready:true,market:draft.market,revision:'r1'};const advance=(d,n,ctx={ready:true})=>{for(let i=0;i<n*10;i++)d.tick(.1,ctx);};
test('unready research, disabled connection and invalid limits block activation',()=>{const d=new TradingDemo();assert.ok(d.start(draft,DEFAULT_CONNECTIONS,{...research,ready:false}));assert.ok(d.start(draft,{...DEFAULT_CONNECTIONS,data:false},research));assert.ok(d.start({...draft,cap:20},DEFAULT_CONNECTIONS,research));assert.equal(d.orders.length,0);});
test('confirmation submits once, partial cancellation preserves filled inventory and fee',()=>{const d=new TradingDemo();assert.equal(d.start(draft,DEFAULT_CONNECTIONS,research),null);advance(d,5);assert.equal(d.orders.length,0);assert.equal(d.submit(),null);assert.ok(d.submit());advance(d,1.5);d.pause();assert.equal(d.orders.length,1);assert.equal(d.orders[0].status,'partial-cancelled');assert.ok(Math.abs(d.position.qty*d.position.price-125)<1e-8);assert.ok(Math.abs(d.cash-9874.875)<1e-8);assert.equal(d.pending,null);});
test('automatic run is bounded, actual fixture fills change cash and fees',()=>{const d=new TradingDemo();d.start({...draft,mode:'auto'},DEFAULT_CONNECTIONS,research);advance(d,45);assert.equal(d.orders.length,3);assert.equal(d.state,'paused');assert.equal(d.orders.every(o=>o.status==='filled'),true);assert.ok(Math.abs(d.equity-(10000-d.totalFees))<1e-7);});
test('signal mode never submits, research change stops fresh risk',()=>{const d=new TradingDemo();d.start({...draft,mode:'signal'},DEFAULT_CONNECTIONS,research);advance(d,8);assert.equal(d.orders.length,0);d.tick(.1,{ready:false});assert.equal(d.state,'blocked');advance(d,20);assert.equal(d.orders.length,0);});
test('stop retains holding and explicit close exits with new fee',()=>{const d=new TradingDemo();d.start({...draft,mode:'auto'},DEFAULT_CONNECTIONS,research);advance(d,10);assert.equal(d.orders[0].status,'filled');d.stop();assert.ok(d.position);assert.ok(d.start(draft,DEFAULT_CONNECTIONS,research));assert.equal(d.closePosition(),null);advance(d,3);assert.equal(d.position,null);assert.equal(d.state,'stopped');assert.ok(Math.abs(d.cash-9999.5)<1e-7);});

test('autonomous signal gets a review interval before the mock order is submitted',()=>{const d=new TradingDemo();d.start({...draft,mode:'auto'},DEFAULT_CONNECTIONS,research);advance(d,5);assert.ok(d.signal);assert.equal(d.pending,null);advance(d,2);assert.ok(d.pending);});
test('restoring an old ledger drops repeated restore notices from the unread count',()=>{const d=new TradingDemo();const snapshot={cash:10000,orders:[],events:[{id:4,text:'已恢复模拟账本；自动执行保持暂停，需明确恢复。',kind:'info',at:0},{id:3,text:'模拟委托已成交',kind:'fill',at:0}],seq:4,readSeq:0,state:'stopped',session:{id:'SIM-1'}};assert.equal(d.restore(snapshot),true);assert.equal(d.events.length,1);assert.equal(d.unread,1);assert.equal(d.events[0].text,'模拟委托已成交');});

test('resume waits for valid research, keeps the run and never submits while waiting',()=>{
 const d=new TradingDemo();d.start({...draft,mode:'auto'},DEFAULT_CONNECTIONS,research);d.pause();
 const id=d.session.id,cash=d.cash,orders=d.orders.length;
 assert.equal(d.resume({...research,ready:false}),null);assert.equal(d.state,'running');assert.equal(d.session.awaitingResearch,true);
 advance(d,20,{...research,ready:false});assert.equal(d.orders.length,orders);assert.equal(d.cash,cash);
 advance(d,1,{...research,revision:'r2'});assert.equal(d.session.awaitingResearch,false);assert.equal(d.session.researchRevision,'r2');assert.equal(d.session.id,id);
 advance(d,9,{...research,revision:'r2'});assert.equal(d.orders.length,1);assert.equal(d.orders[0].status,'filled');
 d.tick(.1,{...research,ready:false});assert.equal(d.state,'running');assert.equal(d.session.awaitingResearch,true);advance(d,12,{...research,ready:false});assert.equal(d.orders.length,1);
 d.pause();advance(d,10,{...research,revision:'r3'});assert.equal(d.state,'paused');assert.equal(d.orders.length,1);
});
test('resume cannot bypass an unconfirmed order or a protection lock',()=>{
 const d=new TradingDemo();d.start({...draft,mode:'auto'},DEFAULT_CONNECTIONS,research);d.orderScenario='unknown';advance(d,10);
 const count=d.orders.length,pending=d.pending.id;assert.ok(d.resume(research));assert.equal(d.orders.length,count);assert.equal(d.pending.id,pending);assert.equal(d.state,'blocked');
 const guarded=new TradingDemo();guarded.start({...draft,mode:'auto',protection:{id:'astarter'}},DEFAULT_CONNECTIONS,research);guarded.tick(.1,research);guarded.pause();guarded.capitalProtection.locked=true;assert.ok(guarded.resume(research));assert.equal(guarded.state,'paused');
});
