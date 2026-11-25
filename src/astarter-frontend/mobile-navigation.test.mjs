import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {MOBILE_DOCK} from './product-data.mjs';

const source=readFileSync(new URL('./mobile-navigation.mjs',import.meta.url),'utf8').replace(/^export /gm,'').replace('import(bundleUrl)','loadAnimation(bundleUrl)');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(matches){
 let change,notifyResize,resolve,reject,mounts=0,destroys=0,last,timerId=0;
 const items=MOBILE_DOCK,routes=[],requests=[],timers=new Map(),onlineListeners=new Set();
 const document={activeElement:null,createElement(tagName){const label={textContent:''};return {tagName,dataset:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},querySelector(){return label;},focus(){document.activeElement=this;}};}};
 const host={children:[],dataset:{},style:{setProperty(key,value){this[key]=value;}},setAttribute(){},
  append(link){link.offsetLeft=3+60*this.children.length;link.offsetWidth=60;this.children.push(link);},
  querySelector(){return this.children.find(link=>link.attributes['aria-current']==='page');},
  replaceChildren(...children){this.children=children;},contains(button){return this.children.includes(button);}};
 class ResizeObserver {constructor(callback){notifyResize=callback;}observe(){}}
 const mobile={matches,addEventListener(_,fn){change=fn;}};
 const getComputedStyle=()=>({translate:host.pillLeft??host.style['--dock-left']});
 const navigator={onLine:true};
 const window={addEventListener(event,fn){assert.equal(event,'online');onlineListeners.add(fn);},removeEventListener(event,fn){assert.equal(event,'online');onlineListeners.delete(fn);}};
 const create=runInNewContext(source+';createMobileNavigation',{document,window,navigator,ResizeObserver,getComputedStyle,matchMedia:()=>mobile,console:{warn(){}},
  setTimeout(fn,ms){assert.ok(ms>0);timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  loadAnimation(url){requests.push(url);return new Promise((ok,no)=>{resolve=ok;reject=no;});}});
 const nav=create(host,{items,icons:Object.fromEntries(items.map(x=>[x.id,''])),onNavigate:id=>routes.push(id)});
 const state=(section='workbench')=>({section,labels:items.map(x=>x.en),hrefs:items.map(x=>'?page='+x.home),label:'Navigation',reducedMotion:false});
 function ready(){
  resolve({mountMobileNavigation(){
   mounts++;host.replaceChildren();
   for(const item of items){
    const link=document.createElement('a');link.dataset.mobileSection=item.id;host.append(link);
   }
   return {update(next){
    last=next;
    for(const link of host.children)link.setAttribute('aria-current',link.dataset.mobileSection===next.section?'page':'false');
   },destroy(){destroys++;host.replaceChildren();}};
  }});
 }
 return {nav,host,document,routes,state,ready,notifyResize,navigator,requests,timers,onlineListeners,
  online(){navigator.onLine=true;for(const listener of [...onlineListeners])listener();},
  delay(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}},fail(){reject(Error('Unavailable'));},
  resize(value){mobile.matches=value;change();},get calls(){return requests.length;},get mounts(){return mounts;},get destroys(){return destroys;},get last(){return last;}};
}

test('desktop skips the animation bundle; a failed mobile load keeps all routes working',async()=>{
 const f=fixture(false);f.nav.update(f.state());assert.equal(f.calls,0);assert.equal(f.host.children.length,0);
 f.resize(true);assert.equal(f.host.children.length,4);assert.equal(f.calls,1);
 const data=f.host.children.at(-1);data.focus();f.fail();await tick();assert.equal(f.host.children.at(-1),f.document.activeElement);
 data.onclick();assert.deepEqual(f.routes,['data']);
 const next=f.state('data');next.labels=MOBILE_DOCK.map(x=>x.zh);next.hrefs[3]='?page=markets&asset=BTC';f.nav.update(next);
 assert.deepEqual(f.host.children.map(link=>[link.tagName,link.href,link.querySelector('.mobile-nav-label').textContent]),next.labels.map((label,i)=>['a',next.hrefs[i],label]));
 assert.deepEqual(f.host.children.map(link=>link.attributes['aria-label']),next.labels);
 assert.equal(data.attributes['aria-current'],'page');assert.equal(f.calls,1);
});

test('animation hydration uses the latest route and language while preserving keyboard focus',async()=>{
 const f=fixture(true);f.nav.update(f.state());f.host.children[2].focus();
 const next={...f.state('signals'),labels:MOBILE_DOCK.map(x=>x.zh),reducedMotion:true};f.nav.update(next);
 f.ready();await tick();assert.equal(f.mounts,1);assert.equal(f.last,next);assert.equal(f.document.activeElement.dataset.mobileSection,'signals');assert.ok(f.host.contains(f.document.activeElement));
});

test('online recovery uses one distinct module URL and the latest route, without taking focus from content',async()=>{
 const f=fixture(true);f.nav.update(f.state());f.navigator.onLine=false;f.fail();await tick();
 const data=f.host.children.at(-1);data.focus();data.onclick();assert.deepEqual(f.routes,['data']);
 const content=f.document.createElement('button');content.focus();
 f.delay();f.nav.update(f.state('data'));assert.equal(f.calls,1);
 f.online();f.online();f.delay();assert.equal(f.calls,2);
 const [base,retry]=f.requests.map(path=>new URL(path,'https://astarter.test'));
 assert.equal(base.pathname,retry.pathname);assert.equal(base.search,'');assert.equal(retry.search,'?retry=1');
 assert.equal(f.timers.size,0);assert.equal(f.onlineListeners.size,0);
 const next={...f.state('signals'),labels:MOBILE_DOCK.map(x=>x.zh)};f.nav.update(next);
 assert.equal(f.host.children.at(-1),data);assert.equal(f.calls,2);
 f.ready();await tick();assert.equal(f.mounts,1);assert.equal(f.last,next);
 assert.equal(f.document.activeElement,content);
});

test('a delayed retry defers on desktop and remounts the dock once with the focused section',async()=>{
 const f=fixture(true);f.nav.update(f.state());f.fail();await tick();f.resize(false);f.delay();
 assert.equal(f.calls,1);assert.equal(f.host.children.length,0);
 f.resize(true);const focused=f.host.children.at(-1);focused.focus();f.online();f.nav.update(f.state('data'));
 assert.equal(f.calls,2);f.ready();await tick();
 assert.equal(f.mounts,1);assert.ok(f.host.contains(f.document.activeElement));assert.equal(f.document.activeElement.dataset.mobileSection,'data');
 f.resize(false);f.resize(true);await tick();assert.equal(f.calls,2);assert.equal(f.mounts,2);
});

test('a second failure preserves the same fallback links and permanently caps this document at two requests',async()=>{
 const f=fixture(true);f.nav.update(f.state());const link=f.host.children.at(-1);
 f.fail();await tick();assert.equal(f.timers.size,1);f.delay();assert.equal(f.calls,2);
 link.focus();f.fail();await tick();assert.equal(f.document.activeElement,link);assert.equal(f.host.children.at(-1),link);
 f.nav.update(f.state('data'));f.online();f.delay();assert.equal(f.calls,2);
 link.onclick();assert.deepEqual(f.routes,['data']);assert.equal(link.attributes['aria-current'],'page');
 f.resize(false);f.resize(true);f.online();assert.equal(f.calls,2);assert.equal(f.host.children.length,4);
 assert.equal(f.onlineListeners.size,0);assert.equal(f.timers.size,0);
});

test('a pending animation load cannot mount on desktop and a mounted tree is cleaned up',async()=>{
 const f=fixture(true);f.nav.update(f.state());f.resize(false);f.ready();await tick();
 assert.equal(f.mounts,0);assert.equal(f.host.children.length,0);
 f.resize(true);await tick();assert.equal(f.calls,1);assert.equal(f.mounts,1);assert.equal(f.host.children.length,4);
 f.resize(false);assert.equal(f.destroys,1);assert.equal(f.host.children.length,0);
});

test('the dock uses actual link bounds and only slides between selected sections',()=>{
 const f=fixture(true),{host}=f;
 const route=section=>f.nav.update(f.state(section));
 const geometry=()=>[host.dataset.dockSlide,host.style['--dock-left'],host.style['--dock-width']];
 route('data');assert.deepEqual(geometry(),['rest','183px','60px']);
 route('execution');assert.deepEqual(geometry(),['left','63px','60px']);
 route('execution');assert.equal(host.dataset.dockSlide,'left');
 route('signals');assert.deepEqual(geometry(),['right','123px','60px']);
 Object.assign(host.children[2],{offsetLeft:178,offsetWidth:71});
 f.notifyResize();assert.deepEqual(geometry(),['rest','178px','71px']);
 host.pillLeft='50px';route('execution');assert.equal(host.dataset.dockSlide,'right');
 route('assistant');assert.equal(host.dataset.dockSlide,undefined);
 assert.equal(host.querySelector('[aria-current="page"]'),undefined);
 route(null);assert.equal(host.dataset.dockSlide,undefined);
 route('data');assert.equal(host.dataset.dockSlide,'rest');
});
