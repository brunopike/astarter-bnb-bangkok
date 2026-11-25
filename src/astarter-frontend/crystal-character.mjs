import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {workerPose} from './agent-poses.mjs';

// Landing clear crystal baseline, without changing the original role choreography.
export const CRYSTAL_OPTICS=Object.freeze({ior:1.544,dispersion:.03,roughness:.012,transmission:1,thickness:.9});
// Photonic reference: clear crystal, hard strip reflections, dark negative fill.
export function createCrystalEnvironment(renderer,light=false){
 const scene=new THREE.Scene();scene.background=new THREE.Color(light?'#aab8c9':'#080b10');
 const add=(w,h,x,y,z,color,power=1)=>{const m=new THREE.MeshBasicMaterial({color:new THREE.Color(color).multiplyScalar(power),side:THREE.DoubleSide});const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);mesh.position.set(x,y,z);mesh.lookAt(0,0,0);scene.add(mesh);};
 add(1.1,9,-4,3,4,'#ffffff',light?1.4:5);add(.3,8,4,1,2,'#e8f6ff',light?2:6);add(6,.55,0,5,1,'#ffffff',light?1.2:4);add(3,2,-1,-3,-4,'#7e8d9b',.45);
 ['#ff3e65','#ff8d3d','#ffe65a','#3df5ae','#48e9ff','#5779ff','#bd65ff'].forEach((c,i)=>add(.23,5,1.5+i*.25,0,-3,c,light?.8:2.5));
 if(light){add(1.4,7,4,0,-3,'#34465c',.6);add(.45,8,-4,0,-2,'#60738a',.5);}
 const generator=new THREE.PMREMGenerator(renderer),env=generator.fromScene(scene,.008);generator.dispose();scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});return env;
}
export function createCrystalEdge(){
  return new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,uniforms:{ink:{value:new THREE.Color('#a78bfa')},alpha:{value:.6}},vertexShader:`varying vec3 n;varying vec3 v;varying vec3 tint;void main(){vec4 p=vec4(position,1.);vec3 norm=normal;tint=vec3(1.);
#ifdef USE_INSTANCING
p=instanceMatrix*p;norm=mat3(instanceMatrix)*norm;
#endif
#ifdef USE_INSTANCING_COLOR
tint=instanceColor;
#endif
p=modelViewMatrix*p;n=normalize(normalMatrix*norm);v=-p.xyz;gl_Position=projectionMatrix*p;}`,fragmentShader:'varying vec3 n;varying vec3 v;varying vec3 tint;uniform vec3 ink;uniform float alpha;void main(){float rim=1.-abs(dot(normalize(n),normalize(v)));float f=pow(rim,1.8);vec3 c=mix(ink*tint,vec3(1.),pow(rim,10.)*.45);gl_FragColor=vec4(c,(.008+f*.992)*alpha);\n#include <colorspace_fragment>\n}'});
}

export function createCrystalAgent({compact=false}={}){
  const root=new THREE.Group(),body=new THREE.Group();root.add(body);
  const glass=new THREE.MeshPhysicalMaterial({...CRYSTAL_OPTICS,color:'#ffffff',metalness:0,clearcoat:1,clearcoatRoughness:.02,iridescence:.23,iridescenceIOR:1.544,iridescenceThicknessRange:[140,420],attenuationColor:'#e8eff7',attenuationDistance:2.8,envMapIntensity:1.45});
  const headGroup=new THREE.Group();headGroup.position.y=1.92;body.add(headGroup);
  const headGeometry=new THREE.SphereGeometry(.77,compact?28:64,compact?20:48),vertices=headGeometry.attributes.position;
  for(let i=0;i<vertices.count;i++){const x=vertices.getX(i)/.77,y=vertices.getY(i)/.77,z=vertices.getZ(i)/.77;vertices.setXYZ(i,Math.sign(x)*Math.pow(Math.abs(x),.88)*.77,Math.sign(y)*Math.pow(Math.abs(y),.88)*.71,Math.sign(z)*Math.pow(Math.abs(z),.9)*.64);}headGeometry.computeVertexNormals();
  const head=new THREE.Mesh(headGeometry,glass);headGroup.add(head);
  const torso=new THREE.Mesh(new RoundedBoxGeometry(.64,.67,.44,compact?3:6,.18),glass);torso.position.y=.98;body.add(torso);
  const neck=new THREE.Mesh(new THREE.CapsuleGeometry(.11,.08,8,20),glass);neck.position.y=1.38;body.add(neck);
  const limbs={};
  for(const side of [-1,1]){
    const name=side<0?'left':'right',arm=new THREE.Group();arm.position.set(side*.43,1.2,0);body.add(arm);
    const upper=new THREE.Mesh(new THREE.CapsuleGeometry(.09,.26,compact?4:8,compact?12:24),glass);upper.position.y=-.16;arm.add(upper);
    const elbow=new THREE.Group();elbow.position.y=-.32;arm.add(elbow);
    const lower=new THREE.Mesh(new THREE.CapsuleGeometry(.083,.20,compact?4:8,compact?12:24),glass);lower.position.y=-.14;elbow.add(lower);
    const hand=new THREE.Mesh(new THREE.SphereGeometry(.10,compact?12:24,compact?8:16),glass);hand.scale.set(.85,1.05,.8);hand.position.y=-.30;elbow.add(hand);
    const leg=new THREE.Group();leg.position.set(side*.17,.66,0);body.add(leg);
    const shin=new THREE.Mesh(new THREE.CapsuleGeometry(.10,.28,compact?4:8,compact?12:24),glass);shin.position.y=-.2;leg.add(shin);
    const foot=new THREE.Mesh(new THREE.SphereGeometry(.13,compact?12:24,compact?8:16),glass);foot.position.set(0,-.4,.045);foot.scale.set(1,.65,1.45);leg.add(foot);
    limbs[name]={arm,elbow,leg,hand};
  }
  const edgeInk=createCrystalEdge();
  const shells=[];body.traverse(x=>{if(x.isMesh&&x.material===glass)shells.push(x);});shells.forEach(mesh=>{const edge=new THREE.Mesh(mesh.geometry,edgeInk);edge.scale.setScalar(1.001);edge.renderOrder=3;mesh.add(edge);});
  const neon=new THREE.MeshBasicMaterial({color:new THREE.Color('#a78bfa').multiplyScalar(1.45),toneMapped:false,transparent:true,depthWrite:false}),eyes=[];
  for(const x of [-.23,.23]){const eye=new THREE.Mesh(new THREE.CapsuleGeometry(.055,.18,compact?4:8,compact?12:24),neon);eye.position.set(x,.035,.635);eye.renderOrder=4;eye.rotation.z=x<0?.10:-.10;headGroup.add(eye);eyes.push(eye);}
  if(compact){
    const socket=new THREE.MeshBasicMaterial({color:'#111a24'});socket.userData.socket=true;
    for(const eye of eyes){eye.position.z=.705;const inset=new THREE.Mesh(new THREE.CapsuleGeometry(.066,.18,4,12),socket);inset.position.copy(eye.position);inset.position.z=.66;inset.rotation.copy(eye.rotation);headGroup.add(inset);}
  }
  const eyeGlow=new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,blending:THREE.AdditiveBlending,uniforms:{strength:{value:.75}},vertexShader:`varying vec2 uvv;varying vec3 tint;void main(){uvv=uv;tint=vec3(1.);vec4 p=vec4(position,1.);
#ifdef USE_INSTANCING
p=instanceMatrix*p;
#endif
#ifdef USE_INSTANCING_COLOR
tint=instanceColor;
#endif
gl_Position=projectionMatrix*modelViewMatrix*p;}`,fragmentShader:'varying vec2 uvv;varying vec3 tint;uniform float strength;void main(){vec2 d=(uvv-.5)*2.;float light=exp(-dot(d,d)*4.5);gl_FragColor=vec4(tint,light*strength);}' });eyeGlow.userData.tint='neon';eyeGlow.userData.eyeGlow=true;
  for(const eye of eyes){const glow=new THREE.Mesh(new THREE.PlaneGeometry(.27,.45),eyeGlow);glow.position.copy(eye.position);glow.position.z+=.012;glow.renderOrder=5;headGroup.add(glow);}
  const ringInk=neon.clone();ringInk.userData.tint='neon';
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.87,.027,compact?5:8,compact?48:128),ringInk);ring.rotation.x=-Math.PI/2;ring.position.y=.07;root.add(ring);
  const ringHalo=new THREE.Mesh(new THREE.RingGeometry(.48,1.26,compact?48:128),new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:false,toneMapped:false,side:THREE.DoubleSide,uniforms:{color:{value:new THREE.Color('#a78bfa')},strength:{value:1}},vertexShader:`varying vec3 local;varying vec3 tint;void main(){local=position;tint=vec3(1.);vec4 p=vec4(position,1.);
#ifdef USE_INSTANCING
p=instanceMatrix*p;
#endif
#ifdef USE_INSTANCING_COLOR
tint=instanceColor;
#endif
gl_Position=projectionMatrix*modelViewMatrix*p;}`,fragmentShader:'uniform vec3 color;uniform float strength;varying vec3 local;varying vec3 tint;void main(){float d=abs(length(local.xy)-.87);float core=exp(-pow(d/.021,2.));float near=exp(-pow(d/.075,2.));float wash=exp(-pow(d/.20,2.));float a=clamp((core*.96+near*.46+wash*.16)*strength,0.,1.);vec3 ink=mix(color*tint,vec3(1.),core*.72);gl_FragColor=vec4(ink,a);\n#include <colorspace_fragment>\n}'}));ringHalo.rotation.x=-Math.PI/2;ringHalo.position.y=.068;ringHalo.renderOrder=6;root.add(ringHalo);
  const paper=new THREE.Group();paper.position.set(0,-.34,.09);limbs.right.elbow.add(paper);paper.rotation.x=1.3;paper.visible=false;
  paper.add(new THREE.Mesh(new RoundedBoxGeometry(.24,.32,.018,3,.02),new THREE.MeshPhysicalMaterial({color:'#e3e9ec',roughness:.16,metalness:.15,transparent:true,opacity:.88})));
  for(let i=0;i<3;i++){const line=new THREE.Mesh(new THREE.BoxGeometry(i===2?.10:.15,.012,.005),neon);line.position.set(i===2?-.025:0,.07-i*.06,.013);paper.add(line);}
  body.name='Body';headGroup.name='Head';ring.name='Halo';ringHalo.name='HaloWash';paper.name='Paper';
  for(const [name,limb] of Object.entries(limbs))for(const [part,node]of Object.entries(limb))node.name=name+part;
  eyes.forEach((eye,i)=>eye.name='Eye'+i);
  return {root,body,headGroup,glass,edgeInk,eyes,limbs,neon,ring,ringHalo,paper};
}

export function createCrystalFamily(){
  const base=createCrystalAgent({compact:true});base.paper.removeFromParent();
  base.glass.thickness=1.2;base.glass.envMapIntensity=1.1;base.glass.color.set('#ffffff');base.glass.attenuationColor.set('#ffffff');base.glass.attenuationDistance=10;base.glass.userData.tint='glass';
  base.edgeInk.uniforms.ink.value.set('#ffffff');base.edgeInk.userData.tint='edge';
  base.neon.color.set('#ffffff').multiplyScalar(1.35);base.neon.userData.tint='neon';
  base.ring.material.color.set('#ffffff');base.ringHalo.material.uniforms.color.value.set('#ffffff');base.ringHalo.material.userData.tint='neon';
  base.ring.rotation.x=base.ringHalo.rotation.x=1.16;
  const ceramic=base.glass.clone();ceramic.userData.tint=false;ceramic.color.set('#b9cbd8');ceramic.thickness=2;ceramic.transmission=.94;ceramic.roughness=.045;ceramic.transparent=true;ceramic.opacity=.28;ceramic.depthWrite=false;
  const silver=new THREE.MeshPhysicalMaterial({color:'#cad9e2',metalness:.72,roughness:.2,clearcoat:1});
  const graphite=new THREE.MeshPhysicalMaterial({color:'#111a22',metalness:.22,roughness:.2,clearcoat:1});
  const trim=new THREE.MeshBasicMaterial({color:'#ffffff',toneMapped:false});
  const materials={ceramic,silver,graphite,trim};
  const geometries=new Set(),owned=new Set([...Object.values(materials),base.glass,base.edgeInk,base.neon]);
  for(const root of [base.root,base.paper])root.traverse(n=>{if(n.geometry)geometries.add(n.geometry);if(n.material)owned.add(n.material);});
  return {crystal:true,materials,createRig(){
    const root=base.root.clone(true),body=root.getObjectByName('Body'),head=root.getObjectByName('Head'),joints={Wrist_L:root.getObjectByName('lefthand'),Wrist_R:root.getObjectByName('righthand')},meshes=[];
    root.traverse(n=>{if(n.isMesh)meshes.push(n);});
    return {root,body,head,joints,meshes,height:2.7};
  },pose(rig,p){
    rig.body.rotation.set(0,p.yaw,p.roll);rig.head.rotation.set(p.headPitch,p.headYaw,p.roll*.3);
    for(const side of ['left','right']){rig.root.getObjectByName(side+'arm').rotation.set(p[side+'Arm'],0,p[side+'ArmRoll']);rig.root.getObjectByName(side+'elbow').rotation.x=p[side+'Elbow'];rig.root.getObjectByName(side+'leg').rotation.x=p[side+'Leg'];}
    for(let i=0;i<2;i++)rig.root.getObjectByName('Eye'+i).scale.y=p.squint;
    rig.root.updateMatrixWorld(true);
  },theme(dark){base.edgeInk.uniforms.alpha.value=dark?.9:.88;base.edgeInk.uniforms.ink.value.setScalar(dark?1.35:.4);base.neon.color.setScalar(dark?2:.42);base.ring.material.color.setScalar(dark?1.25:.62);base.ringHalo.material.uniforms.strength.value=dark?1:.74;base.glass.envMapIntensity=dark?1.1:.75;base.glass.transmission=dark?.42:.36;base.glass.roughness=dark?.035:.045;base.glass.iridescence=dark?.23:.12;base.glass.emissive.set('#c0d8e8');base.glass.emissiveIntensity=dark?.08:.035;base.glass.attenuationColor.set('#ffffff');for(const m of owned){if(m.userData.socket)m.color.set(dark?'#111a24':'#e7edf4');if(m.userData.eyeGlow)m.uniforms.strength.value=dark?.75:.035;}ceramic.envMapIntensity=dark?1.2:.8;ceramic.color.set(dark?'#354d5e':'#c9d9e2');silver.color.set(dark?'#44545e':'#a4b4c0');},ornament(){return null;},dispose(){for(const g of geometries)g.dispose();for(const m of owned)m.dispose();}};
}

function start(){
  const stage=document.querySelector('.stage');let renderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});}catch{stage.querySelector('.error').hidden=false;return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
  renderer.domElement.setAttribute('aria-label','透明水晶小人的三维预览');renderer.domElement.setAttribute('role','img');stage.prepend(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,1,.1,60);camera.position.set(1.5,2.5,7.2);
  const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,1.25,0);controls.enablePan=false;controls.enableDamping=true;controls.minDistance=4;controls.maxDistance=14;controls.minPolarAngle=.5;controls.maxPolarAngle=1.65;
  const environment=new THREE.Scene();environment.background=new THREE.Color('#272c32');const lightCards=[];
  const card=(w,h,x,y,z,color,intensity=1)=>{const mat=new THREE.MeshBasicMaterial({color:new THREE.Color(color).multiplyScalar(intensity),side:THREE.DoubleSide});const item=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);item.position.set(x,y,z);item.lookAt(0,1,0);environment.add(item);lightCards.push(item);};
  card(2,7,-4,3,3,'#fffefa',3);card(.35,6,3,2,2,'#eaf4ff',4);card(4,2,0,6,-1,'#ffffff',2);card(2,4,1,2,-4,'#ffffff',1.4);card(1,5,-3,0,-2,'#151922');
  const spectrum=['#ff5548','#ffba47','#e5f860','#53e4a9','#45ccff','#6979ff','#b780ff'];
  spectrum.forEach((color,i)=>card(.045,2,1.2+i*.07,1.3,-2.2,color,1.1));
  const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(environment,.015);scene.environment=env.texture;pmrem.dispose();lightCards.forEach(x=>{x.geometry.dispose();x.material.dispose();});
  const key=new THREE.DirectionalLight('#ffffff',2.6);key.position.set(-3,6,4);scene.add(key,new THREE.HemisphereLight('#e5edff','#050609',.4));
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:'#2b3037',roughness:.72,metalness:.05}));ground.rotation.x=-Math.PI/2;scene.add(ground);
  const shadowTexture=(()=>{const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d'),gr=g.createRadialGradient(64,64,2,64,64,62);gr.addColorStop(0,'rgba(0,0,0,.9)');gr.addColorStop(.5,'rgba(0,0,0,.4)');gr.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=gr;g.fillRect(0,0,128,128);return new THREE.CanvasTexture(c);})();
  const shadow=new THREE.Mesh(new THREE.PlaneGeometry(1.6,1.25),new THREE.MeshBasicMaterial({map:shadowTexture,transparent:true,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=.012;scene.add(shadow);
  const actor=createCrystalAgent();scene.add(actor.root);
  const trailCount=48,trailPoints=[],trailGeometry=new THREE.BufferGeometry(),trailPosition=new Float32Array(trailCount*6),trailLife=new Float32Array(trailCount*2),trailSide=new Float32Array(trailCount*2),trailIndices=[];
  for(let i=0;i<trailCount;i++){trailSide[i*2]=-1;trailSide[i*2+1]=1;if(i<trailCount-1){const j=i*2;trailIndices.push(j,j+1,j+2,j+1,j+3,j+2);}}
  trailGeometry.setAttribute('position',new THREE.BufferAttribute(trailPosition,3));trailGeometry.setAttribute('life',new THREE.BufferAttribute(trailLife,1));trailGeometry.setAttribute('side',new THREE.BufferAttribute(trailSide,1));trailGeometry.setIndex(trailIndices);
  const trailMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide,uniforms:{ink:{value:new THREE.Color('#a78bfa')}},vertexShader:'attribute float life;attribute float side;varying float fade;varying float across;void main(){fade=life;across=side;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'uniform vec3 ink;varying float fade;varying float across;void main(){float core=exp(-pow((abs(across)-.28)*18.,2.));float halo=exp(-across*across*3.);gl_FragColor=vec4(mix(ink,vec3(1.),core*.4),pow(max(fade,0.),1.5)*(core*.8+halo*.35));\n#include <colorspace_fragment>\n}'});
  const trail=new THREE.Mesh(trailGeometry,trailMaterial);trail.frustumCulled=false;trail.renderOrder=2;scene.add(trail);
  const wallCanvas=document.createElement('canvas');wallCanvas.width=wallCanvas.height=512;
  const wallTexture=new THREE.CanvasTexture(wallCanvas);wallTexture.colorSpace=THREE.SRGBColorSpace;
  const wall=new THREE.Mesh(new THREE.PlaneGeometry(40,25),new THREE.MeshBasicMaterial({map:wallTexture}));wall.position.set(0,2,-3.5);scene.add(wall);
  function paintWall(light){const ctx=wallCanvas.getContext('2d'),g=ctx.createRadialGradient(256,245,5,256,245,190);g.addColorStop(0,light?'#ced5dc':'#515964');g.addColorStop(.4,light?'#e2e6ea':'#232a32');g.addColorStop(1,light?'#eef0f2':'#080a0c');ctx.fillStyle=g;ctx.fillRect(0,0,512,512);wallTexture.needsUpdate=true;}

  const glowTexture=(()=>{const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d'),gr=g.createRadialGradient(64,64,0,64,64,64);gr.addColorStop(0,'rgba(255,255,255,.8)');gr.addColorStop(.16,'rgba(255,255,255,.24)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,128,128);return new THREE.CanvasTexture(c);})();
  const glowMaterials=[];actor.eyes.forEach(eye=>{const m=new THREE.SpriteMaterial({map:glowTexture,color:'#a78bfa',transparent:true,opacity:.2,depthWrite:false,blending:THREE.AdditiveBlending});const glow=new THREE.Sprite(m);glow.scale.set(.36,.49,1);glow.position.z=.018;glow.renderOrder=5;eye.add(glow);glowMaterials.push(m);});
  const bounce=new THREE.PointLight('#a78bfa',.25,2,2);bounce.position.set(0,.25,0);scene.add(bounce);
  let color='#a78bfa',light=false,paused=false,small=false,walking=false,walkStart=0,time=1,last=0,handedAt=-100;const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const applyColor=()=>{
    const tint=new THREE.Color(color);
    // Keep thin limbs readable when the character is shown at squad scale.
    actor.glass.color.set('#ffffff').lerp(tint,small?.58:light?.38:.22);
    actor.glass.attenuationColor.set('#ffffff').lerp(tint,small?.65:.45);
    actor.glass.attenuationDistance=2.8;
    actor.glass.emissive.copy(tint);actor.glass.emissiveIntensity=light?.012:.035;
    actor.edgeInk.uniforms.ink.value.copy(tint).multiplyScalar(light?(small?.2:.42):1.15);
    actor.edgeInk.uniforms.alpha.value=small?.9:light?.68:.66;
    actor.neon.color.copy(tint).multiplyScalar(light?.55:1.45);
    actor.ring.material.color.copy(tint).multiplyScalar(light?.62:1.25);actor.ringHalo.material.uniforms.strength.value=light?.74:1;actor.ringHalo.material.uniforms.color.value.copy(tint);
    glowMaterials.forEach(m=>{m.color.copy(tint);m.opacity=light?.15:.35;});
    trailMaterial.uniforms.ink.value.copy(tint).multiplyScalar(light?.4:1.3);
    bounce.color.copy(tint);document.body.style.setProperty('--accent',color);
  };
  const setTheme=value=>{light=value==='light';paintWall(light);document.body.classList.toggle('light',light);scene.background=new THREE.Color(light?'#eef0f2':'#080a0c');scene.fog=new THREE.Fog(light?'#eef0f2':'#080a0c',8,19);ground.material.color.set(light?'#dfe4e8':'#2b3037');ground.material.roughness=.72;actor.glass.envMapIntensity=light?.85:1.15;applyColor();document.querySelectorAll('[data-theme]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.theme===value)));};
  document.querySelectorAll('button[data-theme]').forEach(b=>b.addEventListener('click',()=>setTheme(b.dataset.theme)));setTheme('dark');
  document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{color=b.dataset.color;applyColor();document.querySelectorAll('[data-color]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));}));
  document.querySelector('#pause').addEventListener('click',e=>{paused=!paused;e.currentTarget.textContent=paused?'继续动作':'暂停动作';e.currentTarget.setAttribute('aria-pressed',String(paused));});
  document.querySelector('#size').addEventListener('click',e=>{small=!small;e.currentTarget.setAttribute('aria-pressed',String(small));e.currentTarget.textContent=small?'查看细节':'看小尺寸';actor.root.scale.setScalar(small?.16:1);actor.root.position.y=small?1:0;shadow.visible=!small;trailPoints.length=0;applyColor();});
  const walkButton=document.querySelector('#walk');
  const setWalking=value=>{walking=value;walkStart=time;walkButton.textContent=value?'停下':'走动';walkButton.setAttribute('aria-pressed',String(value));};
  walkButton.addEventListener('click',()=>setWalking(!walking));
  document.querySelector('#handoff').addEventListener('click',()=>{setWalking(false);handedAt=time;});
  const resize=()=>{const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();};const observer=new ResizeObserver(resize);observer.observe(stage);resize();
  function draw(now){
    const dt=Math.min(.04,(now-last)/1000||0);last=now;if(document.hidden){requestAnimationFrame(draw);return;}if(!paused&&!document.hidden&&!reduced.matches)time+=dt;
    const age=time-handedAt,hand=age<4,moving=walking&&!reduced.matches;const phase=(time-walkStart)*1.25,scale=small?.16:1;
    if(!paused){actor.root.position.x=THREE.MathUtils.damp(actor.root.position.x,moving?Math.sin(phase)*.65*scale:0,8,dt);actor.root.position.z=THREE.MathUtils.damp(actor.root.position.z,moving?(1-Math.cos(phase))*.15*scale:0,8,dt);}
    shadow.position.x=actor.root.position.x;shadow.position.z=actor.root.position.z;
    if(moving&&!paused&&(!trailPoints.length||time-trailPoints.at(-1).time>.035)){trailPoints.push({x:actor.root.position.x,z:actor.root.position.z,time});if(trailPoints.length>trailCount)trailPoints.shift();}
    trail.visible=trailPoints.length>1&&!reduced.matches;
    for(let i=0;i<trailCount;i++){const point=trailPoints[Math.min(i,trailPoints.length-1)]||{x:0,z:0,time:-100},next=trailPoints[Math.min(i+1,trailPoints.length-1)]||point,prev=trailPoints[Math.max(0,i-1)]||point,dx=next.x-prev.x,dz=next.z-prev.z,len=Math.hypot(dx,dz)||1;for(let side=0;side<2;side++){const j=i*2+side,width=(side===0?-1:1)*.16*scale;trailPosition[j*3]=point.x-dz/len*width;trailPosition[j*3+1]=(small?1:0)+.052*scale;trailPosition[j*3+2]=point.z+dx/len*width;trailLife[j]=Math.max(0,1-(time-point.time)/1.6);}}
    trailGeometry.attributes.position.needsUpdate=true;trailGeometry.attributes.life.needsUpdate=true;
    const pose=workerPose({id:0,motion:{nod:hand?Math.sin(Math.min(age,1)*Math.PI):0,speaking:!hand&&!moving,walking:moving,facing:0},workPhase:hand?'handoff':'idle'},time,reduced.matches);
    if(hand&&reduced.matches){pose.rightArm=-.98;pose.rightElbow=-.5;}actor.body.position.y=pose.bob*.028;actor.body.rotation.y=moving?Math.cos(phase)*.6:.08*Math.sin(time*.65);actor.headGroup.rotation.y=hand?-.15:Math.sin(time*.6)*.13;actor.headGroup.rotation.x=pose.headPitch;
    for(const name of ['left','right']){const limb=actor.limbs[name];limb.arm.rotation.x=pose[name+'Arm'];limb.arm.rotation.z=pose[name+'ArmRoll'];limb.elbow.rotation.x=pose[name+'Elbow'];limb.leg.rotation.x=pose[name+'Leg'];}
    actor.eyes.forEach(x=>x.scale.y=pose.squint);actor.paper.visible=hand;actor.ringHalo.material.uniforms.strength.value=(light?.26:.4)+(hand?.13:0)+(moving?(1-Math.abs(Math.sin(time*12)))*.18:0)+Math.sin(time*2)*.025;actor.edgeInk.uniforms.alpha.value=(small?.9:light?.68:.66)+(moving?.06*(1-Math.abs(Math.sin(time*12))):0);
    controls.update();renderer.render(scene,camera);stage.dataset.ready='true';stage.dataset.frame=String(Math.round(time*1000));stage.dataset.drawCalls=String(renderer.info.render.calls);requestAnimationFrame(draw);
  }
  renderer.domElement.addEventListener('webglcontextlost',()=>{stage.querySelector('.error').hidden=false;});requestAnimationFrame(draw);
}
if(typeof document!=='undefined'&&document.querySelector('.stage .error'))start();
