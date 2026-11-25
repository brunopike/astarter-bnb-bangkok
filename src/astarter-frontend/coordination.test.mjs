import {Simulation} from './simulation.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {coordinationJobs,coordinationPhase} from './coordination.mjs';
const model={runId:'research-1',elapsed:16,completed:false},idle={state:'idle',time:16,orders:[],signal:null,pending:null};
test('research collaboration uses phase-specific tasks and unique role assignments',()=>{const jobs=coordinationJobs(model,idle),roles=jobs.flatMap(j=>j.roles);assert.equal(new Set(roles).size,roles.length);assert.ok(jobs.find(j=>j.id==='rules'));assert.equal(jobs.some(j=>j.id==='trend'),false);assert.ok(jobs.every(j=>j.trigger.includes('research-1')));});
test('risk and reconciliation motion is bound to exact signal/order identity',()=>{const trade={...idle,state:'running',time:20,signal:{id:'SIG-4',at:18},pending:{id:'ORD-5',at:19}};const jobs=coordinationJobs({...model,completed:true},trade);assert.ok(jobs.some(j=>j.trigger==='SIG-4'));assert.ok(jobs.some(j=>j.trigger==='ORD-5'));assert.ok(jobs.some(j=>j.id.startsWith('source-check')));});
test('all 18 roles continuously share six finite review duties without creating evidence',()=>{
 const m={...model,completed:true,events:[]},before=JSON.stringify(m);
 for(let time=0;time<72;time+=.25){
  const jobs=coordinationJobs(m,{...idle,time}),roles=jobs.flatMap(j=>j.roles);
  assert.equal(jobs.length,6);assert.equal(roles.length,18);assert.equal(new Set(roles).size,roles.length);
  assert.ok(jobs.every(j=>j.roles.length===3&&j.progress>=0&&j.progress<1));
  assert.ok(jobs.some(j=>coordinationPhase(j)==='discuss'));
 }
 assert.equal(JSON.stringify(m),before);
});
test('completed fill owns its exact review pair then expires, background review continues',()=>{
 const d={...idle,state:'paused',time:24,orders:[{id:'ORD-9',status:'filled',at:20}]};
 const jobs=coordinationJobs({...model,completed:true},d);
 assert.deepEqual(jobs.find(j=>j.trigger==='ORD-9').roles,[16,17]);
 assert.ok(jobs.filter(j=>j.trigger!=='ORD-9').every(j=>!j.roles.includes(16)&&!j.roles.includes(17)));
 const later=coordinationJobs({...model,completed:true},{...d,time:31});
 assert.equal(later.some(j=>j.trigger==='ORD-9'),false);assert.equal(later.length,6);
});
test('a courier carrying new evidence cannot simultaneously join a meeting',()=>{
 const m={...model,completed:true,events:[{from:0,at:15},{from:1,at:14}]};
 const jobs=coordinationJobs(m,{...idle,time:2});
 assert.ok(jobs.every(j=>j.roles.length>=2&&!j.roles.includes(0)&&!j.roles.includes(1)));
});
test('team handoff precedes leader submission and colleagues return without duplicate deliveries',()=>{
 const phase=(progress,leader)=>coordinationPhase({progress},leader);
 assert.equal(phase(.1,true),'visit');assert.equal(phase(.24,true),'meet');
 assert.equal(phase(.5,true),'discuss');assert.equal(phase(.5,false),'discuss');
 assert.equal(phase(.74,true),'deliver');assert.equal(phase(.74,false),'return');
 assert.equal(phase(.85,true),'submit');assert.equal(phase(.85,false),'return');
 assert.equal(phase(.96,true),'return');
 const held=coordinationJobs({...model,completed:true},{...idle,state:'running',time:100,signal:{id:'SIG-HOLD',at:1}}).find(j=>j.trigger==='SIG-HOLD');
 assert.equal(phase(held.progress,true),'discuss');
});

test('every role takes a turn carrying the team dossier, including integration role 12',()=>{
 const leaders=new Set(),m={...model,completed:true,events:[]};
 for(let time=0;time<52;time+=.2)for(const j of coordinationJobs(m,{...idle,time}))if(coordinationPhase(j,true)==='deliver')leaders.add(j.roles[0]);
 assert.deepEqual([...leaders].sort((a,b)=>a-b),Array.from({length:18},(_,i)=>i));
});

test('only field leaders collect while their colleagues review and two desks stay occupied',()=>{
 const jobs=coordinationJobs({...model,completed:true,events:[]},{...idle,time:0});
 assert.equal(jobs.filter(j=>j.mode==='desk').length,2);
 for(const j of jobs){assert.equal(coordinationPhase({...j,progress:.1},false),j.mode==='desk'?'review':'await');}
 assert.ok(jobs.some(j=>j.sourceAnchor==='market'));
});


test('returned tasks choose relevant available colleagues and never borrow execution roles',async()=>{
 const {receiptTeam}=await import('./coordination.mjs');
 assert.deepEqual(receiptTeam({id:4},[{id:16,phase:5},{id:17,phase:5,job:{id:'order-1'}}]),{station:2,peers:[16]});
 assert.deepEqual(receiptTeam({id:4},[{id:16,phase:2},{id:0,phase:5}]),{station:2,peers:[]});
});

test('wide workspaces put desks in side whitespace, compact layouts stay inside the stage',async()=>{
 const {meetingCenters}=await import('./coordination.mjs');
 for(const [width,height,mobile]of [[360,190,true],[600,280,false],[890,310,false],[1250,480,false]]){
  const core={x:width/2,y:height/2},centers=meetingCenters({width,height,core,mobile});
  assert.equal(centers.length,6);
  for(const p of centers){assert.ok(p.x>=45&&p.x<=width-45);assert.ok(p.y>=20&&p.y<=height-20);}
  if(width>=650){assert.ok(centers[4].x-core.x>width*.35);assert.ok(core.x-centers[5].x>width*.35);}
 }
});

test('expressions follow collection, acknowledgement and peer handoff rather than invented profit',async()=>{
 const {agentReaction}=await import('./coordination.mjs');
 assert.equal(agentReaction({id:0,phase:1,source:{key:'macro'}},.8).emoji,'🌍');
 assert.equal(agentReaction({id:0,phase:5,coreWaiting:true},3,{stage:'confirm',progress:.5}).emoji,'👌');
 assert.equal(agentReaction({id:4,phase:5,followup:{},workPhase:'handoff'},3,{stage:'handoff',progress:.8,team:{peers:[4]}}).emoji,'👍');
 assert.equal(agentReaction({id:0,phase:5,workPhase:'discuss',job:{source:'risk'}},.8).emoji,'🤔');
 assert.equal(agentReaction({id:0,phase:1},3),null);
 const pose={id:3,phase:5,workPhase:'collaborate',job:{source:'social'}};assert.deepEqual(agentReaction(pose,5),agentReaction(pose,5));
});

test('background teams cover crypto, traditional markets and portfolio review',()=>{
 const m=new Simulation();m.completed=true;const jobs=coordinationJobs(m,{time:0,orders:[]});
 const subjects=new Set(jobs.flatMap(j=>j.subjects));for(const s of ['BTC','ETH','SOL','DXY','XAU','SPX','NDX','US10Y','组合敞口'])assert.ok(subjects.has(s));
});

test('standing and returning couriers keep their feet outside review table surfaces',async()=>{
 const {collaborationPosition,avoidMeetingTable}=await import('./coordination.mjs');
 for(const mobile of [false,true]){
  const center={x:240,y:180},scale=mobile?.66:.90;
  const outside=p=>Math.hypot((p.x-center.x)/(52*scale),(p.y+20-center.y-17)/(19*scale))>=1;
  for(const station of [4,5])for(let slot=0;slot<3;slot++)assert.ok(outside(collaborationPosition(center,station,slot,3,mobile)));
  for(let x=170;x<=310;x+=5)for(let y=130;y<=215;y+=5)assert.ok(outside(avoidMeetingTable({x,y},center,mobile)));
 }
});


test('scene work differentiates retrieval, keyboard verification and turn-taking without mutating tasks',async()=>{
 const {sceneWork}=await import('./coordination.mjs');
 const job={id:'evidence-42',roles:[1,7,16],route:'team',progress:.4,station:0};
 const before=JSON.stringify(job);
 assert.equal(sceneWork(job,1).action,'retrieve');
 assert.equal(sceneWork(job,7).action,'compare');
 assert.equal(sceneWork({...job,progress:.51},1).action,'inspect');
 assert.equal(sceneWork({...job,progress:.65},1).action,'pack');
 const computer={...job,station:2};
 assert.equal(sceneWork(computer,1).action,'type');
 assert.equal(sceneWork({...computer,progress:.59},1).action,'verify');
 assert.equal(sceneWork({...computer,progress:.65},1).action,'pack');
 assert.equal(sceneWork(computer,7).action,'crosscheck');
 for(const q of [.05,.38,.72]){
  const screen={...job,station:3,progress:.32+.35*q};
  const actions=screen.roles.map(id=>sceneWork(screen,id));
  assert.equal(actions.filter(w=>w.action==='point').length,1);
  assert.equal(actions.filter(w=>w.action==='listen').length,2);
  assert.equal(actions.find(w=>w.action==='point').owner,screen.roles[Math.floor(q*3)]);
 }
 assert.equal(JSON.stringify(job),before);
});
test('local gestures cannot divert raw collection or bypass the existing core submission gate',async()=>{
 const {sceneWork}=await import('./coordination.mjs');
 const job={id:'pending-order',roles:[16,17],station:2,progress:.5};
 assert.equal(sceneWork({...job,route:'direct'},16),null);
 assert.equal(sceneWork(job,0),null);
 for(const progress of [.1,.31,.67,.8,.94])assert.equal(sceneWork({...job,progress},16),null);
 for(const progress of [.34,.5,.62]){
  assert.equal(coordinationPhase({...job,progress},true),'discuss');
  assert.notEqual(sceneWork({...job,progress},16).action,'pack');
 }
 assert.equal(coordinationPhase({...job,progress:.7},true),'deliver');
 assert.equal(coordinationPhase({...job,progress:.85},true),'submit');
});


test('market screen updates and presenter pointer use the same bounded simulation frame',async()=>{
 const {sceneWork,sceneMarket}=await import('./coordination.mjs');
 assert.notDeepEqual(sceneMarket(.1),sceneMarket(.6));
 assert.deepEqual(sceneMarket(.4),sceneMarket(.4));
 for(let q=.02;q<1;q+=.07){
  const frame=sceneMarket(q),job={id:'screen-task',station:3,roles:[6,10,14],progress:.32+.35*q};
  const work=sceneWork(job,6),at=q*7,n=Math.min(6,Math.floor(at)),mix=at-n;
  const [a,b]=[frame.points[n],frame.points[n+1]];
  assert.ok(Math.abs(work.chartX-(a[0]+(b[0]-a[0])*mix))<1e-8);
  assert.ok(Math.abs(work.chartY-(a[1]+(b[1]-a[1])*mix))<1e-8);
  assert.ok(frame.points.every(([x,y])=>x>=-53&&x<=51&&y>=-65&&y<=-19));
  assert.ok(frame.volumes.every(v=>v>=4&&v<=14));
 }
});
