import test from 'node:test';
import assert from 'node:assert/strict';
import {companionMood,mountCompanionMotion} from './page-companion.mjs';

const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
const element=(box,extra={})=>({box,nodeType:1,parentElement:null,style:{visibility:'visible',overflowX:'visible',overflowY:'visible',position:'static'},getBoundingClientRect(){return this.box;},matches:()=>false,closest:()=>null,querySelector:()=>null,...extra});
const overlaps=(a,b,gap=8)=>a.left<b.right+gap&&a.right>b.left-gap&&a.top<b.bottom+gap&&a.bottom>b.top-gap;
function fixture({width=320,height=779,bodyTop=null,actions=[],strategyActions=[],recommendationActions=[],recommendationReading=[],chartFooterActions=[],chartFooterReading=[],signalReading=[],socialReading=[],economicReading=[],categoryActions=[],pageControls=[],chartAxes=[],account=[],reading=[],connectionBars=[],calendarRead=[],pnlControls=[],rangeControls=[],pageHeaders=[],panels=[],workbenchResults=[],workbenchRoot=null,currentPage='workbench',navTop=height-60}={}){
 const frames=new Map();let frameId=0,resize,structure;
 const view=Object.assign(new EventTarget(),{width,height,offsetLeft:0,offsetTop:0});
 const win=Object.assign(new EventTarget(),{innerWidth:width,innerHeight:height,visualViewport:view,getComputedStyle:el=>el.style,
  requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);},
  ResizeObserver:class{targets=new Set();constructor(fn){this.callback=fn;resize=this;}observe(el){this.targets.add(el);}unobserve(el){this.targets.delete(el);}disconnect(){this.targets.clear();}},
  MutationObserver:class{targets=new Map();constructor(fn){this.callback=(records=[{type:'childList',target:page}])=>fn(records.map(r=>({addedNodes:[],removedNodes:[],...r})));structure=this;}observe(el,options){this.targets.set(el,options);this.target??=el;this.options??=options;}disconnect(){this.targets.clear();this.target=null;}}
 });
 const header=element(rect(0,0,width,52)),nav=navTop===null?null:element(rect(8,navTop,width-16,52));
 const page={},focusTarget=element(rect(260,74,44,44),{closest:()=>null,focus(){doc.activeElement=this;}});
 const doc=Object.assign(new EventTarget(),{defaultView:win,body:{},querySelector:s=>s==='.topbar'?header:s==='body > .biz-mobile-nav'?nav:s==='#product-page'?page:s==='.network-stage'?workbenchRoot:null,querySelectorAll:s=>s.startsWith('#product-page :is(button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button]),.trading-chart>.trading-chart-footer :is(a,button)')?[...(currentPage==='workbench'&&s.includes('body[data-page=workbench] :is(.pw-output-filter,.pw-result)')?workbenchResults:[]),...strategyActions,...recommendationActions.filter(el=>!el.card?.ariaHidden),...chartFooterActions,...categoryActions,...pageControls,...(s.includes('.trading-chart-canvas .tv-lightweight-charts>table>tr:first-child>td:last-child canvas:first-of-type')&&s.includes('.trading-chart-canvas .tv-lightweight-charts>table>tr:last-child>td:nth-child(2) canvas:first-of-type')?chartAxes:[])]:s.startsWith('#product-page .layout-actions-menu')?[focusTarget]:s.startsWith('#product-page .bh-strategy-card .bh-card-actions > button[data-bh="choose"]')?[...strategyActions,...(s.includes('#product-page .bh-recommendation-card:not([aria-hidden=true])>footer button:is([data-bh="recommendation-logic"],[data-bh="recommendation"])')?recommendationActions.filter(el=>!el.card?.ariaHidden):[]),...(s.includes('.trading-chart>.trading-chart-footer :is(a,button)')?chartFooterActions:[]),...(s.includes('#product-page .bh-category-tabs>button[data-bh="category"]')?categoryActions:[])]:s.startsWith('#product-page >')?pageHeaders:s.startsWith('#product-page.account-context')?[...account,...(s.includes('.st-date-axis time')?reading:[]),...(s.includes('.st-calendar th')?calendarRead:[]),...(s.includes('.pnl-details>summary')?pnlControls:[]),...(s.includes('.st-range>summary')?rangeControls:[]),...(s.includes('#product-page .bh-recommendation-card:not([aria-hidden=true]) .bh-pick-plan :is(dt,dd)')?recommendationReading.filter(el=>!el.card?.ariaHidden):[]),...(s.includes('.trading-chart>.trading-chart-footer :is(.trading-chart-status>span,time)')?chartFooterReading:[]),...(s.includes('#product-page .sig-event .sig-stats-readout>:is(strong,small)')?signalReading:[]),...(s.includes('#product-page .pd-social-text')?socialReading:[]),...(s.includes('#product-page .df-economic-calendar :is(h2,h3,')&&s.includes('.df-calendar-selection>span')?economicReading:[])]:s.startsWith('.ux-profile-cta,')?[...actions,...(s.includes('body[data-page=workbench]>.connection-bar')?connectionBars:[])]:[],createRange(){let target;return {selectNodeContents(el){target=el;},getClientRects(){return target.textRects||[target.box];}};}});
 const trigger=new EventTarget(),pocket=new EventTarget();
 const style={setProperty(k,v){this[k]=v;},removeProperty(k){delete this[k];}};
 Object.assign(pocket,{ownerDocument:doc,dataset:{},style,attributes:{},matches:()=>false,setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},contains:el=>el===trigger||panels.includes(el),querySelector:()=>trigger,querySelectorAll:()=>panels,getBoundingClientRect(){const mobile=win.innerWidth<=900;return rect(win.innerWidth-(mobile?(win.innerWidth<=380?12:16):24)-48+parseFloat(style['--companion-offset-x']||0),(bodyTop??win.innerHeight-(mobile?72:24)-48)+parseFloat(style['--companion-offset-y']||0)+parseFloat(style['--companion-panel-shift-y']||0),48,48);}});
 const api=mountCompanionMotion(pocket),send=(target,type,props={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,props);target.dispatchEvent(event);return event;};
 const flush=()=>{let turns=0;while(frames.size){assert.ok(++turns<5,'layout must settle without a frame loop');const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());}};
 return {api,pocket,trigger,view,win,doc,nav,header,page,send,flush,resize,structure,frames,actions,strategyActions,recommendationActions,recommendationReading,account,reading,connectionBars,pageHeaders,focusTarget};
}
function assertSafe(f,obstacles){
 const r=f.pocket.getBoundingClientRect();assert.equal(f.pocket.dataset.avoidance,'clear');assert.equal(r.width,48);assert.equal(r.height,48);
 assert.ok(r.left>=f.view.offsetLeft+12&&r.right<=f.view.offsetLeft+f.view.width-12);
 assert.ok(r.top>=f.view.offsetTop+12&&r.bottom<=f.view.offsetTop+f.view.height-12);
 if(f.nav)assert.ok(r.bottom<=f.nav.box.top-8);
 for(const obstacle of obstacles)assert.equal(overlaps(r,obstacle.box),false,'whole hit area must clear protected content');
}
const panel=()=>element(rect(0,0,288,440),{hidden:false,offsetWidth:288,offsetHeight:440,style:{setProperty(k,v){this[k]=v;}}});

test('mobile body clears account values and keeps its safe position after scrolling away',()=>{
 const status=element(rect(242,650,42,24)),f=fixture({account:[status]});
 assertSafe(f,[status]);const before=f.pocket.getBoundingClientRect();assert.ok(before.top<650-48);
 status.box=rect(242,400,42,24);f.send(f.doc,'scroll');f.flush();assert.deepEqual(f.pocket.getBoundingClientRect(),before);
 status.box=rect(242,before.top+12,42,24);f.send(f.doc,'scroll');f.flush();assertSafe(f,[status]);f.api.dispose();
});

test('narrow Data Center charts cannot isolate the dock inside the painted graph',()=>{
 for(const channel of ['markets','tracking','derivatives','etf']){
  const f=fixture({width:320,height:660,navTop:600});
  const original=f.pocket.getBoundingClientRect();
  const plot=element(rect(215,505,101,85),{tagName:'CANVAS',childNodes:[],matches:s=>s.split(',').includes('canvas')});
  const area=element(rect(0,52,320,548),{tagName:'DIV',dataset:{dataCenter:channel},childNodes:[plot],hasAttribute:k=>k==='data-public-data',querySelectorAll:()=>[]});
  Object.assign(f.page,element(rect(0,52,320,548)),{tagName:'DIV',childNodes:[area],ownerDocument:f.doc,querySelector:s=>s==='.dc-root'?area:null});
  area.parentElement=f.page;plot.parentElement=area;f.doc.body.dataset={page:channel};
  assert.ok(overlaps(original,plot.box,0),'reproduce the original dock over the chart');
  f.api.layout();const available=f.pocket.getBoundingClientRect();
  assert.equal(f.pocket.inert,false);assert.equal(available.width,48);assert.equal(overlaps(available,plot.box,0),false);
  f.api.layout();assert.deepEqual(f.pocket.getBoundingClientRect(),available,'a safe position stays still on the next paint');
  f.api.dispose();
 }
});

test('a 320px calendar fits the entire companion between painted data and an original-source link',()=>{
 const link=element(rect(226,477,61,44),{tagName:'A',childNodes:[],matches:s=>s.split(',').includes('a[href]')});
 const chart=box=>element(box,{tagName:'CANVAS',childNodes:[],matches:s=>s.split(',').includes('canvas')});
 const top=chart(rect(0,52,320,375)),bottom=chart(rect(0,521,320,79)),f=fixture({width:320,height:660,navTop:600,pageControls:[link]});
 const area=element(rect(0,52,320,548),{tagName:'DIV',dataset:{publicData:'intelligence'},childNodes:[top,link,bottom],hasAttribute:k=>k==='data-public-data',querySelectorAll:()=>[]});
 Object.assign(f.page,element(rect(0,52,320,548)),{tagName:'DIV',childNodes:[area],ownerDocument:f.doc,querySelector:s=>s==='.dc-root'?area:null});
 for(const el of area.childNodes)el.parentElement=area;
 area.parentElement=f.page;f.doc.body.dataset={page:'intelligence'};f.api.layout();
 const dock=f.pocket.getBoundingClientRect();assert.equal(dock.width,48);assert.equal(dock.height,48);
 assert.equal(dock.left,260);assert.equal(link.box.top-dock.bottom,2);assert.equal(overlaps(dock,top.box,0),false);assert.equal(f.pocket.inert,false);
 f.api.dispose();
});

test('the full composer and fixed actions remain clear when input height or viewport changes',()=>{
 for(const width of [320,390,900]){
  const composer=element(rect(12,570,width-24,140),{matches:()=>true}),footer=element(rect(12,520,width-24,44));
  const f=fixture({width,actions:[composer,footer]});assertSafe(f,[composer,footer]);
  composer.box=rect(12,410,width-24,300);f.resize.callback();f.flush();assertSafe(f,[composer,footer]);
  f.view.height=340;f.send(f.view,'resize');f.flush();assertSafe(f,[]);assert.ok(f.pocket.getBoundingClientRect().bottom<=328);
  f.api.dispose();
 }
});

test('only visible fragments of scrolled account content block placement',()=>{
 const scroller=element(rect(0,52,320,520),{style:{overflowY:'auto',overflowX:'hidden'}});
 const clipped=element(rect(240,650,44,24),{parentElement:scroller}),f=fixture({account:[clipped]});
 assert.equal(f.pocket.getBoundingClientRect().top,659);assert.equal(f.pocket.dataset.avoidance,'clear');f.api.dispose();
});

test('blocked side lanes do not force the companion into the middle of the page',()=>{
 const account=[element(rect(0,52,90,700)),element(rect(230,52,90,700))],f=fixture({account});
 assert.equal(f.pocket.dataset.avoidance,'blocked');assert.equal(f.pocket.inert,true);f.api.dispose();
});

test('account text protects its visible lines rather than empty full-width heading space',()=>{
 const heading=element(rect(36,650,248,24),{matches:()=>true,textRects:[rect(36,650,80,24)]}),f=fixture({account:[heading]});
 assert.equal(f.pocket.getBoundingClientRect().top,659);assert.equal(f.pocket.dataset.avoidance,'clear');f.api.dispose();
});

test('the mobile companion clears visible social post lines as the reader scrolls',()=>{
 const lines=[rect(16,650,285,24),rect(16,678,285,24)];
 const post=element(rect(16,600,288,125),{matches:()=>true,textRects:lines});
 const f=fixture({socialReading:[post]});
 assertSafe(f,lines.map(box=>({box})));
 const top=f.pocket.getBoundingClientRect().top;
 post.box=rect(16,top-12,288,80);post.textRects=[rect(16,top,285,24)];
 f.send(f.doc,'scroll');f.flush();assertSafe(f,post.textRects.map(box=>({box})));
 f.api.dispose();
});

test('news calendar titles and counts protect their visible text while leaving unused space available',()=>{
 for(const width of [320,390]){
  const heading=element(rect(32,646,width-48,68),{
   matches:selector=>selector.split(',').includes('h3'),textRects:[rect(32,659,90,21)]
  });
  const count=element(rect(16,642,width-32,22),{
   matches:selector=>selector.includes('.df-calendar-selection>span'),textRects:[rect(16,642,44,17)]
  });
  const f=fixture({width,economicReading:[heading,count]});
  assert.ok(f.resize.targets.has(heading)&&f.resize.targets.has(count));assert.equal(f.pocket.getBoundingClientRect().top,659);
  heading.textRects=[rect(32,646,120,21),rect(32,671,width-52,21)];f.send(f.doc,'scroll');f.flush();
  assertSafe(f,[...heading.textRects,...count.textRects].map(box=>({box})));
  const corner=f.pocket.getBoundingClientRect();
  count.box=rect(16,corner.top,width-32,24);count.textRects=[rect(width-68,corner.top,52,17)];
  f.send(f.doc,'scroll');f.flush();assertSafe(f,[...heading.textRects,...count.textRects].map(box=>({box})));f.api.dispose();
 }
});

test('no-space state is reported without clamping the body into a protected editor',()=>{
 const f=fixture({height:210,navTop:150,actions:[element(rect(0,52,320,100))]});
 assert.equal(f.pocket.dataset.avoidance,'blocked');assert.equal(f.pocket.style['--companion-offset-y'],undefined);
 assert.equal(f.pocket.style.inset,undefined);f.api.dispose();
});

test('a short screen cannot claim success by covering the page action header',()=>{
 const f=fixture({height:340,pageHeaders:[element(rect(16,68,288,56))],actions:[element(rect(16,144,288,204))]});
 assert.equal(f.pocket.dataset.avoidance,'blocked');assert.equal(f.pocket.style['--companion-offset-y'],undefined);f.api.dispose();
});

test('blocked companion and open panels leave the focus order, then recover without changing the open state',()=>{
 const p=panel(),f=fixture({panels:[p]});f.doc.activeElement=p;
 f.win.innerHeight=f.view.height=340;f.nav.box=rect(8,280,304,52);
 f.actions.push(element(rect(16,144,288,204)));f.pageHeaders.push(element(rect(16,68,288,56)));
 f.structure.callback();f.flush();assert.equal(f.pocket.dataset.avoidance,'blocked');assert.equal(f.pocket.inert,true);assert.equal(f.pocket.attributes['aria-hidden'],'true');assert.equal(f.doc.activeElement,f.focusTarget);assert.equal(p.hidden,false);
 f.win.innerHeight=f.view.height=779;f.nav.box=rect(8,719,304,52);f.actions[0].box=rect(16,500,288,204);f.send(f.win,'resize');f.flush();
 assertSafe(f,f.actions);assert.equal(f.pocket.inert,false);assert.equal(f.pocket.attributes['aria-hidden'],undefined);assert.equal(p.hidden,false);assert.equal(f.doc.activeElement,f.focusTarget);f.api.dispose();
});

test('panels use the updated body and fit above or below it while clearing the composer',()=>{
 for(const height of [779,340]){
  const composer=element(rect(0,height-200,320,140),{matches:()=>true}),p=panel(),f=fixture({height,actions:[composer],panels:[p]});
  const anchor=f.pocket.getBoundingClientRect(),[dy,,,dx]=p.style.inset.split(' ').map(parseFloat);
  const r=rect(anchor.left+dx,anchor.top+dy,Math.min(p.offsetWidth,parseFloat(p.style.maxWidth)),Math.min(p.offsetHeight,parseFloat(p.style.maxHeight)));
  assert.ok(r.top>=64);assert.ok(r.bottom<=composer.box.top-8);assert.ok(r.left>=16&&r.right<=304);f.api.dispose();
 }
 const p=panel(),f=fixture({panels:[p],account:[element(rect(0,132,320,590))]});
 const anchor=f.pocket.getBoundingClientRect();assert.equal(f.pocket.dataset.avoidance,'clear');assert.ok(parseFloat(p.style.inset)>=anchor.height+12,'upper anchor opens downward');f.api.dispose();
});

test('open panels also clear the page navigation row',()=>{
 const p=panel(),f=fixture({panels:[p],pageHeaders:[element(rect(16,68,288,56))],actions:[element(rect(16,442,288,204))]});
 const top=f.pocket.getBoundingClientRect().top+parseFloat(p.style.inset);
 assert.ok(top>=132);assert.ok(top+parseFloat(p.style.maxHeight)<=434);f.api.dispose();
});

test('desktop layout is unchanged and returning to mobile recalculates protection',()=>{
 const status=element(rect(242,650,42,24)),f=fixture({account:[status]});assertSafe(f,[status]);
 f.win.innerWidth=f.view.width=1280;f.nav.box=rect(0,0,0,0);f.send(f.win,'resize');f.flush();
 assert.equal(f.pocket.style['--companion-offset-x'],undefined);assert.equal(f.pocket.style['--companion-offset-y'],undefined);assert.equal(f.pocket.dataset.avoidance,undefined);
 assert.deepEqual(f.pocket.getBoundingClientRect(),rect(1208,707,48,48));
 f.win.innerWidth=f.view.width=320;f.nav.box=rect(8,719,304,52);f.send(f.win,'resize');f.flush();assertSafe(f,[status]);f.api.dispose();
});

test('layout events coalesce and observers, frames and all listeners stop on disposal',()=>{
 const p=panel(),first=element(rect(242,650,42,24)),f=fixture({account:[first],panels:[p]});
 assert.ok(f.resize.targets.has(first));f.account.splice(0,1);f.api.layout();assert.equal(f.resize.targets.has(first),false);
 for(const type of ['scroll','toggle'])f.send(f.doc,type);f.send(f.win,'resize');f.send(f.view,'scroll');f.resize.callback();assert.equal(f.frames.size,1);
 f.api.dispose();assert.equal(f.frames.size,0);assert.equal(f.resize.targets.size,0);assert.equal(f.structure.target,null);const before={...f.pocket.style};
 f.send(f.doc,'scroll');f.send(f.doc,'toggle');f.send(f.win,'resize');f.send(f.view,'resize');f.send(f.view,'scroll');f.resize.callback();f.api.layout();
 assert.equal(f.frames.size,0);assert.deepEqual(f.pocket.style,before);
});

test('opening and closing panels does not move a safe body or re-enable dragging',()=>{
 const p=panel();p.hidden=true;const f=fixture({account:[element(rect(242,650,42,24))],panels:[p]});
 const before=f.pocket.getBoundingClientRect();p.hidden=false;f.api.layout();assert.ok(p.style.inset);p.hidden=true;f.api.layout();assert.deepEqual(f.pocket.getBoundingClientRect(),before);
 f.send(f.trigger,'pointerdown',{clientX:270,clientY:600});f.send(f.trigger,'pointermove',{clientX:100,clientY:300});f.send(f.trigger,'pointerup');f.send(f.trigger,'keydown',{key:'ArrowLeft'});
 assert.deepEqual(f.pocket.getBoundingClientRect(),before);assert.equal(f.pocket.dataset.placement,'corner');assert.equal(f.pocket.dataset.dragging,undefined);f.api.dispose();
});

test('expressions reflect visible information and page context',()=>{
 assert.equal(companionMood('markets','news'),'browse');assert.equal(companionMood('markets','analysis'),'think');assert.equal(companionMood('markets','data'),'confirm');assert.equal(companionMood('workbench'),'scan');assert.equal(companionMood('settings'),'audit');
});


test('strategy primary actions are collected and the whole body clears them on either side of the breakpoint',()=>{
 for(const width of [320,390,900,901,1084]){
  const cta=element(rect(width-100,689,76,44)),f=fixture({width,strategyActions:[cta],navTop:width<=900?719:null});
  assert.ok(f.resize.targets.has(cta),'the precise strategy CTA selector must be collected');
  assertSafe(f,[cta]);
  cta.box=rect(width-100,f.pocket.getBoundingClientRect().top+8,76,44);f.resize.callback();f.flush();
  if(width<=900)assertSafe(f,[cta]);
  else{assert.deepEqual(f.pocket.getBoundingClientRect(),rect(width-72,707,48,48));assert.equal(overlaps(f.pocket.getBoundingClientRect(),cta.box),false);}
  f.api.dispose();
 }
});

test('desktop only leaves its fixed corner for a colliding strategy CTA and returns when it clears',()=>{
 const cta=element(rect(980,200,80,44)),f=fixture({width:1084,height:610,strategyActions:[cta],navTop:null});
 const corner=rect(1012,538,48,48);assert.deepEqual(f.pocket.getBoundingClientRect(),corner);assert.equal(f.pocket.dataset.avoidance,undefined);
 cta.box=rect(980,550,80,44);f.send(f.doc,'scroll');f.flush();assertSafe(f,[cta]);
 const safe=f.pocket.getBoundingClientRect();f.send(f.doc,'scroll');f.flush();assert.deepEqual(f.pocket.getBoundingClientRect(),safe);
 f.send(f.trigger,'pointerdown',{clientX:1020,clientY:500});f.send(f.trigger,'pointermove',{clientX:400,clientY:300});f.send(f.trigger,'pointerup');assert.deepEqual(f.pocket.getBoundingClientRect(),safe);assert.equal(f.pocket.dataset.placement,'corner');
 cta.box=rect(980,200,80,44);f.send(f.doc,'scroll');f.flush();assert.deepEqual(f.pocket.getBoundingClientRect(),corner);assert.equal(f.pocket.dataset.avoidance,undefined);assert.equal(f.pocket.style['--companion-offset-y'],undefined);
 f.api.dispose();
});

test('ordinary-flow strategy actions do not become a ceiling for companion panels',()=>{
 const p=panel(),high=element(rect(980,100,80,44)),low=element(rect(980,550,80,44)),f=fixture({width:1084,height:610,strategyActions:[high,low],panels:[p],navTop:null});
 assertSafe(f,[high,low]);assert.ok(parseFloat(p.style.maxHeight)>300,'a top-of-page CTA must not collapse the panel');
 const anchor=f.pocket.getBoundingClientRect(),top=anchor.top+parseFloat(p.style.inset);assert.ok(top>=64);assert.ok(top+parseFloat(p.style.maxHeight)<=anchor.top-12);
 f.strategyActions.length=0;f.structure.callback();f.flush();assert.equal(f.resize.targets.has(high),false);assert.equal(f.resize.targets.has(low),false);assert.deepEqual(f.pocket.getBoundingClientRect(),rect(1012,538,48,48));f.api.dispose();
});

test('clipped strategy actions do not displace the corner, and a no-space case recovers without focus stealing',()=>{
 const clip=element(rect(0,52,1084,400),{style:{overflowY:'auto',overflowX:'hidden'}}),cta=element(rect(980,550,80,44),{parentElement:clip});
 const f=fixture({width:1084,height:610,strategyActions:[cta],navTop:null});assert.deepEqual(f.pocket.getBoundingClientRect(),rect(1012,538,48,48));f.api.dispose();
 const left=element(rect(0,64,90,44)),right=element(rect(791,64,110,44)),g=fixture({width:901,height:610,strategyActions:[left,right],navTop:null});g.doc.activeElement=g.trigger;
 g.win.innerHeight=g.view.height=140;g.send(g.win,'resize');g.flush();assert.equal(g.pocket.dataset.avoidance,'blocked');assert.equal(g.pocket.inert,true);assert.equal(g.pocket.attributes['aria-hidden'],'true');assert.equal(g.doc.activeElement,g.focusTarget);
 g.win.innerHeight=g.view.height=610;g.send(g.win,'resize');g.flush();assert.equal(g.pocket.dataset.avoidance,undefined);assert.equal(g.pocket.inert,false);assert.equal(g.pocket.attributes['aria-hidden'],undefined);assert.equal(g.doc.activeElement,g.focusTarget);g.api.dispose();
});


test('the visible workbench connection bar is collected as a mobile obstacle without moving desktop',()=>{
 const bar=element(rect(0,630,320,44),{style:{position:'relative',visibility:'visible',overflowX:'visible',overflowY:'visible'}}),f=fixture({height:740,connectionBars:[bar]});
 assert.ok(f.resize.targets.has(bar),'collect the connection bar through its actual selector');assertSafe(f,[bar]);f.api.dispose();
 const desktop=fixture({width:1084,height:610,navTop:null,connectionBars:[bar]});assert.equal(desktop.pocket.dataset.avoidance,undefined);assert.deepEqual(desktop.pocket.getBoundingClientRect(),rect(1012,538,48,48));desktop.api.dispose();
});

test('the 430px Spectrum result filters clear the companion above the connection strip',()=>{
 const filters=[rect(12,745,131,46),rect(149,745,132,46),rect(287,745,131,46)].map(box=>element(box)),bar=element(rect(0,822,430,44));
 const f=fixture({width:430,height:932,navTop:872,connectionBars:[bar],workbenchResults:filters});
 assertSafe(f,[...filters,bar]);f.api.dispose();
});

test('async Spectrum results trigger precise avoidance and stop observing removed controls',()=>{
 const rows=[],runs=element(rect(12,700,406,100)),host=element(rect(12,443,406,352),{contains:node=>node===runs}),bar=element(rect(0,822,430,44));
 const f=fixture({width:430,height:932,navTop:872,connectionBars:[bar],workbenchResults:rows,workbenchRoot:host});
 assert.equal(f.structure.targets.has(host),true,'observe the stable stage through optical-root replacements');
 const initial=f.pocket.getBoundingClientRect(),row=element(rect(287,745,131,46),{matches:s=>s.split(',').includes('.pw-result')});
 assert.equal(overlaps(initial,row.box),true,'reproduce the result area collision before its async mount');
 rows.push(row);f.structure.callback([{type:'childList',target:runs,addedNodes:[row]}]);
 assert.equal(f.frames.size,1,'async result controls must schedule a layout');f.flush();assertSafe(f,[row,bar]);
 row.box=rect(287,f.pocket.getBoundingClientRect().top+8,131,46);f.resize.callback();f.flush();assertSafe(f,[row,bar]);
 f.structure.callback([{type:'childList',target:runs,addedNodes:[{nodeType:3},element(rect(0,0,10,10))]}]);assert.equal(f.frames.size,0,'text and SVG-only changes do not schedule layout');
 rows.length=0;f.structure.callback([{type:'childList',target:runs,removedNodes:[row]}]);f.flush();assert.equal(f.resize.targets.has(row),false);
 f.api.dispose();assert.equal(f.structure.targets.size,0);f.structure.callback([{type:'childList',target:runs,addedNodes:[row]}]);assert.equal(f.frames.size,0);
});

test('Spectrum result protection keeps clear desktop corners and ignores clipped or other-page results',()=>{
 const row=element(rect(980,200,80,44)),desktop=fixture({width:1084,height:610,navTop:null,workbenchResults:[row]});
 assert.deepEqual(desktop.pocket.getBoundingClientRect(),rect(1012,538,48,48));row.box=rect(980,550,80,44);desktop.send(desktop.doc,'scroll');desktop.flush();assertSafe(desktop,[row]);desktop.api.dispose();
 const clip=element(rect(0,52,430,500),{style:{overflowY:'auto',overflowX:'hidden'}}),clipped=element(rect(287,800,131,46),{parentElement:clip});
 const f=fixture({width:430,height:932,navTop:872,workbenchResults:[clipped]});assert.deepEqual(f.pocket.getBoundingClientRect(),rect(366,812,48,48));f.api.dispose();
 const other=fixture({width:430,height:932,navTop:872,currentPage:'signals',workbenchResults:[element(rect(287,800,131,46))]});assert.deepEqual(other.pocket.getBoundingClientRect(),rect(366,812,48,48));other.api.dispose();
});

test('statement date labels and caption protect reading ink, including clipped scroll fragments',()=>{
 for(const width of [320,430]){
  const date=element(rect(width-80,670,42,16)),caption=element(rect(16,692,width-32,28),{matches:()=>true,textRects:[rect(width-110,692,94,16)]}),f=fixture({width,reading:[date,caption]});
  assert.ok(f.resize.targets.has(date)&&f.resize.targets.has(caption),'collect the precise statement reading selectors');assertSafe(f,[date,{box:caption.textRects[0]}]);
  date.box=rect(width-80,f.pocket.getBoundingClientRect().top+8,42,16);f.send(f.doc,'scroll');f.flush();assertSafe(f,[date,{box:caption.textRects[0]}]);f.api.dispose();
 }
 const clip=element(rect(0,52,320,450),{style:{overflowY:'auto',overflowX:'hidden'}}),outside=element(rect(260,670,42,16),{parentElement:clip}),f=fixture({reading:[outside]});assert.equal(f.pocket.getBoundingClientRect().top,659);f.api.dispose();
});


test('calendar weekday labels are real reading obstacles rather than spare corner space',()=>{
 const weekday=element(rect(260,674,14,16)),f=fixture({calendarRead:[weekday]});assert.ok(f.resize.targets.has(weekday),'collect the exact calendar heading selector');assertSafe(f,[weekday]);f.api.dispose();
});

test('moving above the connection bar also clears the capital disclosure and adjacent amount ink',()=>{
 const bar=element(rect(0,630,320,44)),summary=element(rect(26,583,268,44)),amount=rect(168,540,75,30),f=fixture({height:740,connectionBars:[bar],pnlControls:[summary]});
 assert.ok(f.resize.targets.has(summary),'collect the exact workbench disclosure selector');assertSafe(f,[bar,summary]);assert.equal(overlaps(f.pocket.getBoundingClientRect(),amount),false);f.api.dispose();
});


test('date range disclosure cannot become an apparently empty fallback corner',()=>{
 const range=element(rect(16,52,288,44)),f=fixture({height:210,navTop:150,rangeControls:[range]});assert.ok(f.resize.targets.has(range),'collect the real date range disclosure');assert.equal(f.pocket.dataset.avoidance,'blocked');assert.equal(f.pocket.inert,true);f.api.dispose();
});

test('mobile recommendation parameters protect the visible ink without reserving blank card space',()=>{
 for(const width of [320,430]){
  const label=element(rect(50,748,width-90,20),{matches:()=>true,textRects:[rect(50,748,56,20)]});
  const value=element(rect(width-130,748,92,20),{matches:()=>true,textRects:[rect(width-71,748,28,20)]});
  const f=fixture({width,height:844,recommendationReading:[label,value]});
  assert.ok(f.resize.targets.has(label)&&f.resize.targets.has(value),'collect actual exposed recommendation dt/dd');
  assertSafe(f,[...label.textRects,...value.textRects].map(box=>({box})));f.api.dispose();
  const blank=fixture({width,height:844,recommendationReading:[label]});
  assert.deepEqual(blank.pocket.getBoundingClientRect(),rect(width-(width===320?60:64),724,48,48),'empty space beside label remains usable');blank.api.dispose();
 }
});

test('recommendation footer buttons clear the companion on mobile and desktop without limiting panels',()=>{
 for(const width of [320,430,901,1084]){
  const cta=element(rect(width-100,689,76,44)),p=panel(),f=fixture({width,recommendationActions:[cta],panels:[p],navTop:width<=900?719:null});
  assert.ok(f.resize.targets.has(cta),'collect both real footer action selectors, including wrapped use button');assertSafe(f,[cta]);
  assert.ok(parseFloat(p.style.maxHeight)>300,'ordinary-flow recommendation actions do not form a panel ceiling');
  f.recommendationActions.length=0;f.structure.callback();f.flush();assert.equal(f.resize.targets.has(cta),false);
  if(width>900)assert.deepEqual(f.pocket.getBoundingClientRect(),rect(width-72,707,48,48));f.api.dispose();
 }
});

test('recommendation reading uses the existing scroll clipping, resize and visual viewport protection',()=>{
 const clip=element(rect(0,52,320,600),{style:{overflowY:'auto',overflowX:'hidden'}});
 const value=element(rect(249,748,28,20),{parentElement:clip,matches:()=>true}),f=fixture({height:844,recommendationReading:[value]});
 assert.deepEqual(f.pocket.getBoundingClientRect(),rect(260,724,48,48));
 clip.box=rect(0,52,320,760);f.send(f.doc,'scroll');f.flush();assertSafe(f,[value]);
 value.box=rect(249,f.pocket.getBoundingClientRect().top+8,28,20);f.resize.callback();f.flush();assertSafe(f,[value]);
 f.view.height=600;f.send(f.view,'resize');f.flush();assertSafe(f,[]);assert.ok(f.pocket.getBoundingClientRect().bottom<=588);
 value.style.visibility='hidden';f.send(f.doc,'scroll');f.flush();assert.equal(f.pocket.dataset.avoidance,'clear');f.api.dispose();
});

test('only recommendation exposure, settled carousel motion and root replacement schedule new layout',()=>{
 const card=element(rect(24,200,272,580),{ariaHidden:true,matches:s=>s==='.bh-recommendation-card'});
 const value=element(rect(249,748,28,20),{card,matches:()=>true}),f=fixture({height:844,recommendationReading:[value]});
 assert.equal(f.resize.targets.has(value),false);
 const rail=element(rect(0,200,320,580),{matches:s=>s==='[data-bh-recommendation-rail]'});
 f.structure.callback([{type:'attributes',target:f.pocket,attributeName:'aria-hidden'},{type:'childList',target:rail}]);assert.equal(f.frames.size,0,'ignore unrelated descendants and companion aria state');
 card.ariaHidden=false;f.structure.callback([{type:'attributes',target:card,attributeName:'aria-hidden'}]);
 f.structure.callback([{type:'attributes',target:rail,attributeName:'data-interacting'}]);assert.equal(f.frames.size,1,'relevant changes share one frame');f.flush();assertSafe(f,[value]);
 value.box=rect(249,f.pocket.getBoundingClientRect().top+8,28,20);f.structure.callback([{type:'attributes',target:rail,attributeName:'data-interacting'}]);f.flush();assertSafe(f,[value]);
 card.ariaHidden=true;f.structure.callback([{type:'attributes',target:card,attributeName:'aria-hidden'}]);f.flush();assert.equal(f.resize.targets.has(value),false);
 assert.deepEqual(f.structure.options,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-hidden','data-interacting']});
 f.structure.callback();assert.equal(f.frames.size,1);f.api.dispose();f.structure.callback([{type:'attributes',target:rail,attributeName:'data-interacting'}]);assert.equal(f.frames.size,0);
});

test('dense recommendation actions retain blocked focus handling and recover when the card disappears',()=>{
 const card=element(rect(0,52,320,700),{ariaHidden:true,matches:s=>s==='.bh-recommendation-card'});
 const actions=[element(rect(0,52,90,700),{card}),element(rect(230,52,90,700),{card})],p=panel(),f=fixture({recommendationActions:actions,panels:[p]});f.doc.activeElement=p;
 card.ariaHidden=false;f.structure.callback([{type:'attributes',target:card,attributeName:'aria-hidden'}]);f.flush();
 assert.equal(f.pocket.dataset.avoidance,'blocked');assert.equal(f.pocket.inert,true);assert.equal(f.pocket.attributes['aria-hidden'],'true');assert.equal(f.doc.activeElement,f.focusTarget);assert.equal(p.hidden,false);
 card.ariaHidden=true;f.structure.callback([{type:'attributes',target:card,attributeName:'aria-hidden'}]);f.flush();
 assertSafe(f,[]);assert.equal(f.pocket.inert,false);assert.equal(f.pocket.attributes['aria-hidden'],undefined);assert.equal(f.doc.activeElement,f.focusTarget);assert.equal(p.hidden,false);assert.equal(f.resize.targets.has(actions[0]),false);f.api.dispose();
});

test('the real 390px chart footer keeps TradingView credits, time and status clear without blocking its empty space',()=>{
 const status=element(rect(29,735,82,16),{matches:s=>s.includes('.trading-chart-status>span'),textRects:[rect(39,735,72,16)]});
 const time=element(rect(125,735,92,16),{matches:s=>s.includes('.trading-chart-footer>time')});
 const credit=element(rect(279,735,61,16)),notice=element(rect(348,735,9,16));
 const f=fixture({width:390,height:844,chartFooterReading:[status,time],chartFooterActions:[credit,notice]});
 for(const el of [status,time,credit,notice])assert.ok(f.resize.targets.has(el),'collect actual footer text and action leaves');
 assertSafe(f,[{box:status.textRects[0]},time,credit,notice]);f.api.dispose();
 status.box=rect(29,735,332,16);const blank=fixture({width:390,height:844,chartFooterReading:[status]});
 assert.deepEqual(blank.pocket.getBoundingClientRect(),rect(326,724,48,48),'use status ink, not a full-width footer obstacle');blank.api.dispose();
 const desktopCredit=element(rect(980,550,80,20)),desktop=fixture({width:1084,height:610,navTop:null,chartFooterActions:[desktopCredit]});
 assertSafe(desktop,[desktopCredit]);desktop.api.dispose();
});

test('async stats mount protects a non-selected 320px signal card price and time ink',()=>{
 const price=element(rect(179,748,40,18),{selected:false,matches:s=>s.includes('.sig-stats-readout>'),textRects:[rect(179,748,34,18)]});
 const stamp=element(rect(220,748,70,18),{selected:false,matches:s=>s.includes('.sig-stats-readout>')});
 const incoming=[],host=element(rect(32,700,256,150),{matches:s=>s==='[data-signal-stats]'}),f=fixture({height:844,signalReading:incoming});
 incoming.push(price,stamp);f.structure.callback([{type:'childList',target:host}]);f.flush();
 assert.ok(f.resize.targets.has(price)&&f.resize.targets.has(stamp),'collect actual readout leaves after React mounts, including non-selected cards');
 assertSafe(f,[{box:price.textRects[0]},stamp]);
 f.structure.callback([{type:'childList',target:element(rect(0,0,0,0))}]);assert.equal(f.frames.size,0,'internal chart updates do not schedule body layout');
 incoming.length=0;f.structure.callback([{type:'childList',target:host}]);f.flush();assert.equal(f.resize.targets.has(stamp),false);f.api.dispose();
 price.box=rect(20,748,280,18);const blank=fixture({height:844,signalReading:[price]});
 assert.deepEqual(blank.pocket.getBoundingClientRect(),rect(260,724,48,48),'reserve price ink rather than full-width readout space');blank.api.dispose();
});


test('carousel-driven displacement also clears the real 320px strategy category buttons',()=>{
 const recommendation=element(rect(136,703,130,44)),categoryActions=[],f=fixture({height:844,recommendationActions:[recommendation],categoryActions});
 assertSafe(f,[recommendation]);const before=f.pocket.getBoundingClientRect();
 const buttons=[20,89,158,227].map(left=>element(rect(left,668.37,66,44)));assert.equal(overlaps(before,buttons.at(-1).box),true,'reproduce the observed next-control collision');
 recommendation.box=rect(136,309,130,44);categoryActions.push(...buttons);f.structure.callback();f.flush();
 assert.ok(buttons.every(b=>f.resize.targets.has(b)),'collect actual category buttons without protecting the whole section');assertSafe(f,[recommendation,...buttons]);f.api.dispose();
});


test('actual asynchronously inserted page controls share body protection without scanning text or SVG updates',()=>{
 const inert=element(rect(240,748,64,44),{closest:()=>({})}),pageControls=[inert],f=fixture({height:844,pageControls}),selector='button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button]';
 assert.equal(f.resize.targets.has(inert),false,'inactive or aria-hidden ancestors do not create visible control obstacles');assert.deepEqual(f.pocket.getBoundingClientRect(),rect(260,724,48,48));
 const button=element(rect(240,748,64,44),{matches:s=>s.startsWith(selector)}),holder=element(rect(220,730,100,80),{querySelector:s=>s.startsWith(selector)?button:null}),target=element(rect(0,52,320,720));
 pageControls.push(button);f.structure.callback([{type:'childList',target,addedNodes:[holder]}]);f.flush();
 assert.ok(f.resize.targets.has(button),'collect a real control added inside an existing section');assertSafe(f,[button]);
 f.structure.callback([{type:'childList',target,addedNodes:[{nodeType:3},element(rect(0,0,100,100))]}]);assert.equal(f.frames.size,0,'price text and SVG-only changes do not schedule layout');
 pageControls.length=0;f.structure.callback([{type:'childList',target,removedNodes:[holder]}]);f.flush();assert.equal(f.resize.targets.has(button),false);assert.equal(f.pocket.inert,false);f.api.dispose();
});


test('the measured390px price/time axes protect their actual canvases after async mount and resize',()=>{
 const priceSelector='.trading-chart-canvas .tv-lightweight-charts>table>tr:first-child>td:last-child canvas:first-of-type';
 const price=element(rect(289,440.390625,80,185)),time=element(rect(21,672.390625,268,28)),credit=element(rect(266.3984375,734.890625,94.6015625,19.5));
 const chartAxes=[],f=fixture({width:390,height:844,bodyTop:603.6953125,chartAxes,chartFooterActions:[credit]});
 assert.equal(overlaps(f.pocket.getBoundingClientRect(),price.box),true,'reproduce the observed retained mobile position crossing the price axis');
 const chart=element(rect(21,440,348,260),{querySelector:s=>s.includes(priceSelector)?price:null});
 chartAxes.push(price,time);f.structure.callback([{type:'childList',target:element(rect(0,0,0,0)),addedNodes:[chart]}]);f.flush();
 assert.ok(f.resize.targets.has(price)&&f.resize.targets.has(time),'collect primary price and time axes through their measured DOM selectors');assertSafe(f,[price,time,credit]);
 assert.equal(overlaps(f.pocket.getBoundingClientRect(),rect(289,626.390625,80,46),0),true,'blank volume-axis space is not a whole-chart obstacle');
 price.box=rect(289,f.pocket.getBoundingClientRect().top+4,80,185);f.resize.callback();f.flush();assertSafe(f,[price,time,credit]);f.api.dispose();
});

test('assistant briefs stay next to the figure and clear typing, sending, tools and mobile navigation',()=>{
 for(const [width,height,inputs] of [
  [1440,900,[rect(423,640,810,62),rect(1191,706,42,42),rect(717,767,108,44)]],
  [390,844,[rect(42,496,306,62),rect(304,562,44,44),rect(103,623,90,44)]],
  [320,625,[rect(42,277,236,62),rect(234,343,44,44),rect(80,404,90,44)]],
  [1920,1080,[rect(600,820,810,62),rect(1370,886,42,42),rect(900,947,108,44)]],
 ]){
  const controls=inputs.map(bounds=>element(bounds));
  const composer=element(rect(16,height-287,width-32,222),{matches:s=>s==='.chat-composer-area',querySelectorAll:()=>controls});
  const brief=panel();brief.offsetHeight=320;brief.hidden=true;
  const f=fixture({width,height,navTop:width<=900?height-60:null,panels:[brief],actions:[composer],pageControls:controls});
  f.doc.body.dataset={page:'assistant'};f.api.layout();
  const rest=f.pocket.getBoundingClientRect();
  brief.hidden=false;f.api.layout();
  const anchor=f.pocket.getBoundingClientRect(),[dy,,,dx]=brief.style.inset.split(' ').map(parseFloat);
  const card=rect(anchor.left+dx,anchor.top+dy,Math.min(brief.offsetWidth,parseFloat(brief.style.maxWidth)),Math.min(brief.offsetHeight,parseFloat(brief.style.maxHeight)));
  assert.ok(anchor.top-card.bottom===12||anchor.left-card.right===12,'brief stays 12px from the figure at '+width+'px');
  for(const r of [...inputs,...(f.nav?[f.nav.box]:[])]){assert.equal(overlaps(card,r,0),false);assert.equal(overlaps(anchor,r,0),false);}
  if(width===1920)assert.equal(anchor.top,rest.top,'empty space beside the composer remains usable');
  brief.hidden=true;f.api.layout();assert.deepEqual(f.pocket.getBoundingClientRect(),rest);f.api.dispose();
 }
});
