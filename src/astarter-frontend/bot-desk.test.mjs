import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTradingDesk} from './trading-desk.js?v=20261120c';
import {WorkspaceSim} from './workspace-sim.mjs';
import {TradingAccess} from './trading-access.mjs?v=20261120c';
import {normalizeConnections} from './connections.mjs?v=20261120c';
import {botParameters,BOT_MARKETS} from './bot-runtime.mjs';
import {TradingDemo} from './trading-demo.mjs';
import {startStrategyWatch} from './strategy-journeys.mjs';
import {portfolio,accountOrders} from './product-data.mjs';
import {assetsView,logsView,tradeAnalytics,tradeLogEntries} from './product-views.mjs';

const clone=value=>structuredClone(value);
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
const route={connectionId:'api-main',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''};
const oldCostFixture=JSON.parse(readFileSync(new URL('./bot-cost-legacy.fixture.json',import.meta.url),'utf8')).fixtures[0];
function deskFixture(t,{saved,connections={}}={}){
 const globals={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,Option:globalThis.Option,CustomEvent:globalThis.CustomEvent},elements=new Map();
 class Node{
  constructor(){this.dataset={};this.attrs={};this.nodes=new Map();this.value='';this.textContent='';this.firstChild={textContent:''};this.lastElementChild={textContent:''};this.selectedOptions=[{textContent:''}];this.classList={toggle(){},add(){},remove(){}};}
  setAttribute(k,v){this.attrs[k]=v;}getAttribute(k){return this.attrs[k]??null;}getAttributeNames(){return Object.keys(this.attrs);}removeAttribute(k){delete this.attrs[k];}
  querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Node());return this.nodes.get(key);}querySelectorAll(){return [];}
  addEventListener(){}append(){}prepend(){}after(){}focus(){}scrollIntoView(){}replaceChildren(...nodes){if(nodes[0]?.value!==undefined){this.value=nodes[0].value;this.selectedOptions=nodes;}}
 }
 const node=id=>{if(!elements.has(id))elements.set(id,new Node());return elements.get(id);};
 const config=normalizeConnections({exchange:true,data:true,ai:true,preferences:{exchange:{service:'binance',market:'spot',access:'trade'}},tradingAccounts:[{id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'}],preferredTradingConnection:'api-main',...connections});
 const values=new Map([['hive-demo.connections.v1',JSON.stringify(config)]]),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 globalThis.document={hidden:false,documentElement:{lang:'zh-CN'},body:node('body'),getElementById:node,querySelector:node,querySelectorAll:()=>[],createElement:()=>new Node(),addEventListener(){},dispatchEvent(){}};
 globalThis.document.body.dataset.page='execution';globalThis.window={addEventListener(){}};globalThis.localStorage=storage;
 globalThis.Option=class extends Node{constructor(text,value){super();this.textContent=text;this.value=value;}};
 globalThis.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options?.detail;}};
 for(const [id,value] of Object.entries({'trade-market':'BTC/USDT','trade-strategy':'S03','trade-mode':'auto','trade-amount':'100','trade-cap':'500'}))node(id).value=value;
 const w=new WorkspaceSim({storage});if(saved)w.s.trade=clone(saved);
 // Capture the real private runtime without replacing its permission behavior.
 const configure=TradingAccess.prototype.configure;let access;
 TradingAccess.prototype.configure=function(...args){access=this;return configure.apply(this,args);};
 let desk;
 try{desk=createTradingDesk({workspace:w,model:{config:{actors:[]},elapsed:0,runId:'TEST'},market:()=> 'BTC/USDT',prepare:async()=>null,notice(){},getResearchContext:market=>({ready:true,market,revision:'research-1',price:BOT_MARKETS[market]})});}
 finally{TradingAccess.prototype.configure=configure;}
 access.configure(config,{section:'exchange',operation:'verify',connectionId:'api-main'});
 t.after(()=>{for(const [key,value] of Object.entries(globals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 return {w,desk,access,connections:config};
}
function approved(w,{strategy='S02',cap=500,amount=100,market='ETH/USDT',triggerPrice}={}){
 const d=w.createDraft(strategy),bot=botParameters(strategy,BOT_MARKETS[market]);if(triggerPrice!==undefined)bot.triggerPrice=triggerPrice;
 assert.equal(w.saveDraft(d.id,{...d,market,amount,cap,executionRoute:route,planVariant:strategy+'-SIM',botParameters:bot}),null);
 assert.ok(w.validateSetup().run);d.botLaunch={requestId:d.id+':approval',status:'accepted'};return clone(d);
}
const tick=(desk,n)=>{for(let i=0;i<n*10;i++)desk.tick(.1);};

test('desk precheck blocks new fee-negative plans while exact historical receipts stay readable',t=>{
 const first=deskFixture(t),a=approved(first.w,{strategy:'S01'}),before=first.desk.snapshot();
 a.botParameters={lower:100000,upper:100010,count:2,spacing:'arithmetic'};
 assert.match(first.desk.botCreateError(a),/手续费/);assert.match(first.desk.createBot(a),/手续费/);assert.deepEqual(first.desk.snapshot(),before);
 const saved={...before,cash:oldCostFixture.cash,botBook:oldCostFixture.state},next=deskFixture(t,{saved});
 const original={...oldCostFixture.plan,botLaunch:{requestId:oldCostFixture.requestId,status:'accepted'}},restored=next.desk.snapshot();
 assert.equal(next.desk.botCreateError(original),null);assert.equal(next.desk.createBot(original),null);
 assert.equal(next.desk.snapshot().cash,restored.cash);assert.deepEqual(next.desk.snapshot().botBook,restored.botBook);
 assert.match(next.desk.createBot({...original,amount:101}),/请求编号/);
 assert.match(next.desk.createBot({...original,botLaunch:{...original.botLaunch,requestId:'NEW-REQUEST'}}),/手续费/);
 next.desk.selectContext({accountId:'SIM-02'});assert.ok(next.desk.createBot(original));
 assert.equal(next.desk.snapshot().cash,restored.cash);assert.equal(next.desk.snapshot().botBook.runs.length,1);
});

test('account summary shares the execution cash owner and releases only ended BOT allocations',t=>{
 const {w,desk}=deskFixture(t),initial=desk.readSnapshot().accountSummary;
 assert.deepEqual(initial,{accountId:'SIM-01',environment:'DEMO',unit:'USDT',asOf:0,equity:10000,cash:10000,available:10000,reserved:0,risk:{allocated:0,loss:0,fees:0,locked:false},positions:0,orders:0});
 for(let i=0;i<2;i++)assert.equal(desk.createBot(approved(w,{triggerPrice:1})),null);
 const data=desk.readSnapshot(),summary=data.accountSummary;
 assert.equal(summary.equity,portfolio(data).equity);assert.equal(summary.cash,10000);
 assert.equal(summary.available,9000);assert.equal(summary.reserved,1000);assert.equal(summary.positions,0);assert.equal(summary.orders,0);
 for(const run of data.botBook.runs)assert.equal(desk.botAction(run.id,'stop-keep',{requestId:'SUMMARY-END-'+run.id}),null);
 const ended=desk.readSnapshot().accountSummary;
 assert.equal(ended.available,10000);assert.equal(ended.reserved,0);assert.equal(ended.equity,10000);
 desk.selectContext({accountId:'OTHER'});assert.equal(desk.readSnapshot(),null);
});

test('asset snapshot and views include native BOT orders, fees, holdings and unspent allocations once',t=>{
 const {w,desk}=deskFixture(t);
 assert.equal(desk.createBot(approved(w,{market:'ETH/USDT'})),null);
 assert.equal(desk.createBot(approved(w,{market:'BTC/USDT',triggerPrice:1})),null);
 tick(desk,46);
 const data=desk.readSnapshot(),before=JSON.stringify(data),p=portfolio(data),orders=data.botBook.runs.flatMap(run=>run.orders),analytics=tradeAnalytics(data);
 assert.ok(orders.some(order=>order.filled>0));assert.equal(data.orders.length,0);
 assert.equal(p.orders,orders.length);assert.equal(p.filled,orders.filter(o=>o.filled>0).length);
 assert.equal(p.freeCash,data.accountSummary.available);near(p.reservedCash,data.accountSummary.reserved);
 near(p.botCash,data.botSummary.cash);near(p.freeCash+p.reservedCash+p.held,p.equity);
 assert.equal(p.positions.length,1);assert.equal(p.positions[0].market,'ETH/USDT');near(p.positions[0].inventoryValue,p.held);
 near(analytics.orders.reduce((sum,o)=>sum+o.fee,0),p.fees);
 assert.equal(analytics.fills.length,data.botBook.flow.fills.length);
 const html=assetsView({d:data});assert.match(html,/策略与订单占用|Strategy &amp; order funds|Strategy & order funds/);
 assert.match(html,/data-chart="tc-account-fees"/);assert.match(html,/ETH/);assert.doesNotMatch(html,/NaN|undefined/);
 const logs=logsView({d:data,rows:accountOrders(data),filter:'全部'});
 assert.match(logs,new RegExp(orders[0].id));assert.doesNotMatch(logs,/手动交易|Manual trade/);
 assert.equal(accountOrders(data)[0].strategy,'S02');
 const activity=logsView({d:{...data,events:[{at:1,text:'策略已暂停。'}]},rows:[],filter:'策略操作'});assert.doesNotMatch(activity,/手动交易|Manual trade/);
 assert.equal(tradeLogEntries({d:data,query:'S02'}).length,p.orders);assert.equal(tradeLogEntries({d:data,query:'S01'}).length,0);
 assert.equal(JSON.stringify(data),before);
 const duplicated={...data,orders:[orders[0]]};assert.equal(portfolio(duplicated).orders,p.orders);
 const foreign=structuredClone(data.botBook.runs[0]);foreign.plan.executionRoute.accountId='OTHER';
 foreign.id='FOREIGN';foreign.orders=[{...orders[0],id:'FOREIGN-ORDER',runId:'FOREIGN',accountId:'OTHER'}];
 assert.equal(portfolio({...data,botBook:{...data.botBook,runs:[...data.botBook.runs,foreign]}}).orders,p.orders);

 const entered=data.botBook.runs[0],waiting=data.botBook.runs[1];
 assert.equal(desk.botAction(entered.id,'stop-close',{requestId:'ASSETS-CLOSE'}),null);tick(desk,4);
 const firstEnded=desk.readSnapshot(),partial=portfolio(firstEnded);
 assert.equal(firstEnded.botBook.runs[0].status,'stopped');assert.equal(firstEnded.botBook.runs[1].status,'waiting');
 near(partial.held,0);near(partial.reservedCash,500);near(partial.botCash,500);
 near(partial.freeCash+partial.reservedCash,partial.equity);
 assert.ok(partial.orders>0);assert.ok(partial.filled>0);assert.ok(partial.fees>0);
 assert.equal(desk.botAction(waiting.id,'stop-keep',{requestId:'ASSETS-RETURN'}),null);
 const ended=portfolio(desk.readSnapshot());near(ended.reservedCash,0);near(ended.freeCash,ended.equity);
 assert.equal(ended.orders,partial.orders);assert.equal(ended.filled,partial.filled);near(ended.fees,partial.fees);
});

test('creating two approved BOTs uses one cash owner and same request retries never reserve twice',t=>{
 const {w,desk}=deskFixture(t),a=approved(w),b=approved(w);
 assert.equal(desk.createBot(a),null);assert.equal(desk.snapshot().cash,9500);
 assert.equal(desk.createBot(a),null);assert.equal(desk.snapshot().cash,9500);
 assert.equal(desk.createBot(b),null);const saved=desk.snapshot();
 assert.equal(saved.cash,9000);assert.equal(saved.botBook.runs.length,2);assert.equal(saved.botSummary.allocated,1000);
 assert.equal(portfolio(saved).equity,10000);assert.equal(saved.orders.length,0);
 assert.equal(w.s.trade.botBook.runs.length,2);assert.equal(desk.readSnapshot().botBook.runs.length,2);
 const c=approved(w),before=JSON.stringify(desk.snapshot());assert.match(desk.createBot(c),/额度|上限/);assert.equal(JSON.stringify(desk.snapshot()),before);
});

test('restoring a saved BOT book neither reallocates nor releases its cash and preserves corrupt input',t=>{
 const first=deskFixture(t),a=approved(first.w);assert.equal(first.desk.createBot(a),null);
 tick(first.desk,4);const saved=first.desk.snapshot(),equity=portfolio(saved).equity;
 const next=deskFixture(t,{saved}),restored=next.desk.snapshot();
 assert.equal(restored.cash,saved.cash);near(portfolio(restored).equity,equity);assert.equal(restored.botBook.runs[0].status,'interrupted');
 const broken={...saved,botBook:{...saved.botBook,runs:[{bad:'unreadable'}]}},bad=deskFixture(t,{saved:broken}),snapshot=bad.desk.snapshot();
 assert.equal(snapshot.cash,saved.cash);assert.deepEqual(snapshot.botBook,broken.botBook);assert.match(snapshot.botSummary.recoveryError,/恢复|账本/);
 const b=approved(bad.w);assert.match(bad.desk.createBot(b),/恢复|账本/);assert.deepEqual(bad.desk.snapshot().botBook,broken.botBook);
});

test('BOT actions retain the original account, connection and unknown order without resubmitting',t=>{
 const {w,desk}=deskFixture(t),a=approved(w);a.simulationScenario='unknown';
 assert.equal(desk.createBot(a),null);tick(desk,46);let s=desk.snapshot(),run=s.botBook.runs[0];
 const order=run.orders.find(order=>order.status==='unknown');assert.ok(order,JSON.stringify({status:run.status,reason:run.pauseReason,orders:run.orders,events:run.events}));
 const request={requestId:'QUERY-ONE',expectedAccountId:'SIM-01',expectedConnectionId:'api-main',expectedEnvironment:'DEMO',orderId:order.id};
 assert.equal(desk.botAction(run.id,'query',request),null);const before=desk.snapshot();
 assert.equal(desk.botAction(run.id,'query',request),null);assert.equal(desk.snapshot().botBook.runs[0].orders.length,before.botBook.runs[0].orders.length);assert.equal(desk.snapshot().cash,before.cash);
 assert.match(desk.botAction(run.id,'pause',{...request,requestId:'WRONG',expectedAccountId:'SIM-02'}),/账户|接入/);
 desk.selectContext({accountId:'SIM-02'});assert.match(desk.botAction(run.id,'query',{...request,requestId:'OTHER-VIEW'}),/账户|接入/);
 assert.equal(desk.snapshot().botBook.runs[0].orders.length,before.botBook.runs[0].orders.length);
});

test('legacy start and watch cannot consume BOT allocated capital or exceed the shared account cap',t=>{
 const {w,desk}=deskFixture(t),a=approved(w);assert.equal(desk.createBot(a),null);
 const d=w.draft('D-S03');assert.equal(w.saveDraft(d.id,{...d,market:'BTC/USDT',cap:600,executionRoute:route}),null);
 assert.ok(w.validateSetup().run);for(let i=0;i<30;i++)w.tick(.2);
 desk.configure(clone(d));assert.match(desk.start(),/额度|上限/);assert.match(desk.arm(clone(d)),/额度|上限/);
 const access=desk.access({...route,operation:'entry'}),ticket={profileId:'cex-spot',connectionId:'api-main',accountId:'SIM-01',scopeGeneration:access.scopeGeneration,accessRevision:access.revision};
 assert.match(desk.quickOrder({market:d.market},clone(d),ticket),/额度|上限/);
 assert.equal(desk.snapshot().session,null);assert.equal(desk.snapshot().cash,9500);
});

test('a legacy waiting allocation and pending reservation reduce available cash only once',t=>{
 const {w,desk}=deskFixture(t),d=w.draft();assert.equal(w.saveDraft(d.id,{...d,market:'BTC/USDT',executionRoute:route}),null);assert.ok(w.validateSetup().run);for(let i=0;i<30;i++)w.tick(.2);
 assert.equal(desk.arm(clone(d)),null);const a=approved(w);assert.equal(desk.createBot(a),null);
 assert.equal(desk.snapshot().cash,9500);assert.equal(desk.snapshot().botSummary.allocated,500);
 const next=approved(w);assert.match(desk.createBot(next),/额度|上限/);
});

test('native BOT permission ignores research AI readiness but still pauses when its trade access expires',t=>{
 const {w,desk,access}=deskFixture(t,{connections:{data:false,ai:false}}),a=approved(w);
 assert.equal(desk.createBot(a),null);tick(desk,1);const run=desk.snapshot().botBook.runs[0];assert.equal(run.status,'running');
 access.change('expire-connection','Arbitrum','api-main');tick(desk,1);assert.equal(desk.snapshot().botBook.runs[0].status,'paused');
 const before=desk.snapshot().botBook.runs[0].orders.length;
 assert.match(desk.botAction(run.id,'resume',{requestId:'EXPIRED-RESUME'}),/过期|接入|权限|阻止/);tick(desk,1);assert.equal(desk.snapshot().botBook.runs[0].orders.length,before);
 assert.equal(desk.botAction(run.id,'pause',{requestId:'SAFE-PAUSE'}),null);
});

test('BOT PnL and fees remain in shared equity after allocation and enforce the account loss limit',t=>{
 const {w,desk}=deskFixture(t),a=approved(w);assert.equal(desk.createBot(a),null);tick(desk,46);
 const before=desk.snapshot(),p=portfolio(before);near(p.equity,before.cash+before.botSummary.equity);near(p.fees,before.totalFees+before.botSummary.fees);assert.ok(before.botSummary.fees>0,JSON.stringify(before.botBook.runs[0]));
 w.s.risk.dailyLoss=.01;tick(desk,1);assert.equal(desk.snapshot().botBook.runs[0].status,'paused');
 const next=approved(w);assert.match(desk.createBot(next),/保护|亏损|上限/);
});

test('returning unused BOT capital credits the same account once and preserves instance order isolation',t=>{
 const {w,desk}=deskFixture(t),a=approved(w,{triggerPrice:1});assert.equal(desk.createBot(a),null);const id=desk.snapshot().botBook.runs[0].id;
 const request={requestId:'STOP-ONE'};assert.equal(desk.botAction(id,'stop-keep',request),null);assert.equal(desk.snapshot().cash,10000);
 assert.equal(desk.botAction(id,'stop-keep',request),null);assert.equal(desk.snapshot().cash,10000);assert.equal(desk.snapshot().botSummary.allocated,0);
 assert.equal(desk.snapshot().orders.length,0);assert.equal(portfolio(desk.snapshot()).equity,10000);
});

test('preflight checks shared capital before approval without mutating funds or authorizing creation',t=>{
 const {w,desk}=deskFixture(t),a=approved(w),unapproved={...a};delete unapproved.botLaunch;
 const before=JSON.stringify(desk.snapshot());assert.equal(desk.botCreateError(unapproved),null);assert.equal(JSON.stringify(desk.snapshot()),before);
 assert.match(desk.createBot(unapproved),/批准|请求/);assert.equal(desk.snapshot().cash,10000);
 assert.equal(desk.createBot(a),null);const b=approved(w,{cap:600});
 assert.match(desk.botCreateError(b),/额度|上限/);
});

test('a legacy hold plus its unused allowance cannot be double allocated from a depleted cash account',t=>{
 const legacy=new TradingDemo();legacy.cash=650;legacy.session={id:'LEGACY',strategy:'S03',market:'BTC/USDT',mode:'auto',amount:100,cap:500,riskVersion:1,executionRoute:route};legacy.state='paused';
 legacy.flow.reservations.push({id:'HOLD',amount:'100',unit:'USDT',state:'HELD'});
 const saved=clone({...legacy,flow:legacy.flow}),{w,desk}=deskFixture(t,{saved});w.s.risk.dailyLoss=20000;
 const a=approved(w),before=JSON.stringify(desk.snapshot());
 assert.match(desk.botCreateError(a),/可用.*余额|预留/);assert.match(desk.createBot(a),/可用.*余额|预留/);assert.equal(JSON.stringify(desk.snapshot()),before);
 assert.equal(desk.snapshot().cash,650);assert.equal(desk.snapshot().flow.reservations[0].amount,'100');
 assert.equal(desk.snapshot().accountSummary.available,150);assert.equal(desk.snapshot().accountSummary.reserved,500);
});

test('risk version changes pause existing BOT entries and preserve safe stop and refund actions',t=>{
 const {w,desk}=deskFixture(t),a=approved(w,{triggerPrice:1});assert.equal(desk.createBot(a),null);const id=desk.snapshot().botBook.runs[0].id;
 assert.equal(w.setRisk({cap:900,dailyLoss:90}),null);tick(desk,.2);
 assert.equal(desk.snapshot().botBook.runs[0].status,'paused');assert.match(desk.botAction(id,'resume',{requestId:'RISK-RESUME'}),/风控版本/);
 assert.equal(desk.botAction(id,'stop-keep',{requestId:'RISK-STOP'}),null);assert.equal(desk.snapshot().cash,10000);
});

test('a native BOT cannot be routed back through the legacy launcher for another reservation',t=>{
 const {w,desk}=deskFixture(t),a=approved(w);assert.equal(desk.createBot(a),null);desk.configure(a);
 assert.match(desk.start(),/创建 BOT/);assert.match(desk.arm(a),/创建 BOT/);assert.equal(desk.snapshot().session,null);assert.equal(desk.snapshot().cash,9500);
});

test('an unreadable parent cash ledger is retained and cannot fall back to a fresh spendable balance',t=>{
 const first=deskFixture(t),a=approved(first.w);assert.equal(first.desk.createBot(a),null);
 const original={...first.desk.snapshot(),cash:'unreadable-cash'},next=deskFixture(t,{saved:original}),snapshot=next.desk.snapshot();
 assert.equal(snapshot.cashKnown,false);assert.deepEqual(snapshot.unreadableTrade,original);assert.deepEqual(snapshot.botBook,original.botBook);
 assert.match(snapshot.botSummary.recoveryError,/账本|恢复/);assert.notEqual(snapshot.cash,10000);
 assert.equal(snapshot.accountSummary,null);
 const b=approved(next.w);assert.match(next.desk.createBot(b),/账本|恢复/);
 const again=deskFixture(t,{saved:snapshot});assert.deepEqual(again.desk.snapshot().unreadableTrade,original);assert.equal(again.desk.snapshot().cashKnown,false);
});

test('the actual explicit approval entry creates a native BOT from the requested receipt',t=>{
 const {w,desk}=deskFixture(t),a=approved(w);delete w.draft(a.id).botLaunch;
 assert.equal(startStrategyWatch(w,desk),null);
 const snap=desk.snapshot(),run=snap.botBook.runs[0];assert.ok(run);assert.equal(run.plan.id,a.id);assert.equal(w.draft(a.id).botLaunch.runId,run.id);assert.equal(snap.cash,9500);
 assert.equal(startStrategyWatch(w,desk),null);assert.equal(desk.snapshot().cash,9500);assert.equal(desk.snapshot().botBook.runs.length,1);
});

test('approval waits for the service receipt and reconciles the same draft without another allocation',async t=>{
 const {w,desk}=deskFixture(t),a=approved(w);delete w.draft(a.id).botLaunch;
 const create=desk.createBot;let resolve,calls=0;desk.createBot=plan=>{calls++;return new Promise(done=>{resolve=()=>done(create(plan));});};
 const result=startStrategyWatch(w,desk);assert.ok(result instanceof Promise);assert.equal(w.draft(a.id).botLaunch.status,'requested');assert.equal(desk.snapshot().cash,10000);
 assert.equal(startStrategyWatch(w,desk),result);assert.equal(calls,1);assert.equal(w.draft(a.id).botLaunch.status,'requested');resolve();assert.equal(await result,null);assert.equal(w.draft(a.id).botLaunch.status,'started');assert.equal(desk.snapshot().cash,9500);assert.equal(desk.snapshot().botBook.runs.length,1);
});

test('a lost async creation result retains its original request for readback',async t=>{
 const {w,desk}=deskFixture(t),a=approved(w);delete w.draft(a.id).botLaunch;let calls=0;
 desk.createBot=async()=>{calls++;throw Error('response lost');};assert.match(await startStrategyWatch(w,desk),/尚未确认/);const id=w.draft(a.id).botLaunch.requestId;
 assert.equal(w.draft(a.id).botLaunch.status,'unknown');assert.match(startStrategyWatch(w,desk),/尚未确认/);assert.equal(w.draft(a.id).botLaunch.requestId,id);assert.equal(calls,1);assert.equal(desk.snapshot().cash,10000);
});

test('completed BOTs without holdings keep a stable history instead of ticking and republishing forever',t=>{
 const {w,desk}=deskFixture(t),a=approved(w);assert.equal(desk.createBot(a),null);const run=desk.snapshot().botBook.runs[0];
 assert.equal(desk.botAction(run.id,'stop-keep',{requestId:'FINISH-IDLE'}),null);const before=desk.snapshot();tick(desk,3);const after=desk.snapshot();
 assert.equal(after.botBook.time,before.botBook.time);assert.equal(after.botBook.revision,before.botBook.revision);assert.deepEqual(after.botBook.history,before.botBook.history);assert.equal(after.cash,10000);
});
