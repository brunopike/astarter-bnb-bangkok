// Presentation adapted from kuratlielia's Money Input (MIT), https://21st.dev/@kuratlielia/components/money-input.
const selector='input[type="number"],input[inputmode="decimal"]';
const controllers=new WeakMap();

export function isNumberInput(input){
 return input?.localName==='input'&&!input.hasAttribute('data-number-exclude')&&input.getAttribute('autocomplete')!=='one-time-code'&&!input.closest?.('[data-rk],[data-number-exclude]')&&(input.type==='number'||input.type==='text'&&input.inputMode==='decimal');
}

export function numberInputConfiguration(input){
 const hint=input.getAttribute('data-number-fraction-digits'),step=input.getAttribute('step')||'1';
 const label=[...(input.labels||[])].map(node=>node.textContent).join(' ');
 const units=[...(input.parentElement?.children||[])].filter(node=>node!==input&&!node.hasAttribute?.('data-number-mirror')).map(node=>node.textContent).join(' ');
 const money=/\b(?:USD|USDT|USDC|EUR|GBP|HKD|CNY)\b|\$|美元/.test(label+' '+units)||input.name==='dollars';
 const decimals=step.match(/\.(\d+)$/)?.[1].length||Number(step.match(/e-(\d+)$/i)?.[1]||0);
 return {minimumFractionDigits:hint!==null&&/^\d{1,2}$/.test(hint)&&Number(hint)<=12?Number(hint):money?2:Math.min(12,decimals)};
}

export function numberInputParts(value,minimumFractionDigits=0){
 const raw=String(value??''),match=raw.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
 if(!match||raw&&!/\d/.test(raw))return [{key:'raw',char:raw,ghost:false}];
 const [,sign,whole,fraction]=match,integer=whole.replace(/^0+(?=\d)/,'')||'0',parts=[];
 if(sign)parts.push({key:'sign',char:sign,ghost:false});
 [...integer].forEach((char,index)=>{const place=integer.length-index-1;parts.push({key:'i'+place,char,ghost:!whole});if(place&&place%3===0)parts.push({key:'g'+place,char:',',ghost:!whole});});
 const digits=Math.max(fraction?.length||0,Number.isFinite(minimumFractionDigits)?Math.max(0,Math.min(12,minimumFractionDigits)):0);
 if(fraction!==undefined||digits){parts.push({key:'decimal',char:'.',ghost:fraction===undefined});for(let i=0;i<digits;i++)parts.push({key:'f'+i,char:fraction?.[i]??'0',ghost:fraction===undefined||i>=fraction.length});}
 return parts;
}

export function refreshNumberInputs(scope=document){
 const doc=scope.ownerDocument||scope;
 controllers.get(doc)?.refresh(scope);
}

export function createNumberInputs(doc=document){
 if(controllers.has(doc))return controllers.get(doc);
 const view=doc.defaultView,states=new Map(),pending=new Map(),reduced=view.matchMedia('(prefers-reduced-motion: reduce)');
 let frame=0,disposed=false;
 const moving=()=>!doc.hidden&&!reduced.matches&&doc.documentElement.dataset.reducedMotion!=='true';
 const cancel=state=>{for(const animation of state.animations)animation.cancel();state.animations.clear();};
 const hide=state=>{state.mirror.hidden=true;state.input.removeAttribute('data-number-ready');};
 function remove(input){const state=states.get(input);if(!state)return;cancel(state);state.mirror.remove();input.removeAttribute('data-number-input');input.removeAttribute('data-number-ready');resize.unobserve(input);states.delete(input);}
 function attach(input){
  if(states.has(input))return states.get(input);
  const mirror=doc.createElement('number-mirror'),figure=doc.createElement('number-figure');
  mirror.className='number-presentation';mirror.dataset.numberMirror='';mirror.setAttribute('aria-hidden','true');mirror.setAttribute('data-no-translate','');mirror.hidden=true;
  figure.className='number-presentation-value';mirror.append(figure);input.setAttribute('data-number-input','');
  const state={input,mirror,figure,columns:new Map(),animations:new Set(),raw:null};states.set(input,state);resize.observe(input);return state;
 }
 function synchronize(input,animate=true){
  if(!isNumberInput(input)||!input.isConnected){remove(input);return;}
  const state=attach(input),raw=input.value,focused=doc.activeElement===input,host=input.offsetParent,rect=input.getBoundingClientRect();
  if(focused||!host||!rect.width||!rect.height||input.validity?.badInput||!raw&&input.placeholder){hide(state);cancel(state);state.raw=raw;return;}
  if(state.mirror.parentElement!==host)host.append(state.mirror);
  const style=view.getComputedStyle(input),parent=host.getBoundingClientRect(),left=parseFloat(style.paddingLeft)||0,right=parseFloat(style.paddingRight)||0,top=parseFloat(style.paddingTop)||0,bottom=parseFloat(style.paddingBottom)||0;
  const available=Math.max(0,input.clientWidth-left-right),height=Math.max(0,input.clientHeight-top-bottom);
  Object.assign(state.mirror.style,{left:rect.left-parent.left-host.clientLeft+host.scrollLeft+input.clientLeft+left+'px',top:rect.top-parent.top-host.clientTop+host.scrollTop+input.clientTop+top+'px',width:available+'px',height:height+'px',fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,lineHeight:style.lineHeight,letterSpacing:style.letterSpacing,color:style.color,opacity:style.opacity,justifyContent:['right','end'].includes(style.textAlign)?'flex-end':'flex-start'});
  const box={left:rect.left+input.clientLeft+left,top:rect.top+input.clientTop+top};
  const clip={left:box.left,top:box.top,right:box.left+available,bottom:box.top+height};
  for(let ancestor=input.parentElement;ancestor&&ancestor!==host;ancestor=ancestor.parentElement){
   const overflow=view.getComputedStyle(ancestor),bounds=ancestor.getBoundingClientRect();
   if(/auto|scroll|hidden|clip/.test(overflow.overflowX)){clip.left=Math.max(clip.left,bounds.left+ancestor.clientLeft);clip.right=Math.min(clip.right,bounds.left+ancestor.clientLeft+ancestor.clientWidth);}
   if(/auto|scroll|hidden|clip/.test(overflow.overflowY)){clip.top=Math.max(clip.top,bounds.top+ancestor.clientTop);clip.bottom=Math.min(clip.bottom,bounds.top+ancestor.clientTop+ancestor.clientHeight);}
  }
  state.mirror.style.clipPath=`inset(${Math.max(0,clip.top-box.top)}px ${Math.max(0,box.left+available-clip.right)}px ${Math.max(0,box.top+height-clip.bottom)}px ${Math.max(0,clip.left-box.left)}px)`;
  state.figure.style.transformOrigin=['right','end'].includes(style.textAlign)?'right center':'left center';
  const parts=numberInputParts(raw,numberInputConfiguration(input).minimumFractionDigits),keys=new Set(parts.map(part=>part.key));
  const changed=state.raw!==null&&state.raw!==raw,direction=Number(raw)>=Number(state.raw)?1:-1;
  cancel(state);
  for(const part of parts){
   let column=state.columns.get(part.key),old=column?.textContent;
   if(!column){column=doc.createElement('number-digit');column.className='number-presentation-digit';state.columns.set(part.key,column);}
   column.textContent=part.char;column.toggleAttribute('data-ghost',part.ghost);column.hidden=false;state.figure.append(column);
   if(animate&&changed&&old!==part.char&&moving()&&column.animate){const animation=column.animate([{transform:`translateY(${direction*.4}em)`,opacity:0},{transform:'translateY(0)',opacity:1}],{duration:180,easing:'cubic-bezier(.16,1,.3,1)'});state.animations.add(animation);animation.onfinish=animation.oncancel=()=>state.animations.delete(animation);}
  }
  for(const [key,column]of state.columns)if(!keys.has(key)){column.remove();state.columns.delete(key);}
  state.mirror.hidden=false;
  const typeSize=parseFloat(style.fontSize),minimumSize=Math.min(16,typeSize);
  let natural=state.figure.offsetWidth,scale=natural?Math.min(1,available/natural):1;
  if(scale*typeSize<minimumSize){for(const column of state.columns.values())if(column.hasAttribute('data-ghost'))column.hidden=true;natural=state.figure.offsetWidth;scale=natural?Math.min(1,available/natural):1;}
  // Keep the readable native control when the actual digits cannot fit at its existing type size.
  if(!available||!height||scale*typeSize<minimumSize){hide(state);cancel(state);state.raw=raw;return;}
  state.figure.style.transform=`scale(${scale})`;input.setAttribute('data-number-ready','');state.raw=raw;
 }
 function flush(){frame=0;const batch=[...pending];pending.clear();for(const [input,animate]of batch)synchronize(input,animate);}
 function queue(input,animate=true){if(disposed)return;pending.set(input,Boolean(animate&&pending.get(input)!==false));if(!frame)frame=view.requestAnimationFrame(flush);}
 function scan(scope,animate=true){
  if(isNumberInput(scope))queue(scope,animate);
  for(const input of scope.querySelectorAll?.(selector)||[])if(isNumberInput(input))queue(input,animate);
 }
 const resize=new view.ResizeObserver(entries=>{for(const entry of entries)if(states.has(entry.target))queue(entry.target,false);});
 const observer=new view.MutationObserver(records=>{
  for(const record of records){
   if(record.target.closest?.('[data-number-mirror]'))continue;
   if(record.type==='attributes'){
    if(record.target===doc.documentElement){for(const input of states.keys())queue(input,false);}
    else if(states.has(record.target)||isNumberInput(record.target))queue(record.target,false);
    else if(record.attributeName==='disabled')scan(record.target,false);
   }else for(const node of record.addedNodes)if(node.nodeType===1&&!node.hasAttribute('data-number-mirror'))scan(node,false);
  }
  for(const input of states.keys())if(!input.isConnected)remove(input);
 });
 const onFocus=event=>{const state=states.get(event.target);if(state){hide(state);cancel(state);state.raw=event.target.value;}};
 const onInput=event=>{if(isNumberInput(event.target))queue(event.target,false);};
 const onBlur=event=>{if(isNumberInput(event.target))queue(event.target,false);};
 const onReset=event=>queueMicrotask(()=>scan(event.target,false));
 const onClick=()=>queueMicrotask(()=>{if(!disposed)for(const input of states.keys())queue(input,true);});
 const onScroll=()=>{for(const input of states.keys())queue(input,false);};
 const onMotion=()=>{for(const state of states.values())cancel(state);for(const input of states.keys())queue(input,false);};
 const listeners=[['focusin',onFocus],['focusout',onBlur],['input',onInput],['change',onInput],['reset',onReset],['click',onClick],['scroll',onScroll],['visibilitychange',onMotion]];
 for(const [name,listener]of listeners)doc.addEventListener(name,listener,true);
 reduced.addEventListener('change',onMotion);
 observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['value','type','inputmode','disabled','readonly','required','min','max','step','placeholder','aria-invalid','lang','data-theme','data-reduced-motion']});
 const api={refresh(scope=doc){scan(scope);},dispose(){disposed=true;observer.disconnect();resize.disconnect();reduced.removeEventListener('change',onMotion);for(const [name,listener]of listeners)doc.removeEventListener(name,listener,true);if(frame)view.cancelAnimationFrame(frame);pending.clear();for(const input of [...states.keys()])remove(input);controllers.delete(doc);}};
 controllers.set(doc,api);scan(doc,false);doc.fonts?.ready.then(()=>{if(!disposed)scan(doc,false);});return api;
}
