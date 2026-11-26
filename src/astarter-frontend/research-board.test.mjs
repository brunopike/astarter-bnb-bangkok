import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchBoard,researchSharedDetail} from './research-board.js';
import {MarketResearch} from './live-research.mjs';
import {normalizeResearchBackground} from './market-hub-data.mjs';
import {pair,initLocale,getLocale} from './locale.mjs';
const NOW=Date.UTC(2026,10,17,12),DAY=Date.UTC(2026,10,17);
const row=resource=>({resource,state:'ready',snapshot:normalizeResearchBackground({schema:'public-market-relay-v1',resource,receivedAt:NOW,body:resource==='sentiment'?{data:[{timestamp:String(DAY/1000),value:'37'}]}:resource==='chains'?[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500}]:[{date:DAY/1000,totalCirculatingUSD:{peggedUSD:120}}]},resource,NOW)});
class Element extends EventTarget{
 constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.dataset={};this.attributes=new Map();this.nodes=new Map();this.style={setProperty(){}};this.children=[];this.open=false;this.writes=0;this._html='';this.textContent='';this.nodeType=1;}
 set innerHTML(value){this._html=value;this.writes++;}get innerHTML(){return this._html;}
 setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}hasAttribute(key){return this.attributes.has(key);}
 append(...nodes){this.children.push(...nodes);}prepend(){}contains(){return false;}closest(){return null;}querySelectorAll(){return [];}
 querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Element());return this.nodes.get(key);}showModal(){this.open=true;}close(){this.open=false;this.dispatchEvent(new Event('close'));}
}
test('shared source detail shows finite context, provider and original source versus retrieval time; stale values disappear',()=>{
 const research=new MarketResearch({now:()=>NOW/1000});research.ingest(['sentiment','chains','stablecoins'].map(row));
 const social=researchSharedDetail(research.shared.find(source=>source.id==='social'),NOW);assert.match(social,/37\/100/);assert.match(social,/Alternative.me/);assert.match(social,/2026-11-17 00:00:00 UTC/);assert.match(social,/2026-11-17 12:00:00 UTC/);assert.match(social,/data-status="context"/);
 const chain=researchSharedDetail(research.shared.find(source=>source.id==='chain'),NOW);assert.match(chain,/1,000/);assert.match(chain,/获取时间|Retrieved at/);assert.doesNotMatch(chain,/数据时间 · UTC|Source time · UTC/);
 assert.doesNotMatch(researchSharedDetail(research.shared.find(source=>source.id==='social'),DAY+129600000),/37\/100|data-status="context"/);
 const escaped=researchSharedDetail({...research.shared[0],summary:'<script>bad</script>',assets:['<img>']},NOW);assert.doesNotMatch(escaped,/<script>|<img>/);assert.match(escaped,/&lt;script&gt;/);
});
test('the reachable shared drawer updates on ingest, pause, expiry and locale without changing the selected source',async()=>{
 const keys=['document','location','MutationObserver','NodeFilter'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let now=NOW,dialog;
 const body=new Element('body');body.dataset={workbenchView:'photonic',paused:'false'};const stage=new Element(),ids=new Map(),document=Object.assign(new EventTarget(),{body,activeElement:null,documentElement:{lang:'zh',dataset:{},style:{setProperty(){}}},createTreeWalker:()=>({nextNode:()=>null}),createElement(tag){const element=new Element(tag);if(tag==='dialog')dialog=element;return element;},getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},querySelector:key=>key==='.network-stage'?stage:null,querySelectorAll:()=>[],contains:()=>false});
 const research=new MarketResearch({now:()=>now/1000});let locale;
 try{
  Object.defineProperty(globalThis,'document',{configurable:true,value:document});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/?page=workbench'}});Object.defineProperty(globalThis,'MutationObserver',{configurable:true,value:class{observe(){}disconnect(){}}});Object.defineProperty(globalThis,'NodeFilter',{configurable:true,value:{SHOW_TEXT:4}});
  const ui=createResearchBoard({research,onHandoff(){assert.fail('no handoff');},onChange(){},onSelect(){},notice(){}});ui.openSource('social');const detail=dialog.querySelector('.multi-detail-body');assert.equal(dialog.open,true);assert.doesNotMatch(detail.innerHTML,/37\/100/);
  research.ingest([row('sentiment')]);ui.update();assert.match(detail.innerHTML,/37\/100/);assert.match(detail.innerHTML,/data-status="context"/);const readyWrites=detail.writes;ui.update();assert.equal(detail.writes,readyWrites);
  locale=initLocale();const oldLocale=getLocale();await locale.set(oldLocale==='en'?'zh':'en');ui.update();assert.ok(detail.writes>readyWrites);assert.match(detail.innerHTML,new RegExp(pair('背景参考','Context')));assert.equal(ids.get('multi-detail-title').textContent,research.shared.find(source=>source.id==='social').name);await locale.set(oldLocale);
  research.ingest([{resource:'sentiment',state:'paused',snapshot:null}]);ui.update();assert.doesNotMatch(detail.innerHTML,/37\/100|data-status="context"/);assert.match(detail.innerHTML,/已暂停|paused/);
  research.ingest([row('sentiment')]);ui.update();assert.match(detail.innerHTML,/37\/100/);now=DAY+129600000;ui.update();assert.doesNotMatch(detail.innerHTML,/37\/100|data-status="context"/);assert.match(detail.innerHTML,/已过期|expired/);assert.equal(dialog.open,true);assert.equal(dialog.querySelector('.multi-detail-footer').hidden,true);
 }finally{for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
