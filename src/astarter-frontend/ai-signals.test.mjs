import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingDemo,DEFAULT_CONNECTIONS,quickTicketError} from './trading-demo.mjs';
import {ticketConfigError,marketSignalRows,refreshedSignalTicket,createAISignals} from './intelligence-experience.mjs';
import {MultiResearch} from './multi-research.mjs';
const ctx={ready:true,market:'ETH/USDT',price:100,revision:'research-ETH:v1'};
const draft={market:ctx.market,strategy:'S03',mode:'confirm',amount:100,cap:500};
const ticket=()=>({sourceId:ctx.revision,revision:ctx.revision,title:'ETH demo',quotePrice:100,quotedAt:0,stopLoss:98,takeProfit:104,maxGap:.5});
const step=(d,seconds,c=ctx)=>{for(let i=0;i<seconds*10;i++)d.tick(.1,c);};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('completed one-shot hides active exit settings while pending orders and positions keep them',()=>{
 const saved=globalThis.document,dialog={setAttribute(){},addEventListener(){},close(){}};
 try{
  globalThis.document={body:{append(){}},createElement:()=>dialog,addEventListener(){}};
  const demo=new TradingDemo(),research=new MultiResearch(),w=new WorkspaceSim({research});
  const view=createAISignals({w,desk:{readSnapshot:()=>demo},research,root:{},refresh(){},go(){},notify(){}});
  assert.equal(demo.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket()),null);
  assert.match(view.protection({compact:true}),/as-protection/);step(demo,3);
  assert.match(view.protection({compact:true}),/as-protection/);
  demo.closePosition();step(demo,3);assert.equal(demo.position,null);assert.equal(demo.pending,null);
  const before=JSON.stringify(demo);assert.equal(view.protection({compact:true}),'');assert.equal(JSON.stringify(demo),before);
 }finally{if(saved===undefined)delete globalThis.document;else globalThis.document=saved;}
});
test('tickets reject stale quotes, revised evidence, invalid prices and exit conditions',()=>{
 assert.equal(quickTicketError(ticket(),ctx,0),null);
 for(const t of [{quotedAt:-46},{quotedAt:1},{revision:'old'},{quotePrice:0},{quotePrice:NaN},{stopLoss:100},{takeProfit:99},{maxGap:3}])assert.ok(quickTicketError({...ticket(),...t},ctx,0));
 assert.ok(quickTicketError(ticket(),{...ctx,price:101},0));
 assert.ok(quickTicketError(ticket(),{...ctx,ready:false},0));
 assert.ok(quickTicketError(ticket(),{...ctx,conflict:true},0));
});
test('one ticket submits one buy, fills same ledger and does not repeat entry',()=>{
 const d=new TradingDemo();let billed=0;assert.equal(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket(),()=>billed++),null);
 assert.equal(d.orders.length,1);assert.ok(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket(),()=>billed++));assert.equal(billed,1);
 step(d,1.5);near(d.position.qty,.5);near(d.cash,9949.95);assert.equal(d.orders[0].status,'partial');
 step(d,80);assert.equal(d.orders.length,1);near(d.position.qty,1);near(d.cash,9899.9);assert.equal(d.state,'paused');assert.equal(d.flow.fills.length,2);
 assert.equal(d.flow.plans[0].protection.takeProfit,104);
});
test('take profit closes once, charges exit fee, releases reservation and preserves source',()=>{
 const d=new TradingDemo();d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket());step(d,3);step(d,4,{...ctx,price:104});
 assert.equal(d.orders.length,2);assert.equal(d.position,null);near(d.cash,10003.796);near(d.totalFees,.204);assert.equal(d.state,'stopped');
 assert.equal(d.orders[0].exitReason,'takeProfit');assert.equal(d.orders[0].sourceId,ctx.revision);step(d,20,{...ctx,price:90});assert.equal(d.orders.length,2);
 assert.ok(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,{...ticket(),quotedAt:d.time}));
});
test('stop loss works after pause and without requiring fresh entry evidence',()=>{
 const d=new TradingDemo();d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket());step(d,3);d.stop();step(d,4,{...ctx,ready:false,price:97});assert.equal(d.position,null);near(d.cash,9996.803);assert.equal(d.orders[0].exitReason,'stopLoss');
});
test('rejected protection attempt never loops or fabricates a fill',()=>{
 const d=new TradingDemo();d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket());step(d,3);d.orderScenario='rejected';step(d,30,{...ctx,price:95});assert.equal(d.orders.length,2);assert.equal(d.orders[0].status,'rejected');near(d.position.qty,1);near(d.cash,9899.9);
});
test('unknown exit keeps pending original and blocks competing protection',()=>{
 const d=new TradingDemo();d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket());step(d,3);d.orderScenario='unknown';step(d,10,{...ctx,price:104});assert.equal(d.orders.length,2);assert.equal(d.pending.status,'unknown');assert.ok(d.triggerProtection('stopLoss',98));step(d,10,{...ctx,price:90});assert.equal(d.orders.length,2);near(d.position.qty,1);
});
test('partial buy cancellation protects only confirmed inventory; restore never re-enters',()=>{
 const d=new TradingDemo();d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket());step(d,1.5);d.pause();near(d.position.qty,.5);
 const restored=new TradingDemo();assert.equal(restored.restore({...d,flow:d.flow}),true);step(restored,4,{...ctx,price:104});assert.equal(restored.position,null);assert.equal(restored.orders.length,2);near(restored.orders[0].qty,.5);
});
test('order form respects account limits and finite prices',()=>{
 const w={s:{risk:{cap:1000,dailyLoss:25}}},c={amount:100,cap:500,stopLoss:98,takeProfit:104};assert.equal(ticketConfigError(c,100,w),null);assert.ok(ticketConfigError({...c,amount:1000,stopLoss:90},100,w));assert.ok(ticketConfigError(c,NaN,w));assert.ok(ticketConfigError({...c,cap:2000},100,w));
});
test('market feed includes strategy, onchain, macro, sentiment and explicit wallet fixtures',()=>{
 const rows=marketSignalRows(new MultiResearch());for(const source of ['strategy','onchain','social','macro','money'])assert.ok(rows.some(r=>r.source===source));assert.equal(rows.filter(r=>r.source==='money').length,2);
});

import {WorkspaceSim} from './workspace-sim.mjs';
import {tradeAnalytics} from './product-views.mjs';
test('entry debits credits once, records authorization, and protection exits with zero credits',()=>{
 const w=new WorkspaceSim(),d=new TradingDemo(),config={...w.draft()};assert.equal(w.checkStart(config),null);
 assert.equal(d.quickOrder({...config,market:ctx.market},DEFAULT_CONNECTIONS,ctx,ticket(),s=>w.started(s)),null);assert.equal(w.available,996);assert.equal(w.s.usage.length,1);
 assert.ok(d.orders[0].operationId);assert.ok(d.session.authorizationId);assert.ok(d.session.usageId);
 assert.ok(d.quickOrder({...config,market:ctx.market},DEFAULT_CONNECTIONS,ctx,ticket(),s=>w.started(s)));assert.equal(w.available,996);step(d,3);w.s.credits=0;
 assert.equal(d.triggerProtection('takeProfit',104),null);step(d,3);assert.equal(w.s.credits,0);assert.equal(w.s.usage.length,1);assert.equal(d.position,null);
 const a=tradeAnalytics({...d,flow:d.flow,equity:d.equity});assert.equal(a.reconciles,true);near(a.history.at(-1),d.equity);
});

test('explicit quote refresh adopts qualified evidence for the same asset and clears old permission without replacing user inputs',()=>{
 const t={...ticket(),market:ctx.market,amount:140,cap:500,walletAuthorized:true,authorizationKey:'old-grant'},before=JSON.stringify(t);
 const next=refreshedSignalTicket(t,{...ctx,price:101,revision:'research-ETH:v2'},9);
 assert.equal(next.sourceId,'research-ETH:v2');assert.equal(next.quotePrice,101);assert.equal(next.quotedAt,9);assert.equal(next.walletAuthorized,false);assert.equal(next.authorizationKey,'');
 assert.equal(next.amount,140);assert.equal(next.cap,500);assert.equal(next.stopLoss,98);assert.equal(next.takeProfit,104);assert.equal(JSON.stringify(t),before);
 for(const patch of [{ready:false},{market:'BTC/USDT'},{price:NaN},{price:0},{revision:''}])assert.equal(refreshedSignalTicket(t,{...ctx,...patch},9),null);
});


test('an opportunity opens the matching signal plan without creating an order or credit task',()=>{
 const previous=globalThis.document;
 try{
  globalThis.document={body:{append(){}},addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const w=new WorkspaceSim(),research=new MultiResearch(),demo=new TradingDemo(),before=JSON.stringify(w.s),orders=demo.orders.length;
  const signals=createAISignals({w,desk:{snapshot:()=>demo},research,root:{},refresh(){},go(){},notify(){}});
  assert.equal(signals.review('ETH'),true);const eth=signals.render();assert.match(eth,/<h2 id="sig-detail-title">ETH<\/h2>/);assert.match(eth,/RX03-S/);assert.match(eth,/交易参考|Trade reference/);assert.match(eth,/待补依据|Evidence pending/);assert.doesNotMatch(eth,/示例推演|Illustrative scenario|0\.5%/);assert.doesNotMatch(eth,/协作发现|Team findings/);
  assert.equal(signals.review('NOT-AN-ASSET'),false);assert.equal(signals.render(),eth);assert.equal(JSON.stringify(w.s),before);assert.equal(demo.orders.length,orders);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('research updates do not overwrite historical signal records or interrupt an open control',()=>{
 const previous=globalThis.document;let refreshes=0,expanded=false;
 try{
  globalThis.document={body:{append(){}},querySelector:()=>null,activeElement:null,addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const research=new MultiResearch(),w=new WorkspaceSim({research}),demo=new TradingDemo(),root={scrollTop:23,contains:()=>false,querySelectorAll:()=>[],querySelector:q=>q==='.sig-tracking'?{}:q==='details[open]'&&expanded?{}:null};
  const view=createAISignals({w,desk:{snapshot:()=>demo},research,root,refresh(){refreshes++;},go(){},notify(){}});
  assert.doesNotMatch(view.render(),/data-track-record=|2026-10-24/);assert.equal(view.review('ETH'),true);
  assert.match(view.render(),/2026-10-24/);assert.match(view.render(),/历史记录|Historical record/);research.advance(60);
  const historical=view.render();assert.match(historical,/历史记录|Historical record/);assert.doesNotMatch(historical,/进入策略候选|Trend and capital align/);
  research.recheck('ETH','新一轮模拟');const updated=view.render();assert.match(updated,/target-scope-bar/);assert.equal(updated.slice(updated.indexOf('<div class="sig-workspace">')),historical.slice(historical.indexOf('<div class="sig-workspace">')));
  expanded=true;view.tick();assert.equal(refreshes,0);expanded=false;view.tick();assert.equal(refreshes,1);view.tick();assert.equal(refreshes,1);
  assert.equal(root.scrollTop,23);assert.equal(demo.orders.length,0);assert.equal(w.s.usage.length,0);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('the signal header clears shared scope only after an explicit All markets click',()=>{
 const previous=globalThis.document,previousMedia=globalThis.matchMedia,all={dataset:{asView:'all'}};let paints=0;
 try{
  globalThis.document={body:{append(){}},addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  globalThis.matchMedia=()=>({matches:false});
  const research=new MultiResearch(),w=new WorkspaceSim({research}),demo=new TradingDemo(),root={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-as-view]'?[all]:[]};
  w.s.workbenchFilter='scan';w.s.workbenchFocusAsset='BTC';
  const view=createAISignals({w,research,desk:{snapshot:()=>demo},root,refresh(){paints++;},go(){},notify(){}}),before={credits:w.s.credits,usage:JSON.stringify(w.s.usage),drafts:JSON.stringify(w.s.drafts)};
  view.render();view.review('BTC');view.render();assert.equal(w.s.workbenchFocusAsset,'BTC');assert.equal(w.s.workbenchFilter,'scan');
  view.bind();all.onclick();assert.equal(w.s.workbenchFocusAsset,null);assert.equal(w.s.workbenchFilter,'all');assert.equal(paints,1);
  assert.equal(w.s.credits,before.credits);assert.equal(JSON.stringify(w.s.usage),before.usage);assert.equal(JSON.stringify(w.s.drafts),before.drafts);assert.equal(demo.orders.length,0);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;if(previousMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previousMedia;}
});

test('legacy signal execution actions cannot configure a strategy or change an order',()=>{
 const saved=globalThis.document,events=[],routes=[],notices=[],strategies=[];
 const dialog={setAttribute(){},addEventListener(){},close(){},showModal(){throw Error('Per-order dialog must not open');}};
 const button={dataset:{asAction:'agent',id:'ETH'}},root={querySelector:()=>null,querySelectorAll:q=>q==='[data-as-action]'?[button]:[]};
 try{
  globalThis.document={body:{append(){}},createElement:()=>dialog,addEventListener(){},dispatchEvent:event=>events.push(event)};
  const research=new MultiResearch(),w=new WorkspaceSim({research}),demo=new TradingDemo();research.advance(60);
  const before={credits:w.available,draft:JSON.stringify(w.draft())};
  const view=createAISignals({w,desk:{snapshot:()=>demo},research,root,refresh(){},go:page=>routes.push(page),notify:message=>notices.push(message),onStrategy:id=>strategies.push(id)});
  view.bind(root);button.onclick();
  assert.equal(events.length,0);assert.deepEqual(strategies,[]);
  assert.equal(w.s.selectedOpportunity,null);assert.equal(demo.orders.length,0);assert.equal(w.available,before.credits);assert.equal(JSON.stringify(w.draft()),before.draft);
  demo.discovery={armed:true};button.onclick();assert.deepEqual(routes,[]);assert.equal(events.length,0);
  demo.discovery={armed:false};research.task('ETH').outcome='conflict';button.onclick();assert.equal(events.length,0);assert.equal(notices.length,0);assert.equal(demo.orders.length,0);
  assert.equal(w.available,before.credits);assert.equal(JSON.stringify(w.draft()),before.draft);
 }finally{if(saved===undefined)delete globalThis.document;else globalThis.document=saved;}
});

test('viewing a signal strategy forwards its exact template without touching trading state',()=>{
 const previous=globalThis.document,oldMedia=globalThis.matchMedia,opened=[],routes=[],button={dataset:{trackStrategy:'RX03-S'}},root={querySelector:()=>null,querySelectorAll:q=>q==='[data-track-strategy]'?[button]:[]};
 try{
  globalThis.document={body:{append(){}},addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  const research=new MultiResearch(),w=new WorkspaceSim({research}),demo=new TradingDemo(),before=JSON.stringify(w.s);
  const view=createAISignals({w,desk:{snapshot:()=>demo},research,root,refresh(){},go:page=>routes.push(page),notify(){},onStrategy:id=>opened.push(id)});
  globalThis.matchMedia=()=>({matches:false});assert.equal(view.review('ETH'),true);view.render();view.bind();button.onclick();assert.deepEqual(opened,['RX03-S']);assert.equal(routes.length,0);assert.equal(demo.orders.length,0);assert.equal(JSON.stringify(w.s),before);
 }finally{if(oldMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=oldMedia;if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('signal automatic display updates obey the selected interval and defer while a control is open',t=>{
 const previous=globalThis.document,previousStorage=globalThis.localStorage;let at=1000000,refreshes=0,expanded=false,seconds='60';
 t.mock.method(Date,'now',()=>at);
 try{
  globalThis.document={body:{append(){}},querySelector:()=>null,activeElement:null,addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  globalThis.localStorage={getItem:key=>key==='hive.market.refreshSeconds'?seconds:null};
  const research=new MultiResearch(),w=new WorkspaceSim({research}),demo=new TradingDemo(),root={scrollTop:23,contains:()=>false,querySelectorAll:()=>[],querySelector:q=>q==='.sig-tracking'?{}:q==='details[open]'&&expanded?{}:null};
  const view=createAISignals({w,desk:{snapshot:()=>demo},research,root,refresh(){refreshes++;},go(){},notify(){}}),before=JSON.stringify(w.s);
  research.advance(60);view.tick();assert.equal(refreshes,1);
  research.advance(60);at+=59000;view.tick();assert.equal(refreshes,1);at+=1000;view.tick();assert.equal(refreshes,2);
  seconds='15';research.advance(60);at+=15000;expanded=true;view.tick();assert.equal(refreshes,2);expanded=false;view.tick();assert.equal(refreshes,3);
  assert.equal(root.scrollTop,23);assert.equal(demo.orders.length,0);assert.equal(JSON.stringify(w.s),before);
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;if(previousStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previousStorage;}
});

test('run signals and expiry refresh without a research scan and defer while typing',t=>{
 const saved={document:globalThis.document,localStorage:globalThis.localStorage};let now=1000000,paints=0;
 t.mock.method(Date,'now',()=>now);
 const input={value:'ETH',matches:()=>true},snapshot={time:10,orders:[],flow:{fills:[]}},w={s:{signals:[],aiSignalWatch:[],credits:500}},research=new MultiResearch();
 const root={scrollTop:71,contains:element=>element===input,querySelectorAll:()=>[],querySelector:s=>s==='.sig-tracking'?{}:null};
 try{
  globalThis.document={body:{append(){}},activeElement:null,querySelector:()=>null,addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  globalThis.localStorage={getItem:()=>null};
  const view=createAISignals({w,desk:{readSnapshot:()=>snapshot},research,root,refresh(){paints++;},go(){},notify(){}});view.tick();assert.equal(paints,0);
  w.s.signals=[{id:'SIG-1',runId:'RUN-1',market:'ETH/USDT',at:10,validUntil:20}];now+=59000;view.tick();assert.equal(paints,0);now+=1000;view.tick();assert.equal(paints,1);
  snapshot.time=20;now+=60000;document.activeElement=input;view.tick();assert.equal(paints,1);assert.equal(input.value,'ETH');
  document.activeElement=null;view.tick();assert.equal(paints,2);assert.equal(root.scrollTop,71);assert.equal(w.s.credits,500);assert.equal(snapshot.orders.length,0);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('AI signals expose a read-only recommendation source modal without navigating or changing the selected feed',async t=>{
 const previous={document:globalThis.document,location:globalThis.location,matchMedia:globalThis.matchMedia};t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const dialogs=[],listeners=new Map();globalThis.document={body:{dataset:{page:'strategies'},append(){}},addEventListener:(type,fn)=>listeners.set(type,fn),createElement(){const close={},dialog={open:false,innerHTML:'',setAttribute(){},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},querySelector:s=>s==='[data-track-close]'?close:null,querySelectorAll:()=>[]};dialogs.push(dialog);return dialog;}};globalThis.location={search:'?page=strategies'};globalThis.matchMedia=()=>({matches:false});
 const w=new WorkspaceSim(),research=new MultiResearch();w.s.signals=[{id:'SIG-READ',runId:'RUN-READ',sourceId:'research-ETH',version:'v1',market:'ETH/USDT',clockKind:'simulation',observedAt:5,validUntil:10}];
 const root={scrollTop:62,querySelector:()=>null,querySelectorAll:()=>[]},signals=createAISignals({w,research,desk:{readSnapshot:()=>({time:100})},root,refresh(){assert.fail('Read-only source must not repaint the host');},go(){assert.fail('Read-only source must not navigate');},notify(){assert.fail('Caller handles missing sources');}});
 assert.equal(typeof signals.openSource,'function');const feed=signals.render(),state=JSON.stringify(w.s),ref={type:'signal',recordId:'research-ETH:v1:RUN-READ:SIG-READ',sourceId:'research-ETH',signalId:'SIG-READ',runId:'RUN-READ',revision:'v1',asset:'ETH'};let returned=0;
 assert.equal(signals.openSource(ref,()=>returned++),true);assert.equal(dialogs[1].open,true);dialogs[1].querySelector('[data-track-close]').onclick();assert.equal(returned,1);assert.equal(signals.render(),feed);assert.equal(JSON.stringify(w.s),state);assert.equal(root.scrollTop,62);assert.equal(signals.openSource({...ref,revision:'v2'}),false);
 assert.ok(signals.openSource(ref,()=>returned++));listeners.get('hive:page-leave')({detail:'strategies'});
 assert.equal(dialogs[1].open,false);assert.equal(returned,1,'leaving the page does not reopen the previous panel');assert.equal(JSON.stringify(w.s),state);
});
