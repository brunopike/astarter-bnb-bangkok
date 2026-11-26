import test from 'node:test';
import assert from 'node:assert/strict';
import {selectOptions,chooseOption,replacementSelect} from './liquid-select-state.mjs';

function native(options,selectedIndex=0) {
 const events=[],groups=[...new Set(options.map(option=>option.parentElement).filter(group=>group?.tagName==='OPTGROUP'))];
 return {options,selectedIndex,events,disabled:false,ownerDocument:{defaultView:{Event}},
  querySelectorAll(){return groups;},matches(){return this.disabled;},dispatchEvent(event){events.push([event.type,event.bubbles]);}};
}
test('duplicate option values retain distinct native indices and labels',()=>{
 const select=native([{value:'same',label:'Spot'},{value:'same',label:'Perpetual'}]);
 assert.deepEqual(selectOptions(select).map(({value,label})=>[value,label]),[['0','Spot'],['1','Perpetual']]);
 assert.equal(chooseOption(select,'1'),true);assert.equal(select.selectedIndex,1);
 assert.deepEqual(select.events,[['input',true],['change',true]]);
 assert.equal(chooseOption(select,'1'),false);assert.equal(select.events.length,2);
});
test('optgroup labels, disabled groups and hidden options survive adaptation',()=>{
 const group={tagName:'OPTGROUP',label:'Futures',disabled:true};
 const select=native([{label:'Spot'},{label:'BTC',parentElement:group},{label:'Hidden',hidden:true}]);
 const result=selectOptions(select);assert.equal(result.length,2);
 assert.equal(result[1].groupLabel,'Futures');assert.equal(result[1].disabled,true);
 assert.equal(chooseOption(select,'1'),false);assert.equal(chooseOption(select,'2'),false);assert.equal(chooseOption(select,'99'),false);
 assert.equal(select.selectedIndex,0);assert.deepEqual(select.events,[]);
});
test('disabled fields never write or dispatch business events',()=>{
 const select=native([{label:'A'},{label:'B'}]);select.disabled=true;
 assert.equal(chooseOption(select,'1'),false);assert.equal(select.selectedIndex,0);assert.deepEqual(select.events,[]);
});

// The enhancer is bundled with its UI library and React DOM replaced by stubs; the page is a small DOM stand-in.
async function liquidSelectBundle() {
 const {build}=await import('esbuild'),{fileURLToPath}=await import('node:url');
 const stubs={'react-dom/client':'export const createRoot=mount=>({render(){mount.renders=(mount.renders||0)+1;},unmount(){}});',
  './liquid-select-source/liquid-select':'export const LiquidSelect=()=>null;','./liquid-select-source/provider':'export const LiquefyProvider=({children})=>children;','./liquid-select-source/liquefy-ui.css':''};
 const result=await build({entryPoints:[fileURLToPath(new URL('./liquid-select.jsx',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',packages:'external',jsx:'automatic',logLevel:'silent',
  plugins:[{name:'select-stubs',setup(b){b.onResolve({filter:/^(react-dom\/client|\.\/liquid-select-source\/)/},args=>({path:args.path,namespace:'select-stub'}));b.onLoad({filter:/.*/,namespace:'select-stub'},args=>({contents:stubs[args.path],loader:'js'}));}}]});
 const code=result.outputFiles[0].text.replace(/from (["'])([^"']+)\1/g,(_match,_quote,specifier)=>'from '+JSON.stringify(import.meta.resolve(specifier)));
 return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}
function selectPage(t,count) {
 const reads=new Map(),observers={};let doc;
 class Node {
  constructor(tag){Object.assign(this,{localName:tag,nodeType:1,children:[],parentElement:null,attributes:new Map(),style:{},dataset:{},className:'',clientWidth:240});this.classList={contains:name=>this.className.split(' ').includes(name)};}
  get isConnected(){return this===doc.body||Boolean(this.parentElement?.isConnected);}
  matches(selector){return selector===this.localName;}
  closest(){return null;}
  querySelector(){return null;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  before(node){node.remove();const rows=this.parentElement.children;rows.splice(rows.indexOf(this),0,node);node.parentElement=this.parentElement;}
  remove(){if(this.parentElement){const rows=this.parentElement.children;rows.splice(rows.indexOf(this),1);this.parentElement=null;}}
  getAttribute(key){return this.attributes.get(key)??null;}
  hasAttribute(key){return this.attributes.has(key);}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  removeAttribute(key){this.attributes.delete(key);}
  toggleAttribute(key,on){if(on)this.setAttribute(key,'');else this.removeAttribute(key);}
  addEventListener(){}
  getBoundingClientRect(){reads.set(this,(reads.get(this)||0)+1);return this.box||{width:0,height:0};}
 }
 doc={documentElement:{dataset:{}},activeElement:null,createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){}};doc.body=new Node('body');
 const fakes={matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
  getComputedStyle:()=>({fontSize:'14px',flex:'0 1 auto',order:'0',alignSelf:'auto',gridColumn:'auto',gridRow:'auto',paddingLeft:'0px',paddingRight:'0px',display:'block',flexGrow:'0',getPropertyValue:()=>''}),
  IntersectionObserver:class{constructor(callback){this.callback=callback;this.targets=new Set();observers.visible=this;}observe(node){this.targets.add(node);}unobserve(node){this.targets.delete(node);}disconnect(){this.targets.clear();}},
  MutationObserver:class{constructor(callback){this.callback=callback;}observe(node){if(node===doc.body)observers.page=this;}disconnect(){}}};
 for(const [key,value] of Object.entries(fakes)){const own=Object.getOwnPropertyDescriptor(globalThis,key);globalThis[key]=value;t.after(()=>{if(own)Object.defineProperty(globalThis,key,own);else delete globalThis[key];});}
 // A closed pane holds the selects (no box); the header credit count changes text on every frame.
 const pane=new Node('section'),credit=new Node('b'),selects=[];doc.body.append(pane,credit);
 for(let index=0;index<count;index++){
  const field=new Node('label'),select=new Node('select');pane.append(field);field.append(select);
  Object.assign(select,{multiple:false,size:0,options:[],selectedOptions:[],selectedIndex:-1,value:'',required:false,title:'',validity:{valid:true},labels:[]});
  select.setAttribute('aria-label','Field '+index);selects.push(select);
 }
 return {doc,selects,reads:select=>reads.get(select)||0,watched:select=>observers.visible.targets.has(select),
  frame(){observers.page.callback([{type:'childList',target:credit,addedNodes:[],removedNodes:[]}]);},
  intersect(select){observers.visible.callback([{target:select,isIntersecting:true}]);}};
}
test('selects without a box leave the pending set and are measured again only when they come into view',async t=>{
 const {mountLiquidSelects}=await liquidSelectBundle(),page=selectPage(t,3),settle=()=>new Promise(resolve=>setImmediate(resolve));
 const stop=mountLiquidSelects(page.doc);await settle();
 assert.deepEqual(page.selects.map(page.reads),[1,1,1]);
 for(let frame=0;frame<5;frame++){page.frame();await settle();}
 assert.deepEqual(page.selects.map(page.reads),[1,1,1]);
 assert.ok(page.selects.every(page.watched));
 const [shown,...closed]=page.selects;shown.box={width:180,height:40};page.intersect(shown);await settle();
 assert.equal(page.reads(shown),2);assert.equal(shown.parentElement.className,'liquid-native-host');assert.equal(shown.parentElement.children[1].renders,1);assert.equal(page.watched(shown),false);
 page.frame();await settle();
 assert.deepEqual(closed.map(page.reads),[1,1]);assert.ok(closed.every(select=>select.parentElement.localName==='label'&&page.watched(select)));
 stop();
});
test('fields of a page rendered by a click are measured and enhanced after its first frame, not in the click task',async t=>{
 const {mountLiquidSelects}=await liquidSelectBundle(),page=selectPage(t,0),settle=()=>new Promise(resolve=>setImmediate(resolve));
 // Keep the page observer to deliver the records of the click; the stand-in itself is restored by selectPage.
 const PageObserver=globalThis.MutationObserver;let changes;
 globalThis.MutationObserver=class extends PageObserver{observe(node){super.observe(node);if(node===page.doc.body)changes=this;}};
 const stop=mountLiquidSelects(page.doc);await settle();
 const view=page.doc.createElement('section'),fields=[];
 // The stand-in's closest() always returns null; the nodes of the click find themselves or their nearest match above, as in a page,
 // so the attribute record below reaches the page observer's path for a changed field that is not yet enhanced.
 const closest=function(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;};view.closest=closest;
 for(let index=0;index<2;index++){
  const field=page.doc.createElement('label'),select=page.doc.createElement('select');view.append(field);field.append(select);field.closest=closest;
  Object.assign(select,{multiple:false,size:0,options:[],selectedOptions:[],selectedIndex:-1,value:'',required:false,title:'',validity:{valid:true},labels:[],box:{width:180,height:40},closest});
  select.setAttribute('aria-label','Route field '+index);fields.push(select);
 }
 // The click task inserts the new page and then updates one of its fields; settle stands for the end of that task.
 page.doc.body.append(view);
 changes.callback([{type:'childList',target:page.doc.body,addedNodes:[view],removedNodes:[]},{type:'attributes',target:fields[0],addedNodes:[],removedNodes:[]}]);
 await settle();
 assert.deepEqual(fields.map(page.reads),[0,0]);
 assert.ok(fields.every(select=>select.parentElement.localName==='label'&&page.watched(select)));
 // The visibility observer reports after the frame is drawn; each field is then measured once and enhanced.
 for(const select of fields)page.intersect(select);
 await settle();
 assert.deepEqual(fields.map(page.reads),[1,1]);
 assert.ok(fields.every(select=>select.parentElement.className==='liquid-native-host'&&select.parentElement.children[1].renders===1&&!page.watched(select)));
 stop();
});

test('when a filter repaints, only its unique matching native control can reclaim focus',()=>{
 const field=values=>({attributes:Object.entries(values).map(([name,value])=>({name,value})),getAttribute:key=>values[key]??null});
 const original=field({'data-news-date':'','aria-label':'Date',tabindex:'-1','aria-hidden':'true'});
 const next=field({'data-news-date':'','aria-label':'Date'}),other=field({'data-news-source':'','aria-label':'Source'});
 assert.equal(replacementSelect(original,{querySelectorAll:()=>[other,next]}),next);
 assert.equal(replacementSelect(original,{querySelectorAll:()=>[next,next]}),null);
 assert.equal(replacementSelect(original,{querySelectorAll:()=>[other]}),null);
 assert.equal(replacementSelect(field({}),{querySelectorAll:()=>[next]}),null);
});
