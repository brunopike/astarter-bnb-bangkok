import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GROUPS, ROLES } from './simulation.mjs';
import { createAgentCores } from './agent-cores.js';
import {createStrategyWeave} from './strategy-weave.js';

const R = 2.05;
const CORE_COUNT=550,CORE_STEPS=35,SURFACE_COUNT=240,SURFACE_STEPS=84;
const CHANNELS=['r','g','b'];
function readAppearance(){
  const style=getComputedStyle(document.documentElement),color=name=>new THREE.Color(style.getPropertyValue(name).trim());
  return {dark:document.documentElement.dataset.theme==='dark',fiber:color('--field-fiber'),fiberAlt:color('--field-fiber-alt'),lead:color('--field-lead'),hot:color('--field-hot'),muted:color('--field-muted'),background:color('--surface-2'),palette:Object.fromEntries(Object.keys(GROUPS).map(key=>[key,color('--role-'+key)]))};
}
function randomGenerator(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function spherePoint(u, v, radius = R) {
  const theta = u * Math.PI * 2, y = 2 * v - 1, r = Math.sqrt(1 - y * y);
  return new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).multiplyScalar(radius);
}
const ROLE_POSITIONS = ROLES.map((_, i) => spherePoint((i * .61803398875) % 1, (i + .5) / 18, R * 1.012));
const defaultFront = { 0: [-.65,.66,.72], 4: [-.93,.03,.57], 5: [.50,.66,.75], 12: [.54,-.24,.94], 15: [-.29,-.73,.82] };
for (const [id, p] of Object.entries(defaultFront)) ROLE_POSITIONS[id].set(...p).normalize().multiplyScalar(R * 1.012);

const filamentVertex = `
 attribute vec3 fiberColor;attribute vec3 fiberMotion;attribute float fiberSlot;
 varying vec3 vColor;varying float vAlpha;
 uniform float uTime;uniform float uIntensity;uniform vec3 uPulseOrigins[4];uniform float uPulseAges[4];
 uniform float uBranchGather[12];uniform float uBranchSelect[12];
 uniform vec3 uFiberBase;uniform vec3 uFiberAlt;uniform vec3 uAccent;
 void main(){
  vec3 p=position,normal=normalize(p+vec3(.001));float shell=fiberMotion.z;
  float gather=0.0,selected=0.0;
  if(fiberSlot>-.5){int slot=int(fiberSlot+.5);gather=uBranchGather[slot];selected=uBranchSelect[slot];}
  vec3 tangent=normalize(cross(normal,vec3(.23,.91,.37))+vec3(.001));
  float wave=sin(uTime*.96+p.y*3.0+p.x*1.7)*.030+sin(uTime*.61+p.z*4.6)*.020;
  for(int i=0;i<4;i++){float age=uPulseAges[i];if(age<6.8){float d=distance(normal,normalize(uPulseOrigins[i]));float band=exp(-pow((d-age*.45)*4.5,2.0));wave+=band*sin(d*9.0-age*3.0)*.045*exp(-age*.32);}}
  p+=tangent*sin(uTime*.81+position.y*2.4)*.035*uIntensity;
  p+=cross(normal,tangent)*cos(uTime*.63+position.x*2.8)*.023*uIntensity;
  p+=normal*wave*uIntensity*mix(1.0,.26,shell);
  if(shell>.5)p=normalize(p)*length(position)*(1.0+sin(uTime*.72+position.y)*.004*uIntensity);
  if(length(p)>2.11)p=normalize(p)*2.11;
  vec4 viewPosition=modelViewMatrix*vec4(p,1.0);
  float head=fract(uTime*(.14+max(0.0,fiberMotion.y)*.09)+fiberMotion.y);
  float travel=exp(-pow((fiberMotion.x-head)*17.0,2.0))*step(0.0,fiberMotion.y);
  vec3 viewNormal=normalize(mat3(modelViewMatrix)*normal);float rim=pow(1.0-abs(viewNormal.z),2.0)*shell;
  vColor=mix(uFiberBase,uFiberAlt,clamp((fiberColor.r+fiberColor.g+fiberColor.b)*.8,0.0,1.0));
  vColor=mix(vColor,uAccent,selected*(1.0-gather)*.40);
  vAlpha=(.22+.78*(1.0-smoothstep(4.5,9.0,-viewPosition.z))+travel*.32+rim*.22)*(1.0-gather*.90);
  gl_Position=projectionMatrix*viewPosition;
 }`;
const filamentFragment = `
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uOpacity;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha * uOpacity);
    #include <colorspace_fragment>
  }
`;
const pointVertex = `
  attribute vec3 packetColor;
  attribute float packetSize;
  attribute float packetAngle;
  attribute float packetKind;
  varying vec3 vColor;
  varying float vAngle;
  varying float vKind;
  uniform float uPixelRatio;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position,1.0);
    vColor = packetColor; vAngle=packetAngle; vKind=packetKind;
    gl_PointSize = packetSize * uPixelRatio * (6.8 / max(3.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }`;
const pointFragment = `
  varying vec3 vColor;
  varying float vAngle;
  varying float vKind;
  void main() {
    vec2 p=(gl_PointCoord-.5)*2.0;
    p=mat2(cos(vAngle),-sin(vAngle),sin(vAngle),cos(vAngle))*p;
    float r=length(p),a;
    if(vKind>.5&&vKind<1.5){
      // A soft luminous stroke, with no frame, seam or repeated link shape.
      a=exp(-p.x*p.x*4.8-p.y*p.y*40.0)*.8;
      a+=exp(-p.x*p.x*3.0-p.y*p.y*9.0)*.20;
    }else if(vKind<.5){
      a=exp(-p.x*p.x*4.0-p.y*p.y*24.0)*.68;
    }else{
      float diamond=abs(p.x)*.65+abs(p.y)*1.8;
      a=(1.0-smoothstep(.30,.64,diamond))*.9+exp(-r*r*6.0)*.15;
    }
    if(vKind<1.5)a*=.46;
    if(a<.015)discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }`;

const routeVertex = `
  varying vec2 vUv;
  void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const routeFragment = `
  uniform vec3 uColor;
  uniform vec3 uAccent;
  uniform float uAge;
  uniform float uOpacity;
  varying vec2 vUv;
  void main(){
    float head=uAge/3.1;
    float pulse=exp(-pow((vUv.x-head)*19.0,2.0));
    pulse+=exp(-pow((vUv.x-(uAge-1.0)/3.1)*19.0,2.0))*.65;
    float trail=smoothstep(head-.23,head-.04,vUv.x)*(1.0-smoothstep(head,head+.025,vUv.x));
    gl_FragColor=vec4(mix(uColor,uAccent,min(.55,pulse*.5)),uOpacity*(.22+trail*.28+pulse*.50));
    #include <colorspace_fragment>
  }`;

function buildFilaments() {
  const rand = randomGenerator(4218), positions = [], colors = [],motion=[];
  const cool = new THREE.Color('#807b90'), warm = new THREE.Color('#98919f');
  function segment(a, b, color, intensity,ta,tb,phase,shell) {
    positions.push(a.x,a.y,a.z,b.x,b.y,b.z);
    for (let j = 0; j < 2; j++) colors.push(color.r * intensity,color.g * intensity,color.b * intensity);
    motion.push(ta,phase,shell,tb,phase,shell);
  }
  // Long, continuous bundles create a woven volume, rather than a polygon cage.
  for (let i = 0; i < CORE_COUNT; i++) {
    const longitude = rand();
    const a = spherePoint(longitude,.54 + rand() * .46);
    const b = spherePoint(longitude + .18 + rand() * .27,rand() * .46);
    const axis = new THREE.Vector3().crossVectors(a,b).normalize();
    const dip = .73 + rand() * .17;
    const mid = spherePoint(longitude + .13,.25 + rand() * .5,R * (.60 + rand() * .29)).addScaledVector(axis,.12);
    const curve = new THREE.CatmullRomCurve3([a, a.clone().multiplyScalar(dip).addScaledVector(axis,.36), mid, b.clone().multiplyScalar(.65).addScaledVector(axis,-.34), b]);
    const color = i % 11 === 0 ? warm : cool;
    const intensity = .52 + rand() * .57;
    let previous = curve.getPoint(0);
    const phase=i%4===0?rand():-1;
    for (let s = 1; s <= CORE_STEPS; s++) { const next = curve.getPoint(s / CORE_STEPS); segment(previous,next,color,intensity,(s-1)/CORE_STEPS,s/CORE_STEPS,phase,0); previous = next; }
  }
  // A second family of near-surface paths gives the silhouette its fine hairline detail.
  for (let i = 0; i < SURFACE_COUNT; i++) {
    const angle = rand() * Math.PI * 2;
    const normal = spherePoint(rand(),rand(),1);
    const axis = new THREE.Vector3(0,1,0).cross(normal).normalize();
    if (axis.length() < .1) axis.set(1,0,0);
    const second = new THREE.Vector3().crossVectors(normal,axis).normalize();
    const contour=i>=185;
    const radius = R * (contour?.97+rand()*.025:.80+rand()*.20);
    const start = rand() * 1.3, arc = Math.PI * (1.05 + rand() * .9);
    const phase=i%4===0?rand():-1;
    let previous;
    for (let s = 0; s <= SURFACE_STEPS; s++) {
      const t = start + s / SURFACE_STEPS * arc;
      const next = axis.clone().multiplyScalar(Math.cos(t + angle) * radius).addScaledVector(second,Math.sin(t + angle) * radius).addScaledVector(normal,Math.sin(t * 1.7 + angle) * (contour?.04:.10));
      if (previous) segment(previous,next,i % 9 === 0 ? warm : cool,(contour?.68:.55) + (i % 5) * .08,(s-1)/SURFACE_STEPS,s/SURFACE_STEPS,phase,1);
      previous = next;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('fiberColor',new THREE.Float32BufferAttribute(colors,3));
  geometry.setAttribute('fiberMotion',new THREE.Float32BufferAttribute(motion,3));
  return geometry;
}

function flowCurve(from, to, generation=0) {
  const a = ROLE_POSITIONS[from], b = ROLE_POSITIONS[to];
  const normal = new THREE.Vector3().crossVectors(a,b).normalize();
  const bend=generation===0?0:Math.sin(generation*2.399+from*.71)*.32,mid=a.clone().add(b).multiplyScalar(.29).addScaledVector(normal,.28+bend);mid.y+=generation===0?0:Math.cos(generation*1.31+from)*.16;
  return new THREE.CatmullRomCurve3([a,a.clone().multiplyScalar(.76).addScaledVector(normal,.26+bend*.4),mid,b.clone().multiplyScalar(.78).addScaledVector(normal,.18-bend*.25),b]);
}

function staticFallback(container) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS,'svg');
  svg.setAttribute('viewBox','-260 -260 520 520'); svg.style.cssText='width:100%;height:100%';
  const rand = randomGenerator(47);
  for (let i=0;i<150;i++) {
    const a=spherePoint(rand(),rand(),205), b=spherePoint(rand(),rand(),205);
    const path=document.createElementNS(svgNS,'path');
    path.setAttribute('d',`M ${a.x} ${a.y} Q ${(a.x+b.x)*.15} ${(a.y+b.y)*.3} ${b.x} ${b.y}`);
    path.setAttribute('fill','none');path.setAttribute('data-fiber','');path.setAttribute('stroke','#807b90');path.setAttribute('stroke-opacity','.30');path.setAttribute('stroke-width','.5');svg.append(path);
  }
  const symbols={market:'M-4 0H4M0-4V4',research:'M0-5L4-2.5V2.5L0 5L-4 2.5V-2.5ZM-4-2.5L4 2.5M-4 2.5L4-2.5',risk:'M-4-4H4L3 2L0 5L-3 2ZM0-2V2',review:'M0-4L4 0L0 4L-4 0ZM-4 3L0 7L4 3'};
  for(const role of ROLES){
    const g=document.createElementNS(svgNS,'g');g.setAttribute('transform',`translate(${ROLE_POSITIONS[role.index].x*99} ${-ROLE_POSITIONS[role.index].y*99})`);g.setAttribute('fill','none');g.setAttribute('data-role',role.group);g.setAttribute('data-agent',String(role.index));g.setAttribute('stroke-width','.8');
    const ring=document.createElementNS(svgNS,'circle');ring.setAttribute('r','9');ring.setAttribute('stroke-dasharray','9 3');g.append(ring);
    const symbol=document.createElementNS(svgNS,'path');symbol.setAttribute('d',symbols[role.group]);g.append(symbol);svg.append(g);
  }
  container.replaceChildren(svg);
  const label = document.createElement('span');label.className='fallback-label';label.textContent='策略支路示意 · 静态模式';container.append(label);
  document.body.dataset.renderer='svg-fallback';
  function setTheme(){const theme=readAppearance();for(const path of svg.querySelectorAll('[data-fiber]'))path.setAttribute('stroke','#'+theme.fiber.getHexString());for(const g of svg.querySelectorAll('[data-role]'))g.setAttribute('stroke','#'+theme.palette[g.dataset.role].getHexString());}
  const strategy=document.createElementNS(svgNS,'g');svg.append(strategy);let scenario='';
  function update(model){
    if(scenario===model.key)return;scenario=model.key;strategy.replaceChildren();
    for(const from of model.config.actors.slice(0,-1)){
      const curve=flowCurve(from,model.config.actors.at(-1)),points=curve.getPoints(60),path=document.createElementNS(svgNS,'path');
      path.setAttribute('d',points.map((p,i)=>`${i?'L':'M'}${p.x*99},${-p.y*99}`).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke','var(--field-lead)');path.setAttribute('stroke-width','1.5');path.setAttribute('stroke-opacity','.8');strategy.append(path);
    }
    for(const g of svg.querySelectorAll('[data-agent]'))g.setAttribute('opacity',model.config.actors.includes(Number(g.dataset.agent))?'1':'.18');
  }
  setTheme();
  return { update, focus(){}, reset(){}, setRotate(){}, setVisual(){}, setTheme, zoom(){}, resize(){}, get fps(){return null;}, dispose(){} };
}

export function createGlobe(container, labelContainer, { onSelect, reducedMotion = false } = {}) {
  if(new URLSearchParams(location.search).get('renderer')==='static')return staticFallback(container);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'}); }
  catch { return staticFallback(container); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,1.75));
  renderer.setClearColor(0x000000,0); renderer.outputColorSpace=THREE.SRGBColorSpace;
  container.replaceChildren(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','完整球形信号场，按策略抽取线束汇向Agent；新证据只调整相关支路，可拖动与缩放');
  renderer.domElement.setAttribute('role','img');
  document.body.dataset.renderer='webgl';
  const scene=new THREE.Scene(),appearance=readAppearance(),PALETTE=appearance.palette;
  const blending=()=>appearance.dark?THREE.AdditiveBlending:THREE.NormalBlending;
  const camera=new THREE.PerspectiveCamera(36,1,.1,40);
  const home=new THREE.Vector3(.25,.22,7.6);camera.position.copy(home);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=.07;controls.enablePan=false;
  controls.minDistance=5.4;controls.maxDistance=11.0;controls.autoRotateSpeed=.23;
  controls.minPolarAngle=.18;controls.maxPolarAngle=Math.PI-.18;
  let autoAnchor=controls.getAzimuthalAngle();
  controls.addEventListener('end',()=>{autoAnchor=controls.getAzimuthalAngle();});
  let visual={intensity:1.8,pointScale:1.6,labels:true,paths:true,focus:false};
  const material=new THREE.ShaderMaterial({vertexShader:filamentVertex,fragmentShader:filamentFragment,uniforms:{uTime:{value:0},uOpacity:{value:.43},uIntensity:{value:1.8},uPulseOrigins:{value:Array.from({length:4},()=>new THREE.Vector3(0,1,0))},uPulseAges:{value:[99,99,99,99]},uBranchGather:{value:new Float32Array(12)},uBranchSelect:{value:new Float32Array(12)},uFiberBase:{value:appearance.fiber},uFiberAlt:{value:appearance.fiberAlt},uAccent:{value:appearance.lead}},transparent:true,depthWrite:false,blending:blending()});
  const fibers=new THREE.LineSegments(buildFilaments(),material);scene.add(fibers);
  const weave=createStrategyWeave(scene,fibers.geometry,appearance,flowCurve,reducedMotion);material.uniforms.uBranchGather.value=weave.gathers;material.uniforms.uBranchSelect.value=weave.selects;
  const agentCores=createAgentCores(ROLE_POSITIONS,ROLES,PALETTE,reducedMotion,appearance);scene.add(agentCores.group);
  const labels=[];
  for(const role of ROLES){
    const label=document.createElement('div');label.className='agent-tag';label.innerHTML=`<span>${role.id}</span><span class="tag-name">${role.name}</span>`;labelContainer.append(label);labels.push(label);
  }
  const maxPoints=1536, packetPositions=new Float32Array(maxPoints*3), packetColors=new Float32Array(maxPoints*3), packetSizes=new Float32Array(maxPoints),packetAngles=new Float32Array(maxPoints),packetKinds=new Float32Array(maxPoints);
  const packetGeometry=new THREE.BufferGeometry();packetGeometry.setAttribute('position',new THREE.BufferAttribute(packetPositions,3).setUsage(THREE.DynamicDrawUsage));packetGeometry.setAttribute('packetColor',new THREE.BufferAttribute(packetColors,3).setUsage(THREE.DynamicDrawUsage));packetGeometry.setAttribute('packetSize',new THREE.BufferAttribute(packetSizes,1).setUsage(THREE.DynamicDrawUsage));packetGeometry.setAttribute('packetAngle',new THREE.BufferAttribute(packetAngles,1).setUsage(THREE.DynamicDrawUsage));packetGeometry.setAttribute('packetKind',new THREE.BufferAttribute(packetKinds,1).setUsage(THREE.DynamicDrawUsage));packetGeometry.setDrawRange(0,0);
  const packetMaterial=new THREE.ShaderMaterial({vertexShader:pointVertex,fragmentShader:pointFragment,uniforms:{uPixelRatio:{value:renderer.getPixelRatio()}},transparent:true,depthWrite:false,depthTest:false,blending:blending()});
  packetMaterial.blending=THREE.NormalBlending;packetMaterial.userData.strategy=true;
  const packets=new THREE.Points(packetGeometry,packetMaterial);packets.frustumCulled=false;scene.add(packets);
  const activityCount=300, activityPositions=new Float32Array(activityCount*3), activityColors=new Float32Array(activityCount*3), activitySizes=new Float32Array(activityCount),activityAngles=new Float32Array(activityCount),activityKinds=new Float32Array(activityCount);
  const activityGeometry=new THREE.BufferGeometry();activityGeometry.setAttribute('position',new THREE.BufferAttribute(activityPositions,3).setUsage(THREE.DynamicDrawUsage));activityGeometry.setAttribute('packetColor',new THREE.BufferAttribute(activityColors,3).setUsage(THREE.DynamicDrawUsage));activityGeometry.setAttribute('packetSize',new THREE.BufferAttribute(activitySizes,1).setUsage(THREE.DynamicDrawUsage));
  activityGeometry.setAttribute('packetAngle',new THREE.BufferAttribute(activityAngles,1).setUsage(THREE.DynamicDrawUsage));activityGeometry.setAttribute('packetKind',new THREE.BufferAttribute(activityKinds,1));
  const activityMaterial=new THREE.ShaderMaterial({vertexShader:pointVertex,fragmentShader:pointFragment.replace('vec4(vColor, a)','vec4(vColor, a * .62)'),uniforms:{uPixelRatio:{value:renderer.getPixelRatio()}},transparent:true,depthWrite:false,blending:blending()});
  const activity=new THREE.Points(activityGeometry,activityMaterial);activity.frustumCulled=false;scene.add(activity);
  const rng=randomGenerator(7724), activityPaths=Array.from({length:activityCount},(_,i)=>{const shell=i%3===0;return{start:shell?CORE_COUNT*CORE_STEPS*2+Math.floor(rng()*SURFACE_COUNT)*SURFACE_STEPS*2:Math.floor(rng()*CORE_COUNT)*CORE_STEPS*2,steps:shell?SURFACE_STEPS:CORE_STEPS,shell: shell?1:0,phase:rng(),speed:.075+rng()*.07};});
  for(let i=0;i<activityCount;i++)activityKinds[i]=2;
  const routeLayer=new THREE.Group();scene.add(routeLayer);const routes=new Map();
  let selected=4, autoRotate=false, cameraTarget=null, focusUntil=0, dragStart=null, hovering=null, width=1,height=1,frames=0,frameTime=0,fps=60,renderUntil=performance.now()+600,reserved=[];
  const invalidate=()=>{renderUntil=performance.now()+220;};
  controls.addEventListener('change',invalidate);controls.addEventListener('start',invalidate);
  const raycaster=new THREE.Raycaster(), pointer=new THREE.Vector2(), projected=new THREE.Vector3(), direction=new THREE.Vector3();
  const onPointerDown=e=>{dragStart={x:e.clientX,y:e.clientY};cameraTarget=null;focusUntil=performance.now()+3000;};
  const pick=e=>{const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObject(agentCores.pickBody)[0]?.instanceId;};
  const onPointerMove=e=>{const next=pick(e);if(next!==hovering)invalidate();hovering=next;renderer.domElement.style.cursor=hovering===undefined?'grab':'pointer';};
  const onPointerUp=e=>{if(dragStart&&Math.hypot(e.clientX-dragStart.x,e.clientY-dragStart.y)<6){const id=pick(e);if(id!==undefined)onSelect?.(id);}dragStart=null;};
  renderer.domElement.addEventListener('pointerdown',onPointerDown);renderer.domElement.addEventListener('pointermove',onPointerMove);renderer.domElement.addEventListener('pointerup',onPointerUp);
  renderer.domElement.addEventListener('pointerleave',()=>{hovering=null;});
  const resize=()=>{const rect=container.getBoundingClientRect();if(rect.width<1||rect.height<1)return;width=rect.width;height=rect.height;renderer.setSize(width,height,false);camera.aspect=width/height;const base=7.25*Math.max(1,.98/camera.aspect),ratio=camera.position.length()/home.length();home.setLength(base);camera.position.setLength(base*ratio);controls.minDistance=base*.74;controls.maxDistance=base*1.6;camera.updateProjectionMatrix();reserved=[...container.closest('.network-stage').querySelectorAll('.stage-heading,.scene-note,.stage-bottom,.route-caption')].map(element=>{const r=element.getBoundingClientRect();return{left:r.left-rect.left,right:r.right-rect.left,top:r.top-rect.top,bottom:r.bottom-rect.top};});invalidate();};
  const observer=new ResizeObserver(resize);observer.observe(container);resize();
  const temp=new THREE.Vector3(), tangent=new THREE.Vector3(), color=new THREE.Color();
  const fieldNormal=new THREE.Vector3(),fieldTangent=new THREE.Vector3(),fieldSecond=new THREE.Vector3(),fieldOrigin=new THREE.Vector3(),fieldAxis=new THREE.Vector3(.23,.91,.37);
  function warpActivity(point,shell,time,intensity){
    const originalX=point.x,originalY=point.y,radius=point.length();fieldNormal.copy(point).normalize();
    fieldTangent.crossVectors(fieldNormal,fieldAxis).addScalar(.001).normalize();fieldSecond.crossVectors(fieldNormal,fieldTangent);
    let wave=Math.sin(time*.96+point.y*3+point.x*1.7)*.030+Math.sin(time*.61+point.z*4.6)*.020;
    for(let i=0;i<4;i++){
      const age=material.uniforms.uPulseAges.value[i];if(age>=6.8)continue;
      fieldOrigin.copy(material.uniforms.uPulseOrigins.value[i]).normalize();const d=fieldNormal.distanceTo(fieldOrigin),band=Math.exp(-Math.pow((d-age*.45)*4.5,2));
      wave+=band*Math.sin(d*9-age*3)*.045*Math.exp(-age*.32);
    }
    point.addScaledVector(fieldTangent,Math.sin(time*.81+originalY*2.4)*.035*intensity).addScaledVector(fieldSecond,Math.cos(time*.63+originalX*2.8)*.023*intensity).addScaledVector(fieldNormal,wave*intensity*(shell?.26:1));
    if(shell)point.setLength(radius*(1+Math.sin(time*.72+originalY)*.004*intensity));
    if(point.length()>2.11)point.setLength(2.11);
  }
  let contextLost=false;
  const onLost=e=>{e.preventDefault();contextLost=true;document.body.dataset.renderer='webgl-lost';};
  const onRestored=()=>{contextLost=false;document.body.dataset.renderer='webgl';invalidate();};
  renderer.domElement.addEventListener('webglcontextlost',onLost);renderer.domElement.addEventListener('webglcontextrestored',onRestored);

  function update(model,delta,running){
    if(contextLost)return;
    frames++;frameTime+=delta;if(frameTime>=1){fps=Math.round(frames/frameTime);frames=0;frameTime=0;}
    material.uniforms.uTime.value=reducedMotion?0:model.elapsed;
    material.uniforms.uIntensity.value=reducedMotion?0:visual.intensity;
    material.uniforms.uOpacity.value=visual.focus?(appearance.dark?.16:.19):(appearance.dark?.30:.34);
    const observation=model.observation;
    const stats=weave.update(model,visual);for(const [key,value]of Object.entries(stats))container.dataset[key]=typeof value==='object'?JSON.stringify(value):String(value);
    for(let i=0;i<4;i++){const event=model.flows[i];material.uniforms.uPulseAges.value[i]=event?model.elapsed-event.at:99;if(event)material.uniforms.uPulseOrigins.value[i].copy(ROLE_POSITIONS[event.from]);}
    controls.autoRotate=autoRotate&&running&&!reducedMotion&&performance.now()>focusUntil&&!cameraTarget;
    const angle=controls.getAzimuthalAngle()-autoAnchor;
    const relative=Math.atan2(Math.sin(angle),Math.cos(angle));
    if(controls.autoRotate&&relative<-.28)controls.autoRotateSpeed=-.23;
    if(controls.autoRotate&&relative>.28)controls.autoRotateSpeed=.23;
    if(cameraTarget){camera.position.lerp(cameraTarget,reducedMotion?1:1-Math.exp(-delta*4));if(camera.position.distanceTo(cameraTarget)<.012)cameraTarget=null;}
    controls.update(delta);
    const alive=new Set(model.flows.map(e=>e.id));
    for(const [id,entry]of routes){if(!alive.has(id)){routeLayer.remove(entry.line);entry.line.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});routes.delete(id);}}
    for(const event of model.flows){
      if(!routes.has(event.id)){
        const curve=flowCurve(event.from,event.to);
        const line=new THREE.Group(),routeColor=PALETTE[ROLES[event.from].group].clone();
        const core=new THREE.Mesh(new THREE.TubeGeometry(curve,100,.006,5,false),new THREE.ShaderMaterial({vertexShader:routeVertex,fragmentShader:routeFragment,uniforms:{uColor:{value:routeColor},uAccent:{value:appearance.lead},uAge:{value:0},uOpacity:{value:.7}},transparent:true,depthWrite:false,blending:blending()}));
        const glow=new THREE.Mesh(new THREE.TubeGeometry(curve,80,.026,5,false),new THREE.MeshBasicMaterial({color:routeColor,transparent:true,opacity:.10,depthWrite:false,blending:blending()}));
        line.add(core,glow);routeLayer.add(line);routes.set(event.id,{curve,line,core,glow,from:event.from});
      }
    }
    let p=0;
    for(const event of model.flows){
      const route=routes.get(event.id),age=model.elapsed-event.at;
      const envelope=Math.min(1,age*4)*Math.max(0,1-age/6.8);
      route.core.material.uniforms.uOpacity.value=Math.min(.72,.25*visual.intensity)*envelope;
      route.core.material.uniforms.uAge.value=reducedMotion?0:age;
      route.glow.material.opacity=.034*visual.intensity*envelope;
      color.copy(PALETTE[ROLES[event.from].group]);
      // Handoffs remain a quiet secondary layer beneath the emerging lead.
      for(let burst=0;burst<1;burst++){
        const progress=(age-burst*1.0)/3.1;if(progress<0||progress>1)continue;
        tangent.copy(route.curve.getTangent(progress)).transformDirection(camera.matrixWorldInverse);
        const heading=Math.atan2(tangent.y,tangent.x);
        for(let tail=0;tail<44&&p<maxPoints;tail++){
          const t=progress-tail*.0045;if(t<0)continue;
          route.curve.getPoint(t,temp);packetPositions[p*3]=temp.x;packetPositions[p*3+1]=temp.y;packetPositions[p*3+2]=temp.z;
          const fade=Math.pow(1-tail/44,1.8);for(let axis=0;axis<3;axis++)packetColors[p*3+axis]=THREE.MathUtils.lerp(appearance.dark?0:appearance.background[CHANNELS[axis]],color[CHANNELS[axis]],fade);packetSizes[p]=(tail===0?11:5.5)*visual.pointScale*Math.sqrt(fade);packetAngles[p]=-heading;packetKinds[p]=tail===0?1:0;p++;
        }
      }
    }
    // One soft flow head per assembled branch; no repeated chain glyphs.
    if(!reducedMotion)for(const branch of weave.branches.values())for(const r of [branch.current,branch.incoming]){
      if(!r||r.gather<.75||r.select<.2)continue;
      const progress=(model.elapsed*(.12+branch.spec.index*.009)+branch.spec.role*.137)%1;
      tangent.copy(r.curve.getTangent(progress)).transformDirection(camera.matrixWorldInverse);const heading=Math.atan2(tangent.y,tangent.x);
      for(let tail=0;tail<22&&p<maxPoints;tail++){
        const q=progress-tail*.005;if(q<0)continue;r.curve.getPoint(q,temp);temp.toArray(packetPositions,p*3);const fade=Math.pow(1-tail/22,1.8)*r.select;
        color.copy(appearance.lead);if(!appearance.dark)color.lerp(appearance.background,1-fade);else color.multiplyScalar(fade);
        color.toArray(packetColors,p*3);packetSizes[p]=(tail===0?9:4.5)*visual.pointScale*Math.sqrt(fade);packetAngles[p]=-heading;packetKinds[p]=tail===0?1:0;p++;
      }
    }
    packetGeometry.setDrawRange(0,p);packetGeometry.attributes.position.needsUpdate=true;packetGeometry.attributes.packetColor.needsUpdate=true;packetGeometry.attributes.packetSize.needsUpdate=true;packetGeometry.attributes.packetAngle.needsUpdate=true;packetGeometry.attributes.packetKind.needsUpdate=true;
    routeLayer.visible=visual.paths;packets.visible=visual.paths&&!reducedMotion;
    const fiberPositions=fibers.geometry.attributes.position.array;
    for(let i=0;i<activityCount;i++){
      const path=activityPaths[i],q=((reducedMotion?0:model.elapsed)*path.speed+path.phase)%1,s=q*(path.steps-1),edge=path.start+Math.floor(s)*2,alpha=s-Math.floor(s);
      for(let axis=0;axis<3;axis++)activityPositions[i*3+axis]=fiberPositions[edge*3+axis]*(1-alpha)+fiberPositions[(edge+1)*3+axis]*alpha;
      temp.fromArray(activityPositions,i*3);const attraction=path.shell?0:weave.attractActivity(Math.floor(path.start/(CORE_STEPS*2)),q,temp);warpActivity(temp,path.shell,reducedMotion?0:model.elapsed,reducedMotion?0:visual.intensity);temp.toArray(activityPositions,i*3);
      for(let axis=0;axis<3;axis++)activityColors[i*3+axis]=THREE.MathUtils.lerp(appearance.fiber[CHANNELS[axis]],appearance.lead[CHANNELS[axis]],attraction);
      tangent.fromArray(fiberPositions,(edge+1)*3).sub(temp.fromArray(fiberPositions,edge*3)).transformDirection(camera.matrixWorldInverse);
      activityAngles[i]=-Math.atan2(tangent.y,tangent.x);
      activitySizes[i]=(2.1+(Math.sin((reducedMotion?0:model.elapsed)*1.2+i)+1)*.8)*visual.pointScale;
    }
    activityGeometry.attributes.position.needsUpdate=true;activityGeometry.attributes.packetColor.needsUpdate=true;activityGeometry.attributes.packetSize.needsUpdate=true;activityGeometry.attributes.packetAngle.needsUpdate=true;activity.visible=!visual.focus;
    direction.copy(camera.position).normalize();
    for(const role of ROLES){
      const i=role.index,status=model.status(i),participating=status!=='idle',isSelected=i===selected;
      projected.copy(ROLE_POSITIONS[i]).project(camera);
      const front=ROLE_POSITIONS[i].clone().normalize().dot(direction)>.05;
      const visible=(status==='running'||isSelected||hovering===i||i===model.config.actors.at(-1)&&observation.phase>1)&&front&&projected.z<1;
      const leftSide=projected.x<0;
      const nodeX=(projected.x*.5+.5)*width;
      let x=nodeX+(leftSide?-140:30);
      const y=(-projected.y*.5+.5)*height+(projected.y>0?-16:7);
      const safeInset=width<550?34:6;
      if(x<safeInset)x=nodeX+30;
      if(x+108>width-safeInset)x=nodeX-140;
      const labelX=Math.min(width-108-safeInset,Math.max(safeInset,x));
      const blocked=reserved.some(rect=>labelX<rect.right&&labelX+108>rect.left&&y<rect.bottom&&y+14>rect.top);
      labels[i].style.transform=`translate3d(${labelX}px,${y}px,0)`;
      labels[i].style.opacity=visible&&!blocked&&visual.labels?'1':'0';labels[i].classList.toggle('selected',isSelected);
    }
    agentCores.update(model,selected,hovering,visual.pointScale);
    renderer.render(scene,camera);
  }
  return {
    update,
    setTheme(){const next=readAppearance();appearance.dark=next.dark;for(const key of ['fiber','fiberAlt','lead','hot','muted','background'])appearance[key].copy(next[key]);for(const key of Object.keys(PALETTE))PALETTE[key].copy(next.palette[key]);agentCores.setTheme();for(const entry of routes.values()){entry.core.material.uniforms.uColor.value.copy(PALETTE[ROLES[entry.from].group]);entry.glow.material.color.copy(PALETTE[ROLES[entry.from].group]);}scene.traverse(o=>{if(o.material?.transparent){o.material.blending=o.material.userData.strategy?THREE.NormalBlending:blending();o.material.needsUpdate=true;}});invalidate();},
    focus(id,orient=true){selected=id;if(orient){cameraTarget=ROLE_POSITIONS[id].clone().normalize().multiplyScalar(camera.position.length());autoAnchor=Math.atan2(cameraTarget.x,cameraTarget.z);focusUntil=performance.now()+6000;}},
    reset(){cameraTarget=home.clone();autoAnchor=Math.atan2(home.x,home.z);focusUntil=performance.now()+1500;},
    setRotate(value){autoRotate=value;},
    setVisual(value){visual={...visual,...value};invalidate();},
    zoom(factor){cameraTarget=camera.position.clone().setLength(THREE.MathUtils.clamp(camera.position.length()*factor,controls.minDistance,controls.maxDistance));focusUntil=performance.now()+3000;},
    resize,
    get needsRender(){return cameraTarget!==null||performance.now()<renderUntil;},
    get fps(){return fps;},
    get drawCalls(){return renderer.info.render.calls;},
    get vertices(){return fibers.geometry.attributes.position.count;},
    dispose(){weave.dispose();observer.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',onPointerDown);renderer.domElement.removeEventListener('pointermove',onPointerMove);renderer.domElement.removeEventListener('pointerup',onPointerUp);renderer.domElement.removeEventListener('webglcontextlost',onLost);renderer.domElement.removeEventListener('webglcontextrestored',onRestored);scene.traverse(o=>{if(o.isInstancedMesh)o.dispose();o.geometry?.dispose();if(o.material){for(const m of(Array.isArray(o.material)?o.material:[o.material]))m.dispose();}});renderer.dispose();labelContainer.replaceChildren();}
  };
}
