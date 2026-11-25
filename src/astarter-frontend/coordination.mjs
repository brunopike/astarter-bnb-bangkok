export const COLLAB_SCENES=['huddle','exchange','computer','screen','planning-table','risk-table'];
// Presentation jobs describe concrete fixture checks; they never create AI output or evidence.
export function coordinationJobs(model,trade){
 const jobs=[],add=(id,roles,title,source,age,duration,trigger,hold=false)=>{
  if(age<0||(!hold&&age>=duration))return;
  jobs.push({id,roles,title,source,trigger,progress:hold?Math.min(.56,age/duration):Math.min(1,age/duration),kind:hold?'review':'task'});
 };
 const t=model.elapsed;
 // Every role has a finite, source-specific review duty, including the small outer couriers.
 // These presentation jobs reuse fixtures and yield to new evidence and execution jobs below.
 const teams=[
  {roles:[0,1,2],source:'macro',title:'复核宏观背景与趋势条件'},
  {roles:[3,7,8],source:'social',title:'核对舆情与量价的正反证据'},
  {roles:[4,16,17],source:'chain',title:'核对链上异动与盘口旁证'},
  {roles:[6,10,11],source:'trend',title:'复核规则、等待与失效条件'},
  {roles:[5,9,14],source:'volatility',title:'复核异常、反证与保护条件'},
  {roles:[12,13,15],source:'risk',title:'整合证据、敞口与执行条件'}
 ];
 teams.forEach((team,station)=>{
  const duration=16,clock=trade.time+station*duration/6,cycle=Math.floor(clock/duration),turn=cycle%team.roles.length;
  const roles=[...team.roles.slice(turn),...team.roles.slice(0,turn)];
  const subjects=[['DXY','XAU','SPX'],['SOL','BTC'],['ETH','SOL'],['BTC','ETH','SOL'],['SPX','NDX','US10Y'],['组合敞口']][station];
  add(`source-check-${station}-${cycle}`,roles,subjects.join(' / ')+' · '+team.title+' · 已有样例',team.source,clock%duration,duration,`${model.runId} / 已有证据复核`);
  Object.assign(jobs.at(-1),{station,subjects,mode:station>=4?'desk':'field',sourceAnchor:station===3?'market':station===2&&cycle%2?'orderbook':null,taskType:station>=4?'review':'collect'});
 });
 if(!model.completed){
  add('trend',[1,2],'交叉核对趋势与结构','trend',t-1,11,`${model.runId} / 环境采样`);
  add('volume',[3,7,8],'对照量价与正反条件','volume',t-5,12,`${model.runId} / 量价核验`);
  add('rules',[6,10,11],'核对规则、等待与失效条件','risk',t-11,12,`${model.runId} / 情景推演`);
  add('critique',[9,14],'核查分歧与保护条件','risk',t-14,9,`${model.runId} / 证据筛选`);
 }
 if(trade.signal){add(`risk-${trade.signal.id}`,[13,14,15],'检查单笔额度、敞口与执行条件','risk',trade.time-trade.signal.at,3.4,trade.signal.id,true);}
 if(trade.pending){const o=trade.pending;add(`order-${o.id}`,[15,16],'交接委托与核对成交回报','depth',trade.time-o.at,3,o.id);}
 const filled=trade.orders.find(o=>o.status==='filled');
 if(filled)add(`review-${filled.id}`,[16,17],'核对成交、费用与持仓变化','volume',trade.time-filled.at-2.5,7,filled.id);
 const claimed=new Set();return jobs.reverse().flatMap(j=>{
  // Evidence delivery has priority. A meeting needs at least two available colleagues.
  const roles=j.roles.filter(r=>!claimed.has(r)&&!(model.events||[]).some(e=>e.from===r&&e.at<=t&&t-e.at<7.2));
  if(roles.length<2)return [];
  roles.forEach(r=>claimed.add(r));return [{...j,roles}];
 });
}
export function coordinationForRole(jobs,id){return jobs.find(j=>j.roles.includes(id));}

// Shared phase boundaries for bodies, hands and the single physical document.
export function coordinationPhase(job,leader=false){
 const u=job.progress;
 if(job.route==='direct')return u<.16?'visit':u<.38?'deliver':u<.66?'submit':'return';
 if(job.mode==='desk'&&u<.32)return 'review';
 if(job.mode==='field'&&!leader&&u<.32)return 'await';
 if(u<.16)return 'visit';
 if(u<.32)return 'meet';
 if(u<.67)return 'discuss';
 if(!leader)return job.mode?'review':'return';
 if(u<.80)return 'deliver';
 if(u<.92)return 'submit';
 return 'return';
}

// Space belongs to the work groups; compact viewports keep the original close formation.
export function meetingCenters({width,height,core,mobile=false}){
 const rx=Math.max(70,width*.5-(mobile?51:82)),ry=Math.min(height*.5-28,Math.max(45,height*.32));
 return [[-1,-1],[1,-1],[1,1],[-1,1],[1,0],[-1,0]].map(([x,y])=>({x:core.x+x*rx,y:core.y+y*ry}));
}

// Positions are body centers; feet sit about 20 px below. Tables are obstacles,
// not platforms. Keep the same formation for home, meetings and returned tasks.
export function collaborationPosition(center,station,slot,count=3,mobile=false,time=0){
 const scale=mobile?.66:1;
 const formations=[
  [[-46,32],[42,22],[0,48]], // rack retrieval starts in the briefing area, then approaches the drawer
  [[-34,9],[34,9],[0,-27]], // two facing couriers, one waiting colleague
  [[0,24],[-49,3],[49,4]], // keyboard operator in front, reviewers at either side
  [[-49,17],[0,26],[49,17]], // standing in front of the research screen
  [[-78,8],[0,-55],[78,8]], // around the table, feet outside its surface
  [[-78,8],[0,-55],[78,8]]
 ];
 const [x,y]=formations[station%6][count===2?(slot===0?0:2):slot%3];
 const drift=station===3?Math.sin(time*.65)*9:station===1?Math.sin(time*.5+slot)*3:0;
 return {x:center.x+(x+drift)*scale,y:center.y+y*scale};
}
export function avoidMeetingTable(point,center,mobile=false){
 const scale=mobile?.66:.90,rx=52*scale+20,ry=19*scale+17;
 const dx=point.x-center.x,dy=point.y+20-(center.y+17),q=Math.hypot(dx/rx,dy/ry);
 if(q>=1)return point;
 const angle=q>.001?Math.atan2(dy/ry,dx/rx):-Math.PI/2;
 return {x:center.x+Math.cos(angle)*rx,y:center.y+17+Math.sin(angle)*ry-20};
}

// A returned task goes back to the relevant research group, never an arbitrary passer-by.
export function receiptTeam(state,states){
 if(state.job?.noReturnTeam)return {station:state.job.station??0,peers:[]};
 const teams=[[0,1,2],[3,7,8],[4,16,17],[6,10,11],[5,9,14],[12,13,15]];
 const station=state.job?.station??teams.findIndex(roles=>roles.includes(state.id));
 const intended=state.job?.roles||teams[Math.max(0,station)];
 const peers=intended.filter(id=>id!==state.id&&states.some(s=>s.id===id&&s.phase===5&&!s.job?.business&&!/^(risk-|order-|review-)/.test(s.job?.id||'')));
 return {station:Math.max(0,station),peers:peers.slice(0,2)};
}

// Expressions describe an action, never profitability or an invented execution result.
export function agentReaction(pose,time,receipt=null){
 const id=pose.id,stage=pose.workPhase||'',phase=pose.phase,source=pose.job?.source||pose.event?.source||pose.source?.key;
 const pulse=(time+id*.73)%6.8,visible=pulse<1.65;
 let emoji='',kind='',priority=0,strength=Math.min(1,pulse/.16,(1.65-pulse)/.2);
 if(pose.coreWaiting&&receipt?.stage==='confirm'){emoji=['blocked','rejected','cancelled'].includes(receipt.context?.job?.result)?'🤔':'👌';kind='confirmed';priority=100;strength=Math.sin(receipt.progress*Math.PI)*.25+.75;}
 else if(pose.followup&&stage==='handoff'&&receipt?.team?.peers[0]===id&&receipt.progress>.55){emoji='👍';kind='received';priority=95;strength=1;}
 else if(visible){
  if(phase===1||stage==='visit'){emoji={macro:'🌍',social:'🧐',chain:'🔎',risk:'🛡️'}[source]||'👀';kind='collect';priority=65;}
  else if(phase===2||stage==='dispatch'||stage==='deliver'){emoji='📎';kind='carrying';priority=35;}
  else if(['discuss','review','await','collaborate','handoff'].includes(stage)){
   const turn=Math.floor(time/6.8)%2;
   emoji=source==='risk'||source==='volatility'?(turn?'🛡️':'🤔'):stage==='collaborate'?'🤝':source==='social'?(turn?'🤨':'🧐'):source==='macro'?(turn?'🧩':'🤔'):(turn?'💡':'🧮');kind='discussion';priority=45;
  }else if(phase===0){emoji='🔍';kind='search';priority=25;}
 }
 return emoji?{emoji,kind,priority,strength:Math.max(0,strength)}:null;
}

// Schematic market frames share the review clock with the presenter's pointer.
// These screen coordinates never feed the research or execution ledger.
export function sceneMarket(q=0){
 q=Math.max(0,Math.min(1,q));
 const base=[[-52,-30],[-37,-39],[-24,-35],[-10,-48],[4,-43],[18,-53],[33,-46],[50,-55]];
 const points=base.map(([x,y],n)=>[x,y+Math.sin(q*Math.PI*4+n*.9)*6+Math.sin(q*Math.PI*2)*3]);
 const volumes=Array.from({length:18},(_,n)=>4+(Math.sin(q*12+n*1.7)*.5+.5)*10);
 return {points,volumes,bandY:-49+Math.sin(q*Math.PI*2)*5};
}

// Local work is a read-only subdivision of the existing task's review interval.
// It cannot complete research, release a pending order, or advance a core handoff.
export function sceneWork(job,id){
 if(!job||job.route==='direct'||!job.roles.includes(id)||job.progress<.32||job.progress>=.67)return null;
 const q=Math.max(0,Math.min(1,(job.progress-.32)/.35)),slot=job.roles.indexOf(id),leader=slot===0;
 if(job.station===0)return {kind:'data-center',q,action:leader?(q<.38?'retrieve':q<.80?'inspect':'pack'):'compare',owner:job.roles[0]};
 if(job.station===2)return {kind:'computer',q,action:leader?(q<.70?'type':q<.88?'verify':'pack'):'crosscheck',owner:job.roles[0],checks:Math.min(3,Math.floor(q*3.5))};
 if(job.station===3){
  const turn=Math.min(job.roles.length-1,Math.floor(q*job.roles.length)),part=q*job.roles.length-turn;
  const {points}=sceneMarket(q),at=q*(points.length-1),segment=Math.min(points.length-2,Math.floor(at)),mix=at-segment;
  const chartX=points[segment][0]+(points[segment+1][0]-points[segment][0])*mix,chartY=points[segment][1]+(points[segment+1][1]-points[segment][1])*mix;
  return {kind:'screen',q,action:slot===turn?(part<.72?'point':'discuss'):'listen',owner:job.roles[turn],chartX,chartY};
 }
 return null;
}
