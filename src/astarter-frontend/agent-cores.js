import * as THREE from 'three';

const vertex = `
  attribute vec3 coreColor;
  attribute vec4 coreState;
  attribute float coreKind;
  attribute float coreOffset;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec4 vState;
  varying float vKind;
  varying float vOffset;
  void main() {
    vUv=uv; vColor=coreColor; vState=coreState; vKind=coreKind; vOffset=coreOffset;
    vec4 center=modelViewMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0);
    float size=length(instanceMatrix[0].xyz);
    center.xy+=position.xy*size;
    gl_Position=projectionMatrix*center;
  }`;

const fragment = `
  uniform float uTime;
  uniform vec3 uAccent;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec4 vState;
  varying float vKind;
  varying float vOffset;
  const float TAU=6.2831853;
  float line(float d,float width){return 1.0-smoothstep(width,width+.014,abs(d));}
  float edge(vec2 p,vec2 a,vec2 b){vec2 v=b-a;return length(p-a-v*clamp(dot(p-a,v)/dot(v,v),0.0,1.0));}
  mat2 turn(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
  void main(){
    vec2 p=(vUv-.5)*2.0;
    float r=length(p),a=atan(p.y,p.x)/TAU+.5;
    if(r>.99)discard;
    float t=uTime*(.12+vState.x*.13)+vOffset;
    float ring=line(r-.65,.012)*step(.15,fract(a*6.0-t));
    ring+=line(r-.84,.008)*step(.42,fract(a*3.0+t*.65));
    ring*=max(vState.z*.45,vState.x*.18);
    float ticks=0.0;
    float sweep=line(r-.49,.009)*pow(max(0.0,cos((a-t)*TAU)),12.0)*vState.x;
    vec2 q=turn(-t*2.0)*p;
    float glyph=0.0;
    if(vKind<.5){
      glyph=line(r-.27,.009)+line(r-.13,.009);
      glyph+=max(line(p.x,.008)*step(abs(p.y),.35),line(p.y,.008)*step(abs(p.x),.35));
      glyph+=line(q.y,.014)*step(0.0,q.x)*step(q.x,.36);
    }else if(vKind<1.5){
      glyph=line(max(abs(q.x)*.866025+abs(q.y)*.5,abs(q.y))-.29,.012);
      glyph+=line(edge(q,vec2(-.25,-.145),vec2(.25,.145)),.008);
      glyph+=line(edge(q,vec2(-.25,.145),vec2(.25,-.145)),.008);
    }else if(vKind<2.5){
      glyph=line(edge(p,vec2(-.27,.23),vec2(.27,.23)),.013);
      glyph+=line(edge(p,vec2(-.27,.23),vec2(-.23,-.12)),.013);
      glyph+=line(edge(p,vec2(.27,.23),vec2(.23,-.12)),.013);
      glyph+=line(edge(p,vec2(-.23,-.12),vec2(0.0,-.34)),.013);
      glyph+=line(edge(p,vec2(.23,-.12),vec2(0.0,-.34)),.013);
      glyph+=line(p.x,.009)*step(abs(p.y),.15);
    }else{
      glyph=line(abs(p.x)+abs(p.y)-.28,.014);
      glyph+=line(abs(p.x)+abs(p.y+.13)-.28,.009)*step(p.y,-.10);
      glyph+=line(abs(p.x)+abs(p.y+.26)-.28,.009)*step(p.y,-.23);
    }
    float signal=vState.y;
    float pulse=line(r-(.38+signal*.55),.014)*sin(signal*3.14159);
    float brackets=0.0;
    float halo=exp(-r*r*7.0)*.025;
    float alpha=clamp(ring*.76+ticks*.7+sweep+glyph*.85+pulse*1.4+brackets+halo,0.0,1.0)*vState.w;
    vec3 color=mix(vColor,uAccent,min(.35,vState.x*.22+vState.z*.30));
    gl_FragColor=vec4(color,alpha);
    #include <colorspace_fragment>
  }`;

// All 18 cores share five instanced draws; ring detail is drawn in the shader.
export function createAgentCores(positions, roles, palette, reducedMotion, appearance) {
  const count=roles.length, group=new THREE.Group(), dummy=new THREE.Object3D();
  const states=new Float32Array(count*4), colors=new Float32Array(count*3);
  const kinds=new Float32Array(count), offsets=new Float32Array(count);
  const geometry=new THREE.PlaneGeometry(1,1);
  geometry.setAttribute('coreState',new THREE.InstancedBufferAttribute(states,4).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('coreColor',new THREE.InstancedBufferAttribute(colors,3));
  geometry.setAttribute('coreKind',new THREE.InstancedBufferAttribute(kinds,1));
  geometry.setAttribute('coreOffset',new THREE.InstancedBufferAttribute(offsets,1));
  const material=new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,uniforms:{uTime:{value:0},uAccent:{value:appearance.lead}},transparent:true,depthWrite:false,depthTest:false,blending:THREE.NormalBlending});
  const faces=new THREE.InstancedMesh(geometry,material,count);
  const crystal=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.045),new THREE.MeshBasicMaterial({transparent:true,opacity:.55,blending:THREE.NormalBlending,depthWrite:false}),count);
  const cage=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.083),new THREE.MeshBasicMaterial({transparent:true,opacity:.38,wireframe:true,blending:THREE.NormalBlending,depthWrite:false}),count);
  const gyros=new THREE.InstancedMesh(new THREE.TorusGeometry(.125,.0024,3,32,Math.PI*1.42),new THREE.MeshBasicMaterial({transparent:true,opacity:.18,blending:THREE.NormalBlending,depthWrite:false}),count*2);
  const pickBody=new THREE.InstancedMesh(new THREE.SphereGeometry(.18,8,6),new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false}),count);
  for(const mesh of [faces,crystal,cage,gyros,pickBody]){mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);group.add(mesh);}
  const color=new THREE.Color();
  for(const role of roles){
    const i=role.index;
    colors.set(palette[role.group].toArray(),i*3);
    kinds[i]=role.group==='market'?0:role.group==='research'?1:role.group==='risk'?2:3;
    offsets[i]=i*.137;
    dummy.position.copy(positions[i]);dummy.rotation.set(0,0,0);dummy.scale.setScalar(1);dummy.updateMatrix();pickBody.setMatrixAt(i,dummy.matrix);
  }
  function update(model,selected,hovering,pointScale){
    const t=reducedMotion?0:model.elapsed, flows=model.flows;
    material.uniforms.uTime.value=t;
    for(const role of roles){
      const i=role.index,status=model.status(i),participating=status!=='idle';
      const selectedNow=i===selected||i===hovering;
      let signal=0;
      if(!reducedMotion)for(const event of flows){
        const age=model.elapsed-event.at;
        if(event.from===i&&age<1.9)signal=Math.max(signal,age/1.9);
        if(event.to===i&&age>3.1&&age<5.0)signal=Math.max(signal,1-(age-3.1)/1.9);
      }
      const energy=status==='running'?1:status==='done'?.38:participating?.2:.04;
      states.set([energy,signal,selectedNow?1:0,selectedNow?.9:participating?.58:.055],i*4);
      const scale=(selectedNow?1.15:participating?1:.7)*(.82+pointScale*.12);
      dummy.position.copy(positions[i]);dummy.rotation.set(0,0,0);dummy.scale.setScalar(.31*scale);dummy.updateMatrix();faces.setMatrixAt(i,dummy.matrix);
      color.copy(palette[role.group]);
      if(appearance.dark)color.multiplyScalar(selectedNow?1.1:participating?.76:.10);else color.lerp(appearance.muted,selectedNow?0:participating?.18:.82);
      dummy.scale.setScalar(scale*(participating?1:.6));
      dummy.rotation.set(t*.28+i*.4,t*.46+i*.7,t*.16);dummy.updateMatrix();crystal.setMatrixAt(i,dummy.matrix);crystal.setColorAt(i,color);
      dummy.rotation.set(-t*.22+i*.5,t*.31,t*.18+i);dummy.updateMatrix();cage.setMatrixAt(i,dummy.matrix);cage.setColorAt(i,color);
      for(let j=0;j<2;j++){
        dummy.rotation.set(.8+i*.34+j*1.4,t*(j?-.48:.36)+i*.9,t*.18+j*.7);
        dummy.scale.setScalar(scale*(selectedNow?.85:status==='running'?.65:0)*(1+Math.sin(signal*Math.PI)*.16));dummy.updateMatrix();
        gyros.setMatrixAt(i*2+j,dummy.matrix);gyros.setColorAt(i*2+j,color);
      }
    }
    geometry.attributes.coreState.needsUpdate=true;
    for(const mesh of [faces,crystal,cage,gyros]){mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}
  }
  function setTheme(){for(const role of roles)colors.set(palette[role.group].toArray(),role.index*3);geometry.attributes.coreColor.needsUpdate=true;for(const mesh of [faces,crystal,cage,gyros]){mesh.material.blending=appearance.dark?THREE.AdditiveBlending:THREE.NormalBlending;mesh.material.needsUpdate=true;}}
  setTheme();
  return {group,pickBody,update,setTheme};
}
