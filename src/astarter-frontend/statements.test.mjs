import test from 'node:test';
import assert from 'node:assert/strict';
import {statementRecords,projectStatements,statementScope,statementSearch,statementDay,statementMonth,statementTimestamp} from './statements-data.mjs';
import {statementsView,statementsCalendar,statementNumber,statementDetail} from './statements-view.mjs';
import {BotBook} from './bot-runtime.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {createStatements} from './statements.mjs';
import {publicSpotBook,spotTradeLedger} from './connection-options.mjs';

test('date-scoped entries preserve the current account and validate dates and timezone; old entries stay unchanged',async t=>{
 const saved={document:globalThis.document,location:globalThis.location};t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const handlers={},data=fixture(),before=structuredClone(data);let html='';
 const doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};
 globalThis.document=doc;globalThis.location={search:'?page=workbench'};
 const root={ownerDocument:doc,scrollTop:0,querySelector:()=>null},dialog={open:false,classList:{add(){},remove(){}},addEventListener(){}};
 createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show:(_,body)=>{html=body;dialog.open=true;},navigate(){}});
 const click=async dataset=>{const entry={dataset};await handlers.click({target:{closest:selector=>selector==='[data-statements]'?entry:null},preventDefault(){}});};
 await click({statements:'AI_SPECTRUM',statementFrom:'2026-11-09',statementTo:'2026-11-09',statementDay:'2026-11-09',statementZone:'Asia/Shanghai',statementAccount:'B',statementEnvironment:'LIVE'});
 assert.match(html,/2026-11-09 – 2026-11-09/);assert.match(html,/UTC\+8/);assert.match(html,/A · DEMO/);assert.match(html,/data-st-detail="spectrum:F-S"/);assert.doesNotMatch(html,/data-st-detail="spectrum:F-(?:B|OTHER)"/);
 await click({statements:'AI_SPECTRUM',statementFrom:'2026-11-08',statementTo:'2026-11-08',statementDay:'2026-11-08',statementZone:'Asia/Shanghai'});assert.doesNotMatch(html,/data-st-detail="spectrum:F-S"/);
 await click({statements:'AI_SPECTRUM',statementFrom:'2026-02-30',statementTo:'bad',statementDay:'bad',statementZone:'Bad/Zone'});
 assert.match(html,/全部日期|All dates/);assert.match(html,/>UTC\+0<\/span>/);assert.match(html,/data-st-detail="spectrum:F-S"/);assert.doesNotMatch(html,/2026-02-30|Bad\/Zone/);
 await click({statements:'AI_SPECTRUM'});assert.match(html,/全部日期|All dates/);assert.match(html,/data-st-detail="spectrum:F-S"/);assert.deepEqual(data,before);
});

const at=Date.parse('2026-11-08T16:30:00Z');
const scope=patch=>statementScope('',{accountId:'A',environment:'DEMO',currency:'USDT',timeZone:'Asia/Shanghai',...patch});
function fixture(){
 const order=(id,owner,accountId='A')=>({id,runId:'RUN-'+id,accountId,environment:'DEMO',tradeOwner:owner,market:'ETH/USDT',currency:'USDT',marketType:'SPOT',side:'sell',price:110,qty:1,filled:1,status:'filled',recordedAt:at});
 const orders=[order('S','AI_SPECTRUM'),order('B','STRATEGY_AGENT'),order('X',null),order('OTHER','AI_SPECTRUM','B')];
 const fills=orders.map(o=>({id:'F-'+o.id,venueFillId:'VENUE-'+o.id,orderId:o.id,accountId:o.accountId,side:o.side,marketType:'SPOT',quantity:'1',price:'110',notional:'110',currency:'USDT',realizedPnlGross:'10',feeState:'CONFIRMED',recordedAt:at}));
 const ledger=fills.map(f=>({id:'L-'+f.id,economicEventId:'E-'+f.id,accountId:f.accountId,orderId:f.orderId,fillId:f.id,type:'FEE',amount:'-0.1',currency:'USDT',recordedAt:at,revision:1}));
 return {orders,flow:{fills,ledger},accountSummary:{accountId:'A',environment:'DEMO',unit:'USDT'}};
}
const project=(d,s=scope())=>{const records=statementRecords(d,s);return {records,model:projectStatements(records,s)};};
test('owners and account/environment remain isolated regardless of entry category',()=>{
 const data=fixture(),before=structuredClone(data),{records,model}=project(data);
 assert.deepEqual(model.fills.map(f=>f.id),['F-S']);assert.equal(model.net,'9.9');assert.equal(model.unknownCount,1);
 assert.deepEqual(projectStatements(records,scope({owner:'STRATEGY_AGENT'})).fills.map(f=>f.id),['F-B']);
 assert.deepEqual(projectStatements(records,scope({exceptions:true})).fills.map(f=>f.id),['F-X']);
 assert.equal(project(data,scope({environment:'LIVE'})).model.fills.length,0);assert.deepEqual(data,before);
});
test('conflicting declared ownership is unclassified and native run ownership is trustworthy',()=>{
 const d=fixture();d.orders[0].planId='P';d.flow.plans=[{id:'P',accountId:'A',tradeOwner:'STRATEGY_AGENT'}];
 assert.equal(project(d).model.fills.length,0);assert.equal(project(d).model.unknownCount,2);
 const raw={...d.orders[1],tradeOwner:undefined};d.botBook={runs:[{id:raw.runId,environment:'DEMO',plan:{strategy:'S02',executionRoute:{accountId:'A'}},orders:[raw]}],flow:{fills:[d.flow.fills[1]],ledger:[d.flow.ledger[1]]}};d.orders.splice(1,1);
 assert.equal(project(d,scope({owner:'STRATEGY_AGENT'})).model.fills.length,1);
});
test('fill receipt deduplication and fee revisions never double count',()=>{
 const d=fixture();d.flow.fills.push({...d.flow.fills[0],id:'REPLAY',revision:0});
 d.flow.ledger.push({...d.flow.ledger[0],revision:2,amount:'-0.2'});d.flow.ledger.push({...d.flow.ledger[0],revision:1,amount:'-99'});
 const {model}=project(d);assert.equal(model.fills.length,1);assert.equal(model.fees,'0.2');assert.equal(model.net,'9.8');
});
test('fee rebates retain their sign; incompatible currencies cannot masquerade as net PnL',()=>{
 const d=fixture();d.flow.ledger[0].amount='0.1';assert.equal(project(d).model.net,'10.1');assert.equal(project(d).model.fees,'-0.1');
 d.flow.ledger[0].currency='BNB';const {model}=project(d);assert.equal(model.net,null);assert.equal(model.foreignCosts,1);assert.equal(model.fees,'0');assert.equal(model.days[0].foreignCosts,1);
 assert.match(statementsCalendar(model,scope(),'2026-11'),/data-st-day="2026-11-09"[^>]+>[\s\S]*?<span class="st-cal-amount">—<\/span>/);
 d.flow.ledger[2].currency='BNB';assert.equal(project(d,scope({exceptions:true})).model.net,null);
 assert.equal(project(d,scope({query:'unrelated'})).model.foreignCosts,0);
});
test('pending fees, missing cost bases and undated history are not zero-profit days',()=>{
 const d=fixture();d.flow.fills[0].feeState='PENDING';d.flow.ledger=[];let m=project(d).model;assert.equal(m.net,null);assert.equal(m.days[0].pending,1);
 delete d.flow.fills[0].realizedPnlGross;m=project(d).model;assert.equal(m.missingPnl,1);assert.equal(m.net,null);
 delete d.flow.fills[0].recordedAt;m=project(d).model;assert.equal(m.undated,1);assert.equal(m.days.length,1);assert.equal(m.days[0].classificationPending,true);assert.equal(m.days[0].fills,0);
 assert.equal(project(d,scope({from:'2026-11-01',to:'2026-11-30'})).model.fills.length,0);
});
test('late fees belong to their recorded day and filters use the same daily event ledger',()=>{
 const d=fixture();d.flow.ledger[0].recordedAt=at+86400000;
 const {model}=project(d);assert.deepEqual(model.days.map(x=>[x.day,x.net,x.fills]),[['2026-11-09','10',1],['2026-11-10','-0.1',0]]);
 const feeDay=project(d,scope({day:'2026-11-10'})).model;assert.equal(feeDay.net,'-0.1');assert.equal(feeDay.fills.length,0);assert.equal(feeDay.orders.length,1);
 assert.equal(project(d,scope({from:'2026-11-10',to:'2026-11-10'})).model.orders.length,1);
 assert.equal(statementDay(Date.parse('2026-11-01T05:30:00Z'),'America/New_York'),'2026-11-01');
 assert.equal(statementDay(Date.parse('2026-11-01T06:30:00Z'),'America/New_York'),'2026-11-01');
 assert.equal(statementDay(at,'UTC'),'2026-11-08');assert.equal(statementDay(at,'Asia/Shanghai'),'2026-11-09');
});
test('scope roundtrip keeps filters, while query parameters cannot change authorized accounts',()=>{
 const s=scope({owner:'STRATEGY_AGENT',from:'2026-11-01',to:'2026-11-30',day:'2026-11-09',runId:'r:a',tab:'orders',symbol:'ETH/USDT'});
 assert.deepEqual(statementScope(statementSearch(s)+'&st_account=EVIL',s),s);
 const invalid=statementScope('?st_from=2026-02-30&st_zone=Bad/Zone&st_owner=BOT',s);assert.equal(invalid.from,'');assert.equal(invalid.timeZone,'UTC');assert.equal(invalid.owner,'AI_SPECTRUM');
 assert.equal(statementMonth('2026-12',1),'2027-01');assert.equal(statementMonth('2026-01',-1),'2025-12');
});
test('calendar and rows expose zero, no-activity, unknown, partial cancellation and safe text',()=>{
 const s=scope(),{records,model}=project(fixture());model.days.push({day:'2026-11-11',net:'0',fills:1,pending:0,missingPnl:0});
 const html=statementsCalendar(model,s,'2026-11');assert.match(html,/data-st-day="2026-11-11"[^>]+0.00/);assert.match(html,/data-st-day="2026-11-12"[^>]+disabled/);
 const d=fixture();d.orders[0].status='partial-cancelled';d.orders[0].market='<script>/USDT';const orderScope=scope({tab:'orders'}),p=project(d,orderScope);
 const view=statementsView({...p,scope:orderScope,month:'2026-11'});assert.match(view,/部分成交|Part filled/);assert.doesNotMatch(view,/<script>/);assert.match(view,/&lt;script&gt;/);
});
test('new legacy runs preserve explicit ownership and timestamps without relabeling old history',()=>{
 const d=new TradingDemo();assert.equal(d.start({market:'BTC/USDT',strategy:'S03',mode:'confirm',amount:100,cap:500,tradeOwner:'AI_SPECTRUM'},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',price:100,revision:'r1'}),null);
 d.signal={id:'SIG-OWNER',side:'buy'};d.submit();const order=d.orders[0];d.fill(order,1);
 assert.equal(d.session.tradeOwner,'AI_SPECTRUM');assert.equal(order.tradeOwner,'AI_SPECTRUM');assert.equal(d.flow.fills[0].tradeOwner,'AI_SPECTRUM');assert.ok(d.flow.fills[0].recordedAt>1e12);
 const saved=structuredClone({...d,flow:d.flow});delete saved.orders[0].tradeOwner;delete saved.session.tradeOwner;delete saved.flow.plans[0].tradeOwner;
 const restored=new TradingDemo();restored.restore(saved);assert.equal(restored.orders[0].tradeOwner,undefined);assert.equal(restored.session.tradeOwner,undefined);
});
test('native Agent settled fill metadata agrees with the existing lot result and cash',()=>{
 const plan={id:'P',version:1,strategy:'S02',planVariant:'S02-SIM',market:'ETH/USDT',executionRoute:{accountId:'SIM-01',connectionId:'legacy-exchange',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:{deviationPct:2,sizeMultiplier:1.5,maxEntries:3,takeProfitPct:2,stopLossPct:8}};
 let cash=10000;const book=new BotBook({debit:value=>{cash-=value;return true;},credit:value=>{cash+=value;return true;}}),created=book.create(plan,{requestId:'APPROVED'});assert.ok(!created.error);
 for(let i=0;i<50;i++)book.tick(.1,{'ETH/USDT':100});for(let i=0;i<50;i++)book.tick(.1,{'ETH/USDT':110});
 const saved=book.snapshot(),run=saved.runs[0],closing=saved.flow.fills.filter(f=>f.side==='sell');assert.ok(closing.length>0);
 assert.ok(Math.abs(closing.reduce((n,f)=>n+Number(f.realizedPnlNet),0)-run.realizedPnl)<1e-8);assert.equal(run.tradeOwner,'STRATEGY_AGENT');
 assert.ok(closing.every(f=>f.recordedAt>1e12&&Number.isFinite(Number(f.settledCostBasis))));
 const data={botBook:saved,accountSummary:{accountId:'SIM-01',environment:'DEMO',unit:'USDT'}},p=project(data,scope({owner:'STRATEGY_AGENT',accountId:'SIM-01'}));
 assert.ok(Math.abs(Number(p.model.net)-run.realizedPnl)<1e-8);assert.ok(Math.abs(cash+run.cash-10000-run.realizedPnl)<1e-8);
});

test('invalid or out-of-range wall clocks remain unknown without crashing calendar',()=>{
 for(const value of [null,undefined,'1794192000000',NaN,Infinity,1e30,-1,123]){assert.equal(statementTimestamp({recordedAt:value}),null);assert.equal(statementDay(value),null);}
 assert.equal(statementTimestamp({recordedAt:at}),at);
});

test('controller keeps the originating category across account switches and freezes tables on updates',async t=>{
 const globals={document:globalThis.document,location:globalThis.location,history:globalThis.history};
 t.after(()=>{for(const [key,value]of Object.entries(globals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const handlers={},notices=[],nav=[];let html='',current={accountId:'A',environment:'DEMO'},data=fixture();
 const host={querySelector:selector=>selector==='.st-new-records'&&notices.length?notices[0]:null,prepend:node=>notices.push(node)};
 const doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[],createElement:()=>({dataset:{},setAttribute(){}})};
 globalThis.document=doc;globalThis.location={search:'?page=strategies'};globalThis.history={replaceState(){}};
 const root={ownerDocument:doc,scrollTop:24,querySelector:()=>host},dialog={open:false,classList:{add(){},remove(){}},addEventListener(){},querySelector:()=>host,close(){this.open=false;}};
 const controller=createStatements({desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',scope:current})},root,dialog,show:(_,body)=>{html=body;dialog.open=true;},navigate:(...args)=>nav.push(args),storage:{getItem(){throw Error('denied');},setItem(){throw Error('denied');}}});
 controller.open({owner:'STRATEGY_AGENT',runId:'RUN-B'});assert.match(html,/STRATEGY_AGENT|策略 Agent/);assert.match(html,/agents:F-B|spectrum:F-B/);
 await handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:selector.includes('data-st-action')?{dataset:{stAction:'full'},closest:()=>({})}:null},preventDefault(){}});
 assert.equal(nav[0][0],'logs');assert.equal(new URLSearchParams(nav[0][1].search).get('st_owner'),'STRATEGY_AGENT');assert.equal(new URLSearchParams(nav[0][1].search).get('st_run'),'RUN-B');
 controller.open({owner:'STRATEGY_AGENT'});const before=html;data.flow.revision=2;controller.tick();controller.tick();assert.equal(html,before);assert.equal(notices.length,1);
 current={accountId:'B',environment:'DEMO'};controller.tick();assert.match(html,/B · DEMO/);assert.match(html,/策略 Agent/);assert.doesNotMatch(html,/data-st-detail="spectrum:F-B"/);assert.doesNotMatch(html,/data-st-detail="spectrum:F-OTHER"/);
});

test('unavailable numeric display stays unknown; exceptions filters use unknown records',()=>{
 for(const v of [null,undefined,'',NaN,Infinity,'garbage'])assert.equal(statementNumber(v),'—');
 assert.equal(statementNumber(0),'0.00');
 const d=fixture();d.orders[2].market='SOL/USDT';const s=scope({exceptions:true}),p=project(d,s),html=statementsView({...p,scope:s,month:'2026-11'});
 assert.match(html,/<option value="SOL\/USDT"/);assert.doesNotMatch(html,/<option value="ETH\/USDT"/);
});


test('order details aggregate actual fills and preserve signed funding cashflows',()=>{
 const d=fixture();d.orders[0].price=999;d.flow.fills[0].quantity='0.5';d.flow.fills[0].notional='55';d.flow.fills[0].realizedPnlGross='5';
 d.flow.fills.push({...d.flow.fills[0],id:'F-S-2',venueFillId:'VENUE-S-2',quantity:'0.5',price:'120',notional:'60',realizedPnlGross:'10'});
 d.flow.ledger.push({id:'FUND',economicEventId:'FUND-1',accountId:'A',orderId:'S',fillId:'F-S',type:'FUNDING',amount:'1.25',currency:'USDT',recordedAt:at});
 const {records}=project(d),order=records.orders.find(o=>o.id==='S');
 assert.equal(order.filledQuantity,'1');assert.equal(order.filledNotional,'115');assert.equal(order.averageFillPrice,115);assert.equal(order.realizedGross,'15');
 const html=statementDetail(order,scope());assert.match(html,/115(?:\.0+)? USDT/);assert.match(html,/<dt>(?:委托价格|Order price)<\/dt><dd>999 USDT<\/dd>/);assert.match(html,/<dt>(?:成交价|Fill price)<\/dt><dd>115 USDT<\/dd>/);assert.match(html,/\+1.25 USDT/);
});


test('perpetual actions translate complete intent and direction phrases',()=>{
 for(const [intent,direction,label]of [['open','long',/开多|Open long/],['open','short',/开空|Open short/],['close','long',/平多|Close long/],['close','short',/平空|Close short/],['unknown','long',/方向待核对|Unverified direction/],['close','unknown',/方向待核对|Unverified direction/]]){
  const d=fixture();Object.assign(d.orders[0],{marketType:'PERPETUAL',intent,direction});
  const {records}=project(d);assert.match(statementDetail(records.orders.find(o=>o.id==='S'),scope()),label);
 }
});

test('full statement return focuses the rebuilt originating entry among matching owners',async t=>{
 const saved={document:globalThis.document,location:globalThis.location,CSS:globalThis.CSS};
 t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const handlers={},focused=[];let entries=[];
 const container={id:'product-page',querySelectorAll:()=>entries};
 const entry=id=>({isConnected:true,parentElement:{closest:()=>container},matches:()=>true,hasAttribute:name=>name==='data-statements',getAttribute:()=> 'STRATEGY_AGENT',closest:()=>null,focus:()=>focused.push(id)});
 entries=[entry('original-first'),entry('original-second')];const origin=entries[1];
 const doc={activeElement:origin,body:{dataset:{page:'strategies'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[],getElementById:id=>id==='product-page'?container:null};
 globalThis.document=doc;globalThis.location={search:'?page=strategies&view=mine'};globalThis.CSS={escape:value=>value};
 const root={ownerDocument:doc,scrollTop:72,querySelector:()=>null},dialog={open:false,ownerDocument:doc,classList:{add(){},remove(){}},addEventListener(){},close(){this.open=false;}};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>fixture(),syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show:()=>{dialog.open=true;},navigate:()=>{origin.isConnected=false;entries=[entry('rebuilt-first'),entry('rebuilt-second')];root.scrollTop=0;}});
 controller.open({owner:'STRATEGY_AGENT'});
 await handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:{dataset:{stAction:'return'},closest:()=>({})}},preventDefault(){}});
 assert.deepEqual(focused,['rebuilt-second']);assert.equal(root.scrollTop,72);
});

test('popup day entries return to the stable matrix point after close, redraw and full records',async t=>{
 const saved={document:globalThis.document,location:globalThis.location};t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const handlers={},focused=[],id='pnl-point-account-day-1';let onReturn,point;
 const makePoint=name=>({id,isConnected:true,focus(){focused.push(name);doc.activeElement=this;}});
 const popupButton={dataset:{statementReturnId:id},isConnected:true,matches:()=>false,focus(){throw Error('hidden popup must not receive return focus');}};
 const doc={activeElement:popupButton,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[],getElementById:target=>target===id?point:null};
 globalThis.document=doc;globalThis.location={search:'?page=workbench'};point=makePoint('initial-point');
 const root={ownerDocument:doc,scrollTop:72,querySelector:()=>null},dialog={open:false,ownerDocument:doc,classList:{add(){},remove(){}},querySelector:()=>null,addEventListener(){},close(){this.open=false;onReturn?.();}};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>fixture(),syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show:(_,body,restore)=>{onReturn=restore;dialog.open=true;},navigate:page=>{doc.body.dataset.page=page;root.scrollTop=0;if(point)point.isConnected=false;point=page==='workbench'?makePoint('rebuilt-point'):null;}});
 controller.open({owner:'AI_SPECTRUM',day:'2026-11-09'},popupButton);
 assert.equal(typeof onReturn,'function');dialog.close();assert.deepEqual(focused,['initial-point']);
 controller.open({owner:'AI_SPECTRUM'},popupButton);point.isConnected=false;point=makePoint('redrawn-point');dialog.close();assert.equal(focused.at(-1),'redrawn-point');
 controller.open({owner:'AI_SPECTRUM'},popupButton);
 const action=stAction=>handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:{dataset:{stAction},closest:()=>({})}},preventDefault(){}});
 await action('full');assert.equal(doc.body.dataset.page,'logs');await action('return');assert.equal(doc.body.dataset.page,'workbench');assert.equal(root.scrollTop,72);assert.equal(focused.at(-1),'rebuilt-point');
 controller.open({owner:'AI_SPECTRUM'},popupButton);point=null;const count=focused.length;dialog.close();assert.equal(focused.length,count,'a removed target must not fall back to the hidden popup');
});

test('legacy order links resolve actual scoped ownership while explicit filters take priority',t=>{
 const saved={document:globalThis.document,location:globalThis.location};t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const doc={body:{dataset:{page:'logs'}},addEventListener(){}};globalThis.document=doc;globalThis.location={search:''};
 const controller=createStatements({root:{ownerDocument:doc},dialog:{addEventListener(){}},desk:{readSnapshot:()=>fixture(),syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show(){},navigate(){},storage:{getItem:()=> 'AI_SPECTRUM'}});
 let html=controller.page('?page=logs&order=B');assert.match(html,/st-detail-heading/);assert.match(html,/策略 Agent|Strategy Agents/);assert.match(html,/data-st-copy="B"/);
 html=controller.page('?page=logs&order=X');assert.match(html,/归属待核对|Unclassified/);assert.match(html,/data-st-copy="X"/);
 for(const search of ['?page=logs&order=OTHER','?page=logs&order=B&st_owner=AI_SPECTRUM','?page=logs&order=B&st_run=RUN-S','?page=logs&order=B&st_currency=USD']){html=controller.page(search);assert.doesNotMatch(html,/st-detail-heading|data-st-copy="(?:B|OTHER)"/);}
 html=controller.page('?page=logs&order=B&st_query=S&st_owner=AI_SPECTRUM');assert.doesNotMatch(html,/st-detail-heading/);assert.match(html,/data-st-detail="spectrum:F-S"/);
});

test('calendar uses signed K/M/B amounts at every width and retains exact accessible values',()=>{
 const days=[['01','1250'],['02','-2500000'],['03','1000000000'],['04','999999'],['05','0'],['06','-0.004'],['07',null]].map(([day,net])=>({day:'2026-11-'+day,net,fills:1,pending:0,missingPnl:0}));
 const html=statementsCalendar({days},scope(),'2026-11');
 const cell=day=>html.match(new RegExp('data-st-day="2026-11-'+day+'"[\\s\\S]*?</button>'))[0];
 assert.match(cell('01'),/class="profit"/);assert.match(cell('01'),/st-cal-amount">\+1.25K</);assert.match(cell('01'),/title="2026-11-01 · \+1,250.00 USDT"/);
 assert.match(cell('02'),/class="loss"/);assert.match(cell('02'),/st-cal-amount">−2.5M</);assert.match(cell('02'),/-2,500,000.00 USDT/);
 assert.match(cell('03'),/st-cal-amount">\+1B</);assert.match(cell('04'),/st-cal-amount">\+1M</);assert.doesNotMatch(cell('04'),/1000K/);
 assert.match(cell('05'),/class="neutral"/);assert.match(cell('05'),/st-cal-amount">0</);
 assert.match(cell('06'),/st-cal-amount">−&lt;\.01</);
 assert.match(cell('07'),/st-cal-amount">—</);assert.match(cell('08'),/disabled/);assert.match(cell('08'),/st-cal-amount">·</);
 assert.doesNotMatch(html,/st-cal-long|st-cal-short/);
});

test('dotted PnL curve follows the settled net sign and stays hidden for incomplete settlement',()=>{
 for(const [gross,expected]of [['10','profit'],['-10','loss'],['0.1','neutral']]){
  const data=fixture();data.flow.fills[0].realizedPnlGross=gross;
  const s=scope({runId:'RUN-S'}),p=project(data,s),html=statementsView({...p,scope:s,month:'2026-11'});
  assert.ok(html.includes('class="st-curve '+expected+'" data-st-curve'));
  assert.match(html,/stroke-linecap="round" stroke-dasharray="0 7"/);
  assert.equal(p.model.points.at(-1).value,Number(p.model.net));
  const before=structuredClone(p.model.points);
  statementsView({...p,scope:s,month:'2026-11'});assert.deepEqual(p.model.points,before);
 }
 const data=fixture();data.flow.fills[0].feeState='PENDING';data.flow.ledger=[];
 const s=scope({runId:'RUN-S'}),p=project(data,s);assert.equal(p.model.classificationPending,false);assert.equal(p.model.pending,1);
 const html=statementsView({...p,scope:s,month:'2026-11'});
 assert.match(html,/st-curve-empty/);assert.doesNotMatch(html,/class="st-curve /);
});

test('unclassified coverage masks apparent zero in compact metrics and calendar without changing attributed amounts',()=>{
 const data=fixture();data.orders=data.orders.filter(o=>o.id==='X');data.flow.fills=data.flow.fills.filter(f=>f.orderId==='X');data.flow.ledger=data.flow.ledger.filter(e=>e.orderId==='X');
 const before=structuredClone(data),s=scope({day:'2026-11-09'}),p=project(data,s);
 assert.equal(p.model.net,'0');assert.equal(p.model.confirmedNet,'0');assert.equal(p.model.classificationPending,true);assert.equal(p.model.scopedUnknownCount,1);
 const html=statementsView({...p,scope:s,compact:true,month:'2026-11'});
 assert.equal(html.match(/<strong class="dot-number[^\"]*">([^<]*)/)?.[1],'—');
 assert.equal(html.match(/<dt>费用<\/dt><dd>([^<]*)/)?.[1],'—');assert.equal(p.model.fees,'0');
 assert.ok(html.includes('历史盈亏待核对'));assert.ok(html.includes('data-st-action="exceptions"'));assert.ok(!html.includes('class="st-curve '));
 const cell=statementsCalendar(p.model,s,'2026-11').match(/data-st-day="2026-11-09"[\s\S]*?<\/button>/)?.[0];
 assert.equal(cell?.match(/st-cal-amount">([^<]*)/)?.[1],'—');assert.ok(cell?.includes('历史盈亏待核对'));assert.ok(!cell?.includes('disabled'));
 const footer=statementsCalendar(p.model,s,'2026-11').match(/<footer>[\s\S]*?<\/footer>/)?.[0];assert.ok(footer?.includes('— USDT'));assert.ok(!footer?.includes('0.00'));
 const unknownScope={...s,exceptions:true},unknown=project(data,unknownScope),unknownHtml=statementsView({...unknown,scope:unknownScope,compact:true,month:'2026-11'});
 assert.equal(unknown.model.net,'9.9');assert.equal(unknown.model.classificationPending,false);assert.ok(unknownHtml.includes(' · 归属待核对</p>'));assert.ok(unknownHtml.includes('data-st-detail="spectrum:F-X"'));
 assert.deepEqual(data,before);
});

test('true empty records remain confirmed zero while unrelated unknown activity does not pollute coverage',()=>{
 const empty={orders:[],flow:{fills:[],ledger:[]},accountSummary:{accountId:'A',environment:'DEMO',unit:'USDT'}},s=scope(),p=project(empty,s);
 assert.equal(p.model.classificationPending,false);assert.equal(p.model.scopedUnknownCount,0);
 const html=statementsView({...p,scope:s,compact:true,month:'2026-11'});assert.equal(html.match(/<strong class="dot-number[^\"]*">([^<]*)/)?.[1],'0.00');assert.equal(html.match(/<dt>费用<\/dt><dd>([^<]*)/)?.[1],'0.00');assert.ok(!html.includes('data-st-action="exceptions"'));
 const cases=[
  {mutate:rows=>rows.forEach(row=>row.accountId='B')},
  {mutate:rows=>rows[0].environment='LIVE'},
  {mutate:rows=>rows.forEach(row=>row.currency='USD')},
  {mutate:rows=>rows[0].market='BTC/USDT',scope:{symbol:'ETH/USDT'}},
  {mutate:rows=>rows.forEach(row=>row.recordedAt=at+86400000),scope:{from:'2026-11-09',to:'2026-11-09',day:'2026-11-09'}},
  {mutate:()=>{},scope:{runId:'RUN-S'}},
  {mutate:()=>{},scope:{query:'RUN-S'}}
 ];
 for(const c of cases){
  const data=fixture();c.mutate([data.orders[2],data.flow.fills[2],data.flow.ledger[2]]);
  const active=scope(c.scope),result=project(data,active),view=statementsView({...result,scope:active,compact:true,month:'2026-11'});
  assert.equal(result.model.classificationPending,false);assert.equal(result.model.scopedUnknownCount,0);assert.equal(result.model.net,'9.9');
  assert.equal(view.match(/<strong class="dot-number[^\"]*">([^<]*)/)?.[1],'+9.90');assert.ok(!view.includes('data-st-action="exceptions"'));
  assert.equal(view.match(/<dt>费用<\/dt><dd>([^<]*)/)?.[1],'0.10');
 }
 const data=fixture();data.flow.ledger[2].currency='BNB';const mixed=project(data);assert.equal(mixed.model.classificationPending,true);assert.equal(mixed.model.scopedUnknownCount,1);assert.equal(mixed.model.net,'9.9');
 const mixedView=statementsView({...mixed,scope:scope(),compact:true,month:'2026-11'});assert.equal(mixedView.match(/<strong class="dot-number[^\"]*">([^<]*)/)?.[1],'—');assert.ok(!mixedView.includes('class="st-curve '));
});

test('undated unclassified activity stays pending without fabricated calendar dates and offers clearing the selected period',()=>{
 const data=fixture();data.orders=data.orders.filter(o=>o.id==='X');data.flow.fills=data.flow.fills.filter(f=>f.orderId==='X');data.flow.ledger=data.flow.ledger.filter(e=>e.orderId==='X');
 for(const row of [...data.orders,...data.flow.fills,...data.flow.ledger])delete row.recordedAt;
 const before=structuredClone(data);
 for(const filters of [{day:'2026-11-09'},{from:'2026-11-09',to:'2026-11-09',day:'2026-11-09'}]){
  const s=scope(filters),p=project(data,s),html=statementsView({...p,scope:s,compact:true,month:'2026-11'});
  assert.equal(p.model.classificationPending,true);assert.equal(p.model.unclassifiedUndated,1);assert.equal(p.model.scopedUnknownCount,1);assert.deepEqual(p.model.days,[]);
  const note=html.match(/<p class="st-history-note">[\s\S]*?<\/p>/)?.[0];
  assert.ok(note?.includes('时间未记录'));assert.ok(note?.includes('data-st-action="clear-range"'));assert.ok(html.includes('data-st-action="exceptions"'));
  const unknownScope={...s,exceptions:true},unknown=project(data,unknownScope),unknownView=statementsView({...unknown,scope:unknownScope,compact:true,month:'2026-11'});
  assert.equal(unknown.model.net,'0');assert.equal(unknown.model.fees,'0');
  assert.equal(unknownView.match(/<strong class="dot-number[^\"]*">([^<]*)/)?.[1],'—');assert.equal(unknownView.match(/<dt>费用<\/dt><dd>([^<]*)/)?.[1],'—');assert.ok(!unknownView.includes('class="st-curve '));
  assert.ok(statementsCalendar(unknown.model,unknownScope,'2026-11').match(/<footer>[\s\S]*?<\/footer>/)?.[0].includes('— USDT'));
  const date=statementsCalendar(p.model,s,'2026-11').match(/data-st-day="2026-11-09"[\s\S]*?<\/button>/)?.[0];assert.ok(date?.includes('disabled'));assert.ok(date?.includes('st-cal-amount">·'));
 }
 const s=scope({exceptions:true}),p=project(data,s),view=statementsView({...p,scope:s,compact:true,month:'2026-11'});
 assert.equal(p.model.net,'9.9');assert.equal(view.match(/<strong class="dot-number[^\"]*">([^<]*)/)?.[1],'+9.90');assert.equal(view.match(/<dt>费用<\/dt><dd>([^<]*)/)?.[1],'0.10');
 assert.ok(view.includes('时间未记录'));assert.ok(view.includes('data-st-detail="spectrum:F-X"'));assert.deepEqual(data,before);
});

test('compact exceptions keep the unclassified title and return to the original owner and day',async t=>{
 const saved={document:globalThis.document,location:globalThis.location};t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const handlers={},data=fixture();let html='',title='';
 const doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};
 globalThis.document=doc;globalThis.location={search:'?page=workbench'};
 const root={ownerDocument:doc,scrollTop:0,querySelector:()=>null},dialog={ownerDocument:doc,open:false,classList:{add(){},remove(){}},addEventListener(){}};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show:(heading,body)=>{title=heading;html=body;dialog.open=true;},navigate(){}});
 const toggle=async()=>handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:{dataset:{stAction:'exceptions'},closest:()=>({})}},preventDefault(){}});
 controller.open({owner:'AI_SPECTRUM',day:'2026-11-09',timeZone:'Asia/Shanghai'});assert.ok(title.endsWith('AI 交易'));assert.ok(html.includes('历史盈亏待核对'));
 await toggle();assert.ok(title.endsWith('归属待核对'));assert.ok(html.includes(' · 归属待核对</p>'));assert.ok(html.includes('data-st-detail="spectrum:F-X"'));assert.ok(html.includes('2026-11-09'));
 await toggle();assert.ok(title.endsWith('AI 交易'));assert.ok(html.includes('历史盈亏待核对'));assert.ok(html.includes('data-st-detail="spectrum:F-S"'));assert.ok(html.includes('2026-11-09'));
});

test('date filters keep the disclosure open before restoring input focus, then dismiss without closing records',t=>{
 const saved={document:globalThis.document,location:globalThis.location,CSS:globalThis.CSS};t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const data=fixture(),before=structuredClone(data),handlers={};let range,fields,html='';
 const doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};
 const summary={focus(){doc.activeElement=this;}};
 globalThis.document=doc;globalThis.location={search:'?page=workbench'};globalThis.CSS={escape:x=>x};
 const root={ownerDocument:doc,scrollTop:0,querySelector:()=>null},dialog={ownerDocument:doc,open:false,classList:{add(){},remove(){}},addEventListener(){},querySelector(selector){if(selector==='.st-range')return range;return fields?.[selector.match(/data-st-filter="([^"]+)"/)?.[1]];}};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show:(_,body)=>{
  html=body;dialog.open=true;range={open:false,querySelector:()=>summary};
  fields=Object.fromEntries(['from','to'].map(name=>[name,{dataset:{stFilter:name},value:html.match(new RegExp('data-st-filter="'+name+'" value="([^"]*)"'))?.[1],closest(selector){return selector==='[data-st-filter]'?this:selector==='.statements'?{}:null;},hasAttribute:name=>name==='data-st-filter',getAttribute:()=>name,focus(){assert.equal(range.open,true);doc.activeElement=this;}}]));
 },navigate(){}});
 controller.open({owner:'AI_SPECTRUM'});range.open=true;
 for(const [name,value]of [['from','2026-11-02'],['to','2026-11-08']]){
  doc.activeElement=fields[name];fields[name].value=value;handlers.change({target:fields[name]});assert.equal(range.open,true);assert.equal(doc.activeElement,fields[name]);assert.equal(fields[name].value,value);
 }
 assert.equal(fields.from.value,'2026-11-02');assert.equal(fields.to.value,'2026-11-08');
 const button={dataset:{stAction:'close-range'},closest:selector=>selector==='.st-range'?range:{}};
 handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:button},preventDefault(){}});
 assert.equal(range.open,false);assert.equal(dialog.open,true);assert.equal(doc.activeElement,summary);assert.deepEqual(data,before);
 range.open=true;dialog.open=false;doc.activeElement=null;controller.open({owner:'AI_SPECTRUM'});assert.equal(range.open,false);assert.deepEqual(data,before);
});

test('pending order entries open the requested tab in the authorized account and preserve date and return focus',async t=>{
 const saved={document:globalThis.document,location:globalThis.location,CSS:globalThis.CSS};t.after(()=>{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const data=fixture();data.orders[0].status='open';data.orders[0].filled=0;data.flow.fills=data.flow.fills.filter(f=>f.orderId!=='S');data.flow.ledger=data.flow.ledger.filter(e=>e.orderId!=='S');
 const before=structuredClone(data),handlers={},routes=[];let html='',focused=false;
 const entry={dataset:{statements:'AI_SPECTRUM',statementOrder:'S',statementRun:'RUN-S',statementTab:'orders',statementFrom:'2026-11-09',statementTo:'2026-11-09',statementDay:'2026-11-09',statementZone:'Asia/Shanghai',statementAccount:'B',statementEnvironment:'LIVE'},isConnected:true,matches:()=>true,hasAttribute:n=>['data-statements','data-statement-order','data-statement-run'].includes(n),getAttribute:n=>({'data-statements':'AI_SPECTRUM','data-statement-order':'S','data-statement-run':'RUN-S'}[n]),closest:()=>null,focus(){focused=true;}};
 const doc={activeElement:entry,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[entry]};
 globalThis.document=doc;globalThis.location={search:'?page=workbench&queue=1'};globalThis.CSS={escape:x=>x};
 const root={ownerDocument:doc,scrollTop:72,querySelector:()=>null},dialog={ownerDocument:doc,open:false,classList:{add(){},remove(){}},addEventListener(){},close(){this.open=false;}};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',scope:{accountId:'A',environment:'DEMO'}})},show:(_,body)=>{html=body;dialog.open=true;},navigate:(page,context)=>routes.push({page,context})});
 const open=()=>handlers.click({target:{closest:selector=>selector==='[data-statements]'?entry:null},preventDefault(){}});
 const action=name=>handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:{dataset:{stAction:name},closest:()=>({})}},preventDefault(){}});
 await open();assert.ok(html.includes('data-st-tab="openOrders" aria-pressed="true"'));assert.ok(html.includes('data-st-detail="spectrum:S"'));assert.ok(html.includes('A · DEMO'));assert.ok(!html.includes('spectrum:F-S'));
 await action('full');const full=routes.at(-1);assert.equal(full.page,'logs');const params=new URLSearchParams(full.context.search);assert.equal(params.get('st_tab'),'openOrders');assert.equal(params.get('st_day'),'2026-11-09');assert.equal(params.get('st_owner'),'AI_SPECTRUM');
 const page=controller.page(full.context.search);assert.ok(page.includes('data-st-detail="spectrum:S"'));assert.ok(page.includes('data-st-tab="openOrders" aria-pressed="true"'));
 await action('return');assert.equal(routes.at(-1).page,'workbench');assert.equal(routes.at(-1).context.search,'?page=workbench&queue=1');assert.equal(focused,true);assert.equal(root.scrollTop,72);
 entry.dataset.statementTab='orders&st_account=EVIL';await open();assert.ok(html.includes('data-st-tab="fills" aria-pressed="true"'));assert.ok(!html.includes('data-st-detail="spectrum:S"'));assert.ok(html.includes('A · DEMO'));assert.deepEqual(data,before);
});

test('explicit review scope survives day/detail/full/return and rejects unknown IDs or changed accounts',async t=>{
 const {STATEMENT_EXAMPLE}=await import('./trading-preview.mjs');
 const keys=['document','location','history','navigator'],saved=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);t.after(()=>{for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 const handlers={},trade={cash:10000,orders:[{id:'UNCLASSIFIED-HISTORY',accountId:'SIM-01',environment:'DEMO',status:'unknown',market:'ETH/USDT'}],flow:{fills:[],ledger:[]},accountSummary:{accountId:'SIM-01',environment:'DEMO'}},before=structuredClone(trade);
 let current={state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}},html='',navigation=null,copied='',runCalls=0,streamCalls=0,storageCalls=0;
 const doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};
 Object.defineProperty(globalThis,'document',{configurable:true,value:doc});Object.defineProperty(globalThis,'location',{configurable:true,value:{search:'?page=workbench&st_example='+STATEMENT_EXAMPLE.id,hostname:'localhost'}});
 Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState:(_a,_b,s)=>{location.search=s;}}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{copied=value;}}}});
 const host={set outerHTML(value){html=value;},querySelector:()=>null,prepend(){}},root={ownerDocument:doc,scrollTop:0,querySelector:selector=>selector==='.statements'?host:null},dialog={open:false,classList:{add(){},remove(){}},addEventListener(){},close(){this.open=false;},querySelector:()=>null};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>trade,syncStatus:()=>current,streamAction(){streamCalls++;}},show:(_,body)=>{html=body;dialog.open=true;},navigate:(page,context)=>{navigation={page,...context};location.search=context?.search||'?page='+page;if(page==='execution')runCalls++;},storage:{getItem(){return null;},setItem(){storageCalls++;}}});
 const entry=async dataset=>{const node={dataset};await handlers.click({target:{closest:selector=>selector==='[data-statements]'?node:null},preventDefault(){}});};
 const action=async dataset=>{const node={dataset,closest:selector=>selector==='.statements'?{}:null};await handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:node},preventDefault(){}});};
 await entry({statements:'AI_SPECTRUM',statementExample:STATEMENT_EXAMPLE.id,statementFrom:'2026-10-11',statementTo:'2026-11-09',statementDay:'2026-11-09',statementZone:'Asia/Shanghai'});
 assert.match(html,/参考数据 · 只读/);assert.doesNotMatch(html,/审阅账单/);assert.match(html,/data-st-detail/);assert.equal(storageCalls,0);
 const key=html.match(/data-st-detail="([^"]+)"/)[1];await action({stDetail:key});assert.match(html,/参考数据 · 只读/);assert.doesNotMatch(html,/data-st-action="run"/);
 await action({stAction:'copy',stCopy:'PNL-EXAMPLE'});assert.equal(copied,'参考数据 · 只读 · PNL-EXAMPLE');await action({stAction:'run',stRun:'example'});assert.equal(runCalls,0);
 await action({stAction:'full'});assert.equal(navigation.page,'logs');assert.match(navigation.search,/st_example=spectrum-20261109/);assert.match(navigation.search,/st_day=2026-11-09/);
 html=controller.page(navigation.search);assert.match(html,/参考数据 · 只读/);assert.match(html,/data-st-detail/);
 await action({stAction:'return'});assert.equal(location.search,'?page=workbench&st_example='+STATEMENT_EXAMPLE.id);
 html=controller.page('?page=logs&st_example='+STATEMENT_EXAMPLE.id);current={...current,state:'DISCONNECTED'};doc.body.dataset.page='logs';controller.tick();assert.match(html,/记录暂不可用/);assert.doesNotMatch(html,/data-st-detail/);current={...current,state:'LIVE'};
 html=controller.page('?page=logs&st_example=invalid');assert.match(html,/参考数据 · 只读/);assert.doesNotMatch(html,/data-st-detail/);await action({stAction:'refresh'});assert.equal(streamCalls,0);
 html=controller.page('?page=logs&st_example='+STATEMENT_EXAMPLE.id);assert.match(html,/data-st-detail/);current={...current,scope:{accountId:'OTHER',environment:'LIVE'}};doc.body.dataset.page='logs';controller.tick();assert.match(html,/记录暂不可用/);assert.doesNotMatch(html,/data-st-detail/);
 current={state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}};await entry({statements:'AI_SPECTRUM'});assert.doesNotMatch(html,/参考数据 · 只读/);await action({stAction:'full'});assert.doesNotMatch(navigation.search,/st_example/);assert.deepEqual(trade,before);
});

test('a connected wallet replaces the paper account on trade history',()=>{
 const saved={document:globalThis.document,location:globalThis.location};
 try{
  const address='0x'+'ab'.repeat(20);
  const trade={orders:[{id:'PAPER',accountId:'SIM-01',environment:'DEMO',tradeOwner:'STRATEGY_AGENT',market:'BTC/USDT',currency:'USDT',marketType:'SPOT',side:'buy',price:100,qty:1,filled:1,status:'filled',recordedAt:Date.parse('2026-11-23T02:00:00Z')}],flow:{fills:[],ledger:[]},accountSummary:{accountId:'SIM-01',environment:'DEMO'},connections:{tradingAccounts:[{id:'wallet-bsc',status:'connected',accountId:address,chain:'56'}]}};
  globalThis.document={body:{dataset:{page:'logs'}},addEventListener(){}};globalThis.location={search:'?page=logs'};
  const html=createStatements({root:{ownerDocument:document},dialog:{addEventListener(){}},desk:{readSnapshot:()=>trade,syncStatus:()=>({state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}})},show(){},navigate(){}}).page('?page=logs&st_owner=STRATEGY_AGENT');
  assert.match(html,/0xabab…abab · BNB Chain/);assert.doesNotMatch(html,/SIM-01 · DEMO/);assert.doesNotMatch(html,new RegExp(address));assert.doesNotMatch(html,/data-st-copy="PAPER"/);
  const book={symbol:'BTCUSDT',orders:[{orderId:'68949351615',side:'BUY',type:'LIMIT_MAKER',price:'58418.19',origQty:'0.00012',executedQty:'0',status:'NEW',time:Date.parse('2026-11-22T14:08:00Z'),strategy:'S01'}],history:[{orderId:'68874446964',side:'BUY',type:'LIMIT',price:'56251.89',origQty:'0.00009',executedQty:'0.00009',status:'FILLED',time:Date.parse('2026-11-21T04:57:00Z'),strategy:'S01'},{orderId:'68949351639',side:'BUY',type:'LIMIT',price:'59835.24',origQty:'0.00011',executedQty:'0',status:'CANCELED',time:Date.parse('2026-11-22T14:08:00Z'),strategy:'S01'}]};
  const listed=statementRecords({...trade,connections:{...trade.connections,spotBook:book}},{accountId:address,environment:'LIVE'});
  const shown=projectStatements(listed,statementScope('',{accountId:address,environment:'LIVE',owner:'STRATEGY_AGENT',currency:'',timeZone:'Asia/Shanghai'}));
  assert.deepEqual(shown.openOrders.map(row=>row.id),['68949351615']);
  assert.deepEqual(shown.historyOrders.map(row=>row.id),['68949351639','68874446964']);
  assert.deepEqual(shown.fills.map(row=>row.order.id),['68874446964']);
  assert.equal(statementRecords({...trade,connections:{...trade.connections,spotBook:book}},{accountId:'SIM-01',environment:'DEMO'}).orders.some(row=>row.id==='68874446964'),false);
 }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('binance spot fills, the statement total and realized PnL use one fee-inclusive ledger',()=>{
 const book=publicSpotBook({symbol:'BTCUSDT',usdt:1,usdtLocked:0,btc:0.0006,btcPrice:62000,orders:[],history:[
  {orderId:'68874446964',side:'BUY',type:'MARKET',price:'0.00000000',origQty:'0.001',executedQty:'0.001',cummulativeQuoteQty:'60',status:'FILLED',time:Date.parse('2026-11-21T04:57:00Z')},
  {orderId:'68874446965',side:'SELL',type:'LIMIT',price:'61000',origQty:'0.0004',executedQty:'0.0004',cummulativeQuoteQty:'24.4',status:'FILLED',time:Date.parse('2026-11-21T05:57:00Z')}
 ],trades:[
  {id:'1',orderId:'68874446964',price:'60000',qty:'0.001',quoteQty:'60',commission:'0.06',commissionAsset:'USDT',isBuyer:true,time:Date.parse('2026-11-21T04:57:00Z')},
  {id:'2',orderId:'68874446965',price:'61000',qty:'0.0004',quoteQty:'24.4',commission:'0.0244',commissionAsset:'USDT',isBuyer:false,time:Date.parse('2026-11-21T05:57:00Z')}
 ]});
 const ledger=spotTradeLedger(book);
 const records=statementRecords({orders:[],flow:{fills:[],ledger:[]},connections:{spotBook:book}},{accountId:'BINANCE-SPOT',environment:'LIVE'});
 const sell=records.fills.find(row=>row.side==='sell');
 const shown=projectStatements(records,statementScope('',{accountId:'BINANCE-SPOT',environment:'LIVE',owner:'STRATEGY_AGENT',currency:'USDT',timeZone:'UTC'}));
 assert.equal(records.orders.find(row=>row.id==='68874446964').price,null);
 assert.ok(Math.abs(Number(sell.realizedGross)-ledger.closes.get('68874446965'))<1e-9);
 assert.ok(Math.abs(Number(shown.net)-ledger.realized)<1e-9);
 assert.ok(shown.fees>0);assert.ok(records.events.filter(row=>row.type==='FEE').every(row=>row.excludeFromNet===true));
});
