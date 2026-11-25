import test from 'node:test';
import assert from 'node:assert/strict';
import {botParameters} from './bot-runtime.mjs';

const near=(actual,want)=>assert.ok(Math.abs(actual-want)<1e-8,`${actual} != ${want}`);
const plan=(strategy='S02',extra={})=>({id:'LOCAL-TEST',version:1,riskVersion:1,strategy,planVariant:strategy+'-SIM',market:'BTC/USDT',environment:'DEMO',executionRoute:{accountId:'SIM-01',connectionId:'local-fixture',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters(strategy,100000),simulationReference:{market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',period:'1H',closedPrice:100000,closedAt:1700000000000,asOf:1700000001000},...extra});
async function setup(state,cash=1000){
 const {ResidentBotBook}=await import('./local-sim-runtime.mjs');
 const a={cash};a.book=new ResidentBotBook({fixtureId:'runtime-fixture',state,debit(n){if(n>a.cash)return false;a.cash-=n;return true;},credit(n){a.cash+=n;return true;}});return a;
}
function tick(book,seconds,price=100000){for(let i=0;i<Math.round(seconds*10);i++)assert.ok(!book.tick(.1,{'BTC/USDT':price}).error);}
function start(a,p=plan()){const out=a.book.create(p,{requestId:'CREATE'});assert.ok(!out.error,out.error);return out.run.id;}
const view=a=>a.book.snapshot().runs[0];
const held=a=>a.book.snapshot().flow.reservations.filter(r=>r.orderId===view(a).orders[0].id&&r.state==='HELD'&&r.unit==='USDT').reduce((n,r)=>n+Number(r.amount),0);
const receipt=(a,eventId,quantity,fee,kind='partial',sequence=1)=>({runId:view(a).id,orderId:view(a).orders[0].id,eventId,kind,cumulativeQuantity:quantity,cumulativeFee:fee,sequence});
function pending(a){tick(a.book,1.5);const out=a.book.action(view(a).id,'cancel',{requestId:'CANCEL',orderId:view(a).orders[0].id,cancelScenario:'unknown'});assert.ok(!out.error,out.error);}

test('cancel request and unknown retain reservation; near cumulative receipts each settle once',async()=>{
 const a=await setup();start(a);pending(a);near(held(a),50.05);assert.equal(view(a).orders[0].status,'partial');
 assert.ok(!a.book.receiveReceipt(receipt(a,'UNKNOWN','.0005','.05','cancel-unknown')).error);
 assert.ok(!a.book.receiveReceipt(receipt(a,'P1','.00050001','.050001')).error);
 assert.ok(!a.book.receiveReceipt(receipt(a,'P2','.00050002','.050002','partial',2)).error);
 near(view(a).quantity,.00050002);near(view(a).cash,449.947998);near(view(a).fees,.050002);near(held(a),50.047998);near(view(a).freeCash,399.9);
 const before=a.book.snapshot();assert.equal(a.book.receiveReceipt(receipt(a,'P2','.00050002','.050002','partial',2)).duplicate,true);assert.deepEqual(a.book.snapshot(),before);
 assert.ok(!a.book.receiveReceipt(receipt(a,'SAME-CUMULATIVE','.00050002','.050002','partial',3)).error);
 near(view(a).cash,449.947998);near(view(a).fees,.050002);assert.equal(a.book.snapshot().flow.fills.length,3);
});

test('cancel acknowledgement accepts legitimate late cumulative fills; stale events never roll back',async()=>{
 const a=await setup();start(a);pending(a);
 assert.ok(!a.book.receiveReceipt(receipt(a,'ACK','.0005','.05','cancel-ack',10)).error);near(held(a),50.05);
 assert.ok(!a.book.receiveReceipt(receipt(a,'LATE','.00075','.075','partial',9)).error);near(view(a).quantity,.00075);near(held(a),25.025);
 assert.ok(!a.book.receiveReceipt(receipt(a,'OLD','.0004','.04','partial',8)).error);near(view(a).quantity,.00075);
 assert.ok(!a.book.receiveReceipt(receipt(a,'FINAL','.00075','.075','cancel-final',11)).error);near(held(a),0);
 const economic={cash:view(a).cash,fees:view(a).fees,quantity:view(a).quantity};
 assert.ok(!a.book.receiveReceipt(receipt(a,'DELAYED-KNOWN','.00075','.075','partial',9)).error);
 assert.deepEqual({cash:view(a).cash,fees:view(a).fees,quantity:view(a).quantity},economic);
 assert.equal(a.book.receiveReceipt(receipt(a,'CONTRADICTION','.0008','.08','partial',12)).code,'RECEIPT_CONFLICT');
 assert.deepEqual({cash:view(a).cash,fees:view(a).fees,quantity:view(a).quantity},economic);
});

test('bad identity, cumulative quantity or fee is rejected before any mutation',async()=>{
 const a=await setup();start(a);pending(a);
 for(const patch of [{cumulativeQuantity:'.001001',cumulativeFee:'.1001'},{cumulativeQuantity:'.0005',cumulativeFee:'0'},{cumulativeQuantity:.0005},{runId:'OTHER'},{orderId:'OTHER'},{eventId:'__proto__'},{unexpected:true}]){
  const before=a.book.snapshot();assert.ok(a.book.receiveReceipt({...receipt(a,'INVALID','.0005','.05'),...patch}).error);assert.deepEqual(a.book.snapshot(),before);
 }
 assert.ok(!a.book.receiveReceipt(receipt(a,'FIXED-EVENT','.0006','.06')).error);
 const before=a.book.snapshot();assert.equal(a.book.receiveReceipt(receipt(a,'FIXED-EVENT','.0007','.07')).code,'RECEIPT_CONFLICT');assert.deepEqual(a.book.snapshot(),before);
});

test('normal grid protection confirms internal cancels without client receipts and exits known inventory',async()=>{
 const a=await setup();const id=start(a,plan('S01'));tick(a.book,3);near(view(a).quantity,.001);
 assert.ok(view(a).orders.some(o=>o.side==='sell'&&o.intent==='grid-sell'));
 a.book.action(id,'pause',{requestId:'PAUSE'});tick(a.book,6,90000);
 assert.equal(view(a).status,'stopped');near(view(a).quantity,0);near(a.cash,989.81);
 assert.ok(a.book.snapshot().residentControl.receipts.some(r=>r.source==='SERVICE_FIXTURE'));
});

test('internal stop-keep cannot release cash while cancellation is unknown; legal later exit remains available',async()=>{
 const a=await setup();const id=start(a);pending(a);
 a.book.action(id,'stop-keep',{requestId:'KEEP'});tick(a.book,3);near(a.cash,500);near(view(a).returned,0);near(held(a),50.05);
 assert.ok(!a.book.receiveReceipt(receipt(a,'FINAL','.0005','.05','cancel-final',4)).error);
 assert.equal(view(a).status,'stopped');near(a.cash,949.95);near(view(a).quantity,.0005);
 assert.ok(!a.book.action(id,'close-position',{requestId:'EXIT'}).error);tick(a.book,4);near(a.cash,999.9);near(view(a).quantity,0);
});

test('restored verified inventory resumes protection without restoring new entry permission',async()=>{
 const first=await setup();start(first);tick(first.book,3);
 const a=await setup(first.book.snapshot(),first.cash);assert.equal(view(a).status,'interrupted');
 a.book.resumeProtection();assert.equal(view(a).status,'paused');tick(a.book,4,90000);
 assert.equal(view(a).status,'stopped');near(a.cash,989.81);assert.equal(view(a).orders.filter(o=>o.side==='buy').length,1);
});

test('restored receipt identities preserve no-double-settlement and reject cross-fixture control metadata',async()=>{
 const first=await setup();start(first);pending(first);first.book.receiveReceipt(receipt(first,'P1','.00050001','.050001'));first.book.receiveReceipt(receipt(first,'P2','.00050002','.050002','partial',2));
 const a=await setup(first.book.snapshot(),first.cash);a.book.resumeProtection();const before=a.book.snapshot();
 assert.equal(a.book.receiveReceipt(receipt(a,'P2','.00050002','.050002','partial',2)).duplicate,true);assert.deepEqual(a.book.snapshot(),before);near(held(a),50.047998);
 const bad=first.book.snapshot();bad.residentControl.fixtureId='OTHER';await assert.rejects(setup(bad,first.cash));
});

test('older cancel status cannot regress acknowledgement or stop service finality, but new cumulative fills still apply',async()=>{
 const a=await setup();start(a);tick(a.book,1.5);
 assert.ok(!a.book.action(view(a).id,'cancel',{requestId:'CANCEL',orderId:view(a).orders[0].id}).error);
 assert.ok(!a.book.receiveReceipt(receipt(a,'NEW-ACK','.0005','.05','cancel-ack',10)).error);
 const old=a.book.receiveReceipt(receipt(a,'OLD-UNKNOWN','.0005','.05','cancel-unknown',9));
 assert.equal(old.ignoredStale,true);assert.equal(a.book.snapshot().residentControl.cancelRequests[0].state,'ACKNOWLEDGED');
 assert.ok(!a.book.receiveReceipt(receipt(a,'OLD-STATE-NEW-FILL','.00075','.075','cancel-unknown',8)).error);
 near(view(a).quantity,.00075);near(held(a),25.025);assert.equal(a.book.snapshot().residentControl.cancelRequests[0].state,'ACKNOWLEDGED');
 tick(a.book,1);near(held(a),0);assert.equal(view(a).orders[0].status,'partial-cancelled');
 const final=a.book.snapshot().residentControl.receipts.find(r=>r.source==='SERVICE_FIXTURE'&&r.kind==='cancel-final');assert.ok(final.sequence>10);
});

test('sell-final contradiction holds existing competing exits while unrelated protection keeps running',async()=>{
 const a=await setup(),id=start(a),other=a.book.create(plan('S02',{id:'OTHER'}),{requestId:'OTHER-CREATE'}).run.id;tick(a.book,3);
 a.book.action(id,'stop-close',{requestId:'CLOSE'});tick(a.book,1.5);const first=view(a).orders.find(row=>row.intent==='close');near(first.filled,.5);
 a.book.action(id,'cancel',{requestId:'CANCEL-SELL',orderId:first.id,cancelScenario:'unknown'});
 const message={runId:id,orderId:first.id,eventId:'SELL-FINAL',kind:'cancel-final',cumulativeQuantity:'.0005',cumulativeFee:'.05',sequence:10};assert.ok(!a.book.receiveReceipt(message).error);
 const second=view(a).orders.filter(row=>row.intent==='close').at(-1);assert.notEqual(second.id,first.id);
 assert.equal(a.book.receiveReceipt({...message,eventId:'SELL-CONFLICT',kind:'partial',cumulativeQuantity:'.0008',cumulativeFee:'.08',sequence:11}).code,'RECEIPT_CONFLICT');
 a.book.action(other,'stop-close',{requestId:'OTHER-CLOSE'});tick(a.book,4);
 near(view(a).orders.find(row=>row.id===second.id).filled,0);near(view(a).quantity,.0005);assert.equal(a.book.snapshot().runs.find(run=>run.id===other).status,'stopped');
 const before={cash:view(a).cash,quantity:view(a).quantity,fees:view(a).fees};
 assert.equal(a.book.receiveReceipt({...message,orderId:second.id,eventId:'COMPETING-FILL',kind:'filled',sequence:12}).code,'RECONCILIATION_REQUIRED');assert.deepEqual({cash:view(a).cash,quantity:view(a).quantity,fees:view(a).fees},before);
});

test('sell-final contradiction forbids a new close against already disputed remaining inventory',async()=>{
 const a=await setup(),id=start(a);tick(a.book,3);a.book.action(id,'stop-close',{requestId:'CLOSE'});tick(a.book,1.5);
 const first=view(a).orders.find(row=>row.intent==='close');a.book.action(id,'cancel',{requestId:'CANCEL-SELL',orderId:first.id,cancelScenario:'unknown'});a.book.action(id,'stop-keep',{requestId:'KEEP'});
 const message={runId:id,orderId:first.id,eventId:'SELL-FINAL',kind:'cancel-final',cumulativeQuantity:'.0005',cumulativeFee:'.05',sequence:10};assert.ok(!a.book.receiveReceipt(message).error);assert.equal(view(a).status,'stopped');near(view(a).quantity,.0005);
 assert.equal(a.book.receiveReceipt({...message,eventId:'SELL-CONFLICT',kind:'partial',cumulativeQuantity:'.0008',cumulativeFee:'.08',sequence:11}).code,'RECEIPT_CONFLICT');const count=view(a).orders.length;
 assert.equal(a.book.action(id,'close-position',{requestId:'POST-CONFLICT-EXIT'}).code,'RECONCILIATION_REQUIRED');assert.equal(view(a).orders.length,count);tick(a.book,4);near(view(a).quantity,.0005);
});
