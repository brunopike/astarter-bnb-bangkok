import test from 'node:test';
import assert from 'node:assert/strict';
import {workerPose, corePose} from './agent-poses.mjs';

test('computer operator faces the screen and types with both arms',()=>{
  const s={id:4,leader:true,work:{kind:'computer',action:'type'},motion:{walking:false}};
  const pose=workerPose(s,1);
  assert.equal(pose.yaw,Math.PI);
  assert.ok(pose.leftArm<-.7&&pose.rightArm<-.7);
  assert.notEqual(pose.leftArm,workerPose(s,1.1).leftArm);
});
test('walking and pointing have distinct poses without changing the research input',()=>{
  const state={id:2,work:{kind:'screen',action:'point'},motion:{facing:1,walking:false}};
  const before=structuredClone(state), point=workerPose(state,2);
  assert.ok(point.rightArm<-.9);
  const walk=workerPose({...state,work:null,motion:{walking:true,dx:1}},2);
  assert.equal(walk.leftLeg,-walk.rightLeg);
  assert.notEqual(walk.leftLeg,0);
  assert.deepEqual(state,before);
});
test('reduced motion keeps the correct workstation orientation without gestures',()=>{
  const s={id:4,leader:true,work:{kind:'computer',action:'type'},motion:{walking:false}};
  assert.deepEqual(workerPose(s,1,true),workerPose(s,21,true));
  assert.equal(workerPose(s,1,true).yaw,Math.PI);
  assert.equal(workerPose(s,1,true).bob,0);
});
test('core receives, thinks and acknowledges the existing receipt, including reset',()=>{
  const reaction={action:'receive',pitch:.26,yaw:.38,roll:0,hands:1,receipt:{side:1}};
  assert.ok(corePose(reaction,2).rightArm<-.5);
  assert.equal(corePose(reaction,2).headYaw,.38);
  assert.notDeepEqual(corePose(reaction,2),corePose({...reaction,action:'think'},2));
  assert.equal(corePose({action:'observe'},2).leftArm,0);
  assert.deepEqual(corePose(reaction,1,true),corePose(reaction,12,true));
});
