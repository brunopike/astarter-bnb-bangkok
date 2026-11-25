import {pair,translate,normalizeLocale} from './locale.mjs';
// Presentation-only summaries of existing receipts. Never invent a signal or order.
export function receiptSummary(receipt,research,locale='zh'){
 if(!receipt||!['acknowledge','confirm'].includes(receipt.stage))return null;
 const j=receipt.context?.job,e=receipt.context?.event;
 const say=(zh,english)=>pair(zh,english,locale);
 let text,kind='input',ref=j?.ref||j?.revision||e?.id||receipt.key;
 if(j?.business){
  kind=j.taskType;
  if(kind==='validation')text=({passed:say('策略核验通过，下一步检查账户额度。','Strategy checks passed. Account limits come next.'),blocked:say('核验还有缺口，补齐前先不执行。','Checks found missing evidence. Execution stays on hold.'),cancelled:say('本次核验已撤回。','This validation was cancelled.')})[j.result];
  else if(kind==='credits')text=j.reserved>0&&!(j.settled||j.released)?say(`已预留 ${j.reserved} 积分，等核验结果。`,`${j.reserved} credits reserved while checks run.`):say(`本次消耗 ${j.settled||0} 积分，退回 ${j.released||0}。`,`${j.settled||0} credits used; ${j.released||0} released.`);
  else if(kind==='review')text=j.result==='filled'?say('模拟成交已确认，正在复核费用和持仓。','Simulated fill confirmed. Reviewing fees and positions.'):say('执行回执存在异常，交给复盘组核对。','An execution exception needs review.');
  else if(kind==='execution')text=j.result==='unknown'?say('委托回报未确认，先对账，不重复下单。','Order status is unknown. Reconcile before retrying.'):say('已交给执行组，等待模拟回报。','Handed to execution. Waiting for a simulated receipt.');
  else if(kind==='risk')text=say('收到风控复核资料，继续核对授权与敞口。','Risk checks received. Reviewing permissions and exposure.');
 }else if(j?.route==='direct'){
  const source={macro:['宏观','macro'],social:['舆情','sentiment'],chain:['链上','on-chain'],trend:['行情','market'],depth:['盘口','order-book'],risk:['风控','risk']}[j.source]||['市场','market'];
  text=say(`收到${source[0]}资料，先和其他组交叉核对。`,`Received ${source[1]} evidence. Cross-checking with the teams.`);
 }else{
  const task=research?.task?.(j?.symbol);
  if(task?.phase==='complete'){
   kind='conclusion';ref=research.revision?.(task)||ref;
   const subject=task.symbol;
   text=({candidate:task.domain==='TradFi'?say(`${subject} 有值得跟踪的线索，当前仅研究观察。`,`${subject} has a lead to track. Research only for now.`):say(`${subject} 出现策略候选，执行前还要过风控。`,`${subject} has a strategy candidate. Risk checks still apply.`),conflict:say(`${subject} 的证据有分歧，先补查，不执行。`,`${subject} evidence conflicts. Investigate before execution.`),missing:say(`${subject} 还缺关键证据，先保持观察。`,`${subject} needs more evidence. Keeping it under observation.`),context:say(`${subject} 作为共享背景，已纳入跨组研究。`,`${subject} is shared context for cross-team research.`),watch:say(`${subject} 还未满足条件，我会继续观察。`,`${subject} conditions are not met yet. Continuing to monitor.`)})[task.outcome];
  }else text=say('小组报告收到了，正在比对证据和风险条件。','Team report received. Comparing evidence and risk conditions.');
 }
 return text?{text,kind,ref,key:receipt.key}:null;
}
export function createCoreReports(){
 let epoch,active=null,until=0,nextAt=0,pending=null,initialized=false;const seen=new Set(),versions=new Map();
 return ({time,epoch:run,receipt,research,locale='zh'})=>{
  if(epoch!==run){epoch=run;active=null;pending=null;until=0;nextAt=0;initialized=false;seen.clear();versions.clear();}
  const enqueue=(r)=>{
   const zh=receiptSummary(r,research,'zh'),en=receiptSummary(r,research,'en');
   if(!zh||seen.has(zh.key))return;
   seen.add(zh.key);if(seen.size>128)seen.delete(seen.values().next().value);
   if(!pending||zh.kind!=='input')pending={zh,en,at:time};
  };
  enqueue(receipt);
  // Completion is read from the research ledger, never inferred from a courier pose.
  for(const task of research?.tasks||[]){
   const key=research.revision(task),status=task.phase;
   if(initialized&&status==='complete'&&versions.get(key)!=='complete')enqueue({stage:'acknowledge',key:'conclusion:'+key,context:{job:{symbol:task.symbol,revision:key}}});
   versions.set(key,status);
  }
  while(versions.size>128)versions.delete(versions.keys().next().value);
  initialized=true;
  if(active&&time>=until)active=null;
  if(pending&&time-pending.at>15)pending=null;
  if(!active&&pending&&time>=nextAt){active=pending;pending=null;until=time+5.5;nextAt=time+12;}
  return active?(normalizeLocale(locale)==='zh'?active.zh:{...active.en,text:translate(active.en.text,locale)}):null;
 };
}
