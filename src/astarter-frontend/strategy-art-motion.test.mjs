import test from 'node:test';
import assert from 'node:assert/strict';
import {createStrategyArtMotion,strategyArt} from './strategy-art.mjs';
test('strategy plots stay still until hovered; leaving, hiding and disconnecting stop work',()=>{
 const keys=['document','matchMedia','location','IntersectionObserver','requestAnimationFrame','cancelAnimationFrame','DOMPoint'];
 const old=Object.fromEntries(keys.map(k=>[k,globalThis[k]])),frames=new Map(),listeners=new Map(),mediaListeners=new Map();let seq=0,observer;
 const media={matches:false,addEventListener:(k,f)=>mediaListeners.set(k,f),removeEventListener:k=>mediaListeners.delete(k)};
 const node=()=>({attrs:{},setAttribute(k,v){this.attrs[k]=v;},textContent:''});
 const parts={'[data-scan-path]':{getTotalLength:()=>100,getPointAtLength:v=>({x:28+v*3.44,y:120-Math.sin(v)*8})},'.sa-quote':node(),'.sa-cursor':node(),'.sa-scan-dot':node(),'.sa-tooltip-label':node(),'.sa-tooltip-value':node(),svg:{getScreenCTM:()=>({inverse:()=>({})})}};
 const packets=[node(),node()],button={};
 const plot={closest:()=>button,dataset:{chart:'inside-bars',tips:JSON.stringify([['A','a'],['B','b'],['C','c']])},isConnected:true,querySelector:s=>parts[s],querySelectorAll:s=>s==='.sa-light-packet'?packets:[]};
 try{
  globalThis.document={hidden:false,addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
  globalThis.matchMedia=()=>media;globalThis.location={search:''};
  globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;observer=this;}observe(){}unobserve(){}disconnect(){}};
  globalThis.requestAnimationFrame=f=>{frames.set(++seq,f);return seq;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
  globalThis.DOMPoint=class{constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}};
  const run=()=>{const pending=[...frames.entries()];frames.clear();for(const [,f]of pending)f(1200);};
  const motion=createStrategyArtMotion();motion.observe(plot);observer.callback([{target:plot,isIntersecting:true}]);
  const initial=parts['.sa-quote'].attrs.transform;assert.equal(frames.size,0);assert.ok(initial);
  button.onfocus();assert.equal(plot.dataset.motion,'active');assert.equal(frames.size,1);run();assert.ok(packets[0].attrs['stroke-dashoffset']);button.onblur();assert.equal(frames.size,0);assert.equal(plot.dataset.motion,'idle');
  plot.onpointerenter({pointerType:'touch'});assert.equal(frames.size,0);
  plot.onpointerenter({pointerType:'mouse'});assert.equal(frames.size,1);run();const packetAt=packets[0].attrs['stroke-dashoffset'];assert.notEqual(parts['.sa-quote'].attrs.transform,initial);
  plot.onpointerleave();assert.equal(frames.size,0);const frozen=parts['.sa-quote'].attrs.transform;run();assert.equal(parts['.sa-quote'].attrs.transform,frozen);assert.equal(packets[0].attrs['stroke-dashoffset'],packetAt);
  plot.onpointerenter({pointerType:'mouse'});globalThis.document.hidden=true;listeners.get('visibilitychange')();assert.equal(frames.size,0);
  globalThis.document.hidden=false;listeners.get('visibilitychange')();assert.equal(frames.size,1);
  media.matches=true;mediaListeners.get('change')();assert.equal(frames.size,0);assert.equal(plot.dataset.motion,'reduced');
  plot.onpointermove({pointerType:'mouse',clientX:100,clientY:100});assert.equal(frames.size,0);
  motion.disconnect();assert.equal(listeners.size,0);assert.equal(mediaListeners.size,0);assert.equal(plot.onpointermove,null);assert.equal(button.onfocus,null);assert.equal(button.onblur,null);
  media.matches=false;motion.observe(plot);observer.callback([{target:plot,isIntersecting:true}]);assert.equal(listeners.size,1);assert.equal(frames.size,0);plot.onpointerenter({pointerType:'mouse'});assert.equal(frames.size,1);motion.disconnect();assert.equal(frames.size,0);
 }finally{for(const k of keys){if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}}
});

test('strategy optics use seven local spectrum stops with unique IDs and retain semantic candle directions',()=>{
 const a=strategyArt('S03'),b=strategyArt('S03');
 const uid=a.match(/id="(sa-area-\d+-spectrum)"/)[1];
 assert.ok(!b.includes('id="'+uid+'"'));
 for(let i=1;i<=7;i++)assert.ok(a.includes('stop-color:var(--s'+i+')'));
 for(const cls of ['sa-light-envelope','sa-light-core','sa-packet-tail','sa-packet-head','sa-candle-up','sa-candle-down'])assert.ok(a.includes(cls));
 assert.ok(a.includes('data-scan-path'));
});
