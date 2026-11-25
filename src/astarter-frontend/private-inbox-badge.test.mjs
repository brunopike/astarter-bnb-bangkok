import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbenchConsole} from './workbench-console.mjs';
import {createPrivateUIController} from './private-ui-controller.mjs';
import {MultiResearch} from './multi-research.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';

// Card U2 "Unread counts match the current owner": the notices tab badge is drawn by the workbench console from the
// private UI controller, so both run here unchanged on a small fake page, wired as the app wires them (the controller's
// onChange updates the console). The badge counts reminders (reminderUnreadCount); the inbox heading counts every
// unread row. Only research notices are reminders here, so an unread risk row counts in the heading and not on the badge.
const NOW=1800000000000,OWNER_A='wallet:offline:56',OWNER_B='wallet:other:56',STATE_URL='/api/notifications/state?responseVersion=2';
const session=ownerRef=>({ownerRef,expiresAt:NOW+3600000,authVersion:2,permissionProfile:'private-ui-v2'});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const notice=(id,type,title)=>({id,type,title,body:'Synthetic notice for this test.',source:'server-research',requestId:'research-request-'+id,createdAt:NOW,readAt:null,executionAuthority:'NONE'});
function inbox(scope,rows,revision=0){const unread=rows.filter(row=>row.readAt===null);return {schema:'private-notifications-v2',scope,revision,updatedAt:0,inapp:true,events:['research'],services:Object.fromEntries(['telegram','email'].map(channel=>[channel,{available:false,error:'CHANNEL_DISABLED'}])),channels:Object.fromEntries(['telegram','email'].map(channel=>[channel,{channel,label:'',enabled:0,verified:0}])),deliveries:[],inbox:rows,unreadCount:unread.length,nextCursor:null,mode:'server-research-only',reminderUnreadCount:unread.filter(row=>row.type==='research').length};}
const reports=(owner,count)=>Array.from({length:count},(_,i)=>notice('notice-'+owner+(i+1),'research','Owner '+owner.toUpperCase()+' report '+(i+1)));
const held=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function memory(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}

async function mounted(t,serve){
 const saved={document:globalThis.document,observer:globalThis.IntersectionObserver,media:globalThis.matchMedia},nodes=new Map();
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',dataset:{},attrs:{},isConnected:true,setAttribute(name,value){this.attrs[name]=value;},getAttribute(name){return this.attrs[name]??null;},addEventListener(){},parentElement:{scrollTop:0},querySelector:()=>null,querySelectorAll:()=>[]});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const tab=node('#ops-view-notifications'),panel=node('#ops-notices');tab.setAttribute('aria-selected','true');
 globalThis.document={activeElement:null,body:{dataset:{page:'workbench',mobileView:'console'}},visibilityState:'visible',querySelector:selector=>/^(#|\.console-header )/.test(selector)?node(selector):null,querySelectorAll:()=>[],addEventListener(){},dispatchEvent(){}};
 globalThis.matchMedia=()=>({matches:false});globalThis.IntersectionObserver=undefined;
 t.mock.timers.enable({apis:['setTimeout']});
 // The inbox has a layout box only while the notices tab is the selected console tab.
 const root={contains:()=>true,addEventListener(){},removeEventListener(){},querySelector:selector=>selector==='[data-private-inbox]'&&tab.getAttribute('aria-selected')==='true'&&panel.innerHTML.includes('data-private-inbox')?{isConnected:true,getClientRects:()=>[{}],parentElement:panel}:null};
 const calls=[];let view=null;
 const privateUI=createPrivateUIController({storage:memory(),now:()=>NOW,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return serve(url,init);},onChange:()=>view?.update()});
 t.after(()=>{privateUI.dispose();globalThis.document=saved.document;globalThis.IntersectionObserver=saved.observer;globalThis.matchMedia=saved.media;});
 privateUI.bind(root);
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 view=createWorkbenchConsole({host,research,workspace,privateUI,desk:{readSnapshot:()=>({state:'idle',session:null,discovery:{armed:false},orders:[],events:[]}),syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}});view.update();
 const show=selected=>{tab.setAttribute('aria-selected',String(selected));view.update();};
 return {privateUI,calls,show,
  badge:()=>tab.dataset.unreadCount,label:()=>tab.attrs['aria-label'],
  heading:()=>panel.innerHTML.match(/· (\d+) (?:未读|unread)/)?.[1]??null,html:()=>panel.innerHTML};
}

test('the notices badge and the inbox heading follow an owner change and a sign-out, never an earlier owner count',async t=>{
 const states={[OWNER_A]:inbox(OWNER_A,[...reports('a',1),notice('notice-a-risk','risk','Owner A risk notice')]),[OWNER_B]:inbox(OWNER_B,[...reports('b',2),notice('notice-b-risk','risk','Owner B risk notice')])};
 let serving=OWNER_A,gate=null;
 const page=await mounted(t,async()=>{const wait=gate;gate=null;const owner=serving;if(wait)await wait.promise;return response(states[owner]);});
 page.privateUI.setIdentity(session(OWNER_A));await settle();await settle();
 assert.equal(page.badge(),'1','owner A has one reminder');assert.match(page.label(),/(?:未读提醒|Unread reminders) 1$/);assert.equal(page.heading(),'2','owner A has two unread rows');assert.match(page.html(),/Owner A report 1/);
 const pending=held();gate=pending;serving=OWNER_B;page.privateUI.setIdentity(session(OWNER_B));await settle();
 assert.equal(page.badge(),'','while owner B is read, the badge shows no count');assert.doesNotMatch(page.label(),/\d/);assert.equal(page.heading(),null);assert.doesNotMatch(page.html(),/Owner A/);
 pending.open();await settle();await settle();
 assert.equal(page.badge(),'2','owner B has two reminders');assert.match(page.label(),/(?:未读提醒|Unread reminders) 2$/);assert.equal(page.heading(),'3','owner B has three unread rows');assert.match(page.html(),/Owner B report 2/);assert.doesNotMatch(page.html(),/Owner A/);
 page.privateUI.setIdentity(null);await settle();
 assert.equal(page.badge(),'','signed out: no count');assert.doesNotMatch(page.label(),/\d/);assert.equal(page.heading(),null);assert.doesNotMatch(page.html(),/Owner [AB]/);
 assert.ok(page.calls.every(call=>call.url===STATE_URL&&call.method==='GET'),'only reads of notification state');
});

test('one automatic tick on the notices tab updates the badge; on another console tab a tick reads nothing and an owner change still shows only the new owner count',async t=>{
 const a=reports('a',4),risk=notice('notice-a-risk','risk','Owner A risk notice');
 let current=inbox(OWNER_A,[a[0],risk]);const ownerB=inbox(OWNER_B,[...reports('b',4),notice('notice-b-risk','risk','Owner B risk notice')]);
 const page=await mounted(t,async()=>response(current));
 page.privateUI.setIdentity(session(OWNER_A));await settle();await settle();assert.equal(page.badge(),'1');
 current=inbox(OWNER_A,[a[0],a[1],risk],1);const reads=page.calls.length;
 t.mock.timers.tick(60000);await settle();await settle();
 assert.equal(page.calls.length,reads+1,'one read per tick');assert.equal(page.badge(),'2','the tick shows the new reminder count');assert.equal(page.heading(),'3');
 page.show(false);current=inbox(OWNER_A,[a[0],a[1],a[2],risk],2);const quiet=page.calls.length;
 t.mock.timers.tick(60000);await settle();await settle();
 assert.equal(page.calls.length,quiet,'no read while another console tab is shown');assert.equal(page.badge(),'2','the badge keeps the same owner last read count');
 current=ownerB;page.privateUI.setIdentity(session(OWNER_B));await settle();await settle();
 assert.equal(page.badge(),'4','an owner change reads the new owner count on any console tab');assert.match(page.label(),/(?:未读提醒|Unread reminders) 4$/);
 page.show(true);await settle();await settle();
 assert.equal(page.badge(),'4');assert.equal(page.heading(),'5');assert.doesNotMatch(page.html(),/Owner A/);
 assert.ok(page.calls.every(call=>call.url===STATE_URL&&call.method==='GET'),'only reads of notification state');
});
