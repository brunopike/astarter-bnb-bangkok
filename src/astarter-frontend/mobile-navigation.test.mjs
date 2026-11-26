import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {MOBILE_DOCK} from './product-data.mjs';

const source=readFileSync(new URL('./mobile-navigation.mjs',import.meta.url),'utf8').replace(/^export /gm,'').replace("import(bundleUrl)",'loadAnimation()');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(matches){
 let change,notifyResize,resolve,reject,calls=0,mounts=0,destroys=0,last;
 const items=MOBILE_DOCK,routes=[];
 const document={activeElement:null,createElement(tagName){const label={textContent:''};return {tagName,dataset:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},querySelector(){return label;},focus(){document.activeElement=this;}};}};
 const host={children:[],dataset:{},style:{setProperty(key,value){this[key]=value;}},setAttribute(){},
  append(link){link.offsetLeft=3+60*this.children.length;link.offsetWidth=60;this.children.push(link);},
  querySelector(){return this.children.find(link=>link.attributes['aria-current']==='page');},
  replaceChildren(){this.children=[];},contains(button){return this.children.includes(button);}};
 class ResizeObserver {constructor(callback){notifyResize=callback;}observe(){}}
 const mobile={matches,addEventListener(_,fn){change=fn;}};
 const getComputedStyle=()=>({translate:host.pillLeft??host.style['--dock-left']});
 const create=runInNewContext(source+';createMobileNavigation',{window:new EventTarget(),setTimeout,clearTimeout,document,ResizeObserver,getComputedStyle,matchMedia:()=>mobile,console:{warn(){}},loadAnimation(){calls++;return new Promise((ok,no)=>{resolve=ok;reject=no;});}});
 const nav=create(host,{items,icons:Object.fromEntries(items.map(x=>[x.id,''])),onNavigate:id=>routes.push(id)});
 const state=(section='brain')=>({section,labels:items.map(x=>x.en),hrefs:items.map(x=>'?page='+x.home),label:'Navigation',reducedMotion:false});
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
 return {nav,host,document,routes,state,ready,notifyResize,fail(){reject(Error('Unavailable'));},resize(value){mobile.matches=value;change();},get calls(){return calls;},get mounts(){return mounts;},get destroys(){return destroys;},get last(){return last;}};
}

test('desktop skips the animation bundle; a failed mobile load keeps all routes working',async()=>{
 const f=fixture(false);f.nav.update(f.state());assert.equal(f.calls,0);assert.equal(f.host.children.length,0);
 f.resize(true);assert.equal(f.host.children.length,5);assert.equal(f.calls,1);
 const data=f.host.children.at(-1);data.focus();f.fail();await tick();assert.equal(f.host.children.at(-1),f.document.activeElement);
 const brain=f.host.children[0];assert.equal(brain.attributes['aria-label'],'Deep Brain');brain.onclick();
 data.onclick();assert.deepEqual(f.routes,['brain','data']);
 const next=f.state('data');next.labels=MOBILE_DOCK.map(x=>x.zh);next.hrefs[4]='?page=markets&asset=BTC';f.nav.update(next);
 assert.deepEqual(f.host.children.map(link=>[link.tagName,link.href,link.querySelector('.mobile-nav-label').textContent]),next.labels.map((label,i)=>['a',next.hrefs[i],label]));
 assert.deepEqual(f.host.children.map(link=>link.attributes['aria-label']),next.labels);
 assert.equal(data.attributes['aria-current'],'page');assert.equal(f.calls,1);
});

test('animation hydration uses the latest route and language while preserving keyboard focus',async()=>{
 const f=fixture(true);f.nav.update(f.state());f.host.children[3].focus();
 const next={...f.state('signals'),labels:MOBILE_DOCK.map(x=>x.zh),reducedMotion:true};f.nav.update(next);
 f.ready();await tick();assert.equal(f.mounts,1);assert.equal(f.last,next);assert.equal(f.document.activeElement.dataset.mobileSection,'signals');assert.ok(f.host.contains(f.document.activeElement));
});

test('a pending animation load cannot mount on desktop and a mounted tree is cleaned up',async()=>{
 const f=fixture(true);f.nav.update(f.state());f.resize(false);f.ready();await tick();
 assert.equal(f.mounts,0);assert.equal(f.host.children.length,0);
 f.resize(true);f.ready();await tick();assert.equal(f.mounts,1);assert.equal(f.host.children.length,5);
 f.resize(false);assert.equal(f.destroys,1);assert.equal(f.host.children.length,0);
});

test('the dock uses actual link bounds and only slides between selected sections',()=>{
 const f=fixture(true),{host}=f;
 const route=section=>f.nav.update(f.state(section));
 const geometry=()=>[host.dataset.dockSlide,host.style['--dock-left'],host.style['--dock-width']];
 route('data');assert.deepEqual(geometry(),['rest','243px','60px']);
 route('workbench');assert.deepEqual(geometry(),['left','63px','60px']);
 route('workbench');assert.equal(host.dataset.dockSlide,'left');
 route('signals');assert.deepEqual(geometry(),['right','183px','60px']);
 Object.assign(host.children[3],{offsetLeft:178,offsetWidth:71});
 f.notifyResize();assert.deepEqual(geometry(),['rest','178px','71px']);
 host.pillLeft='50px';route('execution');assert.equal(host.dataset.dockSlide,'right');
 route('assistant');assert.equal(host.dataset.dockSlide,undefined);
 assert.equal(host.querySelector('[aria-current="page"]'),undefined);
 route(null);assert.equal(host.dataset.dockSlide,undefined);
 route('data');assert.equal(host.dataset.dockSlide,'rest');
});
