import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingPreview,hasActiveTrade} from './trading-preview.mjs';
import {TradingDemo} from './trading-demo.mjs';
import {portfolio} from './product-data.mjs';
import {tradeAnalytics,assetsView,logsView} from './product-views.mjs';
import {previewToolbar,previewExecutionView,previewOrderDetail} from './trading-preview-view.mjs';

const build=()=>new TradingPreview(1800000000000);
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('a stopped historical session does not replace the populated portfolio, while active work stays visible',()=>{
 assert.equal(hasActiveTrade({state:'stopped',session:{id:'old'},orders:[{status:'filled'}]}),false);
 for(const trade of [{state:'running',session:{}},{state:'paused',session:{}},{state:'stopped',position:{}},{pending:{}},{discovery:{armed:true}}])assert.equal(hasActiveTrade(trade),true);
 assert.equal(hasActiveTrade(null),false);
});
test('preview covers four markets and multiple order states with a reconciled isolated ledger',()=>{
 const desk=new TradingDemo(),before=JSON.stringify(desk),p=build(),d=p.snapshot();
 assert.equal(JSON.stringify(desk),before);assert.equal(d.positions.length,7);assert.equal(d.runs.length,10);assert.equal(d.orders.length,33);
 assert.equal(new Set(d.orders.map(o=>o.id)).size,d.orders.length);
 assert.equal(new Set(d.runs.map(o=>o.profileId)).size,4);
 for(const state of ['filled','partial','submitted','unknown','confirming','rejected','partial-cancelled'])assert.ok(d.orders.some(o=>o.status===state));
 assert.ok(d.orders.every(o=>o.accountId==='DEMO-PREVIEW'&&o.recordedAt<=1800000000000));
 close(d.cash,10000+d.flow.ledger.reduce((s,e)=>s+Number(e.amount),0));
 close(d.available+d.reserved,d.cash);close(portfolio(d).equity,d.equity);assert.equal(tradeAnalytics(d).reconciles,true);assert.ok(tradeAnalytics(d).labels.some(v=>typeof v==='number'));
});
test('closing an example updates positions, fees and the same order history once',()=>{
 const p=build(),before=p.snapshot();assert.equal(p.action('btc-trend','close'),null);
 const d=p.snapshot();assert.equal(d.positions.length,before.positions.length-1);assert.equal(d.orders.length,before.orders.length+1);
 assert.ok(d.orders.some(o=>o.previewId==='btc-trend'&&o.intent==='close'&&o.at>=80000));
 assert.ok(d.totalFees>before.totalFees);assert.match(p.action('btc-trend','close'),/无可退出/);assert.equal(p.snapshot().orders.length,d.orders.length);
 close(d.cash,10000+d.flow.ledger.reduce((s,e)=>s+Number(e.amount),0));
});
test('partial cancellation keeps filled quantity and releases only the unfilled reservation',()=>{
 const p=build(),before=p.snapshot(),qty=before.positions.find(p=>p.previewId==='sol-order').qty;
 assert.equal(p.action('sol-order','cancel'),null);const d=p.snapshot();
 close(d.positions.find(p=>p.previewId==='sol-order').qty,qty);assert.ok(d.reserved<before.reserved);
 assert.equal(d.orders.find(o=>o.previewId==='sol-order'&&o.at>=80000).status,'partial-cancelled');
 const unknown=d.reserved;assert.match(p.action('btc-unknown','cancel'),/未知/);close(p.snapshot().reserved,unknown);
});
test('pending examples complete through existing receipt and fill paths without duplicating fills',()=>{
 for(const id of ['btc-unknown','btc-swap','eth-order']){
  const p=build();assert.equal(p.action(id,'complete'),null);const d=p.snapshot();
  assert.equal(d.orders.find(o=>o.previewId===id&&o.at>=80000).status,'filled');assert.ok(d.positions.some(p=>p.previewId===id));
  assert.match(p.action(id,'complete'),/已经处理完成/);assert.equal(p.snapshot().flow.fills.length,d.flow.fills.length);
 }
});
test('pausing, resuming and stopping a sample strategy preserve its holdings',()=>{
 const p=build(),qty=p.snapshot().positions[0].qty;
 for(const [action,state]of [['pause','paused'],['resume','running'],['stop','stopped']]){
  assert.equal(p.action('btc-trend',action),null);const d=p.snapshot();assert.equal(d.runs[0].state,state);close(d.positions[0].qty,qty);
 }
});
test('sample filters, history and asset report use the same populated data without live trade controls',()=>{
 const d=build().snapshot(),html=previewExecutionView(d),dex=previewExecutionView(d,{market:'dex-spot'});
 assert.match(html,/data-preview-position="btc-trend"/);assert.doesNotMatch(dex,/data-preview-position="btc-trend"/);assert.match(dex,/data-preview-position="eth-swap"/);
 assert.doesNotMatch(html,/data-biz="trade"|NaN|undefined/);
 const assets=assetsView({d});assert.match(assets,/资产组合/);assert.match(assets,/WETH/);assert.match(assets,/BTC/);assert.doesNotMatch(assets,/NaN|undefined/);
 assert.match(logsView({d,rows:d.orders,filter:'全部'}),/BTC 趋势跟随/);assert.match(previewOrderDetail(d,d.orders[0].id),new RegExp(d.orders[0].id));
});

test('portfolio examples are opt-in and retain an explicit return to personal account data',()=>{
 const account=previewToolbar(false);assert.match(account,/data-preview-mode="examples"/);assert.doesNotMatch(account,/data-preview-action="reset"/);
 const examples=previewToolbar(true);assert.match(examples,/组合体验|Portfolio preview/);assert.match(examples,/data-preview-mode="account"/);assert.match(examples,/data-preview-action="reset"/);
});

test('statement example reuses the 54-fill, 27-day ledger for both owners without modifying account data',async()=>{
 const {statementExampleSnapshot,STATEMENT_EXAMPLE}=await import('./trading-preview.mjs');
 const {statementRecords,projectStatements,statementScope}=await import('./statements-data.mjs');
 const data=statementExampleSnapshot(),before=structuredClone(data),scope=statementScope('',{...data.accountSummary,timeZone:STATEMENT_EXAMPLE.timeZone});
 const records=statementRecords(data,scope);
 for(const [owner,net,fees]of [['AI_SPECTRUM','124.40940454','45.11417046'],['STRATEGY_AGENT','191.3990839','69.4064161']]){
  const m=projectStatements(records,{...scope,owner});assert.equal(m.fills.length,54);assert.equal(m.days.length,27);assert.equal(m.net,net);assert.equal(m.fees,fees);
  assert.equal(m.pending+m.missingPnl+m.foreignCosts+m.unknownCount,0);assert.ok(m.days.some(d=>Number(d.net)<0));assert.ok(m.days.some(d=>Number(d.net)>0));
  for(const day of m.days)assert.equal(projectStatements(records,{...scope,owner,day:day.day}).net,day.net);
 }
 assert.deepEqual(data,before);assert.deepEqual(statementExampleSnapshot(),data);
});

test('statement examples require a healthy exact local account and never mask real or unknown receipts',async()=>{
 const {statementExampleAllowed,statementExampleContext}=await import('./trading-preview.mjs');
 const trade={cash:10000,orders:[],flow:{fills:[],ledger:[]},accountSummary:{accountId:'SIM-01',environment:'DEMO'}},status={state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}};
 for(const host of ['localhost','127.0.0.1','opsqa.localhost'])assert.equal(statementExampleAllowed(trade,status,host),true);
 for(const host of ['localhost.evil.com','example.com','evillocalhost','127.0.0.2'])assert.equal(statementExampleAllowed(trade,status,host),false);
 for(const patch of [undefined,{}, {...status,state:'STALE'}, {...status,state:'DISCONNECTED'}, {...status,state:'REPLAYING'}, {...status,source:'LOCAL_SERVICE'}, {...status,scope:{accountId:'OTHER',environment:'DEMO'}}, {...status,scope:{accountId:'SIM-01',environment:'LIVE'}}])assert.equal(statementExampleAllowed(trade,patch,'localhost'),false);
 for(const patch of [{cash:NaN},{cashKnown:false},{unreadableTrade:{}},{botSummary:{recoveryError:'bad'}},{botSummary:{equity:NaN}},{position:{qty:NaN,price:100}},{pending:{}},{accountSummary:{accountId:'SIM-01',environment:'LIVE'}}])assert.equal(statementExampleAllowed({...trade,...patch},status,'localhost'),false);
 for(const patch of [{flow:null},{flow:{fills:[{id:'orphan',accountId:'SIM-01',orderId:'missing'}],ledger:[]}},{flow:{fills:[],ledger:[{id:'orphan-fee',accountId:'SIM-01',orderId:'missing',type:'FEE',amount:'-1'}]}}])assert.equal(statementExampleAllowed({...trade,...patch},status,'localhost'),false);
 const order={id:'REAL',accountId:'SIM-01',environment:'DEMO',market:'ETH/USDT',side:'sell',tradeOwner:'AI_SPECTRUM',recordedAt:Date.now()};
 assert.equal(statementExampleAllowed({...trade,orders:[order]},status,'localhost'),false);
 assert.equal(statementExampleAllowed({...trade,orders:[{...order,tradeOwner:undefined}]},status,'localhost'),false);
 for(const tradeOwner of ['AI_SPECTRUM',undefined])assert.equal(statementExampleContext({...trade,orders:[{...order,tradeOwner}]},status,'localhost'),true);
 for(const state of ['STALE','DISCONNECTED','REPLAYING'])assert.equal(statementExampleContext(trade,{...status,state},'localhost'),false);
 assert.equal(statementExampleContext(trade,{...status,scope:{accountId:'OTHER',environment:'DEMO'}},'localhost'),false);
 assert.equal(statementExampleContext({...trade,cash:NaN},status,'localhost'),false);
});
