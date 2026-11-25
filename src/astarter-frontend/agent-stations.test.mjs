import test from 'node:test';
import assert from 'node:assert/strict';
import {createStations,createStationMaterials} from './agent-stations.mjs';
import {createCrystalFamily,CRYSTAL_OPTICS} from './crystal-character.mjs';

test('station crystal uses the character optics without changing the character materials',()=>{
 const family=createCrystalFamily(),original=family.materials.ceramic.color.getHexString();
 const palette=createStationMaterials(family.materials,'#43b8ef'),m=palette.materials;
 const snapshot=()=>[m.ceramic.color.getHexString(),m.graphite.color.getHexString(),m.ceramic.transmission,m.ceramic.envMapIntensity,palette.edge.color.getHexString(),palette.glow.strength.value];
 try{
  assert.equal(m.ceramic.ior,CRYSTAL_OPTICS.ior);assert.notEqual(m.ceramic,family.materials.ceramic);
  palette.theme(true);const dark=snapshot();palette.theme(false);
  assert.ok(m.ceramic.color.r>.25&&m.ceramic.color.g>.25&&m.ceramic.color.b>.25);
  assert.ok(m.graphite.color.r>.3&&m.graphite.color.g>.3&&m.graphite.color.b>.3);
  assert.ok(m.ceramic.transparent);assert.equal(m.ceramic.depthWrite,false);assert.ok(m.ceramic.opacity>.4&&m.ceramic.opacity<.8);assert.ok(m.ceramic.transmission>0&&m.ceramic.transmission<.6);
  assert.ok(palette.glow.strength.value>0&&palette.glow.strength.value<dark[5]);
  palette.theme(true);assert.deepEqual(snapshot(),dark);assert.equal(family.materials.ceramic.color.getHexString(),original);
 }finally{palette.dispose();family.dispose();}
});

test('theme changes preserve station placement, animated screens, retrieval and shared resources',()=>{
 const originalDocument=globalThis.document,contexts=[];
 globalThis.document={createElement(name){assert.equal(name,'canvas');const ctx={paints:0,fillRect(){this.paints++;}};for(const name of ['beginPath','moveTo','lineTo','stroke','arc','fill'])ctx[name]=()=>{};contexts.push(ctx);return {width:0,height:0,getContext:()=>ctx};}};
 const family=createCrystalFamily();let stations;
 try{
  stations=createStations(family);assert.equal(stations.root.children.length,6);
  const frame={geometry:{cr:{width:900,height:500},core:{x:450,y:250},mobile:false},poses:[{job:{station:0},work:{action:'retrieve'}}],deviceFrames:new Map([[0,{q:.19}]]),time:1,reduced:false,dark:true};
  stations.update(frame);const drawer=stations.root.children[0].children.find(m=>m.isMesh&&m.position.y===37&&m.position.z===13);
  assert.ok(drawer.position.x<-10);const positions=stations.root.children.map(g=>g.position.toArray()),first=contexts.map(c=>c.paints);
  stations.update(frame);assert.deepEqual(contexts.map(c=>c.paints),first);
  stations.update({...frame,dark:false});assert.deepEqual(stations.root.children.map(g=>g.position.toArray()),positions);
  assert.ok(contexts.every((ctx,i)=>ctx.paints>first[i]));
  stations.update({...frame,poses:[],dark:false});assert.equal(drawer.position.x,-7);
  let sharedDisposals=0;family.materials.ceramic.addEventListener('dispose',()=>sharedDisposals++);
  stations.dispose();stations=null;assert.equal(sharedDisposals,0);
 }finally{stations?.dispose();family.dispose();if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;}
});
