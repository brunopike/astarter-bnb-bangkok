// Read-only projection of the existing simulation ledgers. Animation never submits,
// settles credits, approves a strategy, or creates a research conclusion.
export class BusinessMotion {
 constructor(){this.previous=new Map();this.receipts=new Map();this.initialized=false;}
 update(workspace,trade,research){
  const now=workspace.s.clock,items=[];
  const observe=(key,status,job)=>{
   const old=this.previous.get(key);
   if(this.initialized&&old!==status)this.receipts.set(key,{...job,id:key,at:now,status});
   this.previous.set(key,status);
  };
  const base=(roles,station,taskType,title,ref,extra={})=>({roles,station,taskType,title,trigger:ref,ref,source:'risk',mode:'desk',business:true,noReturnTeam:true,...extra});
  for(const v of workspace.s.validations){
   const job=base([6,9,12],3,'validation','策略核验',v.id,{badge:({passed:'已核验',blocked:'待补证',cancelled:'已撤回'})[v.status]||'核验',glyph:v.status==='blocked'?'?':v.status==='cancelled'?'↩':'✓',draftId:v.draftId,usageId:v.usageId,result:v.status});
   observe('validation-'+v.id,v.status,job);
   if(v.status==='running')items.push({...job,id:'validation-'+v.id,progress:.32+v.progress*.0034,priority:80});
  }
  for(const u of workspace.s.usage){
   const job=base([10],4,'credits',u.status==='reserved'?'积分预留':u.status==='cancelled'?'释放预留':'积分结算',u.ref,{badge:u.status==='reserved'?`锁 ${u.reserved}`:u.status==='cancelled'?`退 ${u.released}`:`−${u.settled} / 退 ${u.released}`,glyph:'◎',usageId:u.id,reserved:u.reserved,settled:u.settled,released:u.released});
   observe('credits-'+u.id,u.status,job);
   if(u.kind==='账户私有复核')observe('private-'+u.id,u.status,base([13,14],5,'risk','账户私有复核回执',u.ref,{badge:'权限复核',glyph:'◇',usageId:u.id}));
  }
  if(trade.signal)items.push({...base([13,14],5,'risk','信号与敞口复核',trade.signal.id,{badge:'风控',glyph:'◇'}),id:'risk-'+trade.signal.id,progress:.38+(Math.sin(trade.time)*.5+.5)*.18,priority:100});
  for(const o of trade.orders||[]){
   const terminal=['filled','cancelled','partial-cancelled','rejected'].includes(o.status);
   const job=base(terminal?[16,17]:[15,16],2,terminal?'review':'execution',terminal?(o.status==='filled'?'成交与费用复盘':'异常回执复核'):'委托与回报交接',o.id,{badge:terminal?(o.status==='filled'?'复盘':'异常'):o.status==='unknown'?'待对账':o.status==='partial'?'部分成交':'执行',glyph:terminal?'↺':'↗',symbol:o.market?.split('/')[0],orderId:o.id,result:o.status,source:'depth'});
   observe('order-'+o.id,o.status,job);
   if(!terminal)items.push({...job,id:'order-'+o.id,progress:.34+(Math.sin(trade.time*1.3)*.5+.5)*.28,priority:110});
  }
  for(const a of trade.flow?.admissions||[]){
   const job=base([13,14],5,'risk',a.state==='BLOCKED'?'准入阻断回报':'准入复核回报',a.id,{badge:a.state==='BLOCKED'?'阻断':'准入',glyph:a.state==='BLOCKED'?'!':'✓',admissionId:a.id,planId:a.planId,result:a.state});
   observe('admission-'+a.id,a.state,job);
  }
  for(const p of trade.flow?.protections||[]){
   const unresolved=['PENDING','IMPAIRED','UNKNOWN'].includes(p.state),job=base([13,14],5,'risk',unresolved?'保护覆盖核对':'保护确认回报',p.id,{badge:p.state==='PENDING'?'待确认':unresolved?'保护异常':'已保护',glyph:unresolved?'!':'✓',protectionId:p.id,result:p.state,targetQuantity:p.targetQuantity,confirmedQuantity:p.confirmedQuantity});
   observe('protection-'+p.id,p.state+':'+p.revision,job);
   if(unresolved&&Number(p.targetQuantity)>0)items.push({...job,id:'protection-'+p.id,progress:.38+(Math.sin(trade.time)*.5+.5)*.18,priority:120});
  }
  for(const fee of trade.flow?.ledger?.filter(e=>e.type==='FEE'||e.type==='FUNDING')||[]){
   observe('cost-'+fee.id,fee.revision,base([16,17],2,'review','成交费用核账回报',fee.id,{badge:fee.backfill?'费用补录':'核账',glyph:'↺',fillId:fee.fillId,orderId:fee.orderId,ledgerId:fee.id,revision:fee.revision}));
  }
  // Terminal receipts remain visible long enough to hand over, read and acknowledge.
  // Their state is already committed in the ledger; these are report deliveries.
  for(const [key,r] of this.receipts){
   const age=now-r.at;
   if(age>14){this.receipts.delete(key);continue;}
   if(items.some(j=>j.id===key)||r.status==='running'||['submitted','partial','unknown'].includes(r.status))continue;
   const credit=r.taskType==='credits';
   items.push({...r,progress:credit?.32+Math.min(1,age/14)*.67:r.taskType==='validation'?.67+Math.min(1,age/14)*.32:.32+Math.min(1,age/14)*.67,priority:credit?60:r.taskType==='review'?90:80});
  }
  this.initialized=true;
  const claimed=new Set(),jobs=[];
  for(const j of items.sort((a,b)=>b.priority-a.priority||String(a.id).localeCompare(String(b.id)))){
   if(j.roles.some(r=>claimed.has(r)))continue;
   j.roles.forEach(r=>claimed.add(r));jobs.push(j);
  }
  return jobs;
 }
}

// Routine raw observations can go straight to the core; disputed evidence must
// stay with its team. A raw delivery never upgrades a finding into a conclusion.
export function researchMotionJobs(research){
 const jobs=research.jobs().flatMap(j=>{
  const t=j.taskId?research.task(j.symbol):null;
  const dispute=t&&['conflict','missing'].includes(t.outcome);
  if(dispute||['queuedCore','core','complete'].includes(j.researchPhase))return [j];
  const cycle=Math.floor((research.time+j.station*2)/16),u=((research.time+j.station*2)%16)/16;
  const roles=j.roles,collector=roles[cycle%roles.length],peers=roles.filter(r=>r!==collector);
  return [{...j,id:`${j.id}:raw:${cycle}`,roles:[collector],route:'direct',noReturnTeam:true,progress:u,discovered:false,taskType:'intelligence',badge:'采集',glyph:'↗',title:j.symbol+' · 原始情报直送',trigger:j.revision||j.trigger},
   {...j,id:j.id+':crosscheck',roles:peers,mode:'desk',progress:.34+u*.30,taskType:'crosscheck',badge:'会审',glyph:'⇄',title:j.symbol+' · 交叉核验'}];
 });
 // Exchange specialists only while cross-checking shared evidence. Direct
 // couriers and reports queued for the core keep their original ownership.
 for(const [a,b,source]of [[0,5,'macro'],[1,2,'chain'],[3,4,'macro']]){
  const eligible=j=>!j.route&&j.roles.length>=2&&(j.taskType==='crosscheck'||j.researchPhase==='verify');
  const left=jobs.find(j=>j.station===a&&eligible(j)),right=jobs.find(j=>j.station===b&&eligible(j));
  if(!left||!right)continue;
  const l=left.roles.at(-1),r=right.roles.at(-1);left.roles=[...left.roles.slice(0,-1),r];right.roles=[...right.roles.slice(0,-1),l];
  for(const [j,visitor,from]of [[left,r,b],[right,l,a]]){j.visitingRoles=[visitor];j.supportSource=source;j.supportFrom=from;j.title+=' · 共享证据协查';}
 }
 return jobs;
}

export function mergeMotionJobs(business,researchJobs){
 const used=new Set(business.flatMap(j=>j.roles));
 return [...business,...researchJobs.map(j=>({...j,roles:j.roles.filter(r=>!used.has(r))})).filter(j=>j.roles.length)];
}
