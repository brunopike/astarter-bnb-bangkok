import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './simulation.mjs';
import {evidenceProcess} from './evidence-process.mjs';
import {requestResearch} from './research-operations.mjs';
import {createMotionClock} from './motion-clock.mjs';
test('idle presentation advances without changing completed research or evidence',()=>{
 const m=new Simulation();m.reset('liquidity',1);m.advance(24);const c=createMotionClock(),start=c.update(m,0),before=JSON.stringify(evidenceProcess(m));let t;for(let i=0;i<60;i++)t=c.update(m,1/60,{ambient:true});assert.ok(t>start);assert.equal(m.elapsed,24);assert.equal(m.completed,true);assert.equal(JSON.stringify(evidenceProcess(m)),before);
});
test('explicit pause and reduced motion freeze presentation, and replay resets it',()=>{
 const m=new Simulation();m.reset('liquidity',1);m.advance(24);const c=createMotionClock(),t=c.update(m,0);assert.equal(c.update(m,.1),t);assert.equal(c.update(m,.1,{ambient:true,reduced:true}),t);m.reset();assert.equal(c.update(m,0),0);
});
test('new work resumes faster motion without a clock jump or premature result',()=>{
 const m=new Simulation();m.reset('liquidity',1);m.advance(24);const c=createMotionClock();const start=c.update(m,0),idle=c.update(m,.1,{ambient:true});assert.equal(requestResearch(m,'sample').ok,true);assert.equal(c.update(m,0),idle);m.advance(.1);const active=c.update(m,.1);assert.ok(active-idle>idle-start);assert.equal(evidenceProcess(m).ready,false);
});
