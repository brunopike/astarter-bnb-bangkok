import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionSource,collectionBeam,planNewsCrew,newsReturnPath,newsDepartureDelays,measureSignalFloor,planSignalCrew,signalMeetingRooms,dataPatrolStops,measureDataFloor,planDataCrew,planDataWalk,nextDataPair} from './collection-motion.mjs';
const top={key:'chain',zone:'chain'},asset={key:'chain',zone:'asset:ETH',asset:'ETH',intent:'asset',lower:true},flow={key:'chain',zone:'workflow:0:ETH',asset:'ETH',intent:'asset',lower:true,roles:[3,7,8]},strategy={key:'risk',zone:'workflow:2:ETH',asset:'ETH',intent:'strategy',lower:true,roles:[6,9,12]};
test('a research leader reads its own visible asset or workflow; partners keep collecting independent sources',()=>{
 const job={id:'research-ETH:v1',symbol:'ETH',roles:[3,7,8],source:'chain'},before=JSON.stringify(job);
 assert.equal(collectionSource([top,asset,flow],job,3,top),flow);
 assert.equal(collectionSource([top,asset,flow],{...job,route:'direct'},3,top),asset);
 assert.equal(collectionSource([top,asset,flow],job,7,top),top);
 assert.equal(collectionSource([top,asset,flow],{...job,symbol:'SOL'},3,top),top);
 assert.equal(collectionSource([top],job,3,top),top);assert.equal(JSON.stringify(job),before);
});
test('strategy and execution reading is bound to the actual business role and symbol',()=>{
 const job={id:'validation-1',symbol:'ETH',roles:[6,9,12],source:'risk',taskType:'validation',business:true};
 assert.equal(collectionSource([strategy,asset],job,6,top),strategy);
 assert.equal(collectionSource([strategy,asset],{...job,symbol:'BTC'},6,top),top);
 assert.equal(collectionSource([strategy,asset],job,7,top),top);
 assert.equal(collectionSource([strategy,asset],{...job,symbol:undefined},6,top),top);
});
test('frame highlights use equal perimeter speed and disappear at both ends of a read',()=>{
 const a=collectionBeam(.2,160,70),b=collectionBeam(.4,160,70),c=collectionBeam(.6,160,70);
 assert.equal(a.perimeter,460);assert.ok(Math.abs((b.offset-a.offset)-(c.offset-b.offset))<1e-10);
 assert.equal(collectionBeam(0,160,70).opacity,0);assert.ok(collectionBeam(1,160,70).opacity<1e-8);assert.equal(collectionBeam(-1,160,70).scan,0);assert.equal(collectionBeam(2,160,70).scan,160);
});

function verifyLeg(path, floor) {
 assert.ok(path?.length>=2,'a walk has a measured start and destination');
 const {bounds,ink=floor.obstacles}=floor;
 for(let i=1;i<path.length;i++){
  const a=path[i-1],b=path[i],steps=Math.max(1,Math.ceil(Math.hypot(a.x-b.x,a.y-b.y)));
  for(let n=0;n<=steps;n++){
   const x=a.x+(b.x-a.x)*n/steps,y=a.y+(b.y-a.y)*n/steps;
   assert.ok(x>=bounds.left&&x<=bounds.right&&y>=bounds.top&&y<=bounds.bottom);
   assert.ok(!ink.some(r=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom),'a walk must not cross the visible text or a control');
  }
 }
}

test('all news routes connect the article, optional shared meeting and actual companion',()=>{
 const bounds={left:14,right:1050,top:45,bottom:735},home={x:975,y:681.5};
 const stops=[100,285,470].map((top,i)=>({id:'news-'+i,stamp:{left:45,right:82,top:top+5,bottom:top+18,width:37,height:13},rect:{left:24,right:1026,top,bottom:top+144}}));
 const obstacles=stops.map(({rect})=>({left:100,right:810,top:rect.top+30,bottom:rect.bottom-20}));
 const floor={bounds,home,stops,obstacles},jobs=planNewsCrew(floor,6,0,'news-1');
 assert.equal(jobs.length,6);assert.equal(jobs[0].stop,stops[1]);
 assert.equal(jobs.filter(job=>job.meeting).length,2);
 for(const [i,job] of jobs.entries()){
  assert.deepEqual(job.outbound[0],home);assert.deepEqual(job.homeward.at(-1),home);
  verifyLeg(job.outbound,floor);verifyLeg(job.homeward,floor);
  const source=job.outbound.at(-1),arrive=job.meeting?.approach?.at(-1)||source;
  assert.deepEqual(job.homeward[0],arrive);
  if(job.meeting){
   assert.deepEqual(job.meeting.approach[0],source);verifyLeg(job.meeting.approach,floor);
   const other=jobs[job.meeting.partner].meeting;
   assert.equal(other.partner,i);assert.notEqual(other.facing,job.meeting.facing);
   const peer=other.approach.at(-1);assert.equal(arrive.y,peer.y);
   assert.ok(Math.abs(arrive.x-peer.x)>=34&&Math.abs(arrive.x-peer.x)<=42);
   assert.ok(['above','above-left','above-right'].includes(job.meeting.bubble));
  }
 }
 assert.notDeepEqual(planNewsCrew(floor,6,1).map(j=>j.outbound.at(-1)),jobs.map(j=>j.outbound.at(-1)));
 assert.equal(planNewsCrew(floor,3).length,3);
});

test('a labyrinth connects the actual home through several turns; unreachable stations are skipped',()=>{
 const bounds={left:0,right:300,top:0,bottom:200},home={x:284,y:168},stop={rect:{left:4,right:72,top:8,bottom:49}};
 const obstacles=[{left:70,right:88,top:42,bottom:201},{left:144,right:164,top:-1,bottom:160},{left:212,right:228,top:43,bottom:201}];
 const floor={bounds,home,obstacles,stops:[stop]},route=newsReturnPath(floor,{x:18,y:24});
 assert.ok(route.length>=5);assert.deepEqual(route.at(-1),home);verifyLeg(route,floor);
 assert.equal(planNewsCrew(floor,1).length,1);
 const sealed={...floor,obstacles:[...obstacles,{left:92,right:112,top:-1,bottom:201}]};
 assert.equal(newsReturnPath(sealed,{x:18,y:24}),null);assert.deepEqual(planNewsCrew(sealed,4),[]);
 assert.deepEqual(planNewsCrew({...floor,stops:[]},6),[]);
 assert.ok(newsReturnPath({...floor,stops:[]},{x:18,y:24}),'teammates can return after their source has scrolled away');
});

test('a relayout can release a runner trapped in padding, without stepping through the control',()=>{
 const floor={bounds:{left:0,right:300,top:0,bottom:220},home:{x:260,y:170},stops:[],
  obstacles:[{left:65,right:170,top:80,bottom:142}],ink:[{left:78,right:157,top:96,bottom:126}]};
 const start={x:116,y:87},route=newsReturnPath(floor,start);
 assert.deepEqual(route[0],start);assert.deepEqual(route.at(-1),floor.home);
 assert.ok(Math.hypot(route[1].x-start.x,route[1].y-start.y)<=28);verifyLeg(route,floor);
});

test('on reflow a runner embedded in the headline exits its original line once and returns',()=>{
 const ink=[{left:35,right:365.8,top:662,bottom:681.3},{left:35,right:339.4,top:686,bottom:705.3}];
 const floor={bounds:{left:10,right:380,top:67,bottom:769},home:{x:350,y:628.9765625},stops:[],ink,
  obstacles:ink.map(r=>({left:r.left-10,right:r.right+10,top:r.top-15,bottom:r.bottom+15}))};
 const start={x:350,y:674.4},route=newsReturnPath(floor,start);
 assert.deepEqual(route[0],start);assert.deepEqual(route.at(-1),floor.home);
 assert.ok(Math.hypot(route[1].x-start.x,route[1].y-start.y)<33,'leave via a nearby clear edge');
 verifyLeg(route.slice(0,2),{...floor,ink:[ink[1]]});
 verifyLeg(route.slice(1),floor);
});

test('a reflowed reader can leave a clear pocket enclosed by padding; ordinary reading routes keep full margins',()=>{
 const bounds={left:5,right:220,top:5,bottom:155},home={x:193,y:124},from={x:82,y:80};
 // Two sections of a data column leave a real opening. Their normal body-clearance
 // boxes overlap, isolating the original screen coordinate when the page scrolls.
 const ink=[[40,39,134,45],[40,112,134,118],[40,40,46,116],[128,42,134,72],[128,84,134,116]]
  .map(([left,top,right,bottom])=>({left,top,right,bottom}));
 const pad=r=>({left:r.left-10,right:r.right+10,top:r.top-15,bottom:r.bottom+15});
 const floor={bounds,home,ink,obstacles:ink.map(pad),compact:true,stops:[{id:'card',kind:'signal',rect:{left:74,right:89,top:72,bottom:88}}]};
 assert.ok(!floor.obstacles.some(r=>from.x>=r.left&&from.x<=r.right&&from.y>=r.top&&from.y<=r.bottom));
 assert.equal(newsReturnPath({...floor,ink:undefined},from),null);
 assert.deepEqual(planSignalCrew(floor,6),[],'the narrow exit is only used to recall an existing reader');
 const route=newsReturnPath(floor,from);
 assert.deepEqual(route[0],from);assert.deepEqual(route.at(-1),home);
 verifyLeg(route,floor);
 const label={left:53,top:68,right:102,bottom:82},covered={x:101,y:75};
 const overText={...floor,ink:[...ink,label],obstacles:[...floor.obstacles,pad(label)]};
 const exit=newsReturnPath(overText,covered);
 assert.deepEqual(exit[0],covered);assert.deepEqual(exit[1],{x:103,y:75},'exit by the nearest edge of the newly overlapping label');
 verifyLeg(exit.slice(0,2),floor);verifyLeg(exit.slice(1),overText);
 const wall={left:110,top:0,right:142,bottom:160};
 assert.equal(newsReturnPath({...floor,ink:[...ink,wall],obstacles:[...floor.obstacles,pad(wall)]},from),null,
  'an actual closed control cannot be crossed');
});

test('a runner outside a newly narrowed viewport enters through a clear edge, continuously',()=>{
 const home={x:272,y:508},bounds={left:10,right:310,top:52,bottom:540};
 const obstacles=[{left:286,right:320,top:145,bottom:215}],floor={home,bounds,stops:[],obstacles};
 const from={x:800,y:179},route=newsReturnPath(floor,from);
 assert.deepEqual(route[0],from);assert.deepEqual(route.at(-1),home);
 const firstInside=route.findIndex(p=>p.x>=bounds.left&&p.x<=bounds.right&&p.y>=bounds.top&&p.y<=bounds.bottom);
 assert.ok(firstInside>0);assert.equal(route[firstInside].x,bounds.right);
 verifyLeg(route,{...floor,bounds:{...bounds,right:from.x}});
 verifyLeg(route.slice(firstInside),floor);
});

test('people following the same aisle leave enough space while independent aisles can open together',()=>{
 const home={x:500,y:580},corner={x:500,y:240};
 const left={outbound:[home,corner,{x:100,y:240}]},right={outbound:[home,{x:900,y:580}]};
 const pace=3.45,[first,across,following]=newsDepartureDelays([left,right,left],pace);
 assert.equal(across,first);
 assert.ok((following-first)/pace>=36,'the follower keeps a full body of space on the shared turn');
 const mobilePace=4.45,queue=newsDepartureDelays([left,left,left],mobilePace);
 for(let i=1;i<queue.length;i++)assert.ok((queue[i]-queue[i-1])/mobilePace>=36);
});

test('a fresh patrol gives a runner from an earlier pair enough room on the shared aisle',()=>{
  const home={x:80,y:340},path=[home,{x:80,y:120},{x:480,y:120}];
  const other=[home,{x:490,y:340}],pace=3.45;
  const traffic=[{path,startsIn:30}];
  const [follows]=newsDepartureDelays([{outbound:path}],pace,traffic);
  assert.ok((follows-30)/pace>=36);
  assert.deepEqual(newsDepartureDelays([{outbound:other}],pace,traffic),[50]);
  assert.deepEqual(newsDepartureDelays([{outbound:path}],pace,[{path,startsIn:-5000}]),[50]);
  const homeward=[{x:80,y:120},home],otherReturn=[{x:80,y:112},home];
  const [homeDelay]=newsDepartureDelays([{outbound:otherReturn}],pace,[{path:homeward,startsIn:50}],home);
  assert.ok(homeDelay>50,'different pairs returning along the same edge leave one another room');
});

const box=(left,top,right,bottom)=>({left,right,top,bottom,width:right-left,height:bottom-top});
const record=(id,left,top,right,bottom)=>({id,kind:'signal',rect:box(left,top,right,bottom)});

test('a twelve-person signal crew reads distinct records first and uses separate rooms when space permits',()=>{
  const stops=[72,235,398,561].map((y,i)=>record('id-'+i,20,y,710,y+133));
  const obstacles=stops.map(s=>box(86,s.rect.top+30,560,s.rect.top+95));
  const floor={home:{x:1008,y:717},bounds:box(10,20,1030,736),compact:false,stops,obstacles};
  const jobs=planSignalCrew(floor,12),seats=[];
  assert.equal(jobs.length,12);
  assert.equal(new Set(jobs.slice(0,4).map(job=>job.stop.id)).size,4);
  for(const [i,job] of jobs.entries()){
    const peer=jobs[job.meeting.partner];
    assert.equal(peer.meeting.partner,i);assert.equal(peer.meeting.zone,job.meeting.zone);assert.notEqual(peer.stop.id,job.stop.id);
    assert.notEqual(peer.meeting.facing,job.meeting.facing);
    assert.deepEqual(job.outbound[0],floor.home);
    assert.deepEqual(job.meeting.approach[0],job.outbound.at(-1));
    assert.deepEqual(job.homeward[0],job.meeting.approach.at(-1));
    assert.deepEqual(job.homeward.at(-1),floor.home);
    for(const walk of [job.outbound,job.meeting.approach,job.homeward])verifyLeg(walk,floor);
    const seat=job.homeward[0],otherSeat=peer.homeward[0];
    assert.equal(seat.y,otherSeat.y);assert.equal(Math.abs(seat.x-otherSeat.x),40);
    for(const occupied of seats)if(occupied.index!==job.meeting.partner)assert.ok(Math.hypot(seat.x-occupied.x,seat.y-occupied.y)>=48);
    seats.push({...seat,index:i});
  }
  assert.notEqual(planSignalCrew(floor,4,1)[0].stop.id,jobs[0].stop.id);
});

test('six readers on a single visible phone card keep their reading spots clear of a shared room',()=>{
  const only=record('visible-xau',16,452,304,508);
  const floor={home:{x:284,y:472},bounds:box(10,67,310,493),compact:true,stops:[only],obstacles:[box(0,69,315,430),box(34,467,89,500)]};
  const jobs=planSignalCrew(floor,6),rooms=new Map();
  assert.equal(jobs.length,6);assert.ok(jobs.every(j=>j.stop===only));
  for(const [i,job] of jobs.entries()){
    const source=job.outbound.at(-1),peer=jobs[job.meeting.partner];
    assert.equal(peer.meeting.partner,i);assert.equal(peer.meeting.zone,job.meeting.zone);assert.ok(job.meeting.bubble);
    assert.deepEqual(job.meeting.approach[0],source);
    assert.deepEqual(job.homeward[0],job.meeting.approach.at(-1));
    assert.deepEqual(job.homeward.at(-1),floor.home);
    for(const other of jobs){
      const read=other.outbound.at(-1),seat=other.homeward[0];
      if(other!==job)assert.ok(Math.hypot(source.x-read.x,source.y-read.y)>=27);
      assert.ok(Math.hypot(source.x-seat.x,source.y-seat.y)>=27,'waiting readers leave the meeting seats free');
    }
    const seats=[job.homeward[0],peer.homeward[0]].sort((a,b)=>a.x-b.x);
    if(rooms.has(job.meeting.zone))assert.deepEqual(seats,rooms.get(job.meeting.zone));
    else rooms.set(job.meeting.zone,seats);
    for(const walk of [job.outbound,job.meeting.approach,job.homeward])verifyLeg(walk,floor);
  }
  assert.equal(rooms.size,1,'three pairs can take turns in the only suitable meeting space');
  assert.deepEqual(planSignalCrew({...floor,stops:[]},6),[]);
  assert.deepEqual(planSignalCrew({...floor,obstacles:[box(0,0,320,520)]},6),[]);
});

test('measure the clipped signal list and retain exactly one stop for each visible record ID',()=>{
  const elem=r=>({nodeType:1,tagName:'DIV',childNodes:[],matches:()=>false,getBoundingClientRect:()=>r});
  const row=(id,r)=>({...elem(r),dataset:{trackRecord:id},querySelector:()=>null});
  const items=[row('before',box(16,-80,304,44)),row('peek',box(16,62,304,79)),row('xau',box(16,60,304,274)),
    row('xau',box(16,282,304,395)),row('btc',box(16,409,304,680)),row('below',box(16,600,304,800))];
  const feed={querySelectorAll:()=>items},nav=elem(box(6,580,314,632)),pocket=elem(box(260,514,308,562));
  const root=elem(box(0,68,320,590));root.querySelector=()=>feed;
  root.ownerDocument={defaultView:{innerWidth:320,innerHeight:648,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'})},
    querySelector:()=>nav,createRange:()=>({})};
  const floor=measureSignalFloor(root,pocket);
  assert.deepEqual(floor.stops.map(s=>s.id),['xau','btc']);
  assert.equal(floor.stops[0].rect.top,68);
  assert.equal(floor.stops[1].rect.bottom,580);
  assert.deepEqual(floor.home,{x:284,y:538});
  root.querySelector=()=>null;assert.equal(measureSignalFloor(root,pocket),null);
});

test('signal partners share a meeting place in arrival order; separate rooms and recalls release independently',async()=>{
  const rooms=signalMeetingRooms();
  const first=rooms.arrive(0,'edge'),turns=[];
  first.then(granted=>turns.push(['first',granted]));
  await Promise.resolve();
  assert.deepEqual(turns,[],'one reader waits at the card for their partner');
  assert.equal(await rooms.arrive(0,'edge'),true);
  assert.equal(await first,true);

  rooms.arrive(2,'edge');const second=rooms.arrive(2,'edge');
  second.then(granted=>turns.push(['second',granted]));
  rooms.arrive(4,'other');assert.equal(await rooms.arrive(4,'other'),true);
  rooms.arrive(6,'edge');const third=rooms.arrive(6,'edge');
  assert.deepEqual(turns,[['first',true]],'an occupied seat stays reserved through the handoff');
  rooms.leave(0);assert.equal(await second,true);
  rooms.clear();assert.equal(await third,false);

  const newVisit=rooms.arrive(2,'edge');
  assert.equal(await rooms.arrive(2,'edge'),true);
  assert.equal(await newVisit,true,'the same partners can re-enter after the layout changes');
  rooms.leave(2);
});

test('data crews cover different kinds of evidence, honour a selected visible story and return as partners',()=>{
  const stops=['news','news','series','stat','post'].map((kind,i)=>({...record('source-'+i,25,80+i*115,750,185+i*115),kind,stamp:box(32,87+i*115,75,101+i*115)}));
  const floor={bounds:box(12,48,1190,860),home:{x:1140,y:800},compact:false,obstacles:[],stops};
  const jobs=planDataCrew(floor,12,3,stops[1].id);
  assert.equal(jobs.length,12);assert.equal(jobs[0].stop,stops[1]);
  assert.ok(new Set(jobs.slice(0,5).map(j=>j.stop)).size===5);
  for(const [i,j] of jobs.entries()){
    assert.equal(jobs[j.meeting.partner].meeting.partner,i);
    assert.deepEqual(j.outbound[0],floor.home);assert.deepEqual(j.outbound.at(-1),j.meeting.approach[0]);
    assert.deepEqual(j.meeting.approach.at(-1),j.homeward[0]);assert.deepEqual(j.homeward.at(-1),floor.home);
    for(const path of [j.outbound,j.meeting.approach,j.homeward])verifyLeg(path,floor);
  }
  stops[1].stamp=null;assert.equal(planDataCrew(floor,2,2,stops[1].id)[0].stop,stops[1],'the source can still be read when its time has scrolled away');
  assert.deepEqual(planDataCrew({...floor,stops:[]},12),[]);
  assert.deepEqual(planDataCrew({...floor,obstacles:[box(0,0,1200,900)]},12),[]);
});

test('a returning pair rotates real records while preserving the other readers and its reserved seats',()=>{
  const stops=Array.from({length:7},(_,i)=>({...record('row-'+i,48,58+i*105,735,144+i*105),kind:'row'}));
  const floor={bounds:box(12,48,1030,856),home:{x:984,y:755},compact:false,obstacles:[],stops};
  const jobs=planDataCrew(floor,6),pair=[0,1],next=nextDataPair(floor,jobs,pair,1);
  assert.equal(next.length,2);
  assert.ok(next.some(j=>!jobs.some(original=>original.stop===j.stop)),'read a visible record the first shift missed');
  for(const [i,job] of next.entries()){
    const previous=jobs[i],at=job.outbound.at(-1);
    assert.ok(stops.includes(job.stop));
    assert.equal(job.meeting.zone,previous.meeting.zone);
    assert.equal(job.meeting.partner,previous.meeting.partner);
    assert.deepEqual(job.homeward,previous.homeward);
    assert.deepEqual(job.meeting.approach[0],at);
    assert.deepEqual(job.meeting.approach.at(-1),job.homeward[0]);
    for(const point of jobs.flatMap(j=>[j.outbound.at(-1),j.homeward[0]]))
      assert.ok(Math.hypot(at.x-point.x,at.y-point.y)>=29);
    for(const path of [job.outbound,job.meeting.approach,job.homeward])verifyLeg(path,floor);
  }
  const waiting={...floor,stops:[],walkAreas:[box(30,80,895,700)]};
  const walks=planDataWalk(waiting,6),nextWalk=nextDataPair(waiting,walks,pair,2);
  for(const job of nextWalk){assert.equal(job.stop,null);assert.equal(job.mode,'walk');assert.equal(job.inspectBubble,null);}
});

test('data stations require published content in the visible scroller and keep stable IDs across quote updates',()=>{
  const style={display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'};
  const node=(r,selector,attrs={})=>({dataset:{},childNodes:[],children:[],tagName:'DIV',getBoundingClientRect:()=>r,
    matches:s=>Boolean(selector&&s.split(',').includes(selector)),hasAttribute:k=>Object.hasOwn(attrs,k),getAttribute:k=>attrs[k],
    querySelector:()=>null,querySelectorAll:()=>[],closest:()=>null});
  const root=node(box(0,48,390,792)),area=node(box(0,48,390,792),'',{'data-public-data':'live-etf'}),strip=node(box(24,140,350,330));
  const pocket=node(box(326,724,374,772)),nav=node(box(0,784,390,844));
  area.dataset={publicData:'live-etf',dataCenter:'etf'};
  const attach=(parent,el)=>{el.parentElement=parent;parent.children.push(el);return el;};
  attach(root,area);attach(area,strip);strip.style={...style,overflowX:'auto'};
  const stat=(r,value)=>{const el=attach(strip,node(r,'.dc-stat'));el.value=value;el.querySelector=s=>s==='strong'?{textContent:el.value}:null;return el;};
  const visible=stat(box(30,150,170,224),'$0'),partial=stat(box(320,150,510,224),'$1'),outside=stat(box(470,150,645,224),'$36'),empty=stat(box(30,235,160,289),'—');
  const table=attach(area,node(box(24,340,365,440)));table.tagName='TABLE';
  const tr=attach(table,node(box(25,350,560,408),'tr'));
  tr.matches=s=>s.startsWith('.dc-table tbody>tr');tr.closest=()=>table;
  const date=node(box(30,350,140,406)),amount=node(box(394,350,509,406)),missing=node(box(160,350,252,406));
  date.textContent='2026-11-19';amount.textContent='275';missing.textContent='—';tr.cells=[date,missing,amount];
  area.querySelectorAll=s=>s==='.dc-panel'?[]:s==='.dc-table,.dc-section table'?[table]:[visible,partial,outside,empty,tr];
  root.querySelector=()=>area;
  let active;const query={search:'?page=etf'};root.ownerDocument={
    defaultView:{innerWidth:390,innerHeight:844,location:query,getComputedStyle:el=>el.style||style},
    querySelector:()=>nav,createRange:()=>({selectNodeContents:el=>{active=el;},getClientRects:()=>[active.getBoundingClientRect()]})};
  const first=dataPatrolStops(root,pocket);
  assert.deepEqual(first.map(s=>s.row),[visible,partial]);assert.equal(first[1].rect.right,350);
  const id=visible.dataset.courierSource;assert.ok(id);assert.equal(empty.dataset.courierSource,undefined);assert.equal(tr.dataset.courierSource,undefined);
  visible.value='$36';partial.value='—';amount.getBoundingClientRect=()=>box(200,350,315,406);
  const second=dataPatrolStops(root,pocket);assert.equal(second[0].id,id);assert.equal(partial.dataset.courierSource,undefined);
  assert.equal(second.at(-1).id,'etf:row:0:2026-11-19');
  query.search='?page=etf&data=demo';assert.deepEqual(dataPatrolStops(root,pocket),[]);
  assert.equal(visible.dataset.courierSource,undefined);const floor=measureDataFloor(root,pocket);
  assert.ok(floor);assert.deepEqual(floor.stops,[]);assert.deepEqual(floor.home,{x:350,y:748});
});


test('waiting pairs walk through the active view and return home without creating a source or delivery',()=>{
  const regions=[box(24,88,307,208),box(28,310,303,468)],bar=box(55,225,259,290);
  const floor={bounds:box(10,54,310,620),home:{x:278,y:578},stops:[],compact:true,obstacles:[bar],ink:[bar],walkAreas:regions};
  assert.deepEqual(planDataCrew(floor,6),[]);
  const jobs=planDataWalk(floor,6);
  assert.equal(jobs.length,6);
  for(const [i,job] of jobs.entries()){
    assert.equal(job.mode,'walk');assert.equal(job.stop,null);assert.equal(job.inspectBubble,null);
    assert.equal(jobs[job.meeting.partner].meeting.partner,i);
    assert.deepEqual(job.outbound[0],floor.home);assert.deepEqual(job.outbound.at(-1),job.meeting.approach[0]);
    assert.deepEqual(job.meeting.approach.at(-1),job.homeward[0]);assert.deepEqual(job.homeward.at(-1),floor.home);
    const at=job.outbound.at(-1);assert.ok(regions.some(r=>at.x>=r.left-20&&at.x<=r.right+20&&at.y>=r.top-22&&at.y<=r.bottom+22));
    for(const path of [job.outbound,job.meeting.approach,job.homeward])verifyLeg(path,floor);
  }
  assert.deepEqual(floor.stops,[]);assert.ok(planDataWalk({...floor,walkAreas:[]},6).every(j=>j.stop===null&&j.mode==='walk'));
  assert.deepEqual(planDataWalk({...floor,obstacles:[floor.bounds],ink:[floor.bounds]},6),[]);
});

test('a loading data view keeps its walkable floor and protects the visible area of a third-party widget',()=>{
  const root={dataset:{renderedPage:'tracking'},querySelector:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>box(0,62,390,790),matches:()=>false,childNodes:[]};
  const widget={nodeType:1,tagName:'IFRAME',matches:s=>s.split(',').includes('iframe'),getBoundingClientRect:()=>box(24,86,365,488),childNodes:[]};
  const nav={getBoundingClientRect:()=>box(8,784,382,844)},pocket={getBoundingClientRect:()=>box(326,724,374,772)};root.childNodes.push(widget);
  root.ownerDocument={defaultView:{innerWidth:390,innerHeight:844,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'})},querySelector:()=>nav,createRange:()=>({})};
  const floor=measureDataFloor(root,pocket);assert.deepEqual(floor.stops,[]);assert.equal(floor.ink.length,1);
  assert.equal(floor.ink[0].top,86);assert.equal(floor.ink[0].bottom,488);
  const jobs=planDataWalk(floor,6);assert.equal(jobs.length,6);
  for(const j of jobs)for(const path of [j.outbound,j.meeting.approach,j.homeward])verifyLeg(path,floor);
  root.dataset.renderedPage='strategies';assert.equal(measureDataFloor(root,pocket),null);
});


test('skip complete offscreen panels before inspecting a source row or its children',()=>{
  const getBox=()=>box(0,64,390,792),base={tagName:'DIV',nodeType:1,children:[],childNodes:[],dataset:{},matches:()=>false,getBoundingClientRect:getBox,hasAttribute:()=>false};
  const root={...base},area={...base,parentElement:root,dataset:{dataCenter:'tracking'},hasAttribute:k=>k==='data-public-data'};
  const panel={...base,parentElement:area,tagName:'SECTION',matches:s=>s.split(',').includes('section'),getBoundingClientRect:()=>box(16,900,374,1700)};
  const hiddenRow={...base,parentElement:panel,getBoundingClientRect:()=>assert.fail('a row inside a fully offscreen panel was measured')};
  root.childNodes=[area];area.childNodes=[panel];panel.childNodes=[hiddenRow];root.querySelector=()=>area;
  area.querySelectorAll=s=>s==='.dc-panel'||s.startsWith('.dc-panel,')?[panel]:s==='.dc-table,.dc-section table'?[]:[hiddenRow];
  const style={display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'};
  root.ownerDocument={querySelector:()=>null,createRange:()=>({}),defaultView:{innerWidth:390,innerHeight:844,location:{search:'?page=tracking'},
    getComputedStyle:el=>{assert.notEqual(el,hiddenRow);return style;}}};
  const f=measureDataFloor(root,{getBoundingClientRect:()=>box(320,720,368,768)});assert.deepEqual(f.stops,[]);assert.deepEqual(f.ink,[]);
});
