// A continuous fiber field becomes a woven strategy body. Simulation only.
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {ROLES} from './simulation.mjs';
import {StrategyUpdates} from './strategy-state.mjs';
import {FIELD_REVISION_SECONDS,fieldRecruitment,fieldRevision,evidenceStamp} from './field-flow-state.mjs';

const STEPS=64, MICRO=3, STRANDS=24*MICRO, POOL=576;
const vertex=`
attribute vec4 aPath; // t, side, seed, evidence slot
attribute vec3 aDetail; // micro strand, evidence generation, role patch
uniform float uTime,uCloud,uDetect,uGather,uAssemble,uIncoming,uBatch,uRelease,uWidth;
uniform float uRoles;
uniform float uMasks[8];
varying float vT,vSide,vAlpha,vDepth,vShade,vAffected,vSeed,vFlowCoord;
float h(float n){return fract(sin(n*127.1+31.7)*43758.5453);}
vec3 fabric(float u,float v){
 float a=(u-.5)*3.14159265;
 float twist=a*1.55+.08*sin(uTime*.28+u*4.0);
 return vec3((u*2.0-1.0)*3.15,1.45*v*cos(twist)+.58*sin(a*1.8),1.45*v*sin(twist)+.44*cos(a*1.3)+.055*sin(u*8.0+uTime*.52));
}
vec3 source(float t,float seed){
 float p=h(seed+1.0)*6.2831853,p2=h(seed+5.0)*6.2831853;
 float x=(t*2.0-1.0)*4.2;
 float y=(h(seed+3.0)-.5)*3.65+.64*sin(t*6.6+p+uTime*.48)+.18*sin(t*14.0+seed-uTime*.22);
 float z=(h(seed+9.0)-.5)*3.0+.72*sin(t*5.7+p2-uTime*.34);
 x+=.13*sin(y*2.0+uTime*.37+p);
 return vec3(x,y,z);
}
vec3 pointAt(float t){
 float slot=aPath.w,patchId=aDetail.z,micro=aDetail.x-1.0;
 float family=mod(slot,2.0),row=floor(slot*.5);
 float u=mix((patchId+t)/uRoles,(patchId+(row+.5)/12.0+(t-.5)*.23)/uRoles,family);
 float v=mix(-1.0+2.0*(row+.5)/12.0,-1.0+2.0*t,family);
 v+=micro*.012+.025*sin(u*10.0+row*1.4)*(1.0-abs(v));u=clamp(u+micro*.0014,.0,1.0);
 vec3 ordered=fabric(u,v);
 // Small changes in only the replaced evidence, not the whole body.
 ordered+=vec3(0.0,.022*sin(aDetail.y*2.1+slot),.026*cos(aDetail.y*1.7+slot))*sin(t*3.14159265);
 vec3 raw=source(t,aPath.z);
 vec3 loose=ordered+vec3(.20*sin(t*11.0+aPath.z+uTime*.60),.37*sin(t*9.0+aPath.z*.4-uTime*.6),.37*cos(t*8.0+aPath.z*.6+uTime*.5));
 if(uIncoming>.5)raw=ordered+(raw-ordered)*.32+vec3(-.36,.12,.25);
 vec3 p=mix(raw,loose,uGather);p=mix(p,ordered,uAssemble);
 float affected=1.0-step(.1,abs(floor(slot/6.0)-uBatch));
 if(uIncoming<.5)p=mix(p,ordered+(raw-ordered)*.40,uRelease*affected);
 return mix(p,source(t,aPath.z),uCloud);
}
void main(){
 float t=aPath.x,affected=1.0-step(.1,abs(floor(aPath.w/6.0)-uBatch));
 vec3 p=pointAt(t),next=pointAt(min(1.001,t+.0015));
 vec4 mv=modelViewMatrix*vec4(p,1.0),nv=modelViewMatrix*vec4(next,1.0);
 vec2 direction=normalize(nv.xy-mv.xy+vec2(.000001));
 float width=uWidth*(.75+.4*h(aPath.z+7.0));
 mv.xy+=vec2(-direction.y,direction.x)*aPath.y*width;
 gl_Position=projectionMatrix*mv;
 float mask=0.0;for(int i=0;i<8;i++)mask+=uMasks[i]*(1.0-step(.5,abs(float(i)-aDetail.z)));
 vAlpha=mix((.14+.86*uDetect)*(1.0-uRelease*affected),1.0-mask*.97,uCloud);
 if(uIncoming>.5)vAlpha*=affected*uDetect;
 vT=t;vSide=aPath.y;vDepth=clamp((p.z+2.5)/5.0,.0,1.0);
 vShade=.56+.44*abs(dot(normalize(nv.xyz-mv.xyz+vec3(.001)),normalize(vec3(-.4,.6,.5))));
 vAffected=affected;vSeed=aPath.z;vFlowCoord=(aDetail.z+t)/uRoles;
}`;
const fragment=`
uniform vec3 uGray,uAccent,uHot;
uniform float uTime,uCloud,uDetect,uOpacity,uIncoming,uRelease;
varying float vT,vSide,vAlpha,vDepth,vShade,vAffected,vSeed,vFlowCoord;
void main(){
 float coverage=1.0-smoothstep(.32,1.0,abs(vSide));
 float head=fract(uTime*(.10+fract(vSeed*.371)*.035)+fract(vSeed*.618));
 float coord=mix(vFlowCoord+fract(vSeed*.618)*.10,vT,uCloud);
 float center=mix(fract(uTime*.18),head,uCloud);
 float d=abs(fract(coord-center+.5)-.5),flow=1.0-smoothstep(.025,.19,d);
 float ends=smoothstep(0.0,.035,vT)*(1.0-smoothstep(.96,1.0,vT));
 vec3 color=mix(uGray,uAccent,uDetect*(1.0-uCloud));
 color=mix(color,uGray,uRelease*vAffected*(1.0-uIncoming));
 color*=vShade*(.68+.32*vDepth);
 color=mix(color,uHot,flow*(1.0-uCloud)*(.16+uIncoming*.14));
 float alpha=coverage*ends*vAlpha*uOpacity*(.40+.60*flow)*(.55+.45*vDepth);
 gl_FragColor=vec4(color,min(.94,alpha));
 #include <colorspace_fragment>
}`;

function fabricPoint(u,v,time,out){
 const a=(u-.5)*Math.PI,twist=a*1.55+.08*Math.sin(time*.28+u*4);
 return out.set((u*2-1)*3.15,1.45*v*Math.cos(twist)+.58*Math.sin(a*1.8),1.45*v*Math.sin(twist)+.44*Math.cos(a*1.3)+.055*Math.sin(u*8+time*.52));
}
function makeGeometry(group,generation=0,cloud=false){
 const strands=cloud?POOL:STRANDS,n=strands*(STEPS+1)*2;
 const paths=new Float32Array(n*4),details=new Float32Array(n*3),indices=[];
 let cursor=0;
 for(let strand=0;strand<strands;strand++){
  const patch=cloud?Math.floor(strand/STRANDS):group;
  const slot=Math.floor((cloud?strand%STRANDS:strand)/MICRO),micro=strand%MICRO;
  const stamp=cloud?0:evidenceStamp(generation,slot);
  const seed=cloud?strand:patch*STRANDS+slot*MICRO+micro+stamp*29;
  const start=cursor;
  for(let step=0;step<=STEPS;step++)for(const side of [-1,1]){
   paths.set([step/STEPS,side,seed,slot],cursor*4);details.set([micro,stamp,patch],cursor*3);cursor++;
  }
  for(let step=0;step<STEPS;step++){const a=start+step*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
 }
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(n*3),3));
 geometry.setAttribute('aPath',new THREE.BufferAttribute(paths,4));geometry.setAttribute('aDetail',new THREE.BufferAttribute(details,3));geometry.setIndex(indices);
 return geometry;
}
function staticField(container,labels){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 600 430');svg.style.cssText='width:100%;height:100%';
 const p=new THREE.Vector3();
 for(let k=0;k<76;k++){
  const path=document.createElementNS(ns,'path');let d='';
  for(let j=0;j<=64;j++){const u=k<38?j/64:(k-38)/37,v=k<38?-1+k/37*2:-1+j/64*2;fabricPoint(u,v,0,p);d+=`${j?'L':'M'}${(300+p.x*67).toFixed(2)} ${(215-p.y*67-p.z*10).toFixed(2)}`;}
  path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke','var(--accent)');path.setAttribute('stroke-opacity','.52');path.setAttribute('stroke-width','.75');svg.append(path);
 }
 container.replaceChildren(svg);labels.replaceChildren();const note=document.createElement('span');note.className='fallback-label';note.textContent='策略织构 · 静态示意';container.append(note);document.body.dataset.renderer='svg-fallback';
 return{update(){},focus(){},reset(){},setRotate(){},setVisual(){},setTheme(){},resize(){},zoom(){},get fps(){return null;},dispose(){container.replaceChildren();}};
}

export function createEvidenceField(container,labelContainer,{onSelect,reducedMotion=false}={}){
 if(new URLSearchParams(location.search).get('renderer')==='static')return staticField(container,labelContainer);
 let renderer;try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});}catch{return staticField(container,labelContainer);}
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0,0);container.replaceChildren(renderer.domElement);renderer.domElement.setAttribute('role','img');renderer.domElement.setAttribute('aria-label','连续流动的候选纤维被摘选、牵引并织成三维策略结构，新证据只使局部松开和重织');document.body.dataset.renderer='webgl';
 const scene=new THREE.Scene(),space=new THREE.Group();scene.add(space);
 const camera=new THREE.PerspectiveCamera(32,1,.1,100),home=new THREE.Vector3(),target=new THREE.Vector3();
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.08;controls.enablePan=false;controls.minDistance=5.2;controls.maxDistance=19;controls.autoRotateSpeed=.20;
 let visual={intensity:1.8,pointScale:1.6,paths:true,labels:true,focus:false},selected=4,auto=false,disposed=false,lost=false,flight=null,width=1,height=1,compact=false,renderUntil=performance.now()+600,fps=60,frames=0,frameSeconds=0,epoch=-1,key='',time=0,specs=[],revision=null;
 const appearance={dark:true,gray:new THREE.Color(),accent:new THREE.Color(),hot:new THREE.Color()};
 const masks=new Float32Array(8),updates=new StrategyUpdates({duration:FIELD_REVISION_SECONDS}),records=new Map();
 const invalidate=()=>{renderUntil=performance.now()+600;};controls.addEventListener('change',invalidate);controls.addEventListener('start',invalidate);
 function material(cloud=false){return new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,side:THREE.DoubleSide,transparent:true,depthWrite:false,uniforms:{uTime:{value:0},uCloud:{value:cloud?1:0},uDetect:{value:0},uGather:{value:0},uAssemble:{value:0},uIncoming:{value:0},uBatch:{value:-10},uRelease:{value:0},uWidth:{value:cloud?.008:.012},uRoles:{value:4},uMasks:{value:masks},uGray:{value:appearance.gray},uAccent:{value:appearance.accent},uHot:{value:appearance.hot},uOpacity:{value:1}}});}
 const cloud=new THREE.Mesh(makeGeometry(0,0,true),material(true));cloud.frustumCulled=false;cloud.renderOrder=0;space.add(cloud);
 function makeRecord(spec,generation,incoming=false){const mesh=new THREE.Mesh(makeGeometry(spec.index,generation),material());mesh.frustumCulled=false;mesh.renderOrder=incoming?3:2;space.add(mesh);return{mesh,generation};}
 function drop(record){if(!record)return;space.remove(record.mesh);record.mesh.geometry.dispose();record.mesh.material.dispose();}
 const labels=ROLES.map(role=>{const el=document.createElement('div');el.className='agent-tag field-agent-tag';el.innerHTML=`<span>${role.id}</span><span class="tag-name">${role.name}</span>`;labelContainer.append(el);return el;});
 const point=new THREE.Vector3(),ndc=new THREE.Vector3(),world=new THREE.Vector3();
 function anchor(role,out,edge=.94){const spec=specs.find(s=>s.role===role);if(!spec)return fabricPoint(.87,-.7,time,out);return fabricPoint((spec.index+.5)/Math.max(1,specs.length),edge,time,out);}
 function project(p){return ndc.copy(p).applyMatrix4(space.matrixWorld).project(camera);}
 function resize(){
  const r=container.getBoundingClientRect();if(r.width<1||r.height<1)return;
  const changed=compact!==(r.width<480);width=r.width;height=r.height;compact=width<480;
  space.rotation.set(.10,-.24,compact?-Math.PI/2+.12:-.12);space.scale.setScalar(compact?.93:1);space.updateMatrixWorld(true);
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,compact?1.25:1.5));renderer.setSize(width,height,false);camera.aspect=width/height;home.set(0,.3,compact?12.4:8.8);
  if(changed||camera.position.length()<1){camera.position.copy(home);controls.target.copy(target);camera.lookAt(target);}camera.updateProjectionMatrix();invalidate();
 }
 const observer=new ResizeObserver(resize);observer.observe(container);let down=null;
 const onDown=e=>{down=[e.clientX,e.clientY];};
 function onUp(e){
  if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5){down=null;return;}down=null;
  const box=container.getBoundingClientRect();let nearest=56,role=null;
  for(const spec of specs){anchor(spec.role,point,.1);project(point);const d=Math.hypot((ndc.x*.5+.5)*width-(e.clientX-box.left),(-ndc.y*.5+.5)*height-(e.clientY-box.top));if(d<nearest){nearest=d;role=spec.role;}}
  if(role!==null)onSelect?.(role,false);
 }
 renderer.domElement.addEventListener('pointerdown',onDown);renderer.domElement.addEventListener('pointerup',onUp);
 function beginCamera(p,zoom=1){flight={at:performance.now(),from:camera.position.clone(),to:p.clone().add(home),target:controls.target.clone(),toTarget:p.clone(),fromZoom:camera.zoom,zoom};invalidate();}
 function applyLook(){const s=getComputedStyle(document.documentElement);appearance.dark=document.documentElement.dataset.theme==='dark';appearance.gray.set(appearance.dark?'#b1adb9':'#8e8999');appearance.accent.set(s.getPropertyValue('--field-lead').trim());appearance.hot.set(appearance.dark?'#eee5ff':'#8f75f6');invalidate();}
 function update(model,delta,running){
  if(disposed||lost)return;
  frames++;frameSeconds+=delta;if(frameSeconds>=1){fps=Math.round(frames/frameSeconds);frames=0;frameSeconds=0;}
  revision=updates.update(model);specs=updates.specs;time=reducedMotion?0:model.elapsed*(.62+visual.intensity*.21);
  if(epoch!==model.epoch||key!==model.key){for(const r of records.values()){drop(r.current);drop(r.incoming);}records.clear();epoch=model.epoch;key=model.key;}
  for(const spec of specs){
   const generation=updates.generations.get(spec.role)||0;let r=records.get(spec.role);
   if(!r){r={current:makeRecord(spec,generation),incoming:null};records.set(spec.role,r);}
   if(r.current.generation!==generation){drop(r.current);drop(r.incoming);r.current=makeRecord(spec,generation);r.incoming=null;}
   if(revision?.role===spec.role&&r.incoming?.generation!==revision.generation){drop(r.incoming);r.incoming=makeRecord(spec,revision.generation,true);}
  }
  masks.fill(0);let picked=0,assembled=0;
  for(const spec of specs){
   const r=records.get(spec.role),recruit=fieldRecruitment(spec.index,model.elapsed,reducedMotion),changing=revision?.role===spec.role,env=changing?fieldRevision(revision.progress):null;
   masks[spec.index]=recruit.gather; picked+=24*recruit.detect;assembled+=24*recruit.assemble;
   for(const [record,incoming]of [[r.current,false],[r.incoming,true]])if(record){
    const u=record.mesh.material.uniforms;u.uTime.value=time;u.uRoles.value=specs.length;
    u.uDetect.value=incoming?env.arrive:recruit.detect;u.uGather.value=incoming?env.arrive:recruit.gather;u.uAssemble.value=incoming?env.transfer:recruit.assemble;
    u.uIncoming.value=incoming?1:0;u.uBatch.value=changing?(revision.generation-1)%4:-10;u.uRelease.value=changing&&!incoming?env.retire:0;
    u.uWidth.value=(incoming?.015:.012)*visual.pointScale/1.6;u.uOpacity.value=appearance.dark?1.25:1.10;
    record.mesh.visible=visual.paths;
   }
  }
  cloud.material.uniforms.uTime.value=time;cloud.material.uniforms.uOpacity.value=(appearance.dark?.52:.40)*(1-.28*assembled/Math.max(1,specs.length*24))*(visual.focus?.30:1);cloud.material.uniforms.uWidth.value=.008*visual.pointScale/1.6;
  if(flight){const q=Math.min(1,(performance.now()-flight.at)/650),e=reducedMotion?1:q*q*(3-2*q);camera.position.lerpVectors(flight.from,flight.to,e);controls.target.lerpVectors(flight.target,flight.toTarget,e);camera.zoom=flight.fromZoom+(flight.zoom-flight.fromZoom)*e;camera.updateProjectionMatrix();if(e===1)flight=null;}
  controls.autoRotate=auto&&running&&!reducedMotion&&!flight;controls.update(delta);space.updateMatrixWorld(true);
  const placed=[];
  for(const role of ROLES){
   const active=specs.some(s=>s.role===role.index),show=visual.labels&&(role.index===selected||role.index===revision?.role||role.index===12);
   anchor(role.index,point,role.index===12?-.9:1.05);project(point);
   const x=(ndc.x*.5+.5)*width,y=(-ndc.y*.5+.5)*height,lx=Math.max(5,Math.min(width-120,x+8)),ly=Math.max(4,Math.min(height-22,y-10));
   const box={x:lx,y:ly};const blocked=placed.some(p=>Math.abs(p.x-lx)<110&&Math.abs(p.y-ly)<20);
   const visible=show&&(active||role.index===12)&&!blocked&&ndc.z<1;
   labels[role.index].style.transform=`translate3d(${lx}px,${ly}px,0)`;labels[role.index].style.opacity=visible?'1':'0';labels[role.index].classList.toggle('selected',role.index===selected);if(visible)placed.push(box);
  }
  Object.assign(container.dataset,{pool:String(POOL),picked:String(Math.round(picked)),assembled:String(Math.round(assembled)),modules:String(model.config.actors.length),branches:String(specs.length),revision:revision?'adjusting':'stable',revisionModule:revision?ROLES[revision.role].id:'',revisionStage:revision?fieldRevision(revision.progress).stage:'resume',swaps:revision?'6':'0',generations:JSON.stringify(Object.fromEntries(updates.generations)),process:reducedMotion?'retain':model.elapsed<3?'discover':model.elapsed<7?'screen':model.elapsed<12?'assemble':revision?'revise':'retain'});
  renderer.render(scene,camera);
 }
 const onLost=e=>{e.preventDefault();lost=true;document.body.dataset.renderer='webgl-lost';},onRestored=()=>{lost=false;document.body.dataset.renderer='webgl';invalidate();};
 renderer.domElement.addEventListener('webglcontextlost',onLost);renderer.domElement.addEventListener('webglcontextrestored',onRestored);
 applyLook();resize();
 return{update,setTheme:applyLook,setVisual(v){visual={...visual,...v};invalidate();},focus(id,orient=true){selected=id;if(orient){anchor(id,world,.1);world.applyMatrix4(space.matrixWorld).multiplyScalar(.25);beginCamera(world,1.10);}invalidate();},reset(){beginCamera(target);},setRotate(v){auto=v;invalidate();},zoom(factor){camera.zoom=THREE.MathUtils.clamp(camera.zoom/factor,.72,1.8);camera.updateProjectionMatrix();invalidate();},resize,get needsRender(){return !!flight||performance.now()<renderUntil;},get fps(){return fps;},get drawCalls(){return renderer.info.render.calls;},dispose(){disposed=true;observer.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',onDown);renderer.domElement.removeEventListener('pointerup',onUp);renderer.domElement.removeEventListener('webglcontextlost',onLost);renderer.domElement.removeEventListener('webglcontextrestored',onRestored);drop({mesh:cloud});for(const r of records.values()){drop(r.current);drop(r.incoming);}renderer.dispose();labelContainer.replaceChildren();}};
}
