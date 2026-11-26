import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {MultiResearch} from './multi-research.mjs';
import {MarketResearch} from './live-research.mjs';
import {normalizeSpotDepth} from './spot-depth-data.mjs';
import {createPhotonicRenderGate,updatePhotonicMeter,photonicResultRow,createPhotonicCadence,syncPhotonicCadence} from './photonic-workbench.mjs';
import {photonicProjection,photonicChannels,photonicOutcome,prismLabelSize,photonicEvidenceSummary,createPhotonicLaneMotion,photonicResult,prismDragRotation,prismLocalRect,photonicLaneSlot,photonicSourceGraphic,photonicMonitorSource,photonicCoverage,photonicRuntime,runtimeAssetReading,photonicPatrolSymbol,photonicStageMeter,photonicPhaseSummary} from './photonic-workbench.mjs';
import * as photonic from './photonic-workbench.mjs';
import {pair as jobCopy} from './locale.mjs';

for(const reducedMotion of [false,true])test(`the controller flushes pause/resume with reduced motion ${reducedMotion}`,()=>{
 const source=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8');
 const update=source.match(/  (update\(model,dt,running[^\n]*\{[\s\S]*?\n  \}),\n  focus\(\)/)?.[1];
 assert.ok(update,'exercise the real controller update branch');
 let requests=0;
 const controller=Function('renderGate','reducedMotion','createPhotonicCadence',`
  let wasRunning=true,moving=!reducedMotion,uiTime=0,redraw=false,clock=10,holdUntil=0,patrol=false,patrolAt=0;
  const document={hidden:false,documentElement:{dataset:{}}},cadence=createPhotonicCadence(),stageCadences=new Map();
  return {${update},snapshot(){return {moving,uiTime,clock};}};
 `)({request(){requests++;},analysisVisible:false,opticsVisible:false},reducedMotion,createPhotonicCadence);
 controller.update({},.016,false);
 assert.equal(requests,1,'pause flushes even before the normal 180ms UI interval');
 assert.deepEqual(controller.snapshot(),{moving:false,uiTime:0,clock:10});
 controller.update({},.016,false);
 assert.equal(requests,1);assert.equal(controller.snapshot().clock,10);
 controller.update({},.016,false,{forceUI:true});
 assert.equal(requests,2,'a real job update flushes even after pause has settled');assert.equal(controller.snapshot().clock,10);
 controller.update({},.016,false,{forceUI:false});assert.equal(requests,2,'ordinary paused frames stay throttled');
 controller.update({},.01,true);
 assert.equal(requests,3);assert.deepEqual(controller.snapshot(),{moving:!reducedMotion,uiTime:0,clock:reducedMotion?10:10.01});
});

test('observed work accelerates then settles, without replaying identical snapshots or sort changes',()=>{
 const cadence=createPhotonicCadence(),tasks=[{symbol:'BTC',phase:'collect',progress:20,evidence:[{key:'trend',status:'pending'},{key:'depth',status:'collected'}]}],before=structuredClone(tasks);
 const step=(seconds)=>{for(let i=0;i<seconds*20;i++)cadence.update(.05);};
 cadence.observe(tasks);step(3);const baseline=cadence.state.rate;
 for(let i=0;i<50;i++){cadence.observe(tasks);cadence.update(.05);}assert.ok(Math.abs(cadence.state.rate-baseline)<.01);
 cadence.observe([{...tasks[0],evidence:[...tasks[0].evidence].reverse()}]);step(.2);assert.ok(Math.abs(cadence.state.rate-baseline)<.01,'ordering is not new work');
 const time=cadence.state.time;
 tasks[0].evidence[0].status='collected';cadence.observe(tasks);step(.3);assert.ok(cadence.state.rate>baseline*1.6);assert.ok(cadence.state.time>time);
 step(4);assert.ok(Math.abs(cadence.state.rate-baseline)<.01,'a burst decays when no new evidence arrives');
 tasks[0].phase='queuedCore';tasks[0].executionWaiting=true;cadence.observe(tasks);step(5);assert.ok(cadence.state.rate<baseline&&cadence.state.rate>=.55,'waiting slows without stopping the main beam');
 tasks[0].phase='complete';cadence.observe(tasks);step(8);assert.ok(Math.abs(cadence.state.rate-.55*1.7)<.01);assert.equal(cadence.state.mode,'idle');
 const settled=cadence.state.time;step(2);assert.ok(cadence.state.time>settled,'completed work retains a steady ambient beam');
 assert.deepEqual(before[0].evidence.map(x=>x.status),['pending','collected']);
});

test('paused, hidden or reduced motion freezes presentation time and discards catch-up bursts',()=>{
 const cadence=createPhotonicCadence(),tasks=[{symbol:'BTC',phase:'verify',progress:50}];cadence.observe(tasks);for(let i=0;i<40;i++)cadence.update(.05);
 const frozen=cadence.state.time,workingRate=cadence.state.rate;cadence.update(5,false);tasks[0].progress=90;cadence.observe(tasks,false);cadence.update(5,false);
 assert.equal(cadence.state.time,frozen);assert.equal(cadence.state.rate,0);
 cadence.observe(tasks);cadence.update(.05);assert.ok(cadence.state.rate<workingRate/2,'resume eases from rest instead of replaying missed events');
 assert.ok(cadence.state.time>frozen&&cadence.state.time-frozen<workingRate*.05/2);
 const before=structuredClone(tasks);cadence.observe(tasks);assert.deepEqual(tasks,before,'the presentation controller never changes research data');
});

test('completed beam texture keeps moving without new work, while its stage and explicit pause stay still',()=>{
 const task={symbol:'SPX',version:4,phase:'complete',progress:100,evidence:[{key:'trend',status:'retain',text:'Reviewed'}]},before=structuredClone(task);
 const beam=createPhotonicCadence(),stage=createPhotonicCadence('complete'),empty=createPhotonicCadence(),motion=createPhotonicLaneMotion();
 const sources=Array.from({length:6},()=>({status:'retain',available:3}));
 beam.observe([task]);stage.observe([task]);empty.observe([]);
 motion.update(0,sources,{key:'SPX:4',phase:task.phase,rate:beam.state.rate});
 for(let i=1;i<=200;i++){beam.update(.05);stage.update(.05);empty.update(.05);motion.update(i*.05,sources,{key:'SPX:4',phase:task.phase,rate:beam.state.rate});}
 assert.equal(beam.state.mode,'idle');assert.ok(Math.abs(beam.state.rate-.55*1.7)<.001);assert.ok(motion.state.t>2);
 assert.equal(stage.state.time,0);assert.equal(stage.state.rate,0);assert.equal(empty.state.time,0);assert.deepEqual(task,before);
 const clock=beam.state.time,texture=motion.state.t;beam.update(5,false);motion.update(15,sources,{key:'SPX:4',phase:task.phase,running:false,rate:beam.state.rate});
 assert.equal(beam.state.rate,0);assert.equal(beam.state.time,clock);assert.equal(motion.state.t,texture);
 beam.observe([task]);beam.update(.05);motion.update(15.05,sources,{key:'SPX:4',phase:task.phase,rate:beam.state.rate});
 assert.ok(beam.state.time>clock);assert.ok(motion.state.t>texture);assert.ok(motion.state.t-texture<.02,'resume does not replay the paused interval');assert.deepEqual(task,before);
});

test('the existing eight-asset research engine produces busy, quiet and renewed activity',()=>{
 const research=new MultiResearch(),cadence=createPhotonicCadence();let peak=0,idle=false,renewed=false;
 for(let i=0;i<4800;i++){
  research.advance(.05);if(i%4===0)cadence.observe(research.tasks);cadence.update(.05);
  peak=Math.max(peak,cadence.state.rate);
  if(research.tasks.every(task=>task.phase==='complete')&&Math.abs(cadence.state.rate-.55*1.7)<.01)idle=true;
  if(idle&&cadence.state.rate>.7*1.7&&research.tasks.some(task=>task.phase==='collect'))renewed=true;
 }
 assert.ok(peak>1.1,'overlapping evidence arrivals produce a visibly quicker cadence');
 assert.ok(idle,'a completed research pass retains gentle ambient flow');assert.ok(renewed,'the next actual research pass accelerates the presentation');
});

test('animation playback changes preserve the playhead and exclude business and one-shot animations',()=>{
 const changes=[];const animation=(name,inside=true)=>({animationName:name,playbackRate:1,currentTime:713,effect:{target:{closest(selector){return selector==='[data-run-meter],[data-run-phase]'?null:inside;}}},updatePlaybackRate(rate){changes.push([name,rate]);this.playbackRate=rate;}});
 const a=animation('ph-equalize'),business=animation('ph-packet',false),arrival=animation('one-shot-arrival'),root={getAnimations(){return [a,business,arrival];}};
 syncPhotonicCadence(root,.4);assert.deepEqual(changes,[['ph-equalize',.4]]);assert.equal(a.currentTime,713);
 syncPhotonicCadence(root,.4);assert.equal(changes.length,1);
 syncPhotonicCadence(root,0);assert.equal(a.playbackRate,0);syncPhotonicCadence(root,1.2);assert.equal(a.currentTime,713);assert.equal(a.playbackRate,1.2);
 assert.equal(business.playbackRate,1);assert.equal(arrival.playbackRate,1);
});

test('each stage responds only to its own work while the completed asset beam keeps a steady ambient flow',()=>{
 const tasks=[{symbol:'BTC',phase:'collect',progress:20},{symbol:'ETH',phase:'verify',progress:45},{symbol:'SOL',phase:'queuedCore',progress:72},{symbol:'SPX',phase:'complete',progress:100}];
 const stages=new Map(['queued','collect','verify','queuedCore','core','complete'].map(key=>[key,createPhotonicCadence(key)])),beam=createPhotonicCadence();
 const observe=()=>{beam.observe([tasks[3]]);for(const stage of stages.values())stage.observe(tasks);};
 const step=seconds=>{for(let i=0;i<seconds*20;i++){beam.update(.05);for(const stage of stages.values())stage.update(.05);}};
 observe();step(5);
 const collect=stages.get('collect'),verify=stages.get('verify'),waiting=stages.get('queuedCore'),before=Object.fromEntries([...stages].map(([key,value])=>[key,value.state.rate]));
 assert.ok(Math.abs(beam.state.rate-.55*1.7)<.01,'other assets cannot drive the completed asset beam beyond its ambient floor');
 assert.equal(stages.get('queued').state.rate,0,'a finished intake is at rest');
 assert.equal(collect.state.mode,'busy');assert.equal(waiting.state.mode,'waiting');
 assert.ok(collect.state.rate>waiting.state.rate*8);assert.ok(verify.state.rate>waiting.state.rate*8);
 tasks[0].progress=30;observe();step(.4);
 assert.ok(collect.state.rate>before.collect*1.5,'the collecting asset drives its own burst');
 assert.ok(Math.abs(verify.state.rate-before.verify)<.01,'verification is unaffected by another stage arrival');
 assert.ok(Math.abs(waiting.state.rate-before.queuedCore)<.01);assert.ok(beam.state.time>0);assert.ok(Math.abs(beam.state.rate-.55*1.7)<.01);
 const clocks=[beam,...stages.values()].map(c=>c.state.time);
 for(const c of [beam,...stages.values()])c.update(5,false);
 assert.deepEqual([beam,...stages.values()].map(c=>c.state.time),clocks);
 assert.ok([beam,...stages.values()].every(c=>c.state.rate===0));
});

test('a new focus does not invent an evidence burst and an execution hold slows its own stage',()=>{
 const beam=createPhotonicCadence(),held=createPhotonicCadence('collect'),task={symbol:'BTC',phase:'collect',progress:20};
 beam.observe([{symbol:'ETH',phase:'complete'}]);beam.update(.1);beam.observe([task]);held.observe([task]);
 for(let i=0;i<60;i++){beam.update(.05);held.update(.05);}
 assert.ok(Math.abs(beam.state.rate-held.state.rate)<.01,'focus changes use steady work speed');
 const normal=held.state.rate;task.executionWaiting=true;held.observe([task]);
 for(let i=0;i<100;i++)held.update(.05);
 assert.equal(held.state.mode,'waiting');assert.ok(normal>held.state.rate*8);
});

test('stage playback stays independent of a resting beam and redraws keep their own continuous phase',()=>{
 const nodes=[{dataset:{motionRate:'1.8',motionClock:'5.3'}},{dataset:{motionRate:'.12',motionClock:'.4'}}];
 const make=(stage,name='telemetry-live')=>({animationName:name,currentTime:0,playbackRate:1,effect:{target:{closest(selector){return selector==='[data-run-meter],[data-run-phase]'?stage:true;}}},updatePlaybackRate(rate){this.playbackRate=rate;}});
 const active=make(nodes[0]),waiting=make(nodes[1],'telemetry-wait'),beam=make(null,'ph-packet'),root={getAnimations(){return [active,waiting,beam];}};
 syncPhotonicCadence(root,0);assert.deepEqual([active.playbackRate,waiting.playbackRate,beam.playbackRate],[1.8,.12,0]);
 assert.equal(active.currentTime,5300);assert.equal(waiting.currentTime,400);
 active.currentTime=5600;nodes[0].dataset.motionClock='5.6';syncPhotonicCadence(root,0);assert.equal(active.currentTime,5600);
 const redrawn=make(nodes[0]);syncPhotonicCadence({getAnimations:()=>[redrawn]},0);assert.equal(redrawn.currentTime,5600,'a data redraw does not restart breathing');
 syncPhotonicCadence(root,1.5,false);assert.ok([active,waiting,beam].every(a=>a.playbackRate===0));
 assert.equal(active.currentTime,5600,'pause retains the playhead');
});

test('runtime charts plot closed observations on fixed scales and leave other slots empty',()=>{
 const slot={symbol:'BTC',state:'done'};
 const task={symbol:'BTC',mode:'live_readonly',evidence:[{key:'trend',status:'retain'}],observation:{symbol:'BTC',state:'ready',trend:-1.5,rsi:67}};
 assert.deepEqual(runtimeAssetReading('collect',slot,task),{level:75,text:'EMA20 · -1.50 ATR',label:'BTC · EMA20 · -1.50 ATR'});
 assert.deepEqual(runtimeAssetReading('complete',slot,task),{level:33,text:'RSI 14 · 67.0',label:'BTC · RSI 14 · 67.0'});
 task.observation.trend=4.2;assert.deepEqual(runtimeAssetReading('collect',slot,task),{level:0,text:'EMA20 · +4.20 ATR',label:'BTC · EMA20 · +4.20 ATR'});
 task.observation.rsi=0;assert.equal(runtimeAssetReading('complete',slot,task).level,100);
 assert.equal(runtimeAssetReading('collect',{...slot,symbol:'ETH'},task),null);
 assert.equal(runtimeAssetReading('collect',{...slot,state:'waiting'},task),null);
 task.observation.rsi=null;assert.equal(runtimeAssetReading('complete',slot,task),null);
 task.observation.state='stale';assert.equal(runtimeAssetReading('collect',slot,task),null);
});

test('live evidence pulses keep a one-second CSS clock while real-value feedback stops on pause',()=>{
 const target={closest:selector=>selector.startsWith('.pw-runtime-track')?target:null};
 const sample={animationName:'ph-source-sample',playbackRate:1,effect:{target},updatePlaybackRate(rate){this.playbackRate=rate;}};
 let cancelled=0;
 const flash={id:'pw-reading-change',cancel(){cancelled++;}};
 const root={dataset:{liveObservation:'true'},getAnimations:()=>[sample,flash]};
 syncPhotonicCadence(root,.15);assert.equal(sample.playbackRate,1);assert.equal(cancelled,0);
 syncPhotonicCadence(root,0,false);assert.equal(sample.playbackRate,0);assert.equal(cancelled,1);
 root.dataset.liveObservation='false';syncPhotonicCadence(root,.35);assert.equal(sample.playbackRate,.35);
 root.dataset.liveObservation='true';syncPhotonicCadence(root,.35);assert.equal(sample.playbackRate,1);
});

test('the existing visibility handler freezes CSS and canvas cadence before frames are suspended',()=>{
 const source=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8'),body=source.match(/const restoreLayout=\(\)=>\{(.*?)\};/)?.[1];assert.ok(body);
 const document={hidden:true},cadence=createPhotonicCadence(),stageCadences=new Map([['collect',createPhotonicCadence('collect')]]),root={dataset:{}},rates=[];let layouts=0;
 cadence.observe([{symbol:'BTC',phase:'collect'}]);cadence.update(.1);const time=cadence.state.time;
 const handler=Function('document','cadence','stageCadences','root','syncPhotonicCadence','resize',`let patrolAt=0;return ()=>{${body}};`)(document,cadence,stageCadences,root,(_,rate,enabled)=>rates.push([rate,enabled]),()=>layouts++);
 handler();assert.equal(cadence.state.rate,0);assert.equal(cadence.state.time,time);assert.deepEqual(rates,[[0,false]]);assert.equal(stageCadences.get('collect').state.rate,0);assert.equal(layouts,0);
 document.hidden=false;handler();assert.equal(layouts,1);assert.equal(cadence.state.time,time,'showing the tab does not jump the playhead');
});

test('beam cadence changes speed without resetting its texture or evidence strengths',()=>{
 const sources=laneSources(),motion=createPhotonicLaneMotion();motion.update(0,sources,{key:'BTC:1'});
 motion.update(.1,sources,{key:'BTC:1',rate:.3});const slow=motion.state.t,lit=motion.strengths[0];
 motion.update(.2,sources,{key:'BTC:1',rate:1.5});assert.ok(motion.state.t-slow>slow*4);assert.ok(motion.strengths[0]>lit);
 const time=motion.state.t;motion.update(.3,sources,{key:'BTC:1',rate:0});assert.equal(motion.state.t,time);
 motion.update(.4,sources,{key:'ETH:1',phase:'complete',rate:0});assert.equal(motion.state.L,64);assert.ok(motion.strengths.slice(0,64).every(value=>value===1),'an idle first frame is complete rather than waiting for animation to reveal it');
});

test('photonic rendering coalesces updates, pauses offscreen and tracks only the displayed chart',t=>{
 const doc=Object.getOwnPropertyDescriptor(globalThis,'document'),io=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver');
 let notify,disconnected=false,renders=0,enters=0;const observed=new Set(),node=()=>({getBoundingClientRect(){throw Error('frame must not read layout');}}),panel=node(),optics=node(),consolePanel=node(),chart=node(),nextChart=node();
 Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});
 Object.defineProperty(globalThis,'IntersectionObserver',{configurable:true,value:class{
  constructor(callback){notify=callback;}observe(el){observed.add(el);}unobserve(el){observed.delete(el);}disconnect(){disconnected=true;observed.clear();}
 }});
 t.mock.timers.enable({apis:['setTimeout']});
 const gate=createPhotonicRenderGate([panel,consolePanel],optics,()=>renders++,()=>enters++);
 try{
  gate.request();t.mock.timers.tick(1);assert.equal(renders,0);
  notify([{target:panel,isIntersecting:true},{target:optics,isIntersecting:true}]);gate.request();gate.request();t.mock.timers.tick(1);
  assert.equal(renders,1);assert.equal(gate.opticsVisible,true);assert.equal(enters,1);
  gate.watchChart(chart);notify([{target:chart,isIntersecting:true}]);assert.equal(gate.analysisVisible,true);
  gate.watchChart(nextChart);assert.equal(observed.has(chart),false);assert.equal(gate.analysisVisible,false);
  notify([{target:nextChart,isIntersecting:true}]);assert.equal(gate.analysisVisible,true);
  notify([{target:nextChart,isIntersecting:false},{target:panel,isIntersecting:false},{target:optics,isIntersecting:false}]);
  t.mock.timers.tick(1);assert.equal(renders,1);assert.equal(gate.opticsVisible,false);assert.equal(gate.analysisVisible,false);
  notify([{target:consolePanel,isIntersecting:true}]);document.hidden=true;t.mock.timers.tick(1);assert.equal(renders,1);
  document.hidden=false;gate.request();t.mock.timers.tick(1);assert.equal(renders,2);
  gate.request();gate.dispose();t.mock.timers.tick(1);assert.equal(renders,2);assert.equal(disconnected,true);assert.equal(gate.analysisVisible,false);
 }finally{
  gate.dispose();if(doc)Object.defineProperty(globalThis,'document',doc);else delete globalThis.document;
  if(io)Object.defineProperty(globalThis,'IntersectionObserver',io);else delete globalThis.IntersectionObserver;
 }
});

test('cached prism geometry stays aligned during scroll and refreshes after resize or hiding',()=>{
 const canvas={left:100,top:200,width:1200,height:600},prism={left:620,top:350,width:160,height:300};
 const before=structuredClone({canvas,prism}),rect=prismLocalRect(prism,canvas);
 assert.deepEqual(rect,{left:520,top:150,width:160,height:300,right:680});
 assert.deepEqual(prismLocalRect({...prism,left:prism.left-20,top:prism.top-240},{...canvas,left:canvas.left-20,top:canvas.top-240}),rect);
 assert.deepEqual(prismLocalRect({left:132,top:280,width:126,height:190},{left:0,top:250,width:390,height:250}),{left:132,top:30,width:126,height:190,right:258});
 assert.equal(prismLocalRect({...prism,width:0},canvas),null);
 assert.equal(prismLocalRect(prism,{...canvas,height:0}),null);
 assert.deepEqual({canvas,prism},before);
});

test('coverage controls distinguish available fields from adopted evidence without changing research',()=>{
 const p={task:{evidence:[{status:'retain'},{status:'context'},{status:'na'}]},sources:[{key:'trend',status:'retain'},{key:'macro',status:'context'},{key:'chain',status:'na'}],channels:[{source:'trend',status:'retain'},{source:'trend',status:'na'},{source:'macro',status:'context'},{source:'chain',status:'na'}]},before=structuredClone(p);
 const inputs=photonicCoverage(p),evidence=photonicCoverage(p,'evidence');
 assert.equal(inputs.count,2);assert.equal(inputs.total,4);
 assert.equal(evidence.count,1);assert.equal(evidence.total,2);
 assert.deepEqual(inputs.groups.map(group=>group.ticks),[[true,false],[true],[false]]);
 assert.deepEqual(evidence.groups.map(group=>group.ticks),[[true,false],[false],[false]]);
 assert.deepEqual(p,before);
 assert.deepEqual(photonicCoverage({task:null,sources:[],channels:[]},'evidence'),{groups:[],count:0,total:0});
});

test('unused backups leave no tail and the active backup stays within its source band',()=>{
 const inactive={spare:-1,fail:-1};
 assert.equal(photonicLaneSlot(0,inactive),0);assert.equal(photonicLaneSlot(63,inactive),63);
 for(let i=64;i<68;i++)assert.equal(photonicLaneSlot(i,inactive),null);
 const active={spare:65,fail:24};
 assert.equal(photonicLaneSlot(64,active),null);assert.equal(photonicLaneSlot(65,active),24.42);
 assert.equal(photonicLaneSlot(65,{spare:65,fail:63}),63);
});

test('source micrographs keep actual counts and do not invent absent series or ratios',()=>{
 const fields=[{id:'news',text:'3 items',status:'retain'},{id:'posts',text:'2 posts',status:'context'}],before=structuredClone(fields);
 const social=photonicSourceGraphic('social',fields);
 assert.equal((social.match(/class="pw-micro-sample"/g)||[]).length,5);
 assert.deepEqual(fields,before);
 assert.ok(!photonicSourceGraphic('depth',[{id:'ratio',text:'—'}]).includes('pw-micro-sample'));
 assert.ok(!photonicSourceGraphic('macro',[{text:'0 events'}]).includes('pw-micro-sample'));
 assert.ok(!photonicSourceGraphic('trend',[],[]).includes('polyline'));
 assert.ok(!/NaN|Infinity/.test(photonicSourceGraphic('trend',[],[12,12,12])));
 const evidence=[{key:'trend',status:'retain'},{key:'depth',status:'collected'},{key:'risk',status:'pending'},{key:'chain',status:'na'}];
 assert.deepEqual(photonicResult({phase:'verify',evidence}).basis,['trend','depth']);
 assert.deepEqual(photonicResult({phase:'complete',evidence}).basis,['trend']);
});

test('result cards show the current research and promise the actual detail destination',()=>{
 const task={symbol:'ETH',domain:'Crypto',phase:'verify',outcome:'candidate',title:'候选结论',thesis:'完成后的依据',next:'完成后的下一步',reason:'正在比对来源'};
 const before=structuredClone(task),pending=photonicResult(task);
 assert.equal(pending.reason,task.reason);assert.notEqual(pending.title,task.title);assert.notEqual(pending.next,task.next);
 assert.equal(pending.action,'研究详情');assert.deepEqual(task,before);
 const candidate=photonicResult({...task,phase:'complete'});
 assert.equal(candidate.title,task.title);assert.equal(candidate.reason,task.thesis);assert.equal(candidate.action,'查看机会');
 assert.ok(candidate.next.includes('再选择策略'));
 const watch=photonicResult({...task,phase:'complete',outcome:'watch'});
 assert.equal(watch.next,task.next);assert.equal(watch.action,'研究详情');
 assert.equal(photonicResult({...task,phase:'complete',domain:'TradFi'}).action,'研究详情');
});

test('result rows retain full evidence and the correct destination without repeated status labels',()=>{
 const task={symbol:'US10Y',domain:'TradFi',phase:'complete',outcome:'context',title:'共享利率背景',thesis:'利率变化用于压力情景；不直接推导资产涨跌。',next:'只供研究，不进入执行。',progress:100,evidence:[{key:'trend',status:'retain'},{key:'macro',status:'context'},{key:'chain',status:'na'}]},before=structuredClone(task);
 const row=photonicResultRow(task);
 assert.match(row,/data-pw-result="US10Y"/);assert.match(row,/<span>US10Y<\/span>/);
 assert.ok(row.includes('<strong>'+task.thesis+'</strong>'));assert.ok(row.includes('1/2 依据'));
 assert.ok(row.includes('US10Y · 研究详情'));assert.ok(!row.includes('<em>'));assert.ok(!row.includes('pw-result-flow'));
 assert.ok(!row.includes('<span>研究详情</span>'));assert.deepEqual(task,before);
 const pending=photonicResultRow({...task,phase:'verify',progress:42.4,reason:'正在核对来源'});
 assert.ok(pending.includes('<em>研究中</em>'));assert.ok(pending.includes('42%'));assert.ok(pending.includes('<strong>正在核对来源</strong>'));assert.ok(!pending.includes('<strong>'+task.thesis));
 assert.ok(photonicResultRow({...task,phase:'queued',progress:0}).includes('<em>排队中</em>'));
 assert.ok(photonicResultRow({...task,phase:'core',executionWaiting:true}).includes('<em>待核对</em>'));
 assert.ok(photonicResultRow({...task,evidence:[]}).includes('暂无依据'));
 assert.ok(!photonicResultRow({...task,phase:'core',progress:NaN}).includes('NaN'));
 const escaped=photonicResultRow({...task,symbol:'<X>',thesis:'<img src=x onerror=evil()>'});
 assert.ok(escaped.includes('data-pw-result="&lt;X&gt;"'));assert.ok(escaped.includes('&lt;img src=x onerror=evil()&gt;'));assert.ok(!escaped.includes('<img src=x'));
});

test('prism dragging rotates from the gesture origin and keeps the readable face in bounds',()=>{
 const start={yaw:.1,pitch:-.1},before={...start};
 assert.deepEqual(prismDragRotation(start,25,25),{yaw:.30000000000000004,pitch:.04999999999999999});
 assert.deepEqual(prismDragRotation(start,1000,-1000),{yaw:.85,pitch:-.4});
 assert.deepEqual(prismDragRotation(start,-1000,1000),{yaw:-.85,pitch:.4});
 assert.deepEqual(prismDragRotation(start,0,0),start);assert.deepEqual(start,before);
});

const laneSources=()=>['trend','depth','chain','macro','social','risk'].map(key=>({key,status:'retain',available:3}));
test('lanes reveal across the spectrum and restart only for a new asset or research version',()=>{
 const sources=laneSources(),before=structuredClone(sources),motion=createPhotonicLaneMotion();
 motion.update(0,sources,{key:'BTC:1',phase:'collect'});
 motion.update(.01,sources,{key:'BTC:1',phase:'collect'});
 assert.ok(motion.strengths[32]>0,'bit reversal introduces a separated band early');
 assert.equal(motion.strengths[1],0,'unrevealed lanes stay dim');
 for(let i=1;i<=40;i++)motion.update(i*.05,sources,{key:'BTC:1',phase:'collect'});
 const lit=motion.strengths[0];
 sources[0].status='context';motion.update(2.05,sources,{key:'BTC:1',phase:'verify'});
 assert.ok(motion.strengths[0]<lit&&motion.strengths[0]>.78,'status changes ease instead of jumping');
 motion.update(2.1,sources,{key:'BTC:2',phase:'collect'});
 assert.equal(motion.state.L,0);assert.equal(motion.strengths[32],0);
 motion.update(2.2,sources,{key:'ETH:1',phase:'collect'});assert.equal(motion.state.L,0);
 sources[0].status='retain';assert.deepEqual(sources,before);
});

test('only an available conflicting source interrupts a lane and recovery restores it',()=>{
 const sources=laneSources(),motion=createPhotonicLaneMotion();
 for(let i=0;i<=40;i++)motion.update(i*.05,sources,{key:'BTC:1'});
 assert.equal(motion.state.fail,-1);assert.equal(motion.state.spare,-1);
 sources[2].status='missing';motion.update(2.05,sources,{key:'BTC:1'});assert.equal(motion.state.fail,-1);
 sources[2].status='conflict';sources[2].available=0;motion.update(2.1,sources,{key:'BTC:1'});assert.equal(motion.state.fail,-1);
 sources[2].available=3;motion.update(2.15,sources,{key:'BTC:1'});
 const failed=motion.state.fail,spare=motion.state.spare;
 assert.equal(Math.floor(failed/64*6),2);assert.ok(spare>=64&&spare<68);
 assert.equal(motion.strengths[spare],0,'backup waits before taking over');
 for(let i=44;i<=64;i++)motion.update(i*.05,sources,{key:'BTC:1'});
 assert.ok(motion.strengths[failed]<.01);assert.ok(motion.strengths[spare]>.8);
 sources[2].status='retain';motion.update(3.25,sources,{key:'BTC:1'});
 assert.equal(motion.state.fail,-1);assert.equal(motion.state.spare,-1);assert.ok(motion.strengths[failed]>0);
});

test('phase speed changes preserve motion continuity while pause and reduced motion stay still',()=>{
 const sources=laneSources(),motion=createPhotonicLaneMotion();
 motion.update(0,sources,{key:'BTC:1',phase:'collect'});
 motion.update(.1,sources,{key:'BTC:1',phase:'collect'});const collect=motion.state.t;
 motion.update(.2,sources,{key:'BTC:1',phase:'verify'});const verify=motion.state.t-collect;
 motion.update(.3,sources,{key:'BTC:1',phase:'complete'});const complete=motion.state.t-collect-verify;
 assert.ok(verify>collect&&collect>complete&&complete>0);
 const time=motion.state.t;motion.update(.4,sources,{key:'BTC:1',running:false});
 assert.equal(motion.state.t,time);assert.equal(motion.state.L,64);
 motion.update(.5,sources,{key:'BTC:1'});assert.ok(motion.state.t>time);
 const quiet=createPhotonicLaneMotion(true);
 quiet.update(0,sources,{key:'BTC:1'});quiet.update(1,sources,{key:'ETH:1'});
 assert.equal(quiet.state.t,0);assert.equal(quiet.state.L,64);assert.ok(quiet.strengths.slice(0,64).every(v=>v===1));
});

test('evidence density counts only adopted sources and excludes inapplicable ones',()=>{
 const task={evidence:['retain','retain','context','pending','missing','conflict','na'].map(status=>({status}))};
 const before=structuredClone(task);
 assert.deepEqual(photonicEvidenceSummary(task),{total:6,used:2});
 assert.deepEqual(task,before);
 assert.deepEqual(photonicEvidenceSummary(null),{total:0,used:0});
});

test('glass stage labels fit the original face at mobile and desktop sizes',()=>{
 for(const [width,height] of [[96,128],[124,164],[142,200],[180,240]])for(const emWidth of [2,3.2,4.3,5.4]){
  const size=prismLabelSize(width,height,emWidth);
  assert.ok(size>0);
  assert.ok(size*emWidth<=width*.36+.01,'stage word stays inside the refracted glass face');
  assert.ok(size<=height*.12,'stage word stays above the light beam');
 }
 assert.ok(Number.isFinite(prismLabelSize(96,128,0)));
});

test('photonic decisions preserve research outcomes and require an explicitly linked trading session',()=>{
 const make=(symbol,outcome,phase='complete')=>({symbol,outcome,phase,evidence:[{key:'chain',sourceId:symbol,status:symbol==='SOL'?'conflict':'retain',text:'source'}]});
 const eth=make('ETH','candidate'),btc=make('BTC','watch'),sol=make('SOL','conflict'),xau=make('XAU','candidate','verify');
 const tasks=[eth,btc,sol,xau],before=structuredClone(tasks);
 const p=photonicProjection({}, {task:eth,linked:false,stages:[]},tasks,{state:'running',position:{symbol:'BTC'}});
 assert.deepEqual(p.buckets.ready.map(t=>t.symbol),['ETH']);
 assert.deepEqual(p.buckets.watch.map(t=>t.symbol),['BTC','XAU']);
 assert.deepEqual(p.buckets.blocked.map(t=>t.symbol),['SOL']);
 assert.equal(p.execution,'unassigned');
 assert.equal(p.sources.find(s=>s.key==='chain').received,4);
 assert.deepEqual(tasks,before);
 const approval=photonicProjection({}, {task:eth,linked:true,stages:[]},tasks,{state:'running',signal:{},session:{mode:'confirm'}});
 assert.equal(approval.execution,'approval');
 const empty=photonicProjection({}, {task:eth,linked:true},[],{state:'running'});
 assert.equal(empty.task,null);assert.equal(empty.execution,'unassigned');assert.equal(empty.total,0);
 assert.ok(empty.sources.every(source=>source.available===0));
 const tradfi=make('SPX','watch');
 const sparse=photonicProjection({}, {task:tradfi},[tradfi]);
 assert.equal(sparse.sources.find(source=>source.key==='chain').available,0);
 assert.equal(sparse.sources.find(source=>source.key==='depth').available,0);
 assert.ok(sparse.sources.find(source=>source.key==='macro').available>0);
});

test('eighteen research channels use the selected asset and preserve missing data and snapshot dates',()=>{
 const btc={symbol:'BTC',phase:'verify',outcome:'candidate',evidence:[{key:'risk',status:'pending'}]};
 const eth={symbol:'ETH',phase:'complete',outcome:'candidate',evidence:[]};
 const rows=[{symbol:'BTC',state:'ready',price:80001,change:1.25,sampleAt:1793836800,closedAt:1793923200,priceSeries:[79900,80001]},{symbol:'DXY',state:'ready',price:102.3,closedAt:1793923200}];
 const a=photonicChannels(btc,{context:()=>({price:138000})},'unassigned',rows);
 assert.equal(a.length,18);assert.equal(new Set(a.map(c=>c.id)).size,18);
 assert.equal(a.find(c=>c.id==='price').text,'80,001.00');
 assert.equal(a.find(c=>c.id==='whales').text,'—');
 assert.equal(a.find(c=>c.id==='whales').status,'na');
 assert.equal(a.find(c=>c.id==='authorization').text,'未开启');
 assert.equal(a.find(c=>c.id==='price').asOf,'2026-11-06T00:00:00.000Z');
 assert.equal(a.find(c=>c.id==='change').text,'1.25%');
 assert.equal(a.find(c=>c.id==='dollar').text,'102.30');
 assert.equal(a.find(c=>c.id==='price').origin,'market');
 assert.equal(a.find(c=>c.id==='oi').origin,'simulation');
 assert.equal(photonicChannels(btc,{context:()=>({price:138000})}).find(c=>c.id==='price').text,'—');
 assert.equal(photonicChannels(btc,{},'unassigned',[{...rows[0],state:'stale'}]).find(c=>c.id==='price').text,'—');
 assert.equal(a.find(c=>c.id==='oi').asOf,'2026-10-24 14:00');
 assert.notEqual(photonicChannels(eth,{}).find(c=>c.id==='whales').text,'—');
 assert.ok(photonicChannels(null,{}).every(c=>c.text==='—'));
 assert.equal(photonicOutcome(btc),'research');assert.equal(photonicOutcome(eth),'ready');
});

const liveMarketRows=research=>research.tasks.map((task,index)=>({
 ...task.observation,symbol:task.symbol,state:'ready',feedState:'snapshot',paused:false,
 price:100+index,change:index/10,x:index/10,y:50+index,bars:300,signal:'balanced',
 sampleAt:1793836800,closedAt:1793923200,validUntil:1794009600,priceSeries:[99+index,100+index]
}));

test('live channels expose only validated daily market data and never fixtures or trading authority',()=>{
 const research=new MarketResearch({now:()=>1793925000}),rows=liveMarketRows(research);research.ingestMarket(rows);
 const task=research.task('BTC'),before=structuredClone({task,rows}),fields=photonicChannels(task,research,'position',rows);
 assert.equal(fields.length,18);assert.deepEqual(fields.filter(field=>field.available).map(field=>field.id),['price','change','volume']);
 assert.equal(fields[0].text,'100.00');assert.equal(fields[0].origin,'market');assert.equal(fields[0].status,'retain');assert.equal(fields[0].asOf,'2026-11-06T00:00:00.000Z');
 for(const field of fields.slice(3)){
  assert.equal(field.text,'—',field.id);assert.equal(field.available,false,field.id);assert.equal(field.status,'missing',field.id);assert.equal(field.asOf,null,field.id);assert.equal(field.series,null,field.id);assert.equal(field.origin,'unavailable',field.id);
 }
 assert.deepEqual({task,rows},before);
 const tradfi=photonicChannels(research.task('US10Y'),research,'running',rows);
 assert.equal(tradfi[0].text,'107.00%');assert.ok(tradfi.filter(field=>field.source==='chain').every(field=>field.status==='na'&&!field.available));
 assert.ok(tradfi.filter(field=>field.source==='macro').every(field=>field.text==='—'&&!field.available),'DXY and US10Y market prices are not macro-event evidence');
});
test('live liquidity shows source-bound spot spread and partial depth, without derivative or trade claims',()=>{
 let clock=1793925000;const research=new MarketResearch({now:()=>clock}),rows=liveMarketRows(research);
 rows[0].depthState='ready';rows[0].depthSnapshot=normalizeSpotDepth({lastUpdateId:123,bids:[['99.99','2'],['99.90','3']],asks:[['100.01','4'],['100.10','5']]},'BTC',{requestStartedAt:clock*1000-10,receivedAt:clock*1000});
 research.ingestMarket(rows);const task=research.task('BTC'),fields=photonicChannels(task,research,'running',rows),depth=fields.filter(f=>f.source==='depth');
 assert.deepEqual(depth.map(f=>f.id),['spread','bidDepth','askDepth']);assert.deepEqual(depth.map(f=>f.text),['2.00 bps','≥499.68 USDT','≥900.54 USDT']);
 assert.ok(depth.every(f=>f.available&&f.status==='retain'&&f.origin==='depth'&&f.asOf==='2026-11-06T00:30:00.000Z'));
 assert.equal(depth[1].magnitude,rows[0].depthSnapshot.bidNotional);assert.equal(depth[2].magnitude,rows[0].depthSnapshot.askNotional);
 const projection=photonicProjection(research,{task},research.tasks,{},rows);
 assert.deepEqual(projection.sources.filter(s=>s.available>0).map(s=>s.key),['trend','depth']);assert.equal(photonicCoverage(projection).count,6);assert.equal(photonicCoverage(projection,'evidence').count,2);
 assert.doesNotMatch(photonicSourceGraphic('depth',depth),/NaN|Infinity/);assert.match(photonicSourceGraphic('depth',depth),/pw-micro-sample/);
 for(const patch of [{paused:true},{depthState:'error'},{depthSnapshot:{...rows[0].depthSnapshot,bidNotional:999}},{depthSnapshot:{...rows[0].depthSnapshot,source:'fixture'}}]){
  const invalid=photonicChannels(task,research,'running',[{...rows[0],...patch}]).filter(f=>f.source==='depth');assert.ok(invalid.every(f=>!f.available&&f.text==='—'));
 }
 clock+=30;const stale=photonicChannels(task,research,'running',rows);assert.ok(stale.filter(f=>f.source==='depth').every(f=>!f.available));assert.ok(stale.filter(f=>f.source==='trend').every(f=>f.available));
 assert.equal(research.handoff('BTC'),null);assert.equal(research.context('BTC').ready,false);
});
test('partial depth labels round downward even across compact currency units',()=>{
 const clock=1793925000,research=new MarketResearch({now:()=>clock}),row=liveMarketRows(research)[0],task=research.task('BTC');
 for(const [bid,ask,quantity,expected] of [['99.99','100.01','1.234','≥123.38 USDT'],['999.9','1000.1','123.4','≥123.38K USDT']]){
  const depthSnapshot=normalizeSpotDepth({lastUpdateId:123,bids:[[bid,quantity]],asks:[[ask,'1']]},'BTC',{requestStartedAt:clock*1000-10,receivedAt:clock*1000});
  const fields=photonicChannels(task,research,'running',[{...row,depthState:'ready',depthSnapshot}]);assert.equal(fields.find(f=>f.id==='bidDepth').text,expected);
 }
 const tinySpread=normalizeSpotDepth({lastUpdateId:124,bids:[['65000','1']],asks:[['65000.01','1']]},'BTC',{requestStartedAt:clock*1000-10,receivedAt:clock*1000});
 assert.equal(photonicChannels(task,research,'running',[{...row,depthState:'ready',depthSnapshot:tinySpread}]).find(f=>f.id==='spread').text,'<0.01 bps');
});

test('live availability fails closed for missing, expired, duplicate or invalid scanner rows',()=>{
 const research=new MarketResearch({now:()=>1793925000}),rows=liveMarketRows(research),task=research.task('BTC'),row=rows[0];
 for(const invalid of [[],[{...row,state:'stale'}],[{...row,source:'fixture'}],[{...row,paused:true}],[{...row,closedAt:1793926000}],[row,{...row,price:999}],[{...row,sampleAt:1793750400,closedAt:1793836800,validUntil:1793923200}]]){
  const fields=photonicChannels(task,research,'running',invalid);
  assert.ok(fields.every(field=>!field.available&&field.text==='—'&&field.asOf===null));
 }
 assert.ok(photonicChannels(null,research,'running',rows).every(field=>!field.available&&field.text==='—'));
});

test('eight live markets produce one real source group and consistent field and evidence coverage',()=>{
 const research=new MarketResearch({now:()=>1793925000}),rows=liveMarketRows(research);research.ingestMarket(rows);
 const tasks=research.tasks,task=research.task('BTC'),projection=photonicProjection(research,{task},tasks,{},rows);
 assert.equal(projection.completed,8);assert.equal(projection.received,8);assert.equal(projection.total,43);
 assert.deepEqual(projection.sources.filter(source=>source.available>0).map(source=>source.key),['trend']);
 assert.deepEqual(projection.sources.map(source=>source.received),[8,0,0,0,0,0]);
 assert.equal(photonicCoverage(projection).count,3);assert.equal(photonicCoverage(projection).total,18);
 assert.equal(photonicCoverage(projection,'evidence').count,1);assert.equal(photonicCoverage(projection,'evidence').total,6);
 const tradfi=photonicProjection(research,{task:research.task('SPX')},tasks,{},rows);
 assert.equal(tradfi.sources.find(source=>source.key==='chain').status,'na');assert.equal(photonicCoverage(tradfi,'evidence').total,5);
 const forged={...task,evidence:task.evidence.map(evidence=>({...evidence,status:'retain',text:'fixture evidence'}))};
 const isolated=photonicProjection(research,{task:forged},[forged],{},[]);
 assert.equal(photonicCoverage(isolated).count,0);assert.equal(photonicCoverage(isolated,'evidence').count,0);assert.equal(isolated.received,0);
 assert.ok(isolated.sources.every(source=>source.status==='missing'&&source.text!=='fixture evidence'));
});

test('live runtime keeps model roles and independent stages waiting before and after one real market observation',()=>{
 const research=new MarketResearch({now:()=>1793925000}),pending=research.tasks;
 const initial=photonicRuntime(research,pending);
 assert.equal(initial[1].summary.state,'active');assert.equal(initial[1].summary.done,0);
 for(const index of [0,2,3,4,5]){assert.equal(initial[index].summary.state,'waiting');assert.equal(initial[index].summary.progress,0);}
 assert.ok(initial.every(phase=>phase.roles.every(role=>role.state==='waiting'&&role.progress===0&&role.evidence===0)));
 research.ingestMarket(liveMarketRows(research).filter(row=>row.symbol==='BTC'));
 const tasks=research.tasks,before=structuredClone(tasks),runtime=photonicRuntime(research,tasks),btc=research.task('BTC');
 assert.equal(btc.phase,'complete');assert.equal(research.context('BTC').ready,false);assert.equal(research.handoff('BTC'),null);
 assert.equal(runtime[1].summary.done,1);assert.equal(runtime[5].summary.done,1);
 for(const key of ['queued','verify','queuedCore','core']){
  const phase=runtime.find(item=>item.key===key),summary=photonicPhaseSummary(key,tasks,research);
  assert.deepEqual(summary,phase.summary);assert.equal(summary.done,0);assert.equal(summary.progress,0);assert.equal(summary.state,'waiting');assert.equal(phase.tasks.length,0);assert.equal(phase.motionTasks.length,0);
  assert.equal(summary.basis,'roles');assert.equal(summary.total,18);assert.deepEqual(summary.assets,[]);
  const meter=photonicStageMeter(phase,tasks),readings=photonic.photonicRuntimeReadings(phase,null,true);
  assert.match(meter,/data-value="0"/);assert.match(meter,/<em>\/18<\/em>/);assert.match(meter,/aria-label="[^"]*0\/18/);
  assert.equal((meter.match(/data-meter-part="role-/g)||[]).length,18);assert.doesNotMatch(meter,/data-state="done"|data-state="active"|data-source=|BTC|ETH/);
  assert.equal((readings.match(/data-runtime-role="/g)||[]).length,18);assert.doesNotMatch(readings,/data-runtime-asset=|BTC|ETH|DXY/);
 }
 assert.deepEqual(photonicPhaseSummary('core',[btc],'live_readonly'),photonicPhaseSummary('core',[btc],research));
 assert.equal(photonicPhaseSummary('core',[btc]).state,'waiting','a live task cannot fall back to demo progression when the optional mode is omitted');
 assert.deepEqual(tasks,before);
});

test('whole-card asset readings and individual previews use the same verified values and missing states',()=>{
 const research=new MarketResearch({now:()=>1793925000}),rows=liveMarketRows(research);
 const btc=rows.find(row=>row.symbol==='BTC');btc.x=4.25;btc.y=0;
 rows.find(row=>row.symbol==='DXY').state='invalid';research.ingestMarket(rows);
 const tasks=research.tasks,runtime=photonicRuntime(research,tasks);
 for(const key of ['collect','complete']){
  const phase=runtime.find(item=>item.key===key),{summary}=phase,list=photonic.photonicRuntimeReadings(phase,null,true);
  assert.equal(summary.basis,'assets');assert.equal(summary.total,8);assert.equal(summary.done,7);assert.equal(summary.state,'partial');
  assert.match(photonicStageMeter(phase),/aria-label="[^"]*7\/8/);
  assert.deepEqual([...list.matchAll(/data-runtime-asset="([^"]+)"/g)].map(match=>match[1]),tasks.map(task=>task.symbol));
  for(const [i,asset] of summary.assets.entries()){
   const preview=photonic.photonicRuntimeReadings(phase,i);
   assert.equal((preview.match(/data-runtime-asset=/g)||[]).length,1);
   assert.ok(list.includes(`<dd>${asset.detail}</dd>`)&&preview.includes(`<dd>${asset.detail}</dd>`));
   if(asset.symbol==='DXY'){assert.equal(asset.reading,null);assert.equal(asset.state,'waiting');assert.match(asset.detail,/—.*校验|—.*validation/);}
   else assert.equal(asset.reading.label,asset.symbol+' · '+asset.detail);
  }
  assert.ok(list.includes(key==='collect'?'EMA20 · +4.25 ATR':'RSI 14 · 0.0'));
 }
 const sample=structuredClone(tasks.find(task=>task.symbol==='BTC'));sample.observation.rsi=null;
 const filtered=photonicRuntime(research,[sample]);
 assert.deepEqual(filtered.map(({summary})=>[summary.done,summary.total]),[[0,18],[1,1],[0,18],[0,18],[0,18],[0,1]]);
 assert.match(photonic.photonicRuntimeReadings(filtered[5],null,true),/RSI 14 · —/);
 assert.deepEqual(photonicRuntime(research,[]).map(({summary})=>summary.total),[18,0,18,18,18,0]);
});

test('eight market observations fill only collection and observation instruments and keep the main beam flowing',()=>{
 const research=new MarketResearch({now:()=>1793925000});research.ingestMarket(liveMarketRows(research));
 const tasks=research.tasks,runtime=photonicRuntime(research,tasks),meters=runtime.map(phase=>photonicStageMeter(phase,tasks));
 assert.deepEqual(runtime.map(phase=>phase.summary.done),[0,8,0,0,0,8]);
 assert.deepEqual(runtime.map(phase=>phase.summary.state),['waiting','done','waiting','waiting','waiting','done']);
 assert.match(meters[1],/data-value="8"/);assert.match(meters[1],/<em>\/8<\/em>/);assert.match(meters[5],/技术观察 8\/8|Technical observations 8\/8/);assert.doesNotMatch(meters[5],/Routed|已分流/);
 assert.ok(runtime.every(phase=>phase.roles.every(role=>role.state==='waiting')));
 assert.ok(runtime.every(phase=>phase.motionTasks.length===0),'a completed price snapshot cannot animate an uncalled review stage');
 const beam=createPhotonicCadence(),review=createPhotonicCadence('core');beam.observe([tasks[0]]);review.observe(runtime[4].motionTasks);
 for(let i=0;i<80;i++){beam.update(.05);review.update(.05);}
 assert.ok(beam.state.time>0);assert.equal(review.state.time,0);assert.equal(review.state.rate,0);assert.equal(research.summary().candidates,0);
});

test('paused or expired market data removes observation completion without promoting or retaining model progress',()=>{
 let clock=1793925000;const research=new MarketResearch({now:()=>clock}),rows=liveMarketRows(research);research.ingestMarket(rows);
 assert.equal(photonicRuntime(research,research.tasks)[5].summary.done,8);
 for(const transition of ['paused','expired']){
  if(transition==='paused')research.ingestMarket(rows.map(row=>({...row,paused:true})));else{research.ingestMarket(rows);clock=1794009601;}
  const tasks=research.tasks,runtime=photonicRuntime(research,tasks);
  assert.equal(tasks[0].observation.state,transition==='paused'?'paused':'stale');
  assert.ok(runtime.every(phase=>phase.summary.done===0&&phase.summary.progress===0&&phase.summary.state==='waiting'));
  assert.ok(runtime.every(phase=>phase.motionTasks.length===0));
  for(const phase of runtime)assert.doesNotMatch(photonicStageMeter(phase,tasks),/data-state="done"|data-state="ready"|data-state="active"/);
  assert.equal(research.context('BTC').ready,false);assert.equal(research.handoff('BTC'),null);
 }
});

test('a live phase flag or forged review progress cannot turn missing observations into completed AI work',()=>{
 const research=new MarketResearch({now:()=>1793925000}),tasks=research.tasks.map(task=>({...task,phase:'complete',progress:100,evidence:task.evidence.map(e=>({...e,status:'retain'}))}));
 const runtime=photonicRuntime(research,tasks);assert.ok(runtime.every(phase=>phase.summary.done===0&&phase.summary.progress===0));
 assert.ok(runtime.every(phase=>phase.roles.every(role=>role.state==='waiting')));
 const core=photonicPhaseSummary('core',tasks,research);assert.equal(core.state,'waiting');assert.equal(core.done,0);
});

test('explicit demo phase summaries and meters keep their original progression',()=>{
 const tasks=[{symbol:'BTC',phase:'complete',progress:100},{symbol:'ETH',phase:'verify',progress:50},{symbol:'SPX',phase:'collect',progress:20}];
 for(const key of ['queued','collect','verify','queuedCore','core','complete'])assert.deepEqual(photonicPhaseSummary(key,tasks,{mode:'simulation-only'}),photonicPhaseSummary(key,tasks));
 assert.equal(photonicPhaseSummary('core',tasks).done,1);assert.equal(photonicPhaseSummary('verify',tasks).active,1);
 const core=photonicStageMeter(photonicRuntime({},tasks)[4],tasks);assert.match(core,/判断已完成 1|Reviewed 1/);assert.match(core,/data-value="1"/);assert.doesNotMatch(core,/data-mode="live_readonly"/);
});

test('explicit demo mode retains fixture values, simulation origins and execution readout',()=>{
 const research=new MultiResearch(),task=research.tasks.find(task=>task.symbol==='BTC'),fields=photonicChannels(task,research,'paused');
 assert.notEqual(fields.find(field=>field.id==='oi').text,'—');assert.equal(fields.find(field=>field.id==='oi').origin,'simulation');
 assert.notEqual(fields.find(field=>field.id==='news').text,'—');assert.equal(fields.find(field=>field.id==='authorization').text,'已暂停');
 assert.equal(fields.find(field=>field.id==='oi').asOf,'2026-10-24 14:00');assert.ok(fields.every(field=>field.available===undefined));
 const projection=photonicProjection(research,{task},research.tasks);
 assert.equal(projection.mode,undefined);assert.ok(photonicCoverage(projection).count>3);
});

test('the optical view reuses Landing components without a triangle or central asset label',()=>{
 const workbench=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8').replaceAll('\r\n','\n');
 const marker='/* LANDING_NATIVE_BLOCK_RUNTIME:';
 const authored=workbench.split(marker)[0];
 const start=authored.indexOf('  function N() {',authored.indexOf('function createLandingPhotonicBeam('));
 const paintStart=authored.indexOf('    if (v.globalCompositeOperation = T.globalCompositeOperation = "source-over", l.fail >= 0) {',start);
 const paintEnd=authored.indexOf('\n  }\n  function Ze()',paintStart);
 const end=authored.indexOf('\n // Workbench adaptation of the Landing geometry',paintEnd);
 assert.ok(start>0&&paintStart>start&&paintEnd>paintStart&&end>paintEnd);
 // Pin the original beam geometry and its texture-only translation without distributing the separate Landing source.
 const digest=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(digest(authored.slice(start,paintStart)),'030ce86f20eca67aefb7b92f517161d9d2a7a6fa6a9363310e82c65bd1ec385e','Preserve the original multistrand drawing');
 assert.equal(digest(authored.slice(paintEnd,end)),'3b6dbcb8f6f50d5336102281aaaa47eaad246891e83c2479db961f777503feae','Preserve the clipped beam and its texture-only translation');
 const calls=[],ctx={beginPath(){},setLineDash(value){calls.push(['dash',...value]);},stroke(){calls.push(['stroke']);},fillRect(){calls.push(['marker']);},moveTo(){calls.push(['marker']);},lineTo(){calls.push(['marker']);}};
 const paintConflict=Function('v','T','l','B','te','r','d',authored.slice(paintStart,paintEnd));
 paintConflict(ctx,{}, {fail:2},(_ctx,_shape,lane)=>calls.push(['lane',lane]),()=>10,{xa:0,x1:100},1);
 assert.deepEqual(calls,[['lane',2],['dash',2,5],['stroke'],['dash']],'Keep the actual conflicting lane; do not stamp a black patch or cross over it');
 calls.length=0;paintConflict(ctx,{}, {fail:-1},()=>assert.fail('A healthy lane has no conflict overlay'),()=>10,{},1);assert.deepEqual(calls,[]);
 assert.ok(workbench.includes(marker),'Include the extracted original Landing renderer');
 assert.ok(authored.includes('LandingNativeBlock.createBlock('),'Mount the native rectangular glass component');
 assert.ok(!authored.includes('points="604,78 672,196 536,196"'),'Do not restore the rejected preloader triangle');
 assert.ok(authored.includes("querySelector('.pw-core-subject').textContent=''"),'Keep specific asset names outside the global optical center');
 assert.ok(authored.includes('M300 236 520 300 300 364 80 300Z'),'Reuse the original research art');
 assert.ok(authored.includes('M300 168 362 186 300 204 238 186Z'),'Reuse the original strategy art');
 assert.ok(!/<img[\s>]/.test(authored),'Render components instead of pasting a screenshot');
});


test('monitoring cycles available sources without changing their evidence or outcomes',()=>{
 const sources=[{key:'trend',available:3,status:'retain'},{key:'chain',available:0,status:'na'},{key:'risk',available:2,status:'context'}],before=structuredClone(sources);
 assert.equal(photonicMonitorSource(sources,0),'trend');
 assert.equal(photonicMonitorSource(sources,1.19),'trend');
 assert.equal(photonicMonitorSource(sources,1.2),'risk');
 assert.equal(photonicMonitorSource(sources,2.4),'trend');
 assert.equal(photonicMonitorSource(sources,-1),'trend');
 assert.equal(photonicMonitorSource([{key:'chain',available:0}],3),null);
 assert.equal(photonicMonitorSource([],0),null);
 assert.deepEqual(sources,before);
});


test('runtime maps six phases and eighteen roles to existing task state without inventing work',()=>{
 const research={groups:[{station:0,roles:[0,1,2],task:'BTC',label:'Market'},{station:1,roles:[3],task:'ETH',label:'Chain'}]},tasks=[{symbol:'BTC',group:0,phase:'verify',version:2,progress:40,evidence:[{status:'retain'}]},{symbol:'ETH',group:1,phase:'collect',progress:20,executionWaiting:true}],before=structuredClone({research,tasks});
 const matrix=photonicRuntime(research,tasks);
 assert.equal(matrix.length,6);assert.ok(matrix.every(phase=>phase.roles.length===18));
 assert.equal(matrix[0].roles[0].state,'done');assert.equal(matrix[2].roles[0].state,'active');assert.equal(matrix[3].roles[0].state,'waiting');
 assert.equal(matrix[2].roles[0].symbol,'BTC');assert.equal(matrix[2].roles[0].version,2);assert.equal(matrix[2].roles[0].evidence,1);
 assert.equal(matrix[1].roles[3].state,'waiting');assert.equal(matrix[0].roles[17].state,'idle');
 assert.deepEqual({research,tasks},before);assert.ok(photonicRuntime({},[]).every(phase=>phase.roles.every(role=>role.state==='idle')));
});
test('patrol follows the supplied research universe and wraps without adding symbols',()=>{
 const tasks=[{symbol:'BTC'},{symbol:'ETH'},{symbol:'SPX'}];
 assert.equal(photonicPatrolSymbol(tasks,'BTC'),'ETH');assert.equal(photonicPatrolSymbol(tasks,'SPX'),'BTC');
 assert.equal(photonicPatrolSymbol(tasks,'BTC',11.99),null);assert.equal(photonicPatrolSymbol(tasks,'BTC',12),'ETH');assert.equal(photonicPatrolSymbol(tasks,'BTC',NaN),null);
 assert.equal(photonicPatrolSymbol(tasks,'UNKNOWN'),'BTC');assert.equal(photonicPatrolSymbol(tasks.slice(0,1),'BTC'),null);assert.equal(photonicPatrolSymbol([],'BTC'),null);
});


test('phase gauges use distinct instruments and preserve supplied task counts',()=>{
 const tasks=[{symbol:'BTC',group:0,phase:'complete',outcome:'watch',progress:100},{symbol:'ETH',group:1,phase:'complete',outcome:'candidate',progress:100},{symbol:'SOL',group:2,phase:'complete',outcome:'conflict',progress:100}],before=structuredClone(tasks),phases=photonicRuntime({},tasks),gauges=phases.map(phase=>photonicStageMeter(phase,tasks));
 assert.equal(new Set(gauges).size,6);assert.deepEqual(tasks,before);
 assert.ok(gauges.every(markup=>markup.includes('meter-optical')&&markup.includes('<svg')));
 assert.equal((gauges[2].match(/class="stats-cell"/g)||[]).length,0,'no evidence means no invented check cells');
 assert.ok(!gauges[3].includes('stats-line'),'no observed history means no invented trend');
 assert.equal((gauges[5].match(/data-count="1"/g)||[]).length,3);assert.ok(gauges[5].includes('data-value="3"'));
 assert.ok(gauges.every(svg=>!svg.includes('NaN')));
});

test('stage instruments show source availability and conflicts without fabricating missing inputs',()=>{
 const tasks=[{symbol:'BTC',group:0,phase:'verify',progress:50,evidence:[{key:'trend',status:'retain'},{key:'depth',status:'conflict'},{key:'chain',status:'pending'},{key:'macro',status:'na'}]}],research={groups:[{station:0,roles:[0,1,2],task:'BTC'}]};
 const phases=photonicRuntime(research,tasks),meters=phases.map(p=>photonicStageMeter(p,tasks));
 assert.ok(meters[0].includes('data-value="3"'));
 assert.ok(meters[1].includes('data-value="2"'));
 assert.ok(meters[2].includes('data-state="conflict"'));assert.ok(meters[2].includes('data-value="2"'));
 assert.match(meters[2],/data-source="chain" data-state="waiting" data-count="0" data-total="1"/);assert.match(meters[2],/data-source="macro" data-state="waiting" data-count="0" data-total="0"/);assert.equal((meters[2].match(/data-total="1"/g)||[]).length,3,'three applicable inputs remain represented by their actual source');
 assert.ok(!meters[2].includes('data-state="na"'));
 const empty=photonicRuntime({},[]).map(p=>photonicStageMeter(p,[]));assert.ok(empty.every(markup=>!markup.includes('stats-end')&&!markup.includes('data-state="done"')));
 assert.equal((empty[0].match(/data-state="idle"/g)||[]).length,18);
 assert.equal((empty[1].match(/data-source=/g)||[]).length,6);
 assert.equal((empty[5].match(/data-count="0"/g)||[]).length,3);
});

test('merge paths reflect only queued evidence and retain a quiet waiting structure',()=>{
 const tasks=[{symbol:'BTC',phase:'queuedCore',evidence:[{key:'trend',status:'retain'},{key:'depth',status:'conflict'},{key:'chain',status:'pending'}]},{symbol:'ETH',phase:'complete',evidence:[{key:'social',status:'retain'}]}],before=structuredClone(tasks);
 const phase=photonicRuntime({},tasks)[3],markup=photonicStageMeter(phase,tasks);
 assert.equal((markup.match(/class="lsdt-source-block"/g)||[]).length,6);
 assert.match(markup,/data-source="trend" data-state="ready" data-count="1"/);
 assert.match(markup,/data-source="depth" data-state="conflict" data-count="1"/);
 assert.match(markup,/data-source="social" data-state="waiting" data-count="0"/);
 assert.match(markup,/data-visual="blocks"/);assert.match(markup,/data-value="1"/);
 const idle=photonicStageMeter(photonicRuntime({},[])[3],[]);
 assert.equal((idle.match(/data-state="waiting"/g)||[]).length,6);
 assert.ok(!idle.includes('stats-line')&&!idle.includes('data-state="active"'));assert.deepEqual(tasks,before);
});

test('review checkpoints show actual progress or completion without an invented sparkline',()=>{
 for(const [tasks,ratio] of [[[],0],[[{phase:'core',progress:80,evidence:[]}],.8],[[{phase:'complete',evidence:[]},{phase:'verify',evidence:[]}],.5]]){
  const markup=photonicStageMeter(photonicRuntime({},tasks)[4],tasks);
  assert.match(markup,new RegExp(`data-completion="${ratio}"`));
  assert.match(markup,/data-visual="rise"/);assert.equal((markup.match(/class="lsdt-review-step"/g)||[]).length,tasks.length);
  assert.doesNotMatch(markup,/class="lsdt-step"|class="lsdt-review-step" d="[^"]*Z/);
  assert.ok(!markup.includes('stats-line')&&!markup.includes('stats-end'));
  if(!tasks.length)assert.ok(!markup.includes('data-state="done"'));
 }
});

test('stage markup retains its SVG on identical data and flashes only on an actual visible update',()=>{
 let writes=0,pulses=0;const svg={animate(){pulses++;}},node={get innerHTML(){throw Error('serialized DOM is not a revision');},set innerHTML(value){writes++;},querySelector(){return svg;},querySelectorAll(){return [];}};
 updatePhotonicMeter(node,'first',true);assert.equal(writes,1);assert.equal(pulses,0);
 for(let i=0;i<30;i++)updatePhotonicMeter(node,'first',true);
 assert.equal(writes,1);assert.equal(pulses,0);
 updatePhotonicMeter(node,'new count',true);assert.equal(writes,2);assert.equal(pulses,1);
 updatePhotonicMeter(node,'hidden update',false);assert.equal(writes,3);assert.equal(pulses,1);
});

test('successive core progress updates keep the complete chart visible during their feedback',()=>{
 let markup='',effects=[];
 const svg={animate(frames,options){effects.push({frames,options});}},node={set innerHTML(value){markup=value;},querySelector(){return svg;},querySelectorAll(){return [...markup.matchAll(/<g data-meter-part="([^"]+)"[^>]*>[\s\S]*?<\/g>/g)].map(match=>({...svg,dataset:{meterPart:match[1]},outerHTML:match[0]}));}};
 for(let progress=76;progress<=99;progress++){
  const tasks=[{symbol:'BTC',phase:'core',progress,evidence:[]}];
  const drawing=photonicStageMeter(photonicRuntime({},tasks)[4],tasks);
  updatePhotonicMeter(node,drawing,true);assert.equal(markup,drawing);
 }
 assert.equal(effects.length,23);
 for(const {frames,options} of effects){
  assert.deepEqual(frames,[{opacity:.72},{opacity:1}]);
  assert.ok(options.duration<7000/23,'feedback finishes before the next real progress tick');
 }
 updatePhotonicMeter(node,markup,true);assert.equal(effects.length,23);
 updatePhotonicMeter(node,'paused or reduced-motion update',false);assert.equal(effects.length,23);
});

test('collection ticks count individual applicable inputs, including quiet missing slots',()=>{
 const tasks=[{symbol:'BTC',phase:'collect',evidence:[{key:'trend',status:'retain'},{key:'depth',status:'pending'},{key:'chain',status:'na'}]},{symbol:'ETH',phase:'collect',evidence:[{key:'trend',status:'collected'},{key:'depth',status:'missing'}]}],before=structuredClone(tasks);
 const drawing=photonicStageMeter(photonicRuntime({},tasks)[1],tasks);
 assert.match(drawing,/data-value="2"/);assert.match(drawing,/<em>\/4<\/em>/);
 assert.equal((drawing.match(/class="lsdt-sample"/g)||[]).length,4);
 assert.equal((drawing.match(/class="lsdt-sample" data-state="ready"/g)||[]).length,2);
 assert.equal((drawing.match(/class="lsdt-sample" data-state="waiting"/g)||[]).length,2);
 assert.match(drawing,/data-source="chain" data-count="0" data-total="0"/);
 assert.doesNotMatch(drawing,/class="lsdt-step"/);assert.deepEqual(tasks,before);
});

test('review staircase earns its height from every asset rather than four fixed template levels',()=>{
 const tasks=[{symbol:'BTC',phase:'core',progress:75},{symbol:'ETH',phase:'core',progress:25},{symbol:'SOL',phase:'verify',progress:90}],before=structuredClone(tasks);
 const drawing=photonicStageMeter(photonicRuntime({},tasks)[4],tasks);
 assert.match(drawing,/data-value="50"/);assert.match(drawing,/data-completion="0.5"/);
 assert.match(drawing,/data-meter-part="review-BTC" data-state="active" data-progress="0.75"/);
 assert.match(drawing,/data-meter-part="review-ETH" data-state="active" data-progress="0.25"/);
 assert.doesNotMatch(drawing,/data-meter-part="review-SOL"/,'current review progress does not mix in another stage');
 assert.match(drawing,/d="M50 27V24H92"/,'the endpoint agrees with the displayed current review percentage');
 assert.equal((drawing.match(/class="lsdt-review-point"/g)||[]).length,2);
 assert.deepEqual(tasks,before);
 const complete=tasks.map(task=>({...task,phase:'complete'})),finished=photonicStageMeter(photonicRuntime({},complete)[4],complete);
 assert.match(finished,/data-completion="1"/);assert.match(finished,/cy="12"/,'full review reaches the true endpoint');
 const waiting=[{symbol:'BTC',phase:'complete'},{symbol:'SOL',phase:'verify',progress:90}],partial=photonicStageMeter(photonicRuntime({},waiting)[4],waiting);
 assert.match(partial,/data-value="1"/);assert.match(partial,/d="M50 24V24H92"/,'a task outside review contributes no fabricated completion');
});

test('only changed data groups receive feedback; static, paused and hidden updates stay still',()=>{
 let markup='',pulses=[];
 const node={set innerHTML(value){markup=value;},querySelector(){throw Error('grouped instruments must not flash the whole card');},querySelectorAll(){return [...markup.matchAll(/<g data-meter-part="([^"]+)"[^>]*>[\s\S]*?<\/g>/g)].map(match=>({dataset:{meterPart:match[1]},outerHTML:match[0],animate(){pulses.push(match[1]);}}));}};
 const tasks=[{symbol:'BTC',phase:'collect',evidence:[{key:'trend',status:'pending'},{key:'depth',status:'retain'}]}],draw=()=>photonicStageMeter(photonicRuntime({},tasks)[1],tasks);
 updatePhotonicMeter(node,draw(),true);assert.deepEqual(pulses,[]);
 tasks[0].evidence[0].status='collected';updatePhotonicMeter(node,draw(),true);assert.deepEqual(pulses,['source-trend']);
 for(let i=0;i<10;i++)updatePhotonicMeter(node,draw(),true);assert.equal(pulses.length,1);
 tasks[0].evidence[0].status='retain';updatePhotonicMeter(node,draw(),true);assert.equal(pulses.length,1,'reviewing the same available input does not invent a new arrival');
 tasks[0].evidence[1].status='missing';updatePhotonicMeter(node,draw(),false);assert.equal(pulses.length,1);
 tasks[0].evidence[1].status='retain';updatePhotonicMeter(node,draw(),true);assert.deepEqual(pulses,['source-trend','source-depth']);
});

test('stage summaries cover multiple assets and count actual progression without role codes',()=>{
 const tasks=[{symbol:'BTC',phase:'complete'},{symbol:'ETH',phase:'verify',progress:50},{symbol:'SPX',phase:'collect',progress:20}];
 const summary=photonicPhaseSummary('verify',tasks);assert.deepEqual(summary.assets.map(a=>a.symbol),['BTC','ETH','SPX']);assert.equal(summary.active,1);assert.equal(summary.done,1);assert.equal(summary.progress,50);assert.equal(summary.state,'active');
 assert.equal(photonicPhaseSummary('complete',tasks).done,1);assert.equal(photonicPhaseSummary('queued',tasks).state,'done');assert.equal(photonicPhaseSummary('verify',[]).progress,0);
});

test('Dot Tiles preserve the original dot glyphs and visual families with true values',()=>{
 const tasks=[{phase:'core',progress:88,evidence:[{key:'trend',status:'retain'}]}],phases=photonicRuntime({},tasks),tiles=phases.map(p=>photonicStageMeter(p,tasks));
 assert.deepEqual(tiles.map(s=>s.match(/data-visual="([^"]+)"/)[1]),['slider','steps','dots','blocks','rise','dots']);
 const core=tiles[4];assert.ok(core.includes('data-value="88"'));assert.match(core,/viewBox="0 0 11 7"/);assert.equal((core.match(/<circle cx=/g)||[]).length,34,'original Louis Studios 8 uses 17 dots');
 assert.ok(core.includes('正在研判 88%'));assert.ok(tiles.every(s=>!s.includes('setInterval')&&!s.includes('Math.random')&&!s.includes('Louis Studios')));
 const pending=photonicStageMeter(photonicRuntime({},[])[4],[]);assert.ok(pending.includes('data-value="—"'));assert.equal((pending.match(/<circle cx=/g)||[]).length,3,'unknown remains a dash, never a zero');
});

test('side-by-side instruments fit their canvas at empty, partial and complete counts',()=>{
 const evidence=['trend','depth','chain','macro','social','risk'].map(key=>({key,status:'retain'}));
 for(const taskPhase of ['queued','collect','verify','queuedCore','core','complete'])for(const progress of [0,45,100]){
  const tasks=[{symbol:'BTC',group:0,phase:taskPhase,progress,outcome:'candidate',evidence}],research={groups:[{station:0,roles:Array.from({length:18},(_,i)=>i),task:'BTC'}]};
  for(const phase of photonicRuntime(research,tasks)){
   const markup=photonicStageMeter(phase,tasks),visual=markup.split('class="lsdt-visual"')[1];
   assert.match(visual,/viewBox="0 0 100 48"/);assert.doesNotMatch(visual,/preserveAspectRatio="none"|NaN|Infinity/);
   for(const match of visual.matchAll(/<(rect|circle)\b([^>]*)\/?\s*>/g)){
    const attrs=Object.fromEntries([...match[2].matchAll(/(x|y|width|height|cx|cy|r)="([\d.-]+)"/g)].map(m=>[m[1],Number(m[2])]));
    const left=match[1]==='rect'?attrs.x:attrs.cx-attrs.r,top=match[1]==='rect'?attrs.y:attrs.cy-attrs.r,right=match[1]==='rect'?left+attrs.width:attrs.cx+attrs.r,bottom=match[1]==='rect'?top+attrs.height:attrs.cy+attrs.r;
    assert.ok(left>=0&&top>=0&&right<=100&&bottom<=48,'data marks must not clip or stretch outside the compact instrument');
   }
  }
 }
});

import {normalizeResearchBackground} from './market-hub-data.mjs';
function sharedBackgroundRows(at){
 const day=Math.floor(at/86400000)*86400000;
 return ['sentiment','chains','stablecoins'].map(resource=>({resource,state:'ready',snapshot:normalizeResearchBackground({schema:'public-market-relay-v1',resource,receivedAt:at,body:resource==='sentiment'?{data:[{timestamp:String(day/1000),value:'37'}]}:resource==='chains'?[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500}]:[{date:day/1000,totalCirculatingUSD:{peggedUSD:120}}]},resource,at)}));
}
test('live source cards expose limited context with source clocks while retaining unconnected events, posts and flows',()=>{
 let now=1793925000;const research=new MarketResearch({now:()=>now}),rows=liveMarketRows(research);research.ingestMarket(rows);research.ingest(sharedBackgroundRows(now*1000));
 for(const symbol of ['BTC','ETH','SOL']){
  const task=research.task(symbol),projection=photonicProjection(research,{task},research.tasks,{},rows),fields=projection.channels,background=fields.filter(field=>field.status==='context');
  assert.equal(fields.length,18);assert.equal(new Set(fields.map(field=>field.id)).size,18);assert.equal(background.length,2);
  assert.ok(background.every(field=>field.available&&field.origin==='background'&&field.provider&&field.asOf===(field.timeBasis==='retrieval-time'?'2026-11-06T00:30:00.000Z':'2026-11-06T00:00:00.000Z')));
  assert.equal(fields.find(field=>field.id==='calendar').status,'missing');assert.equal(fields.find(field=>field.id==='netflow').status,'missing');assert.equal(fields.find(field=>field.id==='posts').status,'missing');assert.equal(fields.find(field=>field.id==='news').status,'missing');
  assert.equal(projection.sources.find(source=>source.key==='macro').status,'context');assert.match(projection.sources.find(source=>source.key==='macro').text,/120/);
  assert.equal(photonicCoverage(projection,'evidence').count,1,'background is never a retained or verified source');assert.equal(research.context(symbol).ready,false);assert.equal(research.handoff(symbol),null);
  assert.ok(photonicRuntime(research,research.tasks).filter(phase=>['verify','queuedCore','core'].includes(phase.key)).every(phase=>phase.summary.done===0));
 }
 const btc=photonicChannels(research.task('BTC'),research,'unassigned',rows);assert.equal(btc.find(field=>field.id==='btcSentiment').text,'37 / 100');assert.equal(btc.find(field=>field.id==='btcSentiment').provider,'Alternative.me');
 const eth=photonicChannels(research.task('ETH'),research,'unassigned',rows),tvl=eth.find(field=>field.id==='chainTvl');assert.equal(tvl.text,'1K USD');assert.equal(tvl.timeBasis,'retrieval-time');assert.equal(tvl.asOf,'2026-11-06T00:30:00.000Z');
 for(const key of ['chain','macro','social']){const graphic=photonicSourceGraphic(key,(key==='chain'?eth:btc).filter(field=>field.source===key));if(key!=='chain'||tvl)assert.match(graphic,/背景快照|Context snapshot/);assert.doesNotMatch(graphic,/NaN|Infinity/);}
 const tradfi=photonicProjection(research,{task:research.task('SPX')},research.tasks,{},rows);assert.equal(tradfi.sources.find(source=>source.key==='chain').status,'na');assert.ok(tradfi.sources.filter(source=>['macro','social'].includes(source.key)).every(source=>source.status==='missing'));
 now+=900;assert.equal(photonicProjection(research,{task:research.task('ETH')},research.tasks,{},rows).sources.find(source=>source.key==='chain').status,'missing');
 research.ingest([{resource:'sentiment',state:'paused',snapshot:null}]);assert.ok(photonicChannels(research.task('BTC'),research,'unassigned',rows).filter(field=>field.source==='social').every(field=>!field.available&&field.status==='missing'));
});
test('photonic context requires the current matching source evidence and does not accept stale or forged labels',()=>{
 let now=1793925000;const research=new MarketResearch({now:()=>now});research.ingest(sharedBackgroundRows(now*1000));const task=research.task('BTC'),snapshot=research.background.sentiment.snapshot;
 for(const patch of [{sourceId:'invented'},{source:'Fixture'},{text:'资金流已核验'},{asOf:snapshot.asOf+1},{validUntil:snapshot.validUntil+1},{status:'retain'}]){
  const forged={...task,evidence:task.evidence.map(item=>item.key==='social'?{...item,...patch}:item)};assert.ok(photonicChannels(forged,research).filter(field=>field.source==='social').every(field=>!field.available));
 }
 now=snapshot.validUntil/1000;assert.ok(photonicChannels(task,research).every(field=>field.origin!=='background'));
});
test('the actual source-card renderer labels available background as Context and shows its value and provenance',()=>{
 const source=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8'),body=source.match(/root\.querySelectorAll\('\.pw-inputs>\[data-pw-source\]'\)\.forEach\(\(button,i\)=>\{([\s\S]*?)\n  \}\);/)[1];
 const sourceDefs=Function('return '+source.match(/const SOURCES=(\[[\s\S]*?\n\]);/)[1])(),states=Function('return '+source.match(/const STATES=(\{[^\n]+\});/)[1])();
 const research=new MarketResearch({now:()=>1793925000});research.ingest(sharedBackgroundRows(1793925000000));const task=research.task('BTC'),projection=photonicProjection(research,{task},research.tasks);
 let flashes=0;
 const nodes=new Map(),button={dataset:{},parentElement:{dataset:{inView:'true'}},style:{setProperty(){}},setAttribute(){},querySelector(key){if(!nodes.has(key))nodes.set(key,{textContent:'',innerHTML:'',dataset:{},animate(){flashes++;}});return nodes.get(key);}};
 const render=Function('button','i','sources','channels','source','live','task','moving','document','SOURCES','STATES','L','esc','channelAvailable','photonicSourceGraphic',body);
 const draw=(subject=task,moving=true)=>render(button,4,projection.sources,projection.channels,'social',true,subject,moving,{hidden:false,documentElement:{lang:'zh'}},sourceDefs,states,(zh)=>zh,value=>String(value),field=>field.available,photonicSourceGraphic);
 draw();draw();assert.equal(flashes,0);
 const field=projection.channels.find(field=>field.id==='btcSentiment');
 projection.sources[4].signature+=':new-timestamp';draw();assert.equal(flashes,0);
 field.text='38 / 100';draw();draw();assert.equal(flashes,1);
 field.text='39 / 100';draw(task,false);draw();assert.equal(flashes,1);
 button.parentElement.dataset.inView='false';field.text='40 / 100';draw();assert.equal(flashes,1);
 button.parentElement.dataset.inView='true';field.text='37 / 100';draw({...task,symbol:'ETH'});assert.equal(flashes,1);
 assert.equal(nodes.get('.pw-src-tag').textContent,'背景参考');assert.equal(nodes.get('.pw-source-value').textContent,'37 / 100');assert.equal(nodes.get('.pw-source-value').dataset.label,'BTC 日度情绪');assert.match(nodes.get('.pw-source-value').title,/Alternative.me/);assert.match(nodes.get('.pw-source-value').title,/2026-11-06T00:00:00.000Z/);assert.doesNotMatch(nodes.get('.pw-src-tag').textContent,/已核对|已采用/);
});

const jobViewNow=1793925000000,jobOwner='wallet:56:0x'+'a'.repeat(40);
function currentJobContext(status='processing'){
 const research=new MarketResearch({now:()=>jobViewNow/1000});research.ingestMarket(liveMarketRows(research));
 const task=research.task('BTC'),context={research,tasks:research.tasks,focus:{task},trade:{},marketRows:[],researchIdentity:{ownerRef:jobOwner,expiresAt:jobViewNow+604800000}};
 context.researchJob={status,ownerRef:jobOwner,requestId:'research-view-1234',symbols:['BTC'],createdAt:jobViewNow-10000,result:null,error:null,mode:'live_readonly',executionAuthority:'NONE',queryOriginalRequest:status!=='complete'};
 if(status==='complete')context.researchJob.result={method:'ai',model:'openai/gpt-4.1-mini',responseId:'gen-view-1234',createdAt:jobViewNow-1000,validUntil:1794009600000,executionAuthority:'NONE',methodVersion:'closed-market-research-v1',sources:[{symbol:'BTC',validUntil:1794009600}],output:{outcome:'watch',headline:'Momentum needs confirmation',summary:'The closed daily evidence remains mixed.',claims:[]}};
 return context;
}
// Exercise the exact renderer expressions without starting WebGL or a browser.
function renderCurrentJob(context,now=jobViewNow){
 const source=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8');
 const phase=source.match(/^  const live=projection\.mode[^\n]+/m)?.[0],heading=source.match(/^  laneControls\.querySelector\('\.pw-runtime-heading b'\)[^\n]+/m)?.[0];
 const begin=source.indexOf('  {const steps={queued:'),end=source.indexOf("\n  root.querySelector('.pw-core-state')",begin),stamp=source.match(/^  const stamp=\[[^\n]+/m)?.[0],core=source.match(/^  root\.querySelector\('\.pw-core-state'\)[^\n]+/m)?.[0];
 assert.ok(phase&&heading&&begin>=0&&end>begin&&stamp&&core,'exercise the current central labels, runtime heading and update stamp');
 const projection=photonicProjection(context.research,context.focus,context.tasks,context.trade,context.marketRows);
 const phases=Function('return '+source.match(/const PHASES=(\{[^\n]+\});/)[1])();
 return Function('context','projection','photonicRuntime','photonicResearchJobView','L','PHASES',`
  const {research,tasks}=context,{task,sources,stages,execution}=projection;
  const nodes=new Map(),laneControls={querySelector(key){if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}},document={documentElement:{lang:'en'}},source='trend',output=null;
  const coreNode={},root={dataset:{},querySelector(){return coreNode;}},lens={index:''};
  let word,index;function setLens(nextWord,nextIndex){word=nextWord;index=nextIndex;lens.index=nextIndex;}
  ${phase}
  ${heading}
  ${source.slice(begin,end)}
  ${core}
  ${stamp}
  return {phaseLabel,heading:nodes.get('.pw-runtime-heading span').textContent,word,index,stamp,title:coreNode.title,status:root.dataset.researchJob};
 `)(context,projection,photonicRuntime,(...args)=>photonic.photonicResearchJobView(...args.slice(0,3),now),jobCopy,phases);
}

test('current AI research drives the actual live heading and prism through processing, completion and failure',()=>{
 const context=currentJobContext(),before=structuredClone(context.research.tasks),processing=renderCurrentJob(context);
 assert.equal(processing.phaseLabel,jobCopy('AI 研究进行中','AI research in progress'));assert.equal(processing.heading,'BTC · '+processing.phaseLabel);assert.equal(processing.word,jobCopy('分析','Analyze'));assert.equal(processing.index,jobCopy('只读','Read-only'));
 context.researchJob=currentJobContext('complete').researchJob;
 const complete=renderCurrentJob(context);assert.equal(complete.phaseLabel,jobCopy('AI 研究完成','AI research complete'));assert.equal(complete.heading,'BTC · '+complete.phaseLabel);assert.equal(complete.word,jobCopy('观察','Watch'));assert.equal(complete.title,'Momentum needs confirmation');assert.equal(complete.status,'complete');assert.notEqual(complete.stamp,processing.stamp);
 for(const [outcome,zh,en]of [['conflict','分歧','Conflict'],['insufficient','待证','Evidence']]){context.researchJob.result.output.outcome=outcome;assert.equal(renderCurrentJob(context).word,jobCopy(zh,en));}
 context.researchJob={...currentJobContext().researchJob,status:'service-unavailable',error:'MODEL_TIMEOUT',queryOriginalRequest:false};
 const failed=renderCurrentJob(context);assert.equal(failed.phaseLabel,jobCopy('AI 研究失败','AI research failed'));assert.equal(failed.heading,'BTC · '+failed.phaseLabel);assert.equal(failed.word,jobCopy('失败','Failed'));assert.equal(failed.title,'');assert.notEqual(failed.stamp,complete.stamp);
 for(const phase of photonicRuntime(context.research,context.tasks)){
  assert.ok(phase.roles.every(role=>role.state==='waiting'));
  if(['queued','verify','queuedCore','core'].includes(phase.key))assert.equal(phase.summary.progress,0);
 }
 assert.deepEqual(context.research.tasks,before,'displaying one model job does not mutate market tasks, evidence, outcomes or execution');
 assert.equal(context.research.context('BTC').ready,false);assert.equal(context.research.handoff('BTC'),null);
});

test('unknown and expired jobs never claim completion and visual pause does not pause the actual request',()=>{
 const context=currentJobContext(),processing=renderCurrentJob(context);context.paused=true;
 assert.deepEqual(renderCurrentJob(context),processing);
 context.researchJob.status='unknown';context.researchJob.error='OUTCOME_UNKNOWN';
 const unknown=renderCurrentJob(context);assert.equal(unknown.phaseLabel,jobCopy('原请求待确认','Original request unconfirmed'));assert.equal(unknown.word,jobCopy('待确认','Confirm'));
 context.researchJob.status='service-unavailable';assert.equal(renderCurrentJob(context).phaseLabel,jobCopy('原请求待确认','Original request unconfirmed'),'transport failure with an unresolved original request is not a confirmed model failure');
 context.researchJob=currentJobContext('complete').researchJob;
 const expired=renderCurrentJob(context,context.researchJob.result.validUntil);assert.equal(expired.phaseLabel,jobCopy('AI 报告已过期','AI report expired'));assert.equal(expired.word,jobCopy('已过期','Expired'));assert.doesNotMatch(expired.heading,/complete|pending|研究完成/i);
 const first=renderCurrentJob(currentJobContext()),next=currentJobContext();next.researchJob.requestId='research-view-5678';assert.notEqual(renderCurrentJob(next).stamp,first.stamp,'a new current request refreshes unchanged market UI');
});

test('current-job projection rejects missing identity, wrong owner or asset, invalid request and stale claims',()=>{
 const base=currentJobContext('complete'),view=(context,now=jobViewNow)=>photonic.photonicResearchJobView(context.focus.task,context.researchJob,context.researchIdentity,now);
 assert.equal(view(base)?.status,'complete');
 const variants=[
  context=>{context.researchIdentity=null;},
  context=>{context.researchIdentity.ownerRef='wallet:56:0x'+'b'.repeat(40);},
  context=>{context.researchIdentity.expiresAt=jobViewNow;},
  context=>{context.researchJob.symbols=['ETH'];},
  context=>{context.researchJob.symbols=['BTC','ETH'];},
  context=>{context.researchJob.result.sources[0].symbol='ETH';},
  context=>{context.researchJob.result.sources=[null];},
  context=>{context.researchJob.result.sources=[];},
  context=>{context.researchJob.requestId='bad';},
  context=>{context.researchJob.createdAt=jobViewNow+1;},
  context=>{context.researchJob.result.createdAt=jobViewNow+1;},
  context=>{context.researchJob.result.executionAuthority='EXECUTE';},
  context=>{context.researchJob.result.output.outcome='buy';},
  context=>{context.researchJob.mode='demo';},
  context=>{context.focus.task.mode='demo';}
 ];
 for(const change of variants){const context=currentJobContext('complete');change(context);assert.equal(view(context),null);}
 const wrongOwner=currentJobContext('complete');wrongOwner.researchIdentity.ownerRef+='other';const rejected=renderCurrentJob(wrongOwner);assert.equal(rejected.status,'none');assert.equal(rejected.title,'');assert.equal(rejected.heading,jobCopy('行情观察','Market observation'));assert.equal(rejected.phaseLabel,jobCopy('行情观察完成','Market observation complete'));
 assert.equal(view(base,Number.NaN),null);assert.equal(view(base,-1),null);
 const expired=currentJobContext('complete');expired.researchJob.result.validUntil=jobViewNow;expired.researchJob.result.sources[0].validUntil=jobViewNow/1000;
 assert.equal(view(expired)?.status,'expired');assert.notEqual(view(expired)?.word,jobCopy('观察','Watch'));
});

test('explicit demo keeps its original stage labels even if a real job context is supplied',()=>{
 const context=currentJobContext('complete');context.research={time:0};context.tasks=[{...context.focus.task,mode:'demo',phase:'complete',outcome:'candidate'}];context.focus.task=context.tasks[0];
 const value=renderCurrentJob(context);assert.equal(value.phaseLabel,jobCopy('研究完成','Research complete'));assert.equal(value.heading,`18 ${jobCopy('角色','roles')} × 6 ${jobCopy('阶段','stages')}`);assert.equal(value.word,jobCopy('发现','Signal'));assert.equal(value.index,'06 / 06');
});

test('the actual prism canvas draws the new job word immediately when its presentation clock is paused',()=>{
 const source=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8'),body=source.match(/ function paintLensBackdrop\(\)\{([\s\S]*?)\n \}/)?.[1];
 assert.ok(body,'exercise the actual backdrop painter rather than its DOM status');
 function draw(moving,reducedMotion,elapsed,locale){
  const drawn=[],ctx={globalAlpha:1,setTransform(){},fillRect(){},drawImage(){},measureText:text=>({width:text.length*20}),fillText(text){if(this.globalAlpha>.01)drawn.push(text);}};
  Function('backdropCtx','moving','reducedMotion','elapsedMs','prismLabelSize','L','getLocale',`
   const lensLayout={left:0,top:0,width:200,height:300},backdrop={width:200,height:300},canvas={width:200,height:300,tagName:'CANVAS'},width=200,height=300,dark=false;
   const lensFont='sans-serif',lensMono='monospace',lens={word:L('观察','Watch'),previous:L('分析','Analyze'),index:'Read-only',changed:1000},performance={now:()=>1000+elapsedMs},projection=null;
   ${body}
  `)(ctx,moving,reducedMotion,elapsed,prismLabelSize,(zh,en)=>locale==='zh'?zh:en,()=>locale);
  return drawn;
 }
 for(const locale of ['en','zh']){
  const current=locale==='zh'?'观察':'Watch',previous=locale==='zh'?'分析':'Analyze';
  const brand=locale==='zh'?'AI 交易':'LENSWAVE';
  const frames=[[false,false,12,current],[false,true,12,current],[true,false,12,previous],[true,false,300,current]];
  for(const [moving,reducedMotion,elapsed,expected] of frames){
   const drawn=draw(moving,reducedMotion,elapsed,locale);
   assert.ok(drawn.includes(brand));
   assert.ok(drawn.includes(expected),`moving=${moving}, reduced=${reducedMotion}, elapsed=${elapsed}: ${drawn}`);
   assert.ok(!drawn.includes(expected===current?previous:current));
  }
 }
});
