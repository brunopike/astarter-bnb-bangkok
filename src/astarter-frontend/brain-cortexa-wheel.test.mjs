import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPortraitWheelGate} from './brain-cortexa-graph.mjs';

test('two distinct upward wheel detents confirm even with different deltas or a short interval',()=>{
  for(const interval of [16,65,320,750]){
    const gate=createPortraitWheelGate();
    assert.equal(gate.up(1000,-100,true),false);
    assert.equal(gate.up(1000+interval,-200,true),true,`interval ${interval}ms`);
  }
});

test('downward detents leave the overview available for native scroll and clear an armed upward detent',()=>{
  const gate=createPortraitWheelGate();
  for(const time of [1000,1060]) {
    assert.equal(gate.holdWheel(time,100,true),false);
    assert.equal(gate.up(time,100,true),false);
  }
  assert.equal(gate.up(1150,-100,true),false);
  assert.equal(gate.up(1210,100,true),false);
  assert.equal(gate.up(1270,-100,true),false);
  assert.equal(gate.up(1330,-100,true),true);
});

test('the upward confirming stroke keeps its signed inertia after an immediate transition',()=>{
  const gate=createPortraitWheelGate();
  assert.equal(gate.up(1000,-30,false),false);
  assert.equal(gate.up(1400,-30,false),true);
  gate.beginEntry();
  gate.settleEntry();
  assert.equal(gate.holdWheel(1760,-12,false),true);
  assert.equal(gate.holdWheel(2080,6,false),false);
});

test('a continuous trackpad gesture and its long decaying tail only arm the entry',()=>{
  const gate=createPortraitWheelGate();
  const deltas=[3,9,18,35,61,48,36,29,23,18,13,10,7,5,3,2,1,.5];
  for(const [index,delta] of deltas.entries()){
    assert.equal(gate.up(1000+index*38,-delta,false),false,`event ${index}`);
  }
});

test('two smooth swipes confirm once, including when each starts with tiny deltas',()=>{
  const gate=createPortraitWheelGate();
  const swipe=[2,5,9,18,26,17,10,6,2];
  const runSwipe=start=>swipe.map((delta,index)=>gate.up(start+16*index,-delta,false));
  assert.equal(runSwipe(1000).filter(Boolean).length,0);
  assert.equal(runSwipe(1400).filter(Boolean).length,1);
});

test('an expired or cleared first detent cannot confirm a later one',()=>{
  const gate=createPortraitWheelGate();
  assert.equal(gate.up(1000,-120,true),false);
  assert.equal(gate.up(5000,-120,true),false);
  gate.reset();
  assert.equal(gate.up(5060,-120,true),false);
  assert.equal(gate.up(5160,-120,true),true);
});

test('a second trackpad push can build gradually out of a quiet tail without a long pause',()=>{
  const gate=createPortraitWheelGate();
  const first=[3,8,20,34,27,18,10,5,2,1];
  const second=[2,3,5,7,10,14,20,27,19,10,3];
  let time=1000;
  const feed=delta=>gate.up(time+=16,-delta,false);
  assert.equal(first.map(feed).filter(Boolean).length,0);
  assert.equal(second.map(feed).filter(Boolean).length,1);
});

test('a smooth scroll passing through notch-sized pixels still counts as a single swipe',()=>{
  const gate=createPortraitWheelGate();
  // A pixel-mode device can land on the common wheel magnitude for two frames.
  const events=[[6,false],[19.5,false],[58,false],[96.5,false],[100,true],
    [100,true],[101.5,false],[92,false],[80,false],[56,false],[24,false],[6,false]];
  for(const [i,[delta,notchSized]] of events.entries()){
    assert.equal(gate.up(1000+i*16,-delta,notchSized),false,`event ${i}`);
  }
});

test('entry blocks wheel input in either direction until settlement and discards the remaining inertia',()=>{
  const gate=createPortraitWheelGate();
  assert.equal(gate.up(1000,-100,true),false);
  assert.equal(gate.up(1080,-100,true),true);
  gate.beginEntry();
  assert.equal(gate.entering,true);
  for(const [time,delta] of [[1200,-120],[1260,120],[1400,-120],[2160,120]]){
    assert.equal(gate.holdWheel(time,delta,true),true);
  }
  gate.reset(); // Losing hover only clears the two-stroke recognizer.
  assert.equal(gate.entering,true);
  gate.settleEntry();
  assert.equal(gate.entering,false);
  for(const time of [2200,2235,2300])assert.equal(gate.holdWheel(time,-10,false),true);
  assert.equal(gate.holdWheel(2550,100,true),false);
});

test('an undisturbed entry releases immediately at the endpoint, including with reduced motion',()=>{
  const gate=createPortraitWheelGate();
  gate.beginEntry();
  gate.settleEntry();
  assert.equal(gate.holdWheel(2000,100,true),false);
  assert.equal(gate.up(2050,-120,true),false);
});

test('late, decaying precision events are part of the same swipe on a busy rendering thread',()=>{
  const gate=createPortraitWheelGate();
  for(const [time,delta] of [[1000,5],[1030,12],[1070,31],[1250,19],[1550,7],[1720,2]]){
    assert.equal(gate.up(time,-delta,false),false);
  }
  assert.equal(gate.up(2030,-16,false),true);
  gate.beginEntry();
  assert.equal(gate.holdWheel(2550,-25,false),true);
  gate.settleEntry();
  assert.equal(gate.holdWheel(3300,-15,false),true);
  assert.equal(gate.holdWheel(3870,-8,false),true);
  assert.equal(gate.holdWheel(4230,-3,false),true);
  assert.equal(gate.holdWheel(4500,-20,false),false);
});
