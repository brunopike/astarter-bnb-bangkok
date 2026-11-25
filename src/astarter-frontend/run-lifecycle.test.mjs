import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {executionRunState} from './execution-stream.mjs';
const tick=(d,n,context={ready:true})=>{for(let i=0;i<n*10;i++)d.tick(.1,context);};
function start(scenario='normal'){
 const d=new TradingDemo();d.orderScenario=scenario;assert.equal(d.start({market:'BTC/USDT',strategy:'S03',mode:'auto',amount:100,cap:500},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:1}),null);return d;
}
function holding(){const d=start();d.signal={id:'SIG-ENTRY',side:'buy',at:d.time};assert.equal(d.submit(),null);tick(d,3);return d;}
const counts=d=>[d.orders.length,d.flow.commands.length,d.flow.reservations.length,d.flow.fills.length,d.cash,d.totalFees];

test('pause and resume require no new research task, reservation or fee',()=>{
 const d=start();d.pause();const before=counts(d);assert.equal(d.resume({ready:false}),null);assert.equal(d.state,'running');assert.equal(d.session.awaitingResearch,true);tick(d,5,{ready:false});assert.deepEqual(counts(d),before);
});
test('end and keep retains ownership and prevents stale callbacks from reopening risk',()=>{
 const d=holding(),qty=d.position.qty;assert.equal(d.stop('keep','END-KEEP-1'),null);const before=counts(d);assert.equal(d.position.qty,qty);assert.equal(executionRunState(d).state,'ended-held');assert.match(d.resume({ready:true}),/已结束|接管/);assert.equal(d.stop('keep','END-KEEP-1'),null);tick(d,10);assert.deepEqual(counts(d),before);
 d.state='running';d.signal={side:'sell',intent:'open'};assert.match(d.submit(),/不再新增/);assert.deepEqual(counts(d),before);
});
test('end and exit tracks partial fills and repeated confirmation does not create another order',()=>{
 const d=holding();assert.equal(d.stop('close','END-CLOSE-1'),null);assert.equal(d.orders.length,2);tick(d,1.5);assert.equal(executionRunState(d).state,'ending');assert.ok(d.position.qty>0);const before=counts(d);assert.equal(d.stop('close','END-CLOSE-1'),null);assert.deepEqual(counts(d),before);tick(d,2);assert.equal(d.position,null);assert.equal(d.state,'stopped');assert.equal(executionRunState(d).state,'ended');assert.equal(d.orders.length,2);
});
test('unknown entry retains its original reservation until reconciled before the queued exit',()=>{
 const d=start('unknown');d.signal={id:'SIG-UNKNOWN',side:'buy',at:d.time};d.submit();tick(d,2);const held=d.flow.reservations[0].amount;assert.ok(d.stop('close','END-UNKNOWN-1'));assert.equal(executionRunState(d).state,'end-unknown');assert.equal(d.flow.reservations[0].amount,held);assert.equal(d.flow.reservations[0].state,'HELD');const before=counts(d);d.stop('close','END-UNKNOWN-1');assert.deepEqual(counts(d),before);
 d.deliverReceipt();d.reconcile();d.orderScenario='normal';tick(d,6);assert.equal(d.orders.length,2);assert.equal(d.position,null);assert.equal(d.state,'stopped');
});
test('a rejected exit remains incomplete; it needs a new explicit end request to retry',()=>{
 const d=holding();d.orderScenario='rejected';d.stop('close','END-FAIL-1');assert.equal(executionRunState(d).state,'exit-incomplete');const before=counts(d);tick(d,5);d.stop('close','END-FAIL-1');assert.deepEqual(counts(d),before);assert.ok(d.position);d.orderScenario='normal';d.stop('close','END-RETRY-2');tick(d,3);assert.equal(d.position,null);assert.equal(d.orders.length,3);
});
test('manual partial reduction does not get bought back after cancellation or resume',()=>{
 const d=holding();d.closePosition();tick(d,1.5);d.cancel();const qty=d.position.qty,before=counts(d);assert.ok(qty>0);assert.match(d.resume({ready:true}),/接管/);tick(d,30);assert.equal(d.position.qty,qty);assert.deepEqual(counts(d),before);
});
