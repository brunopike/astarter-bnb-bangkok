import React,{Component,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {LiquidSelect} from './liquid-select-source/liquid-select';
import {LiquefyProvider} from './liquid-select-source/provider';
import {chooseOption,replacementSelect,selectLabel,selectOptions} from './liquid-select-state.mjs';
import {refreshSelectIdentity} from './brand-icons.mjs';
import './liquid-select-source/liquefy-ui.css';

class NativeFallback extends Component {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error){queueMicrotask(()=>this.props.onError(error));}
 render(){return this.state.failed?null:this.props.children;}
}

function SelectField({entry,state}) {
 useLayoutEffect(()=>{entry.ready();},[entry]);
 return <LiquefyProvider className="astarter-liquid" theme={state.theme} tint={state.tint}
  motion={false} lens={false} glow={false} webgl={false} ripple={false} shimmer={false} sparkle={false}
  transparency={false} portalContainer={entry.portal}>
  <LiquidSelect options={state.options} value={state.value} disabled={state.disabled} placeholder={state.placeholder}
   aria-label={state.label||undefined} aria-labelledby={state.labelledBy||undefined}
   aria-describedby={state.describedBy||undefined} aria-required={state.required||undefined}
   aria-invalid={state.invalid||undefined} title={state.title||undefined}
   tabIndex={entry.tabIndex===null?0:Number(entry.tabIndex)}
   onOpenChange={open=>{entry.host.toggleAttribute('data-liquid-open',open);if(open)entry.update();}}
   onValueChange={entry.choose} />
 </LiquefyProvider>;
}

// The native field remains the source of form values, validation and business events.
export function mountLiquidSelects(doc=document) {
 const entries=new Map(),pending=new Set(),failed=new WeakSet(),media=matchMedia('(prefers-reduced-motion: reduce)');
 let scheduled=false,returnFocus=null;
 const schedule=()=>{if(!scheduled){scheduled=true;queueMicrotask(flush);}};
 function restoreChoice(entry){
  const choice=returnFocus;
  if(choice?.field!==entry.native)return;
  requestAnimationFrame(()=>{
   if(returnFocus!==choice)return;
   returnFocus=null;
   const active=doc.activeElement;
   if(entry.native.isConnected&&(active===doc.body||active===entry.native||choice.portal?.contains(active)))entry.focus();
  });
 }
 const visible=new IntersectionObserver(records=>{
  for(const record of records)if(record.isIntersecting){pending.add(record.target);schedule();}
 },{rootMargin:'120px'});
 const eligible=select=>!select.multiple&&select.size<=1&&!select.hasAttribute('data-native-select');
 function focusRenderedSelect(field,portal=null){
  if(!field||field.matches(':disabled')||field.closest('[hidden],[inert]')||!field.getClientRects().length||failed.has(field)||!eligible(field))return false;
  returnFocus={field,portal};
  const mounted=entries.get(field);
  if(mounted?.host.hasAttribute('data-liquid-ready'))restoreChoice(mounted);
  else enhance(field);
  return true;
 }
 const discover=(node,now=false)=>{
  if(node.nodeType!==1)return;
  for(const select of node.matches('select')?[node]:node.querySelectorAll('select')) {
   if(entries.has(select)||failed.has(select)||!eligible(select))continue;
   // Fields added after the first scan wait for the visibility observer, so a click never measures them before its first frame.
   if(now)pending.add(select);visible.observe(select);
  }
 };
 const read=entry=>{
  const native=entry.native,style=getComputedStyle(native),theme=doc.documentElement.dataset.theme==='light'?'light':'dark';
  const options=selectOptions(native),value=String(native.selectedIndex);
  return {options,value:options.some(option=>option.value===value)?value:null,placeholder:native.selectedOptions[0]?.label||'',
   disabled:native.matches(':disabled'),required:native.required,invalid:entry.invalid&&!native.validity.valid,
   label:selectLabel(native),labelledBy:native.getAttribute('aria-labelledby'),describedBy:native.getAttribute('aria-describedby'),
   title:native.title,theme,tint:style.getPropertyValue('--b-violet').trim()||(theme==='light'?'#00667d':'#6fe3ff'),
   reduced:media.matches||doc.documentElement.dataset.reducedMotion==='true'};
 };
 function enhance(native) {
  if(!native.isConnected||entries.has(native)||!eligible(native)||failed.has(native)||(doc.activeElement===native&&returnFocus?.field!==native))return;
  // A field without a box stays observed; the visibility observer adds it back when it can be measured.
  const box=native.getBoundingClientRect();if(!box.width||!box.height){pending.delete(native);return;}
  visible.unobserve(native);pending.delete(native);
  const style=getComputedStyle(native),parent=native.parentElement,host=doc.createElement('span'),mount=doc.createElement('span');
  const parentStyle=getComputedStyle(parent),available=parent.clientWidth-parseFloat(parentStyle.paddingLeft)-parseFloat(parentStyle.paddingRight);
  const flexIntrinsic=getComputedStyle(parent.parentElement).display.includes('flex')&&parentStyle.flexGrow==='0';
  const stretch=parentStyle.display==='grid'||parent.classList.contains('brand-select')||box.width>=available-3&&!flexIntrinsic;
  host.className='liquid-native-host';mount.className='liquid-native-mount';
  host.style.cssText=`--liquid-field-width:${box.width}px;--liquid-field-height:${Math.max(36,box.height)}px;--liquid-field-font:${style.fontSize};flex:${style.flex};order:${style.order};align-self:${style.alignSelf};grid-column:${style.gridColumn};grid-row:${style.gridRow};`;
  if(stretch)host.dataset.stretch='';
  const oldButton=native.querySelector(':scope>button:has(selectedcontent)');oldButton?.remove();
  native.before(host);host.append(native,mount);
  // Owners may replace dialog.innerHTML; React only owns children of this stable, detachable slot.
  const portal=doc.createElement('span');portal.className='liquid-select-portal-slot';portal.style.display='contents';
  (native.closest('dialog,[popover],details')||doc.body).append(portal);
  const abort=new AbortController(),descriptors=new Map();
  const entry={native,host,mount,portal,tabIndex:native.getAttribute('tabindex'),ariaHidden:native.getAttribute('aria-hidden'),
   root:createRoot(mount),invalid:false,signature:'',oldButton,ready(){
    if(host.hasAttribute('data-liquid-ready'))return;
    const focus=doc.activeElement===native;
    host.setAttribute('data-liquid-ready','');native.tabIndex=-1;native.setAttribute('aria-hidden','true');
    if(focus)entry.focus();restoreChoice(entry);
   },focus(){host.querySelector('.lq-select__trigger')?.focus({preventScroll:true});},choose(index){
    const scope=native.closest('dialog,#product-page,.workspace')||doc.body,page=doc.body.dataset.page;
    const ownedFocus=doc.activeElement===doc.body||host.contains(doc.activeElement)||portal.contains(doc.activeElement);
    const changed=chooseOption(native,index);entry.update();
    if(!changed||native.isConnected||!ownedFocus)return;
    queueMicrotask(()=>{
     if(!scope.isConnected||doc.body.dataset.page!==page)return;
     const next=replacementSelect(native,scope);
     if(!next)return;
     if(doc.activeElement!==doc.body&&doc.activeElement!==next&&!portal.contains(doc.activeElement))return;
     if(!focusRenderedSelect(next,portal)&&!next.matches(':disabled')&&next.getClientRects().length)next.focus({preventScroll:true});
    });
   },update(){
    if(!native.isConnected||!entries.has(native))return;
    refreshSelectIdentity(native);
    const state=read(entry),signature=JSON.stringify(state);if(signature===entry.signature)return;
    entry.signature=signature;entry.root.render(<NativeFallback onError={error=>{console.warn('Liquid select kept native control',error);failed.add(native);destroy(entry);}}><SelectField entry={entry} state={state}/></NativeFallback>);
   }};
  entries.set(native,entry);
  // Per-field descriptors preserve assignment without changing HTMLSelectElement globally.
  for(const key of ['value','selectedIndex']) {
   const own=Object.getOwnPropertyDescriptor(native,key);if(own&&!own.configurable)continue;
   const base=own||Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,key);
   if(!base?.get||!base?.set)continue;
   descriptors.set(key,own);
   Object.defineProperty(native,key,{configurable:true,enumerable:base.enumerable,get(){return base.get.call(this);},set(value){base.set.call(this,value);queueMicrotask(()=>entry.update());}});
  }
  entry.dispose=()=>{
   abort.abort();
   for(const [key,own] of descriptors){if(own)Object.defineProperty(native,key,own);else delete native[key];}
  };
  native.addEventListener('focus',()=>entry.focus(),{signal:abort.signal});
  native.addEventListener('invalid',()=>{entry.invalid=true;entry.update();queueMicrotask(()=>entry.focus());},{signal:abort.signal});
  for(const type of ['input','change'])native.addEventListener(type,()=>entry.update(),{signal:abort.signal});
  entry.update();
 }
 function destroy(entry) {
  if(returnFocus?.field===entry.native)returnFocus=null;
  entries.delete(entry.native);entry.dispose();entry.root.unmount();entry.portal.remove();
  const {native,host,tabIndex,ariaHidden}=entry;
  if(tabIndex===null)native.removeAttribute('tabindex');else native.setAttribute('tabindex',tabIndex);
  if(ariaHidden===null)native.removeAttribute('aria-hidden');else native.setAttribute('aria-hidden',ariaHidden);
  if(entry.oldButton)native.prepend(entry.oldButton);
  if(host.parentNode){host.before(native);host.remove();}
 }
 function flush() {
  scheduled=false;
  if(returnFocus&&!returnFocus.field.isConnected)returnFocus=null;
  for(const entry of entries.values())if(!entry.native.isConnected||!eligible(entry.native))destroy(entry);
  for(const select of pending){if(!select.isConnected){pending.delete(select);visible.unobserve(select);}else enhance(select);}
 }
 const observer=new MutationObserver(records=>{
  const dirty=new Set();
  for(const record of records) {
   const target=record.target.nodeType===1?record.target:record.target.parentElement;
   const native=target?.closest('select');if(native){if(entries.has(native))dirty.add(entries.get(native));else discover(native);}
   if(target?.matches('fieldset'))for(const select of target.querySelectorAll('select'))if(entries.has(select))dirty.add(entries.get(select));
   for(const node of record.addedNodes)discover(node);
  }
  for(const entry of dirty)entry.update();
  schedule();
 });
 observer.observe(doc.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','required','multiple','size','selected','value','label','hidden','aria-label','aria-labelledby','aria-describedby','title']});
 const refresh=()=>{for(const entry of entries.values())entry.update();};
 const themeObserver=new MutationObserver(refresh);
 themeObserver.observe(doc.documentElement,{attributes:true,attributeFilter:['data-theme','data-reduced-motion','lang']});
 // A native reset applies its default action after the event's microtask checkpoint.
 const reset=event=>setTimeout(()=>{for(const entry of entries.values())if(entry.native.form===event.target){entry.invalid=false;entry.update();}},0);
 const focusRequest=event=>{if(event.target.tagName==='SELECT'&&focusRenderedSelect(event.target))event.preventDefault();};
 const cancelReturn=()=>{returnFocus=null;};
 doc.addEventListener('hive:focus-select',focusRequest);
 doc.addEventListener('pointerdown',cancelReturn,true);doc.addEventListener('keydown',cancelReturn,true);
 doc.addEventListener('reset',reset,true);doc.addEventListener('focusout',schedule);media.addEventListener('change',refresh);
 discover(doc.body,true);schedule();
 return ()=>{observer.disconnect();themeObserver.disconnect();visible.disconnect();doc.removeEventListener('hive:focus-select',focusRequest);doc.removeEventListener('pointerdown',cancelReturn,true);doc.removeEventListener('keydown',cancelReturn,true);doc.removeEventListener('reset',reset,true);doc.removeEventListener('focusout',schedule);media.removeEventListener('change',refresh);for(const entry of [...entries.values()])destroy(entry);};
}
