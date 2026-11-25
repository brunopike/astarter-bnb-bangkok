import {RESEARCH_GROUPS,researchRoleColor as colorFor} from './multi-research.mjs';
import {createCoreReactions} from './core-reactions.mjs';
import {createMotionClock} from './motion-clock.mjs';
import { createEvidenceMotion } from './evidence-motion.js';
import {evidenceProcess} from './evidence-process.mjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import { ROLES } from './simulation.mjs';
import {createCrystalEnvironment,createCrystalEdge,CRYSTAL_OPTICS} from './crystal-character.mjs';
import { createCouriers } from './couriers.js';

// A visual reconstruction of the supplied video, not recovered Grok Desk code.
const TAU=Math.PI*2;
// One palette for agents, stream families and the static fallback.
const COLORS=RESEARCH_GROUPS.map(group=>group.color);
export const reactorRoleColor=colorFor;
export function setCoreCrystalTheme(material,edge,eyes,dark){
  // Keep a white diffuse body: near-total transmission turns the face into the dark backdrop.
  material.color.set('#ffffff');material.transmission=dark?.24:.18;
  material.emissive.set('#eaf3ff');material.emissiveIntensity=dark?.22:.07;
  material.envMapIntensity=dark?.7:.65;material.attenuationColor.set('#ffffff');material.attenuationDistance=8;
  edge.uniforms.ink.value.set(dark?'#d8edff':'#95b1c8');edge.uniforms.alpha.value=dark?.22:.18;
  eyes.color.set(dark?'#202c3c':'#253447');
}
const shortNames=['环境','趋势','形态','量价','盘口','异常','规则','做多','减仓','反证','等待','推演','决策','敞口','保护','执行','诊断','复盘'];
const vertex=`
attribute float angle,lane,side;
uniform float uTime,uIntensity,uScale,uFocus,uDark,uCount,uSpread,uGather,uFilter;
uniform vec2 uResolution;
uniform vec4 uTethers[7];
uniform vec3 uRoleColors[7];
uniform vec3 uPaletteTint;
uniform float uActivity[7];
varying vec3 vColor;
varying float vAlpha,vSide,vPacket;
const float PI=3.14159265,TAU=6.2831853;
vec3 curve(float u){
  float k=lane,family=mod(floor(k/30.),uCount),clock=uTime*(.35+uIntensity*.09);
  float phase=clock+family*1.73;
  float a=family*2.399+sin(phase*.35)*.7+u*(2.5+sin(phase*.29)*.85);
  a+=sin(u*PI)*sin(k*.7+phase)*.25;
  float outer=(2.08+.27*sin(phase*.41+k*.1))*(1.-uGather*.12);
  float inner=.50+.55*(.5+.5*sin(phase*.61));
  float gather=.5+.5*sin(phase*.68);
  float r=mix(outer,inner,smoothstep(.12,.98,u));
  r+=sin(u*13.+k*.9-clock*1.8)*.07+cos(k*.73+u*7.+phase)*.11;
  vec3 p=vec3(r*cos(a),r*sin(a)*.76,sin(u*TAU+k*.21+clock)*.21-.09);
  p.x=(p.x+sin(phase*.27)*.16*(1.-u))*uSpread;p.y+=cos(phase*.31)*.16;
  p.xy*=1.-uGather*smoothstep(.25,.95,u)*.28;
  p.x+=uFilter*sin(family*2.4)*smoothstep(.5,1.,u)*.32;
  for(int i=0;i<7;i++)if(abs(family-float(i))<.1){
    vec3 anchor=uTethers[i].xyz;
    float pull=smoothstep(.50,.99,u)*uTethers[i].w;
    p=mix(p,anchor,pull*.88);
    p.z-=gather*sin(u*PI)*.12;
  }
  return p;
}
void main(){
  float u=angle/TAU,family=mod(floor(lane/30.),uCount);
  vec4 clip=projectionMatrix*modelViewMatrix*vec4(curve(u),1.);
  vec4 next=projectionMatrix*modelViewMatrix*vec4(curve(u+.002),1.);
  vec2 tangent=(next.xy/next.w-clip.xy/clip.w)*uResolution;
  vec2 normal=normalize(vec2(-tangent.y,tangent.x));
  // Neighbouring filaments carry a coherent packet, with a small phase offset.
  float localLane=mod(lane,30.);
  float head=fract(uTime*(.19+uIntensity*.07)+lane*.017-localLane*.013);
  float d=fract(head-u+1.);
  float arrival=smoothstep(0.,.035,d);
  float pulse=(1.-smoothstep(.06,.23,d))*arrival;
  float tail=(1.-smoothstep(.08,.46,d))*arrival;
  float strandWeight=.84+.16*cos(localLane*.24+family);
  float packet=(pulse*.64+tail*.36)*strandWeight;
  float activity=0.;
  for(int i=0;i<7;i++)if(abs(family-float(i))<.1)activity=uActivity[i];
  // A narrow bright centre and coloured shoulders travel inside each ribbon.
  float width=(2.+packet*7.+activity*packet*1.6)*uScale;
  clip.xy+=normal*side*width*2./uResolution*clip.w;gl_Position=clip;
  vec3 color=vec3(.5);
  for(int i=0;i<7;i++)if(abs(family-float(i))<.1)color=uRoleColors[i];
  // Weight travels with the packet; no filament stays permanently prominent.
  vColor=color*mix(.42,1.2,uDark);
  float taper=smoothstep(0.,.09,u)*(1.-smoothstep(.92,1.,u));
  float weight=smoothstep(.02,.94,packet);
  vAlpha=mix(mix(.065,.025,uDark),mix(.86,.66,uDark),weight)*taper*(1.-uFocus*.3);
  vSide=side;vPacket=packet;
}`;
const fragment=`varying vec3 vColor;varying float vAlpha,vSide,vPacket;uniform float uDark;
void main(){
 float x=abs(vSide),core=exp(-x*x*1900.),body=exp(-x*x*180.),halo=exp(-x*x*6.);
 float alpha=vAlpha*(core*.95+body*.55+halo*mix(.025,.13,uDark))*(1.-smoothstep(.8,1.,x));
 vec3 color=mix(vColor,vec3(1.),core*vPacket*.10);
 color*=mix(1.,1.5+core*vPacket*.8,uDark);
 gl_FragColor=vec4(color,alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;
function filaments(perFamily=30){
  const rows=7*perFamily,steps=perFamily===30?150:96,count=rows*(steps+1)*2,positions=new Float32Array(count*3),angles=new Float32Array(count),lanes=new Float32Array(count),sides=new Float32Array(count),indices=[];
  for(let row=0;row<rows;row++)for(let j=0;j<=steps;j++){const v=(row*(steps+1)+j)*2;angles[v]=angles[v+1]=j/steps*TAU;lanes[v]=lanes[v+1]=Math.floor(row/perFamily)*30+(row%perFamily)*30/perFamily;sides[v]=-1;sides[v+1]=1;if(j<steps)indices.push(v,v+2,v+1,v+1,v+2,v+3);}
  const g=new THREE.BufferGeometry();for(const [key,array,size]of [['position',positions,3],['angle',angles,1],['lane',lanes,1],['side',sides,1]])g.setAttribute(key,new THREE.BufferAttribute(array,size));g.setIndex(indices);return g;
}

function fallback(container,labelContainer,onSelect,surface=document.body){
  surface.dataset.renderer='static';
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 700 430');svg.setAttribute('role','img');svg.setAttribute('aria-label','协作核心静态示意，三维渲染不可用');
  const lines=Array.from({length:48},(_,i)=>`<ellipse cx="350" cy="205" rx="${172+i%7*3}" ry="${115+i%9*3}" fill="none" stroke="${COLORS[i%6]}" stroke-opacity=".3" stroke-width=".8" transform="rotate(${Math.sin(i)*7} 350 205)"/>`).join('');
  svg.innerHTML=`<defs><radialGradient id="reactor-core"><stop offset="0" stop-color="#fff"/><stop offset=".75" stop-color="#f7f8fc"/><stop offset="1" stop-color="#c4c8db"/></radialGradient></defs>${lines}<ellipse cx="350" cy="261" rx="46" ry="10" fill="#6468b1" opacity=".13"/><circle cx="350" cy="200" r="47" fill="url(#reactor-core)"/><rect x="333" y="182" width="9" height="25" rx="5" transform="rotate(-10 338 195)"/><rect x="358" y="182" width="9" height="25" rx="5" transform="rotate(10 363 195)"/><text x="350" y="400" text-anchor="middle" fill="currentColor" font-size="13">静态示意 · 三维动效不可用</text>`;
  container.replaceChildren(svg);labelContainer.replaceChildren();let prior='';
  return {update(model){if(prior===model.key)return;prior=model.key;labelContainer.replaceChildren();model.config.actors.forEach((id,i)=>{const b=document.createElement('button');b.className='reactor-fallback-agent';b.textContent=`${ROLES[id].id} ${shortNames[id]}`;b.style.left=`${50+Math.cos(i/model.config.actors.length*TAU)*35}%`;b.style.top=`${48+Math.sin(i/model.config.actors.length*TAU)*32}%`;b.style.setProperty('--agent-color',colorFor(id));b.onclick=()=>onSelect?.(id);labelContainer.append(b);});},focus(){},setRotate(){},setVisual(){},setTheme(){},zoom(){},reset(){},resize(){},dispose(){container.replaceChildren();labelContainer.replaceChildren();},get fps(){return null;},get drawCalls(){return 0;}};
}

export function createReactor(container,labelContainer,{onSelect,reducedMotion=false,scope=null}={}){
  const surface=scope||document.body;
  surface.dataset.agentLook=new URLSearchParams(location.search).get('look')==='classic'?'classic':'threeui';
  const useAgentModel=new URLSearchParams(location.search).get('look')!=='classic';
  surface.dataset.characterLook=useAgentModel?'crystal':'classic';
  if(new URLSearchParams(location.search).get('renderer')==='static')return fallback(container,labelContainer,onSelect,surface);
  let renderer;try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});}catch{return fallback(container,labelContainer,onSelect,surface);}
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.6));renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
  container.replaceChildren(renderer.domElement);renderer.domElement.setAttribute('role','img');renderer.domElement.setAttribute('aria-label','开放的流动证据线束与白色协作核心，Agent 往返数据面板采集并交接');surface.dataset.renderer='webgl';
  const scene=new THREE.Scene(),root=new THREE.Group();scene.add(root);
  const camera=new THREE.PerspectiveCamera(35,1,.1,30);camera.position.set(0,.1,6.6);
  const composer=new EffectComposer(renderer,new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,samples:4})),bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.18,.12,.85),output=new OutputPass();
  composer.setPixelRatio(Math.min(devicePixelRatio||1,1.25));composer.addPass(new RenderPass(scene,camera));composer.addPass(bloom);composer.addPass(output);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.enablePan=false;controls.enableZoom=surface.dataset.agentLook!=='threeui';controls.minDistance=5.5;controls.maxDistance=12;controls.minPolarAngle=Math.PI*.32;controls.maxPolarAngle=Math.PI*.68;controls.autoRotateSpeed=.25;
  const coreEnv=useAgentModel?createCrystalEnvironment(renderer):null,coreLightEnv=useAgentModel?createCrystalEnvironment(renderer,true):null;if(coreEnv){scene.environment=coreEnv.texture;scene.environmentRotation.set(.12,-.75,.08);}
  scene.add(new THREE.HemisphereLight(0xffffff,useAgentModel?0x75869a:0x121a22,useAgentModel?.9:3));
  const key=new THREE.DirectionalLight(0xffffff,useAgentModel?1.3:4.5);key.position.set(-3,5,6);scene.add(key);
  const fill=new THREE.DirectionalLight(useAgentModel?0xe2eaff:0xc4cdfd,useAgentModel?1.1:2);fill.position.set(3,-2,2);scene.add(fill);
  const core=new THREE.Group();root.add(core);
  const material=new THREE.MeshPhysicalMaterial(useAgentModel?{...CRYSTAL_OPTICS,color:'#eaf1f8',thickness:.84,dispersion:.2,roughness:.055,envMapIntensity:.7,iridescence:.18,iridescenceIOR:1.544,iridescenceThicknessRange:[120,440],clearcoat:1,clearcoatRoughness:.035}:{color:0xf6f7fc,roughness:.29,metalness:.03,clearcoat:.6,clearcoatRoughness:.28});
  const prismBuffer=useAgentModel?new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter}):null;
  if(prismBuffer){
    // Transparent beams are absent from Three's default transmission pass; capture them for real refraction.
    prismBuffer.texture.colorSpace=THREE.LinearSRGBColorSpace;
    material.onBeforeCompile=shader=>{shader.uniforms.prismSceneMap={value:prismBuffer.texture};shader.uniforms.prismSceneSize={value:new THREE.Vector2()};material.userData.prismSize=shader.uniforms.prismSceneSize.value;shader.fragmentShader=shader.fragmentShader.replace('#include <transmission_pars_fragment>',THREE.ShaderChunk.transmission_pars_fragment.replaceAll('transmissionSamplerMap','prismSceneMap').replaceAll('transmissionSamplerSize','prismSceneSize'));};
    material.customProgramCacheKey=()=> 'photonic-captured-background-v1';
  }
  const head=new THREE.Mesh(new THREE.SphereGeometry(.47,64,48),material);head.scale.set(1,.96,.86);core.add(head);
  const eyeMaterial=new THREE.MeshBasicMaterial({color:useAgentModel?0xe7fbff:0x181922,toneMapped:false}),eyes=[];
  for(const side of [-1,1]){const eye=new THREE.Mesh(new THREE.CapsuleGeometry(.039,.19,6,12),eyeMaterial);eye.position.set(side*.113,.055,.39);eye.rotation.z=side*-.13;core.add(eye);eyes.push(eye);}
  let coreEdge;if(useAgentModel){coreEdge=createCrystalEdge();coreEdge.uniforms.ink.value.set('#94dbff');coreEdge.uniforms.alpha.value=.38;const shell=new THREE.Mesh(head.geometry,coreEdge);shell.scale.setScalar(1.002);head.add(shell);}
  const hands=[-1,1].map(side=>{const hand=new THREE.Mesh(new THREE.SphereGeometry(.065,20,16),material);hand.position.set(side*.18,-.37,.34);hand.scale.set(.85,.68,1);core.add(hand);return hand;});
  const uniforms={uPaletteTint:{value:new THREE.Color('#e7dcff')},uSpread:{value:1},uGather:{value:0},uFilter:{value:0},uTime:{value:0},uIntensity:{value:1.8},uScale:{value:1.4},uFocus:{value:0},uDark:{value:0},uCount:{value:5},uResolution:{value:new THREE.Vector2(1,1)},uTethers:{value:Array.from({length:7},()=>new THREE.Vector4(0,0,0,0))},uRoleColors:{value:Array.from({length:7},(_,i)=>new THREE.Color(COLORS[i%6]))}};
  uniforms.uActivity={value:new Float32Array(7)};
  let strandDensity=30;
  const strands=new THREE.Mesh(filaments(),new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,uniforms,transparent:true,depthWrite:false,side:THREE.DoubleSide}));strands.frustumCulled=false;root.add(strands);
  const projected=new THREE.Vector3(),world=new THREE.Vector3();let autoRotate=false,renderUntil=0,frames=0,span=0,fps=0,visual={intensity:1.8,pointScale:1.6,labels:true,paths:true,focus:false};
  const coreLabel=document.createElement('div');coreLabel.className='reactor-core-label';coreLabel.innerHTML='<strong>HIVE CORE</strong><span>证据协同</span>';labelContainer.append(coreLabel);
  const corePoint=()=>{camera.updateMatrixWorld();projected.set(0,.04,.38).applyMatrix4(root.matrixWorld).project(camera);return {x:(projected.x*.5+.5)*container.clientWidth,y:(-projected.y*.5+.5)*container.clientHeight};};
  const handoffPoint=()=>{core.updateWorldMatrix(true,false);projected.set(0,-.39,.48);core.localToWorld(projected);projected.project(camera);return {x:(projected.x*.5+.5)*container.clientWidth,y:(-projected.y*.5+.5)*container.clientHeight};};
  const couriers=createCouriers(container,{onSelect,colorFor,corePoint,handoffPoint,useAgentModel,scope});
  const evidenceMotion=createEvidenceMotion(container,colorFor,scope||document),motionClock=createMotionClock(),reactCore=createCoreReactions();
  function resize(){const width=Math.max(1,container.clientWidth),height=Math.max(1,container.clientHeight);renderer.setSize(width,height,false);composer.setSize(width,height);prismBuffer?.setSize(Math.max(1,Math.round(width*.75)),Math.max(1,Math.round(height*.75)));camera.aspect=width/height;camera.updateProjectionMatrix();
    const spread=Math.min(surface.dataset.multiResearch==='true'?2.5:1.8,Math.max(1,width/height*.74));uniforms.uSpread.value=spread;
    const visibleHeight=2*6.6*Math.tan(35*Math.PI/360);const fit=Math.min(width*.88/(4.6*spread),Math.max(150,height-66)/3.35)*visibleHeight/height;root.scale.setScalar(fit);
    const density=width<600?14:30;if(density!==strandDensity){strands.geometry.dispose();strands.geometry=filaments(density);strandDensity=density;}
    container.dataset.fitScale=fit.toFixed(3);container.dataset.fitWidth=String(width);container.dataset.fitHeight=String(height);uniforms.uResolution.value.set(width,height);couriers.resize();renderUntil=performance.now()+500;}
  const observer=new ResizeObserver(resize);observer.observe(container);resize();
  function setTheme(){bloom.enabled=document.documentElement.dataset.theme==='dark';if(coreEdge){const dark=document.documentElement.dataset.theme==='dark';scene.environment=(dark?coreEnv:coreLightEnv).texture;setCoreCrystalTheme(material,coreEdge,eyeMaterial,dark);}uniforms.uDark.value=document.documentElement.dataset.theme==='dark'?1:0;uniforms.uPaletteTint.value.set(getComputedStyle(document.documentElement).getPropertyValue('--b-accent').trim()||'#e7dcff');renderUntil=performance.now()+300;}
  setTheme();
  function update(model,delta,running,{ambient=false}={}){
    if(container.clientWidth<1||container.clientHeight<1)return;
    const t=motionClock.update(model,delta,{ambient,reduced:reducedMotion}),ended=surface.dataset.stopped==='true'&&!model.completed;uniforms.uTime.value=t;uniforms.uIntensity.value=visual.intensity;uniforms.uScale.value=.65+visual.pointScale*.48;uniforms.uFocus.value=visual.focus?1:0;uniforms.uCount.value=model.config.actors.length;
    controls.autoRotate=autoRotate&&running&&!reducedMotion;controls.update(running?delta:0);root.updateMatrixWorld(true);
    const states=couriers.update(model,{reducedMotion,stopped:ended,running,motionTime:t,ambient});
    const process=evidenceProcess(model);
    coreLabel.style.opacity='0';
    uniforms.uGather.value=process.items.reduce((v,i)=>Math.max(v,i.stage===3?Math.sin(i.progress*Math.PI):0),0);uniforms.uFilter.value=process.items.reduce((v,i)=>Math.max(v,i.stage===4?Math.sin(i.progress*Math.PI):0),0);
    if(model.multiResearch?.core){const age=model.elapsed-model.multiResearch.core.at;uniforms.uGather.value=age>2.6&&age<7?Math.sin((age-2.6)/4.4*Math.PI):0;uniforms.uFilter.value=age>4&&age<7?Math.sin((age-4)/3*Math.PI):0;}
    const activeStates=[...states.filter(s=>s.leader&&['deliver','submit'].includes(s.workPhase)),...states.filter(s=>s.leader),...states.filter(s=>s.phase<5),...states.filter(s=>s.job),...states.filter(s=>(model.visualRoles||[]).includes(s.id)),...states.filter(s=>model.config.actors.includes(s.id))].filter((s,i,a)=>a.findIndex(x=>x.id===s.id)===i).slice(0,7);
    uniforms.uCount.value=Math.max(1,activeStates.length);
    let gather=uniforms.uGather.value;
    for(let i=0;i<7;i++){
      const state=activeStates[i];if(!state){uniforms.uTethers.value[i].set(0,0,0,0);uniforms.uActivity.value[i]=0;continue;}
      const width=container.clientWidth,height=container.clientHeight;
      world.set(state.x/width*2-1,-state.y/height*2+1,.5).unproject(camera);const direction=world.sub(camera.position).normalize();world.copy(camera.position).addScaledVector(direction,-camera.position.z/direction.z);root.worldToLocal(world);
      world.x=THREE.MathUtils.clamp(world.x,-2.25,2.25);world.y=THREE.MathUtils.clamp(world.y,-1.65,1.65);world.z=-.08;if(state.phase===3){world.x*=1-state.p*.86;world.y*=1-state.p*.86;}
      const pull=state.leader&&state.workPhase==='submit'?.98:state.leader&&state.workPhase==='deliver'?.7:state.phase===2?.35+state.p*.6:state.phase===3?.98:state.phase===1?.7:state.phase===4?(1-state.p)*.75:.22;
      uniforms.uTethers.value[i].set(world.x,world.y,world.z,pull);uniforms.uRoleColors.value[i].set(colorFor(state.id));if(state.phase===3)gather=Math.max(gather,Math.sin(state.p*Math.PI));
      uniforms.uActivity.value[i]=state.workPhase==='submit'||state.phase===3?1:state.workPhase==='deliver'||state.phase===2?.65:state.work?.action==='retrieve'?.4:.12;
    }
    const reaction=reactCore({time:t,epoch:model.epoch,states,phase:process.phase,ready:process.ready,width:container.clientWidth,height:container.clientHeight,center:corePoint(),pace:ambient?2.5:1,reduced:reducedMotion});
    couriers.react(reaction);
    evidenceMotion.update(model,states,corePoint(),{reduced:reducedMotion,stopped:ended,receipt:reaction.receipt});
    core.visible=!couriers.materialReady;
    core.position.set(reaction.lean,reaction.lift,0);hands.forEach(hand=>{hand.visible=reaction.hands>.03;hand.scale.set(.85,.68,1).multiplyScalar(reaction.hands);});core.rotation.set(reaction.pitch,reaction.yaw,reaction.roll);core.scale.setScalar((model.multiResearch?1.25:1)*(1+gather*.04));
    const blink=reducedMotion?1:1-Math.pow(Math.max(0,Math.cos(t*.88+1.2)),70)*.9;
    eyes.forEach((eye,i)=>{eye.scale.y=Math.max(.12,blink*reaction.squint);eye.position.x=(i?1:-1)*.113+reaction.lookX;eye.position.y=.055+reaction.lookY;});
    container.dataset.coreAction=reaction.action;container.dataset.coreTarget=String(reaction.targetId??'');container.dataset.corePose=[reaction.pitch,reaction.yaw,reaction.roll].map(v=>v.toFixed(3)).join(',');
    projected.set(0,-.75,.25);root.localToWorld(projected);projected.project(camera);coreLabel.style.left=`${(projected.x*.5+.5)*container.clientWidth}px`;coreLabel.style.top=`${(-projected.y*.5+.5)*container.clientHeight}px`;coreLabel.querySelector('span').textContent=ended&&!process.ready?'本轮已结束':process.title;
    if(prismBuffer){const visible=core.visible;core.visible=false;renderer.setRenderTarget(prismBuffer);renderer.render(scene,camera);core.visible=visible;renderer.setRenderTarget(null);material.userData.prismSize?.set(prismBuffer.width,prismBuffer.height);}
    composer.render(delta);frames++;span+=delta;if(span>=.6){fps=Math.round(frames/span);frames=0;span=0;}
    container.dataset.process=['collect','gather','filter','result'][process.phase];container.dataset.streams=String(model.flows.length);container.dataset.agents=String(states.length);container.dataset.strands=String(strandDensity*7);container.dataset.motionTime=t.toFixed(3);container.dataset.ambient=String(ambient);container.dataset.researchTime=model.elapsed.toFixed(3);container.dataset.collecting=String(states.filter(s=>s.phase===1).length);container.dataset.carrying=String(states.filter(s=>s.phase===2).length);
  }
  const invalidate=()=>{renderUntil=performance.now()+800;couriers.resize();};controls.addEventListener('change',invalidate);
  return {update,focus(id){couriers.focus(id);invalidate();},setVisual(value){visual={...visual,...value};couriers.setVisual(value);invalidate();},setTheme,setRotate(value){autoRotate=value;invalidate();},reset(){camera.position.set(0,.1,6.6);controls.target.set(0,0,0);controls.update();invalidate();},zoom(factor){camera.position.multiplyScalar(factor).clampLength(5.5,12);controls.update();invalidate();},resize,get needsRender(){return performance.now()<renderUntil||couriers.needsLayout;},get fps(){return fps;},get drawCalls(){return renderer.info.render.calls;},dispose(){evidenceMotion.dispose();couriers.dispose();observer.disconnect();controls.removeEventListener('change',invalidate);controls.dispose();scene.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();});prismBuffer?.dispose();coreEnv?.dispose();coreLightEnv?.dispose();bloom.dispose();output.dispose();composer.dispose();renderer.dispose();renderer.forceContextLoss();container.replaceChildren();labelContainer.replaceChildren();}};
}
