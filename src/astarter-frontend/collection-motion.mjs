import {inside,distance,same,readingArea,clearSegment,newsDepartureDelays,runCourierPlan} from './collection-planner.mjs';
export {planNewsCrew,planDataCrew,planSignalCrew,planDataWalk,nextDataPair,newsReturnPath,newsDepartureDelays} from './collection-planner.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {DATA_PAGES} from './data-center-fixtures.mjs';

// ThreeUI Pro Cross Beam / Frame Beam: equal-speed perimeter, soft wash,
// sharp core and a travelling highlight. Adapted to one shared SVG/timebase.
const NS='http://www.w3.org/2000/svg';
const clamp=n=>Math.max(0,Math.min(1,n));
export const courierFigure='<span class="courier-shadow"></span><span class="courier-person"><span class="courier-head"><i></i><i></i></span><span class="courier-arm left"></span><span class="courier-torso"></span><span class="courier-arm right"></span><span class="courier-leg left"></span><span class="courier-leg right"></span><span class="courier-paper"><i></i><i></i></span></span>';
export function collectionSource(sources,job,id,fallback){
 if(!job)return fallback;
 const symbol=job.symbol?.split(/[ /]/)[0];
 const local=sources.filter(s=>s.asset===symbol&&s.lower);
 const intent=({validation:'strategy',risk:'risk',execution:'execution',review:'result'})[job.taskType];
 const business=job.business&&intent?local.find(s=>s.intent===intent&&s.roles?.includes(id)):null;
 if(business)return business;
 const asset=!job.business&&job.roles?.[0]===id?(job.route!=='direct'&&local.find(s=>s.intent==='asset'&&s.zone?.startsWith('workflow:'))||local.find(s=>s.intent==='asset')):null;
 return asset||sources.find(s=>!s.lower&&job.sourceAnchor&&s.zone===job.sourceAnchor)||sources.find(s=>!s.lower&&s.key===job.source)||fallback;
}

export function collectionBeam(progress,width,height){
 const perimeter=2*(Math.max(1,width)+Math.max(1,height));
 const u=clamp(progress),envelope=Math.sin(Math.PI*u);
 return {perimeter,offset:-u*perimeter,length:Math.max(24,perimeter*.2),opacity:Math.max(0,envelope),scan:u*Math.max(1,width)};
}

export function createCollectionBeams(layer,scope=document){
 const svg=document.createElementNS(NS,'svg');svg.classList.add('courier-collection-beams');svg.setAttribute('aria-hidden','true');layer.prepend(svg);
 const frames=new Map();
 let squads=[];
 function frame(source){
  const key=(source.zone||source.key)+':'+(source.asset||'');
  let item=frames.get(key);
  if(!item){const group=document.createElementNS(NS,'g');group.innerHTML='<rect class="collection-beam-wash" fill="none"/><rect class="collection-beam-core" fill="none"/><rect class="collection-beam-head" fill="none"/>';svg.append(group);item={group,rects:[...group.children]};frames.set(key,item);}
  return item;
 }
 return {
  update(geometry,poses,time,active){
   svg.setAttribute('viewBox',`0 0 ${geometry.width} ${geometry.height}`);
   svg.style.display=active?'':'none';for(const item of frames.values())item.group.style.display='none';
   if(!active)return;
   if(!squads.length||!squads[0].isConnected)squads=[...scope.querySelectorAll('.terminal-team')];
   squads.forEach((node,i)=>node.style.setProperty('--beam-angle',((time*82+i*57)%360)+'deg'));
   const readers=poses.filter(p=>p.phase===1||p.workPhase==='visit'&&p.job?.progress>=.10);
   for(const pose of readers){const source=pose.source;if(!source?.el||!source.box)continue;const item=frame(source),b=source.box,u=pose.phase===1?pose.p:clamp((pose.job.progress-.10)/.06),beam=collectionBeam(u,b.width,b.height);
    item.group.style.display='';item.group.style.color=pose.color;item.group.setAttribute('opacity',String(beam.opacity));item.group.dataset.source=source.zone||source.key;item.group.dataset.agent=String(pose.id);item.group.dataset.job=pose.job?.id||'';
    for(const [i,rect]of item.rects.entries()){for(const [key,value]of Object.entries({x:b.x+2,y:b.y+2,width:b.width-4,height:b.height-4,rx:7,'pathLength':beam.perimeter,'stroke-dasharray':`${i===2?8:beam.length} ${beam.perimeter}`,'stroke-dashoffset':beam.offset}))rect.setAttribute(key,String(value));}
   }
   for(const [key,item]of frames)if(item.group.style.display==='none'){item.group.remove();frames.delete(key);}
  },
  dispose(){frames.clear();svg.remove();}
 };
}


// Rotate all eighteen original characters, one member from each colour group at a time.
const newsRoster=RESEARCH_GROUPS.flatMap(group=>group.roles.map((id,shift)=>({id,shift,color:group.color})))
  .sort((a,b)=>a.shift-b.shift);
const controls='a[href],button,input,select,summary,[role=button],[role=tab]';

function courierWindow(root, pocket) {
  const doc=root.ownerDocument, win=doc.defaultView;
  const view=root.getBoundingClientRect(), dock=doc.querySelector('.biz-mobile-nav')?.getBoundingClientRect();
  const h=pocket.getBoundingClientRect(),home={x:h.left+h.width/2,y:h.top+h.height/2};
  const compact=win.innerWidth<=900,px=compact?10:13,py=compact?15:17;
  const viewport={left:Math.max(0,view.left),right:Math.min(view.right,win.innerWidth),top:Math.max(0,view.top),
    bottom:Math.min(view.bottom,win.innerHeight,dock?.height?dock.top:Infinity)};
  const bounds={left:Math.min(home.x,viewport.left+px),right:Math.max(home.x,viewport.right-px),
    top:Math.min(home.y,viewport.top+py),bottom:Math.max(home.y,viewport.bottom-py)};
  const boxes=new WeakMap(),styles=new WeakMap();
  function box(el){let r=boxes.get(el);if(!r){r=el.getBoundingClientRect();boxes.set(el,r);}return r;}
  function style(el){let s=styles.get(el);if(!s){s=win.getComputedStyle(el);styles.set(el,s);}return s;}
  return {doc,win,viewport,home,anchor:h,compact,px,py,bounds,box,style};
}

const signalSolid=[controls,'.as-search','.liquid-native-host','.sig-filter-body','.sig-preferences-panel','.pw-trackbar','.layout-navigation-row','.sig-stats-chart-panel',
  '.sig-card-spark','.sig-detail-chart','svg','canvas','img','[role=img]'].join(',');
const signalHidden='[hidden],.sr-only,.visually-hidden,script,style,template,noscript,option';

function clippedBox(rect,clip) {
  const left=Math.max(rect.left,clip.left),right=Math.min(rect.right,clip.right);
  const top=Math.max(rect.top,clip.top),bottom=Math.min(rect.bottom,clip.bottom);
  return right>left&&bottom>top?{left,right,top,bottom,width:right-left,height:bottom-top}:null;
}

// These containers bound their own scrolling rows/cards. Sticky cells stay inside
// their table and floating menus render in a separate layer. A zero-size or
// display:contents wrapper can still have visible children, so keep traversing it.
const boundedBranches='section,article,aside,nav,table,thead,tbody,tr,ul,ol,li,dl,.dc-table-wrap,.hub-table-wrap,.hub-overview-charts,.hub-two,.hub-three,.hub-asset-cards,.hub-heatmap,.pd-news-list,.pd-market-table,.pd-social-layout,.df-timeline';
function outsideView(rect,clip){
  return rect.width>0&&rect.height>0&&(rect.bottom<=clip.top||rect.top>=clip.bottom||rect.right<=clip.left||rect.left>=clip.right);
}

function measuredFloor(root,frame,stops,solid) {
  const {doc,home,anchor,compact,px,py,bounds,viewport,box}=frame;
  const ink=[],obstacles=[],range=doc.createRange(),seen=new Set();
  function protect(rect,clip) {
    const b=clippedBox(rect,clip);
    if(!b)return;
    const key=[b.left,b.top,b.right,b.bottom].join(',');
    if(seen.has(key))return;
    seen.add(key);ink.push(b);
    obstacles.push({left:b.left-px,right:b.right+px,top:b.top-py,bottom:b.bottom+py});
  }
  // Only painted lines, controls and charts block card whitespace. Clip nested
  // scroll containers as well as the page so hidden copies cannot close an aisle.
  function read(el,clip) {
    if(el.matches(signalHidden))return;
    if(el.matches(boundedBranches)&&outsideView(box(el),clip))return;
    const style=frame.style(el);
    if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return;
    if(el.matches(solid)){protect(box(el),clip);return;}
    if(style.overflowX!=='visible'||style.overflowY!=='visible'){
      const r=box(el);
      const content={left:style.overflowX==='visible'?clip.left:r.left,right:style.overflowX==='visible'?clip.right:r.right,
        top:style.overflowY==='visible'?clip.top:r.top,bottom:style.overflowY==='visible'?clip.bottom:r.bottom};
      clip=clippedBox(content,clip);if(!clip)return;
    }
    if(el.tagName==='DETAILS'&&!el.open){const summary=el.querySelector(':scope>summary');if(summary)read(summary,clip);return;}
    for(const node of el.childNodes){
      if(node.nodeType===1){read(node,clip);continue;}
      if(node.nodeType!==3||!node.textContent.trim())continue;
      range.selectNodeContents(node);
      for(const b of range.getClientRects())protect(b,clip);
    }
  }
  read(root,viewport);
  return {bounds,home,anchor,stops,obstacles,ink,compact};
}

function signalSources(root,frame){
  const feed=root.querySelector('.sig-tracking .sig-feed'),research=feed?null:root.querySelector('.biz-op-layout');
  if(!feed&&!research)return null;
  const clip=contentClipping(root,frame),stops=[],ids=new Set();
  function add(row,id,kind,edge=false){
    const visible=clip(row),rect=visible&&clippedBox(frame.box(row),visible);
    if(!id||ids.has(id)||!rect||rect.height<24||rect.width<36)return;
    const time=row.querySelector('time'),stamp=time&&clippedBox(frame.box(time),rect);
    ids.add(id);stops.push({id,row,rect,stamp,kind,edge});
  }
  if(feed){
    for(const row of feed.querySelectorAll('article[data-track-record]'))add(row,row.dataset.trackRecord,'signal');
    const detail=root.querySelector('.sig-detail-aside .sig-reading-hero,.sig-detail-aside .sig-live-detail');
    const id=detail&&root.querySelector('.sig-detail-aside [data-track-copy]')?.dataset.trackCopy;
    if(id)add(detail,'analysis:'+id,'analysis');
  }else{
    for(const row of research.querySelectorAll('.biz-op-row[data-id]'))add(row,'finding:'+row.dataset.id,'finding',true);
    const current=research.querySelector('.biz-op-row[aria-pressed="true"]')?.dataset.id;
    const detail=research.querySelector('.biz-op-detail .decision-card');
    if(detail&&current)add(detail,'finding-detail:'+current,'analysis');
  }
  return markSources(root,stops);
}
function walkingAreas(area,selector,frame,clip){
  const out=[];
  for(const module of area.querySelectorAll(selector)){
    const visible=clip(module),rect=visible&&clippedBox(frame.box(module),visible);
    if(rect&&rect.width>=32&&rect.height>=28)out.push(rect);
  }
  return out;
}
export function measureSignalFloor(root,pocket){
  const frame=courierWindow(root,pocket),stops=signalSources(root,frame);
  if(!stops)return null;
  const floor=measuredFloor(root,frame,stops,signalSolid);
  floor.walkAreas=walkingAreas(root,'.sig-event,.sig-empty,.sig-detail-aside,.biz-op-list,.biz-op-detail,.biz-signal-section',frame,contentClipping(root,frame));
  return floor;
}


const dataSolid=[signalSolid,'.chart-canvas','[data-hub-plot]','.hub-overview-charts .hub-empty','.hub-breadth','iframe','video','object','embed'].join(',');
const annotatedSources=new WeakMap();
const elementText=(el,selector)=>el.querySelector(selector)?.textContent.trim()||'';
const containsValue=text=>/\d/.test(text??'');
const siblingIndex=el=>Array.prototype.indexOf.call(el.parentElement.children,el);
const officialLink=el=>el.querySelector('a[href^="https://"],a[href^="http://"]')?.getAttribute('href');
const timeKey=el=>el.querySelector('time[datetime]')?.getAttribute('datetime');
const marketQuote=el=>containsValue(elementText(el,'[data-hub-price]'))&&(el.dataset.hubCard||el.querySelector('[data-hub-price]')?.dataset.hubPrice);
const namedValue=(el,label,value)=>containsValue(elementText(el,value))&&elementText(el,label);
function tableObservation(text) {
  return containsValue(text.replace(/\b\d{4}-\d\d-\d\d\b|\b\d\d:\d\d(:\d\d)?\b|\b0x[\da-f]{8,}\b/gi,''));
}

// Only source-backed renderers own these attributes and selectors. Navigation,
// receipt/status messages, summaries of missing feeds and chart axes are never sources.
const dataStationTypes=[
  ['[data-news-record],[data-news-copy]','news',(el,row)=>officialLink(row)&&(el.dataset.newsRecord||el.dataset.newsCopy)],
  ['.df-economic-event','release',el=>officialLink(el)&&timeKey(el)&&[timeKey(el),elementText(el,'h3')].join('/')],
  ['[data-intelligence-day]:has(.has-event)','calendar',el=>el.dataset.intelligenceDay],
  ['.df-market-list>div','close',el=>namedValue(el,'.dc-asset b',':scope>span>b')],
  ['[data-social-post]','post',el=>timeKey(el)&&(elementText(el,'p')||el.querySelector('.pd-post-media img'))&&el.dataset.socialPost],
  ['[data-lunar-topic]','topic',el=>[...el.querySelectorAll('dd')].some(dd=>containsValue(dd.textContent))&&el.dataset.lunarTopic],
  ['.pd-sentiment','sentiment',el=>containsValue(elementText(el,'[data-fng-value]'))&&timeKey(el)&&'btc'],
  ['a.pd-market-tr','spot',el=>containsValue(elementText(el,'.pd-price'))&&el.getAttribute('href')],
  ['.pd-quote>div,.hub-detail-price','quote-detail',el=>containsValue(elementText(el,'strong,b,[data-hub-price]'))&&String(siblingIndex(el))],
  ['[data-hub-card],tr[data-hub-row]','quote',marketQuote],
  ['.hub-kpis>.hub-stat','asset-metric',el=>containsValue(elementText(el,'strong'))&&String(siblingIndex(el))],
  ['.hub-facts>div','change-period',el=>el.querySelector('dd .hub-up,dd .hub-down,dd .hub-flat')&&containsValue(elementText(el,'dd'))&&String(siblingIndex(el))],
  ['[data-trading-chart][data-chart-source="market"]','candles',el=>Number(el.dataset.candleCount)>0&&el.querySelector('canvas')&&el.dataset.tradingChart],
  ['.dc-section>p:has(>strong)','balance',el=>officialLink(el.parentElement)&&containsValue(elementText(el,'strong'))&&String(siblingIndex(el))],
  ['[data-hub-tile]','change',el=>containsValue(elementText(el,'[data-hub-change],strong'))&&el.dataset.hubTile],
  ['.hub-overview-charts>.hub-panel','overview',el=>{
    const plot=el.querySelector('[data-hub-plot][data-chart-ready="true"]');
    return plot&&containsValue(plot.getAttribute('aria-label')?.split(' · ').filter(s=>!/^(\d+h|\d+d)$/i.test(s)).join(' '))&&plot.dataset.hubPlot;
  }],
  ['.hub-market-summary dl>div','global',el=>containsValue(elementText(el,'dd'))&&String(siblingIndex(el))],
  ['.hub-breadth-summary','breadth',el=>containsValue(elementText(el,'strong'))&&'assets'],
  ['.hub-feed-event','tick',el=>containsValue(elementText(el,'.hub-feed-price'))&&timeKey(el)&&[elementText(el,'b'),timeKey(el)].join('/')],
  ['.hub-sector,.hub-rank-row,.hub-venue,.hub-venue-list>li','ranking',el=>namedValue(el,'b','strong')],
  ['[data-chart]','series',el=>Number(el.dataset.visibleCount)>0&&containsValue(elementText(el,'.chart-readout dd'))&&el.dataset.chart],
  ['.dc-stat','stat',el=>containsValue(elementText(el,'strong'))&&String(siblingIndex(el))],
  ['.dc-table tbody>tr:not([data-hub-row]),.dc-section table tbody>tr','row',(el,row,scope)=>{
    const cells=Array.from(el.cells),identity=cells[0]?.textContent.trim();
    if(!identity||cells.length<2)return null;
    // A dated row with empty value cells is an unreported observation.
    const observation=cells.slice(1).some(td=>tableObservation(td.textContent));
    const link=cells.slice(0,2).map(td=>td.querySelector('a[href]')?.getAttribute('href')).find(Boolean);
    const calendar=scope.startsWith('intelligence:')&&/^\d{4}-\d\d-\d\d/.test(identity)&&officialLink(el);
    if(calendar)return [identity,elementText(el,'td:nth-child(3)'),calendar].join('/');
    return observation&&(link||identity);
  }]
];
const dataStations=dataStationTypes.map(([selector])=>selector).join(',');

function sourceContext(root) {
  const area=root.querySelector('.dc-root');
  if(!area)return null;
  const query=new URLSearchParams(root.ownerDocument.defaultView.location?.search||'');
  const channel=area.dataset.dataCenter||area.dataset.publicData;
  const scope=[channel,...['view','asset','coin','metric','exchange','fund','range','series','trader','window']
    .filter(key=>query.has(key)).map(key=>key+'='+query.get(key))].join(':');
  return {area,scope,live:area.hasAttribute('data-public-data')&&query.get('data')!=='demo'};
}

function contentClipping(root,frame) {
  const {viewport,box}=frame;
  const clips=new WeakMap();
  // Tables, media strips and dropdowns scroll independently of the main page.
  function contentClip(el) {
    if(!el||el===root.parentElement)return viewport;
    if(clips.has(el))return clips.get(el);
    const parent=el.parentElement;
    let clip=el.hidden||parent?.tagName==='DETAILS'&&!parent.open&&el.tagName!=='SUMMARY'?null:contentClip(parent);
    if(clip&&el.matches(boundedBranches)&&outsideView(box(el),clip))clip=null;
    if(!clip){clips.set(el,null);return null;}
    const s=frame.style(el);
    if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')clip=null;
    if(clip&&(s.overflowX!=='visible'||s.overflowY!=='visible')){
      const r=box(el);
      const inner={left:r.left+(el.clientLeft||0),top:r.top+(el.clientTop||0)};
      inner.right=inner.left+(el.clientWidth||r.width);inner.bottom=inner.top+(el.clientHeight||r.height);
      clip=clippedBox({left:s.overflowX==='visible'?clip.left:inner.left,right:s.overflowX==='visible'?clip.right:inner.right,
        top:s.overflowY==='visible'?clip.top:inner.top,bottom:s.overflowY==='visible'?clip.bottom:inner.bottom},clip);
    }
    clips.set(el,clip);return clip;
  }
  return contentClip;
}

function visibleStops(root,{area,scope,live},contentClip,box) {
  const byId=new Map(),panels=[...area.querySelectorAll('.dc-panel')],tables=[...area.querySelectorAll('.dc-table,.dc-section table')];
  const range=root.ownerDocument.createRange();
  for(const el of live?area.querySelectorAll(dataStations):[]){
    const row=el.hasAttribute('data-news-copy')?el.parentElement:el,clip=contentClip(row);
    if(!clip)continue;
    const rect=clippedBox(box(row),clip);
    if(!rect||rect.height<16||rect.width<24)continue;
    const [,kind,identify]=dataStationTypes.find(([selector])=>el.matches(selector));
    const key=identify(el,row,scope);
    if(!key)continue;
    const table=kind==='row'?tables.indexOf(el.closest('table')):null;
    if(kind==='row'){
      // Scrolling a published observation out of view can expose only dashes.
      // The sticky date or rank alone is insufficient to make that a station.
      const cells=Array.from(el.cells).slice(1);
      const schedule=scope.startsWith('intelligence:')&&officialLink(el);
      if(!cells.some(cell=>{
        if(!clippedBox(box(cell),rect)||!tableObservation(cell.textContent)&&!(schedule&&(cell===cells[1]||cell===cells[0]&&/\d\d:\d\d/.test(cell.textContent))))return false;
        range.selectNodeContents(cell);return [...range.getClientRects()].some(r=>clippedBox(r,rect));
      }))continue;
    }
    const section=kind==='stat'?panels.indexOf(el.closest('.dc-panel')):table;
    const id=kind==='news'?key:[scope,kind,...(section==null?[]:[section]),key].join(':');
    const time=row.querySelector('time'),stamp=time&&clippedBox(box(time),rect);
    const previous=byId.get(id);
    // Prefer the full article when its timestamp is readable. A visible side
    // copy still works when the primary article is outside the viewport.
    if(!previous||kind==='news'&&(Number(Boolean(stamp))*2+Number(el.hasAttribute('data-news-record'))>
      Number(Boolean(previous.stamp))*2+Number(previous.row.hasAttribute('data-news-record'))))
      byId.set(id,{id,row,rect,stamp,kind,edge:row.matches('a[href],button')});
  }
  return markSources(root,[...byId.values()]);
}
function markSources(root,stops){
  const old=annotatedSources.get(root),active=new Set();
  for(const stop of stops){active.add(stop.row);if(stop.row.dataset.courierSource!==stop.id)stop.row.dataset.courierSource=stop.id;}
  if(old)for(const row of old)if(!active.has(row))delete row.dataset.courierSource;
  annotatedSources.set(root,active);
  return stops;
}

export function dataPatrolStops(root,pocket) {
  const context=sourceContext(root);
  if(!context)return [];
  const frame=courierWindow(root,pocket);
  return visibleStops(root,context,contentClipping(root,frame),frame.box);
}

const dataModules='.dc-panel,.dc-section,.pd-market-panel,.pd-social-stream,.pd-social-context,.df-timeline,.hub-market-summary,.hub-kpis,.hub-detail-price,.trading-chart,.pd-quote,.pd-sentiment,.pd-notice';
export function measureDataFloor(root,pocket) {
  const context=sourceContext(root);
  if(!context&&!DATA_PAGES.includes(root.dataset?.renderedPage))return null;
  const frame=courierWindow(root,pocket),clip=contentClipping(root,frame),area=context?.area||root;
  const stops=context?visibleStops(root,context,clip,frame.box):[],floor=measuredFloor(root,frame,stops,dataSolid);
  floor.walkAreas=walkingAreas(area,dataModules,frame,clip);
  return floor;
}

export function mountNewsCourier(root,pocket,onReceived) {
  return mountCourierCrew(root,pocket,'data',onReceived);
}

export function mountSignalCourier(root,pocket) {
  const {layout,dispose}=mountCourierCrew(root,pocket,'signals');
  return {layout,dispose};
}

function gate() {
  let finish;
  const done=new Promise(resolve=>{finish=resolve;});
  return {done,finish};
}

// Each pair finishes reading before it goes to talk. Several pairs can use
// one safe meeting place in turn while the other readers stay at their cards.
export function signalMeetingRooms() {
  const pairs=new Map(),lastInRoom=new Map();
  return {
    arrive(pair,room){
      let visit=pairs.get(pair);
      if(!visit){
        visit={room,enter:gate(),vacant:gate()};pairs.set(pair,visit);
      }else{
        const ahead=lastInRoom.get(room);
        lastInRoom.set(room,visit);
        if(ahead)ahead.vacant.done.then(visit.enter.finish);
        else visit.enter.finish(true);
      }
      return visit.enter.done;
    },
    leave(pair){
      const visit=pairs.get(pair);
      if(!visit)return;
      if(lastInRoom.get(visit.room)===visit)lastInRoom.delete(visit.room);
      pairs.delete(pair);visit.vacant.finish(true);
    },
    clear(){
      for(const visit of pairs.values()){visit.enter.finish(false);visit.vacant.finish(false);}
      lastInRoom.clear();pairs.clear();
    }
  };
}

// Keep a single planner per mounted patrol. A newer geometry snapshot invalidates
// old work naturally; the owner checks the view and wave before applying results.
function createPlanner(win){
  const requests=new Map(),snapshots=new WeakMap();
  let worker,unavailable=false,serial=0,revision=0,disposed=false;
  function fallback(run){
    return new Promise((resolve,reject)=>win.setTimeout(()=>{
      try{resolve(disposed?null:run());}catch(error){reject(error);}
    },0));
  }
  function failed(){
    unavailable=true;worker?.terminate();worker=null;
    for(const pending of requests.values())pending.retry();
    requests.clear();
  }
  function compute(operation,floor,args){
    if(disposed)return Promise.resolve(null);
    let snapshot=snapshots.get(floor);
    if(!snapshot){
      const {bounds,home,compact,stops,ink,obstacles,walkAreas}=floor;
      const geometry={bounds,home,compact,ink,obstacles,walkAreas,stops:stops.map(({row,...stop})=>stop)};
      snapshot={revision:++revision,floor:geometry};snapshots.set(floor,snapshot);
    }
    if(!worker&&!unavailable&&win.Worker){
      try{worker=new win.Worker(new URL('./collection-planner.mjs',import.meta.url),{type:'module',name:'courier-routes'});
        worker.onmessage=({data})=>{
          const pending=requests.get(data.id);if(!pending)return;
          requests.delete(data.id);data.error?pending.reject(new Error(data.error)):pending.resolve(data.result);
        };
        worker.onerror=failed;worker.onmessageerror=failed;
      }catch{unavailable=true;}
    }
    const local=()=>runCourierPlan(operation,floor,args);
    if(!worker)return fallback(local);
    const id=++serial;
    return new Promise((resolve,reject)=>{
      requests.set(id,{resolve,reject,retry:()=>fallback(local).then(resolve,reject)});
      try{worker.postMessage({id,operation,...snapshot,args});}catch{failed();}
    });
  }
  return {compute,dispose(){disposed=true;worker?.terminate();worker=null;for(const pending of requests.values())pending.resolve(null);requests.clear();}};
}
function withSourceNodes(jobs,floor){
  const stops=new Map(floor.stops.map(stop=>[stop.id,stop]));
  return jobs.map(job=>({...job,stop:job.stop?stops.get(job.stop.id):null}));
}
function routeJobs(jobs){return jobs.map(job=>({...job,stop:job.stop&&{id:job.stop.id}}));}

function mountCourierCrew(root,pocket,scene,onReceived) {
  const doc=root.ownerDocument,win=doc.defaultView,events=new AbortController();
  const changedStamp=(a,b)=>a.length!==b.length||a.some((n,i)=>typeof n==='number'?typeof b[i]!=='number'||Math.abs(n-b[i])>4:n!==b[i]);
  const signals=scene==='signals',measureFloor=signals?measureSignalFloor:measureDataFloor;
  const planner=createPlanner(win);
  let starting=false,layoutVersion=0;
  const options={signal:events.signal,passive:true,capture:true},motion=win.matchMedia('(prefers-reduced-motion: reduce)');
  const prompts=[['🤔','💡'],['🧐','🧩'],['👀','👍']];
  const sourceReactions={news:'📰',post:'💬',topic:'💬',calendar:'🗓️',release:'🗓️',candles:'📊',overview:'📊',series:'📊'};
  let wave=null,pending=null,turn=0,roleIndex=0,pressed=false,scrolling=false,away=false,recallRequested=false;
  let startTimer=0,scrollTimer=0,retryTimer=0,welcomeTimer=0,layoutFrame=0,lastWelcome=-Infinity;
  let observedFeed=null,typing=false,typingTimer=0;
  const feedSize=win.ResizeObserver?new win.ResizeObserver(queueLayout):null;
  const openControls=signals?'.sig-controls details[open]':'.dc-info[open],.pd-info[open],[data-info-open],.dc-column-picker';
  const reduced=()=>motion.matches||doc.documentElement.dataset.reducedMotion==='true'||!win.Element.prototype.animate;
  const overlayOpen=()=>pocket.classList.contains('open')||pocket.querySelector('.mascot-menu:not([hidden])')||
    doc.querySelector('dialog[open],.liquid-native-host [aria-expanded=true]')||root.querySelector(openControls)||
    win.innerWidth<=900&&root.querySelector('.layout-data-menu[open],.layout-actions-menu[open]');
  const busy=()=>doc.hidden||(signals&&(away||pressed))||scrolling||typing||pocket.inert||overlayOpen();
  const story=id=>root.querySelector('[data-news-record="'+win.CSS.escape(id)+'"]');
  const transform=p=>'translate3d('+p.x+'px,'+p.y+'px,0)';
  const live=(crew,version)=>wave===crew&&crew.version===version;
  function home() {
    const r=pocket.querySelector('.mascot-trigger').getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  }
  function layoutStamp(stops) {
    const target=home(),stamp=[target.x,target.y,root.scrollTop,win.innerWidth,win.innerHeight];
    stamp.push(win.location.pathname+win.location.search);
    const visible=stops??(signals?signalSources(root,courierWindow(root,pocket)):dataPatrolStops(root,pocket));
    for(const stop of visible||[]){
      const r=stop.rect;
      stamp.push(stop.id,stop.kind,r.left,r.top,r.right,r.bottom);
    }
    return stamp;
  }
  function schedule(delay=50) {
    if(events.signal.aborted||wave||starting||startTimer||busy()||(!pending&&reduced()))return;
    startTimer=win.setTimeout(start,delay);
  }
  function queueLayout() {
    if(!events.signal.aborted&&!layoutFrame)layoutFrame=win.requestAnimationFrame(()=>{layoutFrame=0;layout();});
  }
  function reaction(m,emoji='',side='above') {
    m.el.dataset.reactionSide=side==='above-left'?'left':side==='above-right'?'right':'center';
    m.bubble.textContent=emoji;m.bubble.hidden=!emoji;
  }
  function unmark(m) {m.pickup?.removeAttribute('data-news-pickup');m.pickup=null;}
  function freeze(crew,pause) {
    const hide=pause&&(scrolling||pocket.inert||Boolean(overlayOpen()));
    for(const m of crew.members)m.el.style.visibility=hide?'hidden':'';
    if(crew.paused===pause)return;
    const now=win.performance.now();
    if(pause)crew.pausedAt=now;
    else for(const m of crew.members)if(m.travel)m.travel.started+=now-crew.pausedAt;
    crew.paused=pause;
    for(const m of crew.members){
      m.el.toggleAttribute('data-paused',pause);
      if(m.animation){if(pause)m.animation.pause();else m.animation.play();}
    }
  }
  function interruptMotion(m) {
    // Commit the on-screen pose before cancelling. A resumed or recalled runner starts at this pixel.
    const r=m.el.getBoundingClientRect();m.position={x:r.left,y:r.top};m.el.style.transform=transform(m.position);
    const a=m.animation;m.animation=null;a?.cancel();
  }
  function clearWave() {
    const crew=wave;wave=null;
    win.clearTimeout(startTimer);startTimer=0;win.clearTimeout(retryTimer);retryTimer=0;
    if(!crew)return;
    for(const meeting of crew.meetings.values())meeting.finish(false);
    crew.rooms.clear();
    for(const m of crew.members){m.animation?.cancel();unmark(m);m.el.remove();}
    crew.members.clear();
  }
  async function playPath(crew,version,m,points,holdMs=0) {
    if(!live(crew,version))return false;
    const target=points.at(-1);let travel=0;
    const keys=points.map((p,i)=>{
      if(i)travel+=distance(points[i-1],p);
      return {transform:transform(p),offset:travel};
    });
    for(const [i,k] of keys.entries())k.offset=travel?k.offset/travel:i/(keys.length-1);
    const animation=m.el.animate(keys,{duration:holdMs||Math.max(16,travel*crew.pace),easing:'linear',fill:'both'});
    m.animation=animation;if(crew.paused)animation.pause();
    try{
      await animation.finished;
      if(!live(crew,version)||m.animation!==animation)return false;
      m.position=target;m.el.style.transform=transform(target);return true;
    }catch(error){
      if(error.name!=='AbortError')throw error;
      if(live(crew,version)&&m.animation===animation){recallRequested=true;queueLayout();}
      return false;
    }
    finally{if(m.animation===animation)m.animation=null;animation.cancel();}
  }
  const hold=(crew,version,m,ms)=>playPath(crew,version,m,[m.position,m.position],ms);
  async function walk(crew,version,m,points,phase) {
    m.el.dataset.phase=phase;
    if(!signals&&points.length)m.travel={path:same(m.position,points[0])?points:[m.position,...points],started:win.performance.now()};
    let leg=[m.position],facing=0;
    for(const p of points){
      const prev=leg.at(-1),dx=p.x-prev.x;
      if(distance(p,prev)<.3)continue;
      const direction=Math.abs(dx)>1?Math.sign(dx):0;
      if(direction&&facing&&direction!==facing){
        m.el.dataset.facing=facing<0?'left':'right';
        if(!await playPath(crew,version,m,leg))return false;
        leg=[prev];
      }
      if(direction)facing=direction;
      leg.push(p);
    }
    if(facing)m.el.dataset.facing=facing<0?'left':'right';
    return leg.length>1?playPath(crew,version,m,leg):live(crew,version);
  }
  async function talk(crew,version,meeting,first,second) {
    const [question,reply]=prompts[(crew.round+first.pass+Math.floor(first.index/2))%prompts.length];
    if(!await hold(crew,version,first,90))return;
    first.el.dataset.speaking='true';reaction(first,question,first.job.meeting.bubble);
    if(!await hold(crew,version,first,650))return;
    first.el.dataset.speaking='false';reaction(first);
    if(!await hold(crew,version,first,70))return;
    second.el.dataset.speaking='true';reaction(second,reply,second.job.meeting.bubble);
    if(!await hold(crew,version,second,690))return;
    second.el.dataset.speaking='false';reaction(second);
    if(!await hold(crew,version,first,100))return;
    meeting.finish(true);
  }
  function meet(crew,version,m) {
    const seat=m.job.meeting,key=Math.min(m.index,seat.partner);
    let meeting=crew.meetings.get(key);
    if(!meeting){meeting=gate();crew.meetings.set(key,meeting);}
    m.el.dataset.phase='wait-peer';m.el.dataset.facing=seat.facing;m.el.dataset.speaking='false';
    crew.atMeeting.set(m.index,m);
    const peer=crew.atMeeting.get(seat.partner);
    if(peer){
      const [first,second]=m.index<peer.index?[m,peer]:[peer,m];
      for(const party of [first,second]){party.el.dataset.phase='discuss';reaction(party);}
      monitor(crew,version,talk(crew,version,meeting,first,second));
    }else{
      const other=[...crew.members].find(person=>person.index===seat.partner);
      if(other){
        const r=other.el.getBoundingClientRect(),end=other.job.meeting.approach.at(-1);
        if(distance({x:r.left,y:r.top},end)*crew.pace>850)reaction(m,'👀',seat.bubble);
      }
    }
    return meeting.done;
  }
  function acknowledge(received=false) {
    const now=win.performance.now();if(!received&&now-lastWelcome<1300)return;
    lastWelcome=now;pocket.toggleAttribute('data-news-handoff',received);pocket.setAttribute('data-news-welcome','');
    win.clearTimeout(welcomeTimer);welcomeTimer=win.setTimeout(()=>{
      pocket.removeAttribute('data-news-welcome');pocket.removeAttribute('data-news-handoff');
    },received?560:330);
  }
  async function dock(crew,version,m) {
    let target=home();
    if(distance(m.position,target)>3){recallRequested=true;queueLayout();return;}
    if(!await walk(crew,version,m,[target],'return'))return;
    m.el.dataset.phase='dock';if(!m.carrying)acknowledge();
    if(!await hold(crew,version,m,360))return;
    target=home();
    if(distance(m.position,target)>3){recallRequested=true;queueLayout();return;}
    if(m.carrying&&m.item&&story(m.item.record_id)){
      m.carrying=false;delete m.el.dataset.carrying;onReceived(m.item);acknowledge(true);
    }
    m.el.remove();crew.members.delete(m);crew.waiting.delete(m);
    if(m.job.meeting&&!crew.recalling){
      const peer=m.job.meeting.partner;
      if(![...crew.members].some(other=>other.index===peer)){
        const key=Math.min(m.index,peer);
        crew.rooms.leave(key);crew.meetings.delete(key);crew.atMeeting.delete(m.index);crew.atMeeting.delete(peer);
        sendPair(crew,[key,Math.max(m.index,peer)],m.pass+1);
      }
    }
    finishEmpty(crew);
  }
  async function readSource(crew,version,m) {
    const {job}=m;
    const original=job.stop.row;
    const row=original.isConnected&&original.dataset.courierSource===job.stop.id?original:
      root.querySelector('[data-courier-source="'+win.CSS.escape(job.stop.id)+'"]');
    const r=row?.getBoundingClientRect(),p=m.position;
    const area=r?.width&&r.height&&readingArea(crew,{kind:job.stop.kind,edge:job.stop.edge,rect:r});
    const slack=signals?6:1;
    if(!area||p.x<area.l-slack||p.x>area.e+slack||p.y<area.top-slack||p.y>area.bottom+slack){
      recallRequested=true;queueLayout();return false;
    }
    if(!m.item&&job.stop.kind==='news'&&pending?.record_id===job.stop.id){
      m.item=pending;pending=null;m.el.dataset.job='delivery';
    }
    m.el.dataset.phase=m.item?'pickup':'inspect';
    if(m.item){
      if(!story(m.item.record_id)){
        recallRequested=true;queueLayout();return false;
      }
      m.carrying=true;m.el.dataset.carrying='true';m.pickup=row;m.pickup.setAttribute('data-news-pickup','');
    }
    if(job.inspectBubble&&(m.item||(m.index+crew.round+m.pass)%3===1)){
      const emoji=m.item?'🔎':sourceReactions[job.stop.kind]||(row.closest('.dc-release-schedule')?'🗓️':'👀');
      reaction(m,emoji,job.inspectBubble);
    }
    const readMs=m.bubble.hidden?340:550;
    if(!await hold(crew,version,m,readMs))return false;
    reaction(m);unmark(m);return true;
  }
  async function trip(crew,m) {
    const version=crew.version,{job}=m;
    if(!signals)m.travel={path:job.outbound,started:win.performance.now()+m.departure};
    if(m.departure&&!await hold(crew,version,m,m.departure))return;
    if(!await walk(crew,version,m,job.outbound,'out'))return;
    if(job.stop){
      if(!await readSource(crew,version,m))return;
    }else{
      m.el.dataset.phase='standby';
      if(!await hold(crew,version,m,220))return;
    }
    if(job.meeting){
      const pair=Math.min(m.index,job.meeting.partner);
      if(!await crew.rooms.arrive(pair,job.meeting.zone??pair)||!live(crew,version))return;
      if(!await walkInTurn(crew,version,m,job.meeting.approach,'to-meeting'))return;
      if(!await meet(crew,version,m)||!live(crew,version))return;
      if(m.index>job.meeting.partner&&!await hold(crew,version,m,240))return;
    }
    await returnToDock(crew,version,m,job.homeward);
  }
  function monitor(crew,version,work) {
    work.catch(error=>{
      if(!live(crew,version)||error.name==='AbortError')return;
      recallRequested=true;queueLayout();
    });
  }
  function newMember(crew,role,index,job,item,departure,pass=0) {
    const el=doc.createElement('div');
    el.className='news-courier';el.inert=true;el.setAttribute('aria-hidden','true');
    el.dataset.courierRole=String(role.id);el.dataset.phase='out';
    el.dataset.courierPage=scene;setJob(el,job,item);

    el.dataset.courierRound=pass?crew.round+'.'+pass:String(crew.round);
    el.dataset.courierPair=String(Math.min(index,job.meeting?.partner??index));
    el.style.setProperty('--agent-color',role.color);el.style.setProperty('--run-stride',(170+role.id%6*13)+'ms');
    el.style.transform=transform(crew.home);
    el.innerHTML='<span class="news-courier-figure">'+courierFigure+'</span><span class="news-courier-reaction" hidden></span>';
    doc.body.append(el);
    return {el,index,pass,role,job,item,departure,position:crew.home,animation:null,carrying:false,pickup:null,bubble:el.lastElementChild};
  }
  function setJob(el,job,item) {
    el.dataset.job=item?'delivery':job.stop?'patrol':'walk';
    if(signals&&job.stop)el.dataset.signalRecord=job.stop.id;else delete el.dataset.signalRecord;
    if(job.stop){el.dataset.courierTarget=job.stop.id;el.dataset.courierKind=job.stop.kind;}
    else{delete el.dataset.courierTarget;delete el.dataset.courierKind;}
  }
  function movingTraffic(crew,now,except=null) {
    const traffic=[];
    for(const m of crew.members){
      if(m!==except&&m.travel&&['out','to-meeting','return','yield'].includes(m.el.dataset.phase))
        traffic.push({path:m.travel.path,startsIn:m.travel.started-now});
    }
    return traffic;
  }
  async function walkInTurn(crew,version,m,path,phase,canWait=true) {
    if(!signals&&canWait){
      const now=win.performance.now(),traffic=movingTraffic(crew,now,m);
      if(traffic.length){
        const [start]=newsDepartureDelays([{outbound:path}],crew.pace,traffic,crew.home);
        if(start>50){
          m.travel={path,started:now+start};m.el.dataset.phase='yield';
          if(!await hold(crew,version,m,start))return false;
        }
      }
    }
    return walk(crew,version,m,path,phase);
  }
  async function returnToDock(crew,version,m,path,canWait=true) {
    if(await walkInTurn(crew,version,m,path,'return',canWait))await dock(crew,version,m);
  }
  function finishEmpty(crew){
    if(wave===crew&&!crew.members.size&&!crew.dispatches){wave=null;recallRequested=false;win.clearTimeout(retryTimer);retryTimer=0;schedule();}
  }
  function sendPair(crew,indexes,pass){
    const version=crew.version;
    crew.dispatches++;
    crew.dispatchQueue=crew.dispatchQueue.then(async()=>{
      if(!live(crew,version)||crew.recalling)return;
      const assignedStory=pending&&crew.jobs.some(job=>job.stop?.id===pending.record_id);
      if(!assignedStory){
        const floor=crew.floor;
        const next=await planner.compute('pair',floor,{jobs:routeJobs(crew.jobs),indexes,turn:crew.round+pass+indexes[0]});
        if(!next||!live(crew,version)||crew.recalling)return;
        withSourceNodes(next,floor).forEach((job,i)=>{crew.jobs[indexes[i]]=job;});
      }
      launchPair(crew,indexes,pass);
    }).catch(()=>{if(live(crew,version)){recallRequested=true;queueLayout();}}).finally(()=>{crew.dispatches--;finishEmpty(crew);});
  }
  function launchPair(crew,indexes,pass){
    const traffic=signals?[]:movingTraffic(crew,win.performance.now());
    const delays=newsDepartureDelays(indexes.map(i=>crew.jobs[i]),crew.pace,traffic);
    const occupied=new Set([...crew.members].map(m=>m.role.id));
    for(const [slot,index] of indexes.entries()){
      let role=newsRoster[roleIndex++%newsRoster.length];
      while(occupied.has(role.id))role=newsRoster[roleIndex++%newsRoster.length];
      occupied.add(role.id);
      const m=newMember(crew,role,index,crew.jobs[index],null,delays[slot],pass);
      crew.members.add(m);monitor(crew,crew.version,trip(crew,m));
    }
  }
  async function start() {
    startTimer=0;
    if(wave||events.signal.aborted||busy())return;
    if(doc.body.classList.contains('app-loading')){schedule(100);return;}
    if(reduced()){
      if(pending&&story(pending.record_id)){const item=pending;pending=null;onReceived(item);}
      return;
    }
    const floor=measureFloor(root,pocket);
    if(!floor){if(!signals)schedule(300);return;}
    const item=pending&&story(pending.record_id)?pending:null,width=win.innerWidth;
    const limit=width<600?6:width<1200?8:12;
    const pace=width<=900?3.45:2.65,stamp=layoutStamp(floor.stops);
    starting=true;
    let result;
    try{result=await planner.compute('plan',floor,{scene,limit,turn,recordId:item?.record_id,pace});}
    catch{starting=false;schedule(1500);return;}
    starting=false;
    if(!result||events.signal.aborted||wave)return;
    if(busy()||reduced()){queueLayout();return;}
    if(changedStamp(stamp,layoutStamp())){schedule();return;}
    const jobs=withSourceNodes(result.jobs,floor),departures=result.delays;
    if(!jobs.length){schedule(1200);return;}
    const crew={round:turn++,version:0,pace,jobs,floor,home:floor.home,bounds:floor.bounds,stamp,members:new Set(),waiting:new Set(),atMeeting:new Map(),meetings:new Map(),rooms:signalMeetingRooms(),recalling:false,paused:false,dispatches:0,dispatchQueue:Promise.resolve()};
    wave=crew;
    const roles=jobs.map(()=>newsRoster[roleIndex++%newsRoster.length]);
    jobs.forEach((job,i)=>{
      const article=i===0&&item&&job.stop?.id===item.record_id?item:null;
      if(article)pending=null;
      crew.members.add(newMember(crew,roles[(crew.round+i)%roles.length],i,job,article,departures[i]));
    });
    for(const m of crew.members)monitor(crew,crew.version,trip(crew,m));
  }
  function resetMeetings(crew) {
    crew.version++;crew.rooms.clear();
    for(const meeting of crew.meetings.values())meeting.finish(false);
    crew.meetings.clear();crew.atMeeting.clear();crew.waiting.clear();
    win.clearTimeout(retryTimer);retryTimer=0;
  }
  function routesStillFit(crew,floor) {
    if(distance(crew.home,floor.home)>3)return false;
    const byId=new Map(floor.stops.map(stop=>[stop.id,stop]));
    for(const job of crew.jobs){
      if(job.stop){
        const stop=byId.get(job.stop.id),at=job.outbound.at(-1);
        if(!stop)return false;
        const area=readingArea(floor,stop);
        if(at.x<area.l-1||at.x>area.e+1||at.y<area.top-1||at.y>area.bottom+1)return false;
      }else if(byId.size)return false;
      for(const path of [job.outbound,job.meeting?.approach,job.homeward]){
        if(path?.some((point,i)=>i>0&&!clearSegment(path[i-1],point,floor.ink)))return false;
      }
    }
    return true;
  }
  async function continueOnReflow(crew,floor,stamp,force,generation) {
    if(!floor)return false;
    if(crew.recalling){
      if(distance(crew.home,floor.home)>3||crew.waiting.size)return false;
      const safe=[...crew.members].every(m=>m.returnPath?.every((point,i,path)=>!i||clearSegment(path[i-1],point,floor.ink)));
      if(safe)crew.stamp=stamp;
      return safe;
    }
    if(!force&&routesStillFit(crew,floor)){crew.floor=floor;crew.stamp=stamp;return true;}
    const people=[...crew.members].sort((a,b)=>a.index-b.index);
    if(people.length!==crew.jobs.length||people.some(m=>m.carrying||m.job.stop&&m.el.dataset.phase!=='out'))return false;
    const item=pending||people.find(m=>m.item)?.item;
    const version=crew.version;
    freeze(crew,true);
    const starts=people.map(m=>{
      const r=m.el.getBoundingClientRect(),at={x:r.left,y:r.top};
      return m.el.dataset.phase==='out'&&distance(at,crew.home)<18?null:at;
    });
    const planned=await planner.compute('plan',floor,{scene,limit:people.length,turn,recordId:item?.record_id,pace:crew.pace,starts});
    if(!planned||!live(crew,version)||generation!==layoutVersion)return true;
    const jobs=withSourceNodes(planned.jobs,floor),paths=planned.redirects;
    freeze(crew,Boolean(busy()));
    if(jobs.length!==people.length||paths.some(path=>!path))return false;
    resetMeetings(crew);
    crew.home=floor.home;crew.bounds=floor.bounds;crew.floor=floor;crew.jobs=jobs;crew.stamp=stamp;
    const delays=planned.delays;pending=item||null;
    for(const m of people){
      const job=jobs[m.index],start=starts[m.index]||floor.home;
      interruptMotion(m);reaction(m);unmark(m);delete m.el.dataset.speaking;
      m.job={...job,outbound:paths[m.index]};m.position=start;m.el.style.transform=transform(start);
      m.departure=start===floor.home?delays[m.index]:0;
      m.item=pending&&job.stop?.id===pending.record_id?pending:null;if(m.item)pending=null;
      setJob(m.el,job,m.item);m.el.dataset.courierPair=String(Math.min(m.index,job.meeting?.partner??m.index));
      m.el.dataset.phase='out';monitor(crew,crew.version,trip(crew,m));
    }
    return true;
  }
  async function sendHome(crew,floor,people){
    const version=crew.version;
    const paths=floor&&await planner.compute('returns',floor,{starts:people.map(m=>m.position)});
    if(!live(crew,version))return;
    people.forEach((m,i)=>dispatchHome(crew,floor,m,paths?.[i]));
    retryWaiting(crew);
  }
  function dispatchHome(crew,floor,m,path){
    m.returnPath=path;
    if(!path?.length){crew.waiting.add(m);m.el.dataset.phase='wait-route';return;}
    crew.waiting.delete(m);
    const version=crew.version;
    // Leave immediately if a scroll has placed a control or label underfoot.
    const canWait=inside(m.position,floor.bounds)&&!floor.obstacles.some(r=>inside(m.position,r));
    monitor(crew,version,returnToDock(crew,version,m,path,canWait));
  }
  function retryWaiting(crew) {
    if(!crew.waiting.size||retryTimer||crew.paused)return;
    retryTimer=win.setTimeout(()=>{
      retryTimer=0;if(wave!==crew||busy())return;
      const floor=measureFloor(root,pocket);
      monitor(crew,crew.version,sendHome(crew,floor,[...crew.waiting]));
    },850);
  }
  function recall(crew,stamp,floor) {
    resetMeetings(crew);crew.recalling=true;crew.stamp=stamp;
    if(floor)crew.home=floor.home;
    for(const m of crew.members){
      interruptMotion(m);m.travel=null;reaction(m);unmark(m);delete m.el.dataset.speaking;
      if(m.item&&!m.carrying){pending??=m.item;m.item=null;m.el.dataset.job='patrol';}
    }
    monitor(crew,crew.version,sendHome(crew,floor,[...crew.members]));
  }
  async function layout() {
    if(events.signal.aborted)return;
    if(feedSize){
      const feed=root.querySelector(signals?'.sig-workspace,.biz-op-layout':'.dc-root');
      if(feed!==observedFeed){
        feedSize.disconnect();observedFeed=feed;
        if(feed)feedSize.observe(feed);
      }
    }
    if(reduced()){
      if(wave){
        const courier=[...wave.members].find(m=>m.item);
        pending??=courier?.item;clearWave();recallRequested=false;
      }
      if(pending)schedule(80);
      return;
    }
    if(!wave){schedule();return;}
    const pause=Boolean(busy());freeze(wave,pause||Boolean(wave.updating));
    if(pause)return;
    const stamp=layoutStamp(),moved=changedStamp(stamp,wave.stamp);
    if(recallRequested||moved){
      const crew=wave,force=recallRequested;recallRequested=false;
      if(!force&&crew.updating&&!changedStamp(stamp,crew.updating))return;
      const generation=++layoutVersion;crew.updating=stamp;
      const sameView=stamp.slice(2,6).every((value,i)=>value===crew.stamp[i+2]);
      const floor=measureFloor(root,pocket);
      try{
        if(sameView&&await continueOnReflow(crew,floor,stamp,force,generation))return;
        if(crew===wave&&generation===layoutVersion)recall(crew,stamp,floor);
      }finally{
        if(generation===layoutVersion){crew.updating=null;if(crew===wave)freeze(crew,Boolean(busy()));}
      }
    }
    else retryWaiting(wave);
  }
  function afterScroll() {
    scrolling=true;if(wave)freeze(wave,true);win.clearTimeout(scrollTimer);
    scrollTimer=win.setTimeout(()=>{scrolling=false;queueLayout();},140);
  }
  doc.addEventListener('scroll',afterScroll,options);
  doc.addEventListener('pointerdown',()=>{if(signals){pressed=true;if(wave)freeze(wave,true);}},options);
  for(const type of ['pointerup','pointercancel'])win.addEventListener(type,()=>{pressed=false;queueLayout();},options);
  for(const type of ['focusin','focusout','beforetoggle','toggle','close','visibilitychange'])doc.addEventListener(type,queueLayout,options);
  doc.addEventListener('visibilitychange',()=>{if(doc.hidden&&wave)freeze(wave,true);},options);
  root.addEventListener('input',event=>{
    if(!event.target.matches(signals?'#sig-search':'input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]'))return;
    typing=true;if(wave)freeze(wave,true);win.clearTimeout(typingTimer);
    typingTimer=win.setTimeout(()=>{typing=false;queueLayout();},400);
  },options);
  win.addEventListener('blur',()=>{pressed=false;if(signals){away=true;if(wave)freeze(wave,true);}},options);
  win.addEventListener('focus',()=>{away=false;queueLayout();},options);
  win.addEventListener('resize',afterScroll,options);
  win.visualViewport?.addEventListener('resize',afterScroll,options);
  motion.addEventListener('change',queueLayout,options);
  const observer=new win.MutationObserver(records=>{
    if(!wave||records.some(r=>r.type==='attributes'||r.target===root||!root.contains(r.target)||
      r.target.closest?.('[data-hub-feed]')||wave.jobs[0]?.mode==='walk'&&r.target.matches?.('[data-hub-price],.dc-stat strong,.chart-readout dd')||
      r.target.nodeName!=='svg'&&[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&n.namespaceURI!=='http://www.w3.org/2000/svg')))queueLayout();
  });
  observer.observe(pocket,{attributes:true,attributeFilter:['style','data-avoidance','class','inert']});
  observer.observe(doc.documentElement,{attributes:true,attributeFilter:['data-reduced-motion']});
  observer.observe(root,signals?{childList:true,subtree:true,attributes:true,attributeFilter:['data-track-record','aria-current','aria-pressed','open']}:{childList:true,subtree:true,attributes:true,attributeFilter:['data-chart-ready','data-visible-count','data-public-data']});
  layout();
  return {
    offer(item){
      if(!item||pending?.record_id===item.record_id)return;
      pending=item;
      if(wave&&!wave.jobs.some(job=>job.stop?.id===item.record_id)&&dataPatrolStops(root,pocket).some(stop=>stop.id===item.record_id)){
        recallRequested=true;queueLayout();
      }else schedule(90);
    },
    replay(item){
      if(!item)return;
      const existing=wave&&[...wave.members].some(m=>m.item?.record_id===item.record_id);
      if(!existing){pending=item;recallRequested=Boolean(wave);}
      const viewport=root.getBoundingClientRect(),primary=story(item.record_id);
      const copy=root.querySelector('[data-news-copy="'+win.CSS.escape(item.record_id)+'"]');
      const visible=[primary?.querySelector('time'),copy].some(el=>{const r=el?.getBoundingClientRect();return r?.width&&r.top>viewport.top+24&&r.bottom<viewport.bottom-24;});
      if(!visible)primary?.scrollIntoView({block:'center',behavior:'instant'});
      queueLayout();
    },
    layout:queueLayout,
    dispose(){
      events.abort();planner.dispose();observer.disconnect();feedSize?.disconnect();win.cancelAnimationFrame(layoutFrame);win.clearTimeout(scrollTimer);win.clearTimeout(typingTimer);
      win.clearTimeout(welcomeTimer);pocket.removeAttribute('data-news-welcome');pocket.removeAttribute('data-news-handoff');pending=null;clearWave();
    }
  };
}
