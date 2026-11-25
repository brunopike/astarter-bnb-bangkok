import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {loadAgentFamily,poseRig} from './agent-family.mjs';
import {workerPose,corePose} from './agent-poses.mjs';
import {createStations} from './agent-stations.mjs';
import {createCrystalFamily,createCrystalEnvironment} from './crystal-character.mjs';

export function createAgentFloor(layer,onChange=()=>{},{crystal=true}={}){
  let renderer;try{renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'high-performance'});}catch{return null;}
  renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  const canvas=renderer.domElement;canvas.className='agent-material-canvas';canvas.setAttribute('aria-hidden','true');layer.prepend(canvas);
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,1,0,-1,.1,4000);camera.position.z=1200;
  const ambient=new THREE.HemisphereLight('#f4f1ff','#31313f',.85),key=new THREE.DirectionalLight('#fff5ed',3.8),rim=new THREE.DirectionalLight('#a58ade',2.5);
  key.position.set(-250,500,700);rim.position.set(400,220,-100);scene.add(ambient,key,rim);
  let env;if(crystal){env=createCrystalEnvironment(renderer);}else{const environment=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer);env=pmrem.fromScene(environment,.04);environment.dispose();pmrem.dispose();}scene.environment=env.texture;scene.environmentIntensity=1;
  let lightEnv=null,family=null,core=null,workers=[],instances=[],stations=null,disposed=false,failedContext=false,ready=false,lastSize='',theme='',grip=null;
  const workerHands=new Map(),tint=new THREE.Color(),white=new THREE.Color('#ffffff');
  const point=new THREE.Vector3(),other=new THREE.Vector3(),zero=new THREE.Matrix4().makeScale(0,0,0),shadowTransform=new THREE.Object3D();
  const shadowGeometry=new THREE.PlaneGeometry(1,1),shadowMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{opacity:{value:.25}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',fragmentShader:'varying vec2 vUv;uniform float opacity;void main(){float d=length((vUv-.5)*2.);gl_FragColor=vec4(.09,.07,.15,(1.-smoothstep(.12,1.,d))*opacity);}' });
  const shadows=new THREE.InstancedMesh(shadowGeometry,shadowMaterial,19);shadows.frustumCulled=false;scene.add(shadows);
  const failed=()=>{if(disposed)return;failedContext=true;ready=false;layer.classList.remove('agent-material-ready');layer.dataset.agentMaterial='fallback';canvas.hidden=true;onChange();};
  const lost=event=>{event.preventDefault();failed();};canvas.addEventListener('webglcontextlost',lost);
  layer.dataset.agentMaterial='loading';
  const loading=(crystal?Promise.resolve(createCrystalFamily()):loadAgentFamily()).then(value=>{
    if(disposed||failedContext){value.dispose();return;}
    family=value;if(!crystal){core=family.createRig();scene.add(core.root);}
    workers=Array.from({length:18},()=>family.createRig(true));
    instances=workers[0].meshes.map(mesh=>{const item=new THREE.InstancedMesh(mesh.geometry,mesh.material,18);item.frustumCulled=false;item.renderOrder=mesh.renderOrder;item.instanceMatrix.setUsage(THREE.DynamicDrawUsage);scene.add(item);return item;});
    stations=createStations(family);scene.add(stations.root);ready=true;onChange();
  }).catch(failed);
  function update(frame){
    if(disposed||!ready||layer.hidden)return;
    const {geometry,poses,reaction,time,reduced,deviceFrames}=frame,{width,height,mobile}=geometry;
    const size=width+':'+height+':'+mobile;if(size!==lastSize){lastSize=size;renderer.setPixelRatio(Math.min(devicePixelRatio||1,mobile?1.4:1.6));renderer.setSize(width,height,false);camera.right=width;camera.bottom=-height;camera.updateProjectionMatrix();}
    const dark=document.documentElement.dataset.theme==='dark';if(theme!==dark){theme=dark;if(crystal){if(!dark&&!lightEnv)lightEnv=createCrystalEnvironment(renderer,true);scene.environment=(dark?env:lightEnv).texture;}renderer.toneMappingExposure=dark?1.05:1.02;ambient.intensity=crystal?.7:dark?1.05:.85;key.intensity=crystal?2.2:3.8;rim.intensity=crystal?1.8:2.5;shadowMaterial.uniforms.opacity.value=dark?.4:.12;family.theme?.(dark);}
    const coreHeight=mobile?111:Math.min(152,Math.max(128,geometry.cr.height*.51));
    if(core){const cp=corePose(reaction,time,reduced);core.root.scale.setScalar(coreHeight/core.height);core.root.position.set(geometry.core.x,-geometry.core.y-coreHeight*.5+cp.bob,40);poseRig(core,cp);
      const l=core.joints.Wrist_L,r=core.joints.Wrist_R;
      if(l&&r){l.getWorldPosition(point);r.getWorldPosition(other);point.add(other).multiplyScalar(.5);grip={x:point.x,y:-point.y};}}
    const setShadow=(id,x,y,w)=>{shadowTransform.position.set(x,-y,-75);shadowTransform.scale.set(w,w*.24,1);shadowTransform.updateMatrix();shadows.setMatrixAt(id,shadowTransform.matrix);};
    if(core)setShadow(18,geometry.core.x,geometry.core.y+coreHeight*.5+3,coreHeight*.8);else shadows.setMatrixAt(18,zero);
    for(let id=0;id<18;id++){
      const state=poses.find(p=>p.id===id),rig=workers[id];
      if(!state){for(const batch of instances)batch.setMatrixAt(id,zero);shadows.setMatrixAt(id,zero);continue;}
      const pose=workerPose(state,time,reduced),size=mobile?35:state.leader?50:44;
      const x=Math.max(size*.43,Math.min(width-size*.43,state.point.x));
      rig.root.scale.setScalar(size/rig.height);rig.root.position.set(x,-state.point.y-size*.5+pose.bob,65+state.point.y*.01);(family.pose||poseRig)(rig,pose);
      const handPositions=['Wrist_L','Wrist_R'].map(name=>{rig.joints[name].getWorldPosition(point);return {x:point.x,y:-point.y};});workerHands.set(id,handPositions);
      for(let j=0;j<instances.length;j++){instances[j].setMatrixAt(id,rig.meshes[j].matrixWorld);const kind=instances[j].material.userData.tint;if(kind){tint.set(state.color);if(kind==='glass')tint.lerp(white,dark?.24:.3);instances[j].setColorAt(id,tint);}}
      setShadow(id,state.point.x,state.point.y+size*.5+2,size*.9);
    }
    for(const batch of instances){batch.instanceMatrix.needsUpdate=true;if(batch.instanceColor)batch.instanceColor.needsUpdate=true;}shadows.instanceMatrix.needsUpdate=true;
    stations.update({geometry,poses,deviceFrames,time,reduced,dark});
    renderer.render(scene,camera);layer.classList.add('agent-material-ready');layer.dataset.agentMaterial='ready';
    layer.dataset.materialCalls=String(renderer.info.render.calls);layer.dataset.materialTriangles=String(renderer.info.render.triangles);
    layer.dataset.materialFrame=time.toFixed(3);layer.dataset.materialCoreAction=reaction?.action||'observe';
  }
  return {update,hand(id,toward){const hands=ready&&workerHands.get(id);if(!hands)return null;return toward?hands.reduce((a,b)=>Math.abs(a.x-toward.x)<Math.abs(b.x-toward.x)?a:b):hands[1];},get ready(){return ready;},get coreReady(){return ready&&Boolean(core);},get coreGrip(){return ready?grip:null;},get loading(){return loading;},dispose(){if(disposed)return;disposed=true;ready=false;layer.classList.remove('agent-material-ready');canvas.removeEventListener('webglcontextlost',lost);stations?.dispose();family?.dispose();for(const batch of instances)batch.dispose();shadows.dispose();shadowGeometry.dispose();shadowMaterial.dispose();env.dispose();lightEnv?.dispose();scene.clear();renderer.dispose();renderer.forceContextLoss();canvas.remove();}};
}
