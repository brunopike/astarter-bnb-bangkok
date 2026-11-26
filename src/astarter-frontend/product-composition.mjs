import {L} from './execution-views.mjs';
const paths={orbit:'<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-35 12 12)"/>',strategy:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M14 6h4v5M6 14v4h5"/>',pulse:'<path d="M2 12h4l3-7 5 14 3-7h5"/>',chart:'<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',sliders:'<path d="M5 3v18M12 3v18M19 3v18M2 8h6M9 16h6M16 9h6"/>',shield:'<path d="M12 2l8 3v6c0 5-5 9-8 11-3-2-8-6-8-11V5z"/><path d="M8 12l3 3 5-6"/>',credits:'<circle cx="12" cy="12" r="9"/><path d="M15 8h-4a2 2 0 000 4h2a2 2 0 010 4H9M12 5v3m0 8v3"/>'};
Object.assign(paths,{close:'<path d="m6 6 12 12M18 6 6 18"/>',search:'<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/>',chat:'<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/>',attach:'<path d="m8 12 6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l8-8m-4 9 7-7"/>',send:'<path d="m12 19 0-14M6 11l6-6 6 6"/>',plus:'<path d="M12 5v14M5 12h14"/>',file:'<path d="M6 3h8l4 4v14H6Z M14 3v5h4M9 12h6M9 16h6"/>',check:'<path d="m5 12 4 4L19 6"/>',history:'<path d="M3 5v5h5M3.5 10a9 9 0 1 1 1 8M12 7v5l3 2"/>'});
Object.assign(paths,{star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',chevron:'<path d="m9 6 6 6-6 6"/>',bookmark:'<path d="M6 3h12v18l-6-4-6 4Z"/>'});
Object.assign(paths,{expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',collapse:'<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>',play:'<path d="m8 4 12 8-12 8Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'});
Object.assign(paths,{compass:'<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6Z"/>',back:'<path d="M19 12H5m6-6-6 6 6 6"/>'});
Object.assign(paths,{more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'});
Object.assign(paths,{columns:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>'});
Object.assign(paths,{filter:'<path d="M3.5 5h17l-6.5 7.6v5.9l-4 2v-7.9Z"/>',layers:'<path d="m12 3 9 4.8-9 4.8-9-4.8Z"/><path d="m3 12.2 9 4.8 9-4.8"/><path d="m3 16.4 9 4.8 9-4.8"/>'});
export const uiGlyph=(key)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key]||paths.chart}</svg>`;
export function dataRefreshControls({scope,seconds,intervals,busy=false,disabled=false,label}){
 if(!['dc','hub','pd'].includes(scope))throw new Error('INVALID_DATA_REFRESH_SCOPE');
 const text=String(label??(busy?L('刷新中','Refreshing'):L('刷新','Refresh'))).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return `<div class="hub-refresh-group data-refresh-controls"><button type="button" class="dc-button" data-${scope}-refresh aria-busy="${busy}" ${disabled||busy?'disabled':''} aria-label="${L('手动刷新数据','Refresh data now')}">${uiGlyph('refresh')}<span data-${scope}-refresh-label>${text}</span></button><label class="hub-refresh-setting">${uiGlyph('clock')}<select data-${scope}-interval aria-label="${L('自动刷新间隔','Auto-refresh interval')}" title="${L('自动刷新间隔','Auto-refresh interval')}">${intervals.map(n=>`<option value="${n}" ${n===seconds?'selected':''}>${n} ${L('秒','s')}</option>`).join('')}</select></label></div>`;
}
export function bindCardEdges(root=document){
 const selector=':is(.insight-surface,.p-card,.sc-card,.capability-card,.ux-run-panel,.dc-panel,.hub-panel,.hub-stat,.hub-asset-card,.sig-event,.sig-detail-aside,.df-post,.df-related,.settings-board,.commerce-card,.commerce-section,.commerce-usage-main,.commerce-balance-panel,.commerce-plan-overview,.commerce-records-section,.tc-orders,.tc-balance-hero,.contract-run,.chat-app,.ux-profile-method,.ux-profile-settings):not(button,a,dialog,.bh-root *)',reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let frame=0,card=null,point=null;
 const clear=()=>{if(frame)cancelAnimationFrame(frame);frame=0;card?.removeAttribute('data-pointer');card=null;};
 const findCard=target=>{let next=target.closest?.(selector);while(next&&!(parseFloat(getComputedStyle(next).borderTopWidth)>0))next=next.parentElement?.closest(selector);return next;};
 // Reuse the chart edge on framed cards only; route replacements need no per-card listeners.
 root.addEventListener('pointermove',event=>{
  if(event.pointerType!=='mouse'||reduced.matches||root.documentElement.dataset.reducedMotion==='true'){clear();return;}
  const next=findCard(event.target);if(!next){clear();return;}
  if(card!==next){clear();card=next;}
  point=[event.clientX,event.clientY];if(frame)return;
  frame=requestAnimationFrame(()=>{frame=0;if(!card?.isConnected){clear();return;}const box=card.getBoundingClientRect(),x=point[0]-box.left,y=point[1]-box.top;if(x<0||y<0||x>box.width||y>box.height){clear();return;}card.style.setProperty('--surface-x',`${x}px`);card.style.setProperty('--surface-y',`${y}px`);card.setAttribute('data-card-edge','');card.setAttribute('data-pointer','');});
 },{passive:true});
 root.addEventListener('focusin',event=>findCard(event.target)?.setAttribute('data-card-edge',''));
 root.addEventListener('pointerleave',clear);
 root.addEventListener('scroll',clear,true);
 root.addEventListener('visibilitychange',clear);
 reduced.addEventListener('change',clear);
 const state=new MutationObserver(records=>{if(records.some(record=>record.oldValue!==record.target.getAttribute(record.attributeName)))clear();});
 state.observe(root.body,{attributes:true,attributeFilter:['data-page'],attributeOldValue:true});
 state.observe(root.documentElement,{attributes:true,attributeFilter:['data-reduced-motion'],attributeOldValue:true});
 window.addEventListener('pagehide',clear);
}
export function bindSelectValues(root=document){
 return import('./liquid-select-loader.mjs').then(({bindLiquidSelects})=>bindLiquidSelects(root)).catch(error=>console.warn('Liquid select unavailable; native controls remain usable',error));
}
export function hasUnsavedFields(root){
 return [...root.querySelectorAll('form input,form select,form textarea')].some(el=>{
  if(el.disabled||['hidden','submit','button','reset','file'].includes(el.type))return false;
  if(el.tagName==='SELECT'){
   const options=[...el.options],marked=options.some(o=>o.defaultSelected);
   return options.some((o,i)=>o.selected!==(o.defaultSelected||!marked&&!el.multiple&&i===0));
  }
  return ['checkbox','radio'].includes(el.type)?el.checked!==el.defaultChecked:el.value!==el.defaultValue;
 });
}
export function canAutoRefresh(root){
 // The closing portal outlives the open flag; keep its trigger until focus returns.
 if(document.querySelector('dialog[open]')||document.querySelector('.lq-select__positioner:not([hidden]) .lq-select__listbox'))return false;
 // Floating menus carry data-info-open; the desktop toolbar stays open inline.
 if(root.querySelector('button:active,a:active,summary:active,details[data-info-open],.account-navigation.is-open,details.layout-section-switch[open],[data-liquid-open],.layout-tab-glide.is-moving,[data-bh-recommendation-rail][data-interacting],:is(select:open),.chart-canvas.is-dragging,.trading-chart[data-interacting],[data-hub-plot][data-interacting],.trading-chart-hosted[data-chart-view=widget]'))return false;
 const active=document.activeElement;
 if(root.contains(active)&&active.matches('.lq-select__trigger,input,select,textarea,[contenteditable=true],.chart-canvas,.trading-chart-canvas,[data-hub-plot],.pd-post-media a')){
  const dataFilter=active.closest?.('.dc-root .liquid-native-host')?.querySelector('select[data-dc-route-select],select[data-pd-news-date],select[data-pd-news-publisher],select[data-pd-limit],select[data-pd-social-filter]');
  const closedSocialSelect=active.tagName==='SELECT'&&active.matches('select[data-pd-social-filter]');
  if(!closedSocialSelect&&(!active.matches('.lq-select__trigger')||!dataFilter))return false;
 }
 return !hasUnsavedFields(root);
}
export function bindSearchRender(input,setValue,render){
 let composing=false,scheduled=false;
 const update=()=>{
  setValue(input.value);
  if(composing||scheduled)return;
  scheduled=true;
  requestAnimationFrame(()=>{
   scheduled=false;
   if(!input.isConnected||composing)return;
   const focused=document.activeElement===input,start=input.selectionStart,end=input.selectionEnd,direction=input.selectionDirection;
   const next=render();
   if(focused&&next){next.focus({preventScroll:true});if(start!==null&&end!==null)next.setSelectionRange(start,end,direction);}
  });
 };
 input.addEventListener('compositionstart',()=>{composing=true;});
 input.addEventListener('compositionend',()=>{composing=false;update();});
 input.addEventListener('input',event=>{if(event.isComposing)composing=true;update();});
}
export function captureProductFocus(root){
 const doc=root.ownerDocument||globalThis.document,focused=doc?.activeElement;if(!focused||!root.contains?.(focused))return ()=>{};
 const native=focused.closest('.liquid-native-host')?.querySelector('select'),active=native||focused;
 const tag=active.tagName,formId=active.closest('form')?.id,tabIndex=native?null:active.getAttribute('tabindex');
 const attributes=[...active.attributes].filter(a=>['id','name','href','aria-label'].includes(a.name)||a.name.startsWith('data-')).map(a=>[a.name,a.value]);
 const text=active.textContent.trim();
 const identifies=el=>(!formId||el.closest('form')?.id===formId)&&attributes.every(([key,value])=>el.getAttribute(key)===value)&&(attributes.length||el.textContent.trim()===text);
 const prior=[...root.querySelectorAll(tag)].filter(identifies),ordinal=prior.indexOf(active);
 return ()=>{
  if(active.isConnected)return;
  if(doc.activeElement!==doc.body&&!root.contains(doc.activeElement))return;
  const matches=[...root.querySelectorAll(tag)].filter(identifies);
  const next=matches.length===1?matches[0]:matches.length===prior.length&&ordinal>=0?matches[ordinal]:null;
  if(next&&!next.disabled&&!next.closest('[hidden]')){
   if(tabIndex!==null)next.setAttribute('tabindex',tabIndex);
   next.focus({preventScroll:true});
   if(doc.activeElement===next)return;
  }
  const fallback=root.querySelector('h1,h2,[role="status"]');
  if(fallback&&!fallback.closest('[hidden]')){fallback.tabIndex=-1;fallback.focus({preventScroll:true});}
 };
}
export function composeProduct(root,page){
 if(page==='workbench')return;
 const sourceMode=root.querySelector('.pd-modebar'),dataHeading=root.querySelector('.dc-market-heading,.dc-head,.df-page-head,.pd-heading,.da-breadcrumb');
 if(sourceMode&&dataHeading&&sourceMode.querySelector('nav')){dataHeading.append(sourceMode);sourceMode.classList.add('in-heading');const stamp=dataHeading.querySelector(':scope > .dc-snapshot');if(stamp&&dataHeading.classList.contains('dc-market-heading'))sourceMode.append(stamp);}
 if(dataHeading?.classList.contains('da-breadcrumb')){const back=dataHeading.querySelector(':scope>a');if(back){back.setAttribute('aria-label',back.textContent.trim());back.title=back.textContent.trim();}}

 root.dataset.composition=({opportunities:'inbox',signals:'signals',execution:'activity',logs:'ledger',assets:'portfolio',markets:'terminal',tracking:'feed',intelligence:'news',strategies:'library','my-strategies':'workspace',usage:'wallet',settings:'settings',setup:'onboarding',risk:'rules'})[page]||'form';
 // Move existing nodes, preserving data, controls and their original event contracts.
 if(page==='opportunities'){
  const list=root.querySelector('.biz-op-list'),toolbar=root.querySelector('.biz-toolbar-tight');if(list&&toolbar)list.prepend(toolbar);
  const ledger=root.querySelector('.biz-signal-section');if(ledger){const details=document.createElement('details');details.className='product-secondary';const summary=document.createElement('summary');summary.textContent=L('查看策略生成的信号','View strategy signals');ledger.before(details);details.append(summary,ledger);}
 }
 if(page==='execution'){const run=root.querySelector('.contract-run'),attention=root.querySelector('.contract-attention');if(run&&attention)run.before(attention);}
 if(page==='assets'){
  const metrics=root.querySelector('.metric-row');if(metrics)metrics.classList.add('portfolio-balance');
 }
 if(page==='logs')root.querySelector('.execution-timeline')?.classList.add('product-timeline');
 // Native table overflow remains keyboard accessible on compact screens.
 for(const el of root.querySelectorAll('.p-table-scroll')){el.tabIndex=0;el.setAttribute('role','region');el.setAttribute('aria-label',L('数据表，可左右滚动','Data table, scroll horizontally'));}
}
