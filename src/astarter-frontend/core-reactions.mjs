import {receiptTeam} from './coordination.mjs';
// Presentation only: one continuous receipt follows an existing evidence/task identity.
const clamp=v=>Math.max(-1,Math.min(1,v));
export function createCoreReactions(){
 let epoch=null,lastTime=null,clock=0,lastPhase=null,nodAt=-Infinity,active=null,lastSize=null;
 const seen=new Set();
 let pose={pitch:0,yaw:0,roll:0,lookX:0,lookY:0,squint:1,lift:0,lean:0,hands:0};
 const identity=s=>s.event?.id?`evidence:${s.event.id}`:s.job?`job:${s.job.id}`:`role:${s.id}`;
 const submitted=s=>s.phase===3||s.workPhase==='submit';
 return function update({time,epoch:run,states=[],phase=0,ready=false,width=1,height=1,center=null,pace=1,reduced=false}){
  if(epoch!==run){epoch=run;lastTime=null;clock=0;lastPhase=null;nodAt=-Infinity;active=null;lastSize=null;seen.clear();pose={pitch:0,yaw:0,roll:0,lookX:0,lookY:0,squint:1,lift:0,lean:0,hands:0};}
  width=Math.max(1,width);height=Math.max(1,height);
  if(active&&active.stage!=='attend'&&lastSize&&(width!==lastSize.width||height!==lastSize.height)){
   const sx=width/lastSize.width,sy=height/lastSize.height;
   active.x*=sx;active.y*=sy;active.origin={x:active.origin.x*sx,y:active.origin.y*sy};
  }
  lastSize={width,height};
  const dt=lastTime===null?0:Math.max(0,time-lastTime);lastTime=time;clock+=dt*pace;
  if(phase===3&&lastPhase!==3&&ready)nodAt=clock;lastPhase=phase;
  if(active&&states.some(s=>s.id===active.id&&s.job?.business&&identity(s)!==active.key))active=null;
  const candidates=states.filter(s=>submitted(s)||s.phase===2||s.workPhase==='deliver');
  if(!active){
   const candidate=candidates.filter(s=>!seen.has(identity(s))).sort((a,b)=>Number(Boolean(b.job?.business))-Number(Boolean(a.job?.business))||Number(Boolean(b.event))-Number(Boolean(a.event))||Number(submitted(b))-Number(submitted(a)))[0];
   if(candidate){active={id:candidate.id,key:identity(candidate),stage:'attend',since:clock,x:candidate.x,y:candidate.y,origin:{x:candidate.x,y:candidate.y},context:candidate,team:null,side:candidate.x>(center?.x??width/2)?1:-1};seen.add(active.key);if(seen.size>128)seen.delete(seen.values().next().value);}
  }
  let action='observe',pitch=0,yaw=0,roll=0,lookX=0,lookY=0,squint=1,lift=Math.sin(clock*.9)*.015,lean=0,hands=0,receipt=null;
  if(active){
   const target=states.find(s=>s.id===active.id&&identity(s)===active.key);
   if(active.stage==='attend'){
    if(target){active.x=target.x;active.y=target.y;active.origin={x:target.x,y:target.y};}
    if(target&&submitted(target)&&clock-active.since>=.30){active.stage='receive';active.since=clock;}
    else if(!target&&clock-active.since>1.2||clock-active.since>5){active=null;}
   }
   if(active){
    const lengths={receive:.65,read:.65,think:.85,acknowledge:.75,confirm:.65,release:.65,dispatch:1.8,handoff:1.15,collaborate:1.8,resume:1},next={receive:'read',read:'think',think:'acknowledge',acknowledge:'confirm',confirm:'release',release:'dispatch',dispatch:'handoff',handoff:'collaborate',collaborate:'resume',resume:null};
    if(['dispatch','handoff','collaborate','resume'].includes(active.stage)&&[active.id,...(active.team?.peers||[])].some(id=>states.some(s=>s.id===id&&((s.event&&s.event.id!==active.context.event?.id&&s.phase<4)||/^(risk-|order-|review-)/.test(s.job?.id||''))))){active=null;}
    if(active&&active.stage!=='attend'&&clock-active.since>=lengths[active.stage]){const stage=next[active.stage];if(stage){active.stage=stage;active.since=clock;if(stage==='release')active.team=receiptTeam(active.context,states);if(stage==='dispatch'&&!active.team.peers.length)active=null;}else active=null;}
    if(active){
     action=active.stage;const u=action==='attend'?0:Math.min(1,(clock-active.since)/lengths[action]);
     // Normalize by the nearby handoff radius, not the whole screen width.
     const dx=clamp((active.x-(center?.x??width/2))/Math.max(65,Math.min(110,width*.25)));
     const dy=clamp((active.y-(center?.y??height/2))/90);
     if(action==='attend'){yaw=dx*.48;pitch=dy*.15;roll=-dx*.075;lookX=dx*.025;lookY=-dy*.02;lean=dx*.035;}
     else{
      receipt={id:active.id,key:active.key,stage:action,progress:u,origin:active.origin,side:active.side,context:active.context,team:active.team};
      const departed=['dispatch','handoff','collaborate','resume'].includes(action);
      yaw=dx*(action==='receive'?.38:['acknowledge','confirm','release'].includes(action)?.30:.12);hands=departed?0:action==='release'?1-u:1;
      if(action==='confirm'){lookY=.014;roll=-active.side*.045;}
      if(departed){yaw=dx*.16;lookX=dx*.012;}
      if(action==='receive'){pitch=.26;lookY=-.038;lean=dx*.025;lift=-.035;}
      if(action==='read'){pitch=.30;lookY=-.045;squint=.80;roll=dx*.035;lift=-.035;}
      if(action==='think'){pitch=.09;roll=active.side*.19;lookY=-.022;lookX=active.side*.019;squint=.64;lift=-.018;}
      if(action==='acknowledge'){const blocked=['blocked','rejected','cancelled'].includes(active.context.job?.result);pitch=blocked?.05:Math.sin(u*Math.PI*2)*.27;roll=blocked?Math.sin(u*Math.PI*2)*.18:0;lookY=.012;squint=blocked?.72:.96;lift=blocked?0:Math.sin(u*Math.PI)*.035;}
     }
    }
   }
  }
  if(!active){
   if(phase===1||phase===2){action='think';roll=.16;pitch=.11;lookY=-.025;squint=.72;}
   else if(clock-nodAt>=0&&clock-nodAt<1.1){action='acknowledge';pitch=Math.sin((clock-nodAt)/1.1*Math.PI*2)*.27;}
   else {yaw=Math.sin(clock*.45)*.12;roll=Math.sin(clock*.6)*.025;}
  }
  if(reduced){pose={pitch:0,yaw:0,roll:0,lookX:0,lookY:0,squint:1,lift:0,lean:0,hands:0};return {...pose,action:'still',targetId:null,receipt:null};}
  const desired={pitch,yaw,roll,lookX,lookY,squint,lift,lean,hands},blend=1-Math.exp(-dt*pace*7);
  for(const k of Object.keys(pose))pose[k]+=(desired[k]-pose[k])*blend;
  return {...pose,action,targetId:active?.id??null,receipt};
 };
}
