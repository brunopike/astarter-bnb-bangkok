import {commerceFixture} from './commerce-test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MembershipAccount} from './membership-account.mjs';
import {createStrategyCenter} from './strategy-journeys.mjs';

test('saving a research strategy or editable settings stays in the originating page; navigation is optional',async t=>{
 const previous={document:globalThis.document,location:globalThis.location,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},routes=[],notices=[];
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(type,handler){events[type]=handler;},show(){this.open=true;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{dataset:{page:'workbench'},append(node){node.parentElement=this;}},addEventListener(){},removeEventListener(){},createElement:()=>drawer};
  globalThis.location={search:'?motion=reduced'};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const staleHost={append(node){assert.equal(document.body.dataset.page,'strategies','An inactive strategy workspace must not receive an editor');node.parentElement=this;}};
  const {workspace:w}=await commerceFixture(t),root={querySelector:selector=>selector==='[data-strategy-workspace-host]'?staleHost:null,querySelectorAll:()=>[]};
  const center=createStrategyCenter({w,desk:{snapshot:()=>({state:'idle'})},root,go:id=>routes.push(id),refresh(){},notify:(...args)=>notices.push(args)});
  center.bind();assert.equal(drawer.open,false,'binding a non-strategy page must not open a stale inline editor');
  const click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
  center.openTemplate('RX03-S');assert.equal(drawer.parentElement,document.body);await click('save-research','RX03-S');
  assert.equal(drawer.open,false);assert.deepEqual(routes,[]);assert.equal(w.draft().strategy,'RX03-S');
  assert.equal(typeof notices.at(-1)[1].action,'function');
  notices.at(-1)[1].action();assert.deepEqual(routes,['execution']);routes.length=0;
  const draft=w.s.drafts.find(d=>d.strategy==='S03');assert.ok(draft);
  center.openDraft(draft.id);await click('configure');await click('save');
  assert.deepEqual(routes,[]);assert.equal(drawer.open,false);assert.equal(w.s.validations.length,0);assert.equal(w.spent,0);
  let returns=0;center.openTemplate('RX03-S',()=>returns++);await click('close');assert.equal(returns,1);center.openTemplate('RX03-S');await click('close');assert.equal(returns,1);
  center.openTemplate('RX03-S',()=>returns++);await click('save-research');assert.equal(returns,1);
  document.body.dataset.page='strategies';center.openTemplate('RX03-S');assert.equal(drawer.parentElement,staleHost);await click('close');
 }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
