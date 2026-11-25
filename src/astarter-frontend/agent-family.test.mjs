import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {prepareAgentFamily,poseRig} from './agent-family.mjs';
import {workerPose,corePose} from './agent-poses.mjs';

test('local ThreeUI asset keeps joints and optical faces while all 18 workers fit the geometry budget',async()=>{
  const bytes=await readFile(new URL('./assets/agent-family.glb',import.meta.url));
  const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),'');
  const family=prepareAgentFamily(gltf.scene);
  try{
    const core=family.createRig(),worker=family.createRig(true),other=family.createRig(true);
    const triangles=rig=>rig.meshes.reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0);
    assert.ok(triangles(core)+18*triangles(worker)<470000);
    for(const name of ['Head','Shoulder_L','Elbow_L','Wrist_R','Hip_L'])assert.ok(worker.joints[name],name);
    assert.ok(worker.model.getObjectByName('Champagne_face_bezel').geometry.index.count>600,'small agents must retain their thin face outline');
    const iris=worker.model.getObjectByName('Iris_L').geometry;
    assert.equal(iris.attributes.uv.count,iris.attributes.position.count,'LED coordinates must survive simplification');
    const lens=core.model.getObjectByName('Curved_protective_glass_L');
    assert.ok(lens?.material.transparent&&lens.material.opacity<.1,'core retains its original subtle optical cover');
    assert.equal(core.model.getObjectByName('Iris_L').material.side,THREE.DoubleSide);
    assert.equal(worker.model.getObjectByName('Iris_R').material.side,THREE.DoubleSide);
    assert.equal(worker.meshes[0].geometry,other.meshes[0].geometry);
    const before=core.joints.Head.quaternion.clone();
    poseRig(worker,workerPose({id:4,leader:true,work:{kind:'computer',action:'type'}},1));
    assert.ok(core.joints.Head.quaternion.equals(before));
    assert.notDeepEqual(worker.joints.Wrist_R.getWorldPosition(new THREE.Vector3()).toArray(),other.joints.Wrist_R.getWorldPosition(new THREE.Vector3()).toArray());
    poseRig(core,corePose({action:'read',hands:1}));
    const left=core.joints.Wrist_L.getWorldPosition(new THREE.Vector3()),right=core.joints.Wrist_R.getWorldPosition(new THREE.Vector3());
    assert.ok(left.distanceTo(right)<.65,'receiving hands must reach the same dossier');
    assert.ok(family.ornament('NETWORK_MASTER'));assert.ok(family.ornament('CREATION_MASTER'));
  }finally{family.dispose();}
});
