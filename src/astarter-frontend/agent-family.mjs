import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

// ThreeUI Pro Agent AI source, retrieved 2026-11-02; private project adaptation.
const workerParts=/^(Champagne_face_bezel|Pupil_|Iris_|Outer_machined_rim_|Inset_curved_face_plate|Expression_mouth_cavity|Oval_ceramic_cranial_shell|Sensor_ceramic_cap_|Sensor_champagne_rim_|Rounded_foot_|Hip_ball_joint_|Slender_leg_strut_|Tapered_forearm_shell_|Palm_ceramic_shell_|Shoulder_ceramic_armor_|Thin_upper_arm_|Core_luminous_diffuser|Core_main_gold_bezel|Continuous_pear-shaped_torso|Neck_bearing|Waist_recessed_assembly)/;
const hiddenParts=/Forehead_/i;

// ThreeUI's irisTexture LED pattern, with a neutral ramp so Astarter can tint it.
function irisTexture(){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d'),img=ctx.createImageData(256,256),px=img.data;
  const stops=[[0,255],[.5,245],[.6,227],[.72,202],[.84,150],[.92,70],[1,10]];
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const r=Math.hypot(x+.5-128,y+.5-128)/128;if(r>1)continue;
    let brightness=10;for(let k=1;k<stops.length;k++)if(r<=stops[k][0]){const a=stops[k-1],b=stops[k],t=(r-a[0])/(b[0]-a[0]);brightness=a[1]+(b[1]-a[1])*t;break;}
    const dot=Math.hypot(x%4.5-2,y%4.5-2),grain=dot<1.6?1:dot<2.1?1-(dot-1.6)*.72:.64,o=(y*256+x)*4;
    px[o]=px[o+1]=px[o+2]=brightness*grain;px[o+3]=255;
  }
  ctx.putImageData(img,0,0);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;return texture;
}
export function palette(irisMap){
  const ceramic=new THREE.MeshPhysicalMaterial({color:'#e9e7f0',metalness:.035,roughness:.32,clearcoat:1,clearcoatRoughness:.13});
  const face=ceramic.clone();face.color.set('#f0edf5');face.roughness=.27;
  const trim=new THREE.MeshPhysicalMaterial({color:'#a78bdb',metalness:.88,roughness:.19,clearcoat:.8});trim.userData.tint=true;
  const silver=new THREE.MeshStandardMaterial({color:'#77788b',metalness:.92,roughness:.23});
  const graphite=new THREE.MeshStandardMaterial({color:'#20232d',metalness:.55,roughness:.35});
  const pupil=new THREE.MeshPhysicalMaterial({color:'#040407',metalness:.08,roughness:.045,clearcoat:1,clearcoatRoughness:.035});
  const glass=new THREE.MeshPhysicalMaterial({color:'#eeeaff',metalness:0,roughness:.022,transparent:true,opacity:.035,depthWrite:false,clearcoat:1,clearcoatRoughness:.025,envMapIntensity:1.1});
  const light=new THREE.MeshStandardMaterial({color:'#dccaff',emissive:'#9670e7',emissiveIntensity:.65,metalness:.35,roughness:.3,side:THREE.DoubleSide});light.userData.tint=true;
  const iris=new THREE.MeshStandardMaterial({color:'#13091f',emissive:'#ac74ff',emissiveMap:irisMap||null,emissiveIntensity:2.0,metalness:0,roughness:1,envMapIntensity:0,side:THREE.DoubleSide});iris.userData.tint=true;
  const groupCeramic=ceramic.clone();groupCeramic.userData.tint=true;groupCeramic.metalness=.05;
  return {ceramic,face,trim,silver,graphite,pupil,glass,light,iris,groupCeramic};
}
function materialFor(name,m){
  if(/Optical glass/i.test(name))return m.glass;
  if(/pupil/i.test(name))return m.pupil;
  if(/iris/i.test(name))return m.iris;
  if(/luminous|LED|diffuser/i.test(name))return m.light;
  if(/Champagne|electrum|violet titanium/i.test(name))return m.trim;
  if(/titanium|platinum/i.test(name))return m.silver;
  if(/Face ceramic/i.test(name))return m.face;
  if(/ceramic|frost/i.test(name))return m.ceramic;
  return m.graphite;
}

// Vertex clustering removes subpixel tessellation once, preserving joint hierarchy.
export function lightweightGeometry(source){
  const pos=source.attributes.position,box=new THREE.Box3().setFromBufferAttribute(pos),size=box.getSize(new THREE.Vector3());
  const cell=Math.max(size.x,size.y,size.z)/12,map=new Map(),indices=new Uint32Array(pos.count),vertices=[],counts=[],uvs=[],normals=[],uv=source.attributes.uv,normal=source.attributes.normal;
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),key=[x,y,z].map(v=>Math.round(v/(cell||1))).join(',');
    let id=map.get(key);if(id===undefined){id=vertices.length/3;map.set(key,id);vertices.push(0,0,0);counts.push(0);uvs.push(0,0);normals.push(0,0,0);}
    indices[i]=id;vertices[id*3]+=x;vertices[id*3+1]+=y;vertices[id*3+2]+=z;counts[id]++;
    if(uv){uvs[id*2]+=uv.getX(i);uvs[id*2+1]+=uv.getY(i);}
    if(normal){normals[id*3]+=normal.getX(i);normals[id*3+1]+=normal.getY(i);normals[id*3+2]+=normal.getZ(i);}
  }
  for(let i=0;i<counts.length;i++)for(let k=0;k<3;k++)vertices[i*3+k]/=counts[i];
  const faces=[],seen=new Set(),index=source.index,count=index?.count||pos.count;
  for(let i=0;i<count;i+=3){const a=indices[index?index.getX(i):i],b=indices[index?index.getX(i+1):i+1],c=indices[index?index.getX(i+2):i+2];if(a===b||b===c||a===c)continue;const key=[a,b,c].sort((x,y)=>x-y).join(',');if(seen.has(key))continue;seen.add(key);faces.push(a,b,c);}
  // Thin bezels must not collapse into an empty mesh; keep their original outline.
  if(faces.length<6)return source.clone();
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(faces);
  if(uv){for(let i=0;i<counts.length;i++){uvs[i*2]/=counts[i];uvs[i*2+1]/=counts[i];}geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));}
  if(normal){geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.normalizeNormals();}else geometry.computeVertexNormals();
  geometry.computeBoundingSphere();return geometry;
}

export async function loadAgentFamily(){
  const loader=new GLTFLoader();
  const source=await loader.loadAsync(new URL('./assets/agent-family.glb',import.meta.url).href);
  return prepareAgentFamily(source.scene,irisTexture());
}
export function prepareAgentFamily(source,irisMap){
  const prototype=source.getObjectByName('ROBOT_MASTER');
  if(!prototype)throw new Error('Agent model missing');
  const materials=palette(irisMap),lightMaterials=palette();
  lightMaterials.iris.dispose();lightMaterials.iris=new THREE.MeshBasicMaterial({color:'#ffffff',map:irisMap||null,side:THREE.DoubleSide,toneMapped:false});lightMaterials.iris.userData.tint=true;
  for(const m of Object.values(lightMaterials))if(m.userData.tint)m.color.set('#ffffff');
  const reduced=new Map(),rigs=[],owned=new Set(),sourceMaterials=new Set();
  source.traverse(o=>{if(o.geometry)owned.add(o.geometry);if(o.material)for(const m of [].concat(o.material))sourceMaterials.add(m);});
  function createRig(light=false){
    const model=prototype.clone(true);model.position.set(0,-.105,0);model.rotation.set(0,0,0);model.scale.setScalar(1);
    const remove=[];model.traverse(o=>{
      if(!o.isMesh)return;
      if(hiddenParts.test(o.name)||(light&&!workerParts.test(o.name))){remove.push(o);return;}
      o.material=materialFor(o.material.name,light?lightMaterials:materials);
      if(light&&/^(Continuous_pear-shaped_torso|Shoulder_ceramic_armor_|Sensor_ceramic_cap_|Rounded_foot_)/.test(o.name))o.material=lightMaterials.groupCeramic;
      if(light){if(!reduced.has(o.geometry)){const simplified=lightweightGeometry(o.geometry);reduced.set(o.geometry,simplified);owned.add(simplified);}o.geometry=reduced.get(o.geometry);}
      o.castShadow=false;o.receiveShadow=false;
    });remove.forEach(o=>o.removeFromParent());
    const root=new THREE.Group();root.add(model);const joints={};
    for(const name of ['Head','Torso','Gaze_L','Gaze_R','Eye_L','Eye_R','Shoulder_L','Shoulder_R','Elbow_L','Elbow_R','Wrist_L','Wrist_R','Hip_L','Hip_R']){const node=model.getObjectByName(name);if(node){joints[name]=node;node.userData.restPosition=node.position.clone();node.userData.restQuaternion=node.quaternion.clone();node.userData.restScale=node.scale.clone();}}
    const meshes=[];model.traverse(o=>{if(o.isMesh)meshes.push(o);});
    const rig={root,model,joints,meshes,height:2.652};rigs.push(rig);return rig;
  }
  function ornament(name){const src=source.getObjectByName(name);if(!src)return null;const group=src.clone(true);group.position.set(0,0,0);group.traverse(o=>{if(o.isMesh){o.material=materialFor(o.material.name,materials);if(!reduced.has(o.geometry)){const simplified=lightweightGeometry(o.geometry);reduced.set(o.geometry,simplified);owned.add(simplified);}o.geometry=reduced.get(o.geometry);}});return group;}
  return {materials,lightMaterials,createRig,ornament,dispose(){for(const g of owned)g.dispose();for(const m of new Set([...sourceMaterials,...Object.values(materials),...Object.values(lightMaterials)]))m.dispose();irisMap?.dispose();rigs.length=0;}};
}

const rotation=new THREE.Euler(),quaternion=new THREE.Quaternion();
export function poseRig(rig,pose){
  rig.model.rotation.set(0,pose.yaw,pose.roll);
  const turn=(name,x=0,y=0,z=0)=>{const n=rig.joints[name];if(!n)return;rotation.set(x,y,z);quaternion.setFromEuler(rotation);n.quaternion.copy(n.userData.restQuaternion).multiply(quaternion);};
  turn('Head',pose.headPitch,pose.headYaw,pose.roll*.3);
  turn('Shoulder_L',pose.leftArm,0,pose.leftArmRoll);turn('Shoulder_R',pose.rightArm,0,pose.rightArmRoll);
  turn('Elbow_L',pose.leftElbow);turn('Elbow_R',pose.rightElbow);
  turn('Hip_L',pose.leftLeg);turn('Hip_R',pose.rightLeg);
  for(const side of ['L','R']){const gaze=rig.joints['Gaze_'+side],eye=rig.joints['Eye_'+side];if(gaze){gaze.position.copy(gaze.userData.restPosition);gaze.position.x+=pose.lookX;gaze.position.y+=pose.lookY;}if(eye){eye.scale.copy(eye.userData.restScale);eye.scale.y*=.76+.24*pose.squint;}}
  rig.root.updateMatrixWorld(true);
}
