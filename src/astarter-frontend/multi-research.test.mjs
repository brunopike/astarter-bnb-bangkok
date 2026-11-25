import test from 'node:test';import assert from 'node:assert/strict';
import {MultiResearch} from './multi-research.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
test('six exclusive teams research eight independently versioned assets',()=>{const r=new MultiResearch();assert.equal(r.tasks.length,8);assert.equal(r.summary().working,6);const ids=r.jobs().flatMap(j=>j.roles);assert.equal(ids.length,18);assert.equal(new Set(ids).size,18);r.advance(19);assert.equal(r.task('BTC').phase,'core');assert.equal(r.task('SOL').phase,'verify');assert.equal(r.task('NDX').phase,'queued');assert.equal(r.task('BTC').version,1);assert.equal(r.handoff('BTC'),null);});
test('core serially receives reports and all assets finish with provenance',()=>{const r=new MultiResearch();r.advance(150);assert.equal(r.summary().complete,8);assert.equal(r.task('ETH').outcome,'candidate');assert.equal(r.task('SOL').outcome,'conflict');assert.equal(r.task('NDX').outcome,'missing');for(const t of r.tasks){assert.equal(t.evidence.length,6);assert.ok(t.evidence.every(e=>!['pending','collected'].includes(e.status)));assert.ok(t.evidence.every(e=>e.id.startsWith(r.revision(t))));}assert.equal(r.task('XAU').evidence.find(e=>e.key==='chain').status,'na');assert.equal(r.handoff('XAU'),null);assert.equal(r.handoff('SOL'),null);assert.equal(r.handoff('BTC'),null);});
test('handoff is immutable, specific to asset and version, and never starts a trade',()=>{const r=new MultiResearch(),d=new TradingDemo();r.advance(50);const h=r.handoff('ETH');assert.ok(h);assert.ok(Object.isFrozen(h));assert.equal(d.orders.length,0);assert.equal(r.context('ETH',h.revision).ready,true);assert.equal(r.context('BTC',h.revision).ready,false);assert.equal(r.context('ETH').ready,false);const oldBTC=r.task('BTC').version;r.recheck('ETH');assert.equal(r.context('ETH',h.revision).ready,false);assert.equal(r.task('BTC').version,oldBTC);assert.equal(r.task('ETH').version,2);});
test('shared update invalidates dependent crypto tasks, leaves TradFi untouched',()=>{const r=new MultiResearch();r.advance(150);const before=r.tasks.filter(t=>t.domain==='TradFi').map(t=>[t.symbol,t.version,t.phase]);assert.deepEqual(r.refreshShared('chain'),['BTC','ETH','SOL']);assert.deepEqual(r.tasks.filter(t=>t.domain==='TradFi').map(t=>[t.symbol,t.version,t.phase]),before);for(const s of ['BTC','ETH','SOL'])assert.equal(r.task(s).version,2);assert.equal(r.task('ETH').evidence.find(e=>e.key==='chain').sharedVersion,2);});
test('an ETH research handoff cannot acquire the BTC-only S03 adapter, before or after a revision change',()=>{const r=new MultiResearch();r.advance(50);const h=r.handoff('ETH'),d=new TradingDemo(),draft={market:'ETH/USDT',strategy:'S03',mode:'confirm',amount:100,cap:500};assert.equal(r.context('ETH',h.revision).ready,true);assert.ok(d.start(draft,DEFAULT_CONNECTIONS,r.context('ETH',h.revision)));r.recheck('ETH');assert.equal(r.context('ETH',h.revision).ready,false);d.tick(.1,r.context('ETH',h.revision));assert.equal(d.state,'idle');assert.equal(d.orders.length,0);assert.equal(d.cash,10000);});
test('zero or invalid clock steps preserve tasks; long runs keep exclusive roles and fresh versions',()=>{const r=new MultiResearch(),before=r.snapshot();for(const dt of [0,-1,NaN,Infinity])r.advance(dt);assert.deepEqual(r.snapshot(),before);for(let i=0;i<500;i++){r.advance(1);const ids=r.jobs().flatMap(j=>j.roles);assert.equal(new Set(ids).size,18);}assert.ok(r.tasks.some(t=>t.version>1));});
test('new shared evidence changes the conclusion, not only the version',()=>{const r=new MultiResearch();r.advance(50);assert.equal(r.task('ETH').outcome,'candidate');r.refreshShared('chain');assert.equal(r.task('ETH').outcome,'conflict');r.advance(110);assert.equal(r.task('ETH').phase,'complete');assert.equal(r.handoff('ETH'),null);assert.equal(r.task('ETH').evidence.find(e=>e.key==='chain').status,'conflict');});
test('selected intelligence retains its identity and unresolved decision',()=>{const r=new MultiResearch();r.ingest('ETH/USDT',{id:'social-01',source:'social',title:'新消息',decision:'missing',reason:'缺少原始出处'});r.advance(145);const t=r.task('ETH'),e=t.evidence.find(e=>e.key==='social');assert.equal(e.sourceId,'social-01');assert.equal(e.status,'missing');assert.equal(t.outcome,'missing');assert.equal(r.handoff('ETH'),null);});
test('execution reviews borrow roles without advancing the affected asset task',()=>{const r=new MultiResearch();r.advance(5);const eth=r.task('ETH').progress,btc=r.task('BTC').progress;r.advance(2,{busyRoles:[3]});assert.equal(r.task('ETH').progress,eth);assert.ok(r.task('BTC').progress>btc);assert.equal(r.task('ETH').executionWaiting,true);r.advance(2);assert.ok(r.task('ETH').progress>eth);});

import {DiscoveryDispatch} from './multi-research.mjs';
test('watch receipts retain the exact cancelled request and never resume on reload',()=>{
 const policy={id:'D-S03',version:2,market:'BTC/USDT',botLaunch:{requestId:'D-S03:v2:1'},executionRoute:{connectionId:'api-main',accountId:'SIM-01'}};
 const dispatch=new DiscoveryDispatch();dispatch.arm(policy);policy.executionRoute.connectionId='other';
 assert.equal(dispatch.policy.executionRoute.connectionId,'api-main');
 const reloaded=new DiscoveryDispatch(dispatch.receipt);assert.equal(reloaded.policy,null);assert.equal(reloaded.receipt.status,'interrupted');assert.equal(reloaded.receipt.requestId,'D-S03:v2:1');
 dispatch.disarm();const stopped=structuredClone(dispatch.receipt);assert.equal(stopped.status,'stopped');dispatch.disarm('read only');assert.deepEqual(dispatch.receipt,stopped);
 assert.deepEqual(new DiscoveryDispatch(stopped).receipt,stopped);assert.equal(new DiscoveryDispatch({...stopped,version:NaN}).receipt,null);
});
test('failed watches and dispatched runs have distinct receipts without retrying',()=>{
 const policy={id:'D1',version:1,botLaunch:{requestId:'request-1'},executionRoute:{connectionId:'c1',accountId:'SIM-01'}},d=new DiscoveryDispatch();
 d.arm(policy);d.failed('permissions changed');assert.equal(d.receipt.status,'failed');assert.equal(d.policy,null);
 d.arm({...policy,botLaunch:{requestId:'request-2'}});d.accepted({revision:'r1'});assert.equal(d.receipt.status,'started');assert.equal(d.receipt.requestId,'request-2');assert.equal(d.policy,null);assert.ok(d.seen.has('r1'));
});
test('discoveries stay hidden during collection and arrive with a specific report revision',()=>{
 const r=new MultiResearch();assert.equal(r.findings().length,0);r.advance(21);
 assert.ok(r.findings().some(t=>t.symbol==='ETH'&&t.phase==='queuedCore'));
 assert.equal(r.handoff('ETH'),null);r.advance(21);
 assert.equal(r.handoff('ETH').revision,'research-ETH:v1');
 assert.ok(r.jobs().every(j=>j.groupLabel&&j.groupColor));
 r.recheck('ETH');assert.ok(!r.findings().some(t=>t.symbol==='ETH'));
});
test('discovery dispatch is opt-in, revision-specific and does not itself execute a stopped or paused run',()=>{
 const r=new MultiResearch();r.advance(45);const d=new DiscoveryDispatch(),trade={state:'idle',session:null,position:null,pending:null,orders:[]};
 assert.equal(d.next(r,trade),null);d.arm({mode:'auto',amount:250,cap:1000,strategy:'S03'});
 const item=d.next(r,trade);assert.equal(item.market,'ETH/USDT');
 assert.equal(trade.orders.length,0); // Dispatcher acceptance is a routing receipt, not engine authority.
 d.accepted(item);assert.equal(d.next(r,trade),null);trade.session={id:'ACKNOWLEDGED-RUN'};trade.state='stopped';assert.equal(d.next(r,trade),null);
 d.arm({mode:'auto'});assert.equal(d.next(r,trade),null); // same revision consumed
 r.recheck('ETH');assert.equal(d.next(r,trade),null);r.advance(110);
 assert.equal(d.next(r,trade)?.revision,'research-ETH:v2');
 trade.state='paused';assert.equal(d.next(r,trade),null);assert.equal(d.policy,null);
});
test('discovery dispatch retains execution guards and failed attempts do not loop',()=>{
 const r=new MultiResearch();r.advance(45);const d=new DiscoveryDispatch(),trade=new TradingDemo();d.arm({mode:'auto',amount:5000,cap:1000,strategy:'S03'});
 const item=d.next(r,trade),error=trade.start({...d.policy,market:item.market},DEFAULT_CONNECTIONS,r.context(item.market,item.revision));assert.ok(error);d.failed(error);assert.equal(d.next(r,trade),null);assert.equal(trade.orders.length,0);
 d.arm({mode:'auto'});trade.position={market:'BTC/USDT',qty:1};assert.equal(d.next(r,trade),null);trade.position=null;
 r.refreshShared('chain');assert.equal(d.next(r,trade),null);r.advance(120);assert.equal(d.next(r,trade),null);
});
test('registered BTC paper execution modes preserve their order authority through the existing ledger',()=>{
 for(const mode of ['signal','confirm','auto']){
  const approved=Object.freeze({market:'BTC/USDT',revision:'EXPLICIT-BTC-PAPER-FIXTURE'}),r={tasks:[{symbol:'BTC'}],handoff:symbol=>symbol==='BTC'?approved:null};
  const trade=new TradingDemo(),d=new DiscoveryDispatch();d.arm({mode,strategy:'S03',market:'BTC/USDT',amount:100,cap:500});const h=d.next(r,trade),c={market:h.market,revision:h.revision,ready:true,price:100};
  assert.equal(trade.start({...d.policy,market:h.market},DEFAULT_CONNECTIONS,c),null);d.accepted(h);
  for(let i=0;i<100;i++)trade.tick(.1,c);
  if(mode==='auto'){assert.equal(trade.orders.length,1);assert.equal(trade.orders[0].status,'filled');assert.ok(trade.cash<10000);}
  else{assert.equal(trade.orders.length,0);assert.equal(trade.cash,10000);}
  trade.pause();for(let i=0;i<50;i++){assert.equal(d.next(r,trade),null);trade.tick(.1,c);}assert.notEqual(trade.state,'running');
 }
});
