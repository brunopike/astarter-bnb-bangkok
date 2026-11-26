import test from 'node:test';
import {pair} from './locale.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('./assistant-team.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function createAssistantTeam','function createAssistantTeam');
class Events{
 listeners=new Map();
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 emit(name,event={}){for(const fn of [...this.listeners.get(name)||[]])fn(event);}
}
class Element extends Events{
 dataset={};nodes=new Map();children=[];attributes={};open=false;hidden=false;parent=null;focusCount=0;
 style={setProperty(key,value){this[key]=value;}};
 constructor(name){super();this.name=name;}
 get isConnected(){return this.name==='body'||Boolean(this.parent?.isConnected);}
 querySelector(selector){if(!this.nodes.has(selector)){const node=new Element(selector);node.parent=this;this.nodes.set(selector,node);}return this.nodes.get(selector);}
 setAttribute(key,value){this.attributes[key]=value;}
 append(child){child.parent=this;this.children.push(child);}
 replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];children.forEach(child=>this.append(child));}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
 showModal(){this.open=true;}
 close(){this.open=false;this.emit('close');}
 focus(){this.focusCount++;}
}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function fixture({deferred=false,reduced=false,english=false}={}){
 const document=new Events(),window=new Events(),frames=new Map(),dialogs=[],observers=[],scenes=[];
 document.body=new Element('body');document.body.dataset={page:'assistant',renderer:'photonic',paused:'false'};
 document.documentElement=new Element('html');document.hidden=false;
 const trigger=new Element('trigger');document.body.append(trigger);
 document.createElement=name=>{const node=new Element(name);if(name==='dialog')dialogs.push(node);return node;};
 document.querySelector=()=>trigger;
 const model={elapsed:12,multiResearch:{},config:{actors:[0,1]},events:[],flows:[]};
 const context={model,running:true,reducedMotion:reduced};let next=0,resolve;
 const factory={createReactor(canvas,labels,options){const scene={canvas,labels,options,updates:[],disposed:0,needsRender:false,
  update(value,delta,running){assert.equal(this.disposed,0);this.updates.push({value,at:value.elapsed,delta,running});},
  focus(){},setRotate(){},setTheme(){},reset(){},dispose(){this.disposed++;}};scenes.push(scene);return scene;}};
 const loading=deferred?new Promise(done=>resolve=done):Promise.resolve(factory);
 const sandbox={document,window,requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),
  MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}},
  L:english?(zh,en)=>pair(zh,en,'en'):zh=>zh,uiGlyph:()=>'<svg/>',getContext:()=>context,loadScene:()=>loading};
 runInNewContext(source+';globalThis.team=createAssistantTeam({getContext,loadScene});',sandbox);
 return {document,window,trigger,model,context,frames,dialogs,scenes,observers,team:sandbox.team,
  resolve:()=>resolve(factory),step(time=16){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(time));}};
}

test('team renders the shared research object without changing page state; close disposes and restores focus',async()=>{
 const f=fixture(),before=JSON.stringify(f.document.body.dataset);
 f.team.open(f.trigger);await settle();f.step();
 assert.equal(f.scenes.length,1);assert.equal(f.scenes[0].updates[0].value,f.model);
 assert.equal(f.scenes[0].options.scope,f.dialogs[0].querySelector('[data-team-stage]'));
 f.model.elapsed=13;f.step(32);assert.equal(f.scenes[0].updates.at(-1).at,13);
 assert.equal(JSON.stringify(f.document.body.dataset),before);
 f.team.close();f.team.close(false);
 assert.equal(f.scenes[0].disposed,1);assert.equal(f.frames.size,0);assert.equal(f.dialogs[0].isConnected,false);
 assert.equal(f.trigger.focusCount,1);assert.ok(f.observers.every(observer=>!observer.active));
 assert.equal(f.document.listeners.get('visibilitychange').size,0);
});

test('closing during lazy loading prevents a late renderer and leaves no modal or animation frame',async()=>{
 const f=fixture({deferred:true});f.team.open(f.trigger);f.team.close();f.resolve();await settle();
 assert.equal(f.scenes.length,0);assert.equal(f.frames.size,0);assert.equal(f.dialogs[0].isConnected,false);
});

test('reopening the team creates only one active scene and preserves the original research state',async()=>{
 const f=fixture(),before=JSON.stringify(f.model);
 f.team.open(f.trigger);f.team.open(f.trigger);await settle();f.step();
 assert.equal(f.dialogs.length,1);f.team.close();
 f.team.open(f.trigger);await settle();f.step();
 assert.equal(f.scenes.length,2);assert.equal(f.scenes[0].disposed,1);assert.equal(f.scenes[1].disposed,0);
 assert.equal(JSON.stringify(f.model),before);f.team.close();assert.equal(f.frames.size,0);
});

test('hidden pages stop frames, resume one loop on return, and leaving assistant disposes the scene',async()=>{
 const f=fixture();f.team.open(f.trigger);await settle();f.step();
 f.document.hidden=true;f.document.emit('visibilitychange');assert.equal(f.frames.size,0);
 f.step(2000);assert.equal(f.scenes[0].updates.length,1);
 f.document.hidden=false;f.document.emit('visibilitychange');assert.equal(f.frames.size,1);
 f.step(3000);assert.equal(f.scenes[0].updates.length,2);assert.equal(f.scenes.length,1);
 f.document.body.dataset.page='workbench';f.step(4000);
 assert.equal(f.scenes[0].disposed,1);assert.equal(f.frames.size,0);assert.equal(f.trigger.focusCount,0);
});

test('reduced motion renders a static scene and preference changes retire its renderer',async()=>{
 const f=fixture({reduced:true});f.team.open(f.trigger);await settle();f.step();f.step(32);
 assert.equal(f.scenes[0].updates.length,1);assert.equal(f.scenes[0].updates[0].running,false);
 f.model.elapsed=13;f.step(40);assert.equal(f.scenes[0].updates.length,2);assert.equal(f.scenes[0].updates.at(-1).running,false);
 f.context.reducedMotion=false;f.step(48);
 assert.equal(f.scenes[0].disposed,1);assert.equal(f.scenes[1].updates[0].running,true);
 f.window.emit('pagehide');assert.equal(f.scenes[1].disposed,1);assert.equal(f.frames.size,0);
});

test('missing research context shows an unavailable state without inventing a simulation',async()=>{
 const f=fixture();f.context.model=null;f.team.open(f.trigger);await settle();
 assert.equal(f.scenes.length,0);assert.equal(f.frames.size,0);
 assert.equal(f.dialogs[0].querySelector('[data-team-message]').textContent,'小队暂不可用');
 assert.equal(f.dialogs[0].querySelector('[data-team-retry]').hidden,false);f.team.close();
});

test('static reactor fallback stays inside the assistant scope and leaves the workbench renderer untouched',()=>{
 const reactor=readFileSync(new URL('./reactor.js',import.meta.url),'utf8');
 const document={body:{dataset:{renderer:'photonic'}},createElementNS:(_,name)=>new Element(name),createElement:name=>new Element(name)};
 const scope=new Element('scope'),canvas=new Element('canvas'),labels=new Element('labels');let selected=null;
 const context={document,scope,canvas,labels,location:{search:'?renderer=static'},URLSearchParams,COLORS:['#fff'],colorFor:()=> '#fff',ROLES:[{id:'A01'}],shortNames:['市场'],TAU:Math.PI*2,onSelect:id=>selected=id};
 runInNewContext(reactor.slice(reactor.indexOf('function fallback(')).replace('export function createReactor','function createReactor')+';globalThis.scene=createReactor(canvas,labels,{scope,onSelect});',context);
 context.scene.update({key:'example',config:{actors:[0]}});
 assert.equal(document.body.dataset.renderer,'photonic');assert.equal(scope.dataset.renderer,'static');
 assert.equal(canvas.children.length,1);assert.equal(labels.children.length,1);
 labels.children[0].onclick();assert.equal(selected,0);context.scene.dispose();assert.equal(canvas.children.length,0);
});


test('English squad copy stays distinct from the AI Spectrum product name',async()=>{
 const f=fixture({english:true});f.team.open(f.trigger);await settle();
 assert.equal(f.dialogs[0].querySelector('[data-team-title]').textContent,'AI squad');
 assert.equal(f.dialogs[0].querySelector('[data-team-close]').attributes['aria-label'],'Close AI squad');
 f.team.close();
});
