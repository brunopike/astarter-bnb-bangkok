import {measureDataFloor,measureSignalFloor} from './collection-motion.mjs';
import {DATA_PAGES} from './data-center-fixtures.mjs';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function companionMood(page,kind){
 if(kind==='analysis')return 'think';
 if(kind==='news')return 'browse';
 if(kind==='data')return 'confirm';
 if(['assets','logs','billing','usage','settings','risk'].includes(page))return 'audit';
 if(['strategies','my-strategies','advisor','execution','mandate'].includes(page))return 'think';
 return 'scan';
}

export function mountCompanionMotion(pocket){
 const doc=pocket.ownerDocument,win=doc.defaultView;
 const controller=new AbortController(),options={signal:controller.signal};
 const actionSelector='.ux-profile-cta,.sc-inline-drawer .sc-drawer-footer,.setup-actions,.chat-composer-area,body[data-page=workbench]>.connection-bar';
 const controlSelector='button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button]';
 // shortcut: axis selectors follow Lightweight Charts' current table; recheck them when upgrading the chart library.
 const axisSelector='.trading-chart-canvas .tv-lightweight-charts>table>tr:first-child>td:last-child canvas:first-of-type,.trading-chart-canvas .tv-lightweight-charts>table>tr:last-child>td:nth-child(2) canvas:first-of-type';
 const workbenchResultSelector='.pw-output-filter,.pw-result';
 const bodySelector=`#product-page :is(${controlSelector}),.trading-chart>.trading-chart-footer :is(a,button),${axisSelector},body[data-page=workbench] :is(${workbenchResultSelector})`;
 const calendarReading='#product-page .df-economic-calendar :is(h2,h3,.df-calendar-top>span,.df-calendar-top>small,.df-calendar-selection>span,.df-economic-event time,.df-economic-area,.df-economic-impact,dt,dd)';
 const readingSelector=`#product-page.account-context .account-content :is(h1,h2,h3,p,dt,dd,label,a,button,input,select,textarea,[role="button"]),.statements [data-st-curve] .st-date-axis time,.statements [data-st-curve] .st-curve-caption,.statements .st-calendar th,body[data-page=workbench] .pnl-details>summary,.statements .st-range>summary,#product-page .bh-recommendation-card:not([aria-hidden=true]) .bh-pick-plan :is(dt,dd),.trading-chart>.trading-chart-footer :is(.trading-chart-status>span,time),#product-page .sig-event .sig-stats-readout>:is(strong,small),#product-page .pd-social-text,${calendarReading}`;
 let frame=0,disposed=false,offsetX=0,offsetY=0,lastDataView='',embeddedDock='';
 const observed=new Set(),observer=new win.ResizeObserver(schedule);
 const insertedSelector=`${controlSelector},${axisSelector}`;
 const hasBodyTarget=node=>node.nodeType===1&&(node.matches(insertedSelector)||node.querySelector(insertedSelector));
 const hasWorkbenchResult=node=>node.nodeType===1&&(node.matches(workbenchResultSelector)||node.querySelector(workbenchResultSelector));
 const page=doc.querySelector('#product-page'),workbench=doc.querySelector('.network-stage'),structure=new win.MutationObserver(records=>{
  const current=doc.body.dataset?.page;
  if((current==='signals'||DATA_PAGES.includes(current))&&records.some(r=>r.target===doc.body&&r.attributeName==='class'&&r.oldValue?.split(/\s+/).includes('app-loading')&&!doc.body.classList.contains('app-loading'))){schedule();return;}
  if(records.some(r=>r.type==='childList'&&(workbench?.contains(r.target)?[...r.addedNodes,...r.removedNodes].some(hasWorkbenchResult):r.target===page||r.target.matches('[data-signal-stats]')||[...r.addedNodes,...r.removedNodes].some(hasBodyTarget))||r.type==='attributes'&&(
   r.attributeName==='aria-hidden'&&r.target.matches('.bh-recommendation-card')||
   r.attributeName==='data-interacting'&&r.target.matches('[data-bh-recommendation-rail]')
  )))schedule();
 });
 if(page)structure.observe(page,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-hidden','data-interacting']});
 if(workbench)structure.observe(workbench,{childList:true,subtree:true});
 if(doc.body.classList?.contains('app-loading'))structure.observe(doc.body,{attributes:true,attributeOldValue:true,attributeFilter:['class']});
 pocket.style.removeProperty('inset');
 pocket.style.removeProperty('transform');
 pocket.dataset.placement='corner';
 delete pocket.dataset.dragging;
 function schedule(){if(!disposed&&!frame)frame=win.requestAnimationFrame(()=>{frame=0;layout();});}
 function layout(){
  if(disposed)return;
  if(frame){win.cancelAnimationFrame(frame);frame=0;}
  const current=doc.body.dataset?.page,onSignals=current==='signals',mobile=win.innerWidth<=900;
  const onData=DATA_PAGES.includes(current),dataPhone=mobile&&onData;
  const dataView=onData?current+(win.location?.search||''):'';
  if((onSignals||dataPhone)&&doc.querySelector('dialog[open],.sig-controls details[open],.liquid-native-host [aria-expanded=true]'))return;
  const vv=win.visualViewport,left=vv?.offsetLeft||0,top=vv?.offsetTop||0,width=vv?.width||win.innerWidth,height=vv?.height||win.innerHeight;
  const headerElement=doc.querySelector('.topbar'),navElement=doc.querySelector('body > .biz-mobile-nav');
  // One pixel absorbs fractional rounding at browser zoom while preserving an 8px clearance.
  const gap=mobile?9:8;
  const header=headerElement?.getBoundingClientRect(),nav=navElement?.getBoundingClientRect();
  const minTop=Math.max(top+12,header?.height&&header.top<=top+2?header.bottom+12:top+12);
  const actionElements=[...doc.querySelectorAll(actionSelector)],bodyElements=[...doc.querySelectorAll(bodySelector)].filter(el=>!el.closest('[inert],[aria-hidden=true]')),readingElements=mobile?[...doc.querySelectorAll(readingSelector)]:[];
  const pageHeaders=mobile?[...doc.querySelectorAll('#product-page > .layout-navigation-row,#product-page > .account-navigation,#product-page > .layout-page-head:not(.layout-context-only)')]:[];
  const panels=[...pocket.querySelectorAll('.mascot-speech,.mascot-menu')];
  const boxes=new Map();
  function box(el){if(!boxes.has(el))boxes.set(el,el.getBoundingClientRect());return boxes.get(el);}
  function inView(r){return r.width>0&&r.height>0&&r.bottom>top&&r.top<top+height&&r.right>left&&r.left<left+width;}
  function visibleSection(el){
   if(!onData)return true;
   const section=el.closest('.hub-panel,.dc-panel,.dc-section,.df-economic-calendar,.pd-kol-post,.df-story');
   return !section||inView(box(section));
  }
  const visibleControls=bodyElements.filter(visibleSection),visibleReading=readingElements.filter(visibleSection);
  const targets=new Set([...actionElements,...visibleControls,...visibleReading,...pageHeaders,...panels,headerElement,navElement,onData?page:null].filter(Boolean));
  for(const el of observed)if(!targets.has(el)){observer.unobserve(el);observed.delete(el);}
  for(const el of targets)if(!observed.has(el)){observer.observe(el);observed.add(el);}
  const clips=new Map();
  function visibleRect(el,r=box(el)){
   if(!inView(r)||win.getComputedStyle(el).visibility==='hidden')return null;
   const closed=onSignals&&el.closest('details:not([open])');
   if(closed&&!closed.querySelector(':scope>summary')?.contains(el))return null;
   let x=Math.max(left,r.left),y=Math.max(top,r.top),right=Math.min(left+width,r.right),bottom=Math.min(top+height,r.bottom);
   for(let parent=el.parentElement;parent&&parent!==doc.body;parent=parent.parentElement){
    if(!clips.has(parent))clips.set(parent,win.getComputedStyle(parent));
    const style=clips.get(parent);
    if(/auto|scroll|hidden|clip/.test(style.overflowX)){const rect=box(parent);x=Math.max(x,rect.left);right=Math.min(right,rect.right);}
    if(/auto|scroll|hidden|clip/.test(style.overflowY)){const rect=box(parent);y=Math.max(y,rect.top);bottom=Math.min(bottom,rect.bottom);}
   }
   return right>x&&bottom>y?{left:x,top:y,right,bottom,width:right-x,height:bottom-y}:null;
  }
  const actions=actionElements.filter(el=>mobile||el.matches('.chat-composer-area')||['fixed','sticky'].includes(win.getComputedStyle(el).position)).map(el=>visibleRect(el)).filter(Boolean);
  const headerRects=pageHeaders.map(el=>visibleRect(el)).filter(Boolean);
  const bodyRects=visibleControls.map(el=>visibleRect(el)).filter(Boolean);
  const ink=onSignals&&page?measureSignalFloor(page,pocket)?.ink:dataPhone&&page?measureDataFloor(page,pocket)?.ink:undefined;
  const inkBoxes=new Set(ink);
  // A 48px touch target already includes 6px of padding around the white figure.
  const dataControls=dataPhone&&ink?.length?new Set(bodyRects):null;
  const clearance=r=>inkBoxes.has(r)?0:dataControls?.has(r)?2:gap;
  const body=pocket.getBoundingClientRect(),size=48,base={left:body.left-offsetX,top:body.top-offsetY};
  const intersects=(x,y,r)=>{const pad=clearance(r);return x<r.right+pad&&x+size>r.left-pad&&y<r.bottom+pad&&y+size>r.top-pad;};
  // Page controls protect the body without limiting the open panel's height.
  if(mobile||ink?.length||onData&&(offsetX||offsetY)||bodyRects.some(r=>intersects(base.left,base.top,r))){
   const anchor=body,maxX=left+width-12-size,maxY=Math.min(top+height-12,nav?.height&&nav.top>top?nav.top-gap:Infinity)-size;
   const readingRects=(!ink?.length?visibleReading:[]).flatMap(el=>{
    const bounds=visibleRect(el);if(!bounds)return [];
    if(!el.matches(`h1,h2,h3,p,dt,dd,label,.trading-chart-status>span,.trading-chart-footer>time,.sig-stats-readout>:is(strong,small),${calendarReading}`))return [bounds];
    const range=doc.createRange();range.selectNodeContents(el);
    const rects=[...range.getClientRects()];
    return rects.length?rects.map(r=>visibleRect(el,r)).filter(Boolean):[bounds];
   });
   const obstacles=ink?.length?[...actions,...headerRects,...bodyRects,...ink]:[...actions,...readingRects,...headerRects,...bodyRects];
   const safe=(x,y)=>x>=left+12&&x<=maxX&&y>=minTop&&y<=maxY&&!obstacles.some(r=>intersects(x,y,r));
   const edgeColumns=[base.left,left+12,maxX];
   const sameDock=onData&&lastDataView===dataView&&pocket.dataset.avoidance==='clear';
   const preferred=(onSignals||onData)&&!sameDock?base:anchor;
   let position=safe(preferred.left,preferred.top)?{x:preferred.left,y:preferred.top}:null;
   if(!position){
    const ys=[...new Set([base.top,minTop,maxY,...obstacles.flatMap(r=>[r.top-size-clearance(r),r.bottom+clearance(r)])])].filter(y=>y>=minTop&&y<=maxY);
    const columns=[edgeColumns];
    if(ink?.length)columns.push(ink.flatMap(r=>[r.left-size-clearance(r),r.right+clearance(r)]));
    for(const candidates of columns){
     let distance=Infinity;
     for(const x of new Set(candidates)){
      if(x<left+12||x>maxX)continue;
      for(const y of ys){
       const next=Math.abs(x-preferred.left)*2+Math.abs(y-preferred.top);
       if(next<distance&&safe(x,y)){position={x,y};distance=next;}
      }
     }
     if(position)break;
    }
   }
   // On a narrow embedded chart, leave a runner's width between the dock
   // and the last line of the source caption when the extra space fits.
   const embed=dataPhone&&width<=360&&page?.querySelector?.('.dc-root iframe');
   if(embed&&inView(box(embed))){
    if(position&&(embeddedDock!==dataView||!safe(anchor.left,anchor.top))&&safe(position.x,position.y-32))position.y-=32;
    embeddedDock=dataView;
   }else embeddedDock='';
   pocket.dataset.avoidance=position?'clear':'blocked';
   if(!position&&pocket.contains(doc.activeElement)){
    const controls=[...doc.querySelectorAll('#product-page .layout-actions-menu>summary,#product-page .chat-history-toggle,body>.biz-mobile-nav a[href],.topbar a[href]')];
    const available=el=>{
     const r=visibleRect(el);return r&&r.top>=top&&r.bottom<=top+height&&!el.closest('[inert]');
    };
    const target=controls.find(el=>el.matches('.layout-actions-menu>summary')&&available(el))||controls.find(available);
    target?.focus({preventScroll:true});
   }
   pocket.inert=!position;
   if(position)pocket.removeAttribute('aria-hidden');else pocket.setAttribute('aria-hidden','true');
   if(position){
    offsetX=position.x-base.left;offsetY=position.y-base.top;
    pocket.style.setProperty('--companion-offset-x',offsetX+'px');
    pocket.style.setProperty('--companion-offset-y',offsetY+'px');
   }
  }else{
   offsetX=offsetY=0;
   pocket.style.removeProperty('--companion-offset-x');pocket.style.removeProperty('--companion-offset-y');
   delete pocket.dataset.avoidance;
   pocket.inert=false;pocket.removeAttribute('aria-hidden');
  }
  lastDataView=dataView;
  const anchor=pocket.getBoundingClientRect();
  const bottom=Math.min(top+height-12,nav?.height&&nav.top>top?nav.top-gap:Infinity,...actions.map(r=>r.top-gap));
  const panelTop=Math.max(minTop,...headerRects.map(r=>r.bottom+gap));
  const above=Math.max(0,Math.min(anchor.top-12,bottom)-panelTop),below=mobile?Math.max(0,bottom-anchor.bottom-12):0;
  const maxWidth=Math.max(0,width-32);
  for(const panel of panels){
   if(panel.hidden)continue;
   const room=Math.min(440,Math.max(above,below));
   panel.style.maxWidth=maxWidth+'px';
   panel.style.maxHeight=room+'px';
   const usedWidth=Math.min(panel.offsetWidth,maxWidth),usedHeight=Math.min(panel.offsetHeight,room);
   const x=clamp(anchor.right-usedWidth,left+16,left+width-usedWidth-16);
   const y=above>=usedHeight||above>=below?Math.min(anchor.top-12,bottom)-usedHeight:anchor.bottom+12;
   panel.style.setProperty('inset',`${y-anchor.top}px auto auto ${x-anchor.left}px`,'important');
  }
 }
 win.addEventListener('resize',schedule,options);
 win.visualViewport?.addEventListener('resize',schedule,options);
 win.visualViewport?.addEventListener('scroll',schedule,options);
 doc.addEventListener('scroll',schedule,{...options,capture:true,passive:true});
 doc.addEventListener('toggle',schedule,{...options,capture:true});
 doc.addEventListener('close',()=>{const current=doc.body.dataset?.page;if(current==='signals'||DATA_PAGES.includes(current))schedule();},{...options,capture:true});
 layout();
 return {layout,requestLayout:schedule,dispose(){disposed=true;controller.abort();observer.disconnect();structure.disconnect();observed.clear();if(frame)win.cancelAnimationFrame(frame);}};
}
