import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceLightLinks} from './evidence-motion.js';
import {createCrystalFamily} from './crystal-character.mjs';
import {workerPose} from './agent-poses.mjs';
import {setCoreCrystalTheme} from './reactor.js';
import * as THREE from 'three';
const center={x:300,y:200},states=[{id:1,x:200,y:220,color:'#8a6fff'},{id:2,x:100,y:150,color:'#00b68c'}];
test('core stays white-dominant with readable eyes and restores its complete optical state',()=>{
 const material=new THREE.MeshPhysicalMaterial(),eye=new THREE.MeshBasicMaterial(),edge={uniforms:{ink:{value:new THREE.Color()},alpha:{value:0}}};
 const snapshot=()=>({color:material.color.getHexString(),transmission:material.transmission,environment:material.envMapIntensity,attenuation:material.attenuationColor.getHexString(),distance:material.attenuationDistance,emissive:material.emissive.getHexString(),emission:material.emissiveIntensity,rim:edge.uniforms.ink.value.getHexString(),alpha:edge.uniforms.alpha.value,eye:eye.color.getHexString()});
 try{setCoreCrystalTheme(material,edge,eye,true);const dark=snapshot();setCoreCrystalTheme(material,edge,eye,false);const light=snapshot();for(const state of [dark,light]){assert.equal(state.color,'ffffff');assert.ok(state.transmission>0&&state.transmission<.35);assert.ok(state.emission>0);assert.equal(state.attenuation,'ffffff');}assert.ok(eye.color.r<.1&&eye.color.g<.1&&eye.color.b<.1);assert.notEqual(light.rim,dark.rim);assert.notEqual(light.eye,dark.eye);setCoreCrystalTheme(material,edge,eye,true);assert.deepEqual(snapshot(),dark);}finally{material.dispose();eye.dispose();}
});
test('receipt light changes direction and requires a real peer for handoff',()=>{
 const r={id:1,key:'job:check',progress:.4,stage:'receive'};
 const receive=evidenceLightLinks({},states,center,r)[0];assert.equal(receive.to.x,center.x);
 const release=evidenceLightLinks({},states,center,{...r,stage:'release'})[0];assert.deepEqual(release.from,receive.to);assert.deepEqual(release.to,receive.from);
 assert.equal(evidenceLightLinks({},states,center,{...r,stage:'handoff'}).length,0);
 assert.equal(evidenceLightLinks({},states,center,{...r,stage:'handoff',team:{peers:[2]}})[0].to.x,112);
 assert.deepEqual(evidenceLightLinks({},states,center,null),[]);
});
test('result light follows an exact completed research version, not a timer or trade claim',()=>{
 const task={symbol:'ETH',version:2,phase:'core',evidence:[{key:'trend',status:'retain'},{key:'chain',status:'conflict'}]};
 const m={elapsed:5,multiResearch:{core:{symbol:'ETH',version:2,at:0},tasks:[task]}};
 assert.deepEqual(evidenceLightLinks(m,[],center).map(l=>l.kind),['retain','defer']);
 m.elapsed=7.4;assert.equal(evidenceLightLinks(m,[],center).length,0);
 task.phase='complete';const result=evidenceLightLinks(m,[],center)[0];assert.equal(result.kind,'result');assert.equal(result.asset,'ETH');
 task.version=3;assert.equal(evidenceLightLinks(m,[],center).length,0);
 task.version=2;m.elapsed=9;assert.equal(evidenceLightLinks(m,[],center).length,0);
});
test('crystal squads share geometry, independent poses and stay within the scene budget',()=>{
 const family=createCrystalFamily();try{
 const a=family.createRig(),b=family.createRig();assert.equal(a.meshes[0].geometry,b.meshes[0].geometry);
 assert.ok(a.meshes.length<45);const triangles=a.meshes.reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count)/3,0);assert.ok(triangles*18<260000);
 const before=b.joints.Wrist_R.getWorldPosition(new THREE.Vector3()).toArray();
 family.pose(a,workerPose({id:1,leader:true,work:{kind:'computer',action:'type'}},1));
 assert.deepEqual(b.joints.Wrist_R.getWorldPosition(new THREE.Vector3()).toArray(),before);assert.notDeepEqual(a.joints.Wrist_R.getWorldPosition(new THREE.Vector3()).toArray(),before);
 family.theme(false);family.theme(true);assert.ok(family.materials.ceramic.transmission>.8);
 }finally{family.dispose();}
});
test('light crystal eyes avoid additive washout and dark materials restore on theme switch',()=>{
 const family=createCrystalFamily();try{
  const rig=family.createRig(),glass=rig.meshes.find(m=>m.material.userData.tint==='glass').material,glow=rig.meshes.find(m=>m.material.userData.eyeGlow).material;
  family.theme(true);const dark={glow:glow.uniforms.strength.value,transmission:glass.transmission,roughness:glass.roughness,emission:glass.emissiveIntensity};
  family.theme(false);assert.ok(glow.uniforms.strength.value<.1);assert.ok(glass.transmission>0&&glass.transmission<.5);assert.ok(glass.thickness<glass.attenuationDistance);assert.ok(glass.emissiveIntensity>0);assert.ok(dark.transmission<.5);assert.equal(glass.attenuationColor.getHexString(),'ffffff');
  family.theme(true);assert.deepEqual({glow:glow.uniforms.strength.value,transmission:glass.transmission,roughness:glass.roughness,emission:glass.emissiveIntensity},dark);
 }finally{family.dispose();}
});

test('floor neon is independent of eyes, readable in both themes and shares the existing rig budget',()=>{
 const family=createCrystalFamily();try{
 const rig=family.createRig(),ring=rig.root.getObjectByName('Halo').material,wash=rig.root.getObjectByName('HaloWash').material,eye=rig.root.getObjectByName('Eye0').material;
 assert.notEqual(ring,eye);assert.equal(wash.toneMapped,false);assert.equal(wash.depthWrite,false);
 family.theme(true);const before={ring:ring.color.r,wash:wash.uniforms.strength.value,eye:eye.color.r};
 family.theme(false);assert.ok(wash.uniforms.strength.value>.5);assert.ok(ring.color.r>eye.color.r);
 family.theme(true);assert.deepEqual({ring:ring.color.r,wash:wash.uniforms.strength.value,eye:eye.color.r},before);
 }finally{family.dispose();}
});
