import test from 'node:test';import assert from 'node:assert/strict';import {createCoreReactions} from './core-reactions.mjs';
test('core follows a delivery, reads its dossier and freezes with the motion clock',()=>{
 const update=createCoreReactions(),base={epoch:1,width:100,height:100,phase:0,states:[{id:4,x:80,y:70,phase:2}]};
 update({...base,time:0});const a=update({...base,time:1});assert.equal(a.action,'attend');assert.ok(a.yaw>0);
 const b=update({...base,time:2,states:[{...base.states[0],phase:3}]});assert.equal(b.action,'receive');assert.ok(b.pitch>0);assert.equal(b.targetId,4);
 assert.deepEqual(update({...base,time:2,states:[{...base.states[0],phase:3}]}),b);
});
test('thinking, completion acknowledgement and reduced motion respect research state',()=>{
 const update=createCoreReactions();update({time:0,epoch:1});assert.equal(update({time:1,epoch:1,phase:2}).action,'think');
 assert.equal(update({time:2,epoch:1,phase:3,ready:true}).action,'acknowledge');
 assert.equal(update({time:4,epoch:1,phase:3,ready:true}).action,'observe');
 assert.equal(update({time:5,epoch:1,reduced:true}).action,'still');
});

test('temporarily collapsed viewport cannot poison core transforms',()=>{
 const update=createCoreReactions();update({time:0,epoch:1});
 const p=update({time:1,epoch:1,width:0,height:0,states:[{id:1,x:0,y:0,phase:2}]});
 for(const key of ['pitch','yaw','roll','lookX','lookY','squint','lift'])assert.ok(Number.isFinite(p[key]));
});

test('a single receipt remains coherent through reading, thinking and feedback after the courier leaves',()=>{
 const update=createCoreReactions(),base={epoch:2,width:800,height:400,center:{x:400,y:200}};
 const delivery={id:5,x:480,y:210,phase:3,event:{id:'E-5'}};
 update({...base,time:0,states:[delivery]});
 const received=update({...base,time:.4,states:[delivery]});assert.equal(received.action,'receive');assert.ok(received.yaw>.2);assert.equal(received.receipt.key,'evidence:E-5');
 const stages=[[1.06,'read'],[1.72,'think'],[2.58,'acknowledge'],[3.34,'confirm'],[4.00,'release']];
 for(const [time,action] of stages){const state=update({...base,time,states:[]});assert.equal(state.action,action);assert.equal(state.receipt.id,5);assert.deepEqual(update({...base,time,states:[]}),state);}
 assert.equal(update({...base,time:4.66,states:[delivery]}).receipt,null);
 assert.equal(update({...base,time:4.76,states:[delivery]}).action,'observe');
 assert.equal(update({...base,time:5,states:[{...delivery,event:{id:'E-6'}}]}).action,'attend');
});

test('a receipt keeps its place relative to the core when the viewport changes',()=>{
 const update=createCoreReactions(),s={id:4,x:480,y:250,phase:3,event:{id:'E-resize'}};
 update({time:0,epoch:1,width:800,height:400,states:[s]});update({time:.4,epoch:1,width:800,height:400,states:[s]});
 const r=update({time:.5,epoch:1,width:400,height:200,states:[]});
 assert.deepEqual(r.receipt.origin,{x:240,y:125});assert.equal(r.receipt.key,'evidence:E-resize');
});


test('feedback is followed by courier confirmation, task return and a source-linked peer handoff',()=>{
 const update=createCoreReactions(),delivery={id:0,x:480,y:210,phase:3,event:{id:'E-macro',source:'macro'}},peers=[{id:1,phase:5},{id:2,phase:5}],base={epoch:1,width:800,height:400,states:[delivery,...peers]};
 update({...base,time:0});
 const sequence=[[.31,'receive'],[.97,'read'],[1.63,'think'],[2.49,'acknowledge'],[3.25,'confirm'],[3.91,'release'],[4.57,'dispatch'],[6.38,'handoff'],[7.54,'collaborate'],[9.35,'resume']];
 for(const [time,stage]of sequence){const p=update({...base,time});assert.equal(p.action,stage);assert.equal(p.receipt.key,'evidence:E-macro');if(time>=3.91)assert.deepEqual(p.receipt.team,{station:0,peers:[1,2]});assert.deepEqual(update({...base,time}),p);}
 assert.equal(update({...base,time:10.36}).receipt,null);
 assert.equal(update({...base,time:10.4}).action,'observe');
});

test('new evidence or execution work interrupts the optional returned-task discussion',()=>{
 for(const urgent of [{id:1,phase:0,event:{id:'new-evidence'}},{id:1,phase:5,job:{id:'order-7'}}]){
  const update=createCoreReactions(),states=[{id:0,x:480,y:210,phase:3,event:{id:'old'}},{id:1,phase:5}],base={epoch:1,states};
  for(const time of [0,.31,.97,1.63,2.49,3.25,3.91,4.57])update({...base,time});
  assert.equal(update({...base,time:4.7,states:[states[0],urgent]}).receipt,null);
 }
});
