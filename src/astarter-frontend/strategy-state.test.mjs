import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './simulation.mjs';
import {branchSpecs,recruitment,StrategyUpdates,revisionEnvelope,revisionGain} from './strategy-state.mjs';
import {FIELD_REVISION_SECONDS,fieldRecruitment,fieldRevision,replacedSlot,evidenceStamp} from './field-flow-state.mjs';

test('scenario topology uses only participating actors and retains the integration role',()=>{
 for(const [key,count] of [['liquidity',4],['volatility',6],['review',3]]){
  const m=new Simulation(key),specs=branchSpecs(m);assert.equal(specs.length,count);
  assert.ok(specs.every(s=>m.config.actors.includes(s.role)&&s.sink===12&&s.role!==s.sink));
  assert.ok(specs.every(s=>recruitment(s,12).gather===1&&recruitment(s,24).gather===1&&recruitment(s,49).gather===1));
 }
});
test('manual evidence waits for initial assembly, changes only its target, and pause is stable',()=>{
 const m=new Simulation(),s=new StrategyUpdates();m.advance(3);m.inject('market');assert.equal(s.update(m),null);
 m.advance(9);const a=s.update(m);assert.equal(a.role,4);assert.equal(a.progress,0);
 assert.deepEqual(s.update(m),a);assert.ok([...s.generations.values()].every(v=>v===0));
 m.advance(3);assert.ok(s.update(m).progress>0);m.advance(1.4);s.update(m);
 assert.equal(s.generations.get(4),1);assert.ok([...s.generations].filter(([role])=>role!==4).every(([,v])=>v===0));
});
test('new run clears old revisions and background history remains bounded',()=>{
 const m=new Simulation(),s=new StrategyUpdates();m.advance(12);m.inject('market');s.update(m);m.reset('review');s.update(m);
 assert.equal(s.active,null);assert.equal(s.queue.length,0);assert.deepEqual([...s.generations.keys()],[6,9,11]);
 for(let i=0;i<2000;i++){m.advance(.4);s.update(m);}
 assert.ok(s.seen.size<=24);assert.ok(s.queue.length<=3);assert.ok([...s.generations.values()].some(v=>v>0));
});

test('local evidence is located and gathered before the previous branch retires',()=>{
 const start=revisionEnvelope(0),early=revisionEnvelope(.22),middle=revisionEnvelope(.55),end=revisionEnvelope(1);
 assert.equal(start.incoming,0);assert.equal(start.outgoing,1);assert.equal(early.outgoing,1);assert.ok(early.incoming>.95);
 assert.ok(middle.gather>.5);assert.ok(middle.outgoing>.5);assert.equal(end.gather,1);assert.equal(end.outgoing,0);assert.equal(end.stage,'resume');
});

test('unused visual agent seats stay finite when no evidence revision exists',()=>{
 assert.equal(revisionGain(undefined,0,null),1);assert.equal(revisionGain(4,0,null),1);
 for(const role of [0,4,5,12,15,undefined])for(const revision of [null,{role:4,progress:0},{role:4,progress:.5},{role:4,progress:1}])assert.ok(Number.isFinite(revisionGain(role,0,revision)));
 assert.equal(revisionGain(5,0,{role:4,progress:1}),1);
});

test('flow selects and gathers before assembly; replacement keeps 18 evidence identities',()=>{
 for(let role=0;role<6;role++){
  assert.equal(fieldRecruitment(role,0).assemble,0);
  assert.equal(fieldRecruitment(role,6).assemble,0);
  assert.equal(fieldRecruitment(role,12).assemble,1);
 }
 for(let generation=1;generation<40;generation++){
  const changed=Array.from({length:24},(_,slot)=>slot).filter(slot=>evidenceStamp(generation,slot)!==evidenceStamp(generation-1,slot));
  assert.equal(changed.length,6);assert.ok(changed.every(slot=>replacedSlot(generation,slot)));
 }
 assert.equal(fieldRevision(.72).retire,0);assert.ok(fieldRevision(.72).transfer>.8);
 assert.equal(fieldRevision(1).retire,1);assert.equal(fieldRevision(1).transfer,1);
});
test('flow revision duration remains independent from the sphere timing',()=>{
 const model=new Simulation(),flow=new StrategyUpdates({duration:FIELD_REVISION_SECONDS}),sphere=new StrategyUpdates();
 model.advance(12);model.inject('market');flow.update(model);sphere.update(model);model.advance(4.4);flow.update(model);sphere.update(model);
 assert.equal(flow.generations.get(4),0);assert.equal(sphere.generations.get(4),1);
 model.advance(2.9);flow.update(model);assert.equal(flow.generations.get(4),1);
});
