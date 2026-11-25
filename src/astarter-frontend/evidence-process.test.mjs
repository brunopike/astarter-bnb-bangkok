import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './simulation.mjs';
import {evidenceProcess} from './evidence-process.mjs';
import {researchSnapshot} from './research-state.mjs';
test('result waits for delivery and filtering of every required evidence item',()=>{
 for(const key of ['liquidity','volatility','review']){const m=new Simulation(key);m.advance(17);assert.equal(evidenceProcess(m).ready,false);m.advance(6.8);const p=evidenceProcess(m);assert.equal(p.ready,true);assert.equal(p.resolved,p.items.length);assert.equal(researchSnapshot(m,'BTC/USDT').complete,p.ready);}
});
test('new evidence invalidates conclusion until it has returned and been filtered',()=>{
 const m=new Simulation();m.reset('liquidity',1);m.advance(22);assert.equal(evidenceProcess(m).ready,true);m.inject('market');const p=evidenceProcess(m);assert.equal(p.ready,false);assert.equal(p.items.at(-1).stage,0);assert.equal(researchSnapshot(m,'BTC/USDT').complete,false);assert.ok(researchSnapshot(m,'BTC/USDT').events.filter(e=>e.from===12).every(e=>e.text==='整合角色等待证据闭合。'));m.advance(2);assert.equal(m.completed,true);assert.equal(evidenceProcess(m).ready,false);
});
test('packet identity and stage are deterministic across pause and advance',()=>{
 const m=new Simulation();m.advance(1.3);const id=evidenceProcess(m).items[0].id;assert.equal(evidenceProcess(m).items[0].stage,0);m.advance(2.2);assert.equal(evidenceProcess(m).items[0].stage,2);m.advance(1.8);assert.equal(evidenceProcess(m).items[0].stage,3);const p=evidenceProcess(m);assert.deepEqual(evidenceProcess(m),p);m.advance(1.4);assert.equal(evidenceProcess(m).items[0].stage,4);m.advance(2);assert.equal(evidenceProcess(m).items[0].stage,5);assert.equal(evidenceProcess(m).items[0].id,id);
});
test('conflicts and missing evidence survive filtering and restart clears them',()=>{
 const m=new Simulation('volatility');m.advance(23.8);assert.equal(evidenceProcess(m).counts.conflict,2);assert.equal(evidenceProcess(m).title,'暂不跟进');m.reset('review');m.advance(23.8);assert.equal(evidenceProcess(m).counts.missing,1);assert.equal(evidenceProcess(m).title,'留待复核');m.reset();assert.equal(evidenceProcess(m).items.length,0);assert.equal(evidenceProcess(m).ready,false);
});
