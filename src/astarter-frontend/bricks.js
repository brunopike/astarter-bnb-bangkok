// ThreeUI Pro Scalability Bricks: original stud geometry and facet/role shaders.
// Hive adaptation: evidence selection, strategy assembly and local revisions.
// Official member source is retained privately in task evidence, not exported.
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {ROLES} from './simulation.mjs';

const clamp=x=>Math.max(0,Math.min(1,x));
const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
const ease=x=>{x=clamp(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;};
function hash(i,j=0,s=1){let v=((i+97)*374761393^(j+131)*668265263^s*2246822519)>>>0;v=Math.imul(v^(v>>>13),1274126177)>>>0;return((v^(v>>>16))>>>0)/4294967296;}

function staticBricks(container,labelContainer){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 420 400');svg.style.cssText='width:100%;height:100%';
 const draw=(X,Y,lit,scale=1)=>{const g=document.createElementNS(ns,'g');g.innerHTML='<path d="M0,-10l17,10 -17,10 -17,-10Z"/><path d="M-17,0v18l17,10v-18Z"/><path d="M0,10v18l17,-10v-18Z"/><ellipse cx="0" cy="-3" rx="6" ry="3"/>';g.setAttribute('transform',`translate(${X},${Y}) scale(${scale})`);g.setAttribute('fill',lit?'var(--accent-soft)':'var(--surface)');g.setAttribute('stroke',lit?'var(--accent)':'var(--dim)');g.setAttribute('stroke-width','.8');svg.append(g);};
 for(let y=0;y<8;y++)for(let x=0;x<9;x++)if(x<2||x>6||y<2||y>5)draw(26+x*46,45+y*43,false,.55);
 for(let m=0;m<3;m++)for(let k=0;k<3+m%2;k++)for(let x=0;x<2;x++)draw(137+m*52+x*19,234-m*15-k*20+x*10,true,.8);
 container.replaceChildren(svg);labelContainer.replaceChildren();document.body.dataset.renderer='svg-fallback';
 const note=document.createElement('span');note.className='fallback-label';note.textContent='策略组合示意 · 静态模式';container.append(note);
 return{update(){},focus(){},reset(){},setRotate(){},setVisual(){},setTheme(){},zoom(){},resize(){},restore(){},get fps(){return null;},dispose(){container.replaceChildren();}};
}

export function createBricks(container,labelContainer,{onSelect,reducedMotion=false}={}){
 if(new URLSearchParams(location.search).get('renderer')==='static')return staticBricks(container,labelContainer);
 let visual={intensity:1.8,pointScale:1.6,labels:true,paths:true,focus:false,brickStyle:'outline'},selected=4,autoRotate=false,disposed=false,contextLost=false,renderUntil=0,flight=null;
 let lastEpoch=-1,lastScenario='',fps=60,frames=0,seconds=0,revision=null;
 const invalidate=()=>{renderUntil=performance.now()+600;};
 const HT=1.2,SR=.276,SH=.147,LAM=.162,GAP=.985;
 const cv=document.createElement('canvas');cv.className='bricks-canvas';cv.setAttribute('role','img');cv.setAttribute('aria-label','候选信号积木被摘选并组合为策略，点击模块聚焦，拖动旋转');
 let renderer;try{renderer=new THREE.WebGLRenderer({canvas:cv,antialias:true,alpha:true,powerPreference:'high-performance'});}catch{return staticBricks(container,labelContainer);}
 renderer.outputColorSpace=THREE.LinearSRGBColorSpace;container.replaceChildren(cv);document.body.dataset.renderer='webgl';
 const scene=new THREE.Scene(),cam=new THREE.OrthographicCamera(-1,1,1,-1,.1,400);
 const HOME_TARGET=new THREE.Vector3(0,2.4,0),HOME_DIR=new THREE.Vector3(1.2,1.25,1.1).normalize(),DIST=120;
 const right=new THREE.Vector3(HOME_DIR.z,0,-HOME_DIR.x).normalize(),up=new THREE.Vector3().crossVectors(HOME_DIR,right).normalize();
 cam.position.copy(HOME_TARGET).addScaledVector(HOME_DIR,DIST);cam.lookAt(HOME_TARGET);
 const controls=new OrbitControls(cam,cv);controls.target.copy(HOME_TARGET);controls.enableDamping=true;controls.dampingFactor=.075;controls.rotateSpeed=.5;controls.zoomSpeed=.7;controls.enablePan=false;controls.minZoom=.75;controls.maxZoom=2;controls.minPolarAngle=.45;controls.maxPolarAngle=Math.PI*.47;controls.update();
 let frameWidth=30,frameHeight=26;
const VERT = `
  varying vec3 vPos;
  varying vec3 vN;
  void main(){
    vPos = position;
    vec4 p=vec4(position,1.0);vec3 n=normal;
    #ifdef USE_INSTANCING
      p=instanceMatrix*p;n=mat3(instanceMatrix)*n;
    #endif
    vN=normalize(mat3(modelMatrix)*n);
    gl_Position=projectionMatrix*modelViewMatrix*p;
  }`;

/* the four face tones, picked by the normal — one line, no lighting to
   chase while orbiting */
const FACET = `
  float facet(vec3 n, vec4 s){
    return s.x * max(n.y, 0.0) + s.y * max(-n.y, 0.0)
         + s.z * abs(n.x)      + s.w * abs(n.z);
  }`;

const GLOW = {value:new THREE.Color()};
const ghostMat = new THREE.ShaderMaterial({
 uniforms:{uShade:{value:new THREE.Vector4()},uGlow:GLOW},
 vertexShader:VERT.replace('varying vec3 vPos;', 'attribute float iEnergy; varying float vEnergy; varying vec3 vPos;').replace('vPos = position;', 'vPos=position;vEnergy=iEnergy;'),
 fragmentShader:`uniform vec4 uShade;uniform vec3 uGlow;varying float vEnergy;varying vec3 vN;${FACET}
 void main(){float f=facet(normalize(vN),uShade);gl_FragColor=vec4(mix(vec3(f),uGlow*(.55+.45*max(vN.y,0.0)),vEnergy),1.0);}`,
 polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1
});
const ghostLineMat=new THREE.ShaderMaterial({
 uniforms:{uColor:{value:new THREE.Color()},uOpacity:{value:.2},uGlow:GLOW},transparent:true,depthWrite:false,
 vertexShader:`attribute vec3 iPosition;attribute vec4 iQuaternion;attribute float iScale;attribute float iEnergy;varying float vEnergy;
 void main(){vEnergy=iEnergy;vec3 p=position*iScale;p+=2.0*cross(iQuaternion.xyz,cross(iQuaternion.xyz,p)+iQuaternion.w*p);gl_Position=projectionMatrix*modelViewMatrix*vec4(p+iPosition,1.0);}`,
 fragmentShader:`uniform vec3 uColor;uniform vec3 uGlow;uniform float uOpacity;varying float vEnergy;void main(){gl_FragColor=vec4(mix(uColor,uGlow,vEnergy),uOpacity+vEnergy*.18);}`
});

/* Lit brick.  In the dark themes light escapes along the *silhouette* edges —
   the ones shared with a back-facing neighbour — which keeps the near vertical
   corner dark; solved in object space so it survives orbiting.  On a light
   background a glow would simply vanish, so there the same brick renders as a
   solid saturated block with the same facet shading as its neighbours. */
const VIEW  = { value: new THREE.Vector3(1, 1, 1).normalize() };

const SOLID = { value: 0 };
const LSHADE = { value: new THREE.Vector4(1.0, 0.66, 0.82, 0.93) };

function litBoxMat(){
  return new THREE.ShaderMaterial({
    uniforms: {
      uHalf:   { value: new THREE.Vector3(0.5, HT / 2, 0.5) },
      uView:VIEW,uGlow:GLOW,uSolid:SOLID,uShade:LSHADE,uGhost:ghostMat.uniforms.uShade,uActive:{value:1},
      uLambda: { value: LAM },
      uSil:    { value: 1.05 },
      uTop:    { value: 0.28 },
      uStud:   { value: SR }
    },
    transparent: true, depthWrite: true,
    vertexShader: VERT,
    fragmentShader: `
      uniform vec3 uHalf; uniform vec3 uView; uniform vec3 uGlow;
      uniform vec4 uShade; uniform float uSolid;uniform vec4 uGhost;uniform float uActive;
      uniform float uLambda; uniform float uSil; uniform float uTop;
      uniform float uStud;
      varying vec3 vPos; varying vec3 vN;
      ${FACET}
      void main(){
        vec3 n = normalize(vN);
        if (uSolid > 0.5){
          gl_FragColor=vec4(mix(vec3(facet(n,uGhost)),uGlow*facet(n,uShade),uActive),1.0);
          return;
        }
        vec3 v = normalize(uView);
        vec3 h = uHalf;

        float dSil = 1e9, dTop = 1e9;
        if (abs(n.x) < 0.5) dSil = min(dSil, v.x > 0.0 ? h.x + vPos.x : h.x - vPos.x);
        if (abs(n.z) < 0.5) dSil = min(dSil, v.z > 0.0 ? h.z + vPos.z : h.z - vPos.z);
        if (abs(n.y) < 0.5){
          dSil = min(dSil, v.y > 0.0 ? h.y + vPos.y : h.y - vPos.y);
          dTop = v.y > 0.0 ? h.y - vPos.y : h.y + vPos.y;
        }

        float g = max(uSil * exp(-max(dSil, 0.0) / uLambda),
                      uTop * exp(-max(dTop, 0.0) / uLambda));
        float base = 0.463 + 0.510 * max(n.y, 0.0) - 0.100 * max(-n.y, 0.0);
        float c = min(base + (1.0 - base) * min(g, 1.0), 1.0);

        if (n.y > 0.5){                       /* contact shade round the stud */
          float ao = exp(-max(length(vPos.xz) - uStud, 0.0) / 0.34);
          c -= 0.20 * ao;
        }
        gl_FragColor=vec4(mix(vec3(facet(n,uGhost)),mix(uGlow*c,mix(uGlow,vec3(1.0),.36),pow(c,6.0)),uActive),1.0);
      }`
  });
}

function litStudMat(){
  return new THREE.ShaderMaterial({
    uniforms: {
      uR: { value: SR }, uH: { value: SH / 2 }, uLambda: { value: LAM },
      uGlow:GLOW,uSolid:SOLID,uShade:LSHADE,uGhost:ghostMat.uniforms.uShade,uActive:{value:1}
    },
    transparent: true, depthWrite: true,
    vertexShader: VERT,
    fragmentShader: `
      uniform float uR; uniform float uH; uniform float uLambda;
      uniform vec3 uGlow; uniform vec4 uShade; uniform float uSolid;uniform vec4 uGhost;uniform float uActive;
      varying vec3 vPos; varying vec3 vN;
      ${FACET}
      void main(){
        vec3 n = normalize(vN);
        if (uSolid > 0.5){
          gl_FragColor=vec4(mix(vec3(facet(n,uGhost)),uGlow*facet(n,uShade)*.94,uActive),1.0);
          return;
        }
        float d = max(uR - length(vPos.xz), uH - abs(vPos.y));
        float g = exp(-max(d, 0.0) / uLambda);
        float base = 0.800 + 0.070 * max(n.y, 0.0);
        float c = min(base + (1.0 - base) * g, 1.0);
        gl_FragColor=vec4(mix(vec3(facet(n,uGhost)),mix(uGlow*c,mix(uGlow,vec3(1.0),.36),pow(c,6.0)),uActive),1.0);
      }`
  });
}

/* ------------------------------------------------------------- geometry */
const boxGeo   = new THREE.BoxGeometry(1, HT, 1);
const edgeGeo  = new THREE.EdgesGeometry(boxGeo, 1);
const studGeo  = new THREE.CylinderGeometry(SR, SR, SH, 32);
const studEdge = new THREE.EdgesGeometry(studGeo, 25);

function bakeMerge(parts){
  const geos = parts.map(({ geo, m }) => {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone());
    g.applyMatrix4(m);
    return g;
  });
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const hasN = !!geos[0].attributes.normal;
  const nor = hasN ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const g of geos){
    pos.set(g.attributes.position.array, o * 3);
    if (hasN) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (hasN) out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/* a dark brick is body and stud welded into one buffer; the lit brick keeps
   its stud separate because that surface has its own shader */
const STUD_UP = new THREE.Matrix4().makeTranslation(0, HT / 2 + SH / 2, 0);
const BRICK_SOLID = bakeMerge([
  { geo: boxGeo,  m: new THREE.Matrix4() },
  { geo: studGeo, m: STUD_UP }
]);
const BRICK_WIRE = bakeMerge([
  { geo: edgeGeo,  m: new THREE.Matrix4() },
  { geo: studEdge, m: STUD_UP }
]);

// A persistent field of evidence. Only the chosen subset moves into a strategy.
const COUNT=252,COLS=18;
const pool=[],neutral=[],lits=[],roleBlocks=new Map(),labels=[];
const instances=new THREE.InstancedMesh(BRICK_SOLID,ghostMat,COUNT);instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);instances.frustumCulled=false;
const energy=new Float32Array(COUNT),edgePositions=new Float32Array(COUNT*3),edgeQuaternions=new Float32Array(COUNT*4),edgeScales=new Float32Array(COUNT);
instances.geometry.setAttribute('iEnergy',new THREE.InstancedBufferAttribute(energy,1).setUsage(THREE.DynamicDrawUsage));
const edgeInstances=new THREE.InstancedBufferGeometry();edgeInstances.setAttribute('position',BRICK_WIRE.attributes.position.clone());
for(const [name,array,size]of [['iPosition',edgePositions,3],['iQuaternion',edgeQuaternions,4],['iScale',edgeScales,1],['iEnergy',energy,1]])edgeInstances.setAttribute(name,new THREE.InstancedBufferAttribute(array,size).setUsage(THREE.DynamicDrawUsage));edgeInstances.instanceCount=COUNT;
const edges=new THREE.LineSegments(edgeInstances,ghostLineMat);edges.frustumCulled=false;scene.add(instances,edges);
const identity=new THREE.Quaternion(),dummy=new THREE.Object3D();
for(let i=0;i<COUNT;i++){
 const rec={index:i,source:new THREE.Vector3(),home:new THREE.Vector3(),position:new THREE.Vector3(),quaternion:new THREE.Quaternion(),scale:.6,energy:0,slot:-1,order:0,chosen:false};pool.push(rec);neutral.push(rec);
}
for(const role of ROLES){
 const box=new THREE.Mesh(boxGeo,litBoxMat()),stud=new THREE.Mesh(studGeo,litStudMat()),grp=new THREE.Group();stud.position.y=HT/2+SH/2;grp.add(box,stud);scene.add(grp);
 const rec={index:COUNT+role.index,role:role.index,source:new THREE.Vector3(),home:new THREE.Vector3(),position:grp.position,quaternion:grp.quaternion,grp,box,stud,scale:.6,energy:0,slot:-1,order:0,chosen:false};box.userData.brick=rec;pool.push(rec);lits.push(rec);roleBlocks.set(role.index,rec);
 const el=document.createElement('div');el.className='agent-tag';el.innerHTML=`<span>${role.id}</span><span class="tag-name">${role.name}</span>`;labelContainer.append(el);labels.push(el);
}
// Shuffle source seats without clumping selected pieces into a corner.
const sourceOrder=Array.from({length:pool.length},(_,i)=>i).sort((a,b)=>hash(a,7)-hash(b,7));
function layoutSources(){for(let i=0;i<pool.length;i++){
 const r=pool[sourceOrder[i]],col=i%COLS,row=Math.floor(i/COLS),u=(col/(COLS-1)-.5)*frameWidth*1.18,v=(row/(Math.ceil(pool.length/COLS)-1)-.5)*frameHeight*.84;
 r.source.copy(HOME_TARGET).addScaledVector(right,u).addScaledVector(up,v).addScaledVector(HOME_DIR,-4+(hash(i,2)-.5)*4).addScaledVector(right,(hash(i,5)-.5)*.40).addScaledVector(up,(hash(i,6)-.5)*.28);
}}
const moduleSeats=[[-4.2,1.6],[0,3.5],[4.2,1.4],[3.6,-2.5],[-3.6,-2.5],[0,-5.3],[0,0]];
function configure(model){
 for(const r of pool){r.chosen=false;r.slot=-1;r.order=0;}
 const actors=model.config.actors,available=neutral.slice().sort((a,b)=>hash(a.index,model.key.length)-hash(b.index,model.key.length));let next=0;
 actors.forEach((role,slot)=>{
  const [cx,cz]=role===12?[0,-.5]:moduleSeats[slot],layers=model.key==='volatility'?2:model.key==='review'?3:3+(slot%2),cells=[];
  for(let level=0;level<layers;level++)for(let x=0;x<2;x++)for(let z=0;z<2;z++)cells.push([cx+(x-.5)*1.1,level*(HT+SH*.7)*1.1-1.2,cz+(z-.5)*1.1,level]);
  cells.forEach(([x,y,z,level],order)=>{const r=available[next++];r.chosen=true;r.slot=slot;r.order=order;r.level=level;r.home.set(x,y,z);r.delay=2.2+slot*.64+level*.94+(order%4)*.13;r.duration=2.2+hash(r.index,2)*.5;});
  const r=roleBlocks.get(role);r.chosen=true;r.slot=slot;r.level=layers;r.order=cells.length;r.home.set(cx,layers*(HT+SH*.7)*1.1-1.2,cz);r.delay=2.2+slot*.64+layers*.94;r.duration=2.35;
 });
 revision=null;layoutSources();
}
function applyLook(){
 const dark=document.documentElement.dataset.theme==='dark',style=getComputedStyle(document.documentElement),wire=visual.brickStyle==='wire',solid=visual.brickStyle==='solid';
 renderer.setClearColor(0,0);GLOW.value.set(style.getPropertyValue('--field-lead').trim()).convertLinearToSRGB();
 ghostMat.uniforms.uShade.value.fromArray(dark?(solid?[.24,.105,.18,.135]:wire?[.1,.075,.09,.08]:[.31,.13,.215,.165]):(solid?[.91,.64,.77,.84]:wire?[.95,.91,.93,.94]:[.91,.60,.73,.84]));
 ghostLineMat.uniforms.uColor.value.set(dark?'#a9a2b7':'#8b8396').convertLinearToSRGB();ghostLineMat.uniforms.uOpacity.value=solid?0:wire?.42:dark?.38:.24;edges.visible=!solid;SOLID.value=dark?0:1;
 invalidate();
}
function resize(){const r=container.getBoundingClientRect();if(r.width<1||r.height<1)return;renderer.setPixelRatio(Math.min(devicePixelRatio||1,r.width<550?1.5:1.75));renderer.setSize(r.width,r.height,false);const aspect=r.width/r.height;frameHeight=Math.max(16/aspect,Math.min(22,26/aspect));frameWidth=frameHeight*aspect;cam.top=frameHeight/2;cam.bottom=-frameHeight/2;cam.left=-frameWidth/2;cam.right=frameWidth/2;cam.updateProjectionMatrix();layoutSources();invalidate();}
const observer=new ResizeObserver(resize);observer.observe(container);
controls.addEventListener('change',invalidate);controls.addEventListener('start',invalidate);
const ray=new THREE.Raycaster(),ptr=new THREE.Vector2(),ndc=new THREE.Vector3();let down=null;
function onDown(e){if(e.button===0)down={x:e.clientX,y:e.clientY};}
function onUp(e){if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>5){down=null;return;}down=null;const r=cv.getBoundingClientRect();ptr.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(ptr,cam);const hit=ray.intersectObjects(lits.map(r=>r.box),false)[0];if(hit)onSelect?.(hit.object.userData.brick.role,false);}
function onCancel(){down=null;}
cv.addEventListener('pointerdown',onDown);cv.addEventListener('pointerup',onUp);cv.addEventListener('pointercancel',onCancel);
function beginCamera(target,zoom=1){flight={at:performance.now(),from:cam.position.clone(),to:target.clone().addScaledVector(HOME_DIR,DIST),target:controls.target.clone(),toTarget:target.clone(),fromZoom:cam.zoom,zoom};invalidate();}
function flyStep(){if(!flight)return;const t=reducedMotion?1:ease((performance.now()-flight.at)/650);cam.position.lerpVectors(flight.from,flight.to,t);controls.target.lerpVectors(flight.target,flight.toTarget,t);cam.zoom=flight.fromZoom+(flight.zoom-flight.fromZoom)*t;cam.updateProjectionMatrix();if(t===1)flight=null;}
const trailGroup=new THREE.Group();scene.add(trailGroup);const trails=[];
for(let i=0;i<8;i++){const pos=new Float32Array(24*3),colors=new Float32Array(24*3),g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3).setUsage(THREE.DynamicDrawUsage));g.setAttribute('color',new THREE.BufferAttribute(colors,3));const line=new THREE.Line(g,new THREE.LineBasicMaterial({transparent:true,opacity:.22,vertexColors:true,depthWrite:false}));line.frustumCulled=false;trailGroup.add(line);trails.push({line,pos,colors});}
// A lateral, bounded transfer. There is no gravity, falling, impact or explosion.
function transit(r,q,time,out,target=r.home){const u=ease(q);out.lerpVectors(r.source,target,u);const bow=Math.sin(Math.PI*q),side=(hash(r.index,3)-.5)*2;out.addScaledVector(up,bow*(1.35+visual.intensity*.4));out.addScaledVector(right,bow*side);return out;}
const revisionEvents=new Set(),revisionQueue=[];
function commitRevision(){
 if(!revision)return;
 for(const pair of revision.swaps){const a=pair.out,b=pair.into;b.chosen=true;b.slot=a.slot;b.level=a.level;b.order=a.order;b.home.copy(a.home);b.delay=-10;b.duration=1;a.chosen=false;a.slot=-1;a.order=0;}
 revision=null;
}
function startRevision(event,model){
 const slot=Math.max(0,model.config.actors.indexOf(event.to));
 const candidates=neutral.filter(r=>r.chosen&&r.slot===slot&&model.elapsed>=r.delay+r.duration).sort((a,b)=>b.level-a.level||a.order-b.order).slice(0,4);
 const available=neutral.filter(r=>!r.chosen).sort((a,b)=>hash(a.index,event.at)-hash(b.index,event.at));
 revision={at:model.elapsed,slot,id:event.id,kind:event.text.startsWith('手动注入')?'injected':'scheduled',swaps:candidates.map((r,i)=>({out:r,into:available[i]}))};
}
function readRevision(model){
 for(const e of [...model.events].reverse()){
  if(revisionEvents.has(e.id))continue;revisionEvents.add(e.id);
  if(e.from!==null&&(e.at>=12||e.text.startsWith('手动注入'))){const queued=revisionQueue.findIndex(q=>q.to===e.to);if(queued>=0)revisionQueue[queued]=e;else revisionQueue.push(e);}
 }
 const visibleIDs=new Set(model.events.map(e=>e.id));for(const id of revisionEvents)if(!visibleIDs.has(id))revisionEvents.delete(id);
 if(revision&&model.elapsed-revision.at>=4.3)commitRevision();
 if(!revision&&revisionQueue.length&&model.elapsed>=12)startRevision(revisionQueue.shift(),model);
}
function update(model,delta,running){
 if(disposed||contextLost)return;frames++;seconds+=delta;if(seconds>=1){fps=Math.round(frames/seconds);frames=0;seconds=0;}
 if(lastEpoch!==model.epoch||lastScenario!==model.key){configure(model);lastEpoch=model.epoch;lastScenario=model.key;revisionEvents.clear();revisionQueue.length=0;}
 readRevision(model);const time=model.elapsed,active=[],turn=new THREE.Euler();let assembled=0,selectedCount=0;
 for(const r of pool){
  let q=r.chosen?clamp((time-r.delay)/r.duration):0;if(reducedMotion)q=r.chosen?1:0;
  const scan=reducedMotion&&r.chosen?1:r.chosen?smooth((time-r.delay+1.4)/.8):0,baseScale=.52+hash(r.index,4)*.13;
  r.energy=r.chosen?scan*(r.role!==undefined?1:.30+.16*q):0;
  if(r.chosen&&q>0&&q<1)r.energy=Math.min(1,r.energy+.16*visual.pointScale*Math.sin(q*Math.PI));
  if(r.chosen&&scan>.5)selectedCount++;if(r.chosen&&q>=1)assembled++;
  if(r.chosen){transit(r,q,time,r.position);if(q>0&&q<1)active.push({r,q});}
  else r.position.copy(r.source);
  // The unselected pool stays alive, but never turns into falling debris.
  if(q===0&&!reducedMotion){r.position.addScaledVector(up,Math.sin(time*.6+r.index*.71)*.12);r.position.addScaledVector(right,Math.sin(time*.28+r.index*.3)*.10);}
  r.scale=baseScale+(1.08-baseScale)*smooth(q);turn.set(0,(hash(r.index,9)-.5)*.28*(1-smooth(q)),0);r.quaternion.setFromEuler(turn);
  if(revision&&!reducedMotion){
   const age=time-revision.at;
   const pair=revision.swaps.find(p=>p.out===r||p.into===r);
   if(pair){
    const incoming=pair.into===r,q=clamp((age-(incoming?.7:0))/3.2),u=ease(q),bow=Math.sin(q*Math.PI);
    if(incoming){r.position.lerpVectors(r.source,pair.out.home,u);r.position.addScaledVector(up,bow*1.6);r.energy=smooth(age/.5)*(.35+.25*u);r.scale=baseScale+(1.08-baseScale)*u;if(q>0&&q<1)active.push({r,q,target:pair.out.home});}
    else{r.position.lerpVectors(r.home,r.source,u);r.position.addScaledVector(up,bow*1.0);r.energy*=1-u;r.scale=1.08+(baseScale-1.08)*u;}
    r.quaternion.slerp(identity,u);
   }else if(r.role!==undefined&&r.chosen&&r.slot===revision.slot){r.position.addScaledVector(up,Math.sin(clamp(age/4.3)*Math.PI)*.9);}
  }
  // Cycle review reflects unresolved evidence without implying a trade was made.
  if(r.chosen&&time>18&&model.key==='review'&&r.role===12)r.energy*=.55;
  if(r.chosen&&time>18&&model.key==='volatility'&&r.level>0)r.energy*=.55;
  if(visual.focus&&!r.chosen)r.scale*=.66;
  if(r.grp){r.grp.scale.setScalar(r.scale);for(const mesh of [r.box,r.stud])mesh.material.uniforms.uActive.value=r.energy;}
  else {dummy.position.copy(r.position);dummy.quaternion.copy(r.quaternion);dummy.scale.setScalar(r.scale);dummy.updateMatrix();instances.setMatrixAt(r.index,dummy.matrix);energy[r.index]=r.energy;r.position.toArray(edgePositions,r.index*3);r.quaternion.toArray(edgeQuaternions,r.index*4);edgeScales[r.index]=r.scale;}
 }
 instances.instanceMatrix.needsUpdate=true;instances.boundingSphere=null;instances.geometry.attributes.iEnergy.needsUpdate=true;for(const name of ['iPosition','iQuaternion','iScale','iEnergy'])edgeInstances.attributes[name].needsUpdate=true;
 active.sort((a,b)=>b.q-a.q);trailGroup.visible=visual.paths&&!reducedMotion;
 trails.forEach((t,i)=>{const v=active[i];t.line.visible=!!v;if(!v)return;for(let j=0;j<24;j++){const q=Math.max(0,v.q-(1-j/23)*.23);transit(v.r,q,time,dummy.position,v.target).toArray(t.pos,j*3);const c=GLOW.value.clone().multiplyScalar(.3+.7*j/23);c.toArray(t.colors,j*3);}t.line.material.opacity=.28*Math.sin(v.q*Math.PI);t.line.geometry.attributes.position.needsUpdate=true;t.line.geometry.attributes.color.needsUpdate=true;});
 controls.autoRotate=autoRotate&&running&&!reducedMotion&&!flight;controls.autoRotateSpeed=.22;flyStep();controls.update(delta);VIEW.value.subVectors(cam.position,controls.target).normalize();
 const rect=container.getBoundingClientRect(),reserved=[...container.closest('.network-stage').querySelectorAll('.stage-heading,.scene-note,.stage-bottom,.route-caption')].map(el=>el.getBoundingClientRect());
 const placed=[];for(const r of lits.slice().sort((a,b)=>Number(b.role===selected)-Number(a.role===selected))){const el=labels[r.role];ndc.copy(r.position).project(cam);const x=Math.min(rect.width-130,Math.max(10,(ndc.x*.5+.5)*rect.width+14)),y=(-ndc.y*.5+.5)*rect.height-10,box={left:x+rect.left,right:x+rect.left+120,top:y+rect.top,bottom:y+rect.top+20},blocked=[...reserved,...placed].some(a=>box.left<a.right&&box.right>a.left&&box.top<a.bottom&&box.bottom>a.top);el.style.transform=`translate3d(${x}px,${y}px,0)`;el.classList.toggle('selected',r.role===selected);el.style.opacity=visual.labels&&!blocked&&ndc.x>-.9&&ndc.x<.85&&ndc.y>-.85&&ndc.y<.8&&(r.role===selected||r.chosen&&model.status(r.role)==='running')?'1':'0';if(el.style.opacity==='1')placed.push(box);}
 container.dataset.pool=String(pool.length);container.dataset.picked=String(selectedCount);container.dataset.assembled=String(assembled);container.dataset.modules=String(model.config.actors.length);container.dataset.revision=revision?'adjusting':'stable';container.dataset.revisionModule=revision?ROLES[model.config.actors[revision.slot]].id:'';container.dataset.swaps=String(revision?.swaps.length||0);
 renderer.render(scene,cam);
}
const onLost=e=>{e.preventDefault();contextLost=true;document.body.dataset.renderer='webgl-lost';},onRestored=()=>{contextLost=false;document.body.dataset.renderer='webgl';invalidate();};cv.addEventListener('webglcontextlost',onLost);cv.addEventListener('webglcontextrestored',onRestored);
function onDouble(){beginCamera(HOME_TARGET);}
cv.addEventListener('dblclick',onDouble);applyLook();resize();
return{update,restore(){beginCamera(HOME_TARGET);invalidate();},setTheme:applyLook,focus(id,orient=true){selected=id;if(orient){const r=roleBlocks.get(id);if(r)beginCamera(r.position.clone().lerp(HOME_TARGET,.5),1.18);}invalidate();},reset(){beginCamera(HOME_TARGET);},setRotate(v){autoRotate=v;invalidate();},setVisual(v){visual={...visual,...v};applyLook();},zoom(factor){cam.zoom=THREE.MathUtils.clamp(cam.zoom/factor,controls.minZoom,controls.maxZoom);cam.updateProjectionMatrix();invalidate();},resize,get needsRender(){return flight!==null||performance.now()<renderUntil;},get fps(){return fps;},get drawCalls(){return renderer.info.render.calls;},dispose(){disposed=true;observer.disconnect();controls.dispose();cv.removeEventListener('pointerdown',onDown);cv.removeEventListener('pointerup',onUp);cv.removeEventListener('pointercancel',onCancel);cv.removeEventListener('dblclick',onDouble);cv.removeEventListener('webglcontextlost',onLost);cv.removeEventListener('webglcontextrestored',onRestored);const geometries=new Set([boxGeo,edgeGeo,studGeo,studEdge,BRICK_SOLID,BRICK_WIRE]),materials=new Set();scene.traverse(o=>{if(o.isInstancedMesh)o.dispose();if(o.geometry)geometries.add(o.geometry);if(o.material)materials.add(o.material);});for(const g of geometries)g.dispose();for(const m of materials)m.dispose();renderer.dispose();labelContainer.replaceChildren();}};
}
