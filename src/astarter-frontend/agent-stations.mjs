import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {meetingCenters,sceneMarket} from './coordination.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {CRYSTAL_OPTICS} from './crystal-character.mjs';

export function createStationMaterials(base,color){
  const tint=new THREE.Color(color),white=new THREE.Color('#ffffff');
  const ceramic=base.ceramic.clone();ceramic.setValues({...CRYSTAL_OPTICS,metalness:.025,clearcoat:1,clearcoatRoughness:.04,transparent:true,depthWrite:false,attenuationColor:white,attenuationDistance:26,thickness:3.4,iridescence:.2});
  const graphite=ceramic.clone();graphite.roughness=.16;graphite.thickness=1.4;graphite.transmission=.2;graphite.transparent=false;graphite.opacity=1;graphite.depthWrite=true;
  const silver=base.silver.clone();silver.metalness=.28;silver.roughness=.17;silver.clearcoat=1;
  const trim=base.trim.clone(),edge=new THREE.LineBasicMaterial({transparent:true,opacity:.85,toneMapped:false});
  const glow={ink:{value:tint.clone()},strength:{value:.72}};
  function theme(dark){
    ceramic.color.set(dark?'#4c677b':'#b4cbd9').lerp(tint,dark?.22:.2);
    ceramic.emissive.copy(tint);ceramic.emissiveIntensity=dark?.035:.008;
    // Alpha also reveals the separate beam canvas beneath the equipment layer.
    ceramic.opacity=dark?.55:.66;ceramic.transmission=dark?.52:.22;ceramic.envMapIntensity=dark?.82:.65;
    graphite.color.set(dark?'#293b49':'#bccedb').lerp(tint,.12);graphite.envMapIntensity=dark?.65:.5;
    silver.color.set(dark?'#a2b9cc':'#edf5fb').lerp(tint,.08);
    trim.color.copy(tint).multiplyScalar(dark?1.7:1);
    edge.color.copy(tint).multiplyScalar(dark?1.3:.72);edge.opacity=dark?.74:.85;
    glow.ink.value.copy(tint).multiplyScalar(dark?1.2:.65);glow.strength.value=dark?.7:.42;
  }
  theme(true);
  return {materials:{ceramic,graphite,silver,trim},edge,glow,theme,dispose(){for(const material of [ceramic,graphite,silver,trim,edge])material.dispose();}};
}

export function createStations(family){
  const root=new THREE.Group(),geometries=new Map(),textures=[],surfaces=[],groups=[],parts=[],palettes=[];
  let theme=null;
  const stationOf=parent=>{for(let p=parent;p;p=p.parent)if(Number.isInteger(p.userData.station))return palettes[p.userData.station];return null;};
  const box=(w,h,d,r=2)=>{const key=[w,h,d,r].join();if(!geometries.has(key))geometries.set(key,new RoundedBoxGeometry(w,h,d,2,r));return geometries.get(key);};
  const mesh=(parent,g,mat,x=0,y=0,z=0)=>{const o=new THREE.Mesh(g,mat);o.position.set(x,y,z);parent.add(o);
    const palette=stationOf(parent);if(palette&&[palette.materials.ceramic,palette.materials.silver].includes(mat)){const key='rim-'+g.uuid;if(!geometries.has(key))geometries.set(key,new THREE.EdgesGeometry(g,32));o.add(new THREE.LineSegments(geometries.get(key),palette.edge));}return o;};
  const cube=(parent,w,h,d,mat,x=0,y=0,z=0,r=2)=>mesh(parent,box(w,h,d,r),mat,x,y,z);
  function glow(parent,w,h,x=0,y=0,z=-4,oval=false){
    const palette=stationOf(parent);if(!palette)return;
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide,
      uniforms:{...palette.glow,size:{value:new THREE.Vector2(w/2,h/2)},extent:{value:new THREE.Vector2(w+20,h+20)},oval:{value:oval?1:0}},
      vertexShader:'varying vec2 uvv;void main(){uvv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:'varying vec2 uvv;uniform vec2 size,extent;uniform vec3 ink;uniform float strength,oval;void main(){vec2 p=(uvv-.5)*extent;vec2 q=abs(p)-size+vec2(4.);float rect=length(max(q,0.))+min(max(q.x,q.y),0.)-4.;float ellipse=(length(p/size)-1.)*min(size.x,size.y);float d=mix(rect,ellipse,oval);float core=exp(-pow(d/.55,2.));float wash=exp(-abs(d)/2.4);float alpha=(core*.7+wash*.28)*strength;gl_FragColor=vec4(mix(ink,vec3(1.),core*.48),alpha);\n#include <colorspace_fragment>\n}'});
    surfaces.push(material);const geometry=new THREE.PlaneGeometry(w+20,h+20);geometries.set('glow-'+geometries.size,geometry);return mesh(parent,geometry,material,x,y,z);
  }
  function screen(parent,w,h,x,y){
    const m=stationOf(parent)?.materials||family.materials;
    const canvas=document.createElement('canvas');canvas.width=480;canvas.height=300;
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;textures.push(texture);
    const material=new THREE.MeshBasicMaterial({map:texture,toneMapped:false});surfaces.push(material);
    cube(parent,w+7,h+7,7,family.crystal?m.ceramic:m.silver,x,y,0,3);cube(parent,w+4,h+4,7,m.graphite,x,y,2,2);
    glow(parent,w+7,h+7,x,y,-4);
    const edge=family.crystal?m.trim:new THREE.MeshBasicMaterial({color:parent.userData.color,toneMapped:false});if(!family.crystal)surfaces.push(edge);cube(parent,w*.34,.65,.6,edge,x-w*.24,y+h*.5+2,6,.2);
    mesh(parent,box(w,h,.3,1),material,x,y,6);return {canvas,texture,last:'',width:w,height:h};
  }
  for(let i=0;i<6;i++){
    const group=new THREE.Group();group.userData.color=RESEARCH_GROUPS[i].color;group.userData.station=i;root.add(group);groups.push(group);const data={};parts.push(data);
    const palette=family.crystal?createStationMaterials(family.materials,group.userData.color):null;palettes.push(palette);const m=palette?.materials||family.materials;
    const accent=family.crystal?m.trim:m.trim.clone();if(!family.crystal){accent.color.set(RESEARCH_GROUPS[i].color).multiplyScalar(1.5);surfaces.push(accent);}
    if(i===0){
      cube(group,42,69,20,m.ceramic,-7,38,-2,5);cube(group,36,61,3,m.graphite,-7,38,10,3);
      glow(group,43,70,-7,38,-13);
      data.drawers=[17,37,57].map(y=>{const d=cube(group,31,16,4,family.crystal?m.ceramic:m.silver,-7,y,13,1.5);cube(d,21,2,1,m.graphite,0,2,3,.5);cube(d,4,2,1,accent,-10,-4,3,.5);return d;});
      data.screen=screen(group,22,27,28,52);cube(group,25,6,15,m.ceramic,28,23,3,2);
    }else if(i===1){
      const network=family.ornament('NETWORK_MASTER');
      if(network){const bounds=new THREE.Box3().setFromObject(network),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());network.position.sub(center);const wrap=new THREE.Group();wrap.add(network);wrap.scale.setScalar(35/Math.max(size.x,size.y,size.z));wrap.position.set(0,-5,-12);group.add(wrap);data.ornament=wrap;}
    }else if(i===2){
      data.screen=screen(group,71,43,0,40);cube(group,7,17,6,m.silver,0,9,-1,1);cube(group,31,4,19,m.graphite,0,0,1,2);
      const keyboard=cube(group,65,4,22,family.crystal?m.ceramic:m.silver,0,-10,16,2);keyboard.rotation.x=.55;
      const keys=cube(keyboard,59,1,17,m.graphite,0,2,0,1);
      for(let k=0;k<4;k++)cube(keys,51,1,.7,m.silver,0,1,-6+k*4,.2);
      cube(group,10,5,15,m.ceramic,42,-11,17,3);
    }else if(i===3){
      data.screen=screen(group,132,75,3.5,42);cube(group,5,19,6,m.silver,-37,-9,-2,1);cube(group,5,19,6,m.silver,37,-9,-2,1);
      cube(group,18,3,17,m.graphite,-37,-19,1,1);cube(group,18,3,17,m.graphite,37,-19,1,1);
    }else{
      const top=family.crystal?new THREE.LatheGeometry([[0,-2.5],[43.5,-2.5],[45,-1],[45,1],[43.5,2.5],[0,2.5]].map(([x,y])=>new THREE.Vector2(x,y)),48):new THREE.CylinderGeometry(45,45,5,48);geometries.set('table'+i,top);
      const desk=mesh(group,top,m.ceramic);desk.rotation.x=.9;desk.scale.set(1.3,1,.65);
      if(family.crystal){
        const rimGeometry=new THREE.TorusGeometry(45,.45,6,64);geometries.set('table-rim'+i,rimGeometry);
        const rim=new THREE.Group();rim.rotation.x=.9;rim.scale.set(1.3,1,.65);group.add(rim);
        const edge=mesh(rim,rimGeometry,accent,0,2.6,0);edge.rotation.x=Math.PI/2;
        const wash=glow(rim,90,90,0,2.4,0,true);wash.rotation.x=-Math.PI/2;
      }else{const edge=mesh(group,top,accent,0,-2,-.3);edge.rotation.copy(desk.rotation);edge.scale.set(1.31,.4,.66);}
      cube(group,5,23,5,family.crystal?m.silver:m.graphite,-40,-13,-2,1);cube(group,5,23,5,family.crystal?m.silver:m.graphite,40,-13,-2,1);
      const tablet=cube(group,24,2,17,m.graphite,12,7,5,2);tablet.rotation.x=.8;
      cube(tablet,19,.8,11,accent,0,1.2,0,1);
      if(i===4){const creation=family.ornament('CREATION_MASTER');if(creation){const bounds=new THREE.Box3().setFromObject(creation),center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());creation.position.sub(center);const wrap=new THREE.Group();wrap.add(creation);wrap.scale.setScalar(16/Math.max(size.x,size.y,size.z));wrap.position.set(-20,11,5);group.add(wrap);}}
      else{const shape=new THREE.Shape();shape.moveTo(-8,9);shape.lineTo(0,12);shape.lineTo(8,9);shape.lineTo(7,-2);shape.quadraticCurveTo(4,-8,0,-10);shape.quadraticCurveTo(-4,-8,-7,-2);shape.closePath();const shield=new THREE.ExtrudeGeometry(shape,{depth:2,bevelEnabled:true,bevelSize:1,bevelThickness:1,bevelSegments:2,steps:1});geometries.set('shield',shield);mesh(group,shield,accent,-20,12,8);}
    }
  }
  function paint(panel,i,q,checks,working,color,dark){
    const key=[Math.floor(q*80),checks,working,dark].join();if(key===panel.last)return;panel.last=key;
    const ctx=panel.canvas.getContext('2d'),w=480,h=300;ctx.fillStyle=dark?'#090e13':'#e0eaf1';ctx.fillRect(0,0,w,h);
    ctx.fillStyle=dark?'#1b252e':'#b9cdda';ctx.fillRect(0,0,w,28);ctx.fillStyle=color;ctx.fillRect(18,12,52,4);
    ctx.fillStyle='#607085';for(let k=0;k<3;k++)ctx.fillRect(403+k*21,12,10,4);
    if(i===3){
      ctx.lineWidth=1;ctx.strokeStyle=dark?'#30384a':'#ced9e1';for(let k=1;k<5;k++){ctx.beginPath();ctx.moveTo(20,42+k*42);ctx.lineTo(460,42+k*42);ctx.stroke();}
      const ink=dark?color:'#3474ad',data=sceneMarket(q).points;ctx.strokeStyle=ink;ctx.lineWidth=5;ctx.beginPath();data.forEach(([x,y],n)=>{const px=(x+62.5)/132*w,py=(y+79.5)/75*h;n?ctx.lineTo(px,py):ctx.moveTo(px,py);});ctx.shadowColor=color;ctx.shadowBlur=dark?9:0;ctx.stroke();ctx.shadowBlur=0;
      for(let k=0;k<22;k++){const value=12+(Math.sin(k*1.71+q*6)+1)*16;ctx.fillStyle=k%3?ink:'#66708a';ctx.globalAlpha=.5;ctx.fillRect(24+k*20,282-value,8,value);}ctx.globalAlpha=1;
      const at=Math.min(data.length-1,Math.floor(q*data.length)),[x,y]=data[at];ctx.fillStyle=dark?'#f3eaff':'#244f78';ctx.beginPath();ctx.arc((x+62.5)/132*w,(y+79.5)/75*h,7,0,Math.PI*2);ctx.fill();
    }else{
      for(let row=0;row<(i===2?3:4);row++){
        const y=68+row*(i===2?68:53),done=i===2?checks>row:q>=.38&&(row<Math.floor(q/.38*4));
        ctx.fillStyle=dark?(done?'#223b40':'#212938'):(done?'#d4e6e2':'#dce4eb');ctx.fillRect(17,y-17,445,40);
        ctx.strokeStyle=done?(dark?'#67d0ba':'#237d69'):'#63728b';ctx.lineWidth=4;ctx.beginPath();if(done){ctx.moveTo(33,y);ctx.lineTo(39,y+6);ctx.lineTo(51,y-8);}else{ctx.arc(42,y,7,0,Math.PI*2);}ctx.stroke();
        ctx.fillStyle=dark?'#8195a7':'#526b80';ctx.fillRect(74,y-7,100,5);ctx.fillStyle=done?['#58efba','#6fe3ff','#b68bff','#ff9a67'][row]:dark?'#3e4d64':'#a4b6c4';ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=done&&dark?8:0;ctx.fillRect(220,y-8,Math.min(198,30+q*140+row*12),12);ctx.shadowBlur=0;
      }
      if(working){ctx.fillStyle='#cdbaff';ctx.fillRect(74+(q*323)%210,278,17,3);}
    }
    panel.texture.needsUpdate=true;
  }
  return {root,update({geometry,poses,deviceFrames,time,reduced,dark}){
    if(theme!==dark){theme=dark;palettes.forEach(palette=>palette?.theme(dark));}
    const centers=meetingCenters({width:geometry.cr.width,height:geometry.cr.height,core:geometry.core,mobile:geometry.mobile}),scale=geometry.mobile?.66:.90;
    for(let i=0;i<6;i++){
      const center=centers[i];groups[i].position.set(center.x,-center.y-17,-35);groups[i].scale.setScalar(scale);
      const working=poses.find(p=>p.job?.station===i&&p.work),frame=deviceFrames.get(i)||{q:0};
      if(parts[i].screen)paint(parts[i].screen,i,frame.q,frame.checks||0,Boolean(working),RESEARCH_GROUPS[i].color,dark);
      parts[i].drawers?.forEach((d,j)=>{d.position.x=-7-(!reduced&&working?.work?.action==='retrieve'&&j===1?Math.sin(Math.min(1,frame.q/.38)*Math.PI)*11:0);});
      if(parts[i].ornament)parts[i].ornament.rotation.y=working&&!reduced?Math.sin(time*.8)*.2:0;
    }
  },dispose(){for(const g of geometries.values())g.dispose();for(const t of textures)t.dispose();for(const m of surfaces)m.dispose();palettes.forEach(palette=>palette?.dispose());root.removeFromParent();}};
}
