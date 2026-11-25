import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {ExecutionRecords,sumAmounts} from './execution-records.mjs';

test('receipt keys retain distinct fine cumulative fills without changing legacy IDs',()=>{
 const records=new ExecutionRecords(),order={id:'FINE',qty:1,price:100,filled:0,side:'buy',market:'ETH/USDT'};
 const first=records.recordFill(order,.50001,1,'a'.repeat(64));assert.ok(first);order.filled=.50001;
 const second=records.recordFill(order,.50002,2,'b'.repeat(64));assert.ok(second);order.filled=.50002;
 assert.equal(records.data.fills.length,2);assert.equal(second.fill.quantity,'0.00001');assert.equal(records.totals.cashDelta,'-50.002');
 const before=structuredClone(records.data);assert.equal(records.recordFill(order,.50003,3,'b'.repeat(64)),null);assert.deepEqual(records.data,before);
 const restored=new ExecutionRecords(records.data);assert.equal(restored.recordFill(order,.50003,3,'b'.repeat(64)),null);assert.deepEqual(restored.data,before);
 const legacy=new ExecutionRecords();assert.equal(legacy.recordFill({...order,filled:0},.5,1).fill.id,'FILL-FINE-5000');
});
test('receipt fill key validation rejects invalid input before any ledger write',()=>{
 const records=new ExecutionRecords(),order={id:'BAD',qty:1,price:100,filled:0,side:'buy',market:'ETH/USDT'},before=structuredClone(records.data);
 for(const key of ['',null,1,'a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'<'.repeat(64)]){
  assert.throws(()=>records.recordFill(order,.5,1,key),/INVALID_RECEIPT_KEY/);assert.deepEqual(records.data,before);
 }
});
import {ExecutionFeed,StreamProjection,DEFAULT_SCOPE,scopeKey,executionRunIdentity,executionRunState,runActionError,scopeExecutionRecords,executionRenderStamp} from './execution-stream.mjs';
import {executionActionFeedback,executionActionError,executionView} from './execution-views.mjs';

test('the embedded account view uses the same canonical allocation and native order projection',async()=>{
 const {executionAccountView}=await import('./execution-views.mjs');assert.equal(typeof executionAccountView,'function');
 const d=new TradingDemo();d.cash=9000;d.botSummary={cash:400,inventoryValue:600,equity:1000,fees:1};
 d.accountSummary={accountId:'SIM-01',available:9000};d.botBook={runs:[{id:'BOT-ONLY',plan:{strategy:'S02',market:'ETH/USDT',executionRoute:{accountId:'SIM-01'}},quantity:2,costBasis:500,markPrice:300,inventoryValue:600,orders:[{id:'BOT-ORDER',runId:'BOT-ONLY',accountId:'SIM-01',market:'ETH/USDT',side:'buy',qty:2,filled:.5,price:250,fee:.25,status:'partial'}]}]};
 const before=JSON.stringify(d),holdings=executionAccountView(d),orders=executionAccountView(d,'orders');
 assert.match(holdings,/10,000/);assert.match(holdings,/9,000/);assert.match(holdings,/400/);assert.match(holdings,/600/);assert.match(holdings,/data-account-positions/);assert.match(holdings,/BOT-ONLY/);
 assert.match(orders,/data-account-orders/);assert.match(orders,/<small>BOT-ORDER<\/small>/);assert.equal((orders.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g)||[]).length,1);assert.match(orders,/data-order-id="BOT-ORDER" data-id="BOT-ONLY"/);assert.match(orders,/Part filled|部分成交/);assert.equal(JSON.stringify(d),before);
 d.connections={spotBook:{symbol:'BTCUSDT',usdt:9.91,usdtLocked:0,btc:0.00035964,btcPrice:56000,orders:[],history:[{orderId:'68874446964',side:'BUY',type:'LIMIT_MAKER',price:'56251.89',origQty:'0.00009',executedQty:'0.00009',status:'FILLED',time:1763700000000,strategy:'S01',clientOrderId:'astarter-s01-20261121-1'},{orderId:'68871608690',side:'BUY',type:'MARKET',price:'0',origQty:'0.00008',executedQty:'0.00008',status:'FILLED',time:1763690000000}]}};
 const {accountContextLabel}=await import('./execution-views.mjs');
 const live=executionAccountView(d,'orders');
 assert.match(live,/68874446964/);assert.match(live,/策略|Strategy/);assert.match(live,/>S01</);assert.match(live,/历史委托|Order history/);assert.match(live,/当前没有挂单|No open orders/);assert.match(live,/9\.91/);assert.match(live,/30\.04984/);assert.doesNotMatch(live,/10,000/);assert.equal(live.includes('astarter-s01'),false);assert.match(live,/BOT-ORDER/);
 assert.equal(accountContextLabel('SIM-01','DEMO',d.connections.spotBook),'PRO · 币安现货');assert.equal(accountContextLabel('SIM-01','DEMO',null),'SIM-01 · DEMO');
 d.connections.spotBook.orders=[{orderId:'68949351615',side:'BUY',type:'LIMIT_MAKER',price:'58418.19',origQty:'0.00012',executedQty:'0',status:'NEW',time:1763800000000,strategy:'S01'},{orderId:'700',side:'BUY',type:'LIMIT_MAKER',price:'1',origQty:'0.0001',executedQty:'0',status:'NEW',time:1763800000000}];
 const open=executionAccountView(d,'orders');
 assert.equal((open.match(/data-biz="cancel-spot-order"/g)||[]).length,1);
 assert.match(open,/data-id="68949351615"/);assert.match(open,/撤销|Cancel/);assert.equal(open.includes('data-id="700"'),false);
});
const run=(scenario='normal')=>{const d=new TradingDemo();d.orderScenario=scenario;assert.equal(d.start({market:'BTC/USDT',strategy:'S03',mode:'confirm',amount:100,cap:500},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'r1'}),null);d.signal={id:'SIG-TEST',side:'buy',at:d.time};return d;};
const tick=(d,n)=>{for(let i=0;i<n*10;i++)d.tick(.1);};
const snapshot=d=>JSON.parse(JSON.stringify({...d,flow:d.flow}));
test('pausing describes new entries while leaving an existing order and holding visible',()=>{
 const before={state:'running',pending:{id:'O1',status:'submitted'}},after={...before,state:'paused'};
 const pending=executionActionFeedback('pause',before,after);assert.match(pending.message,/暂停新增|New entries paused/);assert.match(pending.message,/原订单|existing order/i);
 const unknown=executionActionFeedback('pause',before,{...after,pending:{id:'O1',status:'unknown'}});assert.match(unknown.message,/待确认|unconfirmed/i);assert.equal(unknown.orderId,'O1');
 const held=executionActionFeedback('pause',{}, {state:'paused',position:{qty:1}});assert.match(held.message,/持仓保留|remains open/i);assert.match(held.message,/暂停新增|New entries paused/);
});
test('order recovery reports confirmed terminal outcomes instead of asking the user to keep waiting',()=>{
 const before={pending:{id:'O1',status:'unknown'}};
 for(const [status,expected,tone]of [['filled',/已成交|filled/i,'success'],['cancelled',/已撤销|cancelled/i,'success'],['partial-cancelled',/已成交部分保留|confirmed fills/i,'success'],['rejected',/未成交|rejected/i,'error']]){
  const feedback=executionActionFeedback('reconcile',before,{pending:null,orders:[{id:'OTHER',status:'filled'},{id:'O1',status}]});
  assert.match(feedback.message,expected);assert.equal(feedback.tone,tone);assert.equal(feedback.orderId,'O1');assert.doesNotMatch(feedback.message,/继续等待|Waiting for its fill/i);
 }
 const nextOrder=executionActionFeedback('reconcile',before,{pending:{id:'O2',status:'submitted'},orders:[{id:'O2',status:'submitted'},{id:'O1',status:'filled'}]});assert.equal(nextOrder.orderId,'O1');assert.equal(nextOrder.tone,'success');assert.match(nextOrder.message,/已成交|filled/i);
 const missing=executionActionFeedback('reconcile',before,{pending:null,orders:[{id:'OTHER',status:'filled'}]});assert.doesNotMatch(missing.message,/订单已成交|order filled/i);assert.equal(missing.tone,'info');
});
test('an old stopped state with an unknown order cannot announce a completed empty run',()=>{
 const feedback=executionActionFeedback('stop',{}, {state:'stopped',session:{id:'R1'},pending:{id:'O1',status:'unknown'}});
 assert.equal(feedback.tone,'info');assert.match(feedback.message,/待确认|unconfirmed/i);assert.equal(feedback.orderId,'O1');assert.doesNotMatch(feedback.message,/没有持仓|No open position/);
});
test('legacy confirm mode is displayed as its real execution mode without migrating or re-enabling the run',()=>{
 const data=snapshot(run()),before=JSON.stringify(data),html=executionView({data,status:{state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}}}),mode=html.match(/<dt>(?:交易方式|Execution mode)[\s\S]*?<\/dt><dd>(.*?)<\/dd>/)?.[1];
 assert.match(mode||'',/^(旧设置 · 逐笔批准|Legacy · approve entries)$/);assert.equal(data.session.mode,'confirm');assert.equal(JSON.stringify(data),before);
});
test('action feedback distinguishes submission, original-order recovery, cancellation and retained holdings',()=>{
 const d=run('unknown');let before=snapshot(d);d.submit();let message=executionActionFeedback('confirm',before,snapshot(d));
 assert.match(message.message,/已提交|submitted/);assert.equal(message.tone,'info');assert.equal(message.orderId,d.pending.id);assert.doesNotMatch(message.message,/已成交|filled successfully/i);
 tick(d,2);before=snapshot(d);const waiting=executionActionFeedback('reconcile',before,snapshot(d));assert.match(waiting.message,/等待确认|unconfirmed/);const operation=d.pending.operationId;assert.match(executionActionError(d.reconcile()),/不要重复下单|do not resubmit/);assert.match(executionActionError(d.cancel()),/先查询结果|Check its result/);
 d.deliverReceipt();assert.equal(d.reconcile(),null);message=executionActionFeedback('reconcile',before,snapshot(d));assert.match(message.message,/原订单|Original order/);assert.equal(d.pending.operationId,operation);assert.equal(d.orders.length,1);
 tick(d,.5);before=snapshot(d);assert.ok(before.pending.filled>0);assert.equal(d.cancel(),undefined);message=executionActionFeedback('cancel',before,snapshot(d));assert.match(message.message,/剩余|remainder/);assert.equal(message.orderId,before.pending.id);assert.ok(d.position);
 before=snapshot(d);d.stop();message=executionActionFeedback('stop',before,snapshot(d));assert.match(message.message,/持仓保留|remains open/);assert.equal(d.orders.length,1);assert.ok(d.position);
 assert.equal(executionActionFeedback('confirm',{}, {state:'blocked'}),null);
});
test('A19 each failed admission records evidence without a command, order or reservation',()=>{
 for(const scenario of ['risk-reject','mandate-expired','reservation-conflict','protection-invalid']){const d=run(scenario);assert.ok(d.submit());assert.equal(d.flow.plans.length,1);assert.equal(d.flow.admissions[0].state,'BLOCKED');assert.ok(d.flow.admissions[0].evidenceId);assert.equal(d.flow.commands.length,0);assert.equal(d.flow.reservations.length,0);assert.equal(d.orders.length,0);assert.equal(d.cash,10000);assert.ok(d.submit());}
});
test('signal, plan, admission, command, order and fill have independent linked identities',()=>{
 const d=run();d.submit();tick(d,3);const o=d.orders[0],p=d.flow.plans[0],a=d.flow.admissions[0],c=d.flow.commands[0],fills=d.flow.fills;
 assert.equal(p.signalId,'SIG-TEST');assert.equal(a.planId,p.id);assert.equal(o.planId,p.id);assert.equal(c.id,o.commandId);assert.equal(c.idempotencyKey,o.idempotencyKey);assert.equal(fills.length,2);assert.ok(fills.every(f=>f.orderId===o.id));assert.equal(new Set([p.signalId,p.id,a.id,c.id,o.id,...fills.map(f=>f.id)]).size,7);
});
test('A20 each partial fill changes target before protection acknowledgement',()=>{
 const d=run('protection-delay');d.submit();tick(d,1.5);let p=d.flow.protections[0];assert.equal(p.state,'PENDING');assert.equal(Number(p.targetQuantity),Number(d.position.qty.toFixed(12)));assert.equal(p.confirmedQuantity,'0');assert.ok(Number(p.uncoveredQuantity)>0);
 const first=Number(p.targetQuantity);assert.equal(d.records.protectionReceipt(p.id,first,d.time,'ACTIVE',99),false);d.records.protectionReceipt(p.id,first,d.time,'ACTIVE',p.fenceRevision);tick(d,1.3);p=d.flow.protections[0];assert.equal(p.state,'PENDING');assert.ok(Number(p.targetQuantity)>Number(p.confirmedQuantity));assert.ok(Number(p.pendingQuantity)>0);assert.equal(d.flow.ledger.filter(x=>x.type==='TRADE_CASH').length,2);d.deliverProtection();assert.equal(p.state,'ACTIVE');assert.equal(p.uncoveredQuantity,'0');
});
test('A20 impaired protection blocks new risk while permitting owned exit',()=>{
 const d=run('protection-impaired');d.submit();tick(d,4);assert.equal(d.state,'blocked');assert.equal(d.flow.protections[0].state,'IMPAIRED');assert.ok(d.position);d.pause();assert.match(d.resume({ready:true}),/保护/);assert.equal(d.closePosition(),null);
});
test('A21 replay and late fee correction update the same cash ledger only once',()=>{
 const d=run('late-fee');d.submit();tick(d,3);const qty=d.position.qty;assert.equal(d.totalFees,0);assert.equal(d.flow.fills.length,2);d.replayFill();assert.equal(d.position.qty,qty);assert.equal(d.flow.fills.length,2);d.deliverFees();const cash=d.cash;d.deliverFees();assert.equal(d.cash,cash);assert.ok(Math.abs(d.cash-(10000+Number(d.records.totals.cashDelta)))<1e-8);const fill=d.flow.fills[0];d.applyFee(fill.id,.06,2);assert.ok(Math.abs(d.totalFees-.11)<1e-9);assert.equal(d.flow.ledger.filter(l=>l.fillId===fill.id&&l.type==='FEE').length,1);assert.equal(d.flow.ledger.find(l=>l.fillId===fill.id&&l.type==='FEE').revision,2);
});
test('funding events are separate, scoped to derivatives and exact decimal totals',()=>{
 const r=new ExecutionRecords();assert.equal(r.cost({sourceId:'F-1',amount:-.2,type:'FUNDING',at:1}),null);assert.equal(r.cost({sourceId:'F-1',accountId:'SIM-PERP',amount:-.2,type:'FUNDING',at:1,marketType:'PERPETUAL'}),-.2);assert.equal(r.cost({sourceId:'F-1',amount:-.2,type:'FUNDING',at:2,marketType:'PERPETUAL'}),null);assert.equal(r.totals.funding,'-0.2');assert.equal(sumAmounts(['0.1','0.2','-0.3']),'0');
});
test('A22 refresh, duplicate submit and read queries keep original identity and unknown funds',()=>{
 const d=run('unknown');d.submit();tick(d,2);const o=d.orders[0],key=o.idempotencyKey,res=d.flow.reservations[0].amount;assert.match(d.reconcile(),/仍待核对/);assert.ok(d.submit());const restored=new TradingDemo();restored.restore(snapshot(d));assert.equal(restored.pending.idempotencyKey,key);assert.equal(restored.pending.operationId,o.operationId);assert.equal(restored.pending.clientOrderId,o.clientOrderId);assert.equal(restored.flow.reservations[0].amount,res);assert.match(restored.reconcile(),/仍待核对/);assert.equal(restored.orders.length,1);assert.equal(restored.flow.commands.length,1);restored.deliverReceipt();assert.equal(restored.reconcile(),null);assert.equal(restored.pending.id,o.id);tick(restored,2);assert.equal(restored.orders.length,1);assert.ok(restored.position);
});
test('A23 snapshot watermark and buffered new fills converge without dropping or replaying them',()=>{
 const d=run(),f=new ExecutionFeed();f.publish(snapshot(d));f.disconnect();d.submit();f.publish(snapshot(d));f.fault('expired');tick(d,1.5);f.publish(snapshot(d));f.tick(1);assert.equal(f.status.state,'LIVE');assert.equal(f.data.orders[0].status,'partial');assert.equal(f.data.flow.fills.length,1);tick(d,1.5);f.publish(snapshot(d));assert.equal(f.data.flow.fills.length,2);assert.equal(f.data.cash,d.cash);assert.notEqual(f.status.snapshotCursor,f.status.resumeCursor);
});
test('A23 account generations reject both old successes and failures; entity revisions do not regress',()=>{
 const p=new StreamProjection(DEFAULT_SCOPE),old=p.ticket(),hash=scopeKey(DEFAULT_SCOPE);p.install({snapshotId:'s1',scopeHash:hash,sequence:0,cursor:'stream:0',asOf:0,data:{o:{revision:4,state:'FILLED'}}},old);
 p.receive({eventId:'e1',scopeHash:hash,sequence:1,cursor:'stream:1',asOf:1,entityKey:'o',entity:{revision:2,state:'ACCEPTED'}});assert.equal(p.entities.o.state,'FILLED');p.listCursor='list:20';assert.equal(p.resumeCursor,'stream:1');p.switchScope({...DEFAULT_SCOPE,accountId:'SIM-02'});assert.equal(p.install({scopeHash:hash,data:{o:{revision:9}}},old),false);assert.equal(p.fail(old),false);assert.deepEqual(p.entities,{});assert.equal(p.generation,2);
});
test('A24 failed snapshot retains stale data and retry is a read without a new command',()=>{
 const d=run(),f=new ExecutionFeed();d.submit();f.publish(snapshot(d));const cash=f.data.cash,command=d.orders[0].commandId;f.fault('snapshot-fail');tick(d,3);f.publish(snapshot(d));f.tick(1);assert.equal(f.status.state,'STALE');assert.equal(f.data.cash,cash);assert.ok(d.position);assert.equal(d.flow.protections[0].targetQuantity,Number(d.position.qty).toFixed(12).replace(/\.?0+$/,''));f.fault('retry');f.tick(1);assert.equal(f.status.state,'LIVE');assert.equal(f.data.cash,d.cash);assert.equal(d.orders[0].commandId,command);assert.equal(d.orders.length,1);
});

test('setup precheck binds account, draft and budget; expiry or change requires a fresh check',async()=>{
 const {WorkspaceSim}=await import('./workspace-sim.mjs');const w=new WorkspaceSim();const v=w.validateSetup().run;assert.ok(v.configurationHash);for(let i=0;i<25;i++)w.tick(.2);assert.equal(w.setupReady.id,v.id);w.setBudget({daily:220});assert.equal(w.setupReady,null);w.setBudget({daily:200});assert.ok(w.setupReady);w.s.clock=v.expiresAt;assert.equal(w.setupReady,null);w.setSetupContext('okx');assert.ok(w.validateSetup().error);assert.ok(w.checkStart(w.draft()));
});
test('protection and fee jobs share actual receipts without mutating execution or credits',async()=>{
 const {WorkspaceSim}=await import('./workspace-sim.mjs');const {BusinessMotion}=await import('./business-motion.mjs');const w=new WorkspaceSim(),motion=new BusinessMotion(),d=run('protection-impaired');motion.update(w,snapshot(d));d.submit();tick(d,4);const before=JSON.stringify(snapshot(d)),credits=w.s.credits,jobs=motion.update(w,snapshot(d));assert.ok(jobs.some(j=>j.protectionId===d.flow.protections[0].id&&j.badge==='保护异常'));assert.ok(jobs.some(j=>j.ledgerId));assert.equal(JSON.stringify(snapshot(d)),before);assert.equal(w.s.credits,credits);assert.equal(new Set(jobs.flatMap(j=>j.roles)).size,jobs.flatMap(j=>j.roles).length);
});

test('unconfirmed protection times out visibly and actual insufficient funds retains blocked admission',()=>{
 const delayed=run('protection-delay');delayed.submit();tick(delayed,8);assert.equal(delayed.flow.protections[0].state,'UNKNOWN');assert.equal(delayed.state,'blocked');const limited=run();limited.cash=20;assert.ok(limited.submit());assert.equal(limited.flow.admissions[0].state,'BLOCKED');assert.equal(limited.flow.commands.length,0);
});
test('detail links never resolve a missing plan to an unrelated legacy order',async()=>{
 const {flowDetail,ledgerPanel}=await import('./execution-views.mjs');const d=run();d.submit();tick(d,3);d.orders.push({id:'LEGACY'});const protection=d.flow.protections[0],detail=flowDetail(snapshot(d),'protections',protection.id);assert.ok(detail.body.includes(`data-id="${d.orders[0].id}"`));assert.ok(!detail.body.includes('data-id="LEGACY"'));assert.ok(ledgerPanel(snapshot(d),{query:'MISSING'}).includes('0</strong>'));assert.ok(flowDetail(snapshot(d),'signals','SIG-TEST').body.includes('TRIGGERED'));
});


test('execution activity groups notional by currency and preserves confirmed fills',async()=>{
 const {executionActivity}=await import('./execution-views.mjs');
 const d={flow:{fills:[{notional:'10.1',currency:'USDT',executedAt:1},{notional:'20.2',currency:'USDC',executedAt:2},{notional:'0.2',currency:'USDT',executedAt:3}]}},before=JSON.stringify(d);
 assert.deepEqual(executionActivity(d),{currency:'USDT',fillCount:3,total:'10.3',values:[10.1,.2],labels:['第 1 笔','第 2 笔']});
 assert.equal(JSON.stringify(d),before);
 assert.deepEqual(executionActivity(null),{currency:'USDT',fillCount:0,total:'0',values:[],labels:[]});
 const history={flow:{fills:Array.from({length:30},(_,i)=>({notional:String(i+1),currency:'USDT',executedAt:75000+i}))}};
 const activity=executionActivity(history);assert.equal(activity.labels[0],'第 7 笔');assert.equal(activity.labels.at(-1),'第 30 笔');assert.equal(activity.values[0],7);
});
test('execution activity uses actual partial fills instead of the intended order amount',async()=>{
 const {executionActivity}=await import('./execution-views.mjs');
 const d=run();d.submit();tick(d,1.5);
 assert.equal(d.orders.length,1);assert.equal(executionActivity(d).fillCount,1);
 assert.equal(Number(executionActivity(d).total),50);
 tick(d,2);assert.equal(executionActivity(d).fillCount,2);assert.equal(Number(executionActivity(d).total),100);
});

test('an armed strategy remains visible as watching and cannot look like a fresh unconfigured run',async()=>{
 const {executionView}=await import('./execution-views.mjs');const d=new TradingDemo();
 const html=executionView({data:{...d,flow:d.flow,discovery:{armed:true}},status:{state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0},watchingDraft:{name:'均线＋RSI（冻结原版）',cap:500,amount:100}});
 assert.ok(html.includes('等待机会'));assert.ok(html.includes('data-biz="disarm"'));
 assert.equal(html.includes('data-biz="restart-setup"'),false);assert.ok(html.includes('500 USDT'));
 assert.equal(d.orders.length,0);
});

test('stopping with holdings directs the user to protection instead of another setup flow',async()=>{
 const {executionView}=await import('./execution-views.mjs');const d=run();d.submit();tick(d,3);d.stop();
 const html=executionView({data:d,status:{state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0}});
 assert.ok(html.includes('class="execution-protection-detail"'));assert.ok(html.includes('id="contract-protection"'));assert.match(html,new RegExp(`data-biz="go" data-id="risk" data-run-id="${d.session.id}"`));assert.equal(html.includes('data-biz="restart-setup"'),false);
 assert.ok(d.position);assert.equal(d.orders.length,1);
});

test('unknown submissions do not claim there is no position and offer the original-result query',async()=>{
 const {protectionPanel}=await import('./execution-views.mjs');const d=run('unknown');d.submit();tick(d,2);
 const html=protectionPanel(d);assert.ok(html.includes('交易结果待确认'));assert.ok(html.includes('data-id="reconcile"'));
 assert.equal(html.includes('当前没有持仓'),false);assert.equal(d.orders.length,1);
});
test('completed zero coverage becomes a compact empty position without losing its record',async()=>{
 const {protectionPanel}=await import('./execution-views.mjs');const d=run();d.submit();tick(d,3);d.closePosition();tick(d,3);
 const html=protectionPanel(d);assert.ok(html.includes('当前没有持仓'));assert.equal(html.includes('coverage-grid'),false);
 assert.ok(html.includes(d.flow.protections[0].id));
});
test('current fund holds stay visible while released reservations move into history',async()=>{
 const {executionView}=await import('./execution-views.mjs'),status={state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0};
 const unknown=run('unknown');unknown.submit();tick(unknown,2);
 const pending=executionView({data:unknown,status});
 assert.ok(pending.includes('100.1 USDT'));assert.equal(pending.includes('当前没有在途资金占用。'),false);
 const complete=run();complete.submit();tick(complete,3);
 const history=executionView({data:complete,status});
 assert.ok(history.includes('当前没有在途资金占用。'));assert.ok(history.includes('<details class="execution-reservation-history">'));
 for(const r of complete.flow.reservations)assert.ok(history.includes(r.id));
});


test('result navigation keeps startup credits separate from filled notional and preserves unknown cost',async()=>{
 const {executionView}=await import('./execution-views.mjs'),d=run();d.submit();tick(d,3);
 const before=JSON.stringify(snapshot(d)),status={state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0};
 const html=executionView({data:d,status,credits:{start:0,quote:0}});
 const strip=html.match(/<section class="execution-followup">([\s\S]*?)<\/section>/)[1];
 assert.ok(strip.includes('0 AI 积分'));assert.ok(strip.includes('历史启动记录'));assert.ok(strip.includes('旧版记录'));assert.ok(strip.includes('data-id="assets"'));assert.ok(strip.includes('data-id="usage"'));assert.equal(strip.includes('data-commerce-context'),false);
 assert.equal(strip.includes('100 AI 积分'),false);assert.equal(JSON.stringify(snapshot(d)),before);
 const unknown=executionView({data:d,status,credits:{start:null,quote:0}}).match(/<section class="execution-followup">([\s\S]*?)<\/section>/)[1];
 assert.ok(unknown.includes('<b>—</b>'));assert.equal(unknown.includes('0 AI 积分'),false);
});


test('first-run view removes empty statistics but never collapses an unknown order or holding',()=>{
 const status={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'},lastSyncedAt:0};
 const blank=executionView({data:snapshot(new TradingDemo()),status});
 assert.match(blank,/选择 Agent，开始运行|Choose an Agent to start/);assert.doesNotMatch(blank,/<section class="execution-summary"/);assert.match(blank,/data-biz="go" data-id="advisor"/);assert.match(blank,/data-biz="go" data-id="strategies"/);assert.doesNotMatch(blank,/execution-position-empty/);
 const unknown=run('unknown');unknown.submit();tick(unknown,2);const view=executionView({data:snapshot(unknown),status});
 assert.match(view,/<section class="execution-summary"/);assert.match(view,/data-id="reconcile"/);assert.match(view,/contract-attention/);assert.doesNotMatch(view,/execution-position" hidden/);assert.doesNotMatch(view,/execution-first-note/);
 const holding=run();holding.submit();tick(holding,3);const active=executionView({data:snapshot(holding),status});assert.doesNotMatch(active,/execution-position" hidden/);assert.match(active,/data-id="close"/);
});

test('legacy confirmation runs route to explicit migration, never to a manual entry button',()=>{
 const status={state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:160000},data=run();
 data.signal={side:'buy',id:'S-legacy'};data.session.mode='confirm';
 const before=JSON.stringify(data),html=executionView({data,status});
 assert.match(html,/旧运行需要更新设置|Legacy run needs updated settings/);
 assert.doesNotMatch(html,/data-id="confirm"|data-id="skip"/);assert.match(html,/data-id="stop"/);
 assert.doesNotMatch(html,/2666:|44:26:/);assert.equal(JSON.stringify(data),before);
 for(const state of ['paused','blocked']){
  data.state=state;const legacy=executionView({data,status,researchReview:{ready:true}});
  assert.doesNotMatch(legacy,/data-id="resume"|data-id="pause"|data-biz="review-research"/);
  assert.equal((legacy.match(/data-id="stop"/g)||[]).length,1);
 }
});

test('completed one-shot routes to strategy setup while open orders and positions retain protection access',()=>{
 const status={state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0},finished=run();finished.session.singleShot=true;finished.stop();
 const html=executionView({data:finished,status});
 assert.match(html,/data-biz="restart-setup"/);assert.doesNotMatch(html,/data-biz="review-position"/);
 const pending=run('unknown');pending.submit();tick(pending,2);pending.session.singleShot=true;
 const holding=run();holding.submit();tick(holding,3);holding.session.singleShot=true;
 for(const data of [pending,holding]){
  const view=executionView({data,status});assert.match(view,/class="execution-protection-detail"/);assert.match(view,/id="contract-protection"/);assert.match(view,new RegExp(`data-biz="go" data-id="risk" data-run-id="${data.session.id}"`));assert.doesNotMatch(view,/data-biz="restart-setup"/);
 }
});

test('waiting strategy shows the selected execution permission before any order exists',()=>{
 const status={state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0};
 for(const [mode,label] of [['auto','自动执行'],['review','入场前先批准'],['signal','只研究与提醒']]){
  const data=snapshot(new TradingDemo());data.discovery={armed:true};
  const html=executionView({data,status,watchingDraft:{name:'Test',mode,amount:10,cap:300}});
  const facts=html.match(/<dl class="execution-strategy-facts">([\s\S]*?)<\/dl>/)[1];
  assert.ok(facts.includes(label));assert.equal(data.orders.length,0);
 }
});

test('new opportunity monitoring uses its draft rather than a completed trade session',()=>{
 const old=run();old.stop();const data={...snapshot(old),discovery:{armed:true},strategyIssue:'old protection mismatch'};
 const before=JSON.stringify(data),html=executionView({data,status:{state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0},watchingDraft:{name:'New BTC strategy',market:'BTC/USDT',mode:'review',amount:45,cap:1000},credits:{start:4,quote:0}});
 const facts=html.match(/<dl class="execution-strategy-facts">([\s\S]*?)<\/dl>/)[1];
 assert.match(facts,/BTC\/USDT/);assert.match(facts,/45 USDT/);assert.match(facts,/1,000 USDT/);assert.match(facts,/入场前先批准/);assert.doesNotMatch(facts,/ETH\/USDT|100 USDT|500 USDT/);
 assert.doesNotMatch(html,/old protection mismatch/);assert.equal(html.includes('本次启动'),false);assert.equal(html.includes('历史启动记录'),false);assert.equal(html.includes('data-commerce-context'),false);assert.equal(JSON.stringify(data),before);
});


test('run controls bind account, run and approved version instead of the currently viewed symbol',()=>{
 const d=run();d.submit();tick(d,3);const data=snapshot(d),status={state:'LIVE',scope:DEFAULT_SCOPE},identity=executionRunIdentity(data,DEFAULT_SCOPE),before=JSON.stringify(data);
 assert.equal(identity.accountId,'SIM-01');assert.equal(identity.source,'BOT');assert.equal(identity.strategyVersion,1);assert.equal(runActionError(identity,data,status),null);
 assert.equal(runActionError({...identity,accountId:'SIM-02'},data,status),'RUN_CHANGED');assert.equal(runActionError({...identity,runId:'OTHER'},data,status),'RUN_CHANGED');assert.equal(runActionError({...identity,strategyVersion:2},data,status),'RUN_CHANGED');
 assert.equal(runActionError(identity,data,{...status,scope:{...DEFAULT_SCOPE,accountId:'SIM-02'}}),'ACCOUNT_CHANGED');
 const html=executionView({data,status});assert.ok(html.includes(`data-run-id="${identity.runId}"`));assert.ok(html.includes('data-run-account="SIM-01"'));assert.ok(html.includes('策略版本 1'));assert.ok(html.indexOf('execution-workspace')<html.indexOf('data-trading-chart'));
 assert.equal(JSON.stringify(data),before);
});
test('an entry approval keeps its signal id and the account and run that created it',()=>{
 const d=new TradingDemo(),context={ready:true,market:'BTC/USDT',revision:'research:1',price:81218.87};
 assert.equal(d.start({strategy:'S03',market:'BTC/USDT',mode:'review',amount:100,cap:500,version:1},DEFAULT_CONNECTIONS,context),null);
 for(let i=0;i<50;i++)d.tick(.1,context);
 assert.ok(d.signal?.approval);
 const html=executionView({data:snapshot(d),status:{state:'LIVE',scope:DEFAULT_SCOPE}}),buttons=[...html.matchAll(/<button[^>]+data-biz="approval-(?:accept|skip)"[^>]*>/g)];
 assert.equal(buttons.length,2);
 for(const [button]of buttons){assert.ok(button.includes(`data-id="${d.signal.id}"`));assert.ok(button.includes(`data-run-id="${d.session.id}"`));assert.ok(button.includes('data-run-account="SIM-01"'));assert.ok(button.includes('data-run-environment="DEMO"'));}
});
test('ending is not completed while fills are unknown or an exit leaves a residual position',()=>{
 const base={session:{id:'R1',endIntent:'close'},state:'stopped',position:{qty:0.4},pending:{intent:'close',status:'partial'}};
 assert.equal(executionRunState(base).state,'ending');assert.equal(executionRunState({...base,pending:{intent:'close',status:'unknown'}}).state,'end-unknown');
 assert.equal(executionRunState({...base,pending:null}).state,'exit-incomplete');assert.equal(executionRunState({...base,pending:null,position:null}).state,'ended');
 assert.equal(executionRunState({...base,session:{id:'R1',endIntent:'keep'},pending:null}).state,'ended-held');
});
test('two accounts and two runs keep plan, fill, reservation and protection ownership in the same records contract',()=>{
 const records=new ExecutionRecords(),orders=[];
 for(const [accountId,id]of [['SIM-01','R1'],['SIM-02','R2']]){
  const session={id,accountId,environment:'DEMO',market:'ETH/USDT',strategy:'S03',strategyVersion:1,price:100,amount:100,cap:500};
  const {plan,admission}=records.prepare({id:'SIGNAL-1',side:'buy'},session,1,'normal',0);
  const order={id:accountId+'-ORDER',runId:id,market:'ETH/USDT',side:'buy',qty:1,price:100,filled:0,feeRate:.001};records.submitted(order,plan,admission,0);records.recordFill(order,.5,1);records.updateProtection({...order,qty:.5},order,1);orders.push(order);
 }
 assert.equal(new Set(records.data.plans.map(p=>p.id)).size,2);assert.equal(new Set(records.data.admissions.map(p=>p.id)).size,2);
 const data={cash:10000,orders,position:{...orders[0],qty:.5},pending:orders[0],flow:records.data},before=JSON.stringify(data);
 const own=scopeExecutionRecords(data,{runId:'R2',accountId:'SIM-02'});assert.equal(own.orders.length,1);assert.equal(own.orders[0].accountId,'SIM-02');assert.equal(own.flow.fills.length,1);assert.equal(own.flow.protections.length,1);assert.equal(own.position,null);assert.equal(own.pending,null);assert.equal(own.flow.reservations[0].state,'HELD');assert.equal(own.cash,10000);assert.equal(JSON.stringify(data),before);
});
test('risk page does not render the previous account panel when the selected account has no snapshot',async()=>{
 const {riskStrategyExperience}=await import('./risk-strategy.mjs');const w={s:{astarterDrafts:[]},draft:()=>null};
 const html=riskStrategyExperience({w,desk:{snapshot:()=>({session:{id:'OLD-RUN'},state:'running'}),readSnapshot:()=>null,syncStatus:()=>({state:'STALE',scope:{...DEFAULT_SCOPE,accountId:'SIM-02'}})},accountPanel:'PRIVATE-SIM-01-BALANCE'});
 assert.equal(html.includes('PRIVATE-SIM-01-BALANCE'),false);assert.ok(html.includes('当前账户暂无可读取'));assert.equal(html.includes('OLD-RUN'),false);
});
test('run charge links use original task ownership and never match charges by asset',async()=>{
 const {executionCreditView}=await import('./execution-views.mjs'),data={session:{id:'SIM-184',accountId:'SIM-01',usageId:'U1'}};
 const startup={id:'U1',membershipTaskId:'original-job',priceVersion:'P0.6.1'},tasks=[{id:'same-asset',status:'complete',reserved:99,settled:99,input:{market:'ETH/USDT',runId:'OTHER'}},{id:'original-job',status:'complete',reserved:12,settled:8,input:{}}];
 const credits={start:4,startup,tasks},before=JSON.stringify(credits),html=executionCreditView(data,credits);
 assert.ok(html.includes('data-commerce-context'));assert.ok(html.includes('task=original-job'));assert.equal(html.includes('same-asset'),false);assert.equal(html.includes('历史启动记录'),false);assert.equal(JSON.stringify(credits),before);
 const runOnly=executionCreditView(data,{tasks:[{id:'run-job',input:{runId:'SIM-184',accountId:'SIM-01'}}]});assert.ok(runOnly.includes('run=SIM-184'));
 for(const tasks of [[{id:'other-run',input:{runId:'OTHER'}}],[{id:'other-account',input:{runId:'SIM-184',accountId:'SIM-02'}}]])assert.equal(executionCreditView(data,{tasks}).includes('data-commerce-context'),false);
 const legacy=executionCreditView(data,{start:4,startup:{id:'U1',priceVersion:'legacy-v1'},tasks:credits.tasks});assert.ok(legacy.includes('历史启动记录'));assert.ok(legacy.includes('legacy-v1'));assert.equal(legacy.includes('task='),false);assert.equal(legacy.includes('run='),false);
 assert.equal(executionCreditView(data,{startup:{id:'OTHER',membershipTaskId:'wrong-job'}}).includes('task=wrong-job'),false);
});


test('quote-only stream updates do not require rebuilding the chart or run controls',()=>{
 const d=run();d.submit();tick(d,3);const feed=new ExecutionFeed();feed.publish(snapshot(d));const before=executionRenderStamp(feed.data,feed.status),sequence=feed.sequence;
 d.position.markPrice=d.position.price+1;d.time+=1;feed.publish(snapshot(d));assert.ok(feed.sequence>sequence);assert.equal(executionRenderStamp(feed.data,feed.status),before);
 assert.notEqual(executionRenderStamp(feed.data,{...feed.status,state:'STALE'}),before);assert.notEqual(executionRenderStamp(feed.data,{...feed.status,scope:{...DEFAULT_SCOPE,accountId:'SIM-02'}}),before);
 d.pause();feed.publish(snapshot(d));assert.notEqual(executionRenderStamp(feed.data,feed.status),before);
});
test('a run identity change refreshes its controls even without a new order event',()=>{
 const d=run();d.submit();tick(d,3);const data=snapshot(d),status={state:'LIVE',scope:DEFAULT_SCOPE};data.session.connectionId='C1';
 const before=executionRenderStamp(data,status);data.session.connectionId='C2';assert.notEqual(executionRenderStamp(data,status),before);
});
test('run actions carry the original connection rather than the current preferred connection',()=>{
 const d=run();d.submit();tick(d,3);d.session.connectionId='C1';
 const html=executionView({data:snapshot(d),status:{state:'LIVE',scope:DEFAULT_SCOPE}}),button=html.match(/<button[^>]+data-biz="trade"[^>]+data-id="stop"[^>]*>/)?.[0];
 assert.ok(button);assert.ok(button.includes('data-run-connection="C1"'));
});
test('in-place quote paint updates only the bound run and leaves its ledger untouched',async()=>{
 const {patchExecutionPrices}=await import('./execution-views.mjs'),d=run();d.submit();tick(d,3);d.position.markPrice=d.position.price+2;
 const identity=executionRunIdentity(d,DEFAULT_SCOPE),view={dataset:{run:identity.runId,runAccount:'SIM-01',runEnvironment:'DEMO',runConnection:identity.connectionId||'',runInstrument:identity.instrumentId||''}},mark={},pnl={};
 const root={querySelector:selector=>selector==='.contract-run[data-run]'?view:selector==='[data-exec-mark]'?mark:selector==='[data-exec-pnl]'?pnl:null},before=JSON.stringify(snapshot(d));
 assert.equal(patchExecutionPrices(root,d,{scope:DEFAULT_SCOPE}),true);assert.match(mark.textContent,/USDT/);assert.equal(pnl.className,'execution-positive');assert.equal(JSON.stringify(snapshot(d)),before);
 const displayed=mark.textContent;assert.equal(patchExecutionPrices(root,d,{scope:{...DEFAULT_SCOPE,accountId:'SIM-02'}}),false);assert.equal(mark.textContent,displayed);
});
test('an in-place quote cannot paint a view from the previous connection',async()=>{
 const {patchExecutionPrices}=await import('./execution-views.mjs'),d=run();d.submit();tick(d,3);d.session.connectionId='C2';
 const identity=executionRunIdentity(d,DEFAULT_SCOPE),view={dataset:{run:identity.runId,runAccount:'SIM-01',runEnvironment:'DEMO',runConnection:'C1',runInstrument:identity.instrumentId||''}},mark={textContent:'old quote'},pnl={textContent:'old pnl'};
 const root={querySelector:selector=>selector==='.contract-run[data-run]'?view:selector==='[data-exec-mark]'?mark:selector==='[data-exec-pnl]'?pnl:null};
 assert.equal(patchExecutionPrices(root,d,{scope:DEFAULT_SCOPE}),false);assert.equal(mark.textContent,'old quote');assert.equal(pnl.textContent,'old pnl');
});


test('environment selector keeps explicit enum values independently of localized option labels',async()=>{
 const {loadLocale,translate}=await import('./locale.mjs');await loadLocale('ja');
 for(const environment of ['DEMO','PAPER','LIVE']){
  const data=snapshot(run()),before=JSON.stringify(data),html=executionView({data,status:{state:'LIVE',scope:{accountId:'SIM-01',environment}}});
  const selector=html.match(/<select data-exec-context="environment"[^>]*>([\s\S]*?)<\/select>/)?.[1];assert.ok(selector);
  const options=[...selector.matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map(m=>m[1]),['DEMO','PAPER','LIVE']);assert.equal(options.find(m=>m[2].includes('selected'))?.[1],environment);
  const localized=selector.replace(/>([^<]+)<\/option>/g,(_,text)=>'>'+translate(text,'ja')+'</option>');
  assert.notEqual(localized,selector);assert.deepEqual([...localized.matchAll(/<option value="([^"]+)"/g)].map(m=>m[1]),['DEMO','PAPER','LIVE']);
  assert.equal(JSON.stringify(data),before);
 }
});
