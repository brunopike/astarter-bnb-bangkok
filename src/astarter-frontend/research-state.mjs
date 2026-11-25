import { evidenceProcess, evidenceRoleState, evidenceRoleOutput } from './evidence-process.mjs';
import { ROLES } from './simulation.mjs';

export const SOURCE_INFO = {
  macro:{name:'宏观事件',roles:[0,11,14],unit:'项',description:'模拟经济日历与跨资产背景；高影响事件触发风险复核。'},
  social:{name:'社交舆情',roles:[3,7,9],unit:'热度',description:'模拟讨论热度，去重、查原始出处；热度不代表利多。'},
  chain:{name:'链上异动',roles:[16,13,17],unit:'笔',description:'模拟地址转账与合约调用；转账不能直接归因交易意图。'},
  depth: {name:'盘口深度',roles:[4,13],unit:'指数',description:'合成盘口的相对深度指数，用于演示采样与传递；不是可成交数量。'},
  trend: {name:'趋势结构',roles:[0,1,2,6],unit:'指数',description:'合成序列的趋势示例指数，未调用行情供应商或策略指标引擎。'},
  volatility: {name:'波动区间',roles:[5,11,16],unit:'%',description:'预设波动示例序列，未按真实历史收益率计算。'},
  volume: {name:'量价关系',roles:[3,7,17],unit:'指数',description:'合成量价关系指数，用于表现角色取样；没有真实资金流归因。'},
  spread: {name:'买卖价差',roles:[15],unit:'bps',description:'买卖价差的合成序列。1 bps = 0.01%；展示值不代表交易所报价。'},
  risk: {name:'风险条件',roles:[8,9,10,12,14],unit:'角色',description:'本方案参与风险条件讨论的角色数，不是已通过的风控检查数。'},
};
export const seriesValue=(n,seed=0)=>Math.sin(n*.43+seed)*.41+Math.sin(n*.17+seed*1.7)*.75+Math.cos(n*.069+seed*3.1)*1.4;
export function syntheticPrice(market,n){const base=market.startsWith('ETH')?3180:market.startsWith('SOL')?184:81230,mult=market.startsWith('BTC')?17:market.startsWith('ETH')?.9:.05;return base+seriesValue(n*.6,2)*mult+n*.015*mult;}
export function sourceValue(key,t,actors){
  t=Math.floor(t*2)/2;
  if(key==='macro')return '2';
  if(key==='social')return (42+seriesValue(t*.1,7)*6).toFixed(0);
  if(key==='chain')return '3';
  if(key==='risk')return String(actors.filter(id=>SOURCE_INFO.risk.roles.includes(id)).length);
  if(key==='spread')return (1.5+(seriesValue(t*.2,5)+2)*.12).toFixed(1);
  const seed={depth:0,trend:4,volatility:2,volume:3}[key];
  return (seriesValue(t*.65-1,seed)+4).toFixed(2);
}
export function researchSnapshot(model,market,{stopped=false,selected=4}={}){
  const process=evidenceProcess(model), cycleStart=model.cycle*24;
  const events=model.events.filter(e=>e.at>=cycleStart).map(e=>{const item=process.history.find(i=>i.id===e.id);return item?{...e,at:item.stage===5?e.at+7.2:e.at,to:12,text:item.stage===5?`${item.name} · ${item.label}：${item.reason}${process.items.some(i=>i.id===item.id)?'':'（已被补充核验替换）'}`:`${item.name} · ${['前往来源','采集中','携回中','已回传，待筛选','筛选中'][item.stage]}`}:{...e,at:e.from===12&&process.ready?process.lastAt+.8:e.at,text:e.from===12?(process.ready?`${process.title}。${process.detail}`:'整合角色等待证据闭合。'):e.text};}).sort((a,b)=>b.at-a.at);
  const complete=process.ready;
  const interrupted=stopped&&!model.completed;
  const unfinished=model.completed&&!process.ready;
  const result=interrupted?'本轮已中止':unfinished?'证据尚未闭合':process.title;
  return {market,key:model.key,epoch:model.epoch,cycle:model.cycle+1,at:model.elapsed,selected,
    disposition:model.disposition?.id===`${model.runId}:${process.revision}`?model.disposition:null,process,phase:process.phase,complete:complete&&!interrupted,interrupted,result,
    detail:interrupted?'已保留结束前的示例记录，未完成的角色不再继续。':unfinished?'本轮已结束，仍有证据未完成筛选，尚不能形成结论。':process.detail,
    roles:model.config.actors.map(id=>({id,name:ROLES[id].name,code:ROLES[id].id,status:interrupted&&['running','queued'].includes(evidenceRoleState(model,id,process))?'cancelled':evidenceRoleState(model,id,process),output:interrupted&&['running','queued'].includes(evidenceRoleState(model,id,process))?'本轮已中止，未生成输出。':evidenceRoleOutput(model,id,process)})),
    coordination:(model.coordinationJobs||[]).map(j=>({...j,roles:[...j.roles]})),events,sources:Object.entries(SOURCE_INFO).map(([key,info])=>({key,...info,value:sourceValue(key,model.elapsed,model.config.actors),activeRoles:info.roles.filter(id=>model.config.actors.includes(id))})),
    // Research observations never confer strategy approval, account binding or execution authority.
    strategyReady:false,mode:'simulation-only',next: process.counts.conflict?'先复核宏观、市场与执行分歧，未消除前暂停新增风险。':process.counts.missing?'先补齐原始出处与缺失证据，热度和异动不能替代核验。':model.key==='volatility'?'先核对周期分歧与不利条件，再评估是否继续研究。':model.key==='review'?'先补齐规则与证据缺口，再重新组织评审。':'保留盘口线索，等待新的独立证据；当前结论仍是观察。'};
}
