import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './simulation.mjs';
import {evidenceProcess} from './evidence-process.mjs';
import {requestResearch,recordDisposition} from './research-operations.mjs';
const finished=(key='liquidity')=>{const m=new Simulation(key);m.reset(key,1);m.advance(24);return m;};
test('busy actor cannot receive overlapping jobs; rejected action does not mutate events',()=>{
 const m=new Simulation();m.advance(2);const sequence=m.sequence;assert.equal(requestResearch(m,'sample').ok,false);assert.equal(m.sequence,sequence);
});
test('late dispatch resumes a finite round and waits for return and screening',()=>{
 const m=finished();assert.equal(m.completed,true);assert.equal(requestResearch(m,'sample').ok,true);assert.equal(m.completed,false);assert.equal(evidenceProcess(m).ready,false);m.advance(4);assert.equal(m.completed,false);assert.equal(evidenceProcess(m).items.at(-1).stage,3);m.advance(5.4);assert.equal(m.completed,true);assert.equal(evidenceProcess(m).ready,true);
});
test('challenge changes conclusion and prevents keeping an unresolved observation',()=>{
 const m=finished();assert.equal(requestResearch(m,'challenge').ok,true);m.advance(9.4);const p=evidenceProcess(m);assert.ok(m.config.actors.includes(9));assert.equal(p.items.at(-1).role,9);assert.equal(p.counts.conflict,1);assert.equal(p.title,'暂不跟进');assert.equal(recordDisposition(m,'BTC/USDT','watch').ok,false);assert.equal(recordDisposition(m,'BTC/USDT','hold').ok,true);
});
test('recheck replaces a conflicting evidence identity only after screening completes',()=>{
 const m=finished('volatility'),old=evidenceProcess(m).items.find(i=>i.decision==='conflict').id;
 assert.equal(requestResearch(m,'recheck').ok,true);m.advance(4);assert.ok(evidenceProcess(m).items.some(i=>i.id===old));assert.equal(recordDisposition(m,'BTC/USDT','watch').ok,false);m.advance(5.4);assert.ok(!evidenceProcess(m).items.some(i=>i.id===old));assert.equal(evidenceProcess(m).counts.conflict,1);assert.equal(requestResearch(m,'recheck').ok,true);m.advance(9.4);assert.equal(evidenceProcess(m).counts.conflict,0);assert.equal(recordDisposition(m,'BTC/USDT','watch').ok,true);
});
test('dispositions preserve snapshots, reject duplicates, and never collide after a new run',()=>{
 const m=finished(),r=recordDisposition(m,'BTC/USDT','watch').record;assert.equal(recordDisposition(m,'BTC/USDT','watch',[r]).ok,false);requestResearch(m,'challenge');assert.equal(r.counts.conflict,0);m.reset('liquidity',1);m.advance(24);assert.equal(recordDisposition(m,'BTC/USDT','watch',[r]).ok,true);
});
test('dispatch is bounded before research history can discard required evidence',()=>{
 const m=finished();while(m.sequence<20){assert.equal(requestResearch(m,'sample').ok,true);m.advance(9.4);}assert.equal(requestResearch(m,'sample').ok,false);assert.equal(evidenceProcess(m).ready,true);
});
