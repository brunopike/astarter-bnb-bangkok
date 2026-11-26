const floorGraphs=new WeakMap();
export const inside=(p,r)=>p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom;
export const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export const same=(a,b)=>a.x===b.x&&a.y===b.y;
const overlaps=(a,b)=>a.left<=b.right&&a.right>=b.left&&a.top<=b.bottom&&a.bottom>=b.top;

export function clearSegment(a,b,rects) {
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

export function readingArea(graph,stop) {
  const {bounds}=graph,r=stop.rect,rx=stop.edge?30:stop.kind==='signal'?10:stop.kind?20:12,ry=stop.edge?32:stop.kind==='signal'?10:stop.kind?22:13;
  return {l:Math.max(bounds.left,r.left-rx),e:Math.min(bounds.right,r.right+rx),
    top:Math.max(bounds.top,r.top-ry),bottom:Math.min(bounds.bottom,r.bottom+ry)};
}

function sourcePort(graph,stop,used,variation,spacing,canStand=null) {
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
    if(cost>=score||distance(p,home)<42||used.some(q=>distance(p,q)<spacing)||canStand&&!canStand(p))continue;
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

// Waiting paths use only measured whitespace in the current modules. Corner
// positions and conversation pockets never become records or pickup targets.
export function planDataWalk(floor,limit,turn=0) {
  if(!floor?.bounds||limit<1)return [];
  const areas=floor.walkAreas||[],start=areas.length?turn%areas.length:0;
  const ordered=areas.slice(start).concat(areas.slice(0,start));
  let jobs=[];
  for(const regions of [ordered,[floor.bounds]]){
    if(!regions.length)continue;
    const candidates=planPairedCrew(floor,limit,turn,regions.map(rect=>({rect,kind:'space'})));
    if(candidates.length>jobs.length||candidates.some(job=>job.meeting)&&!jobs.some(job=>job.meeting))jobs=candidates;
    if(jobs.some(job=>job.meeting))break;
  }
  return jobs.map(({outbound,homeward,meeting})=>({mode:'walk',stop:null,inspectBubble:null,outbound,homeward,meeting}));
}

// A pair that has returned can read another visible source immediately. Keep its
// reserved conversation seats and the standing room of every pair still out.
export function nextDataPair(floor,jobs,indexes,turn) {
  const previous=indexes.map(i=>jobs[i]);
  const walking=previous[0].mode==='walk';
  const stops=walking?(floor.walkAreas?.length?floor.walkAreas:[floor.bounds]).map(rect=>({rect,kind:'space'})):floor.stops;
  if(!stops.length)return previous;
  const graph=floorGraph(floor),used=jobs.map(j=>j.outbound.at(-1)),speech=[];
  const assigned=new Map();
  for(const [i,job] of jobs.entries()){
    if(job.meeting){
      const seat=job.homeward[0];used.push(seat);
      speech.push(bubbleBox(floor,seat,job.meeting.bubble));
    }
    if(!indexes.includes(i)&&job.stop)assigned.set(job.stop.id,(assigned.get(job.stop.id)||0)+1);
  }
  const start=turn%stops.length,ordered=stops.slice(start).concat(stops.slice(0,start));
  const dx=floor.compact?10:13,dy=floor.compact?15:17;
  const clearOfSpeakers=p=>!speech.some(b=>p.x+dx>b.left&&p.x-dx<b.right&&p.y+dy>b.top&&p.y-dy<b.bottom);
  return previous.map((job,slot)=>{
    const seat=job.homeward[0];
    const rank=s=>(assigned.get(s.id)||0)+(job.stop?.id===s.id?2:0);
    const candidates=[...ordered].sort((a,b)=>rank(a)-rank(b));
    for(const stop of candidates){
      const at=sourcePort(graph,stop,used,turn+slot*3,29,clearOfSpeakers);
      if(!at)continue;
      // Routing toward the recurring dock and seats reuses their path trees.
      const back=graph.route(at,floor.home),approach=graph.route(at,seat);
      if(!back||!approach)continue;
      used.push(at);
      if(!walking)assigned.set(stop.id,(assigned.get(stop.id)||0)+1);
      return {...job,stop:walking?null:stop,outbound:[...back].reverse(),
        inspectBubble:walking?null:bubblePlace(floor,graph,at),meeting:{...job.meeting,approach}};
    }
    if(job.stop)assigned.set(job.stop.id,(assigned.get(job.stop.id)||0)+1);
    return job;
  });
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
export function newsDepartureDelays(jobs,pace,traffic=[],dock=null) {
  const tick=150,reserved=[];
  function samples(path,startsIn=50){
    const start=Math.max(0,Math.ceil((startsIn-50-tick/2)/tick)),trace=[];
    let length=0,next=(50+(start+.5)*tick-startsIn)/pace;
    for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i],span=distance(a,b);
      if(!span)continue;
      const dx=(b.x-a.x)/span,dy=(b.y-a.y)/span;
      while(next<=length+span){
        const offset=next-length;trace.push({x:a.x+offset*dx,y:a.y+offset*dy,dx,dy});next+=tick/pace;
      }
      length+=span;
    }
    return {start,trace};
  }
  function reserve(start,trace){trace.forEach((p,t)=>(reserved[start+t]??=[]).push(p));}
  for(const active of traffic){
    const {start,trace}=samples(active.path,active.startsIn);
    reserve(start,trace);
  }
  return jobs.map(({outbound},index)=>{
    const {trace}=samples(outbound);
    const first=Math.floor(index*.7);let best=first,least=Infinity;
    for(let slot=first;slot<=first+12;slot++){
      let score=0;
      for(const [t,p] of trace.entries()){
        if(distance(p,dock||outbound[0])<40)continue;
        for(const q of reserved[slot+t]||[]){
          if(p.dx*q.dx+p.dy*q.dy<.65)continue;
          score+=Math.max(0,36-distance(p,q));
        }
      }
      if(score<least){least=score;best=slot;}
      if(!score)break;
    }
    reserve(best,trace);
    return 50+best*tick;
  });
}


function approachFrom(floor,from,to) {
  const graph=floorGraph(floor),direct=graph.route(from,to);
  if(direct)return direct;
  // A chart may have appeared around a runner. Leave its new bounds through
  // the nearest clear edge, then continue to the assigned card from there.
  const escape=newsReturnPath(floor,from);
  for(let i=1;i<(escape?.length||0);i++){
    const rest=graph.route(escape[i],to);
    if(rest)return escape.slice(0,i).concat(rest);
  }
  return null;
}


// All arguments are viewport geometry. DOM nodes and page content stay on the UI thread.
export function runCourierPlan(operation,floor,args){
  if(operation==='returns')return args.starts.map(at=>newsReturnPath(floor,at));
  if(operation==='pair')return nextDataPair(floor,args.jobs,args.indexes,args.turn);
  const {scene,limit,turn,recordId,pace,starts}=args;
  let jobs=scene==='signals'?planSignalCrew(floor,limit,turn):planDataCrew(floor,limit,turn,recordId);
  if(!jobs.length)jobs=planDataWalk(floor,limit,turn);
  const redirects=starts&&starts.map((at,i)=>jobs[i]&&(at?approachFrom(floor,at,jobs[i].outbound.at(-1)):jobs[i].outbound));
  return {jobs,delays:newsDepartureDelays(jobs,pace),redirects};
}

if(typeof DedicatedWorkerGlobalScope!=='undefined' && self instanceof DedicatedWorkerGlobalScope){
  let cachedId,cachedFloor;
  self.onmessage=({data:{id,operation,revision,floor,args}})=>{
    try{
      if(cachedId!==revision){cachedId=revision;cachedFloor=floor;}
      self.postMessage({id,result:runCourierPlan(operation,cachedFloor,args)});
    }catch(error){self.postMessage({id,error:String(error.message)});}
  };
}
