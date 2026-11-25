import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneCueTracker,createChipSynth,createSceneAudio} from './scene-audio.mjs';
const frame=(time,extra={})=>({epoch:1,time,active:true,states:[],research:{tasks:[]},...extra});
test('scene sounds follow new collection, receipt and conclusion identities without replay',()=>{
 const track=createSceneCueTracker();
 assert.equal(track(frame(0)),null);
 const states=[{id:0,phase:1,event:{id:'e1'}}];
 assert.equal(track(frame(1,{states})),'collect');
 assert.equal(track(frame(2,{states})),null);
 const receipt={key:'evidence:e1',stage:'read'};
 assert.equal(track(frame(3,{states,receipt})),'receive');
 assert.equal(track(frame(4,{states,receipt})),null);
 const task={symbol:'ETH',revision:'v2',phase:'complete'};
 assert.equal(track(frame(5,{research:{tasks:[task]}})),'decision');
 assert.equal(track(frame(6,{research:{tasks:[task]}})),null);
 assert.equal(track(frame(7,{states:[{id:16,phase:5,job:{id:'review-1',business:true,taskType:'review',result:'filled'}}]})),'fill');
});
test('mute, hidden/pause gating, reset and dense activity never queue old sounds',()=>{
 const track=createSceneCueTracker(),states=[{id:3,phase:1,event:{id:'e2'}}];
 track(frame(0));track(frame(1,{active:false,states}));assert.equal(track(frame(2,{states})),null);
 assert.equal(track(frame(3,{epoch:2,states})),null);
 assert.equal(track(frame(4,{epoch:2,states:[{id:5,phase:1,event:{id:'e3'}}]})),'collect');
 assert.equal(track(frame(4.1,{epoch:2,receipt:{key:'fast',stage:'read'}})),null);
 assert.equal(track(frame(6,{epoch:2,receipt:{key:'fast',stage:'read'}})),null);
});
test('new conclusions take priority over simultaneous low-priority collection',()=>{
 const track=createSceneCueTracker();track(frame(0));
 assert.equal(track(frame(1,{states:[{id:0,phase:1,event:{id:'e1'}}],research:{tasks:[{symbol:'BTC',revision:'v1',phase:'complete'}]}})),'decision');
 assert.equal(track(frame(2,{states:[{id:0,phase:1,event:{id:'e1'}}]})),null);
});
test('8-bit synthesis stays short and quiet, and mute stops scheduled voices',()=>{
 const nodes=[],params=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){},cancelScheduledValues(){}});
 const ctx={currentTime:10,destination:{},createGain(){const n={gain:params(),connect(){},disconnect(){}};nodes.push(n);return n;},createOscillator(){const n={frequency:params(),connect(){},disconnect(){},start(at){this.startAt=at;},stop(at){this.stopAt=at;}};nodes.push(n);return n;}};
 const synth=createChipSynth(ctx);synth.play('receive');
 const voices=nodes.filter(n=>n.frequency);assert.equal(voices.length,2);
 assert.ok(voices.every(n=>['square','triangle'].includes(n.type)&&n.stopAt-n.startAt<.3));
 assert.ok(nodes[0].gain.value>=.16&&nodes[0].gain.value<=.20);synth.stop();assert.ok(voices.every(n=>n.stopAt===ctx.currentTime));synth.dispose();
});


test('actual uppercase protection states produce one warning per changed risk event',()=>{
 const track=createSceneCueTracker();track(frame(0));
 const job={id:'risk-1',business:true,taskType:'risk',result:'BLOCKED'};
 assert.equal(track(frame(1,{states:[{id:14,job}]})),'warning');
 assert.equal(track(frame(2,{states:[{id:14,job}]})),null);
 assert.equal(track(frame(3,{states:[{id:14,job:{...job,result:'IMPAIRED'}}]})),'warning');
});

test('explicit sound preview works while paused; mute, page changes and rapid toggles stop playback',async()=>{
 const saved=Object.fromEntries(['window','document','MutationObserver'].map(key=>[key,globalThis[key]]));
 const attrs=new Map(),nodes=[],listeners=new Map();let observe;
 const button={dataset:{},setAttribute(k,v){attrs.set(k,v);},remove(){this.removed=true;}};
 const parameter=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
 class AudioContext{
  constructor(){this.state='suspended';this.currentTime=5;this.destination={};nodes.push(this);}
  createGain(){return{gain:parameter(),connect(){},disconnect(){}};}
  createOscillator(){const voice={frequency:parameter(),connect(){},disconnect(){},start(){this.started=true;},stop(at){this.stoppedAt=at;}};nodes.push(voice);return voice;}
  async resume(){this.state='running';}
  async close(){this.state='closed';}
 }
 globalThis.window={AudioContext};globalThis.document={hidden:false,documentElement:{lang:'zh-CN'},body:{dataset:{page:'workbench',paused:'true'}},createElement:()=>button,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 globalThis.MutationObserver=class{constructor(fn){observe=fn;}observe(){}disconnect(){}};
 let audio;
 try{
  audio=createSceneAudio({append(){}});assert.equal(attrs.get('aria-pressed'),'false');assert.equal(nodes.length,0);
  await button.onclick();assert.equal(button.dataset.audioState,'running');assert.equal(button.dataset.audioCue,'enable');
  const preview=nodes.filter(n=>n.frequency);assert.equal(preview.length,3);
  audio.update(frame(0));assert.ok(preview.every(n=>n.stoppedAt>5),'a paused frame must not cut off an explicit sound preview');
  await button.onclick();assert.equal(attrs.get('aria-pressed'),'false');assert.ok(preview.every(n=>n.stoppedAt===5));
  const pending=button.onclick();await button.onclick();await pending;assert.equal(attrs.get('aria-pressed'),'false');assert.equal(nodes.filter(n=>n.frequency).length,3,'a stale resume must not play');
  await button.onclick();document.body.dataset.paused='false';audio.update(frame(1));audio.update(frame(2,{states:[{id:0,phase:1,event:{id:'new'}}]}));assert.equal(button.dataset.audioCue,'collect');
  const cues=nodes.filter(n=>n.frequency);document.body.dataset.paused='true';observe();assert.ok(cues.every(n=>n.stoppedAt===5));
  const count=cues.length;audio.update(frame(3,{states:[{id:1,phase:1,event:{id:'paused'}}]}));assert.equal(nodes.filter(n=>n.frequency).length,count);
  document.body.dataset.page='markets';observe();audio.update(frame(4));assert.equal(nodes.filter(n=>n.frequency).length,count);
  audio.dispose();assert.equal(nodes[0].state,'closed');assert.equal(button.removed,true);assert.equal(listeners.size,0);
 }finally{audio?.dispose();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
