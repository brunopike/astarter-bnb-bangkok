import {createCoreReports} from './core-reports.mjs';
import {createAgentFloor} from './agent-floor.mjs';
import {createSceneAudio} from './scene-audio.mjs';
import {t as localize} from './locale.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {COLLAB_SCENES,sceneWork,sceneMarket,coordinationForRole,coordinationPhase,meetingCenters,collaborationPosition,avoidMeetingTable,agentReaction} from './coordination.mjs';
import { evidenceProcess, EVIDENCE_ENDS } from './evidence-process.mjs';
import { ROLES } from './simulation.mjs';
import {collectionSource,createCollectionBeams,courierFigure} from './collection-motion.mjs';

const TAU=Math.PI*2,NS='http://www.w3.org/2000/svg';
const SOURCE_NAMES={macro:'宏观',social:'舆情',chain:'链上',depth:'盘口',trend:'趋势',volatility:'波动',volume:'量价',spread:'价差',risk:'风控'};
const ROLE_SOURCES=['trend','trend','trend','volume','depth','volatility','trend','volume','risk','risk','risk','volatility','risk','depth','risk','spread','volatility','volume'];
const labels=['前往采集','读取数据','带回证据','核心汇入','证据交接','继续采集'];
const roleTags=['环境','趋势','形态','量价','盘口','异常','规则','做多','减仓','反证','等待','推演','决策','敞口','保护','执行','诊断','复盘'];
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
function travel(a,b,t,bend=0){const p=mix(a,b,smooth(t)),dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy)||1,s=Math.sin(Math.PI*t)*bend;return {x:p.x-dy/l*s,y:p.y+dx/l*s};}
// Couriers share the simulation clock. No independent CSS animation or timers.
export function createCouriers(container,{onSelect,colorFor,corePoint,handoffPoint,useAgentModel=false,scope=null}){
  const workspace=scope||document.querySelector('.workspace'),stage=scope||document.querySelector('.network-stage'),surface=scope||document.body;
  const layer=document.createElement('div');layer.className='reactor-courier-layer';layer.setAttribute('aria-label','Agent 数据采集与交接');
  const svg=document.createElementNS(NS,'svg');svg.setAttribute('class','reactor-courier-trails');svg.setAttribute('aria-hidden','true');layer.append(svg);workspace.append(layer);
  const furniture=document.createElementNS(NS,'svg');furniture.setAttribute('class','courier-meeting-tables');furniture.setAttribute('aria-hidden','true');layer.prepend(furniture);
  const sceneAudio=scope?null:createSceneAudio(stage.querySelector('.stage-controls'));
  const collectionBeams=createCollectionBeams(layer,scope||document);
  let floorReduced=false;
  let coreReceipt=null,currentModel=null;
  const deviceFrames=new Map();
  const acceptedPapers=new Set(),reportCore=createCoreReports();
  const paperKey=p=>p.event?.id?`evidence:${p.event.id}`:p.job?`job:${p.job.id}`:'';
  const report=document.createElement('div');report.className='core-report';report.setAttribute('role','status');report.setAttribute('aria-live','polite');report.hidden=true;
  report.innerHTML='<small>SIM</small><span></span>';layer.append(report);
  let coordination=[],actorIds=[],executionIds=[],agents=[],identity='',geometry=null,previousLayout=-99,selected=4,visual={labels:true,paths:true},snapshots=[],process=null;
  const agentFloor=useAgentModel?createAgentFloor(layer,()=>{previousLayout=-99;}):null;
  const paths=[],documents=[];
  const payloadSvg=document.createElementNS(NS,'svg');payloadSvg.setAttribute('class','reactor-courier-payloads');payloadSvg.setAttribute('aria-hidden','true');layer.append(payloadSvg);
  function rebuild(model){
    identity=model.key+model.config.actors.join();acceptedPapers.clear();for(const a of agents)a.el.remove();svg.replaceChildren();payloadSvg.replaceChildren();paths.length=documents.length=0;
    agents=ROLES.map((role,index)=>{
      const id=role.index;
      const el=document.createElement('button');el.type='button';el.className='agent-courier';el.dataset.agentRole=String(id);el.style.setProperty('--agent-color',colorFor(id));el.setAttribute('aria-label',`聚焦 ${ROLES[id].id} ${ROLES[id].name}`);
      el.innerHTML='<span class="courier-duty" aria-hidden="true"></span><span class="courier-reaction" aria-hidden="true"></span>' + courierFigure + '<span class="courier-caption"><b>'+ROLES[id].id+'</b><strong>'+roleTags[id]+'</strong><small>前往采集</small></span>';
      el.onclick=()=>onSelect?.(id,false);layer.append(el);
      const path=document.createElementNS(NS,'path');path.setAttribute('fill','none');path.setAttribute('stroke',colorFor(id));path.style.color=colorFor(id);path.setAttribute('stroke-width','1.15');svg.append(path);paths.push(path);
      const paper=document.createElementNS(NS,'g');paper.classList.add('courier-document');paper.style.color=colorFor(id);
      paper.innerHTML='<rect x="-6" y="-9" width="15" height="20" rx="2" fill="var(--surface)" stroke="currentColor" opacity=".65" transform="rotate(9)"/><path d="M-9-12 H3 L8-7 V9 Q8 11 6 11 H-7 Q-9 11-9 9Z" fill="var(--surface)" stroke="currentColor" stroke-width="1.6"/><path d="M3-12 V-7 H8 M-5-3 H3 M-5 1 H3 M-5 5 H0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
      const seal=document.createElementNS(NS,'text');seal.setAttribute('x','11');seal.setAttribute('y','-6');seal.setAttribute('font-size','11');seal.setAttribute('fill','currentColor');seal.classList.add('document-seal');paper.append(seal);
      payloadSvg.append(paper);documents.push(paper);
      return {id,index,el,caption:el.querySelector('small')};
    });
  }
  function readLayout(t,force=false){
    if(!force&&geometry&&t-previousLayout>=0&&t-previousLayout<.18)return;
    previousLayout=t;
    const wr=workspace.getBoundingClientRect(),cr=container.getBoundingClientRect(),sr=stage.getBoundingClientRect(),consoleRect=scope?wr:document.querySelector('.console-panel').getBoundingClientRect();
    const mobile=wr.width<=900,width=scope||mobile?wr.width:consoleRect.left-wr.left,height=wr.height;
    layer.style.width=width+'px';if(surface.dataset.multiResearch==='true')layer.style.clipPath=`inset(0 0 ${Math.max(0,height-(cr.bottom-wr.top))}px 0)`;svg.setAttribute('viewBox',`0 0 ${width} ${height}`);payloadSvg.setAttribute('viewBox',`0 0 ${width} ${height}`);furniture.setAttribute('viewBox',`0 0 ${width} ${height}`);
    const sources=[];
    for(const el of (scope||document).querySelectorAll('[data-collector-source]')){
      const r=el.getBoundingClientRect();if(r.width<1||r.height<1)continue;
      const parent=el.closest('.status-panel,.reactor-source-dock,.terminal-flow,.terminal-analytics,.reactor-bottom-grid')||stage,pr=parent.getBoundingClientRect();
      const left=Math.max(r.left,pr.left,sr.left,wr.left),right=Math.min(r.right,pr.right,sr.right,wr.left+width),top=Math.max(r.top,pr.top,sr.top,wr.top),bottom=Math.min(r.bottom,pr.bottom,sr.bottom,wr.bottom);
      if(right-left<30||bottom-top<15)continue;
      const dock=el.classList.contains('reactor-source-chip');
      const lower=Boolean(el.dataset.collectorIntent),inset=lower||dock&&mobile;
      sources.push({key:el.dataset.collectorSource,zone:el.dataset.collectorZone,asset:el.dataset.collectorAsset,intent:el.dataset.collectorIntent,roles:(el.dataset.collectorRoles||'').split(',').filter(Boolean).map(Number),lower,inset,box:{x:left-wr.left,y:top-wr.top,width:right-left,height:bottom-top},el,x:inset?right-wr.left-18:el.dataset.collectorZone?(left+right)/2-wr.left:dock?(left+right)/2-wr.left:right-wr.left-18,y:inset?top-wr.top+18:el.dataset.collectorZone?top-wr.top+14:dock?bottom-wr.top+12:(top+bottom)/2-wr.top});
    }
    const core=corePoint();
    // Scrolling changes screen coordinates even while the shared motion clock is paused.
    if(geometry&&(Math.abs(geometry.width-width)>2||Math.abs(geometry.cr.width-cr.width)>2||Math.abs(geometry.cr.height-cr.height)>2||geometry.cr.top!==cr.top||geometry.cr.left!==cr.left)){for(const a of agents){a.lastPoint=null;a.trail=[];}}
    geometry={width,height,mobile,wr,cr,sr,core:{x:cr.left-wr.left+core.x,y:cr.top-wr.top+core.y},sources};
  }
  function targetFor(id,cycle){
    const key=agents.find(a=>a.id===id)?.sourceKey||ROLE_SOURCES[id];
    const available=geometry.sources.filter(s=>!s.lower&&s.key===key);
    return available.length?available[((cycle%available.length)+available.length)%available.length]:{key:ROLE_SOURCES[id],offscreen:true,x:geometry.core.x+Math.sin(id*2.4)*65,y:Math.max(24,geometry.cr.top-geometry.wr.top+20)};
  }
  function home(index,t){
    const id=agents[index].id;
    if(surface.dataset.multiResearch==='true'){
      const g=RESEARCH_GROUPS.find(g=>g.roles.includes(id)),station=RESEARCH_GROUPS.indexOf(g),slot=g.roles.indexOf(id);
      const center=meetingCenters({width:geometry.cr.width,height:geometry.cr.height,core:geometry.core,mobile:geometry.mobile})[station];
      return collaborationPosition(center,station,slot,3,geometry.mobile,t);
    }
    if(!actorIds.includes(id)&&!executionIds.includes(id)){
      const rest=agents.filter(a=>!actorIds.includes(a.id)&&!executionIds.includes(a.id)),slot=rest.findIndex(a=>a.id===id),side=slot%2?1:-1,row=Math.floor(slot/2),rows=Math.ceil(rest.length/2),gap=geometry.mobile?27:37;
      return {x:geometry.core.x+side*(Math.min(geometry.cr.width*.40,290)-Math.pow((row-(rows-1)/2)/Math.max(1,rows/2),2)*(geometry.mobile?15:40))+Math.sin(t*.3+id)*5,y:geometry.core.y+(row-(rows-1)/2)*gap+Math.cos(t*.35+id)*3};
    }
    const active=[...new Set([...actorIds,...executionIds])],offset=active.indexOf(id),a=offset/active.length*TAU+.4,rx=Math.min(geometry.cr.width*.31,210),ry=Math.min(geometry.cr.height*.28,105),c=geometry.core;
    return {x:c.x+Math.cos(a)*rx+Math.sin(t*.43+index)*18,y:c.y+Math.sin(a)*ry+Math.cos(t*.37+index)*15};
  }
  function sample(index,t,events){
    const agent=agents[index],event=agent.id===12?null:events.find(e=>e.from===agent.id&&e.at<=t&&e.at>=cycleStart);
    const age=event?Math.max(0,t-event.at):99,stage=EVIDENCE_ENDS.findIndex(end=>age<end),phase=stage<0?5:stage,begin=phase?EVIDENCE_ENDS[phase-1]:0;
    const state={phase,p:phase===5?1:(age-begin)/(EVIDENCE_ENDS[phase]-begin),cycle:Math.floor(t/24),event};
    agent.sourceKey=state.event?.source;
    const start=home(index,t+motionOffset),source=targetFor(agent.id,state.cycle),dest={x:source.x,y:source.y},gate={x:geometry.core.x+Math.cos(index*2.399)*Math.min(110,geometry.cr.width*.25),y:geometry.core.y+Math.sin(index*2.399)*Math.min(88,geometry.cr.height*.26)};
    let point=start;let job=null,workPhase=null,meeting=null,leader=false;
    if(phase===0)point=travel(start,dest,state.p,index%2?25:-25);
    else if(phase===1)point={x:dest.x+Math.sin(state.p*TAU)*3,y:dest.y+Math.sin(state.p*Math.PI)*-6};
    else if(phase===2)point=travel(dest,gate,state.p,index%2?-32:32);
    else if(phase===3)point={x:gate.x,y:gate.y-Math.sin(state.p*Math.PI)*8};
    else if(phase===4)point=travel(gate,start,smooth(Math.max(0,(state.p-.12)/.88)),14);
    if(phase===5){job=coordinationForRole(coordination,agent.id);if(job){
      const u=job.progress,slot=job.roles.indexOf(agent.id),count=job.roles.length;
      leader=slot===0;workPhase=coordinationPhase(job,leader);
      const lane=job.station??({macro:0,trend:3,risk:5,social:1,volume:1,volatility:4,chain:2,depth:2,spread:2}[job.source]??0);
      const c=geometry.core,centers=meetingCenters({width:geometry.cr.width,height:geometry.cr.height,core:c,mobile:geometry.mobile});
      meeting=centers[lane];
      const spacing=geometry.mobile?35:47,offset=(slot-(count-1)/2)*spacing;
      const meet=collaborationPosition(meeting,lane,slot,count,geometry.mobile,t+motionOffset);
      const src=collectionSource(geometry.sources,job,agent.id,source);
      agent.jobSource=src;const sampleAt={x:src.x+(src.inset?0:offset*.35),y:src.y};
      const theta=Math.atan2(meeting.y-c.y,meeting.x-c.x),drop={x:c.x+Math.cos(theta)*88,y:c.y+Math.sin(theta)*88};
      if(job.route==='direct'){
        if(workPhase==='visit')point=travel(start,sampleAt,u/.12,18);
        else if(workPhase==='deliver')point=travel(sampleAt,drop,(u-.16)/.22,-22);
        else if(workPhase==='submit')point=drop;
        else point=travel(drop,start,(u-.66)/.34,20);
      }else if(workPhase==='review'||workPhase==='await')point={x:meet.x,y:meet.y+Math.sin((t+motionOffset)*1.6+slot)*1.4};
      else if(workPhase==='visit')point=travel(start,sampleAt,u/.12,18);
      else if(workPhase==='meet')point=travel(sampleAt,meet,(u-.16)/.16,slot%2?-22:22);
      else if(workPhase==='discuss')point={x:meet.x,y:meet.y+Math.sin(u*36+slot)*1.3};
      else if(workPhase==='deliver')point=travel(meet,drop,(u-.67)/.13,-12);
      else if(workPhase==='submit')point=drop;
      else point=travel(leader?drop:meet,start,(u-(leader ? .92 : .67))/(leader ? .08 : .33),12);
    }}
    const work=sceneWork(job,agent.id);
    if(work?.kind==='data-center'&&leader&&meeting){
      const deskScale=geometry.mobile?.66:.90,rack={x:meeting.x-43*deskScale,y:meeting.y+5};
      if(work.q<.12)point=travel(point,rack,work.q/.12);
      else if(work.q<.38)point=rack;
      else if(work.q<.5)point=travel(rack,point,(work.q-.38)/.12);
    }
    const coreWaiting=coreReceipt?.id===agent.id&&!['dispatch','handoff','collaborate','resume'].includes(coreReceipt.stage);
    if(coreWaiting)point={x:coreReceipt.origin.x+geometry.cr.left-geometry.wr.left,y:coreReceipt.origin.y+geometry.cr.top-geometry.wr.top};
    point.x=Math.max(23,Math.min(geometry.width-23,point.x));if(surface.dataset.multiResearch!=='true')point.y=Math.max(23,Math.min(geometry.height-38,point.y));
    return {...state,point,work,coreWaiting,source:job?(agent.jobSource||source):source,gate,job,workPhase,meeting,leader,gateAngle:Math.atan2(gate.y-geometry.core.y+6,gate.x-geometry.core.x+15),id:agent.id,next:12};
  }
  function applyFollowup(poses){
    const r=coreReceipt;if(!r||!['dispatch','handoff','collaborate','resume'].includes(r.stage)||!r.team?.peers.length)return;
    const roles=[r.id,...r.team.peers];
    if(roles.some(id=>poses.some(p=>p.id===id&&((p.event&&p.event.id!==r.context.event?.id&&p.phase<4)||(p.job?.business||/^(risk-|order-|review-)/.test(p.job?.id||''))))))return;
    const meeting=meetingCenters({width:geometry.cr.width,height:geometry.cr.height,core:geometry.core,mobile:geometry.mobile})[r.team.station];
    const spacing=geometry.mobile?35:47;
    for(const [slot,id]of roles.entries()){
      const pose=poses.find(p=>p.id===id);if(!pose)continue;
      const destination=collaborationPosition(meeting,r.team.station,slot,roles.length,geometry.mobile,gestureTime);
      if(r.stage==='dispatch'){
        const origin=id===r.id?{x:r.origin.x+geometry.cr.left-geometry.wr.left,y:r.origin.y+geometry.cr.top-geometry.wr.top}:pose.point;
        pose.point=travel(origin,destination,r.progress,slot%2?-13:13);
      }else if(r.stage==='resume')pose.point=travel(destination,pose.point,r.progress,12);
      else pose.point=destination;
      pose.followup={key:r.key,roles};pose.coreWaiting=false;pose.workPhase=r.stage;pose.meeting=meeting;pose.leader=id===r.id;
      pose.job={...(r.context.job||{}),id:r.key,roles,station:r.team.station,mode:r.team.station>=4?'desk':'field',source:r.context.event?.source||r.context.job?.source||ROLE_SOURCES[id],title:'复核核心返回的任务',trigger:r.key,taskType:'review',progress:1};
      // The real research event remains unmodified; this pose is only the returned task.
      pose.phase=5;
    }
  }
  function drawFollowupDocument(r){
    const sender=snapshots.find(p=>p.id===r.id),receiver=snapshots.find(p=>p.id===r.team.peers[0]);if(!sender||!receiver)return;
    const hand=(p,other)=>agentFloor?.hand(p.id,other.point)||({x:p.point.x+(Math.sign(other.point.x-p.point.x)||1)*16,y:p.point.y+7});
    const from=hand(sender,receiver),to=hand(receiver,sender),el=documents[r.id];
    let pos=from,rotation=-8;
    if(r.stage==='handoff'){const u=smooth(Math.max(0,Math.min(1,(r.progress-.18)/.64)));pos=travel(from,to,u,-8);rotation=-8+16*u;}
    if(r.stage==='collaborate'||r.stage==='resume'){pos=to;rotation=8;}
    const tuck=r.stage==='resume'?smooth(Math.max(0,(r.progress-.25)/.65)):0;
    el.style.display='';el.setAttribute('transform',`translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)}) rotate(${rotation}) scale(${(geometry.mobile?.78:1.02)*(1-tuck*.6)})`);el.setAttribute('opacity',String(1-tuck));
    Object.assign(el.dataset,{from:String(r.id),to:String(receiver.id),motion:'task-'+r.stage,receipt:r.key,job:r.context.job?.id||'',evidence:r.context.event?.id||''});
  }
  let cycleStart=0,motionOffset=0,gestureTime=0,gestureLast=0,gestureEpoch=null;
  function update(model,{reducedMotion=false,stopped=false,running=true,motionTime=model.elapsed,ambient=false}={}){
    floorReduced=reducedMotion;
    if(identity!==model.key+model.config.actors.join())rebuild(model);
    coordination=model.coordinationJobs||[];actorIds=model.config.actors;executionIds=model.visualRoles||[];
    const t=model.elapsed;motionOffset=motionTime-t;cycleStart=model.cycle*24;process=evidenceProcess(model);readLayout(t);if(!geometry)return [];
    layer.hidden=!scope&&window.innerWidth<=900&&document.body.dataset.mobileView!=='network';
    for(const source of geometry.sources){source.el.removeAttribute('data-collector-agent');source.el.removeAttribute('data-collecting');}
    currentModel=model;
    if(gestureEpoch!==model.epoch){acceptedPapers.clear();deviceFrames.clear();coreReceipt=null;gestureEpoch=model.epoch;gestureTime=motionTime;gestureLast=motionTime;}
    gestureTime+=Math.max(0,motionTime-gestureLast)*(model.completed?2.5:1);gestureLast=motionTime;
    const events=model.events.filter(e=>e.from!==null),poses=agents.map((_,i)=>sample(i,t,events)),captionBoxes=[];
    applyFollowup(poses);
    const evidenceBoxes=[];
    for(let i=0;i<poses.length;i++){const a=agents[i],p=poses[i].point;if(a.lastPoint&&a.lastMotion!==undefined&&!reducedMotion){if(a.lastStation!==poses[i].job?.station){a.routeSince=motionTime;a.lastStation=poses[i].job?.station;}const dt=Math.max(0,motionTime-a.lastMotion),blend=1-Math.exp(-dt*(motionTime-(a.routeSince??-99)<2?2:ambient?26:14));p.x=a.lastPoint.x+(p.x-a.lastPoint.x)*blend;p.y=a.lastPoint.y+(p.y-a.lastPoint.y)*blend;}a.lastMotion=motionTime;}
    // Maintain room around the face and separate passing couriers deterministically.
    for(const pose of poses){const p=pose.point,dx=p.x-geometry.core.x,dy=p.y-geometry.core.y,d=Math.hypot(dx,dy),radius=Math.max(51,Math.min(72,geometry.cr.height*.15+23));if(d<radius){const a=d>.01?Math.atan2(dy,dx):pose.id*2.399;p.x=geometry.core.x+Math.cos(a)*radius;p.y=geometry.core.y+Math.sin(a)*radius;}}
    for(let pass=0;pass<2;pass++)for(let i=0;i<poses.length;i++)for(let j=i+1;j<poses.length;j++){const a=poses[i].point,b=poses[j].point,dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);if(d<34){const angle=d>.01?Math.atan2(dy,dx):i*2.399,push=(34-d)*.5;a.x-=Math.cos(angle)*push;a.y-=Math.sin(angle)*push;b.x+=Math.cos(angle)*push;b.y+=Math.sin(angle)*push;}}
    // Both resting bodies and travelling couriers walk around the two review desks.
    if(surface.dataset.multiResearch==='true'){
      const desks=meetingCenters({width:geometry.cr.width,height:geometry.cr.height,core:geometry.core,mobile:geometry.mobile}).slice(4);
      for(const pose of poses)for(const desk of desks)pose.point=avoidMeetingTable(pose.point,desk,geometry.mobile);
    }
    const reactions=new Map(reducedMotion?[]:poses.map(p=>[p.id,agentReaction(p,gestureTime,coreReceipt)]).filter(([,r])=>r).sort((a,b)=>b[1].priority-a[1].priority||a[0]-b[0]).slice(0,geometry.mobile?2:3));
    snapshots=poses.map((pose,i)=>{
      const {point,phase,p,source}=pose,a=agents[i];a.velocityX=point.x-(a.lastPoint?.x??point.x);a.velocityY=point.y-(a.lastPoint?.y??point.y);a.lastPoint={...point};const incoming=poses.find(other=>other.next===a.id&&other.phase===4&&other.p>.70&&other.p<.98),previous=sample(i,Math.max(0,t-.04),events).point,dx=pose.job||pose.followup?a.velocityX:point.x-previous.x,readingSource=pose.workPhase==='visit'&&pose.job.progress>=.12,walking=!pose.coreWaiting&&!readingSource&&(Math.hypot(a.velocityX,a.velocityY)>.65||['dispatch','resume'].includes(pose.workPhase)||phase===0||phase===2||phase===4||['visit','meet','deliver','return'].includes(pose.workPhase));
      const station=pose.job?.station,work=pose.coreWaiting||pose.followup?null:sceneWork(pose.job,a.id);
      pose.work=work;const usingComputer=work?.kind==='computer'&&pose.leader&&!walking,typing=usingComputer&&work.action==='type',watchingScreen=work?.kind==='screen',retrieving=work?.action==='retrieve';
      a.el.dataset.localAction=work?.action||'';a.el.dataset.workRef=work?pose.job.id:'';
      a.el.style.setProperty('--typing-y',usingComputer?'2px':'0px');a.el.dataset.visiting=String(Boolean(pose.job?.visitingRoles?.includes(a.id)));
      a.el.dataset.facing=usingComputer?'back':'front';
      a.el.dataset.sceneAction=usingComputer?'computer':watchingScreen?'screen':work?.kind==='data-center'?'data-center':station>=4?'table':station===1?'exchange':'huddle';
      const meetingPeer=pose.followup&&['handoff','collaborate'].includes(pose.workPhase)?poses.find(s=>s.id!==a.id&&s.followup?.key===pose.followup.key):['discuss','review','await'].includes(pose.workPhase)?poses.find(s=>s.id!==a.id&&s.job?.id===pose.job.id&&['discuss','review','await'].includes(s.workPhase)):null;
      const ds=geometry.mobile?.66:.90;
      const deviceTarget=pose.meeting?(usingComputer?{x:pose.meeting.x,y:pose.meeting.y-30}:retrieving?{x:pose.meeting.x-10*ds,y:pose.meeting.y+17-38*ds}:work?.action==='point'?{x:pose.meeting.x+work.chartX*ds,y:pose.meeting.y+17+work.chartY*ds}:null):null;
      pose.deviceTarget=deviceTarget;
      const presenter=watchingScreen?poses.find(p=>p.id===work.owner):null;
      const target=(pose.coreWaiting?geometry.core:null)||deviceTarget||(readingSource?source:null)||(watchingScreen?presenter?.point:null)||meetingPeer?.point||((phase===3||pose.workPhase==='submit')?geometry.core:null),facing=target?Math.sign(target.x-point.x):Math.sign(dx)||1;
      const speaking=Boolean(meetingPeer&&Math.floor(gestureTime*1.2)%(pose.followup?.roles||pose.job.roles).length===(pose.followup?.roles||pose.job.roles).indexOf(a.id));
      const lean=reducedMotion?0:retrieving?7:readingSource&&source.lower?4:usingComputer?0:meetingPeer?facing*(speaking?7:2)+Math.sin(gestureTime*8+i)*(speaking?3:1):Math.max(-12,Math.min(12,dx*4));
      const step=reducedMotion?0:walking?Math.sin(gestureTime*16+i)*29:Math.sin(gestureTime*4+i)*3;
      const presenting=phase===3||pose.workPhase==='submit',arm=usingComputer?(typing?120+Math.sin(gestureTime*13+i)*15:work.action==='verify'?95:35):deviceTarget&&(retrieving||work?.action==='point')?Math.atan2(-(deviceTarget.x-point.x),deviceTarget.y-point.y)*180/Math.PI:readingSource&&source.lower?-6+Math.sin(gestureTime*10)*8:pose.coreWaiting?(coreReceipt.stage==='release'?-67:-27):meetingPeer?(speaking? -68-Math.sin(gestureTime*9)*18:-25):presenting?-80:phase===1||readingSource?-55-Math.sin(gestureTime*12)*15:phase===2||pose.workPhase==='deliver'||pose.workPhase==='dispatch'?-52:step*.8;
      const confirmDip=pose.coreWaiting&&coreReceipt.stage==='confirm'?Math.sin(coreReceipt.progress*Math.PI):0;
      const peerDip=pose.followup&&a.id===coreReceipt.team.peers[0]&&coreReceipt.stage==='handoff'?Math.sin(Math.PI*Math.max(0,Math.min(1,(coreReceipt.progress-.68)/.32))):0;
      const workNod=work&&['listen','verify','compare','crosscheck'].includes(work.action)?Math.max(0,Math.sin(gestureTime*3+i))*.55:0;
      const nodDip=reducedMotion?0:Math.max(confirmDip,peerDip,workNod);
      a.el.style.transform=`translate3d(${point.x.toFixed(2)}px,${point.y.toFixed(2)}px,0)`;
      for(const [key,value]of Object.entries({lean:lean+'deg',step:step+'deg',arm:(usingComputer?arm:target&&facing<0?step*.5:arm)+'deg','left-arm':(usingComputer?(typing?-120-Math.cos(gestureTime*13+i)*15:work.action==='verify'?-95:-35):target&&facing<0?(deviceTarget&&(retrieving||work?.action==='point')?arm:-arm):step*.7)+'deg',bob:(reducedMotion?0:walking?Math.sin(gestureTime*16+i)*2.1:Math.sin(gestureTime*3+i)*.8)+'px',blink:Math.max(.12,1-Math.pow(Math.max(0,Math.cos(gestureTime*.8+i)),65)),look:target?facing*3+'px':'0px','nod-y':nodDip*4+'px','nod-compress':1-nodDip*.10,nod:(nodDip?nodDip*12:meetingPeer&&!speaking?Math.sin(gestureTime*8+i)*5:0)+'deg'}))a.el.style.setProperty('--'+key,value);
      const reaction=reactions.get(a.id),bubble=a.el.querySelector('.courier-reaction');
      bubble.textContent=reaction?.emoji||'';bubble.dataset.mood=reaction?.kind||'';bubble.style.opacity=String(reaction?.strength||0);bubble.style.transform=`translateY(${(1-(reaction?.strength||0))*4}px) scale(${.86+(reaction?.strength||0)*.14})`;
      const duty=a.el.querySelector('.courier-duty');duty.textContent=pose.job?.business?localize(`${pose.job.glyph} ${pose.job.badge}`):'';if(!pose.job?.business&&pose.job?.visitingRoles?.includes(a.id))duty.textContent=localize('跨组协作');a.el.dataset.visitingIntro=String(motionTime-(a.routeSince??-99)<6);duty.hidden=!pose.job?.business&&!pose.job?.visitingRoles?.includes(a.id);const badgeHalf=document.documentElement.lang==='en'?52:32;duty.style.marginLeft=(Math.max(0,badgeHalf-point.x)+Math.min(0,geometry.width-badgeHalf-point.x))+'px';a.el.dataset.business=String(Boolean(pose.job?.business));a.el.dataset.businessRef=pose.job?.ref||'';a.el.dataset.usageId=pose.job?.usageId||'';a.el.dataset.route=pose.job?.route||'team';
      a.el.dataset.taskType=pose.job?.taskType|| (phase<5?'evidence':'review');a.el.dataset.sourceZone=source.zone||source.key;a.el.dataset.collectionAsset=source.asset||'';a.el.dataset.collectionPhase=pose.workPhase||String(phase);
      a.el.dataset.followup=pose.followup?.key||'';a.el.dataset.coreResponse=pose.coreWaiting?coreReceipt.stage:'';a.el.dataset.coreWaiting=String(Boolean(pose.coreWaiting));a.el.dataset.speaking=String(speaking);a.el.dataset.stature=(model.multiResearch?pose.leader||executionIds.includes(a.id):actorIds.includes(a.id)||executionIds.includes(a.id))?'primary':'scout';
      a.el.dataset.researchAsset=pose.job?.symbol||'';a.el.dataset.researchRevision=pose.job?.revision||'';a.el.querySelector('.courier-caption b').textContent=pose.leader&&pose.job?.discovered?pose.job.symbol:ROLES[a.id].id;a.el.dataset.job=pose.job?.id||'';a.el.dataset.workPhase=pose.workPhase||'';a.el.dataset.duty=pose.job?'collaborating':executionIds.includes(a.id)?'execution':actorIds.includes(a.id)?'research':'standby';a.el.title=pose.job?`${ROLES[a.id].id} · ${pose.job.title} · ${pose.job.trigger}`:`${ROLES[a.id].id} · ${ROLES[a.id].name} · ${a.el.dataset.duty==='standby'?'待命':a.el.dataset.duty==='execution'?'模拟执行协作':'本轮研究'}`;
      const visit=pose.job?.visitingRoles?.includes(a.id)?`跨组协作 · ${RESEARCH_GROUPS[pose.job.supportFrom]?.label||''} → ${RESEARCH_GROUPS[pose.job.station]?.label||''}`:'';
      a.el.title=localize(visit?`${visit} · ${a.el.title}`:a.el.title);a.el.setAttribute('aria-label',localize(`聚焦 ${ROLES[a.id].id} ${ROLES[a.id].name}${visit?' · '+visit:''}`));
      a.el.dataset.receiving=String(Boolean(incoming));a.el.dataset.phase=String(phase);a.el.dataset.carrying=String(Boolean(pose.followup)||phase===2||phase===3||['meet','deliver','submit'].includes(pose.workPhase));a.el.dataset.ended=String(stopped);a.el.dataset.x=point.x.toFixed(1);a.el.dataset.y=point.y.toFixed(1);a.el.setAttribute('aria-pressed',String(selected===a.id));a.el.classList.toggle('hide-caption',!visual.labels||(phase>=2&&phase<=4)||(geometry.mobile&&a.id===12&&process.ready));
      const compact=true;a.el.classList.toggle('compact-caption',compact);
      const w=compact?62:90,h=compact?21:35,overlap=(a,b)=>Math.max(0,Math.min(a.x+w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+h,b.y+b.h)-Math.max(a.y,b.y));
      const candidates=[[point.x-w/2,point.y+23],[point.x+25,point.y-14],[point.x-w-25,point.y-14],[point.x-w/2,point.y-65],[point.x+29,point.y+24],[point.x-w-29,point.y+24]].map(([x,y])=>({x:Math.max(3,Math.min(geometry.width-w-3,x)),y:Math.max(3,Math.min(geometry.height-h-3,y)),w,h}));
      const obstacles=[{x:geometry.cr.left-geometry.wr.left,y:geometry.cr.bottom-geometry.wr.top-32,w:geometry.cr.width,h:32},...evidenceBoxes,...captionBoxes,...poses.map(p=>({x:p.point.x-16,y:p.point.y-24,w:32,h:47})),{x:geometry.core.x-41,y:geometry.core.y-41,w:82,h:82}];
      const label=candidates.map((p,index)=>({p,score:obstacles.reduce((n,o)=>n+overlap(p,o),0)+index*.2})).sort((a,b)=>a.score-b.score)[0].p;captionBoxes.push(label);
      const caption=a.el.querySelector('.courier-caption');caption.style.width=w+'px';caption.style.left=(label.x-point.x+23)+'px';caption.style.top=(label.y-point.y+27)+'px';
      a.caption.textContent=pose.job?pose.job.title:stopped?'本轮结束':reducedMotion?'采集示意':incoming?`接收 ${ROLES[incoming.id].id}`:phase===1?`${source.offscreen?'屏外来源':'采样'} · ${SOURCE_NAMES[source.key]}`:a.id===12?(process.ready?'结论已形成':'等待证据闭合'):phase===4?'提交核心筛选':phase===5?(pose.event?'本条已交付':'等待采集任务'):labels[phase];
      if((phase===1||pose.workPhase==='visit'&&pose.job.progress>.12)&&!stopped){source.el?.setAttribute('data-collecting','true');source.el?.setAttribute('data-collector-agent',ROLES[a.id].id);source.el?.style.setProperty('--collector-color',colorFor(a.id));}
      a.trail=(a.trail||[]);if(walking&&pose.job)a.trail.unshift({...point});else a.trail=[];a.trail.length=Math.min(a.trail.length,18);
      let d='';if(pose.job&&walking&&visual.paths&&!reducedMotion){d=a.trail.map((p,j)=>`${j?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');}else if(!reducedMotion&&walking&&visual.paths){for(let j=0;j<15;j++){const past=sample(i,Math.max(0,t-j*.055),events).point;d+=`${j?'L':'M'}${past.x.toFixed(1)},${past.y.toFixed(1)} `;}}paths[i].setAttribute('d',d);paths[i].setAttribute('opacity',phase===2?'.58':'.22');
      const carryTrail=phase===2?Array.from({length:16},(_,j)=>{const past=sample(i,Math.max(pose.event.at+2,t-j*.025),events).point;return {x:past.x-geometry.cr.left+geometry.wr.left+15,y:past.y-geometry.cr.top+geometry.wr.top+6};}):[];
      return {...pose,motion:{walking,dx,facing,speaking,nod:nodDip},carryTrail,label:a.caption.textContent,color:colorFor(a.id),x:point.x-geometry.cr.left+geometry.wr.left,y:point.y-geometry.cr.top+geometry.wr.top};
    });
    drawDocuments(poses,reducedMotion);drawTables(poses,reducedMotion);
    collectionBeams.update(geometry,snapshots,motionTime,!reducedMotion&&!stopped&&running&&!document.hidden&&(scope?scope.isConnected:document.body.dataset.page==='workbench')&&surface.dataset.paused!=='true');
    layer.dataset.phases=snapshots.map(p=>p.phase).join(',');layer.dataset.positions=snapshots.map(p=>`${p.id}:${p.point.x.toFixed(0)},${p.point.y.toFixed(0)}`).join('|');
    return snapshots;
  }
  function drawTables(poses,reduced){
    if(surface.dataset.multiResearch!=='true'){furniture.innerHTML='';return;}
    const centers=meetingCenters({width:geometry.cr.width,height:geometry.cr.height,core:geometry.core,mobile:geometry.mobile});
    const icons={chart:'M-15 5l8-9 8 4 12-13',nodes:'M-12-6L1 5 13-8 M1 5v8',pulse:'M-17 2h8l4-10 7 18 5-8h10',bars:'M-13 8V0 M-4 8v-18 M5 8v-12 M14 8v-24',diamond:'M0-13l13 12L0 12-13-1Z',calendar:'M-13-10h26v22h-26Z M-13-3h26 M-6-14v8 M6-14v8'};
    furniture.innerHTML=RESEARCH_GROUPS.map((g,i)=>{
      const {x,y}=centers[i],job=coordination.find(j=>j.station===i&&j.groupLabel),phase=job?.researchPhase||'monitor',active=['queuedCore','core'].includes(phase),s=geometry.mobile?.66:.90;
      const progress=job?.progress||0;
      const desk=i>=4,scene=COLLAB_SCENES[i];
      const live=poses.filter(p=>p.job?.station===i&&['discuss','review','await'].includes(p.workPhase));
      const worker=live.find(p=>p.work?.kind==='computer'&&p.leader),pointing=live.find(p=>p.work?.action==='point'),retriever=live.find(p=>p.work?.action==='retrieve');
      const operator=pointing||worker||retriever||live.find(p=>p.work&&(i!==2||p.leader));
      if(operator)deviceFrames.set(i,{q:operator.work.q,checks:operator.work.checks||0,ref:operator.job.id});
      const frame=deviceFrames.get(i)||{q:0,checks:0,ref:''};
      const checks=frame.checks;
      const cursor=worker?.work?.action==='type'?(Math.sin(gestureTime*6)*.5+.5)*28:0;
      const reviewQ=frame.q,typing=worker?.work?.action==='type',verifying=worker?.work?.action==='verify';
      const scan=reduced?0:(reviewQ*6)%1,readQ=retriever?Math.min(1,retriever.work.q/.38):0;
      const market=sceneMarket(frame.q),chartPath=market.points.map(([cx,cy],n)=>`${n?'L':'M'}${cx} ${cy}`).join(' '),lastPrice=market.points.at(-1)[1];
      const surface=i===2?`
        <ellipse cy="15" rx="63" ry="15" fill="currentColor" opacity=".06"/>
        <path d="M-5-15V0h-13v4h36V0H5v-15" fill="currentColor" opacity=".4"/>
        <rect x="-39" y="-66" width="78" height="52" rx="5" fill="var(--surface-2)" stroke="currentColor" stroke-width="1.6"/>
        <rect x="-34" y="-61" width="68" height="39" rx="2" fill="var(--surface)"/>
        ${typing||verifying?`<rect data-device-motion="verification-row" x="-31" y="${-50+Math.min(2,checks)*9}" width="61" height="8" rx="2" fill="currentColor" opacity=".18"/>`:''}
        <path d="M-30-52h60 M-12-49v24" stroke="currentColor" opacity=".22"/>
        <circle cx="-28" cy="-57" r="1.4" fill="currentColor" opacity=".75"/><circle cx="-23" cy="-57" r="1.4" fill="currentColor" opacity=".35"/>
        <path d="M-16-57h18 M18-57h11" stroke="currentColor" stroke-width="1.5" opacity=".45"/>
        ${[-45,-36,-27].map((cy,n)=>`<path d="M-19 ${cy-1}h4" stroke="currentColor" opacity="${checks>n?.8:.25}"/>`).join('')}
        ${[-45,-36,-27].map((cy,n)=>`<path d="M-28 ${cy}l2 2 4-5" fill="none" stroke="currentColor" stroke-width="1.8" opacity="${checks>n?.95:.12}"/>`).join('')}
        <rect x="-7" y="-48" width="15" height="10" rx="1.5" fill="currentColor" opacity=".11"/>
        <rect x="12" y="-48" width="16" height="10" rx="1.5" fill="currentColor" opacity=".11"/>
        <path d="M-4-45h8 M-4-42h5 M15-45h10 M15-42h6" stroke="currentColor" stroke-width="1.1" opacity=".7"/>
        ${[0,1].map(n=>`<path d="M-6 ${-34+n*4}h${typing?6+((scan+n*.4)%1)*26:30-n*8}" stroke="currentColor" stroke-width="2" opacity=".8"/>`).join('')}
        ${verifying?`<path data-device-motion="verification-pass" d="M10-43l4 4 9-9" fill="none" stroke="currentColor" stroke-width="2.8" stroke-dasharray="22" stroke-dashoffset="${22*(1-Math.min(1,(reviewQ-.7)/.18))}"/>`:''}
        <rect x="-6" y="-26" width="34" height="3.5" rx="1" fill="currentColor" opacity=".12"/>
        <rect x="-6" y="-26" width="${34*reviewQ}" height="3.5" rx="1" fill="currentColor" opacity=".85"/>
        <circle cx="0" cy="-18" r="1.3" fill="currentColor"/>
        <rect x="46" y="-34" width="16" height="38" rx="3" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".5"/>
        <path d="M50-26h8 M50-22h8" stroke="currentColor" opacity=".5"/><circle cx="54" cy="-3" r="1.5" fill="currentColor"/>
        <path d="M-28 5h56l6 12h-68Z" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".7"/>
        <path d="M-23 9h46 M-25 12h50 M-16 7v7 M-8 7v7 M0 7v7 M8 7v7 M16 7v7" stroke="currentColor" stroke-width=".8" opacity=".45"/>
        ${worker?.work?.action==='type'?`<rect x="${Math.sin(gestureTime*13)>0?-22:14}" y="8" width="8" height="5" rx="1" fill="currentColor" opacity=".7"/>`:''}
        <rect x="38" y="7" width="9" height="12" rx="4" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".65"/><path d="M42.5 8v4" stroke="currentColor"/>
        ${worker?.work?.action==='type'?`<path d="M${3+cursor*.45}-31v3" stroke="currentColor" stroke-width="1.2" opacity=".9"/>`:''}`:
       i===3?`
        <path d="M-40-8v19 M40-8v19" stroke="currentColor" stroke-width="3" opacity=".35"/>
        <rect x="-66" y="-83" width="139" height="82" rx="5" fill="var(--surface)" stroke="currentColor" stroke-opacity=".6"/>
        <path d="M-65-69h137" stroke="currentColor" opacity=".18"/>
        <rect x="-58" y="-78" width="18" height="4" rx="1.5" fill="currentColor" opacity=".65"/>
        <path d="M-35-76h23 M24-76h9 M39-76h9 M54-76h10" stroke="currentColor" stroke-width="2" opacity=".32"/>
        <path d="M-53-57h103 M-53-39h103 M-53-20h103 M-38-64v45 M-11-64v45 M16-64v45 M43-64v45" stroke="currentColor" opacity=".10"/>
        <rect x="-22" y="${market.bandY}" width="62" height="16" rx="2" fill="currentColor" opacity=".12"/>
        <path d="M-22 ${market.bandY}h62 M-22 ${market.bandY+16}h62" stroke="currentColor" stroke-dasharray="2 3" opacity=".5"/>
        <path d="${chartPath}V-19H-52Z" fill="currentColor" opacity=".10"/>
        <path data-device-motion="market-curve" d="${chartPath}" fill="none" stroke="currentColor" stroke-width="${geometry.mobile?2.8:2.2}"/>
        <circle cx="50" cy="${lastPrice}" r="3" fill="currentColor"/>
        <path d="M54 ${lastPrice}h11" stroke="currentColor" stroke-width="3" opacity=".95"/>
        <path d="M56-48h8 M56-35h6 M56-22h8" stroke="currentColor" stroke-width="1.4" opacity=".3"/>
        ${market.volumes.map((h,n)=>`<rect x="${-53+n*5.8}" y="${-5-h*.65}" width="3.5" height="${h*.65}" rx=".6" fill="currentColor" opacity="${n%3===0?.8:.4}"/>`).join('')}
        ${pointing?.work?`<path d="M${pointing.work.chartX} -65V-4" stroke="currentColor" stroke-dasharray="2 2" opacity=".35"/>`:''}`:
       desk?`
        <ellipse cy="18" rx="64" ry="23" fill="currentColor" opacity=".06"/>
        <path d="M-40 8v19 M40 8v19" stroke="currentColor" stroke-width="3" opacity=".3"/>
        <ellipse rx="52" ry="19" fill="var(--surface)" stroke="currentColor" stroke-opacity=".4"/>
        <path d="M-49 7 Q0 29 49 7" fill="none" stroke="currentColor" stroke-opacity=".25"/>
        <g transform="translate(-25 -3) scale(.5)"><path d="${icons[g.glyph]}" fill="none" stroke="currentColor" stroke-width="3"/></g>
        <rect x="-5" y="-10" width="23" height="15" rx="2" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".35"/>
        <path d="M0-5h12 M0 0h8" stroke="currentColor" stroke-opacity=".7"/>`:
       i===0?`<g transform="translate(0 -10)" data-surface="data-center">
        <title>${localize('数据中心 · 样例数据采集与核验')}</title>
        <ellipse cx="0" cy="14" rx="39" ry="11" fill="currentColor" opacity=".06"/>
        <rect x="-31" y="-62" width="43" height="71" rx="4" fill="var(--surface)" stroke="currentColor" stroke-opacity=".65"/>
        <path d="M-27-57h32 M-25 10v4 M6 10v4" stroke="currentColor" stroke-width="2" opacity=".35"/>
        
        ${[0,1,2,3,4].map(n=>`<rect x="${-24+n*5}" y="-60" width="3" height="1.5" rx=".5" fill="currentColor" opacity="${retriever?.75:.25}"/>`).join('')}
        ${[-51,-34,-17].map((top,index)=>`<g transform="translate(${retriever&&index===1?-Math.sin(Math.min(1,retriever.work.q/.38)*Math.PI)*9:0} 0)"><rect x="-24" y="${top}" width="29" height="13" rx="2" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".4"/><path d="M-20 ${top+4}h10 M-20 ${top+7}h6" stroke="currentColor" stroke-width="1.2" opacity=".7"/>
        ${[0,1,2,3].map(n=>`<rect x="${-20+n*4}" y="${top+10}" width="2.5" height="1.2" fill="currentColor" opacity="${retriever&&index===1&&n<Math.ceil(retriever.work.q/.38*4)?.9:.22}"/>`).join('')}<circle cx="0" cy="${top+6.5}" r="1.7" fill="currentColor" opacity="${retriever&&index===1?.95:.25}"/></g>`).join('')}
        ${retriever?`<rect data-device-motion="database-read" x="-26" y="${-53+readQ*47}" width="33" height="7" rx="2" fill="currentColor" opacity=".27"/>`:''}
        <path d="M10-28h12v16 M10-2h12" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".3"/>
        ${retriever?`<path data-device-motion="database-transfer" d="M24-5V-20H10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 5" stroke-dashoffset="${-readQ*48}" opacity=".95"/>`:''}
        <path d="M13-9v13c0 5 22 5 22 0V-9" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".65"/>
        <ellipse cx="24" cy="-9" rx="11" ry="4" fill="var(--surface)" stroke="currentColor" stroke-opacity=".65"/>
        <path d="M13-3c0 5 22 5 22 0 M13 2c0 5 22 5 22 0" fill="none" stroke="currentColor" opacity=".4"/>
        <rect x="18" y="-48" width="21" height="24" rx="2" fill="var(--surface-2)" stroke="currentColor" stroke-opacity=".4"/>
        ${[0,1,2].map(n=>`<path d="M22 ${-43+n*5}h${retriever?3+Math.min(1,Math.max(0,readQ*3-n))*10:10-n*2}" stroke="currentColor" stroke-width="${geometry.mobile?2.5:2}" opacity=".85"/>`).join('')}
        ${retriever?`<rect x="${12+Math.sin(retriever.work.q/.38*Math.PI)*8}" y="-29.5" width="4" height="3" rx="1" fill="currentColor" opacity=".85"/>`:''}
       </g>`:
       `<path d="M-44 29h24 M20 29h24" stroke="currentColor" stroke-opacity=".16" stroke-width="2"/>`;
      const pointerHand=pointing?.deviceTarget?agentFloor?.hand(pointing.id,pointing.deviceTarget):null;
      return `<g transform="translate(${x} ${y+17}) scale(${s})" data-research-zone="${i}" data-device-job="${frame.ref}" data-device-progress="${frame.q.toFixed(3)}" data-device-working="${Boolean(operator)}" data-furniture="${desk?'table':scene}" data-scene="${scene}" data-active="${Boolean(live.length)}" data-phase="${phase}" style="color:${geometry.mobile&&[0,2,3].includes(i)?`color-mix(in srgb, ${g.color} 78%, var(--text) 22%)`:g.color}">
        ${surface}
      </g>${pointing?.deviceTarget?`<g data-scene-pointer="${i}" data-job="${pointing.job.id}" stroke="${g.color}" fill="none"><path d="M${pointerHand?.x??pointing.point.x+(pointing.deviceTarget.x>pointing.point.x?12:-12)} ${pointerHand?.y??pointing.point.y+2} L${pointing.deviceTarget.x} ${pointing.deviceTarget.y}" stroke-width="1.5" opacity=".75"/><circle cx="${pointing.deviceTarget.x}" cy="${pointing.deviceTarget.y}" r="3" stroke-width="1.5"/></g>`:''}`;
    }).join('');
  }

  function drawDocuments(poses,reduced){
    const hand=(pose,toward)=>{const materialHand=agentFloor?.hand(pose.id,toward);if(materialHand)return materialHand;const side=toward?Math.sign(toward.x-pose.point.x)||1:1;return {x:pose.point.x+side*16,y:pose.point.y+7};};
    for(const [i,pose]of poses.entries()){
      const el=documents[i];el.querySelector('.document-seal').textContent=pose.job?.business?pose.job.glyph:'';let pos=null,scale=geometry.mobile ? .72 : .86,rotation=-8,opacity=1,from=pose.id,to=pose.id,kind='carry';
      if(pose.followup||acceptedPapers.has(paperKey(pose))){}else if(pose.event&&pose.phase>=1&&pose.phase<=3){
        pos=hand(pose,pose.phase===3?geometry.core:null);
        if(pose.phase===1){opacity=Math.min(1,pose.p*4);rotation=12;kind='collect';}
        if(pose.phase===3){
          to='core';kind='submit'; // Wait at the hand; the core receipt owns the transfer.
        }
      }else if(pose.job){
        const job=pose.job,u=job.progress,peers=job.roles.map(id=>poses.find(p=>p.id===id&&p.job?.id===job.id));
        // One dossier per team: all members handle the same object in sequence.
        if(pose.leader&&peers.every(Boolean)){
          if(job.route==='direct'){
            if(u>=.12&&u<.38){pos=hand(pose,geometry.core);kind=u<.16?'collect':'carry';}
            else if(u>=.38&&u<.66){pos=hand(pose,geometry.core);to='core';kind='submit';}
          }else if(job.mode==='desk'&&u<.32){pos={x:pose.meeting.x,y:pose.meeting.y+6};kind='review';}
          else if(u>=.12&&u<.32){pos=hand(pose);kind=u<.16?'collect':'carry';opacity=Math.min(1,(u-.12)/.04);}
          else if(u>=.32&&u<.67&&pose.work?.kind==='data-center'){
            const q=pose.work.q,ds=geometry.mobile?.66:.90,rack={x:pose.meeting.x-10*ds,y:pose.meeting.y+17-38*ds};
            if(q>=.12&&q<.38){pos=travel(rack,hand(pose),Math.min(1,(q-.12)/.26),-5);kind='retrieve';}
            else if(q>=.38){const receiver=peers[1]||pose;pos=q<.78?travel(hand(pose,receiver.point),hand(receiver,pose.point),smooth((q-.38)/.4),-5):travel(hand(receiver,pose.point),hand(pose,geometry.core),(q-.78)/.22,-5);from=q<.78?pose.id:receiver.id;to=q<.78?receiver.id:pose.id;kind=q<.78?'inspect':'pack';}
          }else if(u>=.32&&u<.67&&pose.work?.kind==='computer'){
            const q=pose.work.q,ds=geometry.mobile?.66:.90,tray={x:pose.meeting.x+49*ds,y:pose.meeting.y+25};
            if(q<.88){pos=tray;kind=q<.70?'input-review':'verify';rotation=4;}
            else{pos=travel(tray,hand(pose,geometry.core),(q-.88)/.12,-5);kind='pack';}
          }else if(u>=.32&&u<.67){
            const q=(u-.32)/.35*peers.length,turn=Math.min(peers.length-1,Math.floor(q)),v=q-turn;
            const sender=peers[turn],receiver=peers[(turn+1)%peers.length];from=sender.id;to=receiver.id;
            // Pause in each hand for acknowledgement, then pass to the next colleague.
            const h1=hand(sender,receiver.point),h2=hand(receiver,sender.point),p=smooth(Math.max(0,Math.min(1,(v-.22)/.58)));
            pos=travel(h1,h2,p,-7);rotation=-10+20*p;kind='handoff';
          }else if(u>=.67&&u<.80){pos=hand(pose,geometry.core);kind='carry';}
          else if(u>=.80&&u<.92){
            pos=hand(pose,geometry.core);to='core';kind='submit';
          }
        }
      }
      el.style.display=pos?'':'none';
      if(pos){el.setAttribute('transform',`translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)}) rotate(${reduced?0:rotation}) scale(${scale})`);el.setAttribute('opacity',String(opacity));Object.assign(el.dataset,{from:String(from),to:String(to),motion:kind,job:pose.job?.id||'',evidence:pose.event?.id||'',businessRef:pose.job?.ref||'',usageId:pose.job?.usageId||'',route:pose.job?.route||'team'});}
    }
  }
  function react(reaction){
    coreReceipt=reaction.receipt;
    sceneAudio?.update({epoch:currentModel?.epoch,time:gestureTime,states:snapshots,receipt:reaction.receipt,research:currentModel?.multiResearch});
    if(!geometry)return;
    agentFloor?.update({geometry,poses:snapshots,reaction,time:gestureTime,reduced:floorReduced,deviceFrames});
    const message=reportCore({time:gestureTime,epoch:currentModel?.epoch,receipt:reaction.receipt,research:currentModel?.multiResearch,locale:document.documentElement.lang});
    const coreY=geometry.wr.top+geometry.core.y;
    report.hidden=!message||coreY<Math.max(geometry.sr.top,geometry.wr.top)||coreY>Math.min(geometry.sr.bottom,geometry.wr.bottom);
    if(message){const text=report.querySelector('span');if(text.textContent!==message.text)text.textContent=message.text;report.dataset.ref=message.ref;report.dataset.kind=message.kind;
      const half=geometry.mobile?104:138;report.style.left=Math.max(half+8,Math.min(geometry.width-half-8,geometry.core.x))+'px';report.style.top=Math.max(65,geometry.core.y-(agentFloor?.ready?(geometry.mobile?78:104):(geometry.mobile?67:82)))+'px';}
    if(reaction.receipt){acceptedPapers.add(reaction.receipt.key);if(acceptedPapers.size>128)acceptedPapers.delete(acceptedPapers.values().next().value);}
    const r=reaction.receipt;if(!r||!geometry)return;
    if(['dispatch','handoff','collaborate','resume'].includes(r.stage)){drawFollowupDocument(r);return;}
    const el=documents[r.id];if(!el)return;
    const origin={x:r.origin.x+geometry.cr.left-geometry.wr.left,y:r.origin.y+geometry.cr.top-geometry.wr.top};
    const h=agentFloor?.hand(r.id,geometry.core)||{x:origin.x-Math.sign(origin.x-geometry.core.x)*16,y:origin.y+7};
    const grip=handoffPoint?.();
    const resting=agentFloor?.coreGrip?{x:agentFloor.coreGrip.x+r.side*5,y:agentFloor.coreGrip.y}:grip?{x:geometry.cr.left-geometry.wr.left+grip.x+r.side*5,y:geometry.cr.top-geometry.wr.top+grip.y}:{x:geometry.core.x+r.side*8,y:geometry.core.y+58};
    const u=smooth(r.progress),pos=r.stage==='receive'?travel(h,resting,u,-8):r.stage==='release'?travel(resting,h,u,8):resting;
    const scale=(geometry.mobile?.78:1.02)*(r.stage==='release'?1-u*.12:1),opacity=1;
    el.style.display='';el.setAttribute('transform',`translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)}) rotate(${r.stage==='think'?r.side*9:0}) scale(${scale})`);el.setAttribute('opacity',String(opacity));
    Object.assign(el.dataset,{from:r.stage==='release'?'core':String(r.id),to:r.stage==='release'?String(r.id):'core',motion:'core-'+r.stage,receipt:r.key});
  }
  const invalidate=()=>{previousLayout=-99;};workspace.addEventListener('scroll',invalidate,true);window.addEventListener('resize',invalidate);
  return {update,react,focus(id){selected=id;},setVisual(v){visual={...visual,...v};},get materialReady(){return Boolean(agentFloor?.coreReady);},get states(){return snapshots;},get needsLayout(){return previousLayout===-99;},resize:invalidate,dispose(){collectionBeams.dispose();sceneAudio?.dispose();agentFloor?.dispose();workspace.removeEventListener('scroll',invalidate,true);window.removeEventListener('resize',invalidate);for(const source of geometry?.sources||[]){source.el.removeAttribute('data-collector-agent');source.el.removeAttribute('data-collecting');}layer.remove();}};
}
