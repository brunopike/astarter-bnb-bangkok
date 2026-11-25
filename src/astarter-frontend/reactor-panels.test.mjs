import test from 'node:test';
import assert from 'node:assert/strict';
import {createReactorPanels} from './reactor-panels.js';
import {Simulation} from './simulation.mjs';

test('legacy charts resize from observations without synchronous layout reads and release their observer',()=>{
 const names=['document','ResizeObserver'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const nodes=new Map(),observers=[];
 const node=()=>({
  innerHTML:'',textContent:'',dataset:{},children:[],options:[{}],attrs:new Map(),queries:new Map(),classList:{toggle(){}},
  get clientWidth(){throw new Error('drawing must not force layout');},
  get clientHeight(){throw new Error('drawing must not force layout');},
  setAttribute(key,value){this.attrs.set(key,value);},
  append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},after(){},
  replaceChildren(...items){this.children=items;},remove(){this.removed=true;},addEventListener(){},
  querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,node());return this.queries.get(selector);},
  querySelectorAll(){return [];}
 });
 const getNode=key=>{if(!nodes.has(key))nodes.set(key,node());return nodes.get(key);};
 const document={body:node(),documentElement:{lang:'zh'},createElement:node,getElementById:getNode,querySelector:getNode};
 const ResizeObserver=class{
  constructor(callback){this.callback=callback;observers.push(this);}
  observe(target){this.target=target;}
  disconnect(){this.disconnected=true;}
 };
 for(const [key,value]of Object.entries({document,ResizeObserver}))Object.defineProperty(globalThis,key,{configurable:true,value});
 let panels;
 try{
  panels=createReactorPanels({onSelect(){}});
  const model=new Simulation(),chart=getNode('reactor-price-chart'),initial=JSON.stringify(model);
  assert.equal(observers.length,1);assert.equal(observers[0].target,chart);
  panels.update(model,'BTC/USDT');
  assert.equal(chart.attrs.get('viewBox'),'0 0 500 126');
  assert.match(chart.innerHTML,/observation-core/);
  observers[0].callback([{contentRect:{width:720,height:220}}]);
  panels.update(model,'BTC/USDT');
  assert.equal(chart.attrs.get('viewBox'),'0 0 720 220');
  assert.equal(JSON.stringify(model),initial);
  model.advance(.6);panels.update(model,'ETH/USDT');
  assert.equal(chart.attrs.get('viewBox'),'0 0 720 220');
  panels.dispose();panels=null;assert.equal(observers[0].disconnected,true);
 }finally{
  panels?.dispose();
  for(const [key,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
 }
});
