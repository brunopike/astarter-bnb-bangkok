import {commerceFixture} from './commerce-test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {operatorTasks,matchingOperatorTasks} from './ai-operator.mjs';
import {runnableRecommendation,applyRecommendation} from './strategy-advisor.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MembershipAccount} from './membership-account.mjs';

test('operator prioritizes resolving an unknown order without offering a second submission',async t=>{
 const trade={state:'blocked',pending:{id:'O1',status:'unknown'},session:{id:'R1'}},before=JSON.stringify(trade);
 const tasks=operatorTasks(trade,{ready:false});assert.equal(tasks[0].id,'reconcile');assert.equal(JSON.stringify(trade),before);
 assert.ok(tasks.every(t=>!['buy','sell','close','stop'].includes(t.kind)));
});
test('operator starts with guided setup for a new user and offers pause for a running strategy',async t=>{
 assert.equal(operatorTasks({state:'idle'},{ready:false})[0].id,'start');
 assert.equal(operatorTasks({state:'running',session:{id:'R'}},{ready:true})[0].id,'pause');
 assert.equal(operatorTasks({state:'paused',session:{id:'R'}},{ready:true})[0].id,'activity');
});
test('task search supports intent words without treating unknown input as an execution command',async t=>{
 const tasks=operatorTasks(null,{ready:false});
 assert.equal(matchingOperatorTasks(tasks,'API')[0].id,'connect');
 assert.equal(matchingOperatorTasks(tasks,'持仓')[0].id,'activity');
 assert.deepEqual(matchingOperatorTasks(tasks,'why is bitcoin falling'),[]);
});
test('guided setup keeps the recommended method as an unapproved draft without changing account limits',async t=>{
 for(const [goal,strategy] of [['steady','S07'],['active','S04'],['observe','RX01']]){
  const answers={goal,capital:'1000',risk:'low',pace:'balanced',autonomy:'auto'},r=runnableRecommendation(answers);
  assert.equal(r.strategy,strategy);assert.equal(r.dailyLoss,10);assert.equal(r.cap,1000);
  assert.equal(r.mode,goal==='observe'?'signal':'auto');
  const {workspace:w}=await commerceFixture(t),before=w.available,risk=structuredClone(w.s.risk),{draft}=(await applyRecommendation(w,answers));
  assert.equal(draft.strategy,strategy);assert.equal(draft.mode,r.mode);assert.equal(draft.advisor.dailyLoss,10);
  assert.equal(draft.status,'draft');assert.equal(draft.validatedVersion,null);assert.equal(draft.botLaunch,undefined);assert.equal(draft.executionRoute,undefined);
  assert.equal(w.s.trade,null);assert.equal(w.s.started,false);assert.deepEqual(w.s.risk,risk);
  assert.equal(w.available,before);assert.equal(w.s.usage.length,0);assert.ok(w.checkStart(draft));
 }
});
test('Control+K opens the operator past an open dialog without a layout box, but not over a shown dialog',async t=>{
 const {mountAIOperator}=await import('./ai-operator.mjs'),prior=Object.getOwnPropertyDescriptor(globalThis,'document');
 t.after(()=>{if(prior)Object.defineProperty(globalThis,'document',prior);else delete globalThis.document;});
 const element=()=>{const parts=new Map();return {hidden:false,textContent:'',innerHTML:'',setAttribute(){},addEventListener(){},focus(){},scrollIntoView(){},querySelectorAll:()=>[],querySelector(selector){if(!parts.has(selector))parts.set(selector,element());return parts.get(selector);}};};
 const operator=Object.assign(element(),{open:false,showModal(){this.open=true;},close(){this.open=false;}});
 const hiddenEditor={open:true,getClientRects:()=>[]},shown={open:true,getClientRects:()=>[{}]},listeners={};let open=[];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{append(){}},activeElement:null,createElement:()=>operator,addEventListener:(name,fn)=>listeners[name]=fn,querySelector:selector=>selector==='dialog[open]'?open[0]??null:null,querySelectorAll:selector=>selector==='dialog[open]'?open:[]}});
 mountAIOperator({desk:{readSnapshot:()=>({state:'idle'}),access:()=>({ready:true})},onNavigate(){},onPlan(){},onAsk(){},notify(){}});
 const controlK=()=>listeners.keydown({ctrlKey:true,metaKey:false,key:'k',isComposing:false,target:{type:'text'},preventDefault(){}});
 open=[hiddenEditor];controlK();assert.equal(operator.open,true,'an editor left open inside the hidden product page does not block the shortcut');
 operator.close();open=[hiddenEditor,shown];controlK();assert.equal(operator.open,false,'the operator still does not open over a shown dialog');
 open=[];controlK();assert.equal(operator.open,true);
});
