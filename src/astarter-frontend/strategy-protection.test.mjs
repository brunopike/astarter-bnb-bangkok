import test from 'node:test';
import assert from 'node:assert/strict';
import {PROTECTION_VERSION,PARAMETER_PROTECTION_VERSION,PROTECTION_RULES,PROTECTION_PARAMETER_KEYS,protectionConfig,protectionValid,protectionRules,newProtectionState,advanceProtection,protectionDecision,companionPreview} from './strategy-protection.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';

const args=()=>({policy:protectionConfig(),state:newProtectionState(10000),equity:10000,requested:1000,cap:1000,cash:10000,stopFraction:.02});
test('Astarter applies the minimum remaining risk budget including costs',()=>{
 const p=protectionDecision({...args(),occupied:{portfolio:55,asset:45,group:55}});
 assert.equal(p.risk,5);assert.equal(p.amount,227.27);assert.equal(p.action,'reduce');
 assert.ok(p.amount*.022<=5);
});
test('conservative mode halves risk, not the requested order blindly',()=>{
 const p=protectionDecision({...args(),policy:protectionConfig('astarter','conservative')});
 assert.equal(p.risk,12.5);assert.equal(p.amount,568.18);
 assert.equal(protectionDecision({...args(),requested:100,policy:protectionConfig('astarter','conservative')}).amount,100);
});
test('soft drawdown scales down; hard and daily locks survive recovery and rollover',()=>{
 const soft=companionPreview('drawdown');assert.equal(soft.conservative,true);assert.equal(soft.state.locked,null);assert.equal(soft.amount,577.5);
 let state=advanceProtection({...newProtectionState(10000),high:11000},{equity:10120});
 assert.equal(state.locked,'drawdown');
 state=advanceProtection(state,{equity:12000,day:1,settled:true});assert.equal(state.locked,'drawdown');
 const daily=advanceProtection(newProtectionState(10000),{equity:9800});assert.equal(daily.locked,'daily');
});
test('risk-period loss debit never refills on recovery',()=>{
 let state=advanceProtection(newProtectionState(10000),{equity:9900});
 assert.equal(state.lossDebit,100);
 state=advanceProtection(state,{equity:10100,day:1});assert.equal(state.lossDebit,100);
});
test('reserve only new settled profits; neither floating gains nor replay double-reserve',()=>{
 const start=newProtectionState(10000);
 const floating=advanceProtection(start,{equity:12000,settled:false});assert.equal(floating.reserve,0);
 let state=advanceProtection(floating,{equity:12000,settled:true});assert.equal(state.reserve,400);
 state=advanceProtection(state,{equity:12000,settled:true});assert.equal(state.reserve,400);
 state=advanceProtection(state,{equity:12100,settled:true});assert.equal(state.reserve,420);
});
test('unknown order and invalid policy refuse a second entry',()=>{
 assert.equal(protectionDecision({...args(),pending:true}).amount,0);
 assert.equal(protectionDecision({...args(),policy:{id:'astarter',version:'obsolete'}}).amount,0);
 assert.equal(protectionDecision({...args(),known:false}).amount,0);
});
test('changing companion invalidates the saved setup check without changing global risk',()=>{
 const w=new WorkspaceSim(),d=w.createDraft('S03'),risk={...w.s.risk};
 w.saveDraft(d.id,{amount:100,cap:500,mode:'confirm',protection:protectionConfig()});
 w.validateSetup();for(let i=0;i<50;i++)w.tick(.1);assert.ok(w.setupReady);
 w.saveDraft(d.id,{amount:100,cap:500,mode:'confirm',protection:protectionConfig('astarter','conservative')});
 assert.equal(w.setupReady,null);assert.deepEqual(w.s.risk,risk);
});
test('actual simulated entry uses the companion and persists it through restore',()=>{
 const demo=new TradingDemo();
 assert.equal(demo.start({market:'BTC/USDT',strategy:'S03',amount:1000,cap:1000,mode:'confirm',protection:protectionConfig('astarter','conservative')},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'R1'}),null);
 demo.signal={id:'SIG-TEST',side:'buy',at:0};assert.equal(demo.submit(),null);
 assert.equal(demo.session.protectionDecision.amount,568.18);
 assert.ok(Math.abs(demo.pending.price*demo.pending.qty-568.18)<1e-8);
 const restored=new TradingDemo();assert.equal(restored.restore({...demo,flow:demo.flow}),true);
 assert.equal(restored.session.protection.mode,'conservative');assert.equal(restored.capitalProtection.base,10000);
});
test('protection locks reject new buys but leave owned-position exit available',()=>{
 const demo=new TradingDemo();demo.start({market:'BTC/USDT',strategy:'S03',amount:100,cap:500,mode:'confirm',protection:protectionConfig()},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'R1'});
 demo.capitalProtection={...newProtectionState(10000),locked:'daily'};demo.signal={id:'SIG-L',side:'buy',at:0};
 assert.match(demo.submit(),/资金保护/);assert.equal(demo.orders.length,0);
 assert.match(demo.resume({ready:true}),/锁定/);
 demo.position={market:'BTC/USDT',qty:.001,price:81218.87};assert.equal(demo.closePosition(),null);assert.equal(demo.pending.side,'sell');
});

const riskParameters=()=>Object.fromEntries(PROTECTION_PARAMETER_KEYS.map(key=>[key,PROTECTION_RULES[key]]));
const parameterArgs=policy=>({policy,state:newProtectionState(10000),equity:10000,requested:1000,cap:1000,cash:10000,stopFraction:.02});

test('existing sim-2 and original snapshots keep their exact identity and sizing',()=>{
 const original=protectionConfig('original');
 assert.deepEqual(original,{id:'original',version:'strategy-original'});
 const old=protectionConfig();
 assert.deepEqual(old,{id:'astarter',version:PROTECTION_VERSION,mode:'normal'});
 assert.equal(protectionValid(old),true);
 assert.equal(protectionDecision({...parameterArgs(old),occupied:{portfolio:55,asset:45,group:55}}).amount,227.27);
 assert.equal(advanceProtection(newProtectionState(10000),{equity:9800,policy:old}).locked,'daily');
 assert.equal(protectionDecision({...parameterArgs(original),requested:100}).amount,100);
});

test('a stricter parameter snapshot changes actual sizing without mutating the old policy',()=>{
 const input=riskParameters();input.episode=.001;input.notional=.05;
 const policy=protectionConfig('astarter','normal',input);input.episode=.0025;
 assert.equal(policy.version,PARAMETER_PROTECTION_VERSION);assert.equal(protectionValid(policy),true);
 const result=protectionDecision(parameterArgs(policy));
 assert.equal(result.risk,10);assert.equal(result.amount,454.54);
 assert.equal(protectionDecision(parameterArgs(protectionConfig())).risk,25);
 assert.equal(protectionRules(policy).asset,PROTECTION_RULES.asset);
 assert.equal(PROTECTION_RULES.episode,.0025);
});

test('custom day loss and high-water drawdown keep the existing fixed reserve rule',()=>{
 const params=riskParameters();params.daily=.01;params.hard=.04;
 const policy=protectionConfig('astarter','normal',params);
 assert.equal(advanceProtection(newProtectionState(10000),{equity:9900,policy}).locked,'daily');
 let state=advanceProtection({...newProtectionState(10000),high:11000},{equity:10500,policy});
 assert.equal(state.locked,'drawdown');
 state=advanceProtection(state,{equity:12000,settled:true,day:1,policy});
 assert.equal(state.locked,'drawdown');assert.equal(state.reserve,400);
 state=advanceProtection(state,{equity:12000,settled:true,day:2,policy});
 assert.equal(state.locked,'drawdown');assert.equal(state.reserve,400);
});

test('the custom soft threshold scales future risk down while all other limits still apply',()=>{
 const params=riskParameters();params.soft=.01;
 const policy=protectionConfig('astarter','normal',params);
 const state={...newProtectionState(10000),high:10150};
 const result=protectionDecision({...parameterArgs(policy),state});
 assert.equal(result.conservative,true);assert.equal(result.risk,12.5);
 assert.equal(protectionDecision({...parameterArgs(policy),state,occupied:{asset:48}}).risk,2);
 assert.equal(protectionDecision({...parameterArgs(policy),pending:true}).amount,0);
});

test('the risk-period budget is consumed once and is not refilled by recovery or a new day',()=>{
 const policy=protectionConfig('astarter','normal',{...riskParameters(),epoch:.02});
 const decision=protectionDecision({...parameterArgs(policy),state:{...newProtectionState(10000),lossDebit:195}});
 assert.equal(decision.risk,5);assert.equal(decision.amount,227.27);
 let state=advanceProtection(newProtectionState(10000),{equity:9900,policy});
 state=advanceProtection(state,{equity:9900,day:1,policy});
 state=advanceProtection(state,{equity:9790,day:1,policy});assert.equal(state.locked,'epoch');
 state=advanceProtection(state,{equity:11000,day:2,policy});assert.equal(state.locked,'epoch');assert.equal(state.lossDebit,210);
});

test('missing, non-finite, expanded or inconsistent parameters fail closed',()=>{
 const cases=[{episode:0},{episode:.0026},{notional:.11},{daily:.021},{soft:.04},{hard:.09},{epoch:0},{epoch:.051},{episode:NaN},{soft:.02,hard:.01}];
 for(const patch of cases){
  const policy=protectionConfig('astarter','normal',{...riskParameters(),...patch});
  assert.equal(protectionValid(policy),false,JSON.stringify(patch));
  assert.equal(protectionDecision(parameterArgs(policy)).amount,0);
  assert.equal(advanceProtection(newProtectionState(10000),{equity:10000,policy}).locked,'policy');
 }
 const missing=riskParameters();delete missing.daily;
 assert.equal(protectionValid(protectionConfig('astarter','normal',missing)),false);
 assert.equal(protectionValid(protectionConfig('astarter','normal',{...riskParameters(),extra:1})),false);
 assert.equal(protectionValid({...protectionConfig(),parameters:riskParameters()}),false,'old versions cannot silently carry new parameters');
});
