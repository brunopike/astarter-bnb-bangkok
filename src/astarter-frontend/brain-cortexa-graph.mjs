import {directions,cortexaTones} from './brain-case-notes.mjs';
import {createEvidenceStars} from './brain-evidence-stars.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const blend = (a, b, t) => a + (b - a) * t;
const minZoom = .75, overview = 1, graphZoom = 2.1;
export const maxZoom=21;
function mixHex(from,to,t){
  if(t<=0)return from;
  if(t>=1)return to;
  const rgb=[1,3,5].map(offset=>{
    const a=parseInt(from.slice(offset,offset+2),16), b=parseInt(to.slice(offset,offset+2),16);
    return Math.round(blend(a,b,t)).toString(16).padStart(2,'0');
  });
  return '#'+rgb.join('');
}

// WheelEvent has no portable gesture-end signal. Count detents directly;
// for a precision pad, a pause or a fresh impulse after a taper starts a swipe.
export function createPortraitWheelGate(){
  let lastAt,previous,peak,trough,travel,counted,armedAt,detentStroke;
  let entering=false,lastHeldAt=-Infinity,lastHeldDelta=0;
  function reset(){
    lastAt=armedAt=-Infinity;previous=peak=travel=0;trough=Infinity;counted=detentStroke=false;
  }
  reset();
  function up(time,deltaY,detent){
    if(deltaY>=0){reset();return false;}
    const delta=-deltaY;
    const gap=time-lastAt;
    const secondImpulse=counted && delta>previous && delta>=Math.max(7,trough+5,trough*2);
    const equalTick=delta>=24 && delta===previous && Number.isInteger(delta) && gap>=60 && travel===previous;
    const taper=counted && !detent && !detentStroke && delta<previous && gap<1100;
    if((gap>=155 && !taper) || (detent && detentStroke) || secondImpulse || equalTick){
      peak=travel=0;trough=Infinity;counted=false;detentStroke=detent;
    }else if(!detent)detentStroke=false;
    lastAt=time;previous=delta;travel+=delta;
    peak=Math.max(peak,delta);
    if(delta<=peak*.35)trough=Math.min(trough,delta);
    if(counted || (!detentStroke && travel<12))return false;
    counted=true;
    // Remember the confirming stroke too, so its inertial tail cannot count again.
    const confirmed=time-armedAt<=1100;
    armedAt=confirmed?-Infinity:time;
    if(confirmed){lastHeldAt=time;lastHeldDelta=deltaY;}
    return confirmed;
  }
  // A confirmed entry owns the camera up to its final painted frame. Wheel
  // inertia from that trip must not become a return trip on arrival.
  function holdWheel(time,delta,detent){
    const gap=time-lastHeldAt;
    // Compositing a large graph can deliver an otherwise continuous trackpad
    // tail hundreds of milliseconds late. A decreasing impulse is still its tail.
    const taper=!detent && delta*lastHeldDelta>0 && Math.abs(delta)<Math.abs(lastHeldDelta) && gap<1100;
    if(!entering && gap>=180 && !taper){lastHeldAt=-Infinity;return false;}
    lastHeldAt=time;lastHeldDelta=delta;
    return true;
  }
  return {
    up,reset,holdWheel,
    beginEntry(){reset();entering=true;},
    settleEntry(){entering=false;},
    get entering(){return entering;}
  };
}

function nextZoomStep(value,factor){
  if(factor>0)return value>=graphZoom?value*1.45:value+.55;
  return value>graphZoom?Math.max(graphZoom,value/1.45):value-.55;
}

// Include the outermost child orbits even at the deepest magnification.
function panReach(spread){return Math.max(.41, .69*spread-.5);}

function smoothstep(a, b, value) {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// The case's five directions have stable positions. Leaves fan out from their
// own branch so selecting a different note never runs a layout simulation.
function constellation(notes) {
  const hubs = [[.48,.45],[.26,.30],[.71,.27],[.70,.64],[.31,.70]];
  const angles = [-1.55,-2.67,-.64,.53,2.43];
  const groups = new Map(directions.map(({key}, i) => [key, i]));
  const leaves = hubs.map(() => []);
  const sites = notes.map((note, index) => {
    const family = groups.get(note.group) ?? 0;
    if (note.level >= 3) leaves[family].push(index);
    return {x:hubs[family][0], y:hubs[family][1], level:note.level, tone:note.tone||note.group, color:note.color};
  });
  for (const [family, members] of leaves.entries()) {
    members.forEach((index, order) => {
      const fan = members.length < 2 ? 0 : blend(-1.0, 1.0, order / (members.length - 1));
      const angle = angles[family] + fan;
      sites[index].x += .20 * Math.cos(angle);
      sites[index].y += .25 * Math.sin(angle);
    });
  }
  return sites;
}

// These are the same rest-pose landmarks used to partition the source mesh.
// They also locate their pixels on the baked 1440×900 poster without WebGL.
const landmarks = [
  [0,-.20],[-.68,.24],[.66,.28],[.60,-.64],[-.62,-.62],[-.62,.89],[.63,.91],
  [0,1.17],[.97,-.17],[.66,-1.23],[0,-1.53],[-.63,-2.13],[.65,-2.17],[-.67,-1.24]
];
function posterAnchor(index) {
  const [x,y]=landmarks[index];
  return [.5+x*.21076*900/1440,.3917-y*.21076];
}
const posterAnchors=landmarks.map((_,i)=>posterAnchor(i));

// Animate a few real landmarks and connections without repainting the evidence canvas at idle.
function mountMemoryMotion(canvas) {
  const doc=canvas.ownerDocument;
  function svg(name,attrs={}) {
    const el=doc.createElementNS('http://www.w3.org/2000/svg',name);
    for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));
    return el;
  }
  const layer=svg('svg',{class:'ct-memory-motion','aria-hidden':'true',focusable:'false'});
  canvas.after(layer);
  let lastKey='';
  function running(on){
    const state=String(on);
    if(layer.dataset.running!==state)layer.dataset.running=state;
  }
  function paint(key,bounds,points,links,sites,stars,compact){
    if(key===lastKey)return;
    lastKey=key;
    const left=bounds.cx-bounds.w/2,top=bounds.cy-bounds.h/2;
    const right=left+bounds.w,bottom=top+bounds.h;
    const inside=p=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom;
    const lights=doc.createDocumentFragment();
    const routes=links.filter(([a,b])=>inside(points[a])&&inside(points[b])&&
      Math.hypot(points[a].x-points[b].x,points[a].y-points[b].y)>28);
    const count=Math.min(routes.length,compact?2:3);
    for(let i=0;i<count;i++){
      const [a,b]=routes[Math.floor((i+.5)*routes.length/count)],from=points[a],to=points[b];
      const path=svg('g',{transform:'translate('+from.x+' '+from.y+')',fill:sites[b].color});
      const signal=svg('g',{class:'ct-memory-signal'});
      signal.style.setProperty('--dx',(to.x-from.x)+'px');
      signal.style.setProperty('--dy',(to.y-from.y)+'px');
      signal.style.animationDuration=(5.8+i*.85)+'s';
      signal.style.animationDelay=(-1.6-i*2.9)+'s';
      signal.append(svg('circle',{r:4,opacity:.24}),svg('circle',{r:1.75}));
      path.append(signal);lights.append(path);
    }
    for(const [i,p] of stars.visibleGlints(compact?12:30).entries()){
      const glint=svg('circle',{class:'ct-memory-glint',cx:p.x,cy:p.y,r:p.star.group?5:3.1,fill:p.color});
      glint.style.animationDuration=(3.9+i%5*.66)+'s';
      glint.style.animationDelay=(-(i*1.93+1.2))+'s';
      lights.append(glint);
    }
    layer.replaceChildren(lights);
  }
  return {running,paint,dispose(){layer.remove();}};
}

export function mountCortexaGraph(canvas, markers, edges, reduced, onPick, onZoomChange, notes) {
  const space = canvas.parentElement;
  const doc = canvas.ownerDocument, win = doc.defaultView;
  const sites = constellation(notes);
  const parents=notes.map((note,i)=>note.portraitParent??i);
  notes.forEach((note,i)=>{if(note.mapSite)[sites[i].x,sites[i].y]=note.mapSite;});
  let inspectEvidence;
  const stars=createEvidenceStars(space,doc.documentElement.lang.startsWith('en'),item=>inspectEvidence?.(item));
  const links = edges.filter(([a,b]) => sites[a] && sites[b]);
  const neighbors = sites.map(() => new Set());
  for (const [a,b] of links) { neighbors[a].add(b); neighbors[b].add(a); }
  const context = canvas.getContext('2d');
  const motion=mountMemoryMotion(canvas);
  let evidenceRevision=0,pickerOpen=false,pendingNodeFocus=null;
  const abort = new AbortController();
  function listen(el, event, fn, options={}) {
    el.addEventListener(event, fn, {...options, signal:abort.signal});
  }

  space.dataset.cortexaGraph = '';
  if (!space.hasAttribute('tabindex')) space.tabIndex = 0;
  if (!space.hasAttribute('role')) space.setAttribute('role','group');
  if (!space.hasAttribute('aria-label')) space.setAttribute('aria-label',
    doc.documentElement.lang.startsWith('zh') ? '知识图谱' : 'Knowledge graph');
  space.setAttribute('aria-keyshortcuts','+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown');

  // Keep the same focusable note buttons on the portrait and on the map.
  const sizeByLevel = [0,23,14,7];
  markers.forEach((button,index) => {
    button.removeAttribute('title');
    button.style.setProperty('--node-color', sites[index].color);
    button.style.setProperty('--breath-period',(5.2+index%5*.68)+'s');
    button.style.setProperty('--breath-delay',(-index*1.71-.7)+'s');
    button.style.setProperty('--node-size', (sizeByLevel[sites[index].level] || 7) + 'px');
  });

  let width=0, height=0, ratio=1, zoom=overview, target=overview;
  let panX=0, panY=0, selected=0, pointer=null, focused=-1, press=0, pressedAt=-Infinity;
  let frame=0,resizeFrame=0,lastTime=0,visible=true,disposed=false,drag=null,pinch=null,skipClick=false,visiblePress=0;
  let points=[],anchors=null,bounds,light=false,lastMix=-1,layoutDirty=true,lastSent=null;
  let poseZoom=1,zoomFocus=null,flight=null;
  const entryWheel=createPortraitWheelGate();
  let lastTint=-1;
  function shadeNodes(mix){
    const tint=smoothstep(.12,.94,mix);
    if(tint===lastTint)return;
    lastTint=tint;
    const cyan=light?'#44788c':'#93d2e5', violet=light?'#805f96':'#b69bda';
    for(const [i,site] of sites.entries()){
      const shell=mixHex(cyan,violet,smoothstep(-.95,.95,landmarks[parents[i]][0]));
      site.color=mixHex(shell,cortexaTones[site.tone][light?1:0],tint);
      markers[i].style.setProperty('--node-color',site.color);
    }
  }
  const labels=markers.map(button=>button.querySelector('span'));
  let labelKey='',labelMetrics=null;
  const labelContent=new MutationObserver(()=>{labelMetrics=null;labelKey='';requestPaint();});
  for(const label of labels)labelContent.observe(label,{childList:true,characterData:true,subtree:true});
  const mq=win.matchMedia('(prefers-reduced-motion: reduce)');
  const forceReduced=reduced && !mq.matches && doc.documentElement.dataset.reducedMotion!=='true';

  function requestPaint() {
    if (!frame && visible && !doc.hidden && !disposed) frame=win.requestAnimationFrame(draw);
  }
  listen(space,'cortexa-anchors',({detail})=>{
    const positions=Array.isArray(detail)?detail:detail?.points;
    if(positions?.length!==landmarks.length || !positions.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))return;
    anchors=positions;
    requestPaint();
  });
  function posterPosition(u,v) {
    const scale=height/900;
    return [width*.5+(u-.5)*1440*scale*poseZoom,height*.5+(v-.5)*900*scale*poseZoom];
  }
  function trackPointer(event=null) {
    if(!event && !pointer)return;
    pointer=event && event.pointerType!=='touch'?[event.clientX,event.clientY]:null;
    requestPaint();
  }
  function hit(x,y) {
    let index=-1,distance=Infinity;
    for(let i=0;i<points.length;i++){
      if(lastMix<.86 && i>=landmarks.length)continue;
      const d=Math.hypot(points[i].x-x,points[i].y-y);
      if(d<distance){distance=d;index=i;}
    }
    const radius=blend(Math.max(36,Math.min(width*.20,height*.19)*poseZoom),30,smoothstep(.12,.88,lastMix));
    return distance<=radius?index:-1;
  }
  function localPoint(event) {
    const rect=space.getBoundingClientRect();
    return [event.clientX-rect.left,event.clientY-rect.top];
  }
  function activate(index) {
    if(index<0 || entryWheel.entering)return;
    press++;pressedAt=win.performance.now();
    onPick?.(index);
    if(target<graphZoom)setZoom(graphZoom);
    requestPaint();
  }

  function readBounds() {
    const css=win.getComputedStyle(space);
    const inset=(side,fallback) => {
      const value=parseFloat(css.getPropertyValue('--graph-inset-'+side));
      return Number.isFinite(value) ? value : fallback;
    };
    const left=clamp(inset('left',width < 600 ? 14 : 40),0,width*.45);
    const right=clamp(inset('right',width < 600 ? 14 : 40),0,width*.58);
    const top=clamp(inset('top',55),0,height*.28);
    const bottom=clamp(inset('bottom',64),0,height*.68);
    const w=Math.max(1,width-left-right), h=Math.max(1,height-top-bottom);
    const cx=left+w*.50, cy=top+h*.50;
    return {cx,cy,w,h};
  }

  function resize() {
    const w=space.clientWidth,h=space.clientHeight,dpr=Math.min(win.devicePixelRatio || 1,2);
    if(width===w && height===h && ratio===dpr)return;
    width=w;height=h;ratio=dpr;
    canvas.width=Math.max(1,Math.round(width*ratio));
    canvas.height=Math.max(1,Math.round(height*ratio));
    layoutDirty=true;
    requestPaint();
  }
  function scheduleResize() {
    if(resizeFrame || disposed)return;
    resizeFrame=win.requestAnimationFrame(()=>{resizeFrame=0;resize();});
  }

  // Compact maps retain their node positions. Place the active caption first,
  // reserving the space used by the reader, controls, dots and earlier captions.
  function placeLabels(mapOpen, active) {
    if(!mapOpen || width>900){
      if(space.hasAttribute('data-fit-labels'))space.removeAttribute('data-fit-labels');
      labelKey='';return;
    }
    if(!space.hasAttribute('data-fit-labels'))space.setAttribute('data-fit-labels','');
    const geometry=[width,height,bounds.cx,bounds.cy,bounds.w,bounds.h].join('|');
    const key=[geometry,active,selected,zoom,panX,panY].join('|');
    if(key===labelKey)return;
    labelKey=key;
    if(labelMetrics?.geometry!==geometry){
      const origin=space.getBoundingClientRect();
      const obstacles=Array.from(space.querySelectorAll('.ct-heading,.ct-case,.ct-note-panel,.ct-tools,.ct-next'),el=>{
        const r=el.getBoundingClientRect();
        return [r.left-origin.left,r.top-origin.top,r.right-origin.left,r.bottom-origin.top];
      });
      const sizes=labels.map(label=>{
        const r=label.getBoundingClientRect();return [r.width,r.height];
      });
      labelMetrics={geometry,obstacles,sizes};
    }
    const occupied=[...labelMetrics.obstacles,...points.map(({x,y},i)=>{
      const radius=sizeByLevel[sites[i].level]*(i===active?.59:.5)+1;
      return [x-radius,y-radius,x+radius,y+radius];
    })];
    const priority=[active,selected,...sites.map((_,i)=>i)];
    for(const i of new Set(priority)){
      if(i<0)continue;
      const {x,y}=points[i], [w,h]=labelMetrics.sizes[i];
      const gap=sizeByLevel[sites[i].level]/2+7;
      const candidates=[];
      for(const side of [1,-1]){
        const top=side>0?y+gap:y-gap-h;
        for(const align of [.5,.82,.18])candidates.push([x-w*align,top]);
        candidates.push([side>0?x+gap:x-gap-w,y-h/2]);
      }
      const eligible=i===active || i===selected || sites[i].level<3 || width>780 || neighbors[active]?.has(i);
      const fits=([l,t])=>l>=4 && l+w<=width-4 && t>=3 && t+h<=height-3 &&
        !occupied.some(([x1,y1,x2,y2])=>l<x2+1 && l+w>x1-1 && t<y2+1 && t+h>y1-1);
      let placed=null;
      if(eligible && x>=0 && y>=0 && x<=width && y<=height){
        placed=candidates.map(([l,t])=>[clamp(l,4,width-w-4),t]).find(fits);
        // In tight gaps the closest free rectangle touches an obstacle edge.
        if(!placed && (i===active||i===selected)){
          const xs=[clamp(x-w/2,4,width-w-4),4,width-w-4,...occupied.flatMap(r=>[r[0]-w-2,r[2]+2])];
          const ys=[clamp(y-h/2,3,height-h-3),3,height-h-3,...occupied.flatMap(r=>[r[1]-h-2,r[3]+2])];
          let best=Infinity;
          for(const l of xs)for(const t of ys){
            const distance=(l+w/2-x)**2+(t+h/2-y)**2;
            if(distance<best && fits([l,t])){best=distance;placed=[l,t];}
          }
        }
      }
      if(placed){
        const [l,t]=placed;
        labels[i].style.setProperty('--label-x',(l-x)+'px');
        labels[i].style.setProperty('--label-y',(t-y)+'px');
        occupied.push([l,t,l+w,t+h]);
      }
      labels[i].toggleAttribute('data-label-hidden',!placed);
    }
  }

  function setFlag(el,key,value) {
    if(el.dataset[key]!==value)el.dataset[key]=value;
  }
  function draw(time) {
    frame=0;
    const dt=clamp(time-(lastTime||time-16),6,60);
    lastTime=time;
    const previousZoom=zoom;
    if(reduced){
      zoom=target;flight=null;
    }else if(flight){
      flight.startedAt??=time;
      const progress=clamp((time-flight.startedAt)/flight.duration,0,1);
      zoom=blend(flight.start,target,smoothstep(0,1,progress));
      if(progress===1){zoom=target;flight=null;}
    }else if(zoom>=graphZoom && target>=graphZoom){
      // Interpolate magnification in log space so equal wheel travel feels
      // alike at every depth. A pinch already supplies a scale every frame.
      const remaining=Math.log(target/zoom);
      const follow=1-Math.exp(-dt/78);
      zoom=pinch || Math.abs(remaining)<.0005 ? target : zoom*Math.exp(remaining*follow);
    }else {
      zoom=Math.abs(target-zoom)<.001?target:blend(zoom,target,1-Math.exp(-dt/125));
    }
    if(entryWheel.entering && zoom===target){
      entryWheel.settleEntry();
      space.removeAttribute('aria-busy');
    }
    if(layoutDirty || !bounds){bounds=readBounds();layoutDirty=false;}
    if(!bounds || !width || !height)return;
    const frameRect=pointer && space.getBoundingClientRect();
    const lens=clamp((zoom-overview)/(graphZoom-overview),0,1);
    // First push into the actual portrait. Its moving particles then resolve
    // into their map positions, leaving the labels for the latter half.
    poseZoom=Math.min(1,zoom)+.42*smoothstep(0,.62,lens);
    const amount=smoothstep(.075,1,lens);
    shadeNodes(amount);
    const reveal=smoothstep(.32,.83,amount);
    if(zoom<=overview && target<=overview){panX=0;panY=0;}
    if(lastMix!==amount){
      space.style.setProperty('--graph-mix',String(amount));
      space.style.setProperty('--shell-opacity',String(1-smoothstep(.68,1,amount)));
      space.style.setProperty('--node-reveal',String(reveal));
      setFlag(space,'graphVisible',String(reveal>0));
      lastMix=amount;
    }
    const mapOpen=!entryWheel.entering && amount>=.985;
    if(!lastSent || lastSent.poseZoom!==poseZoom)space.style.setProperty('--portrait-zoom',String(poseZoom));
    setFlag(space,'graphStage',amount===0?'surface':mapOpen?'map':'travel');
    setFlag(space,'graphInteractive',String(!entryWheel.entering && amount>.86));
    const {cx,cy,w,h}=bounds;
    const spread=Math.max(1,zoom/graphZoom);
    if(zoomFocus && (previousZoom>=graphZoom || zoom>=graphZoom)) {
      // Keep the map coordinate under a wheel pointer or pinch midpoint fixed
      // as the lens eases, including the last step down to the 210% map.
      const reach=panReach(spread);
      panX=clamp(zoomFocus.x-cx-zoomFocus.mapX*spread,-w*reach,w*reach);
      panY=clamp(zoomFocus.y-cy-zoomFocus.mapY*spread,-h*reach,h*reach);
    }
    if(zoom===target || zoom<graphZoom)zoomFocus=null;
    const targets=sites.map(site=>[(cx+(site.x-.5)*w*spread+panX)/width,(cy+(site.y-.5)*h*spread+panY)/height]);
    const gl=space.closest('.ct-hero[data-scene=ready]:not([data-defer-scene])') && anchors;
    const origins=gl?anchors.map(([u,v])=>[u*width,v*height]):posterAnchors.map(([u,v])=>posterPosition(u,v));
    points=targets.map(([u,v],i)=>({
      x:blend(origins[parents[i]][0],u*width,amount),
      y:blend(origins[parents[i]][1],v*height,amount)
    }));
    // Re-pick against the moving geometry even when the mouse is stationary.
    // A pinned reader keeps its own selection as the pointer inspects other notes.
    const inspecting=mapOpen && !flight;
    const hovered=inspecting && pointer?hit(pointer[0]-frameRect.left,pointer[1]-frameRect.top):-1;
    const preview=hovered>=0?hovered:reveal>0?focused:-1;
    const active=preview>=0?preview:(reveal>0 && (amount>.18 || time-pressedAt<700)?selected:-1);
    if(reveal>0)visiblePress=press;
    setFlag(space,'pointed',String(hovered>=0));

    // Each GPU particle in a group and its DOM node use precisely the same
    // destination and coefficient. Pointer hit testing reads these positions.
    const destinationKey=[cx,cy,w,h,panX,panY,width,height];
    if(!lastSent || zoom!==lastSent.zoom || active!==lastSent.active || visiblePress!==lastSent.press ||
      destinationKey.some((v,i)=>v!==lastSent.key[i])){
      lastSent={zoom,poseZoom,active,press:visiblePress,key:destinationKey};
      space.dispatchEvent(new win.CustomEvent('cortexa-graph',{detail:{mix:amount,entering:entryWheel.entering,targets:targets.slice(0,landmarks.length),activeNode:parents[active]??-1,press:visiblePress,zoom,portraitZoom:poseZoom}}));
    }

    if(context){
      context.setTransform(ratio,0,0,ratio,0,0);
      context.clearRect(0,0,width,height);
      if(amount<1){
        context.globalAlpha=1-amount;
        for(let i=0;i<landmarks.length;i++){
          context.beginPath();
          context.arc(points[i].x,points[i].y,3.5,0,Math.PI*2);
          context.fillStyle=sites[i].color;
          context.fill();
        }
        context.globalAlpha=1;
      }
      const ink=light?'49,59,79':'177,195,219';
      const pointed=inspecting && pointer?[pointer[0]-frameRect.left,pointer[1]-frameRect.top]:null;
      const onCenter=hovered>=0 && pointed && Math.hypot(points[hovered].x-pointed[0],points[hovered].y-pointed[1])<16;
      if(stars.draw(context,{bounds,centers:points,sites,mix:amount,zoom,panX,panY,width,height,light,pointer:pointed,blocked:onCenter}))setFlag(space,'pointed','true');
      const extension=.28+.72*smoothstep(.12,.77,amount);
      if(extension>0) for(const [a,b] of links){
        const connected=a===active || b===active;
        const from=points[a],to=points[b];
        context.beginPath();
        context.moveTo(from.x,from.y);
        context.lineTo(blend(from.x,to.x,extension),blend(from.y,to.y,extension));
        context.strokeStyle=connected?sites[a===active?b:a].color:'rgb('+ink+')';
        context.globalAlpha=extension*(connected?.87:light?.44:.32);
        context.lineWidth=connected?1.7:1;
        context.stroke();
      }
      const pulse=(time-pressedAt)/700;
      if(!reduced && reveal>0 && pulse>=0 && pulse<1 && selected>=0){
        context.beginPath();context.arc(points[selected].x,points[selected].y,9+38*pulse,0,Math.PI*2);
        context.strokeStyle=sites[selected].color;context.globalAlpha=(1-pulse)*reveal*.95;context.lineWidth=2;
        context.stroke();
      }
      context.globalAlpha=1;
    }
    const breathe=Boolean(context && amount===1 && zoom===target && !reduced && !pickerOpen && !drag?.moved && !pinch);
    if(breathe){
      const key=[zoom,...destinationKey,evidenceRevision,selected,light].join('/');
      motion.paint(key,bounds,points,links,sites,stars,width<700);
    }
    motion.running(breathe);
    placeLabels(mapOpen,active);
    markers.forEach((button,i)=>{
      const {x,y}=points[i],hot=i===preview;
      button.style.transform='translate3d('+x+'px,'+y+'px,0) translate(-50%,-50%)';
      button.style.setProperty('--node-scale',String(blend(hot?.76:.38,hot?1.18:1,amount)));
      button.style.setProperty('--node-alpha',String(hot?1:blend(.5,1,amount)));
      setFlag(button,'hot',String(hot));
      setFlag(button,'down',String(i===drag?.node && !drag.moved));
      setFlag(button,'near',String(i===active || (!!neighbors[active]?.has(i) && amount>.12)));
    });
    if(pendingNodeFocus!==null && (mapOpen || target===overview)){
      const index=pendingNodeFocus;pendingNodeFocus=null;
      if(mapOpen && doc.activeElement===space && selected===index)focusNode(index);
    }
    if(zoom!==target || (!reduced && time-pressedAt<700))requestPaint();
    else lastTime=0;
  }

  function focusAt(x,y) {
    if(!bounds || zoom<graphZoom)return null;
    const scale=zoom/graphZoom;
    return {x,y,mapX:(x-bounds.cx-panX)/scale,mapY:(y-bounds.cy-panY)/scale};
  }

  function setZoom(value,focus=null) {
    if(entryWheel.entering || !Number.isFinite(value))return;
    const next=clamp(value,minZoom,maxZoom);
    if(Math.abs(target-next)<.0001){
      if(pinch && focus){zoomFocus=focus;requestPaint();}
      return;
    }
    zoomFocus=bounds && zoom>=graphZoom?(focus??focusAt(bounds.cx,bounds.cy)):null;
    const crossesPortrait=(next===graphZoom && zoom<graphZoom-.12) || (next===overview && zoom>overview+.12);
    if(crossesPortrait && next===graphZoom){
      entryWheel.beginEntry();
      space.setAttribute('aria-busy','true');
      finishDrag(true);pinch=null;
    }
    flight=!reduced && crossesPortrait?{start:zoom,startedAt:null,duration:clamp(365+Math.abs(zoom-next)*715,400,1160)}:null;
    target=next;
    onZoomChange?.(next);
    requestPaint();
  }

  function pan(dx,dy) {
    if (!bounds || zoom<1.57) return;
    zoomFocus=null;
    const reach=panReach(zoom/graphZoom);
    panX=clamp(panX+dx,-bounds.w*reach,bounds.w*reach);
    panY=clamp(panY+dy,-bounds.h*reach,bounds.h*reach);
    requestPaint();
  }

  function inSurface(el) {
    if (el.closest?.('.ct-note-panel,.ct-tools,.ct-next')) return false;
    return !(el.closest?.('button,a,input,textarea,select,nav') && !el.closest('.neuron'));
  }
  const scrollport=space.closest('#product-page');
  let heldDirection=0,lastWheelAt=-Infinity,wheelOrigin=null,reverseTravel=0;
  function resetWheel(){
    entryWheel.reset();heldDirection=0;lastWheelAt=-Infinity;wheelOrigin=null;reverseTravel=0;
  }
  function zoomByWheel(event) {
    const unit=event.deltaMode===1?24:event.deltaMode===2?height:1;
    const pixels=event.deltaY*unit, direction=Math.sign(pixels), now=event.timeStamp;
    const detent=event.deltaMode!==0 || (pixels!==0 && Number.isInteger(pixels) &&
      (pixels%100===0 || pixels%120===0));
    if(entryWheel.holdWheel(now,pixels,detent)){
      event.preventDefault();
      return;
    }
    if(!pixels || event.shiftKey || (!event.ctrlKey && Math.abs(event.deltaY)<Math.abs(event.deltaX)))return;
    const surface=inSurface(event.target) && !event.target.closest?.('dialog');
    const gap=now-lastWheelAt,previousDirection=heldDirection;
    // The newly opened reader can appear underneath the original pointer.
    // Finish consuming that gesture before the reader or page can scroll.
    if(!event.ctrlKey && heldDirection===direction && (flight || gap<180)){
      lastWheelAt=now;reverseTravel=0;event.preventDefault();return;
    }
    const readerUnderOrigin=flight && previousDirection && wheelOrigin && event.target.closest?.('.ct-note-panel') &&
      Math.hypot(event.clientX-wheelOrigin[0],event.clientY-wheelOrigin[1])<=8;
    const scrollLimit=target<=overview?1:Math.min(48,height*.08);
    if((!surface && !readerUnderOrigin) || pickerOpen || (!event.ctrlKey && (scrollport?.scrollTop??0)>scrollLimit)){
      resetWheel();return;
    }
    lastWheelAt=now;heldDirection=0;
    if(!event.ctrlKey && flight){
      // Only the return flight can reverse. Every entry is committed.
      event.preventDefault();
      const flightDirection=previousDirection || 1;
      heldDirection=flightDirection;
      reverseTravel=direction===flightDirection?0:reverseTravel+Math.abs(pixels);
      if(reverseTravel>=6){
        setZoom(graphZoom);
        heldDirection=direction;reverseTravel=0;
      }
      return;
    }
    if(!event.ctrlKey && target<=overview){
      const confirmed=entryWheel.up(now,pixels,detent);
      // At the portrait, scrolling down belongs to the page and its lower layers.
      if(direction>0)return;
      event.preventDefault();
      if(confirmed){
        space.focus({preventScroll:true});
        heldDirection=direction;reverseTravel=0;wheelOrigin=[event.clientX,event.clientY];
        const node=hit(...localPoint(event));
        if(node>=0)activate(node);else setZoom(graphZoom);
      }
      return;
    }
    entryWheel.reset();
    const delta=clamp(pixels,-240,240);
    const inMap=target>=graphZoom && zoom>=graphZoom;
    // On reversal, start at the visible scale rather than unwinding queued ticks.
    const from=inMap && direction*(target-zoom)>0?zoom:target;
    const gain=event.ctrlKey ? .01 : (inMap ? .00165 : .0039);
    let next=clamp(from*Math.exp(-delta*gain),minZoom,maxZoom);
    // Inside the map retain ordinary wheel zoom. Crossing its lower edge
    // returns to the portrait in one flight, without parking between views.
    if(!event.ctrlKey && direction>0 && next<graphZoom){
      next=target>graphZoom?graphZoom:overview;
      if(next===overview)heldDirection=direction;
    }
    if(Math.abs(next-target)<.0001){
      if(event.ctrlKey || inMap)event.preventDefault();
      return;
    }
    event.preventDefault();
    setZoom(next,focusAt(...localPoint(event)));
  }
  listen(space,'wheel',zoomByWheel,{passive:false,capture:true});

  // Controls, the reader and plot share this surface. Catch their activation
  // before delegated and native handlers, including a press released on arrival.
  let heldPress=false;
  const sceneKeys=new Set(['+', '=', '-', '0', ' ', 'Enter', 'Escape', 'Tab',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
  function guardEntry(event){
    if(event.type==='pointerdown')heldPress=entryWheel.entering;
    const carriedClick=event.type==='click' && event.detail>0 && heldPress;
    if(!entryWheel.entering && !carriedClick)return;
    if(event.type==='keydown' && (event.metaKey || event.ctrlKey || event.altKey || !sceneKeys.has(event.key)))return;
    if(event.type==='click')heldPress=false;
    if(event.cancelable)event.preventDefault();
    event.stopImmediatePropagation();
  }
  for(const event of ['click','pointerdown','touchstart','touchmove','keydown']){
    listen(space,event,guardEntry,{capture:true,passive:false});
  }

  listen(space,'pointerdown',event=>{
    if(event.button!==0 || !event.isPrimary)return;
    resetWheel();
    if(!inSurface(event.target))return;
    skipClick=false;
    focused=-1;
    drag={id:event.pointerId,node:hit(...localPoint(event)),x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,captured:false};
    trackPointer(event);requestPaint();
  });
  listen(space,'pointermove',event=>{
    if(entryWheel.entering)return;
    if(drag?.id===event.pointerId && (event.buttons===0 || (drag.captured && !space.hasPointerCapture(event.pointerId))))finishDrag(true);
    if(!inSurface(event.target)){trackPointer();return;}
    if(drag && drag.id===event.pointerId && !pinch){
      if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>5)drag.moved=true;
      if(drag.moved && lastMix>.85){
        if(!drag.captured){space.setPointerCapture(event.pointerId);drag.captured=true;}
        pan(event.clientX-drag.x,event.clientY-drag.y);
        trackPointer();
      }
      drag.x=event.clientX;drag.y=event.clientY;
      return;
    }
    trackPointer(event);
  });
  listen(space,'pointerleave',()=>{resetWheel();trackPointer();});
  function finishDrag(cancelled) {
    if(!drag)return;
    const {id,moved}=drag;
    skipClick=cancelled || moved;
    drag=null;
    if(space.hasPointerCapture(id))space.releasePointerCapture(id);
    requestPaint();
  }
  function endDrag(event) {
    if(drag?.id!==event.pointerId)return;
    finishDrag(event.type!=='pointerup');
  }
  listen(win,'pointerup',endDrag,{capture:true});
  listen(win,'pointercancel',endDrag,{capture:true});
  listen(space,'lostpointercapture',event=>{if(event.target===space)endDrag(event);});
  function cancelInput(){resetWheel();finishDrag(true);pinch=null;trackPointer();}
  listen(win,'blur',cancelInput);
  listen(space,'click',event=>{
    if(!inSurface(event.target) || (skipClick && event.detail!==0) || pinch)return;
    const button=event.target.closest?.('.neuron');
    if(button && event.target===button.querySelector('span')){
      stars.clear();evidenceRevision++;activate(markers.indexOf(button));return;
    }
    // On a narrow portrait two generous button hit boxes can overlap. Use
    // the same nearest vertex as hover; keyboard activation keeps its focus.
    const nearest=hit(...localPoint(event));
    const [x,y]=localPoint(event);
    if(lastMix>.985 && event.detail!==0 && !(button && nearest>=0 && Math.hypot(points[nearest].x-x,points[nearest].y-y)<17)
      && stars.pick(x,y,event.pointerType==='touch')){evidenceRevision++;requestPaint();return;}
    stars.clear();evidenceRevision++;
    const index=button && event.detail===0?markers.indexOf(button):nearest;
    activate(index);
  });
  const gap=touches=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
  function midpoint(touches) {
    const rect=space.getBoundingClientRect();
    return [(touches[0].clientX+touches[1].clientX)/2-rect.left,(touches[0].clientY+touches[1].clientY)/2-rect.top];
  }
  listen(space,'touchstart',event=>{
    if (event.touches.length!==2 || !inSurface(event.target)) return;
    event.preventDefault(); finishDrag(true);skipClick=true;trackPointer();
    pinch={zoom,distance:Math.max(1,gap(event.touches)),focus:focusAt(...midpoint(event.touches))};
  },{passive:false,capture:true});
  listen(space,'touchmove',event=>{
    if (!pinch || event.touches.length!==2) return;
    event.preventDefault();
    const [x,y]=midpoint(event.touches);
    if(!pinch.focus)pinch.focus=focusAt(x,y);
    setZoom(pinch.zoom * gap(event.touches)/pinch.distance,pinch.focus && {...pinch.focus,x,y});
  },{passive:false,capture:true});
  function endPinch(event) {if(event.touches.length<2)pinch=null;}
  listen(space,'touchend',endPinch);listen(space,'touchcancel',endPinch);
  const picker=space.querySelector('[data-asset-picker]');
  function focusNode(index) {
    markers[index].focus({preventScroll:true});
    focused=index;trackPointer();
    // A panned map can put keyboard targets outside the plot or behind its
    // reader. Reveal the dot with the camera, preserving the selected note.
    if(zoom>graphZoom || panX || panY){
      const {x,y}=points[index],{cx,cy,w,h}=bounds;
      const margin=Math.min(25,w/5,h/5);
      const dx=clamp(x,cx-w/2+margin,cx+w/2-margin)-x;
      const dy=clamp(y,cy-h/2+margin,cy+h/2-margin)-y;
      if(dx || dy)pan(dx,dy);
    }
    requestPaint();
  }
  listen(space,'keydown',event=>{
    if(event.metaKey || event.ctrlKey)return;
    resetWheel();
    const index=markers.indexOf(event.target);
    if(event.key==='Tab' && lastMix>=.985){
      let next=-1;
      if(index>=0)next=index+(event.shiftKey?-1:1);
      else if(event.target===space && !event.shiftKey)next=0;
      else if(event.target===picker && event.shiftKey)next=markers.length-1;
      if(markers[next]){event.preventDefault();focusNode(next);}
      return;
    }
    if(event.altKey || !inSurface(event.target))return;
    if(index>=0){focused=index;trackPointer();requestPaint();}
    const arrows={ArrowLeft:[35,0],ArrowRight:[-35,0],ArrowUp:[0,35],ArrowDown:[0,-35]};
    if (event.key==='+' || event.key==='=') setZoom(nextZoomStep(target,1));
    else if (event.key==='-') setZoom(nextZoomStep(target,-1));
    else if (event.key==='0') setZoom(overview);
    else if (arrows[event.key] && target>=1.58) pan(...arrows[event.key]);
    else return;
    event.preventDefault();
  });
  markers.forEach((button,i)=>{
    listen(button,'focus',()=>{
      focused=button.matches(':focus-visible')?i:-1;
      if(focused>=0)trackPointer();
      requestPaint();
    });
    listen(button,'blur',()=>{if(focused===i)focused=-1;requestPaint();});
  });

  function updateTheme() {
    light=doc.documentElement.dataset.theme==='light';
    lastTint=-1;
    for(const [name,tones] of Object.entries(cortexaTones))space.style.setProperty('--memory-'+name,tones[light?1:0]);
    reduced=Boolean(forceReduced || mq.matches || doc.documentElement.dataset.reducedMotion==='true');
    layoutDirty=true;requestPaint();
  }
  const theme=new MutationObserver(updateTheme);
  theme.observe(doc.documentElement,{attributes:true,attributeFilter:['data-theme','data-reduced-motion']});
  // Only layout changes need computed insets. Camera frames change the visual
  // properties of this same element many times before the reader moves.
  listen(space.closest('astarter-brain'),'cortexa-picker',event=>{
    pickerOpen=Boolean(event.detail);
    if(pickerOpen){resetWheel();motion.running(false);}
    requestPaint();
  });
  listen(space,'cortexa-layout',()=>{layoutDirty=true;requestPaint();});
  const size=new ResizeObserver(scheduleResize);size.observe(space);
  listen(win,'resize',scheduleResize,{passive:true});
  const visibility=new IntersectionObserver(entries=>{
    visible=entries.at(-1).isIntersecting;
    if(visible) {lastTime=0;layoutDirty=true;requestPaint();}
    else {motion.running(false);win.cancelAnimationFrame(frame);frame=0;}
  });
  visibility.observe(space);
  listen(doc,'scroll',()=>{
    if(!pointer)return;
    const underPointer=doc.elementFromPoint(...pointer);
    if(!underPointer || !space.contains(underPointer) || !inSurface(underPointer))trackPointer();
    else requestPaint();
  },{capture:true,passive:true});
  listen(doc,'visibilitychange',()=>{
    if(doc.hidden) {motion.running(false);cancelInput();win.cancelAnimationFrame(frame);frame=0;}
    else {lastTime=0;requestPaint();}
  });
  listen(mq,'change',updateTheme);
  updateTheme();resize();
  return {
    setZoom,
    openNode(index){
      if(entryWheel.entering || !markers[index])return;
      stars.clear();evidenceRevision++;
      space.focus({preventScroll:true});pendingNodeFocus=index;
      activate(index);
    },
    stepZoom(direction){setZoom(nextZoomStep(target,direction));},
    setEvidence(rows,onInspect){inspectEvidence=onInspect;stars.setData(rows);evidenceRevision++;requestPaint();},
    focusEvidence(id,child){stars.focusRecord(id,child);evidenceRevision++;requestPaint();},
    setState(index) {if(selected!==index){selected=index;stars.setBranch(index);requestPaint();}},
    dispose() {
      disposed=true;win.cancelAnimationFrame(frame);win.cancelAnimationFrame(resizeFrame);abort.abort();
      motion.dispose();stars.dispose();size.disconnect();visibility.disconnect();theme.disconnect();labelContent.disconnect();
    }
  };
}
