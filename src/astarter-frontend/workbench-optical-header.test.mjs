import test from 'node:test';
import assert from 'node:assert/strict';
import {halftoneStep,opticalHeaderMetrics,createOpticalHeader,workbenchWalletMetric} from './workbench-optical-header.mjs';

test('header counts scoped available inputs once and never counts missing sources as data',()=>{
 const tasks=[{symbol:'BTC',phase:'complete',outcome:'watch',evidence:[{key:'trend',sourceId:'p',status:'retain'},{key:'trend',sourceId:'p',status:'retain'},{key:'chain',status:'missing'}]},{symbol:'ETH',phase:'verify',outcome:'candidate',evidence:[{key:'trend',sourceId:'p',status:'collected'},{key:'social',status:'pending'}]},{symbol:'XAU',phase:'complete',outcome:'candidate',evidence:[{key:'chain',status:'na'}]}],before=structuredClone(tasks);
 assert.deepEqual(opticalHeaderMetrics(tasks,{cash:10000}),{equity:10000,positionValue:0,inputs:2,assets:3,domains:1,candidates:1});
 assert.deepEqual(tasks,before);assert.equal(opticalHeaderMetrics([],{}).equity,null);assert.equal(opticalHeaderMetrics([],{}).positionValue,null);
});
test('the wallet metric separates a guest, read failures, true zero and positive sub-cent balances',()=>{
 const at=Date.UTC(2026,10,25,9,8,7);
 const snapshot={address:'0x'+'12'.repeat(20),status:'ready',usdt:0,updatedAt:at,cash:10000,connections:{sharedBalance:999}};
 const metric=patch=>workbenchWalletMetric({...snapshot,...patch});
 assert.equal(metric({status:'guest',usdt:999}).amount,'0.00');
 for(const [status,state] of [['loading',/读取中|Loading/],['error',/读取失败|Read failed/]]){
  const m=metric({status,usdt:999});assert.equal(m.amount,'—');assert.match(m.label,state);assert.doesNotMatch(m.description,/999/);
 }
 const zero=metric({});assert.equal(zero.amount,'0.00');assert.match(zero.label,/BSC.*\d{2}:\d{2}/);assert.match(zero.description,/2026-11-25 09:08:07 UTC/);
 const small=metric({usdt:1e-18});assert.equal(small.amount,'<0.01');assert.match(small.description,/0\.000000000000000001/);
 const positive=metric({usdt:1234.567});assert.equal(positive.amount,'1,234.57');assert.match(positive.description,/1,234\.567/);
 assert.equal(metric({usdt:.01}).amount,'0.01');assert.equal(metric({usdt:null}).amount,'—');
});

test('exact BSC decimals determine sub-cent display, rounding and the complete amount in the tooltip',()=>{
 const metric=exactUsdt=>workbenchWalletMetric({status:'ready',usdt:Number(exactUsdt),exactUsdt,updatedAt:0});
 const observed=metric('313590.44042115970586377');
 assert.equal(observed.amount,'313,590.44');assert.match(observed.description,/313,590\.44042115970586377/);
 assert.equal(metric('0').amount,'0.00');assert.equal(metric('0.000000000000000001').amount,'<0.01');
 assert.equal(metric('0.009999999999999999').amount,'<0.01');assert.equal(metric('0.01').amount,'0.01');
 assert.equal(metric('999.994999999999999999').amount,'999.99');assert.equal(metric('999.995').amount,'1,000.00');
 assert.equal(metric('9007199254740993.005').amount,'9,007,199,254,740,993.01');
});

test('halftone displacement settles and remains still at home without pointer force',()=>{
 assert.deepEqual(halftoneStep(1,2,0,0,1,2,-1e5,-1e5,55),[1,2,0,0]);
 let state=[40,30,0,0];for(let i=0;i<250;i++)state=halftoneStep(...state,10,10,-1e5,-1e5,55);
 assert.ok(Math.abs(state[0]-10)<.001&&Math.abs(state[1]-10)<.001);
 assert.ok(halftoneStep(10,10,0,0,10,10,8,10,55)[0]>10);
 for(let home=1;home<=32;home++){
  let point=[home,0,0,0];
  for(let i=0;i<250;i++){point=halftoneStep(...point,home,0,0,0,32);assert.ok(Math.abs(point[0]-home)<8,'hover keeps each glyph locally readable');}
 }
});

test('equity includes marked spot positions once',()=>{
 const m=opticalHeaderMetrics([],{cash:100,position:{qty:2,price:50}});
 assert.equal(m.equity,200);assert.equal(m.positionValue,100);
});

test('allocated bot cash and inventory remain in account equity without duplication',()=>{
 const m=opticalHeaderMetrics([],{cash:7000,botSummary:{cash:2200,inventoryValue:800,equity:3000}});
 assert.equal(m.equity,10000);assert.equal(m.positionValue,800);
 assert.equal(opticalHeaderMetrics([],{cash:7000,botSummary:{equity:NaN}}).equity,null);
 assert.equal(opticalHeaderMetrics([],{cash:10000,cashKnown:false}).equity,null);
 assert.equal(opticalHeaderMetrics([],{cash:0}).equity,0);
});

test('only the wordmark sweeps every eight seconds; pause, reduced motion and offscreen stay neutral',t=>{
 const saved=new Map(),frames=new Map(),intersections=[];let clock=0,id=0;
 const replace=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value,writable:true});};
 const context=()=>({gradients:0,fillStyle:'',setTransform(){},clearRect(){},beginPath(){},arc(){},fill(){},fillText(){},fillRect(){},drawImage(){},save(){},restore(){},measureText(word){return {width:word.length*(Number(this.font?.match(/([\d.]+)px/)?.[1])||10)*.6,actualBoundingBoxAscent:8};},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4).fill(255)};},createLinearGradient(...args){this.gradients++;this.gradientArgs=args;this.stops=[];return {addColorStop:(...stop)=>this.stops.push(stop)};}});
 const makeCanvas=()=>{const ctx=context();return {dataset:{},ctx,getContext(){return ctx;}};};
 const faces=Array.from({length:4},(_,i)=>{const canvas=makeCanvas(),label={textContent:i?'—':'LENSWAVE'},events=new Map();return {canvas,label,events,dataset:{},closest:()=>null,querySelector:q=>q==='canvas'?canvas:label,getBoundingClientRect:()=>({width:40,height:12,left:0,top:0}),addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);}};});
 const fields=Array.from({length:3},()=>({firstElementChild:{},lastElementChild:{},setAttribute(key,value){this[key]=value;}}));
 const root={innerHTML:'',querySelector:()=>({children:fields}),querySelectorAll:()=>faces};
 const doc={hidden:false,documentElement:{dataset:{theme:'dark'},lang:'zh'},createElement:makeCanvas,addEventListener(){},removeEventListener(){}};
 const flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(frame=>frame(clock));};
 replace('document',doc);replace('devicePixelRatio',1);replace('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 replace('ResizeObserver',class{observe(){}disconnect(){}});replace('MutationObserver',class{observe(){}disconnect(){}});
 replace('IntersectionObserver',class{constructor(callback){intersections.push(callback);}observe(){}disconnect(){}});
 const palette=['#ff624f','#ff9a2b','#ffd84d','#4dff7a','#3dd5ff','#4a6bff','#a24dff'];
 replace('getComputedStyle',()=>({color:'#ecebe6',getPropertyValue:key=>palette[Number(key.slice(3))-1]}));
 replace('requestAnimationFrame',fn=>{frames.set(++id,fn);return id;});replace('cancelAnimationFrame',key=>frames.delete(key));
 t.mock.method(performance,'now',()=>clock);let header;
 try{
  header=createOpticalHeader(root);const update=paused=>{header.update([],workbenchWalletMetric({status:'guest'}),paused,[]);flush();};
  clock=7999;update(false);assert.equal(faces[0].canvas.ctx.gradients,0);
  clock=8000;update(false);assert.equal(faces[0].canvas.dataset.sweeping,'true');assert.ok(faces[0].canvas.ctx.gradients>0);
  assert.ok(faces.slice(1).every(face=>face.canvas.ctx.gradients===0&&face.canvas.ctx.fillStyle==='#ecebe6'));
  clock=9201;flush();assert.equal(faces[0].canvas.dataset.sweeping,'false');const count=faces[0].canvas.ctx.gradients;
  clock=16000;update(true);assert.equal(faces[0].canvas.ctx.gradients,count);
  doc.documentElement.dataset.reducedMotion='true';clock=24000;update(false);assert.equal(faces[0].canvas.ctx.gradients,count);
  doc.documentElement.dataset.reducedMotion='false';doc.hidden=true;clock=32000;update(false);assert.equal(faces[0].canvas.ctx.gradients,count);
  doc.hidden=false;intersections.forEach(notify=>notify([{isIntersecting:false}]));clock=40000;update(false);assert.equal(faces[0].canvas.ctx.gradients,count);
  intersections.forEach(notify=>notify([{isIntersecting:true}]));update(false);assert.ok(faces[0].canvas.ctx.gradients>count);
  for(const face of faces){
   face.events.get('pointerenter')({clientX:20,clientY:6});flush();assert.equal(face.canvas.dataset.neon,'true');
   face.events.get('pointerleave')();flush();assert.equal(face.canvas.dataset.neon,'false');
  }
  faces[1].events.get('focus')();flush();assert.equal(faces[1].canvas.dataset.neon,'true');
  doc.documentElement.dataset.reducedMotion='true';flush();assert.equal(faces[1].canvas.dataset.neon,'true');assert.equal(frames.size,0,'reduced motion keeps the focus color without looping');
  faces[1].events.get('blur')();flush();assert.equal(faces[1].canvas.dataset.neon,'false');
  const wallet=workbenchWalletMetric({status:'ready',usdt:25,updatedAt:Date.UTC(2026,10,25,9,8,7)});
  header.update([],wallet,false,[{state:'ready',bars:2500,signal:'balanced'}]);flush();
  assert.deepEqual(faces.map(face=>face.label.textContent),['LENSWAVE','25.00','2,500','0']);
  assert.match(fields[0].firstElementChild.textContent,/^(钱包余额|Wallet balance) · USDT · BSC/);
  assert.equal(fields[0].title,wallet.description);assert.equal(fields[0]['aria-label'],wallet.description);
  assert.match(root.innerHTML,/data-terminal-action="wallet"/);assert.doesNotMatch(root.innerHTML,/data-terminal-route="assets"/);
  for(const state of ['loading','error']){
   const balance=workbenchWalletMetric({status:state});header.update([],balance,false);flush();
   assert.equal(faces[1].label.textContent,'—');assert.equal(fields[0].firstElementChild.textContent,balance.label);
  }
  header.update([],wallet,false,[{state:'ready',bars:2500,signal:'balanced'}]);flush();
  for(const face of faces){
   face.events.get('pointerenter')({clientX:10,clientY:6});flush();
   const [left,,right]=face.canvas.ctx.gradientArgs,textWidth=Math.min(40*.98,face.label.textContent.length*12*1.2*.6);
   assert.ok(Math.abs((right-left)-textWidth*1.12)<.001,'spectrum fits the glyph width instead of its container');
   assert.deepEqual(face.canvas.ctx.stops.map(stop=>stop[1]),palette);
   face.events.get('pointerleave')();flush();assert.equal(face.canvas.dataset.neon,'false');assert.equal(face.canvas.ctx.fillStyle,'#ecebe6');
  }
  header.dispose();assert.equal(frames.size,0);assert.ok(faces.every(face=>face.events.size===0));
 }finally{header?.dispose();for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
