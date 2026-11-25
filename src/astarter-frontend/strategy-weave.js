import * as THREE from 'three';
import {StrategyUpdates,branchSpecs,recruitment,smooth,STRANDS_PER_BRANCH,revisionEnvelope} from './strategy-state.mjs';

const STEPS=80,CORE_STEPS=35,CORE_COUNT=550;
const vertex=`
 attribute vec3 dispersedPosition;attribute vec3 flowNormal;attribute vec3 flowBinormal;attribute float arcProgress;attribute float strandOrder;attribute float strandWeight;
 uniform float uGather;uniform float uTime;uniform float uIntensity;uniform float uSeed;
 varying float vProgress;varying float vOrder;varying float vWeight;varying float vGather;
 void main(){
  vProgress=arcProgress;vOrder=strandOrder;vWeight=strandWeight;
  float live=step(.01,uIntensity);
  vGather=smoothstep(.02,.95,uGather*1.28-arcProgress*.12-strandOrder*.09);
  float renewal=exp(-pow((fract(uTime*.072+strandOrder*.79+uSeed)-.52)*7.0,2.0));
  vGather*=1.0-step(.97,uGather)*renewal*.70*live;
  vec3 p=mix(dispersedPosition,position,vGather);
  float envelope=sin(arcProgress*3.14159265),phase=arcProgress*9.0-uTime*.85+strandOrder*8.0+uSeed*6.0;
  p+=(flowNormal*sin(phase)+flowBinormal*cos(phase*.83+uTime*.35))*envelope*(.09+.075*sin(uTime*.46+strandOrder*9.0))*live*vGather;
  p+=normalize(dispersedPosition+vec3(.001))*sin(uTime*.85+arcProgress*8.0+strandOrder*11.0)*.020*uIntensity*(1.0-vGather);
  if(length(p)>2.11)p=normalize(p)*2.11;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
 }`;
const fragment=`
 uniform float uSelect;uniform float uTime;uniform float uOpacity;uniform float uSeed;uniform float uIncoming;uniform float uIntensity;
 uniform vec3 uBase;uniform vec3 uAccent;uniform vec3 uHot;
 varying float vProgress;varying float vOrder;varying float vWeight;varying float vGather;
 void main(){
  float selected=smoothstep(vOrder*.75,vOrder*.75+.24,uSelect);
  float head=fract(uTime*(.14+vOrder*.012)+vOrder*.24+uSeed),d=abs(fract(vProgress-head+.5)-.5);
  float window=1.0-smoothstep(.018,.095,d),tip=exp(-d*d*2200.0);
  float frontier=exp(-pow((vProgress-uSelect)*8.0,2.0))*(1.0-vGather);
  float ends=smoothstep(0.0,.025,vProgress)*(1.0-smoothstep(.97,1.0,vProgress));
  float live=step(.01,uIntensity),stream=mix(.56,.006+window*.82+tip*.23,live);
  vec3 color=mix(uBase,uAccent,.52+selected*.48);color=mix(color,uHot,tip*.32+uIncoming*frontier*.28);
  float alpha=selected*((1.0-vGather)*(.08+window*.26+frontier*.42)+vGather*stream)*vWeight*ends*uOpacity;
  gl_FragColor=vec4(color,min(.95,alpha));
  #include <colorspace_fragment>
 }`;
function rand(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}

export function createStrategyWeave(scene,fiberGeometry,appearance,flowCurve,reducedMotion){
 const updates=new StrategyUpdates(),branches=new Map(),gathers=new Float32Array(12),selects=new Float32Array(12),slots=new Float32Array(fiberGeometry.attributes.position.count).fill(-1),sourceMap=new Map();
 fiberGeometry.setAttribute('fiberSlot',new THREE.BufferAttribute(slots,1).setUsage(THREE.DynamicDrawUsage));
 const raw=fiberGeometry.attributes.position.array,a=new THREE.Vector3(),b=new THREE.Vector3(),p=new THREE.Vector3();
 const layer=new THREE.Group();scene.add(layer);let epoch=-1,key='',signature='';
 function disposeRecord(r){if(!r)return;layer.remove(r.line);r.line.geometry.dispose();r.line.material.dispose();}
 function makeRecord(spec,generation){
  const random=rand(9281+spec.role*179+generation*1397),reserved=new Set();
  for(const branch of branches.values())for(const r of [branch.current,branch.incoming])if(r)for(const id of r.rawIds)reserved.add(id);
  const rawIds=[],nearby=[];
  if(generation>0){const target=flowCurve(spec.role,spec.sink,generation).getPoint(.24);for(let id=0;id<CORE_COUNT;id++){let distance=Infinity,center=.5;for(let k=1;k<CORE_STEPS;k+=3){a.fromArray(raw,(id*CORE_STEPS*2+k*2)*3);const d=a.distanceToSquared(target);if(d<distance){distance=d;center=k/CORE_STEPS;}}nearby.push({id,distance,center});}nearby.sort((a,b)=>a.distance-b.distance);}
  if(generation>0){const choices=nearby.filter(n=>!reserved.has(n.id)).slice(0,120);while(rawIds.length<STRANDS_PER_BRANCH){const pick=choices.splice(Math.floor(random()*choices.length),1)[0];reserved.add(pick.id);rawIds.push(pick.id);}}else while(rawIds.length<STRANDS_PER_BRANCH){const id=Math.floor(random()*CORE_COUNT);if(!reserved.has(id)){reserved.add(id);rawIds.push(id);}}
  const curve=flowCurve(spec.role,spec.sink,generation),frames=curve.computeFrenetFrames(STEPS,false),position=[],dispersed=[],progress=[],order=[],weight=[],normals=[],binormals=[];
  rawIds.forEach((id,strand)=>{
   const angle=random()*Math.PI*2,radius=.025+random()*.095,w=.50+random()*.34,center=generation>0?nearby.find(n=>n.id===id).center:.5;
   for(let s=0;s<STEPS;s++)for(let end=0;end<2;end++){
    const i=s+end,t=i/STEPS,sourceT=generation>0?Math.max(0,Math.min(1,center+(t-.5)*.43)):t,k=sourceT*CORE_STEPS,step=Math.min(CORE_STEPS-1,Math.floor(k)),edge=id*CORE_STEPS*2+step*2,alpha=k-step;
    a.fromArray(raw,edge*3);b.fromArray(raw,(edge+1)*3);a.lerp(b,alpha);
    p.copy(curve.getPoint(t)).addScaledVector(frames.normals[i],Math.cos(angle+t*2)*radius*Math.sin(t*Math.PI)).addScaledVector(frames.binormals[i],Math.sin(angle+t*2)*radius*Math.sin(t*Math.PI));
    position.push(p.x,p.y,p.z);dispersed.push(a.x,a.y,a.z);progress.push(t);order.push(strand/(STRANDS_PER_BRANCH-1));weight.push(w);normals.push(...frames.normals[i].toArray());binormals.push(...frames.binormals[i].toArray());
   }
  });
  const g=new THREE.BufferGeometry();for(const [name,data,n]of [['position',position,3],['dispersedPosition',dispersed,3],['arcProgress',progress,1],['strandOrder',order,1],['strandWeight',weight,1],['flowNormal',normals,3],['flowBinormal',binormals,3]])g.setAttribute(name,new THREE.Float32BufferAttribute(data,n));
  const material=new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,uniforms:{uGather:{value:0},uSelect:{value:0},uTime:{value:0},uIntensity:{value:1.8},uSeed:{value:spec.role*.137+generation*.19},uIncoming:{value:0},uOpacity:{value:1},uBase:{value:appearance.fiber},uAccent:{value:appearance.lead},uHot:{value:appearance.hot}},transparent:true,depthWrite:false,blending:THREE.NormalBlending});
  material.userData.strategy=true;const line=new THREE.LineSegments(g,material);line.frustumCulled=false;layer.add(line);
  return{line,curve,rawIds,generation,gather:0,select:0,spec};
 }
 function rebuildSources(){
  slots.fill(-1);sourceMap.clear();
  for(const branch of branches.values())for(const [kind,r]of [[0,branch.current],[1,branch.incoming]]){
   if(!r)continue;const slot=branch.spec.index*2+kind;
   for(const id of r.rawIds){slots.fill(slot,id*CORE_STEPS*2,(id+1)*CORE_STEPS*2);sourceMap.set(id,r);}
  }
  fiberGeometry.attributes.fiberSlot.needsUpdate=true;
 }
 function update(model,visual){
  const revision=updates.update(model);
  if(epoch!==model.epoch||key!==model.key){
   for(const branch of branches.values()){disposeRecord(branch.current);disposeRecord(branch.incoming);}branches.clear();
   for(const spec of branchSpecs(model)){const branch={spec,current:null,incoming:null};branches.set(spec.role,branch);branch.current=makeRecord(spec,0);}
   epoch=model.epoch;key=model.key;signature='';
  }
  for(const branch of branches.values()){
   const generation=updates.generations.get(branch.spec.role);
   if(branch.current.generation!==generation){
    disposeRecord(branch.current);const replacement=branch.incoming?.generation===generation?branch.incoming:makeRecord(branch.spec,generation);if(branch.incoming&&replacement!==branch.incoming)disposeRecord(branch.incoming);branch.current=replacement;branch.incoming=null;
   }
   if(revision?.role===branch.spec.role&&(!branch.incoming||branch.incoming.generation!==revision.generation)){
    disposeRecord(branch.incoming);branch.incoming=makeRecord(branch.spec,revision.generation);
   }
  }
  const next=[...branches.values()].map(b=>`${b.spec.role}:${b.current.generation}:${b.incoming?.generation??'-'}`).join('|');if(next!==signature){rebuildSources();signature=next;}
  gathers.fill(0);selects.fill(0);let picked=0,assembled=0;
  for(const branch of branches.values()){
   const initial=recruitment(branch.spec,model.elapsed,reducedMotion),r=branch.current;let gather=initial.gather,select=initial.select;
   if(revision?.role===branch.spec.role){gather=initial.gather;select=reducedMotion?0:revisionEnvelope(revision.progress).outgoing;}
   r.gather=gather;r.select=select;gathers[branch.spec.index*2]=gather;selects[branch.spec.index*2]=select;
   if(branch.incoming){const q=reducedMotion?1:revision?.progress||0;branch.incoming.select=revisionEnvelope(q).incoming;branch.incoming.gather=revisionEnvelope(q).gather;gathers[branch.spec.index*2+1]=branch.incoming.gather;selects[branch.spec.index*2+1]=branch.incoming.select;}
   for(const record of [r,branch.incoming])if(record){
    const u=record.line.material.uniforms;u.uIncoming.value=record===branch.incoming?1:0;u.uGather.value=record.gather;u.uSelect.value=record.select;u.uTime.value=reducedMotion?0:model.elapsed;u.uIntensity.value=reducedMotion?0:visual.intensity;u.uOpacity.value=appearance.dark?1.8:1.65;
   }
   picked+=Math.round(STRANDS_PER_BRANCH*initial.select);assembled+=Math.round(STRANDS_PER_BRANCH*initial.gather);
  }
  layer.visible=visual.paths;
  return{pool:CORE_COUNT,picked,assembled,modules:model.config.actors.length,branches:branches.size,revision:revision?'adjusting':'stable',revisionModule:revision?`A${String(revision.role+1).padStart(2,'0')}`:'',swaps:revision?STRANDS_PER_BRANCH:0,revisionStage:revision?revisionEnvelope(revision.progress).stage:'resume',generations:Object.fromEntries(updates.generations)};
 }
 function attractActivity(pathId,progress,point){
  const r=sourceMap.get(pathId);if(!r)return 0;
  p.copy(r.curve.getPoint(progress));point.lerp(p,r.gather);return r.select*(.3+.7*r.gather);
 }
 return{update,gathers,selects,layer,branches,attractActivity,dispose(){for(const branch of branches.values()){disposeRecord(branch.current);disposeRecord(branch.incoming);}branches.clear();scene.remove(layer);}};
}
