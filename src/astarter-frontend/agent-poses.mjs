const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const rest=()=>({yaw:0,headYaw:0,headPitch:0,roll:0,leftArm:0,rightArm:0,leftArmRoll:-.08,rightArmRoll:.08,leftElbow:0,rightElbow:0,leftLeg:0,rightLeg:0,bob:0,squint:1,lookX:0,lookY:0});

// Presentation consumes the existing task clock; it never advances research or orders.
export function workerPose(state,time,reduced=false){
  const p=rest(),m=state.motion||{},work=state.work,computer=work?.kind==='computer'&&state.leader&&!m.walking;
  p.yaw=computer?Math.PI:clamp((m.facing||Math.sign(m.dx)||0)*.32,-.6,.6);
  if(reduced)return p;
  const t=time+state.id*.47,step=Math.sin(t*12);
  if(m.walking){p.leftLeg=step*.44;p.rightLeg=-p.leftLeg;p.leftArm=-step*.3;p.rightArm=step*.3;p.bob=Math.abs(step)*1.1;p.roll=clamp((m.dx||0)*-.018,-.1,.1);}
  else{p.bob=Math.sin(t*2)*.35;p.headPitch=(m.nod||0)*.24;p.headYaw=Math.sin(t*.8)*.035;}
  if(computer){p.leftArm=-1.05+(work.action==='type'?Math.sin(t*14)*.13:0);p.rightArm=-1.05+(work.action==='type'?Math.cos(t*14)*.13:0);p.leftElbow=p.rightElbow=-.3;p.headPitch=.18;}
  else if(work?.action==='point'||work?.action==='retrieve'){
    const side=m.facing<0?'left':'right';p[side+'Arm']=-1.3;p[side+'Elbow']=-.28;p.headYaw=(m.facing||1)*.26;p.headPitch=-.1;
  }else if(state.coreWaiting||state.phase===3||state.workPhase==='submit'||state.workPhase==='handoff'){
    const side=m.facing<0?'left':'right';p[side+'Arm']=-.98;p[side+'Elbow']=-.5;p.headPitch=(m.nod||0)*.28;
  }else if(m.speaking){p.rightArm=-.65-Math.sin(t*5)*.13;p.rightElbow=-.35;p.headYaw=(m.facing||1)*.18;}
  else if(state.phase===2||['deliver','meet','dispatch'].includes(state.workPhase)){p.rightArm=-.65;p.rightElbow=-.7;}
  p.squint=1-Math.pow(Math.max(0,Math.cos(t*.82)),70)*.8;
  return p;
}

export function corePose(reaction={},time=0,reduced=false){
  const p=rest();if(reduced)return p;
  p.headPitch=reaction.pitch||0;p.headYaw=reaction.yaw||0;p.roll=reaction.roll||0;
  p.bob=(reaction.lift||0)*15;p.lookX=(reaction.lookX||0)*2;p.lookY=(reaction.lookY||0)*2;
  p.squint=(reaction.squint??1)*(1-Math.pow(Math.max(0,Math.cos(time*.88+1.2)),70)*.8);
  const hands=reaction.hands||0;if(hands){p.leftArm=p.rightArm=-.8*hands;p.leftElbow=p.rightElbow=-.55*hands;p.leftArmRoll=1.05*hands;p.rightArmRoll=-1.05*hands;}
  if(reaction.action==='think'){p.rightArm=-.8;p.rightElbow=-1.1;p.headPitch+=.08;}
  if(reaction.action==='release'){const side=reaction.receipt?.side<0?'left':'right';p[side+'Arm']=-1.1*hands;}
  return p;
}
