import {SCENARIOS} from './simulation.mjs';
import {evidenceProcess} from './evidence-process.mjs';
export const OPERATIONS={sample:'补充采样',challenge:'独立反证',risk:'风险复核',recheck:'补充核验'};
export function researchAvailability(model,kind){
 if(!OPERATIONS[kind])return {ok:false,message:'未知任务'};
 const p=evidenceProcess(model);
 if(p.items.some(i=>i.stage<5&&i.event.operation===kind))return {ok:false,message:'同类任务正在处理中'};
 if(p.items.filter(i=>i.stage<5&&i.event.operation).length>=3)return {ok:false,message:'请等待当前任务完成'};
 // Keep the bounded event history sufficient for this finite research round.
 if((p.items.length>=12||model.sequence>=20))return {ok:false,message:'本轮补充次数已满，请保存记录后开始新研究'};
 const target=p.items.find(i=>i.stage===5&&['conflict','missing'].includes(i.decision));
 if(kind==='recheck'&&!target)return {ok:false,message:'当前没有待补或分歧证据'};
 const role=kind==='recheck'?target.role:kind==='challenge'?9:kind==='risk'?14:0;
 if(model.nextEvent<SCENARIOS[model.key].actors.length)return {ok:false,message:'等待首轮任务完成派发'};
 if(p.items.some(i=>i.role===role&&i.stage<5))return {ok:false,message:'该角色正在交接，请稍后再派发'};
 return {ok:true,role,target};
}
export function requestResearch(model,kind){
 const available=researchAvailability(model,kind);if(!available.ok)return available;
 const {role,target}=available;
 if(!model.config.actors.includes(role))model.additionalActors.push(role);
 const decision=kind==='challenge'?'conflict':kind==='sample'?'context':'retain';
 const reasons={sample:'新增环境样本作为旁证保留',challenge:'新增反向条件，需要补充核验',risk:'本项保护条件已完成示例复核',recheck:'补充样本已覆盖原有缺口（模拟）'};
 model.completed=false;model.maxCycles=1;model.holdUntil=Math.max(24,model.elapsed+9.4);
 model.record(model.elapsed,role,12,`研究任务：${OPERATIONS[kind]}`);
 Object.assign(model.events[0],{operation:kind,evidenceName:OPERATIONS[kind],decision,reason:reasons[kind],supersedes:kind==='recheck'?target.id:null});
 return {ok:true,id:model.events[0].id,role,message:`已派发${OPERATIONS[kind]}`};
}
export function recordDisposition(model,market,choice,records=[]){
 const p=evidenceProcess(model);
 if(!p.ready)return {ok:false,message:'等待本轮证据完成筛选'};
 if(!['watch','hold'].includes(choice))return {ok:false,message:'未知处理方式'};
 if(choice==='watch'&&(p.counts.conflict||p.counts.missing))return {ok:false,message:'仍有分歧或缺口，请先退回复核或暂缓'};
 const id=`${model.runId}:${p.revision}`;
 if(records.some(r=>r.id===id))return {ok:false,message:'此版本已处理，新增证据后可再次记录'};
 const record={id,market,scenario:model.key,choice,title:p.title,counts:{...p.counts},evidence:p.items.map(i=>({id:i.id,name:i.name,decision:i.decision,reason:i.reason})),elapsed:model.elapsed,createdAt:new Date().toISOString(),mode:'simulation-only'};
 return {ok:true,record,message:choice==='watch'?'已保留为观察记录':'已记录暂缓原因'};
}
