import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './simulation.mjs';
import {researchSnapshot,sourceValue} from './research-state.mjs';
test('research never confers strategy authority and reports unresolved results',()=>{
 for(const key of ['liquidity','volatility','review']){const m=new Simulation(key);m.advance(23.8);const s=researchSnapshot(m,'BTC/USDT');assert.equal(s.strategyReady,false);assert.equal(s.complete,true);assert.ok(s.next);assert.equal(s.mode,'simulation-only');}
});
test('snapshot is isolated, current-cycle-only, and config resets remove old records',()=>{
 const m=new Simulation();m.advance(22);const old=researchSnapshot(m,'BTC/USDT');const saved=JSON.stringify(old);m.advance(4);const next=researchSnapshot(m,'BTC/USDT');assert.equal(next.cycle,2);assert.ok(next.events.every(e=>e.at>=24));assert.equal(JSON.stringify(old),saved);m.reset('review');const reset=researchSnapshot(m,'ETH/USDT');assert.equal(reset.events.length,1);assert.equal(reset.roles.length,4);assert.equal(reset.market,'ETH/USDT');assert.equal(reset.complete,false);
});
test('manual stop marks unfinished tasks and does not manufacture output',()=>{
 const m=new Simulation('review');m.advance(2);const s=researchSnapshot(m,'BTC/USDT',{stopped:true});assert.equal(s.complete,false);assert.equal(s.interrupted,true);assert.ok(s.roles.some(r=>r.status==='cancelled'));assert.ok(s.roles.filter(r=>r.status==='cancelled').every(r=>r.output.includes('未生成')));
});
test('finite completion retained and source values consistent across views',()=>{
 const m=new Simulation();m.reset('liquidity',1);m.advance(24);const s=researchSnapshot(m,'BTC/USDT',{stopped:true});assert.equal(s.complete,true);assert.equal(s.interrupted,false);assert.equal(s.sources.find(x=>x.key==='spread').value,sourceValue('spread',24,m.config.actors));assert.equal(s.sources.find(x=>x.key==='risk').value,'1');
});
