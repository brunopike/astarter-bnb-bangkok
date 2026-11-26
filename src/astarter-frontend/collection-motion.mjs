import {RESEARCH_GROUPS} from './multi-research.mjs';

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
  return {doc,win,viewport,home,anchor:h,compact,px,py,bounds};
}

const signalSolid=[controls,'.as-search','.liquid-native-host','.sig-filter-body','.sig-preferences-panel','.pw-trackbar','.layout-navigation-row','.sig-stats-chart-panel',
  '.sig-card-spark','.sig-detail-chart','svg','canvas','img','[role=img]'].join(',');
const signalHidden='[hidden],.sr-only,.visually-hidden,script,style,template,noscript,option';

function clippedBox(rect,clip) {
  const left=Math.max(rect.left,clip.left),right=Math.min(rect.right,clip.right);
  const top=Math.max(rect.top,clip.top),bottom=Math.min(rect.bottom,clip.bottom);
  return right>left&&bottom>top?{left,right,top,bottom,width:right-left,height:bottom-top}:null;
}

function measuredFloor(root,frame,stops,solid) {
  const {doc,win,home,anchor,compact,px,py,bounds,viewport}=frame;
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
    const style=win.getComputedStyle(el);
    if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return;
    const r=el.getBoundingClientRect();
    if(el.matches('article,aside')&&!clippedBox(r,clip))return;
    if(el.matches(solid)){protect(r,clip);return;}
    if(style.overflowX!=='visible'||style.overflowY!=='visible'){
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

export function measureSignalFloor(root,pocket) {
  const feed=root.querySelector('.sig-tracking .sig-feed');
  if(!feed)return null;
  const frame=courierWindow(root,pocket),viewport=frame.viewport;
  const stops=[],ids=new Set();
  for(const row of feed.querySelectorAll('article[data-track-record]')){
    const id=row.dataset.trackRecord,rect=clippedBox(row.getBoundingClientRect(),viewport);
    if(!id||ids.has(id)||!rect||rect.height<24||rect.width<36)continue;
    ids.add(id);
    const time=row.querySelector('time');
    const stamp=time&&clippedBox(time.getBoundingClientRect(),rect);
    stops.push({id,row,rect,stamp,kind:'signal'});
  }

  return measuredFloor(root,frame,stops,signalSolid);
}


const dataSolid=[signalSolid,'.chart-canvas','[data-hub-plot]','.hub-breadth'].join(',');
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
  ['.dc-table tbody>tr:not([data-hub-row])','row',(el,row,scope)=>{
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

function visibleStops(root,frame,{area,scope,live}) {
  const {win,viewport}=frame,clips=new WeakMap(),byId=new Map(),panels=[...area.querySelectorAll('.dc-panel')];
  const tables=[...area.querySelectorAll('.dc-table')];
  // Tables, media strips and dropdowns scroll independently of the main page.
  function contentClip(el) {
    if(!el||el===root.parentElement)return viewport;
    if(clips.has(el))return clips.get(el);
    const parent=el.parentElement,s=win.getComputedStyle(el);
    let clip=el.hidden||s.display==='none'||s.visibility==='hidden'||s.opacity==='0'||parent?.tagName==='DETAILS'&&!parent.open&&el.tagName!=='SUMMARY'?null:contentClip(parent);
    if(clip&&(s.overflowX!=='visible'||s.overflowY!=='visible')){
      const r=el.getBoundingClientRect();
      const inner={left:r.left+(el.clientLeft||0),top:r.top+(el.clientTop||0)};
      inner.right=inner.left+(el.clientWidth||r.width);inner.bottom=inner.top+(el.clientHeight||r.height);
      clip=clippedBox({left:s.overflowX==='visible'?clip.left:inner.left,right:s.overflowX==='visible'?clip.right:inner.right,
        top:s.overflowY==='visible'?clip.top:inner.top,bottom:s.overflowY==='visible'?clip.bottom:inner.bottom},clip);
    }
    clips.set(el,clip);return clip;
  }
  const range=root.ownerDocument.createRange();
  for(const el of live?area.querySelectorAll(dataStations):[]){
    const row=el.hasAttribute('data-news-copy')?el.parentElement:el,clip=contentClip(row);
    if(!clip)continue;
    const rect=clippedBox(row.getBoundingClientRect(),clip);
    if(!rect||rect.height<16||rect.width<24)continue;
    const [,kind,identify]=dataStationTypes.find(([selector])=>el.matches(selector));
    const key=identify(el,row,scope);
    if(!key)continue;
    const table=kind==='row'?tables.indexOf(el.closest('.dc-table')):null;
    if(kind==='row'){
      // Scrolling a published observation out of view can expose only dashes.
      // The sticky date or rank alone is insufficient to make that a station.
      const cells=Array.from(el.cells).slice(1);
      const schedule=scope.startsWith('intelligence:')&&officialLink(el);
      if(!cells.some(cell=>{
        if(!clippedBox(cell.getBoundingClientRect(),rect)||!tableObservation(cell.textContent)&&!(schedule&&cell===cells[1]))return false;
        range.selectNodeContents(cell);return [...range.getClientRects()].some(r=>clippedBox(r,rect));
      }))continue;
    }
    const section=kind==='stat'?panels.indexOf(el.closest('.dc-panel')):table;
    const id=kind==='news'?key:[scope,kind,...(section==null?[]:[section]),key].join(':');
    const time=row.querySelector('time'),stamp=time&&clippedBox(time.getBoundingClientRect(),rect);
    const previous=byId.get(id);
    // Prefer the full article when its timestamp is readable. A visible side
    // copy still works when the primary article is outside the viewport.
    if(!previous||kind==='news'&&(Number(Boolean(stamp))*2+Number(el.hasAttribute('data-news-record'))>
      Number(Boolean(previous.stamp))*2+Number(previous.row.hasAttribute('data-news-record'))))
      byId.set(id,{id,row,rect,stamp,kind});
  }
  const stops=[...byId.values()],old=annotatedSources.get(root),active=new Set();
  for(const stop of stops){active.add(stop.row);if(stop.row.dataset.courierSource!==stop.id)stop.row.dataset.courierSource=stop.id;}
  if(old)for(const row of old)if(!active.has(row))delete row.dataset.courierSource;
  annotatedSources.set(root,active);
  return stops;
}

export function dataPatrolStops(root,pocket) {
  const context=sourceContext(root);
  return context?visibleStops(root,courierWindow(root,pocket),context):[];
}

export function measureDataFloor(root,pocket) {
  const context=sourceContext(root);
  if(!context)return null;
  const frame=courierWindow(root,pocket);
  return measuredFloor(root,frame,visibleStops(root,frame,context),dataSolid);
}


const floorGraphs=new WeakMap();
const inside=(p,r)=>p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const same=(a,b)=>a.x===b.x&&a.y===b.y;
const overlaps=(a,b)=>a.left<=b.right&&a.right>=b.left&&a.top<=b.bottom&&a.bottom>=b.top;

function clearSegment(a,b,rects) {
  const dx=b.x-a.x,dy=b.y-a.y;
  const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
  for(const r of rects) {
    if(right<r.left||left>r.right||bottom<r.top||top>r.bottom)continue;
    if(!dx||!dy)return false;
    const x1=(r.left-a.x)/dx,x2=(r.right-a.x)/dx,y1=(r.top-a.y)/dy,y2=(r.bottom-a.y)/dy;
    if(Math.max(0,Math.min(x1,x2),Math.min(y1,y2))<=Math.min(1,Math.max(x1,x2),Math.max(y1,y2)))return false;
  }
  return true;
}

// Ease around bends only where a little arc fits the measured aisle.
function roundBends(points,blocks) {
  if(points.length<3)return points;
  const result=[points[0]];
  for(let i=1;i<points.length-1;i++){
    const a=points[i-1],b=points[i],c=points[i+1],ab=distance(a,b),bc=distance(b,c);
    const radius=Math.min(18,ab/4,bc/4);
    if(radius<3){result.push(b);continue;}
    const entry={x:b.x+(a.x-b.x)*radius/ab,y:b.y+(a.y-b.y)*radius/ab};
    const exit={x:b.x+(c.x-b.x)*radius/bc,y:b.y+(c.y-b.y)*radius/bc};
    const mid={x:(entry.x+2*b.x+exit.x)/4,y:(entry.y+2*b.y+exit.y)/4};
    if(clearSegment(entry,mid,blocks)&&clearSegment(mid,exit,blocks))result.push(entry,mid,exit);
    else result.push(b);
  }
  result.push(points.at(-1));return result;
}

function lowerBound(axis,n) {
  let lo=0,hi=axis.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(axis[mid]<n)lo=mid+1;else hi=mid;}
  return lo;
}

// Route on measured aisles. Include both sides of every label and control so a slim
// phone gutter is reachable even if it falls between the ordinary grid samples.
function buildFloorGraph(floor) {
  const {home,bounds,obstacles}=floor, ink=floor.ink||obstacles;
  const blocks=[];
  for(const [i,r] of obstacles.entries()){
    if(!overlaps(r,bounds))continue;
    if(!inside(home,r)||!floor.ink||inside(home,ink[i])){blocks.push(r);continue;}
    // A companion can settle just inside the padding around a control. Its own
    // footprint is a doorway; the underlying control itself remains protected.
    const door={left:home.x-15,right:home.x+15,top:home.y-15,bottom:home.y+15};
    if(r.left<door.left)blocks.push({...r,right:door.left});
    if(r.right>door.right)blocks.push({...r,left:door.right});
    if(r.top<door.top)blocks.push({...r,bottom:door.top});
    if(r.bottom>door.bottom)blocks.push({...r,top:door.bottom});
    blocks.push(ink[i]);
  }
  function axis(lo,hi,start,min,max) {
    const values=new Set([lo,hi,start]);
    for(let v=lo+18;v<hi;v+=18)values.add(v);
    const add=v=>{if(v>lo&&v<hi)values.add(v);};
    for(const r of blocks){
      add(Math.floor(r[min]-.75));add(Math.ceil(r[max]+.75));
      if(r[max]-r[min]<18)add((r[min]+r[max])/2);
    }
    return [...values].sort((a,b)=>a-b);
  }
  const xs=axis(bounds.left,bounds.right,home.x,'left','right'),ys=axis(bounds.top,bounds.bottom,home.y,'top','bottom');
  const w=xs.length,h=ys.length,size=w*h,stride=w+1;
  const coverage=new Int32Array((h+1)*stride),blocked=new Uint8Array(size);
  for(const r of blocks){
    const l=lowerBound(xs,r.left),e=lowerBound(xs,r.right+1e-6),t=lowerBound(ys,r.top),b=lowerBound(ys,r.bottom+1e-6);
    coverage[t*stride+l]++;coverage[t*stride+e]--;coverage[b*stride+l]--;coverage[b*stride+e]++;
  }
  for(let y=0;y<h;y++){
    let line=0;
    for(let x=0;x<w;x++){const i=y*stride+x;line+=coverage[i];coverage[i]=line+(y?coverage[i-stride]:0);blocked[y*w+x]=coverage[i]>0;}
  }
  const base=lowerBound(ys,home.y)*w+lowerBound(xs,home.x),queue=new Int32Array(size),trees=new Map();
  function tree(seed){
    if(trees.has(seed))return trees.get(seed);
    const parents=new Int32Array(size);parents.fill(-1);
    let head=0,end=0;
    if(!blocked[seed]){parents[seed]=seed;queue[end++]=seed;}
    function add(i,previous){if(!blocked[i]&&parents[i]===-1){parents[i]=previous;queue[end++]=i;}}
    while(head<end){
      const i=queue[head++],x=i%w;
      if(x>0)add(i-1,i);if(x<w-1)add(i+1,i);
      if(i>=w)add(i-w,i);if(i<(h-1)*w)add(i+w,i);
    }
    trees.set(seed,parents);return parents;
  }
  const connected=tree(base),point=i=>({x:xs[i%w],y:ys[Math.floor(i/w)]});
  function closest(p,range=28,allowed=blocks){
    let best=-1,radius=range+.001;
    const xl=lowerBound(xs,p.x-range),xr=lowerBound(xs,p.x+range+.001);
    const yt=lowerBound(ys,p.y-range),yb=lowerBound(ys,p.y+range+.001);
    for(let y=yt;y<yb;y++)for(let x=xl;x<xr;x++){
      const i=y*w+x;if(connected[i]===-1)continue;
      const q={x:xs[x],y:ys[y]},d=distance(p,q);
      if(d<radius&&clearSegment(p,q,allowed)){best=i;radius=d;if(d===0)return i;}
    }
    return best;
  }
  function route(from,to) {
    if(!inside(from,bounds)||!inside(to,bounds))return null;
    if(clearSegment(from,to,blocks))return [from,to];
    const first=closest(from),last=closest(to);
    if(first<0||last<0)return null;
    const parents=tree(last);
    if(parents[first]<0)return null;
    const line=[point(first)];
    let at=first,prior=0;
    while(at!==last){
      const next=parents[at],delta=next-at;
      if(prior&&prior!==delta)line.push(point(at));
      prior=delta;at=next;
    }
    if(!same(line.at(-1),point(last)))line.push(point(last));
    if(!same(line.at(-1),to))line.push(to);
    const result=[from];
    for(let i=0;i<line.length;){
      let next=line.length-1;
      while(next>i&&!clearSegment(result.at(-1),line[next],blocks))next--;
      if(!same(result.at(-1),line[next]))result.push(line[next]);
      i=next+1;
    }
    return result.length===1?[from,to]:roundBends(result,blocks);
  }
  function recall(from) {
    if(!inside(from,bounds)){
      // A viewport shrink can leave a visible runner's old coordinates outside
      // the new frame. Keep its position, walk along the exterior, then enter
      // at the nearest open point on that same edge.
      const entries=[];
      function edge(i,vertical){
        if(connected[i]<0)return;
        const p=point(i),approach=vertical?{x:from.x,y:p.y}:{x:p.x,y:from.y};
        if(!clearSegment(approach,p,blocks))return;
        entries.push({p,approach,travel:distance(from,approach)+distance(approach,p)});
      }
      if(from.x<bounds.left||from.x>bounds.right){
        const x=from.x<bounds.left?0:w-1;for(let y=0;y<h;y++)edge(y*w+x,true);
      }
      if(from.y<bounds.top||from.y>bounds.bottom){
        const y=from.y<bounds.top?0:h-1;for(let x=0;x<w;x++)edge(y*w+x,false);
      }
      entries.sort((a,b)=>a.travel-b.travel);
      const entry=entries[0];if(!entry)return null;
      const rest=route(entry.p,home);if(!rest)return null;
      return same(from,entry.approach)?[from,...rest]:[from,entry.approach,...rest];
    }
    if(!blocks.some(r=>inside(from,r)))return route(from,home);
    // Only an interrupted walk may begin underneath newly laid-out text.
    // A straight exit through the origin's convex boxes can leave each box
    // only once. Every other label/control remains forbidden on that step.
    const exit=[...blocks.filter(r=>!inside(from,r)),...ink.filter(r=>!inside(from,r))];
    let index=-1;
    for(const radius of [32,64,128]){
      index=closest(from,radius,exit);if(index>=0)break;
    }
    if(index<0)return null;
    const p=point(index),rest=route(p,home);
    return rest?[from,...rest]:null;
  }
  return {bounds,home,xs,ys,w,connected,point,blocks,ink,route,recall};
}

function floorGraph(floor) {
  let graph=floorGraphs.get(floor);
  if(!graph){graph=buildFloorGraph(floor);floorGraphs.set(floor,graph);}
  return graph;
}

// A scroll can place a runner inside an island of otherwise safe whitespace.
// Use smaller margins only until it rejoins the normal connected aisles.
const recallGraphs=new WeakMap();
function narrowRecallGraph(floor,xScale,yScale) {
  let variants=recallGraphs.get(floor);
  if(!variants){variants=new Map();recallGraphs.set(floor,variants);}
  const key=xScale+','+yScale;
  if(!variants.has(key)){
    const obstacles=floor.ink.map((r,i)=>{
      const pad=floor.obstacles[i];
      return {left:r.left+(pad.left-r.left)*xScale,right:r.right+(pad.right-r.right)*xScale,
        top:r.top+(pad.top-r.top)*yScale,bottom:r.bottom+(pad.bottom-r.bottom)*yScale};
    });
    variants.set(key,buildFloorGraph({...floor,obstacles}));
  }
  return variants.get(key);
}

function rejoinAisle(graph,walk) {
  const prefix=[walk[0]];
  let traveled=0;
  for(let i=1;i<walk.length;i++){
    const a=walk[i-1],b=walk[i],span=distance(a,b),steps=Math.max(1,Math.ceil(span/8));
    for(let step=1;step<=steps;step++){
      const t=step/steps,at={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
      if(graph.blocks.some(r=>inside(at,r)))continue;
      const rest=graph.route(at,graph.home);
      if(rest)return {path:[...prefix,...rest],narrow:traveled+t*span};
    }
    traveled+=span;prefix.push(b);
  }
  return {path:walk,narrow:traveled};
}

function returnThroughGap(floor,graph,from) {
  // First preserve the largest body margin the measured gap allows. Keep
  // full clearance on either axis when possible and leave the gap promptly.
  for(const scale of [.75,.5,.3,.12,0]){
    const tight=narrowRecallGraph(floor,scale,scale).recall(from);
    if(!tight)continue;
    let best=null;
    for(const [x,y] of [[1,scale],[scale,1]]){
      const walk=narrowRecallGraph(floor,x,y).recall(from);
      if(!walk)continue;
      const route=rejoinAisle(graph,walk);
      if(!best||route.narrow<best.narrow)best=route;
    }
    return best?.path||rejoinAisle(graph,tight).path;
  }
  return null;
}

export function newsReturnPath(floor,from) {
  if(!floor)return null;
  const graph=floorGraph(floor),ordinary=graph.recall(from);
  if(!floor.ink?.length||floor.ink.length!==floor.obstacles.length)return ordinary;
  const originInk=floor.ink.filter(r=>inside(from,r));
  if(!originInk.length)return ordinary||returnThroughGap(floor,graph,from);

  // A freshly moved label can paint over a runner. Step across its nearest
  // reachable edge before turning, so the runner never walks along that text.
  const exits=[];
  for(const r of originInk){
    exits.push({x:r.left-1,y:from.y},{x:r.right+1,y:from.y},{x:from.x,y:r.top-1},{x:from.x,y:r.bottom+1});
    for(const x of [r.left-1,r.right+1])for(const y of [r.top-1,r.bottom+1])exits.push({x,y});
  }
  const otherInk=floor.ink.filter(r=>!originInk.includes(r));
  exits.sort((a,b)=>distance(from,a)-distance(from,b));
  for(const at of exits){
    if(!inside(at,graph.bounds)||originInk.some(r=>inside(at,r))||!clearSegment(from,at,otherInk))continue;
    const rest=graph.recall(at)||returnThroughGap(floor,graph,at);
    if(rest)return [from,...rest];
  }
  return ordinary||returnThroughGap(floor,graph,from);
}

function bubbleBox(floor,p,side){
  const compact=floor.compact??(floor.bounds.right-floor.bounds.left<880),width=compact?24:26,top=compact?41:45;
  const x=p.x+(side==='above-left'?-6:side==='above-right'?6:0);
  return {left:x-width/2-1,right:x+width/2+1,top:p.y-top-1,bottom:p.y-top+(compact?22:24)+4};
}
function bubblePlace(floor,graph,p,first='above') {
  for(const side of new Set([first,'above','above-left','above-right'])){
    const bubble=bubbleBox(floor,p,side);
    if(bubble.left<floor.bounds.left-7||bubble.right>floor.bounds.right+7||bubble.top<floor.bounds.top-10)continue;
    if(!graph.ink.some(r=>overlaps(bubble,r)))return side;
  }
  return null;
}

function readingArea(graph,stop) {
  const {bounds}=graph,r=stop.rect,rx=stop.kind==='signal'?10:stop.kind?20:12,ry=stop.kind==='signal'?10:stop.kind?22:13;
  return {l:Math.max(bounds.left,r.left-rx),e:Math.min(bounds.right,r.right+rx),
    top:Math.max(bounds.top,r.top-ry),bottom:Math.min(bounds.bottom,r.bottom+ry)};
}

function sourcePort(graph,stop,used,variation,spacing) {
  const {home,xs,ys,w,connected}=graph,t=stop.stamp,{l,e,top,bottom}=readingArea(graph,stop);
  if(e<=l||bottom<=top)return null;
  const level=t?Math.max(top,Math.min(bottom,t.top+t.height/2)):top+(bottom-top)*.43;
  const hints=[{x:t?t.right+25:l+(e-l)*.32,y:level},{x:e-16,y:level},{x:l+16,y:top+16},
    {x:l+(e-l)*.55,y:bottom-14},{x:e-17,y:bottom-17},{x:l+(e-l)*.65,y:top+17}];
  const preferred=hints[variation%hints.length];
  let best=null,score=Infinity;
  const x0=lowerBound(xs,l),x1=lowerBound(xs,e+.01),y0=lowerBound(ys,top),y1=lowerBound(ys,bottom+.01);
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=y*w+x;if(connected[i]<0)continue;
    const p={x:xs[x],y:ys[y]},cost=Math.abs(p.x-preferred.x)+1.6*Math.abs(p.y-preferred.y);
    if(cost>=score||distance(p,home)<42||used.some(q=>distance(p,q)<spacing))continue;
    best=p;score=cost;
  }
  return best;
}

function meetingSeats(floor,graph,jobs,occupied=[],atSource=false,readerClearance=36,protectPair=false,accept=null) {
  const {xs,ys,w,connected,home}=graph,separation=(floor.compact??(floor.bounds.right-floor.bounds.left<880))?36:40;
  const [a,b]=jobs.slice(0,2).map(job=>job.outbound.at(-1));
  const target={x:(a.x+b.x+home.x)/3-separation/2,y:(a.y+b.y+home.y)/3};
  const candidates=[],step=atSource?0:7,dockClearance=atSource?36:48;
  const sourceClearance=protectPair?readerClearance:atSource?0:24;
  // A meeting needs a broad pocket, so sample coarsely and then test the exact
  // two body positions and independent speech-bubble rectangles inside it.
  let lastY=-Infinity;
  for(let y=0;y<ys.length;y++){
    if(ys[y]-lastY<step)continue;lastY=ys[y];
    let lastX=-Infinity;
    for(let x=0;x<xs.length&&xs[x]+separation<=floor.bounds.right;x++){
      if(xs[x]-lastX<step)continue;lastX=xs[x];
      const index=y*w+x;if(connected[index]<0)continue;
      const p={x:xs[x],y:ys[y]},q={x:p.x+separation,y:p.y};
      if(distance(p,home)<dockClearance||distance(q,home)<dockClearance)continue;
      if(sourceClearance&&[a,b].some(s=>distance(s,p)<sourceClearance||distance(s,q)<sourceClearance))continue;
      candidates.push({p,q,score:distance(p,target)});
    }
  }
  candidates.sort((a,b)=>a.score-b.score);
  for(const {p,q} of candidates){
    if(!clearSegment(p,q,graph.blocks))continue;
    if(jobs.slice(2).some(job=>distance(job.outbound.at(-1),p)<readerClearance||distance(job.outbound.at(-1),q)<readerClearance))continue;
    if(occupied.some(at=>distance(at,p)<48||distance(at,q)<48))continue;
    const left=bubblePlace(floor,graph,p,'above-left'),right=bubblePlace(floor,graph,q,'above-right');
    if(!left||!right||overlaps(bubbleBox(floor,p,left),bubbleBox(floor,q,right)))continue;
    const seats=[{at:p,bubble:left,facing:'right'},{at:q,bubble:right,facing:'left'}];
    if(!accept||accept(seats))return seats;
  }
  return null;
}

function readingJob(floor,graph,stop,target) {
  const outbound=graph.route(floor.home,target);
  return outbound?{stop,outbound,homeward:[...outbound].reverse(),inspectBubble:bubblePlace(floor,graph,target)}:null;
}

function sourceJob(floor,graph,stop,used,variation,spacing=38) {
  const target=sourcePort(graph,stop,used,variation,spacing),job=target&&readingJob(floor,graph,stop,target);
  if(job)used.push(target);
  return job;
}

// A short phone can show a single strip of a card. Reserve physical room for
// speakers first, then spread the remaining readers over that strip and its rim.
function singleCardPocket(floor,graph,jobs,count,turn) {
  const stop=jobs[0].stop,{l,e,top,bottom}=readingArea(graph,stop),points=[];
  const {xs,ys,w,connected}=graph;
  const x1=lowerBound(xs,e+.01),y1=lowerBound(ys,bottom+.01);
  for(let y=lowerBound(ys,top);y<y1;y++)for(let x=lowerBound(xs,l);x<x1;x++){
    const i=y*w+x;
    if(connected[i]>=0){const at=graph.point(i);if(distance(floor.home,at)>=42)points.push(at);}
  }
  if(points.length<count)return null;
  const corners=[{x:l,y:top},{x:e,y:bottom},{x:l,y:bottom},{x:e,y:top}],tried=[];
  let chosen;
  const seats=meetingSeats(floor,graph,jobs.slice(0,2),[],true,27,false,pair=>{
    const [a,b]=pair.map(seat=>seat.at);
    if(tried.some(p=>distance(p,a)<3))return false;
    tried.push(a);
    const free=points.filter(p=>distance(p,a)>=27&&distance(p,b)>=27);
    if(free.length<count)return false;
    for(let index=0;index<corners.length;index++){
      const corner=corners[(turn+index)%corners.length],first=free.reduce((a,b)=>distance(b,corner)<distance(a,corner)?b:a);
      const selected=[first],nearest=free.map(p=>distance(p,first));
      while(selected.length<count){
        let far=0;
        for(let i=1;i<nearest.length;i++)if(nearest[i]>nearest[far])far=i;
        if(nearest[far]<27)break;
        const next=free[far];selected.push(next);
        for(let i=0;i<free.length;i++)nearest[i]=Math.min(nearest[i],distance(next,free[i]));
      }
      if(selected.length===count){chosen=selected;return true;}
    }
    return false;
  });
  if(!seats)return null;
  const planned=chosen.map(at=>readingJob(floor,graph,stop,at));
  return planned.every(Boolean)?{seats,jobs:planned}:null;
}

function connectMeeting(floor,graph,pair,seats,firstIndex,zone) {
  const travel=(job,seat)=>distance(job.outbound.at(-1),seat.at);
  const swap=travel(pair[0],seats[1])+travel(pair[1],seats[0])<travel(pair[0],seats[0])+travel(pair[1],seats[1]);
  const routes=pair.map((job,i)=>{
    const seat=seats[swap?1-i:i];
    return {seat,approach:graph.route(job.outbound.at(-1),seat.at),homeward:graph.route(seat.at,floor.home)};
  });
  if(routes.some(r=>!r.approach||!r.homeward))return false;
  routes.forEach(({seat,approach,homeward},i)=>{
    pair[i].meeting={approach,facing:seat.facing,bubble:seat.bubble,partner:firstIndex+1-i};
    if(zone!==undefined)pair[i].meeting.zone=zone;
    pair[i].homeward=homeward;
  });
  return true;
}

export function planNewsCrew(floor,limit,turn=0,recordId=null) {
  if(!floor?.stops.length||limit<=0)return [];
  const graph=floorGraph(floor),jobs=[],used=[];
  const priority=recordId?floor.stops.filter(s=>s.id===recordId&&s.stamp?.width&&s.stamp.bottom>=floor.bounds.top&&s.stamp.top<=floor.bounds.bottom):[];
  function add(stop,variation){
    const job=sourceJob(floor,graph,stop,used,variation);
    if(!job)return false;
    jobs.push(job);return true;
  }
  for(const stop of priority)if(add(stop,0))break;
  const ordered=floor.stops.slice(turn%floor.stops.length).concat(floor.stops.slice(0,turn%floor.stops.length))
    .filter(stop=>!recordId||stop.id!==recordId||jobs.length);
  for(let pass=0;pass<limit&&jobs.length<limit;pass++){
    let progress=false;
    for(const [i,stop] of ordered.entries()){
      if(jobs.length>=limit)break;
      if(!pass&&jobs.some(job=>job.stop===stop))continue;
      if(add(stop,turn+i+pass*3))progress=true;
    }
    if(!progress&&pass)break;
  }
  if(jobs.length>1){
    const seats=meetingSeats(floor,graph,jobs);
    if(seats)connectMeeting(floor,graph,jobs.slice(0,2),seats,0);
  }
  return jobs;
}

// Read every visible record once before sending more readers to other
// measured parts of a card. Tight screens keep at least a full figure apart.
export function planSignalCrew(floor,limit,turn=0) {
  if(!floor?.stops.length||limit<1)return [];
  const start=turn%floor.stops.length,ordered=floor.stops.slice(start).concat(floor.stops.slice(0,start));
  return planPairedCrew(floor,limit,turn,ordered);
}

export function planDataCrew(floor,limit,turn=0,recordId=null) {
  if(!floor?.stops.length||limit<1)return [];
  const start=turn%floor.stops.length,rotated=floor.stops.slice(start).concat(floor.stops.slice(0,start));
  const priority=recordId&&rotated.find(stop=>stop.kind==='news'&&stop.id===recordId);
  const groups=new Map();
  for(const stop of rotated){
    if(stop===priority)continue;
    if(!groups.has(stop.kind))groups.set(stop.kind,[]);
    groups.get(stop.kind).push(stop);
  }
  const ordered=priority?[priority]:[];
  // Mix charts, observations, source records and market rows before revisiting
  // another part of a large card. A requested article gets first choice of aisle.
  for(let i=0;ordered.length<rotated.length;i++)
    for(const items of groups.values())if(items[i])ordered.push(items[i]);
  return planPairedCrew(floor,limit,turn,ordered);
}

function planPairedCrew(floor,limit,turn,ordered) {
  const graph=floorGraph(floor),jobs=[],readers=[],zones=[],occupied=[];
  for(const spacing of [38,32,27]){
    for(let pass=0;jobs.length<limit;pass++){
      const before=jobs.length;
      for(const [i,stop] of ordered.entries()){
        const job=sourceJob(floor,graph,stop,readers,turn+i+pass*5,spacing);
        if(job)jobs.push(job);
        if(jobs.length===limit)break;
      }
      if(before===jobs.length)break;
    }
  }
  let reserved=null;
  if(floor.compact&&ordered.length===1&&jobs.length>=2&&limit>2){
    if(jobs.length===limit)reserved=meetingSeats(floor,graph,jobs,[],true,27,true);
    if(!reserved){
      const pocket=singleCardPocket(floor,graph,jobs,Math.floor(limit/2)*2,turn);
      if(pocket){reserved=pocket.seats;jobs.splice(0,jobs.length,...pocket.jobs);}
    }
  }
  if(jobs.length>1&&jobs.length%2)jobs.pop();
  for(let i=0;i+1<jobs.length;i+=2){
    const pair=jobs.slice(i,i+2),participants=[...pair,...jobs.filter(job=>!pair.includes(job))],protect=jobs.length>2;
    let seats=i===0?reserved:null;
    if(!seats)seats=meetingSeats(floor,graph,participants,occupied,false,36,protect);
    if(!seats&&floor.compact)seats=meetingSeats(floor,graph,participants,occupied,true,27,protect);
    // Preserve even very small discussion pockets. Additional pairs queue at
    // their own reading positions before using the very same two seats.
    if(!seats&&!zones.length)seats=meetingSeats(floor,graph,pair,[],true);
    let zone;
    if(seats){
      zone={id:zones.length,seats,uses:0};zones.push(zone);occupied.push(...seats.map(s=>s.at));
    }else if(zones.length){
      const [a,b]=pair.map(j=>j.outbound.at(-1)),midpoint={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const cost=z=>z.uses*64+distance(z.seats[0].at,midpoint);
      zone=zones.reduce((best,z)=>cost(z)<cost(best)?z:best);
    }
    if(zone&&connectMeeting(floor,graph,pair,zone.seats,i,zone.id))zone.uses++;
  }
  return jobs;
}

// Stagger people who will share an aisle, even when their routes enter it at different corners.
export function newsDepartureDelays(jobs,pace) {
  const tick=150,reserved=[];
  return jobs.map(({outbound},index)=>{
    const trace=[];let length=0,next=tick/(2*pace);
    for(let i=1;i<outbound.length;i++){
      const a=outbound[i-1],b=outbound[i],span=distance(a,b);
      if(!span)continue;
      const dx=(b.x-a.x)/span,dy=(b.y-a.y)/span;
      while(next<=length+span){
        const offset=next-length;trace.push({x:a.x+offset*dx,y:a.y+offset*dy,dx,dy});next+=tick/pace;
      }
      length+=span;
    }
    const first=Math.floor(index*.7);let best=first,least=Infinity;
    for(let slot=first;slot<=first+12;slot++){
      let score=0;
      for(const [t,p] of trace.entries()){
        if(distance(p,outbound[0])<40)continue;
        for(const q of reserved[slot+t]||[]){
          if(p.dx*q.dx+p.dy*q.dy<.65)continue;
          score+=Math.max(0,36-distance(p,q));
        }
      }
      if(score<least){least=score;best=slot;}
      if(!score)break;
    }
    trace.forEach((p,t)=>(reserved[best+t]??=[]).push(p));
    return 50+best*tick;
  });
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

function mountCourierCrew(root,pocket,scene,onReceived) {
  const doc=root.ownerDocument,win=doc.defaultView,events=new AbortController();
  const signals=scene==='signals',measureFloor=signals?measureSignalFloor:measureDataFloor;
  const options={signal:events.signal,passive:true,capture:true},motion=win.matchMedia('(prefers-reduced-motion: reduce)');
  const prompts=[['🤔','💡'],['🧐','🧩'],['👀','👍']];
  let wave=null,pending=null,turn=0,roleIndex=0,pressed=false,scrolling=false,away=false,recallRequested=false;
  let startTimer=0,scrollTimer=0,retryTimer=0,welcomeTimer=0,layoutFrame=0,lastWelcome=-Infinity;
  let observedFeed=null,typing=false,typingTimer=0;
  const feedSize=win.ResizeObserver?new win.ResizeObserver(queueLayout):null;
  const openControls=signals?'.sig-controls details[open]':'.dc-info[open],.pd-info[open],[data-info-open],.dc-column-picker';
  const reduced=()=>motion.matches||doc.documentElement.dataset.reducedMotion==='true'||!win.Element.prototype.animate;
  const overlayOpen=()=>pocket.classList.contains('open')||pocket.querySelector('.mascot-menu:not([hidden])')||
    doc.querySelector('dialog[open],.liquid-native-host [aria-expanded=true]')||root.querySelector(openControls);
  const busy=()=>doc.hidden||away||pressed||scrolling||typing||pocket.inert||overlayOpen();
  const story=id=>root.querySelector('[data-news-record="'+win.CSS.escape(id)+'"]');
  const transform=p=>'translate3d('+p.x+'px,'+p.y+'px,0)';
  const live=(crew,version)=>wave===crew&&crew.version===version;
  function home() {
    const r=pocket.querySelector('.mascot-trigger').getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  }
  function layoutStamp(stops) {
    const target=home(),stamp=[target.x,target.y,root.scrollTop,win.innerWidth,win.innerHeight];
    if(signals){
      for(const card of root.querySelectorAll('.sig-feed>[data-track-record]')){
        const r=card.getBoundingClientRect();
        if(r.bottom>=0&&r.top<=win.innerHeight)stamp.push(card.dataset.trackRecord,r.left,r.top,r.width,r.height);
      }
      return stamp;
    }
    stamp.push(win.location.search);
    for(const stop of stops??dataPatrolStops(root,pocket)){
      const r=stop.rect;
      stamp.push(stop.id,stop.kind,r.left,r.top,r.right,r.bottom);
    }
    return stamp;
  }
  function schedule(delay=50) {
    if(events.signal.aborted||wave||startTimer||busy()||(!pending&&reduced()))return;
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
  function acknowledge() {
    const now=win.performance.now();if(now-lastWelcome<1300)return;
    lastWelcome=now;pocket.setAttribute('data-news-welcome','');
    win.clearTimeout(welcomeTimer);welcomeTimer=win.setTimeout(()=>pocket.removeAttribute('data-news-welcome'),330);
  }
  async function dock(crew,version,m) {
    let target=home();
    if(distance(m.position,target)>3){recallRequested=true;queueLayout();return;}
    if(!await walk(crew,version,m,[target],'return'))return;
    m.el.dataset.phase='dock';acknowledge();
    if(!await hold(crew,version,m,360))return;
    target=home();
    if(distance(m.position,target)>3){recallRequested=true;queueLayout();return;}
    if(m.carrying&&m.item&&story(m.item.record_id)){
      m.carrying=false;delete m.el.dataset.carrying;onReceived(m.item);
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
    if(!crew.members.size){wave=null;recallRequested=false;win.clearTimeout(retryTimer);retryTimer=0;schedule();}
  }
  async function trip(crew,m) {
    const version=crew.version,{job}=m;
    if(!await hold(crew,version,m,m.departure))return;
    if(!await walk(crew,version,m,job.outbound,'out'))return;
    const sourceAttr=signals?'data-track-record':'data-courier-source';
    const original=job.stop.row;
    const row=original.isConnected&&original.getAttribute(sourceAttr)===job.stop.id?original:
      root.querySelector('['+sourceAttr+'="'+win.CSS.escape(job.stop.id)+'"]');
    const r=row?.getBoundingClientRect(),p=m.position;
    const area=r?.width&&r.height&&readingArea(crew,{kind:job.stop.kind,rect:r});
    const slack=signals?6:1;
    if(!area||p.x<area.l-slack||p.x>area.e+slack||p.y<area.top-slack||p.y>area.bottom+slack){
      recallRequested=true;queueLayout();return;
    }
    if(!m.item&&job.stop.kind==='news'&&pending?.record_id===job.stop.id){
      m.item=pending;pending=null;m.el.dataset.job='delivery';
    }
    m.el.dataset.phase=m.item?'pickup':'inspect';
    if(m.item){
      if(!story(m.item.record_id)){
        recallRequested=true;queueLayout();return;
      }
      m.carrying=true;m.el.dataset.carrying='true';m.pickup=row;m.pickup.setAttribute('data-news-pickup','');
    }
    if(job.inspectBubble&&(m.item||(m.index+crew.round+m.pass)%3===1)){
      const emoji=m.item?'🔎':row.closest('.df-economic-calendar')?'🌍':'👀';
      reaction(m,emoji,job.inspectBubble);
    }
    const readMs=m.bubble.hidden?340:550;
    if(!await hold(crew,version,m,readMs))return;
    reaction(m);unmark(m);
    if(job.meeting){
      const pair=Math.min(m.index,job.meeting.partner);
      if(!await crew.rooms.arrive(pair,job.meeting.zone??pair)||!live(crew,version))return;
      if(!await walk(crew,version,m,job.meeting.approach,'to-meeting'))return;
      if(!await meet(crew,version,m)||!live(crew,version))return;
      if(m.index>job.meeting.partner&&!await hold(crew,version,m,240))return;
    }
    if(await walk(crew,version,m,job.homeward,'return'))await dock(crew,version,m);
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
    el.dataset.courierRole=String(role.id);el.dataset.job=item?'delivery':'patrol';el.dataset.phase='out';
    el.dataset.courierPage=scene;el.dataset.courierTarget=job.stop.id;el.dataset.courierKind=job.stop.kind;
    if(signals)el.dataset.signalRecord=job.stop.id;
    el.dataset.courierRound=pass?crew.round+'.'+pass:String(crew.round);
    el.dataset.courierPair=String(Math.min(index,job.meeting?.partner??index));
    el.style.setProperty('--agent-color',role.color);el.style.setProperty('--run-stride',(170+role.id%6*13)+'ms');
    el.style.transform=transform(crew.home);
    el.innerHTML='<span class="news-courier-figure">'+courierFigure+'</span><span class="news-courier-reaction" hidden></span>';
    doc.body.append(el);
    return {el,index,pass,role,job,item,departure,position:crew.home,animation:null,carrying:false,pickup:null,bubble:el.lastElementChild};
  }
  function sendPair(crew,indexes,pass) {
    const delays=newsDepartureDelays(indexes.map(i=>crew.jobs[i]),crew.pace);
    const occupied=new Set([...crew.members].map(m=>m.role.id));
    for(const [slot,index] of indexes.entries()){
      let role=newsRoster[roleIndex++%newsRoster.length];
      while(occupied.has(role.id))role=newsRoster[roleIndex++%newsRoster.length];
      occupied.add(role.id);
      const m=newMember(crew,role,index,crew.jobs[index],null,delays[slot],pass);
      crew.members.add(m);monitor(crew,crew.version,trip(crew,m));
    }
  }
  function start() {
    startTimer=0;
    if(wave||events.signal.aborted||busy())return;
    if(doc.getElementById('app-preload')){schedule(270);return;}
    if(reduced()){
      if(pending&&story(pending.record_id)){const item=pending;pending=null;onReceived(item);}
      return;
    }
    const floor=measureFloor(root,pocket);if(!floor)return;
    const item=pending&&story(pending.record_id)?pending:null,width=win.innerWidth;
    const limit=width<600?6:width<1200?8:12;
    const jobs=signals?planSignalCrew(floor,limit,turn):planDataCrew(floor,limit,turn,item?.record_id);
    if(!jobs.length)return;
    const pace=width<=900?3.45:2.65,departures=newsDepartureDelays(jobs,pace);
    const crew={round:turn++,version:0,pace,jobs,home:floor.home,bounds:floor.bounds,stamp:layoutStamp(floor.stops),members:new Set(),waiting:new Set(),atMeeting:new Map(),meetings:new Map(),rooms:signalMeetingRooms(),recalling:false,paused:false};
    wave=crew;
    const roles=jobs.map(()=>newsRoster[roleIndex++%newsRoster.length]);
    jobs.forEach((job,i)=>{
      const article=i===0&&item&&job.stop.id===item.record_id?item:null;
      if(article)pending=null;
      crew.members.add(newMember(crew,roles[(crew.round+i)%roles.length],i,job,article,departures[i]));
    });
    for(const m of crew.members)monitor(crew,crew.version,trip(crew,m));
  }
  function sendHome(crew,floor,m) {
    const path=floor&&newsReturnPath(floor,m.position);
    if(!path?.length){crew.waiting.add(m);m.el.dataset.phase='wait-route';return;}
    crew.waiting.delete(m);
    const version=crew.version;
    monitor(crew,version,(async()=>{if(await walk(crew,version,m,path,'return'))await dock(crew,version,m);})());
  }
  function retryWaiting(crew) {
    if(!crew.waiting.size||retryTimer||crew.paused)return;
    retryTimer=win.setTimeout(()=>{
      retryTimer=0;if(wave!==crew||busy())return;
      const floor=measureFloor(root,pocket);
      for(const m of [...crew.waiting])sendHome(crew,floor,m);
      retryWaiting(crew);
    },850);
  }
  function recall(crew,stamp) {
    crew.version++;crew.recalling=true;crew.rooms.clear();
    for(const meeting of crew.meetings.values())meeting.finish(false);
    crew.meetings.clear();crew.stamp=stamp;crew.atMeeting.clear();crew.waiting.clear();
    win.clearTimeout(retryTimer);retryTimer=0;
    const floor=measureFloor(root,pocket);
    for(const m of crew.members){
      interruptMotion(m);reaction(m);unmark(m);delete m.el.dataset.speaking;
      if(m.item&&!m.carrying){pending??=m.item;m.item=null;m.el.dataset.job='patrol';}
      sendHome(crew,floor,m);
    }
    retryWaiting(crew);
  }
  function layout() {
    if(events.signal.aborted)return;
    if(feedSize){
      const feed=root.querySelector(signals?'.sig-feed':'.dc-root');
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
    const pause=Boolean(busy());freeze(wave,pause);
    if(pause)return;
    const stamp=layoutStamp(),moved=stamp.length!==wave.stamp.length||stamp.some((n,i)=>
      typeof n==='number'?Math.abs(n-wave.stamp[i])>4:n!==wave.stamp[i]);
    if(recallRequested||moved){recallRequested=false;recall(wave,stamp);}
    else retryWaiting(wave);
  }
  function afterScroll() {
    scrolling=true;if(wave)freeze(wave,true);win.clearTimeout(scrollTimer);
    scrollTimer=win.setTimeout(()=>{scrolling=false;queueLayout();},140);
  }
  doc.addEventListener('scroll',afterScroll,options);
  doc.addEventListener('pointerdown',()=>{pressed=true;if(wave)freeze(wave,true);},options);
  for(const type of ['pointerup','pointercancel'])win.addEventListener(type,()=>{pressed=false;queueLayout();},options);
  for(const type of ['focusin','focusout','beforetoggle','toggle','close','visibilitychange'])doc.addEventListener(type,queueLayout,options);
  doc.addEventListener('visibilitychange',()=>{if(doc.hidden&&wave)freeze(wave,true);},options);
  root.addEventListener('input',event=>{
    if(!event.target.matches(signals?'#sig-search':'input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]'))return;
    typing=true;if(wave)freeze(wave,true);win.clearTimeout(typingTimer);
    typingTimer=win.setTimeout(()=>{typing=false;queueLayout();},400);
  },options);
  win.addEventListener('blur',()=>{away=true;pressed=false;if(wave)freeze(wave,true);},options);
  win.addEventListener('focus',()=>{away=false;queueLayout();},options);
  win.addEventListener('resize',afterScroll,options);
  win.visualViewport?.addEventListener('resize',afterScroll,options);
  motion.addEventListener('change',queueLayout,options);
  const observer=new win.MutationObserver(records=>{
    if(!wave||signals||records.some(r=>r.target===root||!root.contains(r.target)||r.target.closest?.('[data-hub-feed]')))queueLayout();
  });
  observer.observe(pocket,{attributes:true,attributeFilter:['style','data-avoidance','class','inert']});
  observer.observe(doc.documentElement,{attributes:true,attributeFilter:['data-reduced-motion']});
  observer.observe(root,{childList:true,subtree:!signals});
  layout();
  return {
    offer(item){
      if(!item||pending?.record_id===item.record_id)return;
      pending=item;
      if(wave&&!wave.jobs.some(job=>job.stop.id===item.record_id)&&dataPatrolStops(root,pocket).some(stop=>stop.id===item.record_id)){
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
      events.abort();observer.disconnect();feedSize?.disconnect();win.cancelAnimationFrame(layoutFrame);win.clearTimeout(scrollTimer);win.clearTimeout(typingTimer);
      win.clearTimeout(welcomeTimer);pocket.removeAttribute('data-news-welcome');pending=null;clearWave();
    }
  };
}
