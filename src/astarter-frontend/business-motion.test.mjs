import test from 'node:test';
import assert from 'node:assert/strict';
import {BusinessMotion,researchMotionJobs,mergeMotionJobs} from './business-motion.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch} from './multi-research.mjs';
import {coordinationPhase,receiptTeam} from './coordination.mjs';
const idle=()=>({time:0,orders:[],signal:null});
test('routine direct couriers and peer meetings coexist without duplicate role ownership',()=>{
 const r=new MultiResearch();r.time=8;
 const jobs=researchMotionJobs(r),roles=jobs.flatMap(j=>j.roles);
 assert.equal(roles.length,18);assert.equal(new Set(roles).size,18);
 assert.ok(jobs.some(j=>j.route==='direct'));assert.ok(jobs.some(j=>j.taskType==='crosscheck'&&j.roles.length===2));
 assert.ok(jobs.filter(j=>j.symbol==='SOL').every(j=>j.route!=='direct'));
 const direct=jobs.find(j=>j.route==='direct');assert.equal(coordinationPhase({...direct,progress:.25},true),'deliver');assert.equal(coordinationPhase({...direct,progress:.5},true),'submit');assert.deepEqual(receiptTeam({id:direct.roles[0],job:direct},[]).peers,[]);
 assert.ok(jobs.filter(j=>j.route==='direct').every(j=>!j.discovered));
});
test('strategy validation and credit receipts use the same task IDs and never alter balances',()=>{
 const w=new WorkspaceSim(),p=new BusinessMotion(),t=idle();p.update(w,t);
 const v=w.validate('D-S03').run;
 let jobs=p.update(w,t);const j=jobs.find(j=>j.taskType==='validation');assert.equal(j.ref,v.id);assert.equal(j.usageId,v.usageId);assert.deepEqual(j.roles,[6,9,12]);assert.equal(jobs.find(j=>j.taskType==='credits').reserved,20);
 for(let i=0;i<25;i++)w.tick(.2,t);
 jobs=p.update(w,t);assert.equal(jobs.find(j=>j.taskType==='credits').settled,16);assert.equal(jobs.find(j=>j.taskType==='credits').released,4);
 const before=JSON.stringify(w.s);for(let i=0;i<100;i++)p.update(w,t);assert.equal(JSON.stringify(w.s),before);
});
test('unknown orders keep execution owners until a real simulated terminal receipt arrives',()=>{
 const w=new WorkspaceSim(),p=new BusinessMotion(),t=idle();p.update(w,t);
 const o={id:'O1',market:'ETH/USDT',status:'unknown'};t.orders=[o];t.time=100;w.s.clock=100;
 let jobs=p.update(w,t);assert.deepEqual(jobs.find(j=>j.orderId==='O1').roles,[15,16]);
 w.s.clock=200;jobs=p.update(w,t);assert.equal(jobs.find(j=>j.orderId==='O1').badge,'待对账');assert.equal(jobs.some(j=>j.taskType==='review'),false);
 o.status='filled';jobs=p.update(w,t);assert.deepEqual(jobs.find(j=>j.orderId==='O1').roles,[16,17]);
 w.s.clock=215;assert.equal(p.update(w,t).some(j=>j.orderId==='O1'),false);
});
test('cancellation releases its actual reserve and historic receipts do not replay on load',()=>{
 const w=new WorkspaceSim(),p=new BusinessMotion(),t=idle();p.update(w,t);const v=w.validate('D-S03').run;p.update(w,t);w.cancelValidation(v.id);
 const j=p.update(w,t).find(j=>j.taskType==='credits');assert.equal(j.released,20);assert.equal(j.settled,0);assert.match(j.badge,/退 20/);
 assert.deepEqual(new BusinessMotion().update(w,t),[]);
});
test('business roles take priority without duplicating researchers or losing group identity',()=>{
 const r=new MultiResearch(),w=new WorkspaceSim({research:r}),p=new BusinessMotion(),t=idle();p.update(w,t);w.validate('D-S03');t.orders=[{id:'O2',status:'partial',market:'ETH/USDT'}];t.signal={id:'S1'};
 const jobs=mergeMotionJobs(p.update(w,t),researchMotionJobs(r)),roles=jobs.flatMap(j=>j.roles);
 assert.equal(new Set(roles).size,roles.length);assert.equal(roles.length,18);assert.ok(jobs.filter(j=>!j.business).every(j=>j.groupLabel));
});

test('six collaboration scenes retain exactly two tables and four distinct alternatives',async()=>{const {COLLAB_SCENES,collaborationPosition}=await import('./coordination.mjs');assert.equal(COLLAB_SCENES.length,6);assert.equal(new Set(COLLAB_SCENES).size,6);assert.equal(COLLAB_SCENES.filter(s=>s.endsWith('-table')).length,2);for(const station of [2,3])for(let i=0;i<3;i++){const p=collaborationPosition({x:200,y:200},station,i);assert.ok(p.y>=200,'reviewers stand in front of equipment, not on it');}});

test('cross-region specialists exchange only for shared evidence, retaining unique identity',()=>{const r=new MultiResearch();r.time=8;const before=JSON.stringify(r);const jobs=researchMotionJobs(r),visits=jobs.filter(j=>j.visitingRoles?.length);assert.ok(visits.length>=2);for(const j of visits){assert.ok(j.roles.includes(j.visitingRoles[0]));assert.notEqual(j.supportFrom,j.station);assert.ok(['macro','chain'].includes(j.supportSource));assert.ok(!j.route);}assert.equal(new Set(jobs.flatMap(j=>j.roles)).size,18);assert.equal(JSON.stringify(r),before);});
