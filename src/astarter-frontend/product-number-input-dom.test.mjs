import test from 'node:test';
import assert from 'node:assert/strict';
import {createNumberInputs,refreshNumberInputs} from './product-number-input.mjs';

function fixture(){
 let doc;
 class Element{
  constructor(tag){this.localName=tag;this.tagName=tag.toUpperCase();this.nodeType=1;this.ownerDocument=doc;this.attributes=new Map();this.children=[];this.style={};this.dataset={};this.hidden=false;this._text='';this.clientWidth=240;this.clientHeight=44;this.clientLeft=0;this.clientTop=0;this.scrollLeft=0;this.scrollTop=0;this.animations=[];}
  get isConnected(){return this===doc.documentElement||Boolean(this.parentElement?.isConnected);}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set textContent(value){this._text=String(value);for(const child of [...this.children])child.remove();}
  get offsetWidth(){return this.localName==='number-figure'?this.children.filter(child=>!child.hidden).reduce((width,child)=>width+child.textContent.length*8,0):this.textContent.length*8;}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)??null;}
  hasAttribute(key){return this.attributes.has(key);}
  removeAttribute(key){this.attributes.delete(key);}
  toggleAttribute(key,value){if(value)this.setAttribute(key,'');else this.removeAttribute(key);}
  append(child){child.remove();child.parentElement=this;this.children.push(child);}
  remove(){if(this.parentElement){const rows=this.parentElement.children;rows.splice(rows.indexOf(this),1);this.parentElement=null;}}
  closest(selector){for(let node=this;node;node=node.parentElement)if([...selector.matchAll(/\[([^\]]+)\]/g)].some(match=>node.hasAttribute(match[1])))return node;return null;}
  querySelectorAll(){return this.children.flatMap(child=>[...(child.localName==='input'?[child]:[]),...child.querySelectorAll()]);}
  getBoundingClientRect(){return {left:this.localName==='input'?20:0,top:this.localName==='input'?20:0,width:240,height:44};}
  animate(){const animation={cancel(){this.cancelled=true;this.oncancel?.();}};this.animations.push(animation);return animation;}
 }
 const frames=new Map(),listeners=new Map(),observers=[];let nextFrame=0;
 const reduced={matches:false,addEventListener(){},removeEventListener(){}};
 doc={nodeType:9,hidden:false,activeElement:null,fonts:{ready:Promise.resolve()},addEventListener(name,listener){listeners.set(name,listener);},removeEventListener(name){listeners.delete(name);},createElement:tag=>new Element(tag),querySelectorAll:()=>doc.documentElement.querySelectorAll()};
 doc.documentElement=new Element('html');doc.documentElement.dataset={};
 doc.defaultView={matchMedia:()=>reduced,requestAnimationFrame:callback=>{frames.set(++nextFrame,callback);return nextFrame;},cancelAnimationFrame:id=>frames.delete(id),getComputedStyle:input=>({overflowX:input.style.overflow||'visible',overflowY:input.style.overflow||'visible',paddingLeft:'8px',paddingRight:'8px',paddingTop:'0px',paddingBottom:'0px',fontFamily:'Inter',fontSize:input.style.fontSize||'16px',fontWeight:'500',lineHeight:'24px',letterSpacing:'0px',color:'#eee',opacity:input.disabled?'.5':'1',textAlign:'left'}),ResizeObserver:class{observe(){}unobserve(){}disconnect(){this.closed=true;}},MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.closed=true;}}};
 const host=new Element('section'),form=new Element('form'),input=new Element('input');doc.documentElement.append(host);host.append(form);form.append(input);
 Object.assign(input,{type:'number',inputMode:'decimal',name:'amount',placeholder:'',labels:[{textContent:'Amount · USDT'}],offsetParent:host,validity:{badInput:false},value:'1234.5',valueWrites:0});
 let raw=input.value;Object.defineProperty(input,'value',{get:()=>raw,set:value=>{input.valueWrites++;raw=String(value);}});Object.defineProperty(input,'valueAsNumber',{get:()=>raw===''?NaN:Number(raw)});
 for(const [name,value]of Object.entries({name:'amount',type:'number',min:'0.25',max:'100000',step:'0.25',required:'','aria-label':'Amount'}))input.setAttribute(name,value);
 input.setCustomValidity=()=>{throw new Error('presentation must not change validity');};input.stepUp=()=>{input.value=Number(input.value)+.25;};
 const flush=()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback();};
 return {doc,host,form,input,reduced,observers,listeners,flush,emit:(name,target=input)=>listeners.get(name)?.({target}),mirror:()=>host.children.find(node=>node.localName==='number-mirror')};
}

test('native identity, form values and constraints survive formatting, focus, programmatic updates and reset',async()=>{
 const f=fixture(),{doc,input,form}=f,attributes=new Map(input.attributes),controller=createNumberInputs(doc);f.flush();
 assert.equal(createNumberInputs(doc),controller);assert.equal(input.parentElement,form);assert.equal(input.value,'1234.5');assert.equal(input.valueAsNumber,1234.5);assert.equal(input.valueWrites,0);
 assert.equal(f.mirror().textContent,'1,234.50');assert.equal(f.mirror().getAttribute('aria-hidden'),'true');assert.equal(f.mirror().querySelectorAll().length,0,'the mirror is not a second form control');
 doc.activeElement=input;f.emit('focusin');input.value='0.00000001';const writes=input.valueWrites;f.emit('input');f.flush();
 assert.equal(f.mirror().hidden,true);assert.equal(input.hasAttribute('data-number-ready'),false);assert.equal(input.value,'0.00000001');assert.equal(input.valueWrites,writes);
 doc.activeElement=null;f.emit('focusout');f.flush();assert.equal(f.mirror().textContent,'0.00000001');
 input.value='0012.30';refreshNumberInputs(input);f.flush();assert.equal(f.mirror().textContent,'12.30');assert.equal(input.value,'0012.30');
 input.value='2000.50';refreshNumberInputs(input);f.flush();assert.equal(input.value,'2000.50');assert.equal(f.mirror().textContent,'2,000.50');
 f.emit('click');input.stepUp();await Promise.resolve();f.flush();assert.equal(input.value,'2000.75');assert.equal(f.mirror().textContent,'2,000.75');
 f.emit('reset',form);input.value='1234.5';await Promise.resolve();f.flush();assert.equal(f.mirror().textContent,'1,234.50');
 for(const [name,value]of attributes)assert.equal(input.getAttribute(name),value);
 controller.dispose();assert.equal(input.value,'1234.5');assert.equal(input.parentElement,form);assert.equal(f.mirror(),undefined);assert.equal(input.hasAttribute('data-number-input'),false);assert.equal(f.listeners.size,0);assert.ok(f.observers.every(observer=>observer.closed));
});

test('placeholder, bad input, reduced motion and removed nodes keep their native state and release decorations',()=>{
 const f=fixture(),controller=createNumberInputs(f.doc);f.flush();f.input.placeholder='Auto';f.input.value='';controller.refresh(f.input);f.flush();assert.equal(f.mirror().hidden,true);assert.equal(f.input.value,'');
 f.input.placeholder='';f.input.value='0';controller.refresh(f.input);f.flush();assert.equal(f.mirror().textContent,'0.00');assert.equal(f.input.valueAsNumber,0);
 f.input.validity.badInput=true;controller.refresh(f.input);f.flush();assert.equal(f.mirror().hidden,true);f.input.validity.badInput=false;
 const animations=f.mirror().children[0].children.flatMap(node=>node.animations),count=animations.length;f.reduced.matches=true;f.input.value='10';controller.refresh(f.input);f.flush();assert.equal(f.mirror().children[0].children.reduce((n,node)=>n+node.animations.length,0),count);assert.ok(animations.every(animation=>animation.cancelled));
 f.form.remove();f.observers[0].callback([{type:'childList',target:f.host,addedNodes:[]}]);assert.equal(f.mirror(),undefined);assert.equal(f.input.value,'10');controller.dispose();
});


test('compact desktop controls retain their existing readable type size',()=>{
 const f=fixture();f.input.style.fontSize='14px';const controller=createNumberInputs(f.doc);f.flush();
 assert.equal(f.mirror().hidden,false);assert.equal(f.mirror().style.fontSize,'14px');assert.equal(f.input.hasAttribute('data-number-ready'),true);
 controller.dispose();
});


test('a mirror outside a scrolling parent respects the native field clipping',()=>{
 const f=fixture();f.form.style.overflow='hidden';const controller=createNumberInputs(f.doc);f.flush();
 assert.equal(f.mirror().parentElement,f.host);assert.equal(f.mirror().style.clipPath,'inset(0px 12px 20px 0px)');
 f.input.offsetParent=null;controller.refresh(f.input);f.flush();assert.equal(f.mirror().hidden,true);
 controller.dispose();
});
