// One deterministic evidence clock shared by couriers, the core and research results.
// Decisions are explicit scenario fixtures, not model or market judgements.
export const EVIDENCE_ENDS=[1,2,3.6,5.2,7.2];
export const EVIDENCE_NAMES={0:'环境快照',1:'周期方向',2:'价格结构',3:'量价关系',4:'盘口深度',5:'异常条件',6:'规则映射',7:'正向条件',8:'退出条件',9:'独立反证',10:'等待条件',11:'ABC 情景',13:'账户敞口',14:'保护条件',15:'执行条件',16:'运行异常',17:'归因记录'};
export function evidenceDecision(key,id){
 if(key==='volatility'&&[1,9].includes(id))return {decision:'conflict',label:'分歧',reason:id===1?'周期方向尚未一致':'反向证据仍未消除'};
 if(key==='review'&&id===9)return {decision:'missing',label:'待补',reason:'规则证据缺口尚未补齐'};
 if(id===0)return {decision:'context',label:'旁证',reason:'环境背景保留，不作为触发依据'};
 return {decision:'retain',label:'保留',reason:'本项示例核验已完成'};
}
export function evidenceProcess(model){
 if(model.multiResearch)return model.multiResearch.process();
 const start=model.cycle*24,expected=model.config.actors.filter(id=>id!==12);
 const history=model.events.filter(e=>e.at>=start&&e.from!==null&&e.from!==12).slice().reverse().map(e=>{
  const age=Math.max(0,model.elapsed-e.at),phase=EVIDENCE_ENDS.findIndex(end=>age<end),stage=phase===-1?5:phase,begin=stage?EVIDENCE_ENDS[stage-1]:0;
  return {id:e.id,event:e,role:e.from,name:e.evidenceName||EVIDENCE_NAMES[e.from]||'研究证据',age,stage,progress:stage===5?1:(age-begin)/(EVIDENCE_ENDS[stage]-begin),...(e.decision?{decision:e.decision,label:{retain:'保留',context:'旁证',conflict:'分歧',missing:'待补'}[e.decision],reason:e.reason}:evidenceDecision(model.key,e.from))};
 });
 const replaced=new Set(history.filter(i=>i.stage===5&&i.event.supersedes).map(i=>i.event.supersedes));
 const items=history.filter(i=>!replaced.has(i.id));
 const arrived=items.filter(i=>i.stage>=3),resolved=items.filter(i=>i.stage===5),seen=new Set(resolved.map(i=>i.role));
 const all=expected.every(id=>seen.has(id))&&items.length>0&&resolved.length===items.length;
 const lastAt=items.length?Math.max(...items.map(i=>i.event.at+7.2)):Infinity;
 const ready=all&&model.elapsed>=lastAt+.8;
 const phase=ready?3:items.some(i=>i.stage===4)||all?2:items.some(i=>i.stage===3)?1:0;
 const counts={retain:0,context:0,conflict:0,missing:0};for(const item of resolved)counts[item.decision]++;
 const result=counts.conflict?'暂不跟进':counts.missing?'留待复核':'继续观察';
 const detail=ready?`已筛选 ${resolved.length} 条：保留 ${counts.retain} · 旁证 ${counts.context} · 分歧 ${counts.conflict} · 待补 ${counts.missing}。`:
  `已回传 ${arrived.length} / ${Math.max(expected.length,items.length)} 条，已筛选 ${resolved.length} 条；等待本轮证据闭合。`;
 const title=ready?result:phase===2?'逐条筛选证据':phase===1?'证据正在汇聚':items.some(i=>i.stage===2)?'证据回到核心':'Agent 正在采集';
 return {history,items,arrived:arrived.length,resolved:resolved.length,expected:Math.max(expected.length,items.length),counts,ready,phase,title,detail,lastAt,revision:items.map(i=>i.id).join('|'),resultProgress:ready?Math.min(1,(model.elapsed-lastAt-.8)/1.1):0};
}

export function evidenceRoleState(model,id,process=evidenceProcess(model)){
 if(!model.config.actors.includes(id))return 'idle';
 if(id===12)return process.ready?'done':process.arrived?'running':'queued';
 const item=process.items.filter(i=>i.role===id).at(-1);
 return !item?'queued':item.stage===5?'done':'running';
}
export function evidenceRoleOutput(model,id,process=evidenceProcess(model)){
 const state=evidenceRoleState(model,id,process);
 if(state==='idle')return '本轮未调用此角色。';
 if(id===12)return process.ready?`${process.title}。${process.detail}`:'等待回传证据完成筛选，再整合本轮结论。';
 const item=process.items.filter(i=>i.role===id).at(-1);
 if(!item)return '等待本轮采集任务。';
 return item.stage===5?`${item.label}：${item.reason}。`:['正在前往数据来源。','正在采集本条证据。','正在将证据带回核心。','证据已回传，正在汇聚。','正在区分保留、旁证、分歧与待补证据。'][item.stage];
}
